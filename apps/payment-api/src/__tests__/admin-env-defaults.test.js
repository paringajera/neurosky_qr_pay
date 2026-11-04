import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@neurosky/db';
import { startServer as startPaymentApi } from '../index.js';
import { authFetch } from '../../../../scripts/test-support.js';

const MERCHANT_ID = '00000000-0000-0000-0000-000000000001';
const ENV_KEYS = ['NEUROSKY_MODE', 'NODE_ENV', 'CLOUDFLARE_DOMAIN', 'DEPLOYMENT_PREFIX', 'BASE_DEMO_STORE_URL', 'COIN_STORE_WEBHOOK_URL'];

function snapshotEnv() {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

describe('Merchant Admin environment defaults follow the real runtime (regression: production VPS showed LOCALHOST)', () => {
  let apiInstance;
  let testDb;
  let baseUrl;
  let savedEnv;

  before(async () => {
    savedEnv = snapshotEnv();
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6214, testDb);
    baseUrl = 'http://localhost:6214';
  });

  after(async () => {
    restoreEnv(savedEnv);
    if (apiInstance) await apiInstance.close();
    if (testDb) testDb.close();
  });

  it('1. reports production mode, domain and prefix from the process when the merchant has not chosen one', async () => {
    process.env.NEUROSKY_MODE = 'production';
    process.env.CLOUDFLARE_DOMAIN = 'https://Example.test/';
    process.env.DEPLOYMENT_PREFIX = 'pay';

    const res = await authFetch(`${baseUrl}/api/v1/admin/merchant-settings?merchantId=${MERCHANT_ID}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.envMode, 'production');
    assert.strictEqual(body.domainTld, 'example.test');
    assert.strictEqual(body.cloudflareDomain, 'example.test');
    assert.strictEqual(body.deploymentPrefix, 'pay');
    assert.strictEqual(body.runtimeUrls.checkoutUrl, 'https://pay.example.test');
    assert.strictEqual(body.runtimeUrls.apiUrl, 'https://pay-api.example.test');
  });

  it('2. falls back to localhost when the process is not in production mode', async () => {
    process.env.NEUROSKY_MODE = 'localhost';
    delete process.env.CLOUDFLARE_DOMAIN;

    const res = await authFetch(`${baseUrl}/api/v1/admin/merchant-settings?merchantId=${MERCHANT_ID}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.envMode, 'localhost');
    assert.strictEqual(body.runtimeUrls.checkoutUrl, 'http://localhost:7000');
  });

  it('3. an explicit merchant choice still wins over the runtime default', async () => {
    process.env.NEUROSKY_MODE = 'production';
    process.env.CLOUDFLARE_DOMAIN = 'example.test';

    const update = await authFetch(`${baseUrl}/api/v1/admin/merchant-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchantId: MERCHANT_ID, envMode: 'localhost', domainTld: '', deploymentPrefix: 'pay' })
    });
    assert.strictEqual(update.status, 200);

    const res = await authFetch(`${baseUrl}/api/v1/admin/merchant-settings?merchantId=${MERCHANT_ID}`);
    const body = await res.json();
    assert.strictEqual(body.envMode, 'localhost', 'a stored envMode must not be overridden by the runtime default');
  });
});
