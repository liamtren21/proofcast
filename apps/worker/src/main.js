import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ethers } from 'ethers';
import { getLogsChunked, applyChainLogs } from './indexer.js';

const CHAIN_ID = 50312;
const PREFIX = 'proofcast_';
const vaultInterface = new ethers.Interface(['event VaultCreated(bytes32 indexed enrollmentId,bytes32 indexed sessionId,address indexed follower,address vault)']);
function positive(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new Error('INVALID_WORKER_CONFIGURATION');
  return n;
}
export function createProductionWorker({ env = process.env, now = () => new Date(), config, pool: providedPool, chain: providedChain, fetchImpl = fetch } = {}) {
  const rpcUrl = env.SOMNIA_RPC_URL ?? env.RPC_URL;
  if (!rpcUrl || !env.DATABASE_URL || !env.DREAMDEX_INDEXER_URL) throw new Error('WORKER_CONFIGURATION_REQUIRED');
  config ??= JSON.parse(fs.readFileSync(new URL('../../../config/shannon.json', import.meta.url), 'utf8'));
  const deployment = config.deployments?.proofCastDynamicV3 ?? config.deployments?.proofCastV2 ?? {};
  const factoryAddress = env.PROOFCAST_FACTORY_ADDRESS ?? deployment.factory ?? deployment.ProofCastFactory?.address ?? config.proofcast?.factory;
  const refs = [factoryAddress,...Object.values(deployment).map(v=>typeof v==='string'?v:v?.address),...Object.values(config.proofcast??{})].filter(a => typeof a === 'string' && ethers.isAddress(a));
  const initialAddresses = [...new Set(refs.map(a => a.toLowerCase()))];
  if (!initialAddresses.length) throw new Error('INDEXER_ADDRESS_SCOPE_REQUIRED');
  const deploymentBlocks = Object.values(deployment).map(v => Number(v?.block)).filter(Number.isSafeInteger);
  const startBlock = Number(env.INDEXER_START_BLOCK ?? Math.min(...deploymentBlocks));
  if (!Number.isSafeInteger(startBlock) || startBlock < 0) throw new Error('INDEXER_START_BLOCK_REQUIRED');
  const batchSize = positive(env.INDEXER_MAX_BLOCKS_PER_TICK, 7200, 7200);
  const timeout = positive(env.INDEXER_TIMEOUT_MS, 15000);
  const staleMs = positive(env.WORKER_STALE_MS, 30000);
  const confirmations = Number(env.INDEXER_CONFIRMATIONS ?? 2);
  if (!Number.isSafeInteger(confirmations) || confirmations < 0) throw new Error('INVALID_CONFIRMATIONS');
  const workerId = env.WORKER_ID ?? 'proofcast-' + crypto.randomUUID();
  const chain = providedChain ?? new ethers.JsonRpcProvider(rpcUrl, CHAIN_ID);
  const pool = providedPool ?? new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
  let initialized = false, flight = null, closed = false;
  let state = { ok:false, db:false, chain:false, indexer:false, scannedHead:null, chainHead:null, lag:null, workerId, executionEnabled:false };
  async function bounded(work) {
    let timer;
    try { return await Promise.race([work(),new Promise((_,reject) => { timer=setTimeout(() => reject(new Error('READ_TIMEOUT')),timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async function initialize() {
    if (initialized) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${PREFIX}chain_events(chain_id BIGINT NOT NULL,tx_hash TEXT NOT NULL,log_index BIGINT NOT NULL,block_number BIGINT NOT NULL,block_hash TEXT NOT NULL,payload JSONB NOT NULL,PRIMARY KEY(chain_id,tx_hash,log_index));
      CREATE TABLE IF NOT EXISTS ${PREFIX}indexer_cursors(chain_id BIGINT PRIMARY KEY,last_block BIGINT NOT NULL,last_block_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ${PREFIX}indexer_addresses(chain_id BIGINT NOT NULL,address TEXT NOT NULL,PRIMARY KEY(chain_id,address));
      CREATE TABLE IF NOT EXISTS ${PREFIX}worker_heartbeats(worker_id TEXT PRIMARY KEY,observed_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE IF NOT EXISTS ${PREFIX}worker_state(worker_id TEXT PRIMARY KEY,chain_id BIGINT NOT NULL,block_number BIGINT NOT NULL,block_hash TEXT NOT NULL,indexer_ok BOOLEAN NOT NULL,observed_at TIMESTAMPTZ NOT NULL DEFAULT now());
    `);
    initialized=true;
  }
  async function scan() {
    await initialize();
    const client=await pool.connect();
    let transaction=false;
    try {
      await client.query('BEGIN'); transaction=true;
      const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtext(current_database() || ':' || current_schema() || ':proofcast:indexer')) AS locked");
      if (!lock.rows[0].locked) throw new Error('INDEXER_LOCKED');
      if (chain.getNetwork && (await bounded(() => chain.getNetwork())).chainId !== BigInt(CHAIN_ID)) throw new Error('WRONG_CHAIN');
      const head=await bounded(() => chain.getBlock('latest'));
      if (!head) throw new Error('CHAIN_BLOCK_UNAVAILABLE');
      if (head.timestamp && Math.abs(now().getTime()/1000-head.timestamp)>120) throw new Error('CHAIN_HEAD_STALE');
      const target=Math.max(0,head.number-confirmations);
      const previous=(await client.query(`SELECT last_block AS block,last_block_hash AS hash FROM ${PREFIX}indexer_cursors WHERE chain_id=$1`,[CHAIN_ID])).rows[0];
      if (previous) {
        const canonical=await bounded(() => chain.getBlock(Number(previous.block)));
        if (!canonical || canonical.hash!==previous.hash) throw new Error('REORG_CURSOR_MISMATCH');
        if (Number(previous.block)>head.number) throw new Error('CHAIN_HEAD_BEHIND_CURSOR');
      }
      let indexerHealthy=false;
      try {
        const response=await bounded(() => fetchImpl(env.DREAMDEX_INDEXER_URL,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(timeout),body:JSON.stringify({query:'{__typename}'})}));
        const body=await bounded(() => response.json());
        indexerHealthy=response.ok && !body.errors?.length && body.data?.__typename==='query_root';
      } catch { /* Continue chain reads while discovery is unavailable. */ }
      const savedAddresses=(await client.query(`SELECT address FROM ${PREFIX}indexer_addresses WHERE chain_id=$1`,[CHAIN_ID])).rows.map(r=>r.address);
      const addresses=[...new Set([...initialAddresses,...savedAddresses])];
      const from=previous?Number(previous.block)+1:startBlock;
      let scannedHead=previous?Number(previous.block):startBlock-1,scannedHash=previous?.hash??head.hash;
      if (from<=target) {
        const scanTo=Math.min(target,from+batchSize-1);
        const scanBlock=scanTo===head.number?head:await bounded(()=>chain.getBlock(scanTo));
        if (!scanBlock) throw new Error('SCAN_BLOCK_UNAVAILABLE');
        const reader={getLogs:filter=>bounded(()=>chain.getLogs(filter))};
        const logs=await getLogsChunked(reader,{address:addresses},from,scanTo,900,4);
        const discovered=new Set();
        for (const log of logs) {
          if(log.address.toLowerCase()!==factoryAddress?.toLowerCase()) continue;
          try { const decoded=vaultInterface.parseLog(log); if(decoded?.name==='VaultCreated') discovered.add(decoded.args.vault.toLowerCase()); } catch {}
        }
        const newAddresses=[...discovered].filter(a=>!addresses.includes(a));
        if(newAddresses.length) logs.push(...await getLogsChunked(reader,{address:newAddresses},from,scanTo,900,4));
        const scope=new Set([...addresses,...newAddresses]);
        logs.sort((a,b)=>a.blockNumber-b.blockNumber||a.index-b.index);
        const normalized=logs.map(log=>{
          if(!scope.has(log.address.toLowerCase())||log.removed||!/^0x[0-9a-f]{64}$/i.test(log.transactionHash??'')||!Number.isSafeInteger(log.index)||log.blockNumber<from||log.blockNumber>scanTo) throw new Error('INVALID_CHAIN_EVENT');
          return {chainId:CHAIN_ID,txHash:log.transactionHash,logIndex:log.index,blockNumber:log.blockNumber,blockHash:log.blockHash,payload:{address:log.address.toLowerCase(),topics:log.topics,data:log.data}};
        });
        const checked=await bounded(()=>chain.getBlock(scanTo));
        if(!checked||checked.hash!==scanBlock.hash) throw new Error('REORG_DURING_SCAN');
        for(const address of newAddresses) await client.query(`INSERT INTO ${PREFIX}indexer_addresses VALUES($1,$2) ON CONFLICT DO NOTHING`,[CHAIN_ID,address]);
        await applyChainLogs({
          getCursor:async()=>previous??null,
          saveChainEvent:async log=>{
            const result=await client.query(`INSERT INTO ${PREFIX}chain_events VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,[log.chainId,log.txHash,log.logIndex,log.blockNumber,log.blockHash,JSON.stringify(log.payload)]);
            return result.rowCount>0;
          },
          setCursor:next=>client.query(`INSERT INTO ${PREFIX}indexer_cursors VALUES($1,$2,$3) ON CONFLICT(chain_id) DO UPDATE SET last_block=EXCLUDED.last_block,last_block_hash=EXCLUDED.last_block_hash WHERE ${PREFIX}indexer_cursors.last_block<=EXCLUDED.last_block`,[CHAIN_ID,next.block,next.hash])
        },normalized,{block:scanTo,hash:scanBlock.hash});
        scannedHead=scanTo; scannedHash=scanBlock.hash;
      }
      const lag=Math.max(0,target-scannedHead),healthy=lag===0&&indexerHealthy;
      await client.query(`INSERT INTO ${PREFIX}worker_heartbeats VALUES($1,now()) ON CONFLICT(worker_id) DO UPDATE SET observed_at=now()`,[workerId]);
      await client.query(`INSERT INTO ${PREFIX}worker_state(worker_id,chain_id,block_number,block_hash,indexer_ok) VALUES($1,$2,$3,$4,$5) ON CONFLICT(worker_id) DO UPDATE SET block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,indexer_ok=EXCLUDED.indexer_ok,observed_at=now()`,[workerId,CHAIN_ID,scannedHead,scannedHash,healthy]);
      await client.query('COMMIT'); transaction=false;
      state={ok:healthy,db:true,chain:true,indexer:indexerHealthy,catchingUp:lag>0,scannedHead,chainHead:head.number,lag,block:String(scannedHead),observedAt:now().toISOString(),workerId,executionEnabled:false};
      return state;
    } catch(error) {
      if(transaction) await client.query('ROLLBACK');
      state={...state,ok:false,chain:false,indexer:false,lag:null,error:error.message,observedAt:now().toISOString()};
      await client.query(`UPDATE ${PREFIX}worker_state SET indexer_ok=false,observed_at=now() WHERE worker_id=$1`,[workerId]).catch(()=>{});
      throw error;
    } finally { client.release(); }
  }
  function tick() {
    if(closed) return Promise.reject(new Error('WORKER_CLOSED'));
    if(!flight) flight=scan().catch(error => {
      state={...state,ok:false,db:false,chain:false,indexer:false,lag:null,error:error.message,observedAt:now().toISOString()};
      throw error;
    }).finally(()=>{flight=null;});
    return flight;
  }
  function snapshot() {
    const stale=!state.observedAt||now().getTime()-Date.parse(state.observedAt)>staleMs;
    return {...state,stale,ok:state.ok&&!stale};
  }
  async function close(){closed=true;await flight?.catch(()=>{});if(!providedChain)chain.destroy();if(!providedPool)await pool.end();}
  return {workerId,tick,snapshot,close};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const worker=createProductionWorker();
  const server=http.createServer((_request,response)=>{
    const state=worker.snapshot();response.writeHead(state.ok?200:503,{'content-type':'application/json'});response.end(JSON.stringify(state));
  }).listen(Number(process.env.WORKER_HEALTH_PORT??9120),'0.0.0.0');
  let stopping=false,timer;
  const loop=async()=>{try{await worker.tick();}catch(error){console.error('[proofcast-worker]',error.message);}if(!stopping)timer=setTimeout(loop,Number(process.env.WORKER_INTERVAL_MS??5000));};
  const stop=async()=>{stopping=true;clearTimeout(timer);server.close();await worker.close();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);void loop();
}
