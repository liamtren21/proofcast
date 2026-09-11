function blockNumber(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_BLOCK_NUMBER');
  return n;
}
export async function getLogsChunked(chain, filter, fromBlock, toBlock, chunkSize = 900, concurrency = 8) {
  fromBlock = blockNumber(fromBlock); toBlock = blockNumber(toBlock);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('INVALID_SCAN_LIMIT');
  const results = [];
  for (let start = fromBlock; start <= toBlock;) {
    const batch = [];
    for (let i = 0; i < concurrency && start <= toBlock; i++, start += chunkSize)
      batch.push(chain.getLogs({ ...filter, fromBlock: start, toBlock: Math.min(toBlock, start + chunkSize - 1) }));
    results.push(...await Promise.all(batch));
  }
  return results.flat();
}

export async function applyChainLogs(store, logs, head = null) {
  const previous = await store.getCursor();
  const cursor = previous ? { block: blockNumber(previous.block), hash: previous.hash } : null;
  const ordered = logs.map(log => ({ ...log, blockNumber: blockNumber(log.blockNumber) }))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  if (cursor && ordered.some(log => log.blockNumber === cursor.block && log.blockHash !== cursor.hash)) throw new Error('REORG_CURSOR_MISMATCH');
  const last = ordered.at(-1);
  const next = head ? { block: blockNumber(head.block), hash: head.hash } : last ? { block: last.blockNumber, hash: last.blockHash } : cursor;
  if (next && cursor && next.block < cursor.block) throw new Error('CURSOR_REGRESSION');
  if (next && cursor && next.block === cursor.block && next.hash !== cursor.hash) throw new Error('REORG_CURSOR_MISMATCH');
  if (next && ordered.some(log => log.blockNumber > next.block || (log.blockNumber === next.block && log.blockHash !== next.hash))) throw new Error('SCAN_HEAD_MISMATCH');
  let accepted = 0;
  const seen = new Set();
  for (const log of ordered) {
    const key = JSON.stringify([log.chainId, log.txHash, log.logIndex]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (await store.saveChainEvent(log) !== false) accepted++;
  }
  if (next && (!cursor || next.block > cursor.block)) await store.setCursor(next);
  return { accepted, cursor: next };
}
