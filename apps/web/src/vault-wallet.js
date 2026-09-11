import { BrowserProvider, Contract, isAddress, isHexString, parseUnits, formatUnits } from 'ethers';
import manifest from '../../../config/shannon.json' with { type: 'json' };
import history from '../../../docs/evidence/lifecycle-2026-09-10-dynamic-20260911.json' with { type: 'json' };
export async function receiptState(provider,hash,owner,vault) {
 const r=await provider.getTransactionReceipt(hash);
 if(!r)return null;
 if(r.hash!==hash||r.from?.toLowerCase()!==owner.toLowerCase()||r.to?.toLowerCase()!==vault.toLowerCase()) throw new Error('RECEIPT_MISMATCH');
 if(![0,1].includes(r.status)||(await provider.getBlock(r.blockNumber))?.hash!==r.blockHash||await provider.getBlockNumber()-r.blockNumber<2)return null;
 return {hash:r.hash,block:r.blockNumber,status:r.status};
}
export async function reconcileOwnerAction(ethereum,pending) {
 await assertWallet(ethereum,pending.owner);
 const provider=new BrowserProvider(ethereum,50312,{cacheTimeout:-1});
 try{return await receiptState(provider,pending.hash,pending.owner,pending.vault);}finally{provider.destroy();}
}
export async function assertWallet(ethereum, owner) {
 if(!ethereum) throw new Error('WALLET_REQUIRED');
 if(BigInt(await ethereum.request({method:'eth_chainId'}))!==50312n) throw new Error('WRONG_CHAIN: switch wallet to Shannon');
 const accounts=await ethereum.request({method:'eth_accounts'});
 if(!isAddress(owner)||accounts[0]?.toLowerCase()!==owner.toLowerCase()) throw new Error('ACCOUNT_CHANGED: reconnect wallet');
}
export function ownerAction(action,value) {
 if(action==='withdraw') {
  if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(String(value))) throw new Error('INVALID_AMOUNT');
  const amount=parseUnits(value,6); if(amount<=0n) throw new Error('INVALID_AMOUNT');
  return {name:'withdraw',args:[amount]};
 }
 if(action==='recover') {
  if(!isHexString(value,32)) throw new Error('INVALID_POSITION');
  return {name:'recover',args:[value]};
 }
 if(['revoke'].includes(action)) return {name:action,args:[]};
 throw new Error('UNSUPPORTED_ACTION');
}
const abi=['function owner() view returns(address)','function beneficiary() view returns(address)',
 'function collateral() view returns(address)','function openRisk() view returns(uint256)',
 'function realizedLoss() view returns(uint256)','function revoked() view returns(bool)',
 'function withdraw(uint256)','function recover(bytes32)','function revoke()',
 'function enrollmentId() view returns(bytes32)'];
async function verified(ethereum,owner,address) {
 await assertWallet(ethereum,owner);
 if(!isAddress(address)) throw new Error('INVALID_VAULT');
 const provider=new BrowserProvider(ethereum,50312,{cacheTimeout:-1});
 const head=await provider.getBlock('latest');
 if(!head||Math.abs(Date.now()/1000-head.timestamp)>120) throw new Error('STALE_CHAIN');
 if(await provider.getCode(address)==='0x') throw new Error('VAULT_NOT_DEPLOYED');
 const vault=new Contract(address,abi,provider);
 if((await vault.owner()).toLowerCase()!==owner.toLowerCase()) throw new Error('NOT_VAULT_OWNER');
 const factories=[history.ProofCastFactory?.address].filter(isAddress);
 let known=false;
 for(const factory of factories) {
  try {
   const id=await vault.enrollmentId(); const registered=await new Contract(factory,['function vaultFor(bytes32) view returns(address)'],provider).vaultFor(id); known ||= registered.toLowerCase()===address.toLowerCase();
  } catch {}
 }
 if(!known) throw new Error('UNKNOWN_PROJECT_VAULT');
 return {provider,vault};
}
export async function readVault(ethereum,owner,address) {
 const {provider,vault}=await verified(ethereum,owner,address);
 try {
  const [risk,loss,revoked,beneficiary,token]=await Promise.all([vault.openRisk(),vault.realizedLoss(),vault.revoked(),vault.beneficiary(),vault.collateral()]);
  const cash=await new Contract(token,['function balanceOf(address) view returns(uint256)'],provider).balanceOf(address);
  return {address,beneficiary,cash:formatUnits(cash,6),risk:formatUnits(risk,6),loss:formatUnits(loss,6),revoked};
 } finally {provider.destroy();}
}
export async function sendOwnerAction(ethereum,owner,address,action,value,onSubmitted,onSigning) {
 const call=ownerAction(action,value);
 const {provider,vault}=await verified(ethereum,owner,address);
 try {
  const signer=await provider.getSigner(owner);
  const target=vault.connect(signer);
  await target[call.name].staticCall(...call.args);
  const estimate=await target[call.name].estimateGas(...call.args);
  const gasLimit=(estimate*125n+99n)/100n;
  const fees=await provider.getFeeData();
  const fee=fees.maxFeePerGas??fees.gasPrice;
  if(!fee||gasLimit*fee>parseUnits('0.5',18)) throw new Error('GAS_BUDGET_EXCEEDED');
  await assertWallet(ethereum,owner);
  onSigning?.();
  const tx=await target[call.name](...call.args,{gasLimit,maxFeePerGas:fee,maxPriorityFeePerGas:fees.maxPriorityFeePerGas??0n});
  onSubmitted?.(tx.hash);
  const receipt=await tx.wait(2,120000);
  if(!receipt||receipt.status!==1||(await provider.getBlock(receipt.blockNumber))?.hash!==receipt.blockHash) throw new Error('RECEIPT_UNCONFIRMED');
  return {hash:receipt.hash,block:receipt.blockNumber};
 } finally {provider.destroy();}
}
