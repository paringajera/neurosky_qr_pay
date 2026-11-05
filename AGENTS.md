# AGENTS.md — NeuroSky Pay V2 Operating & Integration Standard

This document establishes the mandatory architectural rules, Git workflows, security standards, and payment lifecycle invariants for both AI coding agents and human engineers contributing to or integrating with **NeuroSky Pay V2**.

---

## Part 1: AI & Developer Operating Standard

### 1. Mandatory Git Workflow & Branching Rules

1. **Single repository, single branch.** All work happens directly on `main` of `origin` (`https://github.com/paringajera/neurosky_qr_pay.git`). Do not create feature/fix branches, do not add other remotes, and do not open pull requests unless the owner asks for one explicitly.
2. **Keep `main` linear and releasable.** Commit atomically on `main` (see rule 5), run `git pull --ff-only` before starting work, and never force-push or rewrite history that is already on `origin`.
3. **Mandatory Pre-Commit & Pre-Push Checklist**:
   - **Sync & Prune (`git fetch --prune --all`)**: Always run `git fetch --prune --all` before creating branches, pushing, or opening a PR to clean up stale remote-tracking references.
   - **Typecheck**: Run `npm run typecheck` locally to verify TypeScript compiles without errors.
   - **Unit & Regression Tests**: Run `npm test` locally to ensure 100% of curated test suites pass cleanly.
   - **Inspect Changes**: Always check `git status`, `git diff`, and `git log -n 3 --oneline` before staging/committing to prevent accidental secret leaks, debug dumps, or unneeded files.
   - **Environment Integrity**: Ensure any new environment variables are documented in `.env.example` and `docs/CONFIGURATION.md`. Never hardcode API keys, tokens, or private credentials into source code.
4. **Strict No-Unsolicited-Push Rule**:
   - **Never Push Automatically**: After committing locally on `main`, **NEVER execute `git push` without informing and obtaining explicit confirmation from the user in chat first**. All commits must remain strictly local until pre-approved.
   - **Push Protocol**: Once the user approves, run `git fetch --prune --all`, make sure `main` is fast-forwardable, then `git push origin main`. There is no pull-request or merge step in this workflow.
5. **Mandatory Granular & Atomic Commits Standard**:
   - **Never Bundle Multiple Unrelated Features into a Single Monolithic Commit**: Create independent, atomic commits for each logical unit of work.
   - **Conventional Commits**: Every commit header MUST adhere strictly to Conventional Commits:
     - `feat(...)` — New features (Minor bump)
     - `fix(...)` — Bug fixes (Patch bump)
     - `perf(...)` — Performance improvements
     - `refactor(...)` — Refactoring without behavioral change
     - `docs(...)` — Documentation changes
     - `test(...)` — Adding or correcting tests
     - `ci(...)` — CI/CD workflow changes
     - `chore(...)` — Maintenance tasks
   - **Always Commit with Detailed Information**:
     - Every commit message MUST include a conventional header, a bulleted list of what changed, the architectural rationale, and verification status.
6. **Mandatory CI Review & Fix Resolution Protocol**:
   - **Proactive Review**: After pushing to `main`, inspect the GitHub Actions run results and code-scanning alerts for that commit on `origin`.
   - **Continuous Fix Resolution**: If CI, security linters or scanners flag valid and needed fixes—such as eliminating dynamic evaluation (`new Function`, `eval`), strengthening path traversal boundaries (`path.relative`), resolving security advisories/CWEs, fixing memory leaks, or improving code safety—the agent **MUST proactively address and implement them**.
   - **Re-Verification & Push**: Always verify all fixes locally (`npm run typecheck`, `npm test`) and, after confirmation, push the follow-up commits to `main` so the latest commit is 100% green with zero unresolved blockers or critical warnings.
7. **Mandatory Real-World & External Verification Standard (RBI, Regulators, Internet & Community Sources)**:
   - **Never Hardcode Assumptions Directly into Code**: When dealing with real-world entities—such as banking identifiers, regulatory domain spaces (e.g., RBI/IDRBT `.bank.in` and `.fin.in` mandates), bank SMS headers, transaction email alert senders, or NPCI UPI specification rules—never insert assumptions or arbitrary hardcoded lists directly into source code.
   - **Mandatory Web, Regulatory & Community Verification**: If verification is needed for a real test case, domain whitelist, regex pattern, or banking protocol, the agent MUST proactively verify it against authoritative regulatory sources (RBI circulars, IDRBT registry, NPCI specs) and authentic real-world telemetry (community forums like Reddit, bank documentation, official releases).
   - **Grounding in Real Test Cases & Specifications**: Ensure unit tests, regex patterns, and validation logic reflect actual production formats used by Indian banks and payment networks (including both modern `.bank.in` domain structures and verified legacy commercial notification channels).

