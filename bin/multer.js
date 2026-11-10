#!/usr/bin/env node
// Prefere o build minificado; sem ele (durante o desenvolvimento) roda o TypeScript direto.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const build = join(aqui, '..', 'dist', 'multer.min.js');

if (existsSync(build)) await import(build);
else await import('../src/cli.ts');
