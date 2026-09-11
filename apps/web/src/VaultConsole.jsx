import React,{useState,useEffect,useRef} from 'react';
import {readVault,sendOwnerAction,assertWallet,reconcileOwnerAction} from './vault-wallet.js';
import history from '../../../docs/evidence/lifecycle-2026-09-10-dynamic-20260911.json' with {type:'json'};
export function VaultConsole(){
 const pendingKey='proofcast:pending-owner-action:50312';
 const [pending,setPending]=useState(()=>{try{return JSON.parse(localStorage.getItem(pendingKey)||'null');}catch{return {unreadable:true};}});
 const [owner,setOwner]=useState(''),[vault,setVault]=useState(history.vault??''),[snapshot,setSnapshot]=useState(null);
 const [amount,setAmount]=useState(''),[position,setPosition]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const [receipt,setReceipt]=useState(null); const flight=useRef(false);
 useEffect(()=>{
  const invalidate=()=>{setOwner('');setSnapshot(null);setMessage('Wallet changed. Connect again before signing.');};
  window.ethereum?.on?.('accountsChanged',invalidate);window.ethereum?.on?.('chainChanged',invalidate);
  return ()=>{window.ethereum?.removeListener?.('accountsChanged',invalidate);window.ethereum?.removeListener?.('chainChanged',invalidate);};
 },[]);
 async function connect(){
  try {const [account]=await window.ethereum.request({method:'eth_requestAccounts'});await assertWallet(window.ethereum,account);setOwner(account);setMessage('Wallet connected on Shannon.');}
  catch(e){setMessage(e.message);}
 }
 async function refresh(){setSnapshot(null);setMessage('Reading Shannon…');try{setSnapshot(await readVault(window.ethereum,owner,vault));setMessage('Live vault snapshot loaded.');}catch(e){setMessage(e.shortMessage??e.message);}}
 async function execute(action,value){
  if(flight.current||pending)return;
  if(!window.confirm(action==='revoke'?'Revoke execution permanently? Recovery and withdrawal remain available.':`Sign ${action} for this vault on Shannon?`))return;
  flight.current=true;setBusy(true);setReceipt(null);setMessage('Checking ownership and simulating transaction…');
  try{
   const result=await sendOwnerAction(window.ethereum,owner,vault,action,value,hash=>{const entry={owner,vault,hash};setPending(entry);setReceipt({hash});localStorage.setItem(pendingKey,JSON.stringify(entry));setMessage('Submitted — waiting for two confirmations. Do not resubmit.');},()=>{localStorage.setItem(pendingKey,JSON.stringify({owner,vault,signing:true}));setPending({owner,vault,signing:true});});
   localStorage.removeItem(pendingKey);setPending(null);setReceipt(result);setMessage('Confirmed on Shannon.');setSnapshot(await readVault(window.ethereum,owner,vault));
  }catch(e){if(e.code==='ACTION_REJECTED'||e.code===4001){localStorage.removeItem(pendingKey);setPending(null);}setMessage(e.shortMessage??e.message);}finally{flight.current=false;setBusy(false);}
 }
 async function reconcile(){
  if(!pending?.hash){setMessage('Signing outcome unknown. Check wallet activity before any further transaction.');return;}
  setBusy(true);try{const result=await reconcileOwnerAction(window.ethereum,pending);if(!result){setMessage('Still unconfirmed. No new transaction sent.');return;}localStorage.removeItem(pendingKey);setPending(null);setReceipt(result);setMessage(result.status===1?'Confirmed on Shannon.':'Transaction reverted on-chain.');}catch(e){setMessage(e.shortMessage??e.message);}finally{setBusy(false);}
 }
 return <section className="studio" aria-label="ProofCast follower wallet" style={{margin:'1rem',padding:'1.5rem',overflowWrap:'anywhere'}}>
 <h2>Your follower vault</h2>
 <p>Shannon testnet · owner-signed actions · new funding remains disabled.</p>
 <button type="button" onClick={connect} disabled={busy}>{owner?owner:'Connect transaction wallet'}</button>
 <label style={{display:'block',marginTop:'1rem'}}>Vault address<input style={{width:'100%'}} value={vault} onChange={e=>{setVault(e.target.value);setSnapshot(null);}} disabled={busy}/></label>
 <button type="button" disabled={!owner||busy} onClick={refresh}>Refresh on-chain balance</button>
 {snapshot&&<dl><dt>Available token balance (tUSDC)</dt><dd>{snapshot.cash}</dd><dt>Open risk / realized loss (tUSDC)</dt><dd>{snapshot.risk} / {snapshot.loss}</dd><dt>Beneficiary</dt><dd>{snapshot.beneficiary}</dd><dt>Execution revoked</dt><dd>{String(snapshot.revoked)}</dd></dl>}
 <fieldset disabled={!owner||busy||!snapshot||Boolean(pending)}><legend>Owner actions</legend>
 <label>Withdraw tUSDC<input value={amount} onChange={e=>setAmount(e.target.value)} inputMode="decimal"/></label><button type="button" onClick={()=>execute('withdraw',amount)}>Withdraw to beneficiary</button>

 <button type="button" onClick={()=>execute('revoke')}>Revoke execution</button>
 <label>Market ID (bytes32)<input value={position} onChange={e=>setPosition(e.target.value)}/></label><button type="button" onClick={()=>execute('recover',position)}>Recover settled position</button>
 </fieldset>
 {pending&&<button type="button" disabled={busy} onClick={reconcile}>Check pending transaction</button>}
 <p role="status">{message}</p>{receipt&&<p>Transaction: <code>{receipt.hash}</code><br/>{receipt.block?'Confirmed block: '+receipt.block:'Confirmation not yet verified'}</p>}
 </section>;
}
