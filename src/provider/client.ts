// Cliente de chat compatível com OpenAI, com streaming, para as duas formas de
// entrar no Pollinations: o token do APK, com os cookies do Open WebUI, ou uma chave sk_.

import type { ChatMessage } from '../types.ts';
import { bareFree, burnKey, freeBaseUrl, freeHeaders, freeModels, isFree, noteLimit, pickKey } from './free.ts';

const GEN_BASE = 'https://gen.pollinations.ai/v1';
const OPENWEBUI_BASE = 'https://openwebui.pollinations.ai/api';
const PING_TIMEOUT_MS = 30_000;
const PING_CONCURRENCY = 5;

export const DEFAULT_MODEL = 'community/morriszdweck/glm-5.3-flash-free';

export interface ProviderError extends Error {
  status?: number;
  retryable?: boolean;
  needsLogin?: boolean;
  modelNotFound?: boolean;
  timedOut?: boolean;
}

export interface ChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

export interface ChatOptions {
  credential: string;
  model: string;
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  stream?: boolean;
  /** Passou disso sem terminar, a chamada é cortada com `timedOut`. */
  timeoutMs?: number;
}

interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  features?: { memory: boolean };
}

/** `token=<jwt>; oauth_session_id=<id>` vira Bearer e cookies; o resto é chave comum. */
export function parseCredential(raw: string): { bearer: string; cookie: string | null } {
  const key = raw.trim();
  const pairs = key.split(';')
    .map((part): [string, string] | null => {
      const at = part.indexOf('=');
      return at > 0 ? [part.slice(0, at).trim(), part.slice(at + 1).trim()] : null;
    })
    .filter((pair): pair is [string, string] => pair !== null && pair[1] !== '');
  const token = pairs.find(([name]) => name === 'token');
  if (!token) return { bearer: key, cookie: null };
  const cookie = pairs
    .filter(([name, value]) => value !== 'None' && !/\s/.test(name))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
  return { bearer: token[1], cookie };
}

export const baseUrlFor = (credential: string): string =>
  process.env.MULTER_BASE_URL || (parseCredential(credential).cookie ? OPENWEBUI_BASE : GEN_BASE);

