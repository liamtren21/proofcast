import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Vercel proxies API calls to the public Railway API before SPA fallback', async () => {
  const config = JSON.parse(await readFile('vercel.json', 'utf8'));
  assert.deepEqual(config.rewrites[0], {
    source: '/api/(.*)',
    destination: 'https://api-production-a54b.up.railway.app/api/$1',
  });
});
