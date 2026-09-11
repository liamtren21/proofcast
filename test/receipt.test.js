import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECEIPT_STATES,
  createReceipt,
  recordSignal,
  transitionReceipt,
} from '../src/receipt.js';

const market = { marketId: 'btc-1', marketGeneration: 3 };

function signal(overrides = {}) {
  return {
    signalId: 'sig-1',
    marketId: market.marketId,
    marketGeneration: market.marketGeneration,
    sideOrAbstain: 'YES',
    evidenceHash: 'evidence-1',
    ...overrides,
  };
}

test('receipt starts fail-closed as data unavailable and exposes every required state', () => {
  const receipt = createReceipt({ receiptId: 'r1', ...market });

  assert.equal(receipt.state, 'DATA_UNAVAILABLE');
  assert.deepEqual([...RECEIPT_STATES], [
    'PUBLISHED', 'ABSTAIN', 'NO_SIGNAL', 'DATA_UNAVAILABLE', 'REJECTED',
    'ZERO_FILL', 'PARTIAL_FILL', 'SETTLED', 'VOIDED',
  ]);
});

test('records a current-generation signal as published and preserves an abstain as abstain', () => {
  const published = recordSignal(createReceipt({ receiptId: 'r1', ...market }), signal());
  assert.equal(published.state, 'PUBLISHED');
  assert.equal(published.signal.signalId, 'sig-1');

  const abstained = recordSignal(createReceipt({ receiptId: 'r2', ...market }), signal({
    signalId: 'sig-2', sideOrAbstain: 'ABSTAIN',
  }));
  assert.equal(abstained.state, 'ABSTAIN');
});

test('rejects duplicate signals and signals from another market generation', () => {
  const receipt = recordSignal(createReceipt({ receiptId: 'r1', ...market }), signal());

  assert.throws(() => recordSignal(receipt, signal()), /SIGNAL_ALREADY_RECORDED/);
  assert.throws(() => recordSignal(receipt, signal({
    signalId: 'sig-2', marketGeneration: 2,
  })), /MARKET_GENERATION_MISMATCH/);
});

test('rejects malformed signals into a rejected receipt without accepting them', () => {
  const receipt = createReceipt({ receiptId: 'r1', ...market });
  const rejected = recordSignal(receipt, signal({ sideOrAbstain: 'MAYBE' }));

  assert.equal(rejected.state, 'REJECTED');
  assert.equal(rejected.signal, undefined);
  assert.equal(rejected.rejectionCode, 'INVALID_SIGNAL_SIDE');
});

test('allows only valid receipt lifecycle transitions and keeps terminal states immutable', () => {
  const base = createReceipt({ receiptId: 'r1', ...market });
  const settled = transitionReceipt(
    transitionReceipt(
      transitionReceipt(recordSignal(base, signal()), 'PARTIAL_FILL', { filledAmount: 2 }),
      'SETTLED',
    ),
    'SETTLED',
  );

  assert.equal(settled.state, 'SETTLED');
  assert.equal(settled.filledAmount, 2);
  assert.throws(() => transitionReceipt(settled, 'VOIDED'), /INVALID_RECEIPT_TRANSITION/);
  assert.throws(() => transitionReceipt(base, 'SETTLED'), /INVALID_RECEIPT_TRANSITION/);
});

test('supports no-signal, zero-fill, and voided outcomes without conflating them', () => {
  const noSignal = transitionReceipt(
    createReceipt({ receiptId: 'r1', ...market }),
    'NO_SIGNAL',
  );
  const zeroFill = transitionReceipt(
    recordSignal(createReceipt({ receiptId: 'r2', ...market }), signal()),
    'ZERO_FILL',
  );
  const voided = transitionReceipt(
    recordSignal(createReceipt({ receiptId: 'r3', ...market }), signal()),
    'VOIDED',
  );

  assert.equal(noSignal.state, 'NO_SIGNAL');
  assert.equal(zeroFill.state, 'ZERO_FILL');
  assert.equal(voided.state, 'VOIDED');
});
