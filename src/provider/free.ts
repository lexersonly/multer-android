// Pool de chaves gratuitas do NightRouter, para usar sem login nenhum.
//
// Nada de chave no repositório (ele é público): o pool vem do site do Multer em tempo de
// execução (`/api/ai/free-keys`) ou de `MULTER_FREE_KEYS`, e fica em cache local por 10
// minutos, num arquivo que só este aparelho lê. As chaves são descartáveis: batem no limite,
// são puladas na hora, e chaves recusadas saem do cache.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../auth/credentials.ts';
import { FREE_TOKEN } from './free-token.ts';

export const FREE_PREFIX = 'nightrouter/';
/** Endereço do pool. `MULTER_FREE_URL` aponta para outro servidor, se precisar. */
const poolUrl = () => `${(process.env.MULTER_FREE_URL || 'https://multer-builderai.vercel.app').replace(/\/+$/, '')}/api/ai/free-keys`;
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
    const response = await fetch(poolUrl(), {
      headers: { Authorization: `Bearer ${FREE_TOKEN}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      throw new PoolAuthError('O servidor recusou o token do pool. Defina MULTER_FREE_TOKEN com o token novo.');
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

/** Reserva a chave com mais folga para este modelo. `null` quando todas estão no limite. */
export async function pickKey(model: string): Promise<string | null> {
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
