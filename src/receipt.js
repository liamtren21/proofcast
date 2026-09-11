const SIGNAL_SIDES = new Set(['YES', 'NO', 'ABSTAIN']);

export const RECEIPT_STATES = Object.freeze([
  'PUBLISHED',
  'ABSTAIN',
  'NO_SIGNAL',
  'DATA_UNAVAILABLE',
  'REJECTED',
  'ZERO_FILL',
  'PARTIAL_FILL',
  'SETTLED',
  'VOIDED',
]);

const TRANSITIONS = new Map([
  ['DATA_UNAVAILABLE', new Set(['NO_SIGNAL', 'PUBLISHED', 'ABSTAIN', 'REJECTED'])],
  ['PUBLISHED', new Set(['ZERO_FILL', 'PARTIAL_FILL', 'VOIDED'])],
  ['ABSTAIN', new Set(['ZERO_FILL', 'VOIDED'])],
  ['REJECTED', new Set(['VOIDED'])],
  ['ZERO_FILL', new Set(['VOIDED'])],
  ['PARTIAL_FILL', new Set(['SETTLED', 'VOIDED'])],
  ['NO_SIGNAL', new Set(['VOIDED'])],
  ['SETTLED', new Set()],
  ['VOIDED', new Set()],
]);

function fail(code) {
  throw new Error(code);
}

function copyReceipt(receipt, changes = {}) {
  return Object.freeze({ ...receipt, ...changes });
}

export function createReceipt({ receiptId, marketId, marketGeneration }) {
  if (!receiptId || !marketId || !Number.isInteger(marketGeneration) || marketGeneration < 0) {
    fail('INVALID_RECEIPT');
  }
  return Object.freeze({
    receiptId,
    marketId,
    marketGeneration,
    state: 'DATA_UNAVAILABLE',
  });
}

function validateSignal(receipt, signal) {
  if (!signal || !signal.signalId || !signal.evidenceHash) return 'INVALID_SIGNAL';
  if (signal.marketId !== receipt.marketId) return 'MARKET_MISMATCH';
  if (signal.marketGeneration !== receipt.marketGeneration) return 'MARKET_GENERATION_MISMATCH';
  if (!SIGNAL_SIDES.has(signal.sideOrAbstain)) return 'INVALID_SIGNAL_SIDE';
  return null;
}

export function recordSignal(receipt, signal) {
  if (signal?.marketGeneration !== receipt.marketGeneration) fail('MARKET_GENERATION_MISMATCH');
  if (signal?.marketId !== receipt.marketId) fail('MARKET_MISMATCH');
  if (receipt.signal?.signalId === signal?.signalId) fail('SIGNAL_ALREADY_RECORDED');
  if (receipt.signal?.signalId) fail('SIGNAL_ALREADY_RECORDED');
  if (receipt.state !== 'DATA_UNAVAILABLE') fail('INVALID_RECEIPT_TRANSITION');
  const error = validateSignal(receipt, signal);
  if (error === 'MARKET_GENERATION_MISMATCH') fail(error);
  if (error === 'MARKET_MISMATCH') fail(error);
  if (error) return copyReceipt(receipt, { state: 'REJECTED', rejectionCode: error });
  return copyReceipt(receipt, {
    state: signal.sideOrAbstain === 'ABSTAIN' ? 'ABSTAIN' : 'PUBLISHED',
    signal: Object.freeze({ ...signal }),
  });
}

export function transitionReceipt(receipt, nextState, changes = {}) {
  if (nextState === receipt.state) return receipt;
  if (!RECEIPT_STATES.includes(nextState)
      || !TRANSITIONS.get(receipt.state)?.has(nextState)) {
    fail('INVALID_RECEIPT_TRANSITION');
  }
  if (nextState === 'PARTIAL_FILL' && (!Number.isFinite(changes.filledAmount) || changes.filledAmount <= 0)) {
    fail('INVALID_PARTIAL_FILL');
  }
  return copyReceipt(receipt, { ...changes, state: nextState });
}
