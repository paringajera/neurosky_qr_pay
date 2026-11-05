/**
 * Android observer telemetry and liveness.
 *
 * The phone that receives the bank SMS sends a heartbeat every 30 seconds. From release 1.1.0 the
 * heartbeat declares `heartbeatVersion: 2` and carries real telemetry (battery, charging state,
 * network type, app version, number of SMS waiting to be uploaded). The first release sent a fixed
 * `100 / charging` placeholder, so telemetry is only trusted when the version is declared.
 *
 * Liveness has two thresholds on purpose:
 * - ANDROID_HEARTBEAT_TIMEOUT_MS (default 3 minutes) drives the dashboard's online/offline badge and
 *   the one-shot "device offline" audit event produced by sweepOfflineAndroidDevices().
 * - The checkout stops accepting new UPI sessions after 5 minutes without a heartbeat
 *   (checkUpiServerHealth); that gate is deliberately more tolerant than the badge.
 */

export const DEFAULT_ANDROID_HEARTBEAT_TIMEOUT_MS = 180000;
export const ANDROID_HEARTBEAT_INTERVAL_MS = 30000;

export const DEVICE_AUDIT_ACTIONS = Object.freeze({
  OFFLINE: 'ANDROID_DEVICE_OFFLINE',
  ONLINE: 'ANDROID_DEVICE_ONLINE'
});

const NETWORK_TYPES = new Set(['WIFI', 'MOBILE', 'ETHERNET', 'VPN', 'NONE']);

/**
 * Heartbeat timeout for the online badge and the offline event, clamped to 30 s .. 60 min.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function androidHeartbeatTimeoutMs(env = process.env) {
  const raw = Number(env.ANDROID_HEARTBEAT_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ANDROID_HEARTBEAT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(raw), 30000), 3600000);
}

/**
 * Normalises the telemetry a heartbeat may carry. Unknown or out-of-range values become null; a
 * heartbeat without `heartbeatVersion >= 2` yields no telemetry at all.
 * @param {any} body parsed heartbeat JSON
 * @returns {{ telemetryAvailable: boolean, batteryPercent: number | null, isCharging: boolean | null, networkType: string | null, appVersion: string | null, pendingSmsCount: number | null }}
 */
export function normalizeDeviceTelemetry(body = {}) {
  const none = { telemetryAvailable: false, batteryPercent: null, isCharging: null, networkType: null, appVersion: null, pendingSmsCount: null };
  const version = Number(body?.heartbeatVersion || 0);
  if (!Number.isFinite(version) || version < 2) return none;

  const battery = Number(body.batteryPercent);
  const batteryPercent = Number.isFinite(battery) && battery >= 0 && battery <= 100 ? Math.round(battery) : null;
  const isCharging = typeof body.isCharging === 'boolean' ? body.isCharging : null;
  const net = String(body.networkType || '').trim().toUpperCase();
  const networkType = net ? (NETWORK_TYPES.has(net) ? net : 'OTHER') : null;
  const ver = String(body.appVersion || '').trim();
  const appVersion = /^[A-Za-z0-9._+-]{1,32}$/.test(ver) ? ver : null;
  const pending = Number(body.pendingSmsCount);
  const pendingSmsCount = Number.isFinite(pending) && pending >= 0 ? Math.min(Math.round(pending), 9999) : null;

  return { telemetryAvailable: true, batteryPercent, isCharging, networkType, appVersion, pendingSmsCount };
}

/**
 * Stores a heartbeat (timestamp + telemetry) and clears an earlier offline flag. When the device had
 * been flagged offline, an ANDROID_DEVICE_ONLINE audit entry is written and 'device:online' emitted.
 * @param {{ db: any, auditRepo?: any, eventEmitter?: any, deviceId: string, telemetry: ReturnType<typeof normalizeDeviceTelemetry> }} input
 * @returns {{ known: boolean, cameBackOnline: boolean }}
 */
export function recordAndroidHeartbeat({ db, auditRepo = null, eventEmitter = null, deviceId, telemetry }) {
  const existing = db.queryOne('SELECT merchant_id, device_name, offline_alerted_at, last_heartbeat_at FROM android_devices WHERE id = ?', [deviceId]);
  if (!existing) return { known: false, cameBackOnline: false };

  db.execute(
    `UPDATE android_devices
        SET last_heartbeat_at = datetime('now'),
            battery_percent = ?, is_charging = ?, network_type = ?, app_version = ?, pending_sms_count = ?,
            offline_alerted_at = NULL
      WHERE id = ?`,
    [
      telemetry.batteryPercent,
      telemetry.isCharging === null ? null : (telemetry.isCharging ? 1 : 0),
      telemetry.networkType,
      telemetry.appVersion,
      telemetry.pendingSmsCount,
      deviceId
    ]
  );

  const cameBackOnline = Boolean(existing.offline_alerted_at);
  if (cameBackOnline) {
    const event = {
      deviceId,
      merchantId: existing.merchant_id,
      deviceName: existing.device_name,
      offlineFlaggedAt: existing.offline_alerted_at,
      lastHeartbeatBefore: existing.last_heartbeat_at
    };
    try { auditRepo?.log({ merchantId: existing.merchant_id, entityType: 'ANDROID_DEVICE', entityId: deviceId, action: DEVICE_AUDIT_ACTIONS.ONLINE, details: event }); } catch {}
    try { eventEmitter?.emit?.('device:online', event); } catch {}
  }
  return { known: true, cameBackOnline };
}

