import fs from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = await fs.readFile(new URL('../apps/api/migrations/001_core.sql', import.meta.url), 'utf8');
await pool.query(sql);
await pool.end();
console.log('ProofCast database migrated');
