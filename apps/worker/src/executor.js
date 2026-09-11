import fs from 'node:fs';
import pg from 'pg';
import { ethers } from 'ethers';
import { createExecutorGateway, executorInterface, typedRequest } from './executor-contracts.js';

const CHAIN=50312;
const ACTIVE="('SIGNED','BROADCAST','UNKNOWN')";
function integer(value, fallback, max=Number.MAX_SAFE_INTEGER) {
  const n=Number(value??fallback);
  if(!Number.isSafeInteger(n)||n<1||n>max) throw new Error('INVALID_EXECUTOR_CONFIGURATION');
  return n;
}
function amount(value) {
  if(!/^[1-9][0-9]{0,76}$/.test(String(value??''))) throw new Error('INVALID_EXECUTOR_CONFIGURATION');
  return BigInt(value);
}
export function normalizeExecutorConfig(source) {
  const c={...source};
  // Lifecycle evidence is accepted explicitly; never fall back to shared shannon.json.
  for(const [key,name] of Object.entries({executor:'ProofCastExecutor',registry:'ProofCastRegistry',factory:'ProofCastFactory',adapter:'ProofCastDreamDexAdapter'})) {
    c[key]??=source[name]?.address;
    if(!ethers.isAddress(c[key])||c[key]===ethers.ZeroAddress) throw new Error('INVALID_EXECUTOR_DEPLOYMENT');
    c[key]=ethers.getAddress(c[key]);
  }
  c.chainId??=source.ProofCastExecutor?CHAIN:undefined;
  if(c.chainId!==CHAIN) throw new Error('WRONG_CHAIN');
  c.knownEnrollments??=source.enrollmentId?[source.enrollmentId]:[];
  if(!Array.isArray(c.knownEnrollments)||c.knownEnrollments.some(id=>!ethers.isHexString(id,32)||id===ethers.ZeroHash)) throw new Error('INVALID_EXECUTOR_ENROLLMENTS');
  c.knownEnrollments=[...new Set(c.knownEnrollments.map(id=>id.toLowerCase()))];
  return c;
}
function deploymentKey(config) {
  return ethers.id(JSON.stringify([CHAIN,...['executor','registry','factory','adapter'].map(k=>config[k].toLowerCase())]));
}
export function jobKey(config, job) {
  typedRequest(config,job);
  return ethers.id(JSON.stringify([deploymentKey(config),job.enrollmentId.toLowerCase(),job.marketId.toLowerCase(),job.action]));
}

