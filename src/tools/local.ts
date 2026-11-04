// Ferramentas de arquivo, busca e comando, sempre presas à pasta do projeto.

import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ToolArgs, ToolOutcome } from '../types.ts';
import { SENSITIVE } from './specs.ts';

const MAX_READ_LINES = 400;
const MAX_FILE_BYTES = 2_000_000;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_HITS = 60;
const DEFAULT_COMMAND_SECONDS = 120;
const MAX_COMMAND_SECONDS = 600;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '__pycache__', '.venv']);

const clip = (text: string, max = MAX_OUTPUT_CHARS) =>
  text.length <= max ? text : `${text.slice(0, Math.floor(max * 0.6))}\n[... cortado ...]\n${text.slice(-Math.floor(max * 0.4))}`;

const ok = (summary: string, content = summary): ToolOutcome => ({ ok: true, summary, content });
const fail = (message: string): ToolOutcome => ({ ok: false, summary: message, content: message });

/** Resolve dentro do projeto. Link simbólico que aponta para fora também é recusado. */
async function safePath(root: string, input: unknown, { mustExist = true } = {}): Promise<string> {
  if (typeof input !== 'string' || !input.trim()) throw new Error('O campo path é obrigatório.');
  const base = await realpath(root);
  const target = resolve(base, input);
  const inside = (path: string) => path === base || path.startsWith(base + sep);
  if (!inside(target)) throw new Error(`${input} está fora da pasta do projeto.`);
  if (SENSITIVE.test(relative(base, target))) throw new Error(`${input} parece guardar credenciais: não mexo nele.`);
  let existing = target;
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing) throw err;
      if (mustExist && existing === target) throw new Error(`${input} não existe.`);
      existing = dirname(existing);
    }
  }
  if (!inside(existing)) throw new Error(`${input} aponta para fora da pasta do projeto.`);
  return target;
}

async function readFileTool(root: string, args: ToolArgs): Promise<ToolOutcome> {
  const path = await safePath(root, args.path);
  const info = await stat(path);
  if (info.isDirectory()) return fail(`${String(args.path)} é uma pasta. Use list_files.`);
  if (info.size > MAX_FILE_BYTES) return fail(`${String(args.path)} tem ${info.size} bytes: grande demais.`);
  const buffer = await readFile(path);
  if (buffer.subarray(0, 4096).includes(0)) return fail(`${String(args.path)} é um arquivo binário.`);
  const lines = buffer.toString('utf8').split('\n');
  const offset = Math.max(0, Number(args.offset) || 0);
  const limit = Math.min(Number(args.limit) || MAX_READ_LINES, MAX_READ_LINES);
  const part = lines.slice(offset, offset + limit);
  const more = offset + limit < lines.length ? `\n[... mais ${lines.length - offset - limit} linhas; use offset ${offset + limit}]` : '';
  return ok(`Leu ${String(args.path)} (${part.length} linhas)`, clip(part.join('\n')) + more);
}

async function writeFileTool(root: string, args: ToolArgs, mode: 'write' | 'append'): Promise<ToolOutcome> {
  if (typeof args.content !== 'string') return fail('O campo content é obrigatório.');
  const path = await safePath(root, args.path, { mustExist: false });
  await mkdir(dirname(path), { recursive: true });
  if (mode === 'append') await appendFile(path, args.content);
  else await writeFile(path, args.content);
  const lines = args.content.split('\n').length;
  return ok(`${mode === 'append' ? 'Acrescentou' : 'Gravou'} ${lines} linhas em ${String(args.path)}`);
}

async function editFileTool(root: string, args: ToolArgs): Promise<ToolOutcome> {
  const path = await safePath(root, args.path);
  const oldText = args.old ?? args.old_text ?? args.old_string;
  const newText = args.new ?? args.new_text ?? args.new_string;
  if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') return fail('Os campos old e new são obrigatórios.');
  const content = await readFile(path, 'utf8');
  const count = content.split(oldText).length - 1;
  if (count === 0) return fail(`O trecho não existe em ${String(args.path)}. Leia o arquivo de novo e copie o texto exato.`);
  if (count > 1) return fail(`O trecho aparece ${count} vezes em ${String(args.path)}. Inclua mais contexto para ficar único.`);
  await writeFile(path, content.replace(oldText, () => newText));
  return ok(`Editou ${String(args.path)}`);
}

