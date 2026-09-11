import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { ethers } from 'ethers';

const mod = await import('../apps/worker/src/executor.js').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
test('durable executor implementation is available', () => assert.equal(typeof mod.createExecutorWorker, 'function'));
const dbUrl = process.env.EXECUTOR_TEST_DATABASE_URL;
const hash = n => ethers.zeroPadValue(ethers.toBeHex(n), 32);
const address = n => ethers.getAddress(ethers.dataSlice(hash(n), 12));
const config = { chainId:50312, executor:address(1), registry:address(2), factory:address(3), adapter:address(4), knownEnrollments:[hash(1)] };

async function fixture(t, overrides = {}) {
  const schema = 'executor_test_' + crypto.randomBytes(10).toString('hex');
  const admin = new pg.Pool({connectionString:dbUrl});
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({connectionString:dbUrl, options:`-c search_path=${schema}`, max:8});
  const signer = ethers.Wallet.createRandom();
  const state = { head:100, time:2000, chainId:50312n, nonce:7, pending:7, receipt:null, broadcasts:[], estimates:100000n, consumed:false, active:true, registered:true, signalSide:1n, signalUntil:3000n, recovery:false, resolved:false, throwSend:false };
  const gateway = {
    provider:{
      getNetwork:async()=>({chainId:state.chainId}),
      getBlock:async n=>({number:n==='latest'?state.head:Number(n),hash:hash(n==='latest'?state.head:Number(n)),timestamp:state.time}),
      getTransactionCount:async(_,tag)=>tag==='pending'?state.pending:state.nonce,
      getFeeData:async()=>({maxFeePerGas:2n,maxPriorityFeePerGas:1n}),
      getBalance:async()=>10n**20n,
      getTransactionReceipt:async()=>state.receipt,
      getTransaction:async()=>null,
      broadcastTransaction:async raw=>{
        const rows=(await pool.query('SELECT * FROM proofcast_executor_jobs WHERE tx_hash=$1',[ethers.keccak256(raw)])).rows;
        assert.equal(rows.length,1,'signed bytes must be committed and visible on another connection before broadcast');
        assert.equal(rows[0].raw_tx,raw);
        state.broadcasts.push(raw);
        if(state.throwSend) throw new Error('RPC response lost PRIVATE MATERIAL MUST NEVER ESCAPE');
        return {hash:ethers.keccak256(raw)};
      }
    },
    verifyDeployment:async()=>{},
    enrollment:async()=>({sessionId:hash(2),vault:address(5),follower:address(6),active:state.active}),
    registered:async()=>state.registered,
    markets:async()=>[hash(3)],
    signal:async()=>({signalId:hash(4),side:state.signalSide,validUntil:state.signalUntil}),
    consumed:async()=>state.consumed,
    withdrawn:async()=>false,
    recovery:async()=>({positionAmount:state.recovery?1n:0n,resolved:state.resolved}),
    simulate:async job=>job.action==='recover'?5n:2n,
    estimate:async()=>state.estimates
  };
  const env={EXECUTOR_ENABLED:'1',EXECUTOR_RUN_ID:'test-run',EXECUTOR_RUN_BUDGET_WEI:'1000000',EXECUTOR_MAX_FEE_PER_GAS_WEI:'10',EXECUTOR_MAX_GAS:'200000',EXECUTOR_CONFIRMATIONS:'2',...overrides};
  const workers=[];
  const make=(extra={})=>{const w=mod.createExecutorWorker({env,config,pool,signer,gateway,now:()=>2000_000,...extra}); workers.push(w);return w;};
  t.after(async()=>{for(const w of workers)await w.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();});
  const rows=async()=> (await pool.query('SELECT * FROM proofcast_executor_jobs ORDER BY enrollment_id,action')).rows;
  return {pool,signer,state,gateway,make,rows,env};
}