---

## Part 2: High-Level Architecture & Integration Guide

### 1. Payment Lifecycle Architecture

NeuroSky Pay V2 is a self-hosted, sovereign payment gateway designed for zero-fee UPI and counter payments with automated banking observation (SMS & Gmail parsing).

```
  [ Merchant Website / App ]
              │
    (1) Adds one script: <script src=".../neurosky.js" data-neurosky-key="...">
              │
    (2) Maps payment button: <button data-neurosky-pay data-order-id="..." data-amount="...">
              │
    (3) NEUROSKY JS dims/blurs background & renders centered responsive modal (or mobile sheet)
              │
    (4) Existing iframe loads /checkout/:id with dynamic single-use QR and UPI intent
              │
    (5) Customer pays via any UPI app (GPay, PhonePe, Paytm, CRED, BHIM)
              │
    (6) Banking Observers detect SMS / Gmail credit notification
              │
    (7) Verification Engine verifies amount, UTR, and timestamps
              │
    (8) Payment State Machine transitions session to SUCCESS
              │
     ┌────────┴──────────────────────────┐
     ▼                                   ▼
 [ Browser CustomEvents ]      [ Signed Webhook Delivery ]
 neurosky:payment:success          POST /api/webhook (HMAC-SHA256)
 (For instant UI feedback)      (AUTHORITATIVE PROOF OF PAYMENT)
```

---

### 2. Universal One-Script Integration

#### Step 1: Script Inclusion

Place the script tag in the page's HTML `<head>` or `<body>`:

```html
<script
  src="https://<neurosky-checkout-host>/neurosky.js"
  data-neurosky-key="YOUR_MERCHANT_KEY"
></script>
```

- When running locally, `<neurosky-checkout-host>` is `http://localhost:7000`.
- In production, it is your canonical checkout portal domain (e.g., `https://pay.yourdomain.com`).

#### Step 2: One-Button Zero-JS Configuration

Tag any clickable button with `data-neurosky-pay`:

```html
<button
  data-neurosky-pay
  data-order-id="ORDER-1001"
  data-amount="499"
  data-currency="INR"
  data-customer-name="Mohit"
  data-customer-email="mohit@example.com"
  data-customer-phone="9876543210"
  data-metadata='{"sku":"TSHIRT-01"}'
>
  Buy Now
</button>
```

The script automatically binds click events to elements with `[data-neurosky-pay]`, including elements created dynamically at runtime.

#### Step 3: Programmatic API (`NeuroSky.pay`)

For single-page apps (React, Next.js, Vue, Nuxt, Svelte), use the programmatic interface:

```javascript
NeuroSky.pay({
  order_id: "ORDER-1001",
  amount: 499.0,
  currency: "INR",
  customer: {
    name: "Mohit",
    email: "mohit@example.com",
    phone: "9876543210",
  },
  metadata: {
    sku: "TSHIRT-01",
    cart_id: "CART-99",
  },
  handler: function (response) {
    console.log("Payment confirmed in modal:", response);
  },
  onClose: function () {
    console.log("Modal closed by customer");
  },
});
```

---

### 3. Normalized Browser Events

The frontend script emits normalized DOM `CustomEvent`s on `window`. They mirror what the checkout iframe reports and are for **UI feedback only**.

| Event Name                    | Trigger Condition                                                                                                   |
| :---------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| `neurosky:payment:observed`   | A bank SMS / Gmail alert matched this UPI session (`status: "OBSERVED_SUCCESS"`, `settlement_state: "NOT_RECONCILED"`) |
| `neurosky:payment:success`    | `status: "SUCCESS"` for a COD order or a confirmed counter payment, or `status: "RECONCILED"` once the admin's bank-statement import matched the UPI payment |
| `neurosky:payment:suspicious` | `status: "MANUAL_REVIEW"` (late or ambiguous alert) or `status: "SUSPICIOUS"` (risk engine)                        |
| `neurosky:payment:failed`     | Verification window elapsed without a matching alert, wrong amount, or declined                                     |
| `neurosky:payment:expired`    | 5-minute active payment window expired                                                                              |
| `neurosky:payment:cancelled`  | Customer cancelled or dismissed the checkout                                                                        |
| `neurosky:payment:result`     | Unified event dispatched on any outcome                                                                             |

#### Payload Contract (`event.detail`):

