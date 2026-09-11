import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { VaultConsole } from './VaultConsole.jsx';

async function getSessions() {
  const response = await fetch('/api/v1/sessions');
  if (!response.ok) throw new Error('Unable to load confirmed sessions');
  return (await response.json()).sessions;
}

function SessionCard({ session, address, onEnroll }) {
  return <article className="card"><p className="eyebrow">{session.status ?? 'CONFIRMED METADATA'}</p><h2>{session.title}</h2><p className="muted">Creator {session.creator}</p><p>{session.markets.length} registered market window{session.markets.length === 1 ? '' : 's'}. Enrollment and outcomes are shown only from observed records.</p><button type="button" onClick={() => { window.location.href = `/sessions/${encodeURIComponent(session.id)}`; }}>View session</button><p className="muted">New enrollment is unavailable until the current-market deployment is verified.</p></article>;
}

function App() {
  const detailId = window.location.pathname.startsWith('/sessions/') ? decodeURIComponent(window.location.pathname.slice('/sessions/'.length)) : null;
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState('');
  const [address, setAddress] = useState(null);
  const [authError, setAuthError] = useState('');
  const [draftMessage, setDraftMessage] = useState('');
  const [enrollMessage, setEnrollMessage] = useState('');
  const [indexer, setIndexer] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState('');
  const [drafts, setDrafts] = useState([]);
  useEffect(() => {
    if (!address) { setDrafts([]); return; }
    fetch('/api/v1/session-drafts', { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('Unable to load drafts'); return r.json(); }).then(r => setDrafts(r.sessions)).catch(e => setDraftMessage(e.message));
  }, [address]);
  useEffect(() => { getSessions().then(setSessions).catch((reason) => setError(reason.message)); fetch('/api/v1/auth/session', { credentials: 'include' }).then((response) => response.ok ? response.json() : null).then((session) => session && setAddress(session.address)); fetch('/api/v1/indexer/status').then((response) => response.json()).then(setIndexer).catch(() => setIndexer(null)); }, []);
  useEffect(() => { if (detailId) fetch(`/api/v1/sessions/${encodeURIComponent(detailId)}`).then((response) => { if (!response.ok) throw new Error(response.status === 404 ? 'Session not found' : 'Session unavailable'); return response.json(); }).then(setDetail).catch(e => setDetailError(e.message)); }, [detailId]);
  async function connectWallet() {
    setAuthError('');
    try {
      if (!window.ethereum) throw new Error('Install an EVM wallet to sign in.');
      const [wallet] = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const challenge = await fetch('/api/v1/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: wallet, chainId: 50312 }) }).then((response) => response.json());
      const signature = await window.ethereum.request({ method: 'personal_sign', params: [challenge.message, wallet] });
      const verified = await fetch('/api/v1/auth/verify', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, signature }) }).then((response) => response.json());
      if (!verified.address) throw new Error(verified.error ?? 'Wallet verification failed.');
      setAddress(verified.address);
    } catch (cause) { setAuthError(cause.message); }
  }
  async function logout() { await fetch('/api/v1/auth/session', { method: 'DELETE', credentials: 'include' }); setAddress(null); }
  async function createDraft(event) {
    event.preventDefault(); setDraftMessage('');
    if (!address) { setDraftMessage('Connect wallet before saving a creator session.'); return; }
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = { id: `session-${Date.now()}`, creator: address, title: form.get('title'), strategy: form.get('strategy'), terms: form.get('terms'), strategyVersion: 'v1', markets: [{ marketId: form.get('marketId'), generation: '1' }], enrollUntilSec: Math.floor(Date.now() / 1000) + 3600, sessionUntilSec: Math.floor(Date.now() / 1000) + 86400 };
    const response = await fetch('/api/v1/session-drafts', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) { setDraftMessage(result.error ?? 'Unable to save draft'); return; }
    setDraftMessage(`Draft saved: ${result.session.id}`); formElement.reset(); setDrafts(current => [...current, result.session]);
  }
  async function enroll(session) {
    setEnrollMessage('');
    const response = await fetch(`/api/v1/sessions/${encodeURIComponent(session.id)}/enrollments`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enrollmentId: `enroll-${Date.now()}`, vault: address, allowedSideMask: ['YES'], maxYesPrice: '500000', maxNoPrice: '0', maxCostPerOrder: '1000000', totalRiskBudget: '2000000', validUntil: Math.floor(Date.now() / 1000) + 3600 }) });
    const result = await response.json();
    setEnrollMessage(response.ok ? `Enrollment recorded for ${session.title}.` : (result.error ?? 'Enrollment failed'));
  }
  if (detailId) return <><header><a className="brand" href="/">PROOFCAST</a><nav><a href="/">Explore</a><a href="#ledger">Proof ledger</a></nav><button className="wallet" type="button" onClick={address ? logout : connectWallet}>{address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Connect wallet'}</button></header><main><section className="hero"><p className="eyebrow">Session evidence</p><h1>{detail?.session?.title ?? (detailError || 'Loading session…')}</h1><p className="lede">A public timeline of authorization, enrollment, signals and observed outcomes.</p></section><section id="ledger" className="studio"><div className="section-title"><h2>Timeline</h2><span className="muted">observed records only</span></div>{detail?.timeline?.map((entry, index) => <div className="notice" key={`${entry.kind}-${entry.enrollmentId ?? entry.signalId ?? index}`}><strong>{entry.kind}</strong><br/>{entry.status ? `Status: ${entry.status}` : ''}{entry.side ? ` · Side: ${entry.side}` : ''}{entry.follower ? ` · Follower: ${entry.follower}` : ''}</div>) ?? <div className="empty">{detailError ? 'No public evidence is available for this session.' : 'Loading evidence…'}</div>}</section><section className="studio"><div className="section-title"><h2>Execution boundary</h2><span className="muted">fail-closed</span></div><div className="notice">Native execution, fill and settlement are shown only after independent chain observation. No client claim can mark this session executed.</div></section></main><footer><a href="/">Back to ProofCast</a></footer></>;
  return <><header><a className="brand" href="/">PROOFCAST</a><nav><a href="/">Explore</a><a href="/me">My sessions</a><a href="#studio">Creator studio</a></nav><button className="wallet" type="button" onClick={address ? logout : connectWallet}>{address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Connect wallet'}</button></header><main><section className="hero"><p className="eyebrow">A complete record, not a highlight reel</p><h1>Follow the plan.<br/>See every outcome.</h1><p className="lede">Register before a creator’s signal, set your own limits, and inspect the full timeline — including windows with no trade.</p>{authError && <div className="notice">{authError}</div>}{enrollMessage && <div className="notice">{enrollMessage}</div>}</section><section className="steps"><span><b>01</b> Choose a session</span><span><b>02</b> Set your limits</span><span><b>03</b> Follow &amp; verify</span></section><section id="studio" className="studio"><div className="section-title"><h2>Creator studio</h2><span className="muted">draft only · no native execution</span></div><form onSubmit={createDraft} className="studio-form"><label>Session title<input name="title" required placeholder="ETH range thesis"/></label><label>Market ID<input name="marketId" required placeholder="market-2026-01"/></label><label>Strategy<textarea name="strategy" required placeholder="Describe the plan before publishing signals."/></label><label>Terms<textarea name="terms" required placeholder="Explain limits, timing and risks."/></label><button type="submit">Save session draft</button></form>{draftMessage && <div className="notice" role="status">{draftMessage}</div>}{address && <div><h3>My private drafts</h3>{drafts.length === 0 ? <p>No saved drafts yet.</p> : drafts.map(draft => <article className="notice" key={draft.id}><strong>{draft.title}</strong><p>{draft.strategy}</p><small>Private draft · not anchored on-chain · {draft.id}</small></article>)}</div>}</section><section><div className="section-title"><h2>Open sessions</h2><span className="muted">confirmed API data</span></div>{error && <div className="notice">{error}</div>}{sessions?.length === 0 && <div className="empty">No confirmed sessions yet. A creator can start one in Creator studio.</div>}<div className="grid">{sessions?.map((session) => <SessionCard key={session.id} session={session} address={address} onEnroll={enroll}/>)}</div>{sessions === null && !error && <div className="empty">Loading confirmed sessions…</div>}</section><section className="studio"><div className="section-title"><h2>Proof ledger</h2><span className="muted">chain observation status</span></div><div className="notice"><strong>Indexer {indexer?.healthy ? 'caught up' : 'not ready'}</strong><br/>Cursor: {indexer?.cursor ? `${indexer.cursor.block} · ${indexer.cursor.hash.slice(0, 10)}…` : 'not available'}<br/>Observed events: {indexer?.eventCount ?? '—'}<br/>Native execution: {indexer?.executionEnabled ? 'enabled' : 'fail-closed'}</div></section></main><footer>ProofCast keeps enrollment, execution, settlement, and unavailable observations distinct. Sponsor trial: OFF.</footer></>;
}
createRoot(document.getElementById('root')).render(<><VaultConsole /><App /></>);
