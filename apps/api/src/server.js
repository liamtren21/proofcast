import { buildApp } from './app.js';
import { createPgStore } from './store.js';
import { inspectLifecycle } from '../../../scripts/verify-lifecycle.mjs';

const app = await buildApp({ store: createPgStore(process.env.DATABASE_URL), lifecycleReader:inspectLifecycle });
await app.listen({ port: Number(process.env.PORT ?? 3121), host: process.env.HOST ?? '127.0.0.1' });
