import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: dirname(fileURLToPath(import.meta.url)), plugins: [react()], server: { port: 3120, proxy: { '/api': 'http://127.0.0.1:3121' } } });
