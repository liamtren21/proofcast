export function installOriginGuard(app, publicOrigin) {
  const origin = new URL(publicOrigin).origin;
  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    if ((request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({ error: 'ORIGIN_NOT_ALLOWED' });
  });
  return origin;
}
export function challengeMessage(project, origin, challenge) {
  return `${new URL(origin).host} wants you to sign in to ${project} with your Ethereum account:
${challenge.address}

Authorize a session only. This does not authorize a transaction.
URI: ${origin}
Version: 1
Chain ID: ${challenge.chainId}
Nonce: ${challenge.nonce}
Expiration Time: ${new Date(Number(challenge.expiresAt)).toISOString()}`;
}
export function sessionCookie(name, token, origin, maxAge = 86400) {
  return `${name}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`;
}
