import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@neurosky/db';
import { BankSmsParser, evaluateAndroidSmsFilter, dryRunBankSms } from '@neurosky/core';
import { startServer as startPaymentApi } from '../index.js';
import { authFetch } from '../../../../scripts/test-support.js';

const GOOD_SMS = 'Rs.1.00 credited to A/c XX1234 on 04-11-26 by a/c linked to VPA rahul@okaxis (UPI Ref No 431234567890) - HDFC Bank';

describe('Android on-device SMS filter (JS mirror of BankSmsFilter.java)', () => {
  it('forwards a standard bank credit alert and extracts amount and UTR', () => {
    const decision = evaluateAndroidSmsFilter('VM-HDFCBK', GOOD_SMS);
    assert.equal(decision.forwarded, true);
    assert.equal(decision.reason, 'ACCEPTED_BANK_CREDIT_ALERT');
    assert.equal(decision.amountPaise, 100);
    assert.equal(decision.bankRef, '431234567890');
  });

  it('drops SMS from a plain mobile number', () => {
    assert.equal(evaluateAndroidSmsFilter('+919876543210', GOOD_SMS).reason, 'PERSONAL_PHONE_NUMBER_REJECTED');
  });

  it('drops senders that are not TRAI institutional headers', () => {
    assert.equal(evaluateAndroidSmsFilter('HELLO WORLD 12345', GOOD_SMS).reason, 'NON_INSTITUTIONAL_SENDER');
  });

  it('drops text without a credit keyword', () => {
    assert.equal(evaluateAndroidSmsFilter('VM-HDFCBK', 'Rs.500.00 debited from A/c XX1234. UPI Ref No 431234567890').reason, 'NO_CREDIT_KEYWORD');
  });

  it('drops debit alerts even when a credit word is also present', () => {
    assert.equal(evaluateAndroidSmsFilter('VM-HDFCBK', 'Rs.500.00 paid to Amazon. Payment received by merchant. UPI Ref 431234567890').reason, 'DEBIT_ALERT_REJECTED');
  });

  it('drops text without a currency-prefixed amount', () => {
    assert.equal(evaluateAndroidSmsFilter('VM-HDFCBK', 'Your A/c XX1234 is credited. UPI Ref No 431234567890').reason, 'NO_AMOUNT_FOUND');
  });

  it('still forwards when the UTR is missing (the server decides about the reference)', () => {
    const decision = evaluateAndroidSmsFilter('AD-SBIINB', 'Rs.1.00 credited to A/c XX1234 by UPI');
    assert.equal(decision.forwarded, true);
    assert.equal(decision.bankRef, null);
  });
});

describe('BankSmsParser.inspect reports why a message is rejected', () => {
  it('parse() still returns the parsed object for a good SMS', () => {
    const parsed = BankSmsParser.parse({ text: GOOD_SMS });
    assert.ok(parsed);
    assert.equal(parsed.amount, '1.00');
    assert.equal(Number(parsed.amountPaise), 100);
    assert.equal(parsed.bankReferenceNumber, '431234567890');
    assert.equal(parsed.senderVpa, 'rahul@okaxis');
    assert.deepEqual(BankSmsParser.inspect({ text: GOOD_SMS }).failure, null);
  });

  it('NO_CREDIT_KEYWORD when only a bare "Cr" marker is present', () => {
    const result = BankSmsParser.inspect({ text: 'Rs.500.00 Cr to A/c XX1234 UPI Ref No 431234567890' });
    assert.equal(result.parsed, null);
    assert.equal(result.failure, 'NO_CREDIT_KEYWORD');
    assert.equal(BankSmsParser.parse({ text: 'Rs.500.00 Cr to A/c XX1234 UPI Ref No 431234567890' }), null);
  });

  it('DEBIT_CONTEXT when the debit word comes before the credit word', () => {
    assert.equal(BankSmsParser.inspect({ text: 'Rs.500.00 debited from A/c XX1234 and credited to merchant. UPI Ref No 431234567890' }).failure, 'DEBIT_CONTEXT');
  });

  it('NO_AMOUNT when no amount can be extracted', () => {
    assert.equal(BankSmsParser.inspect({ text: 'Your account has been credited by a transfer.' }).failure, 'NO_AMOUNT');
  });

  it('EMPTY_TEXT for an empty message', () => {
    assert.equal(BankSmsParser.inspect({ text: '   ' }).failure, 'EMPTY_TEXT');
  });
});

