import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('worker health server binds all interfaces for Railway ingress', async () => {
  const source = await readFile('apps/worker/src/main.js', 'utf8');
  assert.match(source, /\.listen\(Number\(process\.env\.WORKER_HEALTH_PORT\?\?9120\),'0\.0\.0\.0'\)/);
});

test('executor health server binds all interfaces for Railway ingress', async () => {
  const source = await readFile('apps/worker/src/executor-main.js', 'utf8');
  assert.match(source, /server\.listen\(port,'0\.0\.0\.0',resolve\)/);
});
