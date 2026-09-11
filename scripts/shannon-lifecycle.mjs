import fs from 'node:fs';
import assert from 'node:assert/strict';
import {ethers} from 'ethers';
import {maySubmit,evidencePath,chooseSide} from './lifecycle-journal.mjs';
process.loadEnvFile('.env');
const mode=process.argv[2]??'preflight';
const isFork=process.env.PROOFCAST_FORK==='1';
const rpc=new ethers.JsonRpcProvider(isFork?'http://127.0.0.1:18551':'https://dream-rpc.somnia.network',50312);
const owner='0x7e0bDD1d6f0d76Bdd3716E37b58f9a8476b0603E';
const config=JSON.parse(fs.readFileSync('config/shannon.json','utf8')).dreamdex;
const file=evidencePath(isFork,process.env.PROOFCAST_RUN_ID??'');
const artifact=name=>JSON.parse(fs.readFileSync('artifacts/'+name+'.json','utf8'));
const poolAbi=[
'function getBinaryPoolParams()view returns((address collateralToken,address market,address outcomeToken,uint256 yesId,uint256 noId,uint256 oneCollateral,uint256 setBacking,address feeRecipient,uint256 makerFeeBpsTimes1k,uint256 takerFeeBpsTimes1k,uint256 maxBuilderFeeBpsTimes1k,uint256 settlementFeeBpsTimes1k,address settlement,uint64 marketNonce,bool finalized))',
'function marketExpiryNs()view returns(uint64)','function getBookLevels(bool,uint64)view returns((uint256 price,uint256 quantity)[])','function getOrderBookParameters()view returns((uint256 tickSize,uint256 minQuantity,uint256 lotSize))'
];
const marketAbi=['function isResolved()view returns(bool)','function isVoided()view returns(bool)','function status()view returns(uint8)','function expiry()view returns(uint64)','function settlementWindow()view returns(uint64)','function voidExpired()'];
let evidence;
const save=()=>fs.writeFileSync(file,JSON.stringify(evidence,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
try{
assert.ok(['preflight','run','signal','recover'].includes(mode));
assert.equal((await rpc.getNetwork()).chainId,50312n);
let signer;
if(isFork){
assert.match(await rpc.send('web3_clientVersion',[]),/anvil/i);
await rpc.send('evm_mine',[]);
await rpc.send('anvil_impersonateAccount',[owner]);await rpc.send('anvil_setBalance',[owner,ethers.toBeHex(ethers.parseEther('100'))]);signer=new ethers.JsonRpcSigner(rpc,owner);
}else{signer=new ethers.Wallet(process.env.PROOFCAST_DEPLOYER_PRIVATE_KEY,rpc);assert.equal(signer.address.toLowerCase(),owner.toLowerCase());}
const contract=(name,address)=>new ethers.Contract(address,artifact(name).abi,signer);
async function send(label,request){
const fees=await rpc.getFeeData(),estimate=await rpc.estimateGas({...request,from:owner}),gasLimit=estimate*125n/100n;
const maxFeePerGas=(fees.maxFeePerGas??fees.gasPrice)*2n,maxPriorityFeePerGas=fees.maxPriorityFeePerGas??1000000000n;
assert.ok(gasLimit*maxFeePerGas<=ethers.parseEther('5'),'TX_GAS_CAP');
const tx=await signer.sendTransaction({...request,gasLimit,maxFeePerGas,maxPriorityFeePerGas});
const entry={label,hash:tx.hash,status:'SUBMITTED'};evidence.transactions.push(entry);save();console.log(JSON.stringify(entry));
const receipt=await tx.wait(1,120000);entry.block=receipt.blockNumber;entry.status=receipt.status===1?'MINED_SUCCESS':'REVERTED';save();assert.equal(receipt.status,1);return receipt;
}
async function deploy(name,args=[]){const a=artifact(name);const r=await send('deploy:'+name,await new ethers.ContractFactory(a.abi,a.evm.bytecode.object,signer).getDeployTransaction(...args));evidence[name]={address:r.contractAddress,block:r.blockNumber,txHash:r.hash,artifactHash:ethers.id(JSON.stringify(a))};save();assert.notEqual(await rpc.getCode(r.contractAddress),'0x');return contract(name,r.contractAddress);}
if(mode==='run'||mode==='preflight'){
assert.ok(mode!=='run'||!fs.existsSync(file),'EVIDENCE_EXISTS');
const head=await rpc.getBlock('latest');if(!isFork)assert.ok(Math.abs(Date.now()/1000-head.timestamp)<120,'STALE_CHAIN');
const query='{Market(where:{clobStatus:{_eq:Trading},expiry:{_gt:"'+(head.timestamp+600)+'",_lt:"'+(head.timestamp+7200)+'"}},order_by:{expiry:asc},limit:40){marketId poolAddress}}';
const data=await(await fetch('https://dev.smk.somnia.host/v1/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(15000)})).json();assert.ok(!data.errors);
let selection;
for(const row of data.data.Market){try{
const pool=new ethers.Contract(row.poolAddress,poolAbi,rpc),p=await pool.getBinaryPoolParams(),expiry=await pool.marketExpiryNs();
if(p.finalized||p.collateralToken.toLowerCase()!==config.collateral.toLowerCase()||expiry/1000000000n<BigInt(head.timestamp+600))continue;
const m=new ethers.Contract(p.market,marketAbi,rpc);if(await m.status()!==1n)continue;
const module=new ethers.Contract(config.module,['function markets(bytes32)view returns(uint256,uint8,uint8,address,uint32,bytes32,address,address,address,address,uint256,uint256,uint64,uint64)','function marketNonce(bytes32)view returns(uint64)'],rpc);
const record=await module.markets(row.marketId);if(record[9].toLowerCase()!==row.poolAddress.toLowerCase()||await module.marketNonce(row.marketId)!==p.marketNonce)continue;
const grid=await pool.getOrderBookParameters();
const [asks,bids]=await Promise.all([pool.getBookLevels(false,1),pool.getBookLevels(true,1)]);
if(grid.minQuantity!==1000n||grid.lotSize!==1000n)continue;
chooseSide(asks,bids);
selection={...row,p,record,expiry};break;
}catch{}}
assert.ok(selection,'NO_FRESH_SMALL_LIQUID_MARKET');
const {p,record,expiry}=selection;
console.log(JSON.stringify({phase:'PREFLIGHT',marketId:selection.marketId,pool:selection.poolAddress,nonce:String(p.marketNonce),expiry:String(expiry/1000000000n),isFork}));
if(mode==='run'){
const token=new ethers.Contract(p.collateralToken,['function balanceOf(address)view returns(uint256)','function approve(address,uint256)returns(bool)'],signer);
assert.ok(await token.balanceOf(owner)>=100000n,'NO_TUSDC');
evidence={isFork,liquidityEvidence:isFork?'LOCAL_SNAPSHOT_MAY_INCLUDE_CONTROLLED_MAKER':'PUBLIC_TESTNET_EXTERNAL_BOOK',startedAt:new Date().toISOString(),phase:'DEPLOYING',owner,creatorType:'SELF_CONTROLLED_DEMO_CONTRACT',marketId:selection.marketId,pool:selection.poolAddress,market:p.market,expiry:String(expiry/1000000000n),transactions:[]};save();
const expirySec=expiry/1000000000n,cutoff=expirySec-1n;
// This catalog validates each submitted market against DreamDEX native state;
// it is not tied to the first market selected by this lifecycle run.
const catalog=await deploy('LiveShannonDreamDexCatalog',[config.module,p.collateralToken,p.outcomeToken,p.settlement]);
const adapter=await deploy('ProofCastDreamDexAdapter');
const registry=await deploy('ProofCastRegistry',[await catalog.getAddress()]);
const executor=await deploy('ProofCastExecutor',[await registry.getAddress(),await adapter.getAddress()]);
const factory=await deploy('ProofCastFactory',[await registry.getAddress(),await executor.getAddress(),await adapter.getAddress()]);
const creator=await deploy('ProofCastDemoCreator',[await registry.getAddress()]);
await send('configure-protocol',await adapter.configureProtocol.populateTransaction(config.module,p.collateralToken,p.outcomeToken,p.settlement));
await send('adapter-factory',await adapter.setFactory.populateTransaction(await factory.getAddress()));
await send('executor-factory',await executor.setFactory.populateTransaction(await factory.getAddress()));
await send('native-enable',await adapter.setNativeExecutionEnabled.populateTransaction(true));
const now=(await rpc.getBlock('latest')).timestamp,enrollUntil=BigInt(now+60);
assert.ok(enrollUntil<cutoff,'SESSION_WINDOW_CLOSED');
evidence.enrollUntil=String(enrollUntil);evidence.sessionId=ethers.id('proofcast-native-'+evidence.startedAt);evidence.enrollmentId=ethers.id('proofcast-follower-'+evidence.startedAt);evidence.termsHash=ethers.id('bounded-0.01-tUSDC-self-controlled-test');
evidence.ref=[selection.marketId,p.marketNonce,selection.poolAddress,config.module,p.collateralToken,p.outcomeToken,p.yesId,p.noId,record[4],record[5],record[12],cutoff,expirySec];save();
await send('register-session',await creator.register.populateTransaction(evidence.sessionId,ethers.id('self-controlled-test-manifest'),evidence.termsHash,[evidence.ref],enrollUntil,expirySec+3600n));
await send('create-vault',await factory.createVault.populateTransaction(evidence.enrollmentId,evidence.sessionId,p.collateralToken));
evidence.vault=await factory.vaultFor(evidence.enrollmentId);save();
const vault=contract('ProofCastFollowerVault',evidence.vault);
await send('approve',await token.approve.populateTransaction(evidence.vault,100000));
await send('deposit',await vault.deposit.populateTransaction(100000));
// Adapter rounds the affordable quantity down to the pool lot grid.
await send('enroll',await executor.enroll.populateTransaction(evidence.enrollmentId,[3,1000000,1000000,1000,10000,expirySec,evidence.termsHash,1]));
evidence.phase='ENROLLED_WAITING_SIGNAL';save();
console.log(JSON.stringify({phase:evidence.phase,enrollUntil:evidence.enrollUntil,vault:evidence.vault}));
}
}else{
evidence=JSON.parse(fs.readFileSync(file,'utf8'));
assert.equal(evidence.isFork,isFork,'EVIDENCE_NETWORK_MISMATCH');
for(const entry of evidence.transactions.filter(t=>t.status==='SUBMITTED')){
  const receipt=await rpc.getTransactionReceipt(entry.hash);
  assert.ok(receipt,'RECONCILE_PENDING');entry.status=receipt.status===1?'MINED_SUCCESS':'REVERTED';entry.block=receipt.blockNumber;save();
}
const vault=contract('ProofCastFollowerVault',evidence.vault),executor=contract('ProofCastExecutor',evidence.ProofCastExecutor.address);
if(mode==='signal'){
assert.ok(['ENROLLED_WAITING_SIGNAL','SIGNAL_ANCHORED'].includes(evidence.phase));
let now=(await rpc.getBlock('latest')).timestamp;
if(isFork&&now<Number(evidence.enrollUntil)){await rpc.send('evm_setNextBlockTimestamp',[Number(evidence.enrollUntil)]);await rpc.send('evm_mine',[]);now=Number(evidence.enrollUntil);}
if(now<Number(evidence.enrollUntil)){console.log(JSON.stringify({phase:'WAITING_ENROLLMENT_CUTOFF',seconds:Number(evidence.enrollUntil)-now}));process.exitCode=2;}
else{
const creator=contract('ProofCastDemoCreator',evidence.ProofCastDemoCreator.address);
if(maySubmit(evidence.transactions,'anchor-signal')){
  const pool=new ethers.Contract(evidence.pool,poolAbi,rpc);
  const [asks,bids]=await Promise.all([pool.getBookLevels(false,1),pool.getBookLevels(true,1)]);
  evidence.signalSide=chooseSide(asks,bids);evidence.signalPrice='999000';save();
  await send('anchor-signal',await creator.publish.populateTransaction(evidence.sessionId,evidence.marketId,evidence.signalSide,evidence.signalPrice,BigInt(evidence.expiry)-1n,ethers.id('testnet-native-loop')));
}
evidence.phase='SIGNAL_ANCHORED';save();
if(maySubmit(evidence.transactions,'native-execute'))await send('native-execute',await executor.execute.populateTransaction(evidence.enrollmentId,evidence.marketId));
const record=await vault.executions(await vault.executionCount());evidence.actualCost=String(record.actualCost);evidence.actualQuantity=String(record.filledAmount);save();
assert.ok(record.filledAmount>0n);
if(maySubmit(evidence.transactions,'revoke'))await send('revoke',await executor.revokeEnrollment.populateTransaction(evidence.enrollmentId));
const cashToken=new ethers.Contract(evidence.ref[4],['function balanceOf(address)view returns(uint256)'],rpc);
if(maySubmit(evidence.transactions,'withdraw-unused'))await send('withdraw-unused',await vault.withdraw.populateTransaction(await cashToken.balanceOf(evidence.vault)));
evidence.phase='AWAITING_SETTLEMENT';save();console.log(JSON.stringify({phase:evidence.phase,cost:evidence.actualCost,quantity:evidence.actualQuantity}));
}
}else{
const market=new ethers.Contract(evidence.market,marketAbi,signer);
if(isFork&&!await market.isResolved()&&!await market.isVoided()){const at=await market.expiry()+await market.settlementWindow()+1n;await rpc.send('evm_setNextBlockTimestamp',[Number(at)]);await rpc.send('evm_mine',[]);await send('fork-void',await market.voidExpired.populateTransaction());}
if(!await market.isResolved()&&!await market.isVoided()){console.log(JSON.stringify({phase:'PAYOUT_PENDING',expiry:evidence.expiry}));process.exitCode=2;}
else{
if((await vault.recoveryConfigs(evidence.marketId)).positionAmount>0n)await send('recover',await executor.recover.populateTransaction(evidence.enrollmentId,evidence.marketId));
assert.equal(await vault.openRisk(),0n);
const token=new ethers.Contract(evidence.ref[4],['function balanceOf(address)view returns(uint256)'],rpc);
const cash=await token.balanceOf(evidence.vault);if(cash>0n)await send('withdraw',await vault.withdraw.populateTransaction(cash));
assert.equal(await token.balanceOf(evidence.vault),0n);evidence.phase='RECOVERED_AND_WITHDRAWN';evidence.realizedLoss=String(await vault.realizedLoss());save();console.log(JSON.stringify({phase:evidence.phase,realizedLoss:evidence.realizedLoss}));
}
}
}
}catch(error){console.error(JSON.stringify({error:error.shortMessage??error.message,phase:evidence?.phase}));process.exitCode=1;}finally{rpc.destroy();}
