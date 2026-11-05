# Merchant Integration & Webhook Guide

## 1. Overview
The NeuroSky Pay public contract is designed to be minimal and robust. Merchant systems do not need to understand queue mechanics, five-minute timers, 30-second verification windows, or multi-channel observation.

Finality is configurable with `NEUROSKY_UPI_FINALITY` (see `docs/CONFIGURATION.md`):

- **`OBSERVER` (default)**: a bank SMS / Gmail alert that matches the session settles the UPI payment. The webhook is `event: "SUCCESS"`, `method: "UPI"`, `settlementState: "OBSERVER_VERIFIED"`, and the customer sees "Payment Successful". Treat it as paid.
- **`STATEMENT`**: the strict two-step flow. The alert moves the session to `OBSERVED_SUCCESS` with `settlementState: NOT_RECONCILED`; `RECONCILED` is emitted only after an admin imports a bank-statement CSV and one line matches that session on receiving account, amount in paise, and 12-digit reference. In this mode do not fulfill a UPI order before `RECONCILED`.

Public outcomes:
- `SUCCESS`: In `OBSERVER` mode, a verified UPI payment (`method: "UPI"`, `settlementState: "OBSERVER_VERIFIED"`). In every mode also a Cash on Delivery or counter order (`method: "COD" | "CASH_COUNTER" | "CARD_COUNTER"`, `settlementState: "NOT_BANK_SETTLEMENT"`, no bank money for COD).
- `OBSERVED_SUCCESS`: `STATEMENT` mode only. A bank alert was attributed to this UPI session. Not statement-reconciled.
- `RECONCILED`: `STATEMENT` mode only. A downloaded statement line matched this UPI session.
- `MANUAL_REVIEW`: More than one session could explain the alert, or the payment was flagged. Do not fulfill.
- `FAILED`: Verification window elapsed with no matching observation.
- `EXPIRED`: Payment window elapsed.
- `CANCELLED`: Customer cancelled checkout.

Compatibility note: deployments that keep `NEUROSKY_UPI_FINALITY=STATEMENT` send `X-Gateway-Event: OBSERVED_SUCCESS` for UPI alerts; integrations written for that mode must switch on `event` and `settlementState` rather than on `SUCCESS` alone.

Webhook crash recovery queues each new dispatchable outcome in the same SQLite transaction as its payment-status change. One payment may therefore have separate pending `OBSERVED_SUCCESS`, `MANUAL_REVIEW`, and `RECONCILED` notifications. Dispatching one outcome does not remove the others. Upgrading the outbox preserves already-pending notifications but does not create notifications for historical UPI outcomes. Merchants must still deduplicate by delivery ID: a crash after receipt but before acknowledgement can cause a retry. Delivery order must not be used as a substitute for checking the event and `settlementState`.

---

## 2. Using `@neurosky/merchant-sdk`

### Installation
```bash
npm install @neurosky/merchant-sdk
```

### Initialize Client
```javascript
import { NeuroSkyPaymentClient } from '@neurosky/merchant-sdk';

const client = new NeuroSkyPaymentClient({
  apiUrl: 'https://pay.yourbusiness.com',
  merchantId: 'your-merchant-uuid',
  webhookSecret: 'your-webhook-secret-key'
});
```

### 1. Create a Payment
```javascript
// Merchant initiates payment with order details.
// Customer identity and authentication are fully owned and handled by the Payment Gateway.
const payment = await client.createPayment({
  orderId: 'ORD-98765',
  amount: '200.00',           // Exact INR amount
  currency: 'INR',
  returnUrl: 'https://store.example.com/checkout/complete',
  metadata: {
    productId: 'SUBSCRIPTION_YEARLY'
  }
});

// Redirect customer immediately to hosted checkout portal
res.redirect(payment.checkoutUrl);
```

> **Customer Identity Note**: The merchant developer does **not** collect customer passwords, sessions, or credentials. When the customer reaches the hosted checkout portal, the Payment Gateway securely authenticates the customer (supporting Sign In, Sign Up with 4 profile fields, and 2 remembered accounts) before starting the payment session.

### 2. Verify Signed Webhook
```javascript
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-gateway-signature']; // 'sha256=abcdef...'
  const rawBody = req.body.toString('utf8');

  try {
    const event = client.verifyWebhook(rawBody, signature);

    switch (event.event) {
      case 'OBSERVED_SUCCESS':
        // Alert matched. Do not fulfill. Wait for RECONCILED.
        break;
      case 'RECONCILED':
        if (event.method === 'UPI' && event.settlementState === 'RECONCILED') {
          unlockServiceForCustomer(event.orderId, event.metadata);
        }
        break;
      case 'MANUAL_REVIEW':
        // Hold the order. Do not fulfill.
        break;
      case 'SUCCESS':
        // COD or counter order placed. Check event.method before treating it as paid.
        break;
      case 'FAILED':
        // Mark order as failed, notify customer to retry
        break;
      case 'EXPIRED':
        // Handle abandoned checkout
        break;
      case 'CANCELLED':
        // Return customer items to cart
        break;
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Invalid webhook signature:', err.message);
    res.status(400).send('Invalid signature');
  }
});
```

---

## 3. Direct REST API Integration (Without SDK)

If integrating from Python, Go, PHP, or Java:

### 1. Create Payment
- **`POST /api/v1/payments`**
- **Headers:** `Content-Type: application/json`, `X-Merchant-Id: <UUID>`
- **Payload:**
  ```json
  {
    "orderId": "ORD-12345",
    "amount": "200.00",
    "currency": "INR",
    "returnUrl": "https://store.example.com/complete"
  }
  ```
- **Response:**
  ```json
  {
    "paymentId": "...",
    "orderId": "ORD-12345",
    "amount": "200.00",
    "status": "ACTIVE",
    "checkoutUrl": "https://pay.yourbusiness.com/checkout/..."
  }
  ```

### 2. Webhook Signature Verification Algorithm
- Compute `expectedSig = HMAC-SHA256(merchant.webhookSecret, rawBodyString)`.
- Compare against header `X-Gateway-Signature` (strip `sha256=` prefix) using a constant-time comparison function to prevent timing attacks.
