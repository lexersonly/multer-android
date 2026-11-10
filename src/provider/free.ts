// Pool de chaves gratuitas do NightRouter, para usar sem login nenhum.
//
// Nada de chave no repositório (ele é público): o pool vem do site do Multer em tempo de
// execução (`/api/ai/free-keys`) ou de `MULTER_FREE_KEYS`, e fica em cache local por 10
// minutos, num arquivo que só este aparelho lê. As chaves são descartáveis: batem no limite,
// são puladas na hora, e chaves recusadas saem do cache.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { configDir } from '../auth/credentials.ts';
import { FREE_TOKEN } from './free-token.ts';
import { solve } from './pow.ts';

export const FREE_PREFIX = 'nightrouter/';
/** Endereço do pool. `MULTER_FREE_URL` aponta para outro servidor, se precisar. */
const poolBase = () => (process.env.MULTER_FREE_URL || 'https://multer-builderai.vercel.app').replace(/\/+$/, '');
const poolUrl = () => `${poolBase()}/api/ai/free-keys`;
const CACHE_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Token recusado: não adianta cair para o cache velho sem avisar. */
class PoolAuthError extends Error {}

export const isFree = (model: string): boolean => model.startsWith(FREE_PREFIX);
export const bareFree = (model: string): string => (isFree(model) ? model.slice(FREE_PREFIX.length) : model);

interface Snapshot {
  at: number;
  keys: string[];
  models: string[];
  limit: number;
  windowMs: number;
}

const cachePath = () => join(configDir(), 'free-keys.json');
const tokenPath = () => join(configDir(), 'pool-token.json');
const installPath = () => join(configDir(), 'install-id');

/** Id desta instalação: o token do pool é preso nele, então copiar o token não basta. */
function installId(): string {
  try {
    const saved = readFileSync(installPath(), 'utf8').trim();
    if (/^[a-z0-9-]{8,64}$/.test(saved)) return saved;
  } catch {
    // ainda não existe
  }
  const id = randomBytes(16).toString('hex');
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(installPath(), `${id}\n`, { mode: 0o600 });
  } catch {
    // sem arquivo o id vale só nesta execução
  }
  return id;
}

interface PoolToken {
  token: string;
  expires: number;
}

function readToken(): string | null {
  try {
    const value = JSON.parse(readFileSync(tokenPath(), 'utf8')) as Partial<PoolToken>;
    if (typeof value.token !== 'string' || Number(value.expires) - Date.now() < 60_000) return null;
    return value.token;
  } catch {
    return null;
  }
}

function saveToken(value: PoolToken): void {
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath(), JSON.stringify(value), { mode: 0o600 });
    chmodSync(tokenPath(), 0o600);
  } catch {
    // sem cache o token é pedido de novo na próxima
  }
}

function forgetToken(): void {
  try {
    writeFileSync(tokenPath(), '', { mode: 0o600 });
  } catch {
    // segue sem
  }
}

/** Resolve o desafio e troca por um token novo. `null` quando o servidor não responde. */
async function newToken(): Promise<string | null> {
  try {
    const challenge = await fetch(`${poolUrl()}/challenge`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!challenge.ok) return null;
    const { nonce, bits } = await challenge.json() as { nonce?: string; bits?: number };
    if (!nonce || !bits) return null;
    const counter = solve(nonce, bits);
    const response = await fetch(poolUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, counter, install: installId() }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
    });
    if (!response.ok) return null;
    const value = await response.json() as { token?: string; expires?: number };
    if (!value.token) return null;
    saveToken({ token: value.token, expires: Number(value.expires) || Date.now() + 3_600_000 });
    return value.token;
  } catch {
    return null;
  }
}
let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot | null> | null = null;

/** Uso por chave e modelo dentro da janela do provedor. */
const uses = new Map<string, { count: number; at: number }>();
/** Chaves que o servidor recusou nesta execução. */
const dead = new Set<string>();

function readCache(): Snapshot | null {
  try {
    const value = JSON.parse(readFileSync(cachePath(), 'utf8')) as Snapshot;
    if (!Array.isArray(value.keys) || !value.keys.length) return null;
    return { at: Number(value.at) || 0, keys: value.keys, models: Array.isArray(value.models) ? value.models : [], limit: Number(value.limit) || 3, windowMs: Number(value.windowMs) || 62_000 };
  } catch {
    return null;
  }
}

function writeCache(value: Snapshot): void {
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath(), JSON.stringify(value), { mode: 0o600 });
    chmodSync(cachePath(), 0o600);
  } catch {
    // Sem cache o pool só é buscado de novo na próxima.
  }
}

