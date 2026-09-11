import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { ethers } from 'ethers';
import { createProductionWorker } from '../apps/worker/src/main.js';

const project = 'proofcast';
const prefix = project === 'proofcast' ? 'proofcast_' : '';
const address = '0x' + '11'.repeat(20);
const vault = '0x' + '22'.repeat(20);
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const abi = project === 'losslock'
  ? 'event VaultCreated(address indexed owner,address indexed vault,bytes32 indexed policyHash)'
  : 'event VaultCreated(bytes32 indexed enrollmentId,bytes32 indexed sessionId,address indexed follower,address vault)';
const iface = new ethers.Interface([abi]);
const encoded = iface.encodeEventLog(iface.getEvent('VaultCreated'),
  project === 'losslock' ? [address, vault, hash(1)] : [hash(1), hash(2), address, vault]);
const log = (n, emitter = address, index = 0) => ({
  address: emitter, blockNumber: n, blockHash: hash(n), transactionHash: hash(n + 100),
  index, transactionIndex: 0, topics: [hash(9)], data: '0x', removed: false,
});
const dbUrl = process.env.WORKER_TEST_DATABASE_URL;

test('real PostgreSQL worker: insertion, rollback/replay, scope, reorg, locking and health', { skip: !dbUrl, timeout: 30000 }, async (t) => {
  const schema = 'worker_test_' + crypto.randomBytes(8).toString('hex');
  const admin = new pg.Pool({ connectionString: dbUrl });
  await admin.query('CREATE SCHEMA "' + schema + '"');
  const pool = new pg.Pool({ connectionString: dbUrl, options: '-c search_path=' + schema, max: 5 });
  const workers = [];
  t.after(async () => {
    for (const worker of workers) await worker.close();
    await pool.end();
    // Only the randomly named schema created above is removed. Never public/user tables.
    await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
  });
  let latest = 14, failRpc = false, fork = false, malformed = false, failIndex = false, calls = [];
  let blockGate, enteredRead;
  const chain = {
    getBlock: async (n) => {
      if (blockGate) { enteredRead?.(); await blockGate; }
      if (failRpc) throw new Error('RPC_DOWN');
      n = n === 'latest' ? latest : Number(n);
      return { number: n, hash: fork && n === 14 ? hash(999) : hash(n) };
    },
    getLogs: async (filter) => {
      calls.push(filter);
      const factory = { ...log(11), ...encoded };
      const child = log(11, vault, 1);
      const extra = log(15);
      if (malformed) extra.transactionHash = null;
      return [factory, child, extra].filter((e) => filter.address.map(a => a.toLowerCase()).includes(e.address)
        && e.blockNumber >= filter.fromBlock && e.blockNumber <= filter.toBlock);
    },
  };
  let clock = new Date('2026-09-09T00:00:00Z');
  const env = {
    RPC_URL: 'http://unused', DATABASE_URL: dbUrl, DREAMDEX_INDEXER_URL: 'http://unused',
    INDEXER_START_BLOCK: '10', INDEXER_MAX_BLOCKS_PER_TICK: '3', INDEXER_CONFIRMATIONS: '0',
    INDEXER_RETRIES: '0', INDEXER_TIMEOUT_MS: '5000', WORKER_STALE_MS: '500',
  };
  const config = project === 'losslock'
    ? { deployments: { lossLockV2: { factory: { address, block: 10 } } } }
    : { proofcast: { factory: address }, deployments: { proofCastV2: { ProofCastFactory: { address, block: 10 } } } };
  const make = () => {
    const worker = createProductionWorker({ env, config, pool, chain, now: () => clock,
      fetchImpl: async () => ({ ok: true, json: async () => failIndex ? { errors: [{ message: 'bad' }] } : { data: { __typename: 'query_root' } } }) });
    workers.push(worker);
    return worker;
  };
  const worker = make();
  await t.test('nonempty event insertion, factory child same-block capture and bounded catchup', async () => {
    const state = await worker.tick();
    assert.equal(state.scannedHead, 12);
    assert.equal(state.chainHead, 14);
    assert.equal(state.lag, 2);
    assert.equal(state.ok, false);
    const events = (await pool.query('SELECT * FROM ' + prefix + 'chain_events ORDER BY log_index')).rows;
    assert.equal(events.length, 2);
    assert.equal(events[0].tx_hash, hash(111));
    assert.deepEqual(events[0].payload.topics, encoded.topics);
    assert.equal(events[1].payload.address, vault);
    assert.ok(calls.every(f => f.address.length > 0));
  });
  await t.test('empty range reaches scanned head and reports healthy only at zero lag', async () => {
    const state = await worker.tick();
    assert.equal(state.scannedHead, 14);
    assert.equal(state.ok, true);
    assert.equal((await pool.query('SELECT block_number,indexer_ok FROM ' + prefix + 'worker_state WHERE worker_id=$1', [worker.workerId])).rows[0].block_number, '14');
  });
  await t.test('PostgreSQL abort rolls back events, discovery and cursor; next tick replays', async () => {
    latest = 17;
    await pool.query('ALTER TABLE ' + prefix + "chain_events ADD CONSTRAINT test_reject CHECK(block_number <> 15)");
    await assert.rejects(worker.tick());
    assert.equal(worker.snapshot().ok, false);
    assert.equal((await pool.query('SELECT last_block FROM ' + prefix + 'indexer_cursors')).rows[0].last_block, '14');
    assert.equal((await pool.query('SELECT count(*) FROM ' + prefix + 'chain_events')).rows[0].count, '2');
    await pool.query('ALTER TABLE ' + prefix + 'chain_events DROP CONSTRAINT test_reject');
    assert.equal((await worker.tick()).scannedHead, 17);
    assert.equal((await pool.query('SELECT count(*) FROM ' + prefix + 'chain_events')).rows[0].count, '3');
  });
  await t.test('restart and replay deduplicate and preserve an existing later cursor', async () => {
    await pool.query('UPDATE ' + prefix + 'indexer_cursors SET last_block=30,last_block_hash=$1', [hash(30)]);
    latest = 30;
    const restarted = make();
    assert.equal((await restarted.tick()).scannedHead, 30);
    assert.equal((await pool.query('SELECT last_block FROM ' + prefix + 'indexer_cursors')).rows[0].last_block, '30');
  });
  await t.test('prior cursor hash is fetched without overlapping logs', async () => {
    await pool.query('UPDATE ' + prefix + 'indexer_cursors SET last_block=14,last_block_hash=$1', [hash(14)]);
    fork = true;
    await assert.rejects(worker.tick(), /REORG_CURSOR_MISMATCH/);
    fork = false;
  });
  await t.test('same-process ticks share one flight; competing worker cannot scan while locked', async () => {
    // Initialize DDL before testing the scan lock; DDL itself may wait on table locks.
    const competitor = make();
    await competitor.tick();
    let release;
    const entered = new Promise(resolve => { enteredRead = resolve; });
    blockGate = new Promise(resolve => { release = resolve; });
    const a = worker.tick(), b = worker.tick();
    a.catch(() => {});
    assert.equal(a, b);
    try {
      // getBlock is reached only after this worker acquired its own advisory lock.
      await entered;
      await assert.rejects(competitor.tick(), /INDEXER_LOCKED/);
    } finally { blockGate = null; enteredRead = null; release(); }
    await a;
  });
  await t.test('RPC failure invalidates prior success immediately, heartbeat is false, TTL also expires', async () => {
    failRpc = true;
    await assert.rejects(worker.tick(), /RPC_DOWN/);
    assert.equal(worker.snapshot().ok, false);
    assert.equal(worker.snapshot().lag, null);
    const row = (await pool.query('SELECT indexer_ok FROM ' + prefix + 'worker_state WHERE worker_id=$1', [worker.workerId])).rows[0];
    assert.equal(row.indexer_ok, false);
    failRpc = false;
    latest = worker.snapshot().scannedHead + 3;
    await worker.tick();
    clock = new Date(clock.getTime() + 501);
    assert.equal(worker.snapshot().ok, false);
    assert.equal(worker.snapshot().stale, true);
  });
  await t.test('GraphQL errors do not prevent durable chain catchup but fail readiness', async () => {
    failIndex = true;
    latest += 3;
    const state = await worker.tick();
    assert.equal(state.scannedHead, latest);
    assert.equal(state.ok, false);
    assert.equal(state.indexer, false);
  });
  await t.test('database connection failure cannot retain a previous healthy snapshot', async () => {
    failIndex = false;
    assert.equal((await worker.tick()).ok, true);
    const connect = pool.connect;
    pool.connect = async () => { throw new Error('DATABASE_UNAVAILABLE'); };
    try {
      await assert.rejects(worker.tick(), /DATABASE_UNAVAILABLE/);
      assert.equal(worker.snapshot().ok, false);
      assert.equal(worker.snapshot().db, false);
    } finally { pool.connect = connect; }
  });
});