export function createExecutorWorker({env=process.env, config, pool:providedPool, signer:providedSigner, gateway:providedGateway, now=Date.now}={}) {
  if(env.EXECUTOR_ENABLED!=='1') return {tick:async()=>({enabled:false}),initialize:async()=>{},snapshot:()=>({enabled:false}),close:async()=>{}};
  if((!providedSigner&&!env.EXECUTOR_PRIVATE_KEY)||(!providedPool&&!env.DATABASE_URL)||(!config&&!env.EXECUTOR_CONFIG)||(!providedGateway&&!env.SOMNIA_RPC_URL&&!env.RPC_URL)||!env.EXECUTOR_RUN_ID||!env.EXECUTOR_RUN_BUDGET_WEI) throw new Error('EXECUTOR_CONFIGURATION_REQUIRED');
  config=normalizeExecutorConfig(config??JSON.parse(fs.readFileSync(env.EXECUTOR_CONFIG,'utf8')));
  if(!/^[a-zA-Z0-9_.:-]{1,100}$/.test(env.EXECUTOR_RUN_ID)) throw new Error('INVALID_EXECUTOR_RUN_ID');
  const limits={budget:amount(env.EXECUTOR_RUN_BUDGET_WEI),gas:BigInt(integer(env.EXECUTOR_MAX_GAS,1000000,5000000)),fee:amount(env.EXECUTOR_MAX_FEE_PER_GAS_WEI??'100000000000'),confirmations:integer(env.EXECUTOR_CONFIRMATIONS,2,100),age:integer(env.EXECUTOR_MAX_HEAD_AGE_SECONDS,60,120),jobs:integer(env.EXECUTOR_MAX_JOBS_PER_TICK,10,100),enrollments:integer(env.EXECUTOR_MAX_ENROLLMENTS,1000,10000)};
  const signer=providedSigner??new ethers.Wallet(env.EXECUTOR_PRIVATE_KEY);
  const signerAddress=signer.address.toLowerCase();
  const request=new ethers.FetchRequest(env.SOMNIA_RPC_URL??env.RPC_URL??'http://unused');
  request.timeout=integer(env.EXECUTOR_RPC_TIMEOUT_MS,15000,60000);
  const provider=providedGateway?.provider??new ethers.JsonRpcProvider(request,CHAIN,{cacheTimeout:-1});
  const gateway=providedGateway??createExecutorGateway(provider,config);
  const pool=providedPool??new pg.Pool({connectionString:env.DATABASE_URL,max:4,connectionTimeoutMillis:15000,query_timeout:30000});
  const deployment=deploymentKey(config),run=env.EXECUTOR_RUN_ID;
  let initializing,flight,closed=false,state={enabled:true,ok:false};
  function initialize() {
    if(!initializing) initializing=(async()=>{
      const c=await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT pg_advisory_xact_lock(hashtext(current_database()||':'||current_schema()||':proofcast:executor:migrate'))");
        await c.query(fs.readFileSync(new URL('./executor-schema.sql',import.meta.url),'utf8'));
        await c.query('COMMIT');
      } catch(e) {await c.query('ROLLBACK').catch(()=>{});throw e;} finally {c.release();}
    })().catch(e=>{initializing=null;throw e;});
    return initializing;
  }
  async function freshHead() {
    if(BigInt((await provider.getNetwork()).chainId)!==50312n) throw new Error('WRONG_CHAIN');
    const h=await provider.getBlock('latest');
    if(!h||!Number.isSafeInteger(h.number)||h.number<limits.confirmations||!Number.isFinite(h.timestamp)||Math.abs(now()/1000-h.timestamp)>limits.age||!ethers.isHexString(h.hash,32)) throw new Error('CHAIN_HEAD_STALE');
    return h;
  }
  async function eligible(job,blockTag,timestamp) {
    const e=await gateway.enrollment(job.enrollmentId,blockTag);
    if(!e||!(await gateway.registered(e.sessionId,blockTag))) return false;
    if(!(await gateway.markets(e.sessionId,blockTag)).some(m=>m.toLowerCase()===job.marketId.toLowerCase())) return false;
    if(job.action==='recover') {
      const r=await gateway.recovery(e.vault,job.marketId,blockTag);
      return !r.resolved&&BigInt(r.positionAmount)>0n;
    }
    if(!e.active||await gateway.withdrawn(e.sessionId,blockTag)||await gateway.consumed(job.enrollmentId,job.marketId,blockTag)) return false;
    const s=await gateway.signal(e.sessionId,job.marketId,blockTag);
    return s.signalId!==ethers.ZeroHash&&[1n,2n].includes(BigInt(s.side))&&BigInt(s.validUntil)>=BigInt(timestamp);
  }
  async function discover(c,head) {
    const tag=head.number-limits.confirmations;
    const canonical=await provider.getBlock(tag);
    if(!canonical) throw new Error('DISCOVERY_BLOCK_UNAVAILABLE');
    const ids=new Set(config.knownEnrollments);
    // Events are hints only. Registry, factory, enrollment and signal state are
    // read from the configured deployment at a confirmed block and again at latest.
    const exists=(await c.query("SELECT to_regclass('proofcast_chain_events') AS relation")).rows[0].relation;
    if(exists) {
      const rows=(await c.query(`SELECT DISTINCT lower(payload->'topics'->>1) AS id FROM proofcast_chain_events
        WHERE chain_id=$1 AND block_number<=$2 AND lower(payload->>'address')=$3
        AND lower(payload->'topics'->>0)=$4 LIMIT $5`,[CHAIN,tag,config.executor.toLowerCase(),executorInterface.getEvent('Enrolled').topicHash,limits.enrollments+1])).rows;
      for(const row of rows) if(ethers.isHexString(row.id,32)) ids.add(row.id);
    }
    if(ids.size>limits.enrollments) throw new Error('EXECUTOR_DISCOVERY_LIMIT');
    const jobs=[];
    for(const enrollmentId of ids) {
      const e=await gateway.enrollment(enrollmentId,tag);
      if(!e||!(await gateway.registered(e.sessionId,tag))) continue;
      for(const marketId of await gateway.markets(e.sessionId,tag)) {
        for(const action of ['recover','execute']) {
          const job={enrollmentId,marketId,action};
          if(await eligible(job,tag,head.timestamp)) jobs.push(job);
        }
      }
    }
    if((await provider.getBlock(tag))?.hash!==canonical.hash) throw new Error('DISCOVERY_REORG');
    for(const job of jobs) await c.query(`INSERT INTO proofcast_executor_jobs(job_key,deployment,chain_id,executor,enrollment_id,market_id,action)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[jobKey(config,job),deployment,CHAIN,config.executor.toLowerCase(),job.enrollmentId.toLowerCase(),job.marketId.toLowerCase(),job.action]);
    return jobs;
  }
  function verifyJournal(row) {
    const tx=ethers.Transaction.from(row.raw_tx);
    const expected=typedRequest({executor:row.executor},{enrollmentId:row.enrollment_id,marketId:row.market_id,action:row.action});
    if(tx.hash!==row.tx_hash||tx.from?.toLowerCase()!==signerAddress||tx.chainId!==50312n||tx.to?.toLowerCase()!==row.executor||tx.nonce!==Number(row.nonce)||tx.value!==0n||tx.data!==expected.data||tx.gasLimit*tx.maxFeePerGas!==BigInt(row.reserved)) throw new Error('EXECUTOR_JOURNAL_MISMATCH');
    return tx;
  }
  async function broadcast(c,row) {
    // A successful DB round trip is required after the durable COMMIT. No raw
    // bytes, key material, or untrusted RPC error text enter logs/snapshots.
    await c.query('SELECT 1');
    try {
      const response=await provider.broadcastTransaction(row.raw_tx);
      if(response.hash!==row.tx_hash) throw new Error('HASH_MISMATCH');
      await c.query("UPDATE proofcast_executor_jobs SET state='BROADCAST',updated_at=now() WHERE job_key=$1",[row.job_key]);
    } catch {
      await c.query("UPDATE proofcast_executor_jobs SET state='UNKNOWN',updated_at=now() WHERE job_key=$1",[row.job_key]);
    }
  }
  async function reconcile(c,head) {
    const rows=(await c.query(`SELECT * FROM proofcast_executor_jobs WHERE chain_id=$1 AND signer=$2 AND state IN ${ACTIVE} ORDER BY nonce`,[CHAIN,signerAddress])).rows;
    for(const row of rows) {
      const tx=verifyJournal(row);
      const receipt=await provider.getTransactionReceipt(row.tx_hash);
      if(receipt) {
        const canonical=await provider.getBlock(receipt.blockNumber);
        if(receipt.hash===row.tx_hash&&canonical?.hash===receipt.blockHash&&head.number-receipt.blockNumber>=limits.confirmations&&[0,1].includes(Number(receipt.status))) {
          await c.query('UPDATE proofcast_executor_jobs SET state=$2,receipt=$3::jsonb,updated_at=now() WHERE job_key=$1',[row.job_key,Number(receipt.status)===1?'CONFIRMED':'REVERTED',JSON.stringify({hash:receipt.hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,status:Number(receipt.status)})]);
          continue;
        }
        return true;
      }
      const latest=await provider.getTransactionCount(signerAddress,'latest');
      const pending=await provider.getTransactionCount(signerAddress,'pending');
      // If a nonce was used externally, a missing receipt is ambiguous forever;
      // never replace it or infer success from a nonce alone.
      if(latest<=tx.nonce&&pending<=tx.nonce&&!(await provider.getTransaction(row.tx_hash))&&tx.gasLimit<=limits.gas&&tx.maxFeePerGas<=limits.fee) {
        await freshHead();
        await broadcast(c,row);
      }
      return true;
    }
    return false;
  }
  async function signJob(c,job) {
    await c.query('BEGIN');
    try {
      const row=(await c.query("SELECT * FROM proofcast_executor_jobs WHERE job_key=$1 AND state='QUEUED' FOR UPDATE SKIP LOCKED",[jobKey(config,job)])).rows[0];
      if(!row) {await c.query('ROLLBACK');return false;}
      const head=await freshHead();
      if(!(await eligible(job,'latest',head.timestamp))) {await c.query('ROLLBACK');return false;}
      let estimate,result;
      try {result=await gateway.simulate(job,signerAddress);estimate=BigInt(await gateway.estimate(job,signerAddress));}
      catch {await c.query('ROLLBACK');return false;}
      if(job.action==='recover'&&BigInt(result)!==5n) {await c.query('ROLLBACK');return false;}
      const gas=(estimate*125n+99n)/100n,fees=await provider.getFeeData();
      const fee=fees.maxFeePerGas??fees.gasPrice,tip=fees.maxPriorityFeePerGas??0n;
      if(estimate<=0n||gas>limits.gas||!fee||fee<=0n||fee>limits.fee||tip<0n||tip>fee) {await c.query('ROLLBACK');return false;}
      const cost=gas*fee;
      await c.query('INSERT INTO proofcast_executor_runs(chain_id,signer,run_id,budget) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[CHAIN,signerAddress,run,String(limits.budget)]);
      const reserved=await c.query('UPDATE proofcast_executor_runs SET reserved=reserved+$4 WHERE chain_id=$1 AND signer=$2 AND run_id=$3 AND reserved+$4<=LEAST(budget,$5) RETURNING reserved',[CHAIN,signerAddress,run,String(cost),String(limits.budget)]);
      if(!reserved.rowCount||await provider.getBalance(signerAddress)<cost) {await c.query('ROLLBACK');return false;}
      const latest=await provider.getTransactionCount(signerAddress,'latest'),pending=await provider.getTransactionCount(signerAddress,'pending');
      const previous=(await c.query('SELECT max(nonce) AS nonce FROM proofcast_executor_jobs WHERE chain_id=$1 AND signer=$2',[CHAIN,signerAddress])).rows[0].nonce;
      if(!Number.isSafeInteger(latest)||latest<0||pending!==latest||(previous!==null&&latest<=Number(previous))) {await c.query('ROLLBACK');return false;}
      await freshHead();
      const raw=await signer.signTransaction({...typedRequest(config,job),chainId:CHAIN,type:2,nonce:latest,gasLimit:gas,maxFeePerGas:fee,maxPriorityFeePerGas:tip});
      const signed=(await c.query(`UPDATE proofcast_executor_jobs SET state='SIGNED',signer=$2,run_id=$3,nonce=$4,raw_tx=$5,tx_hash=$6,reserved=$7,updated_at=now() WHERE job_key=$1 RETURNING *`,[row.job_key,signerAddress,run,latest,raw,ethers.keccak256(raw),String(cost)])).rows[0];
      verifyJournal(signed);
      await c.query('COMMIT');
      await broadcast(c,signed);
      return true;
    } catch(e) {await c.query('ROLLBACK').catch(()=>{});throw e;}
  }
  async function cycle() {
    await initialize();
    const c=await pool.connect();let locked=false;
    // Session lock survives the signed-record COMMIT, covering nonce selection
    // through broadcast. Dedicated connection; all processes share this journal.
    const lockName=`proofcast:executor:${CHAIN}:${signerAddress}`;
    try {
      locked=(await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[lockName])).rows[0].locked;
      if(!locked) return {enabled:true,locked:true};
      const head=await freshHead();
      if(await reconcile(c,head)) return {enabled:true,ok:true,pending:true};
      await gateway.verifyDeployment(head.number-limits.confirmations);
      const jobs=await discover(c,head);
      for(const job of jobs.slice(0,limits.jobs)) if(await signJob(c,job)) return {enabled:true,ok:true,pending:true};
      return {enabled:true,ok:true,pending:false};
    } finally {
      if(locked) {try{await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockName]);}catch{c.release(true);return;}}
      c.release();
    }
  }
  function tick() {
    if(closed) return Promise.reject(new Error('EXECUTOR_CLOSED'));
    if(!flight) flight=cycle().then(s=>{state=s;return s;}).catch(()=>{state={enabled:true,ok:false,error:'EXECUTOR_TICK_FAILED'};throw new Error('EXECUTOR_TICK_FAILED');}).finally(()=>{flight=null;});
    return flight;
  }
  async function close() {closed=true;await flight?.catch(()=>{});if(!providedGateway)provider.destroy();if(!providedPool)await pool.end();}
  return {initialize,tick,snapshot:()=>({...state}),close};
}
