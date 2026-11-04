import { BankSmsParser } from './bank-sms-parser.js';
import { evaluateAndroidSmsFilter } from './android-sms-filter.js';

// The patterns the verification pipeline falls back to when the parser found no reference
// (verification-pipeline.js, "Invariant 3: Check 12-digit reference").
const REF12_PATTERNS = [
  /(?:upi\s*ref(?:erence)?\s*(?:no\.?|num)?|utr(?:\s*no\.?)?|rrn(?:\s*no\.?)?|txn\s*(?:id|ref)?|ref\s*no\.?)[\s:=-]+([0-9]{12})\b/i,
  /(?:ref\s*no\.?)?[\s:#=-]+([0-9]{12})\b/i,
  /\b([0-9]{12})\b/
];

const PHONE_HINTS = {
  EMPTY_SENDER: 'Enter the sender ID exactly as the phone shows it (for example VM-HDFCBK).',
  EMPTY_BODY: 'Paste the full SMS text.',
  PERSONAL_PHONE_NUMBER_REJECTED: 'The sender is a phone number. The app only forwards SMS from bank sender IDs such as VM-HDFCBK or AD-SBIINB; alerts sent from a plain mobile number are discarded on the phone.',
  NON_INSTITUTIONAL_SENDER: 'The sender does not look like a TRAI bank header (two letters, a dash, then 3 to 9 letters or digits). Check the sender ID in the SMS app.',
  NO_CREDIT_KEYWORD: 'The text has no credit word (credited, received, deposited, Cr). The phone drops messages that do not announce an incoming credit.',
  DEBIT_ALERT_REJECTED: 'The text contains a debit word (debited, paid to, withdrawn, Dr), so the phone treats it as money leaving the account.',
  NO_AMOUNT_FOUND: 'No amount with a currency prefix was found. The phone needs Rs, Rs., INR or ₹ directly before the number (for example Rs.1.00).',
  INVALID_AMOUNT_FORMAT: 'The amount after the currency symbol could not be read as a number.',
  ZERO_AMOUNT: 'The amount is zero.'
};

const PARSER_HINTS = {
  EMPTY_TEXT: 'Paste the full SMS text.',
  NO_CREDIT_KEYWORD: 'The server parser needs an explicit credit phrase such as "credited", "received", "deposited" or "transferred to your account".',
  DEBIT_CONTEXT: 'A debit word appears before any credit word, so the server reads the message as a debit.',
  NO_AMOUNT: 'The server could not extract an amount (Rs 1.00, Rs.1.00, INR 1.00, ₹1.00 or 1.00 Rs).'
};

const SUMMARIES = {
  READY: 'This SMS format is recognised end to end. A real payment with this format is matched to the active session by amount.',
  PHONE_WOULD_DROP: 'The Android app would not forward this message, so the gateway would never see it.',
  PARSER_WOULD_REJECT: 'The phone forwards it, but the server parser would reject it.',
  REFERENCE_MISSING: 'The amount is readable, but without a transaction reference the verification pipeline rejects the observation (MISSING_12_DIGIT_REFERENCE).'
};

/**
 * Dry-runs a bank SMS through the three gates a live message passes: the phone's on-device filter,
 * the server parser and the mandatory transaction reference. Pure function: nothing is stored and
 * no payment session is touched, so an operator can paste real bank alerts freely.
 *
 * @param {{ sender?: string, text?: string, timestamp?: number | string }} input
 * @returns {{
 *   verdict: 'READY' | 'PHONE_WOULD_DROP' | 'PARSER_WOULD_REJECT' | 'REFERENCE_MISSING',
 *   summary: string,
 *   phone: { forwarded: boolean, reason: string, amountPaise: number | null, bankRef: string | null },
 *   parser: { parsed: boolean, failure: string | null, amount: string | null, amountPaise: number | null, bankReferenceNumber: string | null, senderVpa: string | null },
 *   reference: { value: string | null, present: boolean, isTwelveDigit: boolean, source: 'parser' | 'text' | null },
 *   hints: string[]
 * }}
 */
export function dryRunBankSms({ sender = '', text = '', timestamp } = {}) {
  const cleanText = String(text || '').trim();
  const phone = evaluateAndroidSmsFilter(String(sender || ''), cleanText);
  const inspection = BankSmsParser.inspect({ text: cleanText, sender, timestamp });
  const parsed = inspection.parsed;

  let referenceValue = parsed?.bankReferenceNumber || null;
  let referenceSource = referenceValue ? 'parser' : null;
  if (!referenceValue) {
    for (const pattern of REF12_PATTERNS) {
      const match = cleanText.match(pattern);
      if (match && match[1]) {
        referenceValue = match[1].trim();
        referenceSource = 'text';
        break;
      }
    }
  }
  const reference = {
    value: referenceValue,
    present: Boolean(referenceValue),
    isTwelveDigit: Boolean(referenceValue) && /^[0-9]{12}$/.test(referenceValue),
    source: referenceSource
  };

  const hints = [];
  let verdict;
  if (!phone.forwarded) {
    verdict = 'PHONE_WOULD_DROP';
    hints.push(PHONE_HINTS[phone.reason] || `The phone would discard this message (${phone.reason}).`);
  } else if (!parsed) {
    verdict = 'PARSER_WOULD_REJECT';
    hints.push(PARSER_HINTS[inspection.failure] || `The server parser rejected the message (${inspection.failure}).`);
  } else if (!reference.present) {
    verdict = 'REFERENCE_MISSING';
    hints.push('No transaction reference was found. Verification requires the 12-digit UPI reference (UPI Ref No / UTR / RRN) that banks print in credit alerts.');
  } else {
    verdict = 'READY';
    if (!reference.isTwelveDigit) {
      hints.push(`The reference "${reference.value}" is not a 12-digit UPI reference. It is accepted, but a 12-digit UTR gives the strongest match against your bank statement.`);
    }
    if (!parsed.senderVpa) {
      hints.push('No payer VPA found. That is fine: matching works by amount, the VPA is only shown for reference.');
    }
  }

  return {
    verdict,
    summary: SUMMARIES[verdict],
    phone,
    parser: {
      parsed: Boolean(parsed),
      failure: inspection.failure,
      amount: parsed ? String(parsed.amount) : null,
      amountPaise: parsed ? Number(parsed.amountPaise) : null,
      bankReferenceNumber: parsed?.bankReferenceNumber ?? null,
      senderVpa: parsed?.senderVpa ?? null
    },
    reference,
    hints
  };
}