describe('dryRunBankSms verdicts', () => {
  it('READY for a standard bank credit SMS', () => {
    const result = dryRunBankSms({ sender: 'VM-HDFCBK', text: GOOD_SMS });
    assert.equal(result.verdict, 'READY');
    assert.equal(result.phone.forwarded, true);
    assert.equal(result.parser.amountPaise, 100);
    assert.equal(result.reference.value, '431234567890');
    assert.equal(result.reference.isTwelveDigit, true);
    assert.equal(result.reference.source, 'parser');
    assert.deepEqual(result.hints, []);
  });

  it('PHONE_WOULD_DROP for a numeric sender, while still showing what the parser would read', () => {
    const result = dryRunBankSms({ sender: '9876543210', text: GOOD_SMS });
    assert.equal(result.verdict, 'PHONE_WOULD_DROP');
    assert.equal(result.phone.reason, 'PERSONAL_PHONE_NUMBER_REJECTED');
    assert.equal(result.parser.parsed, true);
    assert.ok(result.hints[0].includes('phone number'));
  });

  it('PARSER_WOULD_REJECT when the phone forwards but the server finds no credit phrase', () => {
    const result = dryRunBankSms({ sender: 'VM-HDFCBK', text: 'Rs.500.00 Cr to A/c XX1234 UPI Ref No 431234567890' });
    assert.equal(result.phone.forwarded, true);
    assert.equal(result.verdict, 'PARSER_WOULD_REJECT');
    assert.equal(result.parser.failure, 'NO_CREDIT_KEYWORD');
  });

  it('REFERENCE_MISSING when the amount parses but no transaction reference exists', () => {
    const result = dryRunBankSms({ sender: 'AD-SBIINB', text: 'Rs.1.00 credited to A/c XX1234 by UPI' });
    assert.equal(result.verdict, 'REFERENCE_MISSING');
    assert.equal(result.parser.parsed, true);
    assert.equal(result.reference.present, false);
  });

  it('falls back to a bare 12-digit number in the text, like the verification pipeline', () => {
    const result = dryRunBankSms({ sender: 'AD-SBIINB', text: 'Rs.1.00 credited to A/c XX1234 by UPI 431234567890' });
    assert.equal(result.verdict, 'READY');
    assert.equal(result.reference.value, '431234567890');
  });
});

describe('POST /api/v1/admin/sms-gateway/parse-test', () => {
  let apiInstance;
  let testDb;
  const baseUrl = 'http://localhost:6218';

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6218, testDb);
  });

  after(async () => {
    if (apiInstance) await apiInstance.close();
    if (testDb) testDb.close();
  });

  const countObservations = () => Number(testDb.queryOne('SELECT COUNT(*) AS c FROM payment_observations')?.c || 0);

  it('requires the admin token', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/sms-gateway/parse-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'VM-HDFCBK', body: GOOD_SMS })
    });
    assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
  });

  it('returns the verdict and records nothing', async () => {
    const before = countObservations();
    const res = await authFetch(`${baseUrl}/api/v1/admin/sms-gateway/parse-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'VM-HDFCBK', body: GOOD_SMS })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.dryRun, true);
    assert.equal(data.verdict, 'READY');
    assert.equal(data.parser.amountPaise, 100);
    assert.equal(data.reference.value, '431234567890');
    assert.equal(countObservations(), before, 'a dry run must not store an observation');
  });

  it('rejects an empty message with 400', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/sms-gateway/parse-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'VM-HDFCBK', body: '' })
    });
    assert.equal(res.status, 400);
  });
});
