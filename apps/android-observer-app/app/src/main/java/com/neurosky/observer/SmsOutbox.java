package com.neurosky.observer;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Durable queue for bank SMS that could not be uploaded (no network, gateway unreachable).
 *
 * Entries live in SharedPreferences as a JSON array, so they survive app restarts and reboots.
 * Replay keeps the original order and the original SMS timestamp; the gateway de-duplicates by
 * clientMessageId and by message fingerprint, so a retry can never create a second observation.
 * The queue is drained after every heartbeat and as soon as connectivity returns.
 */
public final class SmsOutbox {
    private static final String TAG = "NeuroSkySmsOutbox";
    private static final String PREFS_NAME = "neuroskypay_sms_outbox";
    private static final String KEY_ITEMS = "items";
    private static final int MAX_ITEMS = 200;
    // Retries happen every 30 s, so this is several hours; afterwards the entry is dropped with a log line.
    private static final int MAX_ATTEMPTS = 500;
    private static final Object LOCK = new Object();

    private SmsOutbox() {}

    /** Stores an SMS whose upload just failed. */
    public static void enqueue(Context context, String sender, String body, long timestamp, String clientMessageId) {
        synchronized (LOCK) {
            try {
                JSONArray items = load(context);
                JSONObject item = new JSONObject();
                item.put("sender", sender != null ? sender : "UNKNOWN");
                item.put("body", body != null ? body : "");
                item.put("timestamp", timestamp);
                item.put("clientMessageId", clientMessageId != null ? clientMessageId : "");
                item.put("queuedAt", System.currentTimeMillis());
                item.put("attempts", 0);
                items.put(item);
                while (items.length() > MAX_ITEMS) {
                    items.remove(0);
                }
                save(context, items);
                Log.w(TAG, "Queued bank SMS for later upload (" + clientMessageId + "); pending=" + items.length());
            } catch (Exception e) {
                Log.e(TAG, "enqueue failed: " + e.getMessage());
            }
        }
    }

    /** Number of SMS still waiting to be uploaded (reported in every heartbeat). */
    public static int count(Context context) {
        synchronized (LOCK) {
            return load(context).length();
        }
    }

    /**
     * Uploads queued SMS in order and stops at the first failure so order is preserved.
     * @return how many entries were delivered in this pass
     */
    public static int flush(Context context, ApiClient client) {
        synchronized (LOCK) {
            JSONArray items = load(context);
            if (items.length() == 0 || client == null || !client.isPaired()) return 0;

            int delivered = 0;
            boolean stopped = false;
            JSONArray remaining = new JSONArray();
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                if (stopped) {
                    remaining.put(item);
                    continue;
                }
                String clientMessageId = item.optString("clientMessageId", "");
                boolean ok = client.sendSms(
                    item.optString("sender", "UNKNOWN"),
                    item.optString("body", ""),
                    item.optLong("timestamp", 0L),
                    clientMessageId.isEmpty() ? null : clientMessageId
                );
                if (ok) {
                    delivered++;
                    continue;
                }
                int attempts = item.optInt("attempts", 0) + 1;
                if (attempts >= MAX_ATTEMPTS) {
                    Log.e(TAG, "Dropping SMS after " + attempts + " failed uploads: " + clientMessageId);
                    continue;
                }
                try {
                    item.put("attempts", attempts);
                } catch (Exception ignored) {
                }
                remaining.put(item);
                stopped = true;
            }
            save(context, remaining);
            if (delivered > 0) {
                Log.i(TAG, "Uploaded " + delivered + " queued bank SMS; pending=" + remaining.length());
            }
            return delivered;
        }
    }

    private static JSONArray load(Context context) {
        try {
            SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            return new JSONArray(prefs.getString(KEY_ITEMS, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private static void save(Context context, JSONArray items) {
        SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY_ITEMS, items.toString()).apply();
    }
}
