/**
 * UPI finality policy: what a verified bank alert means for a payment.
 *
 * OBSERVER (default): a bank SMS / Gmail alert that matches the session settles it. The session
 *   becomes SUCCESS, the merchant receives event SUCCESS with method UPI and
 *   settlementState OBSERVER_VERIFIED, and the customer sees "Payment Successful".
 * STATEMENT: the stricter two-step flow. A matching alert moves the session to OBSERVED_SUCCESS
 *   (settlementState NOT_RECONCILED) and only a bank-statement import turns it into RECONCILED.
 *
 * Selected with NEUROSKY_UPI_FINALITY. Read lazily so tests and operators can switch per process.
 */

export const UPI_FINALITY_MODES = Object.freeze({ OBSERVER: 'OBSERVER', STATEMENT: 'STATEMENT' });

/** @param {NodeJS.ProcessEnv} [env] */
export function upiFinalityMode(env = process.env) {
  const raw = String(env.NEUROSKY_UPI_FINALITY || '').trim().toUpperCase();
  return raw === UPI_FINALITY_MODES.STATEMENT ? UPI_FINALITY_MODES.STATEMENT : UPI_FINALITY_MODES.OBSERVER;
}

/** True when a matched bank alert is final (OBSERVER mode). */
export function upiSuccessIsFinal(env = process.env) {
  return upiFinalityMode(env) === UPI_FINALITY_MODES.OBSERVER;
}

/** Terminal status written when an observer verifies a UPI payment: SUCCESS or OBSERVED_SUCCESS. */
export function observerOutcomeStatus(env = process.env) {
  return upiSuccessIsFinal(env) ? 'SUCCESS' : 'OBSERVED_SUCCESS';
}

/** Internal event emitted for that outcome: PAYMENT.SUCCESS or PAYMENT.OBSERVED_SUCCESS. */
export function observerOutcomeEvent(env = process.env) {
  return `PAYMENT.${observerOutcomeStatus(env)}`;
}