function headers(credential: string): Record<string, string> {
  const { bearer, cookie } = parseCredential(credential);
  const out: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` };
  if (cookie) out.Cookie = cookie;
  return out;
}

/** Nenhum erro do provedor mostra chave ou token. */
export function sanitizeError(text: unknown): string {
  const cleaned = String(text).replace(/(sk[-_][a-z0-9_-]{8,}|bearer\s+[a-z0-9._-]{8,}|eyJ[a-z0-9_-]{8,}\.[a-z0-9._-]+)/gi, '[oculto]');
  return cleaned.length > 500 ? `${cleaned.slice(0, 500)}…` : cleaned;
}

function errorFromBody(status: number, body: string): ProviderError {
  let message: unknown = body;
  try {
    const value = JSON.parse(body) as { error?: { message?: string } | string; message?: string; detail?: string };
    const nested = typeof value.error === 'object' ? value.error?.message : value.error;
    message = nested ?? value.message ?? value.detail ?? body;
  } catch {
    // corpo sem JSON: fica o texto
  }
  const error: ProviderError = new Error(sanitizeError(message || `erro ${status}`));
  error.status = status;
  error.retryable = status === 429 || status >= 500;
  error.needsLogin = status === 401;
  error.modelNotFound = status === 404 || /model.{0,30}not.{0,5}found|not.{0,5}found.{0,30}model|no such model|unknown model/i.test(`${error.message} ${body}`);
  return error;
}

interface StreamEvent {
  error?: { message?: string } | string;
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function readStream(response: Response, onDelta: (delta: string) => void): Promise<ChatResult> {
  if (!response.body) throw new Error('O provedor respondeu sem corpo.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let promptTokens = 0;
  let completionTokens = 0;
  for (;;) {
    let chunk: { done: boolean; value?: Uint8Array };
    try {
      chunk = await reader.read();
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      // Conexão cortada no meio: o que o modelo já escreveu não se perde.
      if (content.trim()) break;
      const failure: ProviderError = new Error(sanitizeError((err as Error).message));
      failure.retryable = true;
      throw failure;
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return { content, promptTokens, completionTokens };
      let value: StreamEvent;
      try {
        value = JSON.parse(data) as StreamEvent;
      } catch {
        continue;
      }
      if (value.error) {
        const failure: ProviderError = new Error(sanitizeError(typeof value.error === 'object' ? value.error.message : value.error));
        failure.retryable = true;
        throw failure;
      }
      const delta = value.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        onDelta(delta);
      }
      promptTokens = value.usage?.prompt_tokens ?? promptTokens;
      completionTokens = value.usage?.completion_tokens ?? completionTokens;
    }
  }
  if (!content && buffer.trim()) {
    // Servidores que ignoram stream=true devolvem JSON comum.
    try {
      content = (JSON.parse(buffer) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? '';
      if (content) onDelta(content);
    } catch {
      // nada aproveitável
    }
  }
  return { content, promptTokens, completionTokens };
}

async function requestChat(credential: string, body: ChatBody, signal: AbortSignal | undefined, onDelta: (delta: string) => void): Promise<ChatResult> {
  const url = `${baseUrlFor(credential)}/chat/completions`;
  const send = () => fetch(url, { method: 'POST', headers: headers(credential), body: JSON.stringify(body), signal });
  let response = await send();
  if (response.status === 400) {
    const text = await response.text();
    if (!/temperature|max_tokens|max_completion_tokens|unsupported parameter/i.test(text)) throw errorFromBody(400, text);
    // Modelo que recusa esses parâmetros: tenta de novo com o nome novo.
    delete body.temperature;
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    response = await send();
  }
  if (!response.ok) throw errorFromBody(response.status, await response.text());
  if (!body.stream || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const value = await response.json() as {
      error?: unknown;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (value.error) throw errorFromBody(response.status, JSON.stringify(value));
    const content = value.choices?.[0]?.message?.content ?? '';
    if (content) onDelta(content);
    return {
      content,
      promptTokens: value.usage?.prompt_tokens ?? 0,
      completionTokens: value.usage?.completion_tokens ?? 0,
    };
  }
  return readStream(response, onDelta);
}

const warmed = new Set<string>();

/** O Open WebUI só conhece os modelos depois de listá-los: sem isso o primeiro pedido pode dar "Model not found". */
async function warmUp(credential: string, signal?: AbortSignal): Promise<void> {
  const base = baseUrlFor(credential);
  if (warmed.has(base)) return;
  warmed.add(base);
  const limit = AbortSignal.timeout(15_000);
  try {
    const response = await fetch(`${base}/models`, { headers: headers(credential), signal: signal ? AbortSignal.any([signal, limit]) : limit });
    await response.text();
  } catch {
    // sem a lista o pedido segue mesmo assim
  }
}

const MAX_FREE_STRIKES = 3;

/** Uma resposta aceita, lida em fluxo ou inteira. */
async function readFree(response: Response, onDelta: (delta: string) => void, stream: boolean): Promise<ChatResult> {
  if (stream && (response.headers.get('content-type') ?? '').includes('text/event-stream')) return readStream(response, onDelta);
  const value = await response.json() as {
    error?: unknown;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = value.choices?.[0]?.message?.content ?? '';
  if (content) onDelta(content);
  return { content, promptTokens: value.usage?.prompt_tokens ?? 0, completionTokens: value.usage?.completion_tokens ?? 0 };
}

/**
 * Pool gratuito: tenta as chaves com folga, uma atrás da outra, e escorrega para outro modelo
 * grátis quando o modelo escolhido inteiro encheu o minuto. Chave recusada sai do pool.
 */
async function chatFree(
  body: ChatBody,
  options: { onDelta: (delta: string) => void; signal?: AbortSignal; timeoutMs?: number; stream: boolean; model: string },
): Promise<ChatResult> {
  const { onDelta, signal, timeoutMs, stream, model } = options;
  const wanted = bareFree(model);
  const others = (await freeModels()).map(bareFree).filter((id) => id !== wanted).sort(() => Math.random() - 0.5);
  let faltando = 0;
  for (const target of [wanted, ...others]) {
    for (let strike = 0; strike < MAX_FREE_STRIKES; strike++) {
      const key = await pickKey(target);
      if (!key) break;
      const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
      const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout);
      let response: Response;
      try {
        response = await fetch(`${freeBaseUrl()}/chat/completions`, {
          method: 'POST',
          headers: freeHeaders(key),
          body: JSON.stringify({ ...body, model: target }),
          signal: combined,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError' && timeout && !signal?.aborted) {
          const failure: ProviderError = new Error(`O modelo demorou mais de ${Math.round((timeoutMs ?? 0) / 1000)}s para responder.`);
          failure.timedOut = true;
          throw failure;
        }
        throw err as ProviderError;
      }
      if (response.ok) return readFree(response, onDelta, stream);
      const text = await response.text();
      if (response.status === 429 || response.status === 503) {
        noteLimit(target, key);
        continue;
      }
      if (response.status === 401 || response.status === 402 || response.status === 403) {
        burnKey(key);
        continue;
      }
      throw errorFromBody(response.status, text);
    }
  }
  if (faltando === 0) faltando++;
  const failure: ProviderError = new Error('As chaves gratuitas acabaram por agora. Tente de novo em um minuto ou faça /login.');
  failure.retryable = true;
  throw failure;
}

export async function chat(options: ChatOptions): Promise<ChatResult> {
  const { credential, model, system, messages, temperature = 0.2, maxTokens, signal, onDelta = () => {}, stream = true, timeoutMs } = options;
  const body: ChatBody = {
    model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    temperature,
    max_tokens: maxTokens,
    stream,
  };
  // Modelos com prefixo próprio não passam pelo Pollinations: vão para o pool gratuito do site.
  if (isFree(model)) return chatFree(body, { onDelta, signal, timeoutMs, stream, model });
  // O Open WebUI injeta as memórias da conta quando este recurso vem ligado, como no app.
  if (parseCredential(credential).cookie) body.features = { memory: true };
  await warmUp(credential, signal);
  for (let attempt = 0; ; attempt++) {
    const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout);
    try {
      return await requestChat(credential, structuredClone(body), combined, onDelta);
    } catch (err) {
      if (timeout?.aborted && !signal?.aborted) {
        const failure: ProviderError = new Error(`O modelo demorou mais de ${Math.round((timeoutMs ?? 0) / 1000)}s para responder.`);
        failure.timedOut = true;
        throw failure;
      }
      const failure = err as ProviderError;
      if (failure.modelNotFound) failure.message += ` (modelo ${model}, em ${new URL(baseUrlFor(credential)).host})`;
      if (!failure.retryable || attempt >= 2 || signal?.aborted) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}

interface CatalogItem {
  id: string;
  category?: string;
  paid_only?: boolean;
}

/** Modelos de texto gratuitos do catálogo: dizem "free" no nome e não são pagos. */
export function freeTextModels(catalog: { data?: CatalogItem[] } | null): string[] {
  return (catalog?.data ?? [])
    .filter((item) => (item.category ?? 'text') === 'text' && !item.paid_only && String(item.id).toLowerCase().includes('free'))
    .map((item) => item.id);
}

async function fetchCatalog(credential: string): Promise<{ data?: CatalogItem[] }> {
  const response = await fetch(`${baseUrlFor(credential)}/models`, { headers: headers(credential) });
  if (!response.ok) throw errorFromBody(response.status, await response.text());
  return response.json() as Promise<{ data?: CatalogItem[] }>;
}

/** Todos os ids da conta e os gratuitos, sem testar se cada um responde. */
export async function modelIds(credential: string): Promise<{ all: string[]; free: string[] }> {
  const catalog = await fetchCatalog(credential);
  const livres = await freeModels();
  return { all: [...(catalog.data ?? []).map((item) => item.id), ...livres], free: [...freeTextModels(catalog).sort(), ...livres] };
}

/** A lista do catálogo, rápida: sem testar se cada modelo responde. */
export async function freeModelCatalog(credential: string): Promise<string[]> {
  const livres = await freeModels();
  if (!credential) return livres;
  try {
    return [...freeTextModels(await fetchCatalog(credential)).sort(), ...livres];
  } catch {
    return livres;
  }
}

/** Confere se a sessão é aceita antes de guardá-la. */
export async function checkCredential(credential: string): Promise<void> {
  await fetchCatalog(credential);
}

async function pingModel(credential: string, model: string): Promise<boolean> {
  try {
    await chat({
      credential,
      model,
      // Duas voltas: modelos que exigem o raciocínio de respostas anteriores falham aqui.
      messages: [{ role: 'user', content: 'ping' }, { role: 'assistant', content: 'pong' }, { role: 'user', content: 'ping' }],
      temperature: 0,
      maxTokens: 512,
      stream: false,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return true;
  } catch (err) {
    return /token limit|max_tokens|output token/i.test((err as Error).message);
  }
}

/** Testa os gratuitos e devolve só os que respondem. */
export async function workingFreeModels(credential: string, onProgress: (done: number, total: number) => void = () => {}): Promise<string[]> {
  const candidates = freeTextModels(await fetchCatalog(credential));
  const queue = [...candidates];
  const working: string[] = [];
  let done = 0;
  onProgress(0, candidates.length);
  await Promise.all(Array.from({ length: PING_CONCURRENCY }, async () => {
    for (let model = queue.shift(); model; model = queue.shift()) {
      if (await pingModel(credential, model)) working.push(model);
      onProgress(++done, candidates.length);
    }
  }));
  // Os do pool do site já vêm curados: não precisam de teste um por um.
  return [...working.sort(), ...(await freeModels())];
}