```javascript
{
  "status": "OBSERVED_SUCCESS",     // 'OBSERVED_SUCCESS' | 'RECONCILED' | 'MANUAL_REVIEW' | 'SUCCESS' | 'FAILED' | 'SUSPICIOUS' | 'EXPIRED' | 'CANCELLED'
  "order_id": "ORDER-1001",
  "amount_received": 499.00,
  "payment_mode": "UPI",            // 'UPI' | 'COD' | 'CASH_COUNTER' | 'CARD_COUNTER'
  "utr": "123456789012",            // 12-digit bank reference number ('' when none)
  "settlement_state": "NOT_RECONCILED", // UPI outcomes only: 'NOT_RECONCILED' | 'RECONCILED' | 'MANUAL_REVIEW'
  "timestamp": "2026-10-07T12:00:00.000Z",
  "metadata": { "sku": "TSHIRT-01" }
}
```

---

### 4. Authoritative Server-to-Server Webhooks

> **CRITICAL RULE**: Browser events are strictly for user interface updates.  
> **NEVER** mark orders as fulfilled or deliver digital goods based on browser events. Only fulfill orders after verifying the server-to-server webhook!  
> **RAW BODY REQUIREMENT**: Request bytes must **NOT** be parsed to JSON before HMAC calculation. Always compute HMAC over raw unparsed request bytes!

#### When a webhook is sent

One signed `POST` per payment **per event**; a payment can receive several events over its life (for example `OBSERVED_SUCCESS` first and `RECONCILED` days later).

| `event` / `X-Gateway-Event` | Sent when                                                                                         | `settlementState`     |
| :-------------------------- | :------------------------------------------------------------------------------------------------ | :-------------------- |
| `SUCCESS` (`method: UPI`)   | **Default (`NEUROSKY_UPI_FINALITY=OBSERVER`)**: a bank SMS / Gmail credit alert matched the UPI session. The payment is settled | `OBSERVER_VERIFIED`   |
| `SUCCESS` (`method: COD` / `CASH_COUNTER` / `CARD_COUNTER`) | A Cash on Delivery order was placed or a counter payment was confirmed. For COD no money has moved yet | `NOT_BANK_SETTLEMENT` |
| `OBSERVED_SUCCESS`          | Only in `STATEMENT` mode: the alert matched but a bank-statement import has not confirmed it yet          | `NOT_RECONCILED`      |
| `RECONCILED`                | Only in `STATEMENT` mode: an admin imported a bank-statement CSV and one line matched this payment       | `RECONCILED`          |
| `MANUAL_REVIEW`             | The alert was late or ambiguous; an operator must decide                                           | `MANUAL_REVIEW`       |
| `FAILED`                    | The verification window elapsed with no matching alert                                            | `NOT_APPLICABLE`      |
| `EXPIRED`                   | The 5-minute payment window elapsed                                                               | `NOT_APPLICABLE`      |
| `CANCELLED`                 | The customer cancelled the checkout                                                               | `NOT_APPLICABLE`      |

#### Webhook Request Specifications:

- **HTTP Method**: `POST`
- **Headers**:
  - `Content-Type: application/json`
  - `X-Gateway-Event: <event>`
  - `X-Gateway-Signature: sha256=<hex HMAC-SHA256(rawBody, webhookSecret)>`
  - `X-Gateway-Signature-V2: sha256=<hex HMAC-SHA256(timestamp + "." + rawBody, webhookSecret)>`
  - `X-Gateway-Delivery-Id: <uuid>` (identical on every retry of the same delivery)
  - `X-Gateway-Timestamp: <ms>` (equals `payload.timestamp`, identical on retries)
- **Delivery**: first attempt immediately on the status change, 10-second timeout, any `2xx` counts as delivered, redirects are not followed. Failed deliveries are retried after 5 s, 30 s, 2 min, 10 min and 1 h, up to `WEBHOOK_MAX_RETRIES` (default 5) attempts in total, with the **same body and signature**. Pending deliveries survive a restart (`webhook_deliveries` table). Webhook URLs must be public; loopback and private addresses are rejected unless `NEUROSKY_ALLOW_PRIVATE_WEBHOOKS=true`.

#### Payload Contract (`payload`):

```json
{
  "event": "OBSERVED_SUCCESS",
  "deliveryId": "4f0a1b2c-6d7e-4f80-9a1b-2c3d4e5f6a7b",
  "timestamp": 1762340000000,
  "paymentId": "c7942127-14e3-469a-9e4a-9359a16f903a",
  "orderId": "ORDER-1001",
  "attemptId": "c7942127-14e3-469a-9e4a-9359a16f903a",
  "amount": "499.00",
  "amountPaise": 49900,
  "currency": "INR",
  "method": "UPI",
  "utr": "123456789012",
  "verificationTag": "SMS_VERIFIED",
  "verificationLevel": 1,
  "completedAt": "2026-10-07T12:00:00.000Z",
  "metadata": { "sku": "TSHIRT-01" },
  "settlementState": "NOT_RECONCILED"
}
```

