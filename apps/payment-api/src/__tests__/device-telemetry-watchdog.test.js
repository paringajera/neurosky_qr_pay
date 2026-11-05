import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database, AuditLogRepository } from '@neurosky/db';
import {
  normalizeDeviceTelemetry,
  androidHeartbeatTimeoutMs,
  sweepOfflineAndroidDevices,
  listAndroidDevices,
  DEVICE_AUDIT_ACTIONS
} from '@neurosky/core';
import { startServer as startPaymentApi } from '../index.js';
import { authFetch } from '../../../../scripts/test-support.js';

const MERCHANT = '00000000-0000-0000-0000-000000000001';
const DEVICE = 'dev-telemetry-1';

describe('normalizeDeviceTelemetry', () => {
  it('ignores the v1 placeholder (100% / charging) and reports telemetry as unavailable', () => {
    const t = normalizeDeviceTelemetry({ deviceId: 'x', timestamp: 1, batteryPercent: 100, isCharging: true });
    assert.equal(t.telemetryAvailable, false);
    assert.equal(t.batteryPercent, null);
    assert.equal(t.isCharging, null);
    assert.equal(t.appVersion, null);
  });

  it('accepts v2 telemetry and sanitises it', () => {
    const t = normalizeDeviceTelemetry({ heartbeatVersion: 2, batteryPercent: 57.6, isCharging: false, networkType: 'wifi', appVersion: '1.1.0', pendingSmsCount: 2 });
    assert.deepEqual(t, { telemetryAvailable: true, batteryPercent: 58, isCharging: false, networkType: 'WIFI', appVersion: '1.1.0', pendingSmsCount: 2 });
  });

  it('drops out-of-range or malformed values instead of storing them', () => {
    const t = normalizeDeviceTelemetry({ heartbeatVersion: 2, batteryPercent: 140, isCharging: 'yes', networkType: 'satellite', appVersion: 'bad version!', pendingSmsCount: -3 });
    assert.equal(t.telemetryAvailable, true);
    assert.equal(t.batteryPercent, null);
    assert.equal(t.isCharging, null);
    assert.equal(t.networkType, 'OTHER');
    assert.equal(t.appVersion, null);
    assert.equal(t.pendingSmsCount, null);
  });
});

describe('androidHeartbeatTimeoutMs', () => {
  it('defaults to 3 minutes and clamps the configured value', () => {
    assert.equal(androidHeartbeatTimeoutMs({}), 180000);
    assert.equal(androidHeartbeatTimeoutMs({ ANDROID_HEARTBEAT_TIMEOUT_MS: '600000' }), 600000);
    assert.equal(androidHeartbeatTimeoutMs({ ANDROID_HEARTBEAT_TIMEOUT_MS: '5' }), 30000);
    assert.equal(androidHeartbeatTimeoutMs({ ANDROID_HEARTBEAT_TIMEOUT_MS: '99999999' }), 3600000);
    assert.equal(androidHeartbeatTimeoutMs({ ANDROID_HEARTBEAT_TIMEOUT_MS: 'abc' }), 180000);
  });
});

