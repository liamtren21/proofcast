import test from 'node:test';
import assert from 'node:assert/strict';
import { JobJournal, classifyBroadcastRecovery } from '../apps/worker/src/tx-journal.js';
import { applyChainLogs, getLogsChunked } from '../apps/worker/src/indexer.js';

test('journal leases an execution intent once and recovers unknown broadcast without retrying', () => {
  const journal = new JobJournal({ now: () => 100 });
  assert.equal(journal.enqueue({ intentId: 'i-1', enrollmentId: 'e-1', marketId: 'm-1' }), true);
  assert.equal(journal.enqueue({ intentId: 'i-1', enrollmentId: 'e-1', marketId: 'm-1' }), false);
  const first = journal.claim('worker-a', 30);
  assert.equal(first.intentId, 'i-1');
  journal.markBroadcast(first.intentId, { txHash: '0xtx', nonce: '4' });
  assert.equal(classifyBroadcastRecovery(journal.get(first.intentId)), 'RECONCILE_EXISTING_TX');
  assert.equal(journal.claim('worker-b', 30), null);
});

test('expired lease is reclaimable only before broadcast', () => {
  let now = 100;
  const journal = new JobJournal({ now: () => now });
  journal.enqueue({ intentId: 'i-2', enrollmentId: 'e-1', marketId: 'm-1' });
  journal.claim('worker-a', 10);
  now = 111;
  assert.equal(journal.claim('worker-b', 10).intentId, 'i-2');
});

test('indexer deduplicates logs and refuses a reorg without a matching cursor hash', async () => {
  const events = [];
  const store = { async saveChainEvent(event) { events.push(event); }, async getCursor() { return { block: 10, hash: '0xold' }; }, async setCursor(cursor) { this.cursor = cursor; } };
  const logs = [{ chainId: 50312, txHash: '0xtx', logIndex: 0, blockNumber: 11, blockHash: '0xnew', payload: { kind: 'SignalAnchored' } }];
  const result = await applyChainLogs(store, logs);
  assert.equal(result.accepted, 1);
  assert.equal(events.length, 1);
  await assert.rejects(() => applyChainLogs({ ...store, async getCursor() { return { block: 11, hash: '0xdifferent' }; } }, logs), /REORG_CURSOR_MISMATCH/);
});

test('indexer chunks RPC log ranges to the provider limit', async () => {
  const ranges = [];
  const chain = { async getLogs(filter) { ranges.push([filter.fromBlock, filter.toBlock]); return []; } };
  await getLogsChunked(chain, {}, 100, 2_250, 900);
  assert.deepEqual(ranges, [[100, 999], [1000, 1899], [1900, 2250]]);
});
