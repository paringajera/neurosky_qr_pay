/**
 * JavaScript mirror of the Android observer's on-device filter
 * (apps/android-observer-app/app/src/main/java/com/neurosky/observer/BankSmsFilter.java).
 *
 * The phone decides locally whether a bank SMS is forwarded to the gateway at all. This port lets
 * the dashboard tell an operator in advance whether their bank's message would even leave the
 * phone. Keep both implementations in sync when either changes.
 */

// Standard TRAI institutional sender (e.g. VK-HDFCBK, AX-SBIINB, BZ-ICICIB, VM-AXISBK, or HDFCBK)
const INSTITUTIONAL_SENDER_PATTERN = /^(?:[A-Za-z]{2}-)?([A-Za-z0-9]{3,9})$/;
// Pure numeric sender (personal mobile numbers, international prefixes)
const NUMERIC_PHONE_PATTERN = /^\+?[0-9]{7,15}$/;
// Inbound credit / deposit keywords
const CREDIT_KEYWORD_PATTERN = /(?:credited|received|deposit(?:ed)?|payment\s+received|transferred\s+to\s+your|has\s+transferred|deposited\s+in|cr\b|upi\s+credit)/i;
// Explicit debit keywords
const EXPLICIT_DEBIT_PATTERN = /(?:debited\b|spent\s+on|paid\s+to|withdrawn\s+from|dr\b|payment\s+sent)/i;
// Monetary amount with a currency prefix (Rs. 500.00, INR 1,250, ₹ 200.50)
const AMOUNT_PATTERN = /(?:Rs\.?|INR|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i;
// Optional 12-digit UPI transaction reference
const UTR_PATTERN = /(?:UPI\s*(?:ref|reference|txn|id)?|Ref(?:erence)?\s*(?:no|number)?|UTR|IMPS\s*Ref)\s*[:#-]?\s*([0-9]{12})/i;

export const ANDROID_SMS_FILTER_ACCEPTED = 'ACCEPTED_BANK_CREDIT_ALERT';

/**
 * Evaluates an SMS exactly like the phone does before any network call.
 * @param {string} sender originating address as shown by the SMS app
 * @param {string} body message text
 * @returns {{ forwarded: boolean, reason: string, amountPaise: number | null, bankRef: string | null }}
 */
export function evaluateAndroidSmsFilter(sender, body) {
  const reject = (reason) => ({ forwarded: false, reason, amountPaise: null, bankRef: null });
  if (typeof sender !== 'string' || !sender.trim()) return reject('EMPTY_SENDER');
  if (typeof body !== 'string' || !body.trim()) return reject('EMPTY_BODY');

  const cleanSender = sender.trim().replace(/\s+/g, '');
  if (NUMERIC_PHONE_PATTERN.test(cleanSender)) return reject('PERSONAL_PHONE_NUMBER_REJECTED');
  if (!INSTITUTIONAL_SENDER_PATTERN.test(cleanSender)) return reject('NON_INSTITUTIONAL_SENDER');
  if (!CREDIT_KEYWORD_PATTERN.test(body)) return reject('NO_CREDIT_KEYWORD');
  if (EXPLICIT_DEBIT_PATTERN.test(body) && !body.toLowerCase().includes('reversed')) return reject('DEBIT_ALERT_REJECTED');

  const amountMatch = body.match(AMOUNT_PATTERN);
  if (!amountMatch) return reject('NO_AMOUNT_FOUND');
  const amount = Number(amountMatch[1].replace(/,/g, ''));
  if (!Number.isFinite(amount)) return reject('INVALID_AMOUNT_FORMAT');
  if (amount <= 0) return reject('ZERO_AMOUNT');

  const utrMatch = body.match(UTR_PATTERN);
  return {
    forwarded: true,
    reason: ANDROID_SMS_FILTER_ACCEPTED,
    amountPaise: Math.round(amount * 100),
    bankRef: utrMatch ? utrMatch[1] : null
  };
}