const options={skip:!dbUrl||!mod.createExecutorWorker,timeout:30000};
test('disabled by default and never inherits follower credentials', {skip:!mod.createExecutorWorker}, async()=>{
  const w=mod.createExecutorWorker({env:{FOLLOWER_PRIVATE_KEY:'not-a-key'}});
  assert.deepEqual(await w.tick(),{enabled:false}); await w.close();
  assert.throws(()=>mod.createExecutorWorker({env:{EXECUTOR_ENABLED:'1',FOLLOWER_PRIVATE_KEY:'not-a-key'}}),/EXECUTOR_CONFIGURATION_REQUIRED/);
});
test('signed journal, restart reconciliation and typed zero-value chain 50312 transaction',options,async t=>{
  const f=await fixture(t);await f.make().tick();
  let [j]=await f.rows();const tx=ethers.Transaction.from(j.raw_tx);
  assert.equal(tx.chainId,50312n);assert.equal(tx.to,config.executor);assert.equal(tx.value,0n);assert.equal(tx.nonce,7);
  assert.equal(tx.data,new ethers.Interface(['function execute(bytes32,bytes32)']).encodeFunctionData('execute',[hash(1),hash(3)]));
  assert.equal(j.state,'BROADCAST');
  f.state.receipt={hash:j.tx_hash,blockNumber:98,blockHash:hash(98),status:1};
  await f.make().tick();[j]=await f.rows();assert.equal(j.state,'CONFIRMED');assert.equal(f.state.broadcasts.length,1);
});
test('concurrent independent workers serialize signer and allocate a single durable nonce',options,async t=>{
  const f=await fixture(t);const a=f.make(),b=f.make();await Promise.all([a.initialize(),b.initialize()]);
  let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  f.gateway.estimate=async()=>{entered();await gate;return 100000n;};
  const first=a.tick();await ready;const other=await b.tick();assert.equal(other.locked,true);release();await first;
  assert.equal((await f.rows()).length,1);assert.equal(f.state.broadcasts.length,1);
});
test('unknown broadcast remains same hash and bytes, blocks another job and consumed unknown nonce never gets replaced',options,async t=>{
  const f=await fixture(t);f.state.throwSend=true;await f.make().tick();
  const [j]=await f.rows();assert.equal(j.state,'UNKNOWN');
  f.state.nonce=8;f.state.pending=8;
  await f.make({config:{...config,knownEnrollments:[hash(1),hash(9)]}}).tick();
  assert.equal(f.state.broadcasts.length,1);assert.equal((await f.rows()).filter(r=>r.raw_tx).length,1);
  f.state.receipt={hash:j.tx_hash,blockNumber:98,blockHash:hash(98),status:0};
  await f.make().tick();assert.equal((await f.rows())[0].state,'REVERTED');
});
test('crash after signing before send restarts by broadcasting only identical journal bytes',options,async t=>{
  const f=await fixture(t);f.gateway.provider.broadcastTransaction=async()=>{throw new Error('crash before socket write');};
  await f.make().tick();const [j]=await f.rows();
  const seen=[];f.gateway.provider.broadcastTransaction=async raw=>{seen.push(raw);return {hash:ethers.keccak256(raw)};};
  await f.make().tick();assert.deepEqual(seen,[j.raw_tx]);assert.equal((await f.rows())[0].nonce,j.nonce);
});
test('budget persists across restart and cannot be reset by changing configured amount',options,async t=>{
  const f=await fixture(t,{EXECUTOR_RUN_BUDGET_WEI:'250000'});await f.make().tick();const [j]=await f.rows();
  f.state.receipt={hash:j.tx_hash,blockNumber:98,blockHash:hash(98),status:1};f.state.nonce=8;f.state.pending=8;
  await f.make({config:{...config,knownEnrollments:[hash(1),hash(9)]},env:{...f.env,EXECUTOR_RUN_BUDGET_WEI:'999999999'}}).tick();
  assert.equal(f.state.broadcasts.length,1);
});
test('DB failure before signed commit prevents broadcasting',options,async t=>{
  const f=await fixture(t);const w=f.make();await w.initialize();
  await f.pool.query("ALTER TABLE proofcast_executor_jobs ADD CONSTRAINT reject_signed CHECK(raw_tx IS NULL)");
  await assert.rejects(w.tick());assert.equal(f.state.broadcasts.length,0);assert.equal((await f.rows()).filter(j=>j.raw_tx).length,0);
});
test('wrong chain, stale head, excessive gas and abstain do not sign',options,async t=>{
  for(const change of [{chainId:1n},{time:1},{estimates:999999n},{signalSide:3n},{signalUntil:1n},{active:false},{registered:false}]) {
    const f=await fixture(t);Object.assign(f.state,change);await f.make().tick().catch(()=>{});
    assert.equal(f.state.broadcasts.length,0);assert.equal((await f.rows()).filter(j=>j.raw_tx).length,0);
  }
});
test('recover works after revoke and only a simulated RECOVERED result may be signed',options,async t=>{
  const f=await fixture(t);f.state.active=false;f.state.consumed=true;f.state.recovery=true;
  f.gateway.simulate=async()=>4n;await f.make().tick();assert.equal(f.state.broadcasts.length,0);
  f.gateway.simulate=async()=>5n;await f.make().tick();const [j]=await f.rows();assert.equal(j.action,'recover');
  assert.equal(ethers.Transaction.from(j.raw_tx).data,new ethers.Interface(['function recover(bytes32,bytes32)']).encodeFunctionData('recover',[hash(1),hash(3)]));
});
test('unconfirmed or noncanonical receipt cannot release signer',options,async t=>{
  const f=await fixture(t);await f.make().tick();const [j]=await f.rows();
  for(const receipt of [{hash:j.tx_hash,blockNumber:100,blockHash:hash(100),status:1},{hash:j.tx_hash,blockNumber:98,blockHash:hash(999),status:1}]) {
    f.state.receipt=receipt;await f.make().tick();assert.notEqual((await f.rows())[0].state,'CONFIRMED');
  }
  assert.equal(f.state.broadcasts.length,1);
});
test('job identity binds deployment enrollment market and allowed action', {skip:!mod.createExecutorWorker},()=>{
  const job={enrollmentId:hash(1),marketId:hash(2),action:'execute'};
  const k=mod.jobKey(config,job);
  for(const altered of [{...job,marketId:hash(3)},{...job,enrollmentId:hash(4)},{...job,action:'recover'}])assert.notEqual(k,mod.jobKey(config,altered));
  assert.notEqual(k,mod.jobKey({...config,executor:address(8)},job));
  assert.throws(()=>mod.jobKey(config,{...job,action:'withdraw'}),/INVALID_EXECUTOR_JOB/);
});
