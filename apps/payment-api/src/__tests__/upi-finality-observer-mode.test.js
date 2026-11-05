import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@neurosky/db';
import { PaymentStatus, resolveSecret, upiFinalityMode, observerOutcomeStatus, observerOutcomeEvent, upiSuccessIsFinal } from '@neurosky/common';
import { settlementStateFor } from '@neurosky/core';
import { startServer as startPaymentApi } from '../index.js';
import { AndroidObserverDriver } from '../../../android-observer-app/driver.js';

// This suite exercises the DEFAULT finality: a verified bank alert settles a UPI payment as SUCCESS.
process.env.NEUROSKY_UPI_FINALITY = 'OBSERVER';
process.env.NEUROSKY_ALLOW_PRIVATE_WEBHOOKS = 'true';

const MERCHANT = '00000000-0000-0000-0000-000000000001';
const ACCOUNT = '00000000-0000-0000-0000-000000000002';

describe('UPI finality policy helpers', () => {
  it('defaults to OBSERVER and maps to SUCCESS; STATEMENT keeps the two-step flow', () => {
    assert.equal(upiFinalityMode({}), 'OBSERVER');
    assert.equal(upiFinalityMode({ NEUROSKY_UPI_FINALITY: 'statement' }), 'STATEMENT');
    assert.equal(upiFinalityMode({ NEUROSKY_UPI_FINALITY: 'nonsense' }), 'OBSERVER');
    assert.equal(observerOutcomeStatus({}), 'SUCCESS');
    assert.equal(observerOutcomeEvent({}), 'PAYMENT.SUCCESS');
    assert.equal(observerOutcomeStatus({ NEUROSKY_UPI_FINALITY: 'STATEMENT' }), 'OBSERVED_SUCCESS');
    assert.equal(upiSuccessIsFinal({ NEUROSKY_UPI_FINALITY: 'STATEMENT' }), false);
  });

  it('settlementStateFor distinguishes UPI SUCCESS from COD / counter SUCCESS', () => {
    assert.equal(settlementStateFor('SUCCESS', 'UPI'), 'OBSERVER_VERIFIED');
    assert.equal(settlementStateFor('SUCCESS', 'COD'), 'NOT_BANK_SETTLEMENT');
    assert.equal(settlementStateFor('SUCCESS', 'CASH_COUNTER'), 'NOT_BANK_SETTLEMENT');
    assert.equal(settlementStateFor('OBSERVED_SUCCESS', 'UPI'), 'NOT_RECONCILED');
    assert.equal(settlementStateFor('RECONCILED', 'UPI'), 'RECONCILED');
  });
});

describe('OBSERVER finality: a verified bank SMS settles the UPI payment as SUCCESS', () => {
  let apiInstance;
  let testDb;
  let driver;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6225, testDb);
    driver = new AndroidObserverDriver({ apiBaseUrl: `http://localhost:${apiInstance.port}`, deviceName: 'Finality Tester', deviceModel: 'Pixel' });
    await driver.pair(resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET'));
  });

  after(async () => {
    driver.stopHeartbeat();
    if (apiInstance) await apiInstance.close();
    if (testDb) testDb.close();
  });

  it('session -> SUCCESS, event SUCCESS, webhook SUCCESS with method UPI and settlementState OBSERVER_VERIFIED', async () => {
    const ctx = apiInstance.app.context;
    const session = ctx.sessionRepo.create({
      merchantId: MERCHANT,
      receivingAccountId: ACCOUNT,
      orderId: 'FINALITY-ORD-1',
      amountPaise: 12300n
    });
    ctx.queueEngine.enqueueOrActivate(session.id, ACCOUNT);
    ctx.timingEngine.handlePaymentDone(session.id);

    const successEvents = [];
    const observedEvents = [];
    ctx.eventEmitter.on('PAYMENT.SUCCESS', (d) => successEvents.push(d));
    ctx.eventEmitter.on('PAYMENT.OBSERVED_SUCCESS', (d) => observedEvents.push(d));

    const res = await driver.submitObservation({
      amount: '123.00',
      receivingAccountId: ACCOUNT,
      utr: '431234567890',
      senderVpa: 'customer@okaxis',
      notificationText: 'Rs.123.00 credited to A/c XX1234 by VPA customer@okaxis (UPI Ref No 431234567890)'
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.attribution.attributed, true);
    assert.equal(res.body.attribution.outcomeStatus, PaymentStatus.SUCCESS);

    const updated = ctx.sessionRepo.findById(session.id);
    assert.equal(updated.status, PaymentStatus.SUCCESS);
    assert.match(updated.verificationTag || '', /OBSERVER_VERIFIED/);
    assert.ok(updated.completedAt, 'completedAt is set on settlement');

    assert.equal(successEvents.filter(e => e.paymentId === session.id).length, 1, 'exactly one PAYMENT.SUCCESS event');
    assert.equal(observedEvents.filter(e => e.paymentId === session.id).length, 0, 'no PAYMENT.OBSERVED_SUCCESS event in OBSERVER mode');

    // The slot is released so the next customer can pay
    const account = testDb.queryOne('SELECT is_slot_busy, current_active_session_id FROM payment_receiving_accounts WHERE id = ?', [ACCOUNT]);
    assert.equal(Number(account.is_slot_busy), 0);

    // Webhook delivery row carries the public contract (the delivery itself may fail: no receiver in tests)
    let delivery = null;
    for (let i = 0; i < 40 && !delivery; i++) {
      delivery = testDb.queryOne('SELECT event_type, payload FROM webhook_deliveries WHERE payment_id = ? ORDER BY created_at DESC LIMIT 1', [session.id]);
      if (!delivery) await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(delivery, 'a webhook delivery row exists');
    assert.equal(delivery.event_type, 'SUCCESS');
    const payload = JSON.parse(delivery.payload);
    assert.equal(payload.event, 'SUCCESS');
    assert.equal(payload.method, 'UPI');
    assert.equal(payload.settlementState, 'OBSERVER_VERIFIED');
    assert.equal(payload.amountPaise, 12300);
    assert.equal(payload.utr, '431234567890');
  });

  it('GET /api/v1/payments/:id reports SUCCESS with settlementState OBSERVER_VERIFIED', async () => {
    const ctx = apiInstance.app.context;
    const row = testDb.queryOne("SELECT id FROM payment_sessions WHERE order_id = 'FINALITY-ORD-1'");
    const session = ctx.sessionRepo.findById(row.id);
    assert.equal(session.status, PaymentStatus.SUCCESS);
    const res = await fetch(`http://localhost:${apiInstance.port}/api/v1/payments/${row.id}`, {
      headers: { 'X-Merchant-Id': MERCHANT, Authorization: `Bearer ${process.env.ADMIN_API_TOKEN || ''}` }
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.status, 'SUCCESS');
    assert.equal(body.settlementState, 'OBSERVER_VERIFIED');
  });
});
