// Processos em segundo plano, como um bot do Discord ou um servidor, que continuam
// rodando enquanto o Multer está aberto.

import { type ChildProcess, spawn } from 'node:child_process';
import { getSecrets } from '../auth/secrets.ts';
import type { ToolOutcome } from '../types.ts';
import { commandEnv } from './local.ts';

const NAME = /^[a-z0-9_-]{1,30}$/i;
const MAX_LOG_CHARS = 40_000;
const START_CHECK_MS = 2000;
const STOP_GRACE_MS = 3000;
const MIN_REDACT_LENGTH = 4;

interface Managed {
  name: string;
  command: string;
  child: ChildProcess;
  logs: string;
  exitCode: number | null;
  running: boolean;
  startedAt: number;
  secrets: string[];
}

export interface ProcessInfo {
  name: string;
  command: string;
  running: boolean;
  exitCode: number | null;
  seconds: number;
}

const fail = (message: string, content = message): ToolOutcome => ({ ok: false, summary: message, content });
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ProcessManager {
  private readonly root: string;
  private readonly procs = new Map<string, Managed>();

  constructor(root: string) {
    this.root = root;
  }

  list(): ProcessInfo[] {
    return [...this.procs.values()].map((item) => ({
      name: item.name,
      command: item.command,
      running: item.running,
      exitCode: item.exitCode,
      seconds: Math.round((Date.now() - item.startedAt) / 1000),
    }));
  }

  async start(name: string, command: string, envNames: string[]): Promise<ToolOutcome> {
    if (!NAME.test(name)) return fail('Nome inválido: use letras, números, - e _ (até 30).');
    if (this.procs.get(name)?.running) return fail(`${name} já está rodando. Use stop_process antes.`);
    const secrets = getSecrets(envNames);
    const entry = {
      name, command, logs: '', exitCode: null, running: true, startedAt: Date.now(), secrets: Object.values(secrets),
    } as Omit<Managed, 'child'> as Managed;
    entry.child = spawn('sh', ['-c', command], {
      cwd: this.root,
      env: { ...commandEnv(), ...secrets },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const collect = (chunk: Buffer) => this.append(entry, chunk.toString());
    entry.child.stdout?.on('data', collect);
    entry.child.stderr?.on('data', collect);
    entry.child.on('error', (err) => {
      entry.running = false;
      this.append(entry, `Erro: ${err.message}\n`);
    });
    entry.child.on('close', (code) => {
      entry.running = false;
      entry.exitCode = code ?? -1;
    });
    this.procs.set(name, entry);
    // Um bot com token errado ou código quebrado morre nos primeiros segundos.
    await wait(START_CHECK_MS);
    const tail = this.tail(entry, 15) || '(sem saída)';
    if (!entry.running) return fail(`${name} terminou logo ao iniciar (código ${entry.exitCode})`, tail);
    return { ok: true, summary: `${name} rodando em segundo plano`, content: `Rodando. Últimas linhas:\n${tail}` };
  }

  logs(name: string, lines = 40): ToolOutcome {
    const entry = this.procs.get(name);
    if (!entry) return fail(`Não há processo ${name}.${this.hint()}`);
    const state = entry.running ? 'rodando' : `terminou (código ${entry.exitCode})`;
    return { ok: true, summary: `${name}: ${state}`, content: this.tail(entry, Math.min(Math.max(lines, 1), 200)) || '(sem saída)' };
  }

  async stop(name: string): Promise<ToolOutcome> {
    const entry = this.procs.get(name);
    if (!entry) return fail(`Não há processo ${name}.${this.hint()}`);
    if (!entry.running) return { ok: true, summary: `${name} já tinha terminado`, content: `Código ${entry.exitCode}.` };
    this.signal(entry, 'SIGTERM');
    for (let waited = 0; entry.running && waited < STOP_GRACE_MS; waited += 100) await wait(100);
    if (entry.running) this.signal(entry, 'SIGKILL');
    return { ok: true, summary: `${name} parado`, content: 'Parado.' };
  }

  /** Ao fechar o Multer nada fica rodando sozinho. */
  killAll(): void {
    for (const entry of this.procs.values()) if (entry.running) this.signal(entry, 'SIGTERM');
  }

  private hint(): string {
    const names = [...this.procs.keys()];
    return names.length ? ` Existem: ${names.join(', ')}.` : ' Nenhum foi iniciado.';
  }

  private signal(entry: Managed, signal: NodeJS.Signals): void {
    try {
      if (entry.child.pid) process.kill(-entry.child.pid, signal);
    } catch {
      // já terminou
    }
  }

  private append(entry: Managed, text: string): void {
    entry.logs += text;
    if (entry.logs.length > MAX_LOG_CHARS) entry.logs = entry.logs.slice(-MAX_LOG_CHARS / 2);
  }

  /** O token do bot pode aparecer nos logs: nunca volta para o modelo nem para a tela. */
  private tail(entry: Managed, lines: number): string {
    let text = entry.logs.split('\n').slice(-lines - 1).join('\n').trim();
    for (const secret of entry.secrets) {
      if (secret.length >= MIN_REDACT_LENGTH) text = text.replaceAll(secret, '***');
    }
    return text;
  }
}
