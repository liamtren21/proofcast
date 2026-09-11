import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChainLogs } from '../apps/worker/src/indexer.js';

test('scan head wins over last event and bigint cursor strings are normalized', async () => {
  let saved;
  const store = {
    getCursor: async () => ({ block: '10', hash: 'old' }),
    saveChainEvent: async () => {},
    setCursor: async (value) => { saved = value; },
  };
  await applyChainLogs(store, [{ blockNumber: 11, blockHash: 'event', txHash: 'tx', logIndex: 0 }], { block: 20, hash: 'head' });
  assert.deepEqual(saved, { block: 20, hash: 'head' });
});
test('string cursor reorg is rejected before persisting any event', async () => {
  let writes = 0;
  const store = {
    getCursor: async () => ({ block: '10', hash: 'old' }),
    saveChainEvent: async () => { writes++; },
    setCursor: async () => {},
  };
  await assert.rejects(applyChainLogs(store, [{ blockNumber: 10, blockHash: 'fork' }], { block: 11, hash: 'head' }), /REORG_CURSOR_MISMATCH/);
  assert.equal(writes, 0);
});