async function fetchPool(): Promise<Snapshot | null> {
  try {
    let token = readToken() ?? (await newToken()) ?? FREE_TOKEN;
    const pedir = () => fetch(poolUrl(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let response = await pedir();
    if (response.status === 401 || response.status === 403) {
      // Token do pool venceu: um desafio novo resolve; se nem isso, cai no token fixo.
      forgetToken();
      token = (await newToken()) ?? FREE_TOKEN;
      response = await pedir();
      if (response.status === 403) {
        const motivo = await response.json().catch(() => ({})) as { error?: string };
        throw new PoolAuthError(motivo.error ?? 'Esta instalação está bloqueada no pool.');
      }
      if (response.status === 401 || response.status === 403) {
        throw new PoolAuthError('O servidor recusou o acesso ao pool. Defina MULTER_FREE_TOKEN com o token novo.');
      }
    }
    if (!response.ok) return null;
    const value = await response.json() as Partial<Snapshot>;
    if (!Array.isArray(value.keys) || !value.keys.length) return null;
    const fresh: Snapshot = {
      at: Date.now(),
      keys: value.keys.filter((key): key is string => typeof key === 'string' && key.startsWith('sk-')),
      models: (value.models ?? []).filter((id): id is string => typeof id === 'string' && id.startsWith(FREE_PREFIX)),
      limit: Number(value.limit) || 3,
      windowMs: Number(value.windowMs) || 62_000,
    };
    if (!fresh.keys.length) return null;
    writeCache(fresh);
    return fresh;
  } catch (err) {
    if (err instanceof PoolAuthError) throw err;
    return null;
  }
}

function fromEnv(): Snapshot | null {
  const keys = (process.env.MULTER_FREE_KEYS ?? '').split(/[\s,;]+/).filter((key) => key.startsWith('sk-'));
  return keys.length ? { at: Date.now(), keys, models: [], limit: 3, windowMs: 62_000 } : null;
}

/** O pool atual, do cache, do servidor ou do ambiente — nessa ordem de conveniência. */
async function pool(): Promise<Snapshot | null> {
  if (snapshot) return snapshot;
  const env = fromEnv();
  if (env) return (snapshot = env);
  const cached = readCache();
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return (snapshot = cached);
  loading ??= fetchPool().finally(() => { loading = null; });
  const fresh = await loading;
  if (fresh) return (snapshot = fresh);
  return cached ? (snapshot = cached) : null;
}

/** Modelos gratuitos que o servidor oferece hoje. */
export async function freeModels(): Promise<string[]> {
  try {
    return (await pool())?.models ?? [];
  } catch {
    // Sem lista ainda dá para usar o modelo escolhido.
    return [];
  }
}

export async function freeAvailable(): Promise<boolean> {
  try {
    const found = await pool();
    return Boolean(found?.keys.some((key) => !dead.has(key)));
  } catch {
    return false;
  }
}

let buscando = false;

/** Reserva a chave com mais folga para este modelo. `null` quando todas estão no limite. */
export async function pickKey(model: string): Promise<string | null> {
  const achada = await escolher(model);
  // Pool vindo do ambiente é fixo: não há de onde buscar mais.
  if (achada || buscando || process.env.MULTER_FREE_KEYS) return achada;
  // A leva local acabou: pede outra antes de desistir.
  buscando = true;
  try {
    snapshot = null;
    await fetchPool();
    return await escolher(model);
  } finally {
    buscando = false;
  }
}

async function escolher(model: string): Promise<string | null> {
  const found = await pool();
  if (!found) return null;
  const bare = bareFree(model);
  const now = Date.now();
  let best: string | null = null;
  let bestCount = Infinity;
  for (const key of found.keys) {
    if (dead.has(key)) continue;
    const slot = uses.get(`${bare}|${key}`);
    const count = slot && now - slot.at < found.windowMs ? slot.count : 0;
    if (count >= found.limit) continue;
    if (count < bestCount) {
      best = key;
      bestCount = count;
    }
  }
  if (!best) return null;
  uses.set(`${bare}|${best}`, { count: bestCount + 1, at: now });
  return best;
}

/** Bateu no limite: só conta; a janela sozinha devolve a chave. */
export function noteLimit(model: string, key: string): void {
  const slot = uses.get(`${bareFree(model)}|${key}`);
  if (slot) uses.set(`${bareFree(model)}|${key}`, { ...slot, at: Date.now() });
}

/** Chave recusada (vencida, sem saldo): sai do pool até a próxima busca. */
export function burnKey(key: string): void {
  dead.add(key);
}

export const freeBaseUrl = (): string => (process.env.MULTER_FREE_API_URL || 'https://api.nightrouter.ai/v1').replace(/\/+$/, '');

export const freeHeaders = (key: string): Record<string, string> => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${key}` });

/** Esquece o pool: a próxima chamada busca de novo. */
export function resetPool(): void {
  snapshot = null;
  uses.clear();
  dead.clear();
}