async function listFilesTool(root: string, args: ToolArgs): Promise<ToolOutcome> {
  const base = await safePath(root, args.path || '.');
  const depth = Math.min(Math.max(Number(args.depth) || 2, 1), 6);
  const entries: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (entries.length >= MAX_LIST_ENTRIES) return;
      if (item.isDirectory() && SKIP_DIRS.has(item.name)) continue;
      const path = join(dir, item.name);
      entries.push(relative(base, path) + (item.isDirectory() ? '/' : ''));
      if (item.isDirectory() && level < depth) await walk(path, level + 1);
    }
  };
  await walk(base, 1);
  return ok(`${entries.length} entrada(s) em ${String(args.path || '.')}`, entries.join('\n') || '(pasta vazia)');
}

async function searchCodeTool(root: string, args: ToolArgs): Promise<ToolOutcome> {
  const query = String(args.query ?? '').trim();
  if (!query) return fail('O campo query é obrigatório.');
  const base = await safePath(root, args.path || '.');
  const needle = query.toLowerCase();
  const hits: string[] = [];
  const visit = async (path: string): Promise<void> => {
    if (hits.length >= MAX_SEARCH_HITS) return;
    const info = await stat(path).catch(() => null);
    if (!info) return;
    if (info.isDirectory()) {
      for (const item of await readdir(path).catch(() => [] as string[])) {
        if (!SKIP_DIRS.has(item)) await visit(join(path, item));
      }
      return;
    }
    if (info.size > MAX_FILE_BYTES || SENSITIVE.test(relative(base, path))) return;
    const buffer = await readFile(path).catch(() => null);
    if (!buffer || buffer.subarray(0, 4096).includes(0)) return;
    buffer.toString('utf8').split('\n').forEach((line, index) => {
      if (hits.length < MAX_SEARCH_HITS && line.toLowerCase().includes(needle)) {
        hits.push(`${relative(root, path) || path}:${index + 1}: ${line.trim().slice(0, 160)}`);
      }
    });
  };
  await visit(base);
  return ok(`${hits.length} resultado(s) para "${query}"`, hits.join('\n') || 'Nada encontrado.');
}

/** Variáveis de login não vão para os comandos que os agentes rodam. */
export function commandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === 'POLLINATIONS_API_KEY' || name.startsWith('MULTER_')) delete env[name];
  }
  return env;
}

function runCommandTool(root: string, args: ToolArgs, signal?: AbortSignal): Promise<ToolOutcome> {
  const command = String(args.command ?? '').trim();
  if (!command) return Promise.resolve(fail('O campo command é obrigatório.'));
  const seconds = Math.min(Number(args.timeout) || DEFAULT_COMMAND_SECONDS, MAX_COMMAND_SECONDS);
  return new Promise((done) => {
    const child = spawn('sh', ['-c', command], { cwd: root, env: commandEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let stopped: string | null = null;
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      // Só o fim interessa em saídas enormes.
      if (output.length > MAX_OUTPUT_CHARS * 4) output = output.slice(-MAX_OUTPUT_CHARS * 2);
    };
    const kill = (why: string) => {
      stopped = why;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // já terminou
      }
    };
    const timer = setTimeout(() => kill(`passou de ${seconds}s`), seconds * 1000);
    const onAbort = () => kill('cancelado');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      clearTimeout(timer);
      done(fail(`Não consegui rodar o comando: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const body = clip(output.trim()) || '(sem saída)';
      if (stopped) done({ ok: false, summary: `Comando interrompido: ${stopped}`, content: body });
      else if (code === 0) done(ok('Comando terminou (código 0)', body));
      else done({ ok: false, summary: `Comando falhou (código ${code})`, content: body });
    });
  });
}

type LocalTool = (root: string, args: ToolArgs, signal?: AbortSignal) => Promise<ToolOutcome>;

const LOCAL_TOOLS: Record<string, LocalTool> = {
  read_file: readFileTool,
  write_file: (root, args) => writeFileTool(root, args, 'write'),
  create_file: (root, args) => writeFileTool(root, args, 'write'),
  append_file: (root, args) => writeFileTool(root, args, 'append'),
  edit_file: editFileTool,
  list_files: listFilesTool,
  search_code: searchCodeTool,
  run_command: runCommandTool,
};

export const isLocalTool = (name: string): boolean => name in LOCAL_TOOLS;

export async function runLocalTool(name: string, root: string, args: ToolArgs, signal?: AbortSignal): Promise<ToolOutcome> {
  const normalized = { ...args };
  if (normalized.file_path && !normalized.path) normalized.path = normalized.file_path;
  try {
    return await LOCAL_TOOLS[name](root, normalized, signal);
  } catch (err) {
    return fail((err as Error).message);
  }
}
