import { isValidTransition, isTerminalStatus, VALID_TRANSITIONS, IMMUTABLE_STATES } from '@neurosky/common';

/**
 * The transition graph and helpers live in `@neurosky/common` so the database layer can enforce
 * them too (`@neurosky/db` cannot import `@neurosky/core`). They are re-exported here to keep
 * `@neurosky/core` the canonical import site for engine consumers.
 */
export { VALID_TRANSITIONS, isValidTransition, isTerminalStatus, IMMUTABLE_STATES };

/**
 * Asserts a valid transition, throwing a detailed domain error if violated.
 * @param {string} currentState
 * @param {string} nextState
 */
export function assertValidTransition(currentState, nextState) {
  if (!isValidTransition(currentState, nextState)) {
    throw new Error(
      `Illegal payment state transition: Cannot move from '${currentState}' to '${nextState}'.`
    );
  }
}

/**
 * Converts internal payment status to the public contract outcome.
 * Throws if the status is not terminal.
 * @param {string} status
 * @returns {string}
 */
export function toPublicOutcome(status) {
  switch (status) {
    case 'OBSERVED_SUCCESS':
      return 'OBSERVED_SUCCESS';
    case 'RECONCILED':
      return 'RECONCILED';
    case 'MANUAL_REVIEW':
      return 'MANUAL_REVIEW';
    case 'SUCCESS':
      return 'SUCCESS';
    case 'FAILED':
      return 'FAILED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      throw new Error(`Status '${status}' is an internal non-terminal state and cannot be mapped to a public outcome.`);
  }
}

/** True when a webhook may be dispatched for this status. */
export function isDispatchableOutcome(status) {
  return isTerminalStatus(status);
}

/**
 * Settlement posture carried on webhook payloads and status responses.
 * - RECONCILED: matched to a bank-statement line (STATEMENT finality mode).
 * - NOT_RECONCILED: observer match awaiting a statement (STATEMENT mode's OBSERVED_SUCCESS).
 * - OBSERVER_VERIFIED: a UPI payment settled by a verified bank alert (OBSERVER finality mode, the default).
 * - NOT_BANK_SETTLEMENT: COD or counter SUCCESS, no bank money involved yet.
 * @param {string} status public outcome
 * @param {string} [method] payment method, used to tell UPI SUCCESS from COD / counter SUCCESS
 */
export function settlementStateFor(status, method) {
  switch (status) {
    case 'RECONCILED':
      return 'RECONCILED';
    case 'OBSERVED_SUCCESS':
      return 'NOT_RECONCILED';
    case 'MANUAL_REVIEW':
      return 'MANUAL_REVIEW';
    case 'SUCCESS':
      return String(method || '').toUpperCase() === 'UPI' ? 'OBSERVER_VERIFIED' : 'NOT_BANK_SETTLEMENT';
    default:
      return 'NOT_APPLICABLE';
  }
}