describe('Heartbeat telemetry, device listing and the offline watchdog', () => {
  let apiInstance;
  let testDb;
  let auditRepo;
  const baseUrl = 'http://localhost:6221';

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6221, testDb);
    auditRepo = new AuditLogRepository(testDb);
    testDb.execute(
      `INSERT INTO android_devices (id, merchant_id, device_name, device_model, signing_key_hash, is_active, created_at)
       VALUES (?, ?, 'Bank SIM Phone', 'SM-A546E', 'hash-telemetry', 1, datetime('now'))`,
      [DEVICE, MERCHANT]
    );
  });

  after(async () => {
    if (apiInstance) await apiInstance.close();
    if (testDb) testDb.close();
  });

  const heartbeat = (extra) => fetch(`${baseUrl}/api/v1/pollers/android/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE },
    body: JSON.stringify({ deviceId: DEVICE, timestamp: Date.now(), ...extra })
  });
  const devices = async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/sms-gateway/devices`);
    assert.equal(res.status, 200);
    return res.json();
  };
  const auditActions = () => testDb
    .query(`SELECT action FROM audit_logs WHERE entity_type = 'ANDROID_DEVICE' AND entity_id = ? ORDER BY created_at, rowid`, [DEVICE])
    .map(r => r.action);

  it('a device that never sent a heartbeat is listed as NEVER_SEEN and offline', async () => {
    const data = await devices();
    const d = data.devices.find(x => x.id === DEVICE);
    assert.ok(d, 'device must be listed');
    assert.equal(d.status, 'NEVER_SEEN');
    assert.equal(d.online, false);
    assert.equal(d.secondsSinceHeartbeat, null);
    assert.equal(data.anyOnline, false);
    assert.equal(typeof data.heartbeatTimeoutMs, 'number');
  });

  it('a v2 heartbeat stores battery, network, app version and pending count and marks the device online', async () => {
    const res = await heartbeat({ heartbeatVersion: 2, batteryPercent: 64, isCharging: true, networkType: 'MOBILE', appVersion: '1.1.0', pendingSmsCount: 1 });
    assert.equal(res.status, 200);
    const ack = await res.json();
    assert.equal(ack.status, 'HEARTBEAT_ACK');
    assert.equal(ack.heartbeatIntervalMs, 30000);

    const data = await devices();
    const d = data.devices.find(x => x.id === DEVICE);
    assert.equal(d.online, true);
    assert.equal(d.status, 'ONLINE');
    assert.ok(d.secondsSinceHeartbeat >= 0 && d.secondsSinceHeartbeat < 60, `fresh heartbeat age was ${d.secondsSinceHeartbeat}s`);
    assert.equal(d.telemetryAvailable, true);
    assert.equal(d.batteryPercent, 64);
    assert.equal(d.isCharging, true);
    assert.equal(d.networkType, 'MOBILE');
    assert.equal(d.appVersion, '1.1.0');
    assert.equal(d.pendingSmsCount, 1);
    assert.match(d.lastHeartbeatAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'heartbeat time is ISO UTC');
    assert.equal(data.anyOnline, true);
    assert.equal(data.pendingSmsTotal, 1);
  });

  it('a legacy v1 heartbeat keeps the device online but reports telemetry as unknown', async () => {
    const res = await heartbeat({ batteryPercent: 100, isCharging: true });
    assert.equal(res.status, 200);
    const data = await devices();
    const d = data.devices.find(x => x.id === DEVICE);
    assert.equal(d.online, true);
    assert.equal(d.telemetryAvailable, false);
    assert.equal(d.batteryPercent, null);
    assert.equal(d.isCharging, null);
    assert.equal(d.appVersion, null);
  });

  it('the watchdog flags a stale device once, the listing shows OFFLINE, and the next heartbeat logs ONLINE', async () => {
    testDb.execute(`UPDATE android_devices SET last_heartbeat_at = datetime('now', '-10 minutes') WHERE id = ?`, [DEVICE]);

    const flagged = sweepOfflineAndroidDevices({ db: testDb, auditRepo, timeoutMs: 180000 });
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].deviceId, DEVICE);
    assert.ok(flagged[0].secondsSinceHeartbeat >= 590);
    assert.deepEqual(auditActions(), [DEVICE_AUDIT_ACTIONS.OFFLINE]);
    assert.equal(sweepOfflineAndroidDevices({ db: testDb, auditRepo, timeoutMs: 180000 }).length, 0, 'a second sweep must not flag the same outage again');

    let data = await devices();
    let d = data.devices.find(x => x.id === DEVICE);
    assert.equal(d.online, false);
    assert.equal(d.status, 'OFFLINE');
    assert.ok(d.offlineAlertedAt, 'offline flag is exposed');
    assert.ok(d.secondsSinceHeartbeat >= 590);
    assert.equal(data.anyOnline, false);

    const res = await heartbeat({ heartbeatVersion: 2, batteryPercent: 40, isCharging: false, networkType: 'WIFI', appVersion: '1.1.0', pendingSmsCount: 0 });
    const ack = await res.json();
    assert.equal(ack.recovered, true);

    data = await devices();
    d = data.devices.find(x => x.id === DEVICE);
    assert.equal(d.online, true);
    assert.equal(d.offlineAlertedAt, null);
    assert.deepEqual(auditActions(), [DEVICE_AUDIT_ACTIONS.OFFLINE, DEVICE_AUDIT_ACTIONS.ONLINE]);
  });

  it('listAndroidDevices computes heartbeat ages in UTC regardless of the process time zone', () => {
    const list = listAndroidDevices({ db: testDb, merchantId: MERCHANT, timeoutMs: 180000 });
    const d = list.find(x => x.id === DEVICE);
    assert.ok(d.secondsSinceHeartbeat >= 0 && d.secondsSinceHeartbeat < 60);
    assert.equal(d.heartbeatTimeoutMs, 180000);
  });
});
