import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {ethers} from 'ethers';
import {verifyReceipt,verifyClosedPosition} from './receipt-verification.mjs';
const root=new URL('../',import.meta.url);
const expectedOwner='0x7e0bDD1d6f0d76Bdd3716E37b58f9a8476b0603E';
export async function inspectLifecycle(evidenceName=process.env.PROOFCAST_LIFECYCLE_EVIDENCE??'lifecycle-2026-09-10-dynamic-20260911.json'){
  const rpc=new ethers.JsonRpcProvider('https://dream-rpc.somnia.network',50312);
  try{
    if(!/^[a-zA-Z0-9._-]{1,100}\.json$/.test(evidenceName)) throw new Error('INVALID_EVIDENCE_FILE');
    const evidence=JSON.parse(fs.readFileSync(new URL('docs/evidence/'+evidenceName,root),'utf8'));
    assert.notEqual(evidence.isFork,true,'FORK_IS_NOT_PUBLIC_EVIDENCE');
    assert.equal(evidence.owner.toLowerCase(),expectedOwner.toLowerCase());
    assert.equal((await rpc.getNetwork()).chainId,50312n);
    const head=await rpc.getBlock('latest');
    assert.ok(Math.abs(Date.now()/1000-head.timestamp)<120,'STALE_CHAIN');
    const verified=[];
    for(const entry of evidence.transactions){
      const [receipt,transaction]=await Promise.all([rpc.getTransactionReceipt(entry.hash),rpc.getTransaction(entry.hash)]);
      const block=receipt?await rpc.getBlock(receipt.blockNumber):null;
      verifyReceipt(entry,receipt,transaction,block,expectedOwner);
      assert.ok(head.number-receipt.blockNumber>=2,'INSUFFICIENT_CONFIRMATIONS');
      verified.push({label:entry.label,hash:entry.hash,block:receipt.blockNumber,blockHash:receipt.blockHash,to:transaction.to,status:'VERIFIED_SUCCESS'});
    }
    const code=await rpc.getCode(evidence.vault,head.number);assert.notEqual(code,'0x','VAULT_CODE_MISSING');
    const vault=new ethers.Contract(evidence.vault,['function owner()view returns(address)','function openRisk()view returns(uint256)','function realizedLoss()view returns(uint256)','function revoked()view returns(bool)'],rpc);
    const token=new ethers.Contract(evidence.ref[4],['function balanceOf(address)view returns(uint256)'],rpc);
    const overrides={blockTag:head.number};
    const [owner,openRisk,realizedLoss,revoked,cash]=await Promise.all([vault.owner(overrides),vault.openRisk(overrides),vault.realizedLoss(overrides),vault.revoked(overrides),token.balanceOf(evidence.vault,overrides)]);
    assert.equal(owner.toLowerCase(),expectedOwner.toLowerCase(),'WRONG_VAULT_OWNER');
    const positionVault=new ethers.Contract(evidence.vault,JSON.parse(fs.readFileSync(new URL('artifacts/ProofCastFollowerVault.json',root),'utf8')).abi,rpc);
    const count=await positionVault.executionCount(overrides);assert.equal(count,1n,'UNEXPECTED_EXECUTION_COUNT');
    const [position,recovery]=await Promise.all([positionVault.executions(count,overrides),positionVault.recoveryConfigs(evidence.marketId,overrides)]);
    assert.equal(String(position.actualCost),evidence.actualCost,'COST_RECORD_MISMATCH');
    assert.equal(String(position.filledAmount),evidence.actualQuantity,'QUANTITY_RECORD_MISMATCH');
    let complete=false;
    if(evidence.phase==='RECOVERED_AND_WITHDRAWN'){
      verifyClosedPosition({openRisk,cash,revoked,recovered:recovery.resolved,transactions:verified});complete=true;
    }
    return {project:'proofcast',chainId:50312,network:'PUBLIC_SHANNON',observedAt:new Date().toISOString(),observedBlock:head.number,observedBlockHash:head.hash,phase:evidence.phase,complete,owner,vault:evidence.vault,vaultCodeHash:ethers.keccak256(code),marketId:evidence.marketId,expiry:evidence.expiry,openRiskRaw:String(openRisk),realizedLossRaw:String(realizedLoss),cashRaw:String(cash),revoked,transactions:verified,limitations:['CLI lifecycle evidence, not browser wallet acceptance','No assertion of production hosting or worker execution','Receipt verification does not prove current source equals deployed bytecode']};
  }finally{rpc.destroy();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{const report=await inspectLifecycle();fs.writeFileSync(new URL('docs/evidence/lifecycle-verification-2026-09-11-dynamic.json',root),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
  catch(error){console.error(JSON.stringify({error:error.shortMessage??error.message}));process.exitCode=1;}
}
