// Atualização pelo próprio Multer, sem repetir a linha de instalação.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'lexersonly/multer-android';
const CHECK_TIMEOUT_MS = 6000;

const rawBase = () => process.env.MULTER_UPDATE_URL || `https://raw.githubusercontent.com/${REPO}/main`;

export function localVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 0.10.0 é mais novo que 0.9.0: compara número a número. */
export function isNewer(remote: string, local: string): boolean {
  const a = remote.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = local.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export interface UpdateCheck {
  current: string;
  latest: string;
  available: boolean;
}

/** Devolve null sem internet: avisar de atualização nunca atrapalha o uso. */
export async function checkForUpdate(): Promise<UpdateCheck | null> {
  try {
    const response = await fetch(`${rawBase()}/package.json`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!response.ok) return null;
    const latest = ((await response.json()) as { version?: string }).version;
    if (!latest) return null;
    const current = localVersion();
    return { current, latest, available: isNewer(latest, current) };
  } catch {
    return null;
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      output = (output + text).slice(-4000);
      for (const line of text.split('\n')) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => resolve({ code: -1, output: err.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, output }));
  });
}

/** Instalação por git atualiza com pull; a por download, com o bootstrap, que troca a pasta inteira. */
export async function runUpdate(onLine: (line: string) => void = () => {}): Promise<{ ok: boolean; output: string }> {
  const env = { ...process.env, MULTER_DIR: ROOT };
  if (existsSync(join(ROOT, '.git'))) {
    const pull = await run('git', ['pull', '--ff-only'], env, onLine);
    if (pull.code !== 0) return { ok: false, output: pull.output };
    const install = await run('bash', [join(ROOT, 'install.sh')], env, onLine);
    return { ok: install.code === 0, output: install.output };
  }
  const script = join(ROOT, 'bootstrap.sh');
  if (!existsSync(script)) return { ok: false, output: 'Não achei o bootstrap.sh. Rode a linha de instalação do README.' };
  const result = await run('bash', [script], env, onLine);
  return { ok: result.code === 0, output: result.output };
}
