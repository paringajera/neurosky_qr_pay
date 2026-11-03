import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutServer } from '../server.js';
import { BRANDING_CONFIG } from '../config/branding.js';

describe('White-Label Branding & Checkout Identity Tests', () => {
  const server = new CheckoutServer();

  test('renderHtml defaults to NeuroSky Pay and NeuroSky Pay branding when state is minimal/demo', () => {
    const html = server.renderHtml('test-payment-123', {
      orderId: 'ORD-999',
      amount: '500.00'
    });

    // 1. Page title must feature NeuroSky Pay and NeuroSky Pay
    assert.ok(html.includes('<title>NeuroSky Pay · NeuroSky Pay Checkout</title>'), 'Title must have NeuroSky Pay and NeuroSky Pay');

    // 2. Header and Sidebar merchant name
    assert.ok(html.includes('<div class="ypg-merchant-name" id="headerMerchantName">NeuroSky Pay</div>'), 'Header merchant name must be NeuroSky Pay');
    assert.ok(html.includes('<div class="ypg-pc-merchant-name" id="pcMerchantName">NeuroSky Pay</div>'), 'Sidebar merchant name must be NeuroSky Pay');

    // 3. Trust badge must state "Powered by NeuroSky Pay"
    assert.ok(html.includes('Verified Business · Powered by NeuroSky Pay'), 'Trust badge must be Powered by NeuroSky Pay');

    // 4. Logo URL must match official NeuroSky asset
    assert.ok(html.includes(BRANDING_CONFIG.logoUrl), 'Rendered HTML must contain configured NeuroSky logo URL');

    // 5. Customer support details must match NeuroSky support
    assert.ok(html.includes(BRANDING_CONFIG.supportEmail), 'Rendered HTML must contain support@neurosky.local');
    assert.ok(html.includes(BRANDING_CONFIG.supportPhone), 'Rendered HTML must contain +91 8610648309');

    // 6. Splash screen and footer powered by text
    assert.ok(html.includes('<strong id="splashSecuredByText" style="color:var(--ypg-blue); font-size:15px; letter-spacing:-0.2px;">NeuroSky Pay</strong>'), 'Splash footer must say NeuroSky Pay');
    assert.ok(html.includes('Secured by NeuroSky Pay & 256-Bit Bank Encryption'), 'Footer must say Secured by NeuroSky Pay');

    // 7. Success & Processing wording
    assert.ok(html.includes('Processing payment securely with NeuroSky Pay'), 'Processing modal must state NeuroSky Pay');

    // 8. No customer-facing NeuroSky strings in rendered badges/titles
    assert.ok(!html.includes('NeuroSky Pay Verified Business'), 'No NeuroSky Pay Verified Business allowed');
    assert.ok(!html.includes('NeuroSky Pay Trusted Business'), 'No NeuroSky Pay Trusted Business allowed');
    assert.ok(!html.includes('NeuroSky Pay Help &amp; Support'), 'No NeuroSky Pay Help & Support allowed');
  });

  test('renderHtml preserves custom merchant branding when merchant supplies their own brand', () => {
    const html = server.renderHtml('custom-payment-456', {
      merchantName: 'Acme Corp',
      branding: {
        appName: 'Acme Gateway',
        logoUrl: 'https://example.com/logo.png',
        primaryColor: '#ff0000',
        supportEmails: ['help@acme.com'],
        supportMobiles: ['+91 9999999999']
      }
    });

    assert.ok(html.includes('<title>Acme Corp · Acme Gateway Checkout</title>'));
    assert.ok(html.includes('Acme Corp'));
    assert.ok(html.includes('https://example.com/logo.png'));
    assert.ok(html.includes('help@acme.com'));
  });
});
