import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const [file, command] of [
  ['Dockerfile.api', 'node scripts/migrate.mjs && exec node apps/api/src/server.js'],
  ['Dockerfile.worker', 'exec node apps/worker/src/main.js'],
  ['Dockerfile.executor', 'exec node apps/worker/src/executor-main.js'],
]) {
  test(`${file} runs only its Railway service process`, async () => {
    const source = await readFile(file, 'utf8');
    assert.match(source, /FROM node:24-alpine/);
    assert.match(source, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(source, /vite build/);
  });
}