> **PAYMENT METHOD RULE**: `event: "SUCCESS"` means **paid** only when `payload.method === "UPI"` (settlementState `OBSERVER_VERIFIED`). The same event is also sent when a **Cash on Delivery** order is placed (`method: "COD"`, no money received yet) or a counter payment is confirmed (`CASH_COUNTER` / `CARD_COUNTER`). Always check `payload.event`, `payload.method` and `payload.settlementState` before you treat an order as **paid**. In `STATEMENT` mode UPI sends `OBSERVED_SUCCESS` first and `RECONCILED` after the statement import.

#### Node.js (Express) Webhook Verification Example:

```javascript
import crypto from "node:crypto";

app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const signature = req.headers["x-gateway-signature"] || "";
    const secret = process.env.NEUROSKY_WEBHOOK_SECRET;
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", secret).update(req.body).digest("hex");

    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    const payload = JSON.parse(req.body.toString("utf8"));

    // Retries replay the same deliveryId: process each delivery once.
    if (db.webhookDeliveries.seen(payload.deliveryId)) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    db.webhookDeliveries.remember(payload.deliveryId);

    switch (payload.event) {
      case "SUCCESS":
        if (payload.method === "UPI") {
          // Default finality: the bank alert matched, the payment is settled.
          db.orders.markPaid(payload.orderId, { utr: payload.utr, amount: payload.amount, amountPaise: payload.amountPaise });
        } else {
          // COD placed or counter payment confirmed; payload.method tells which.
          db.orders.markPlaced(payload.orderId, { method: payload.method });
        }
        break;
      case "OBSERVED_SUCCESS":
        // STATEMENT mode only: alert matched, statement import pending. Show "verifying"; do not ship yet.
        db.orders.markObserved(payload.orderId, { utr: payload.utr, amountPaise: payload.amountPaise });
        break;
      case "RECONCILED":
        // STATEMENT mode only: statement line matched.
        if (payload.method === "UPI" && payload.settlementState === "RECONCILED") {
          db.orders.markPaid(payload.orderId, { utr: payload.utr, amount: payload.amount, amountPaise: payload.amountPaise });
        }
        break;
      case "MANUAL_REVIEW":
        db.orders.markOnHold(payload.orderId);
        break;
      case "FAILED":
      case "EXPIRED":
      case "CANCELLED":
        db.orders.markUnpaid(payload.orderId, { reason: payload.event });
        break;
    }

    res.status(200).json({ received: true });
  },
);
```

---

### 5. Security & Architectural Invariants

1. **No Public Force-Success Endpoint**:
   - There is no endpoint that allows a client or developer to arbitrarily declare a payment outcome.
   - A UPI `SUCCESS` (or `OBSERVED_SUCCESS` in `STATEMENT` mode) is generated solely by the internal verification engine after matching a genuine bank SMS/Gmail observation, and `RECONCILED` solely by the admin's bank-statement import. The developer simulator is refused in production unless `NEUROSKY_ALLOW_DEV_TOOLS=true`.
2. **Never Expose Secret API Keys in Frontend**:
   - Only publishable public keys (e.g., `data-neurosky-key`) may appear in HTML/JS.
   - `webhookSecret`, database credentials, and observer tokens must remain strictly on the backend.
3. **Idempotency & Deduplication**:
   - Webhook deliveries include unique `X-Gateway-Delivery-Id` and `orderId`. Merchants must ensure their webhook processing is idempotent.
4. **Preserve Customer Metadata**:
   - Unrecognized fields in `metadata` are passed through untouched and included in webhooks and API responses.
5. **Node.js Engine Standard**:
   - The project strictly targets **Node.js >= 24.22.1** (Active LTS "Krypton") due to built-in `node:sqlite` (`DatabaseSync` Release Candidate with defensive mode) and security hardening against October 2026 CVEs (CVE-2026-111497 Brotli RCE, CVE-2026-105482 DNS truncation, and CVE-2026-105483 TLS bypass).

---

### 6. Service Ports (Standard Topology)

| Service                    | Port   | Description                                          |
| :------------------------- | :----- | :--------------------------------------------------- |
| **Coin Wallet Demo Store** | `5000` | Reference merchant implementation & store            |
| **Payment Core REST API**  | `6100` | Core gateway engine, state machine, queue            |
| **Checkout Portal**        | `7000` | Serves `neurosky.js`, iframe `/checkout/:id`, API proxy |
| **Merchant Admin**         | `6001` | Dashboard for slots, receiving VPAs, observers       |
| **SMS Observer**           | `6002` | Android SMS banking webhook ingester                 |
| **Gmail Observer**         | `6003` | Push notification / Gmail observation ingester       |
| **Process Control Center** | `8090` | Local process supervisor daemon                      |