/**
 * Flags, exactly once, every active device whose heartbeat is older than the timeout: sets
 * offline_alerted_at, writes an ANDROID_DEVICE_OFFLINE audit entry and emits 'device:offline'.
 * Safe to call from a timer; returns the devices flagged in this sweep.
 * @param {{ db: any, auditRepo?: any, eventEmitter?: any, timeoutMs?: number }} input
 */
export function sweepOfflineAndroidDevices({ db, auditRepo = null, eventEmitter = null, timeoutMs = androidHeartbeatTimeoutMs() } = {}) {
  if (!db) return [];
  const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000));
  const rows = db.query(
    `SELECT id, merchant_id, device_name, last_heartbeat_at,
            CAST((julianday('now') - julianday(last_heartbeat_at)) * 86400 AS INTEGER) AS seconds_since_heartbeat
       FROM android_devices
      WHERE is_active = 1
        AND last_heartbeat_at IS NOT NULL
        AND offline_alerted_at IS NULL
        AND (julianday('now') - julianday(last_heartbeat_at)) * 86400 > ?`,
    [timeoutSeconds]
  ) || [];

  const flagged = [];
  for (const row of rows) {
    db.execute(`UPDATE android_devices SET offline_alerted_at = datetime('now') WHERE id = ? AND offline_alerted_at IS NULL`, [row.id]);
    const event = {
      deviceId: row.id,
      merchantId: row.merchant_id,
      deviceName: row.device_name,
      lastHeartbeatAt: row.last_heartbeat_at,
      secondsSinceHeartbeat: Number(row.seconds_since_heartbeat),
      timeoutMs
    };
    try { auditRepo?.log({ merchantId: row.merchant_id, entityType: 'ANDROID_DEVICE', entityId: row.id, action: DEVICE_AUDIT_ACTIONS.OFFLINE, details: event }); } catch {}
    try { eventEmitter?.emit?.('device:offline', event); } catch {}
    flagged.push(event);
  }
  return flagged;
}

/**
 * Lists the Android observers of a merchant with liveness and telemetry fields for the dashboard.
 * Ages are computed in SQL (UTC) so the result does not depend on the server's time zone.
 * @param {{ db: any, merchantId: string, timeoutMs?: number }} input
 */
export function listAndroidDevices({ db, merchantId, timeoutMs = androidHeartbeatTimeoutMs() }) {
  const rows = db.query(
    `SELECT id, device_name, device_model, is_active, created_at,
            last_heartbeat_at, last_observation_at,
            battery_percent, is_charging, network_type, app_version, pending_sms_count, offline_alerted_at,
            CASE WHEN last_heartbeat_at IS NULL THEN NULL ELSE CAST((julianday('now') - julianday(last_heartbeat_at)) * 86400 AS INTEGER) END AS seconds_since_heartbeat,
            CASE WHEN last_observation_at IS NULL THEN NULL ELSE CAST((julianday('now') - julianday(last_observation_at)) * 86400 AS INTEGER) END AS seconds_since_observation,
            CASE WHEN last_heartbeat_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%SZ', last_heartbeat_at) END AS last_heartbeat_iso,
            CASE WHEN last_observation_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%SZ', last_observation_at) END AS last_observation_iso
       FROM android_devices
      WHERE merchant_id = ? OR merchant_id = '00000000-0000-0000-0000-000000000001'
      ORDER BY created_at DESC`,
    [merchantId]
  ) || [];

  return rows.map(d => {
    const secondsSinceHeartbeat = d.seconds_since_heartbeat === null || d.seconds_since_heartbeat === undefined ? null : Number(d.seconds_since_heartbeat);
    const secondsSinceObservation = d.seconds_since_observation === null || d.seconds_since_observation === undefined ? null : Number(d.seconds_since_observation);
    const online = secondsSinceHeartbeat !== null && secondsSinceHeartbeat * 1000 <= timeoutMs;
    const name = d.device_name || d.device_model || 'Android Observer';
    return {
      id: d.id,
      deviceId: d.id,
      deviceName: name,
      device_name: name,
      deviceModel: d.device_model,
      device_model: d.device_model,
      isActive: Boolean(d.is_active),
      is_active: d.is_active,
      lastHeartbeatAt: d.last_heartbeat_iso || d.last_heartbeat_at || null,
      last_heartbeat_at: d.last_heartbeat_at,
      lastObservationAt: d.last_observation_iso || d.last_observation_at || null,
      last_observation_at: d.last_observation_at,
      createdAt: d.created_at,
      created_at: d.created_at,
      pairedAt: d.created_at,
      online,
      status: secondsSinceHeartbeat === null ? 'NEVER_SEEN' : (online ? 'ONLINE' : 'OFFLINE'),
      secondsSinceHeartbeat,
      secondsSinceObservation,
      heartbeatTimeoutMs: timeoutMs,
      offlineAlertedAt: d.offline_alerted_at || null,
      telemetryAvailable: d.app_version !== null && d.app_version !== undefined,
      batteryPercent: d.battery_percent === null || d.battery_percent === undefined ? null : Number(d.battery_percent),
      isCharging: d.is_charging === null || d.is_charging === undefined ? null : Boolean(d.is_charging),
      networkType: d.network_type || null,
      appVersion: d.app_version || null,
      pendingSmsCount: d.pending_sms_count === null || d.pending_sms_count === undefined ? null : Number(d.pending_sms_count)
    };
  });
}
