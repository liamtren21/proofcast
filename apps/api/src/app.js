import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import crypto from 'node:crypto';
import { verifyMessage } from 'ethers';
import { installOriginGuard, challengeMessage, sessionCookie } from './auth.js';
import { canonicalizeContent, hashContent } from '../../../packages/protocol/src/content.js';

const addressPattern = /^0x[0-9a-fA-F]{40}$/;

async function actor(request, store) {
  const token = request.cookies?.proofcast_session;
  if (token) {
    const session = await store.getSession(token);
    if (session) return session.address;
  }
  const error = new Error('AUTH_REQUIRED');
  error.statusCode = 401;
  throw error;
}

export async function buildApp({ store, lifecycleReader, now = () => Math.floor(Date.now() / 1000), publicOrigin = process.env.PUBLIC_ORIGIN ?? 'http://localhost:3120' }) {
  if (!store || typeof store.health !== 'function') throw new Error('PERSISTENT_STORE_REQUIRED');
  const app = Fastify({ logger: false });
  const origin = installOriginGuard(app, publicOrigin);
  await app.register(cookie);
  app.setErrorHandler((error, request, reply) => {
    const clientError = error.statusCode >= 400 && error.statusCode < 500;
    return reply.code(clientError ? error.statusCode : 503).send({ error: error.message === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : clientError ? 'INVALID_REQUEST' : 'SERVICE_UNAVAILABLE' });
  });

  app.get('/api/v1/health', async () => ({ ok: true, service: 'proofcast-api', observedAt: now() }));
  let lifecycleFlight;
  app.get('/api/v1/evidence/lifecycle', async (_request, reply) => {
    reply.header('cache-control','no-store');
    if(!lifecycleReader)return reply.code(503).send({error:'LIFECYCLE_VERIFIER_UNAVAILABLE'});
    lifecycleFlight ??= Promise.resolve().then(lifecycleReader).finally(()=>{lifecycleFlight=null;});
    try{return await lifecycleFlight;}catch{return reply.code(503).send({error:'LIFECYCLE_VERIFICATION_UNAVAILABLE'});}
  });
  app.get('/api/v1/ready', async (_request, reply) => {
    const db = await store.health().catch(() => ({ db: false }));
    const ready = db?.db === true;
    const worker = await store.workerHealth?.().catch(() => ({ worker: false })) ?? { worker: false };
    const allReady = ready && worker.worker === true;
    return reply.code(allReady ? 200 : 503).send({ ready: allReady, dependencies: { db: ready, chain: false, indexer: worker.worker === true, executor: false }, sponsor: false });
  });
  app.get('/api/v1/capabilities', async () => ({ sponsor: false, funding: false, nativeVerified: false, chainId: 50312 }));
  app.get('/api/v1/indexer/status', async () => {
    const status = await store.indexerStatus?.() ?? { cursor: null, eventCount: 0, executionEnabled: false };
    const health = await store.workerHealth?.().catch(() => ({ worker: false })) ?? { worker: false };
    return { ...status, healthy: health.worker === true };
  });
  app.post('/api/v1/auth/challenge', async (request, reply) => {
    const { address, chainId } = request.body ?? {};
    if (!addressPattern.test(address ?? '') || chainId !== 50312) return reply.code(400).send({ error: 'INVALID_WALLET' });
    const challengeId = crypto.randomUUID();
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 5 * 60 * 1000;
    await store.createChallenge({ id: challengeId, address: address.toLowerCase(), chainId, nonce, expiresAt });
    return { challengeId, message: challengeMessage('ProofCast', origin, { address: address.toLowerCase(), chainId, nonce, expiresAt }), expiresAt };
  });
  app.post('/api/v1/auth/verify', async (request, reply) => {
    const { challengeId, signature } = request.body ?? {};
    const challenge = await store.getChallenge(challengeId);
    if (!challenge || challenge.consumed || challenge.expiresAt <= Date.now()) return reply.code(401).send({ error: 'CHALLENGE_INVALID' });
    let recovered;
    try { recovered = verifyMessage(challengeMessage('ProofCast', origin, challenge), signature); } catch { return reply.code(401).send({ error: 'SIGNATURE_INVALID' }); }
    if (recovered.toLowerCase() !== challenge.address.toLowerCase()) return reply.code(401).send({ error: 'SIGNER_MISMATCH' });
    if (!await store.consumeChallenge(challengeId)) return reply.code(401).send({ error: 'CHALLENGE_REPLAYED' });
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    await store.createSession({ token, address: recovered.toLowerCase(), expiresAt });
    reply.header('set-cookie', sessionCookie('proofcast_session', token, origin));
    return { address: recovered, expiresAt };
  });
  app.get('/api/v1/auth/session', async (request, reply) => {
    const session = request.cookies?.proofcast_session ? await store.getSession(request.cookies.proofcast_session) : null;
    if (!session) return reply.code(401).send({ error: 'SESSION_INVALID' });
    return { address: session.address, expiresAt: Number(session.expiresAt) };
  });
  app.delete('/api/v1/auth/session', async (request, reply) => {
    if (request.cookies?.proofcast_session) await store.deleteSession(request.cookies.proofcast_session);
    reply.header('set-cookie', sessionCookie('proofcast_session', '', origin, 0));
    return reply.code(204).send();
  });
  app.get('/api/v1/sessions', async () => ({ sessions: (await store.listSessions()).filter(s => s.status === 'CONFIRMED') }));
  app.get('/api/v1/session-drafts', async request => ({ sessions: await store.listDrafts(await actor(request, store)) }));
  app.get('/api/v1/session-drafts/:id', async (request, reply) => {
    const creator = await actor(request, store);
    const session = await store.getSessionData(request.params.id);
    if (!session || session.status !== 'DRAFT' || session.creator.toLowerCase() !== creator.toLowerCase()) return reply.code(404).send({ error: 'DRAFT_NOT_FOUND' });
    return { session };
  });
  app.get('/api/v1/me/enrollments', async request => ({ enrollments: await store.listEnrollments(await actor(request, store)) }));
  app.get('/api/v1/sessions/:id', async (request, reply) => {
    const session = await store.getSessionData(request.params.id);
    if (!session || session.status !== 'CONFIRMED') return reply.code(404).send({ error: 'SESSION_NOT_FOUND' });
    const timeline = [
      { kind: 'SESSION_CREATED', at: session.createdAt ?? null, status: session.status ?? 'DRAFT' },
      ...(session.enrollments ?? []).map((entry) => ({ kind: 'ENROLLMENT', at: entry.createdAt ?? null, enrollmentId: entry.enrollmentId, follower: entry.follower, revoked: Boolean(entry.revoked) })),
      ...(session.signals ?? []).map((entry) => ({ kind: 'SIGNAL', at: entry.createdAt ?? null, signalId: entry.signalId, side: entry.side, status: entry.status ?? 'PUBLISHED' })),
    ];
    return { session, timeline };
  });
  app.post('/api/v1/session-drafts', async (request, reply) => {
    const creator = await actor(request, store);
    const body = request.body ?? {};
    const allowed = new Set(['id', 'creator', 'title', 'strategy', 'terms', 'strategyVersion', 'markets', 'enrollUntilSec', 'sessionUntilSec']);
    if (Object.keys(body).some(key => !allowed.has(key))) return reply.code(400).send({ error: 'INVALID_SESSION_DRAFT' });
    if (typeof body.creator !== 'string' || body.creator.toLowerCase() !== creator.toLowerCase() || !body.id || !body.title || !Array.isArray(body.markets)) return reply.code(400).send({ error: 'INVALID_SESSION_DRAFT' });
    const session = { ...body, creator, withdrawn: false, status: 'DRAFT', createdAt: now() };
    if (!await store.saveDraft(session)) return reply.code(409).send({ error: 'SESSION_ID_CONFLICT' });
    return reply.code(201).send({ session });
  });
  app.post('/api/v1/sessions/:id/enrollments', async (request, reply) => {
    const follower = await actor(request, store);
    const session = await store.getSessionData(request.params.id);
    const body = request.body ?? {};
    if (!session || session.status !== 'CONFIRMED') return reply.code(404).send({ error: 'SESSION_NOT_FOUND' });
    if (session.withdrawn || session.signals?.length > 0 || now() >= session.enrollUntilSec) return reply.code(409).send({ error: 'ENROLLMENT_CLOSED' });
    if (!body.enrollmentId || !body.vault || !Array.isArray(body.allowedSideMask) || body.allowedSideMask.length === 0 || !body.totalRiskBudget || !body.validUntil) return reply.code(400).send({ error: 'INVALID_ENROLLMENT' });
    if ((session.enrollments ?? []).some((entry) => entry.enrollmentId === body.enrollmentId)) return reply.code(409).send({ error: 'ENROLLMENT_ALREADY_EXISTS' });
    const enrollment = { ...body, follower, revoked: false, createdAt: now() };
    await store.saveSession({ ...session, enrollments: [...(session.enrollments ?? []), enrollment] });
    return reply.code(201).send({ enrollment });
  });
  app.post('/api/v1/content', async (request, reply) => {
    let canonical;
    try { canonical = canonicalizeContent(request.body); } catch (error) { return reply.code(400).send({ error: error.message }); }
    const content = { hash: await hashContent(request.body), canonical, confirmed: false, createdAt: now() };
    const saved = await store.saveContent(content);
    return reply.code(201).send(saved);
  });
  app.get('/api/v1/content/:hash', async (request, reply) => {
    const content = await store.getContent(request.params.hash);
    if (!content) return reply.code(404).send({ error: 'CONTENT_NOT_FOUND' });
    return content;
  });
  app.post('/api/v1/transactions', async (request, reply) => {
    if (request.body?.executed !== undefined || request.body?.confirmed !== undefined) return reply.code(400).send({ error: 'CLIENT_STATUS_NOT_ACCEPTED' });
    return reply.code(501).send({ error: 'TRANSACTION_TRACKING_NOT_CONFIGURED' });
  });
  return app;
}
