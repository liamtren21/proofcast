import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { buildApp } from '../apps/api/src/app.js';
import { MemoryStore } from '../apps/api/src/store.js';

export const origin = 'http://localhost:43121';
export async function signIn(app, wallet = Wallet.createRandom()) {
  const challenge = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge', headers: { origin }, payload: { address: wallet.address, chainId: 50312 } });
  assert.equal(challenge.statusCode, 200);
  const data = challenge.json();
  const signature = await wallet.signMessage(data.message);
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/verify', headers: { origin }, payload: { challengeId: data.challengeId, signature } });
  assert.equal(response.statusCode, 200);
  return { wallet, cookie: response.headers['set-cookie'].split(';')[0], data, signature };
}
export function draft(wallet, id = 'test-session') {
  const now = Math.floor(Date.now() / 1000);
  return { id, creator: wallet.address, title: 'A real draft', strategy: 'Observe before acting.', terms: 'Limits require chain confirmation.', strategyVersion: 'v1', markets: [{ marketId: '0x' + 'ab'.repeat(32), generation: '1', decisionCutoffSec: now + 7200, expirySec: now + 10800 }], enrollUntilSec: now + 3600, sessionUntilSec: now + 14400 };
}

test('actor header never authenticates and a public session lookup never reads auth tokens', async t => {
  const store = new MemoryStore();
  const app = await buildApp({ store, publicOrigin: origin }); t.after(() => app.close());
  const wallet = Wallet.createRandom();
  const denied = await app.inject({ method: 'POST', url: '/api/v1/session-drafts', headers: { 'x-proofcast-actor': wallet.address }, payload: draft(wallet) });
  assert.equal(denied.statusCode, 401);
  const auth = await signIn(app, wallet);
  const token = auth.cookie.split('=')[1];
  const publicResponse = await app.inject(`/api/v1/sessions/${token}`);
  assert.equal(publicResponse.statusCode, 404);
  assert.ok(!publicResponse.body.includes(token));
  assert.equal((await app.inject({ url: '/api/v1/me/enrollments', headers: { 'x-proofcast-actor': wallet.address } })).statusCode, 401);
});

test('signed challenge binds domain, URI, address and chain; replay and cross-origin mutations fail', async t => {
  const app = await buildApp({ store: new MemoryStore(), publicOrigin: origin }); t.after(() => app.close());
  const { wallet, cookie, data, signature } = await signIn(app);
  assert.ok(data.message.includes(origin));
  assert.ok(data.message.toLowerCase().includes(wallet.address.toLowerCase()));
  assert.match(data.message, /Chain ID: 50312/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/verify', headers: { origin }, payload: { challengeId: data.challengeId, signature } })).statusCode, 401);
  const refused = await app.inject({ method: 'POST', url: '/api/v1/session-drafts', headers: { cookie, origin: 'https://attacker.invalid' }, payload: draft(wallet) });
  assert.equal(refused.statusCode, 403);
  const logout = await app.inject({ method: 'DELETE', url: '/api/v1/auth/session', headers: { cookie, origin } });
  assert.equal(logout.statusCode, 204);
  assert.match(logout.headers['set-cookie'], /Max-Age=0/);
  assert.equal((await app.inject({ url: '/api/v1/auth/session', headers: { cookie } })).statusCode, 401);
});

test('creator drafts remain private and cannot overwrite another creator or claim confirmation', async t => {
  const store = new MemoryStore();
  const app = await buildApp({ store, publicOrigin: origin }); t.after(() => app.close());
  const a = await signIn(app); const b = await signIn(app);
  const create = await app.inject({ method: 'POST', url: '/api/v1/session-drafts', headers: { cookie: a.cookie, origin }, payload: draft(a.wallet) });
  assert.equal(create.statusCode, 201);
  assert.equal(create.json().session.status, 'DRAFT');
  assert.deepEqual((await app.inject('/api/v1/sessions')).json().sessions, []);
  assert.equal((await app.inject('/api/v1/sessions/test-session')).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/v1/session-drafts/test-session', headers: { cookie: b.cookie } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/session-drafts', headers: { cookie: b.cookie, origin }, payload: draft(b.wallet) })).statusCode, 409);
  const forged = await app.inject({ method: 'POST', url: '/api/v1/session-drafts', headers: { cookie: a.cookie, origin }, payload: { ...draft(a.wallet, 'forged'), status: 'CONFIRMED', token: 'private' } });
  assert.equal(forged.statusCode, 400);
});

test('internal database errors are redacted and readiness does not invent worker health', async t => {
  const app = await buildApp({ store: { health: async () => { throw new Error('postgres://secret@host/db'); }, listSessions: async () => { throw new Error('postgres://secret@host/db'); } } }); t.after(() => app.close());
  const failed = await app.inject('/api/v1/sessions');
  assert.equal(failed.statusCode, 503);
  assert.ok(!failed.body.includes('secret'));
  const ready = await app.inject('/api/v1/ready');
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json().dependencies.indexer, false);
});
