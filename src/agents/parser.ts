// Interpreta a resposta do modelo. Modelos pequenos escrevem a chamada de
// ferramenta de vários jeitos: tudo vira { text, tool, parseError }.

import type { ParsedResponse, ToolArgs, ToolCall } from '../types.ts';

export const TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file', 'write_file', 'create_file', 'append_file', 'edit_file', 'list_files', 'search_code',
  'run_command', 'assign_task', 'send_message', 'update_task', 'submit_review', 'find_tools', 'request_plugin',
]);

const isKnownTool = (name: string) => TOOL_NAMES.has(name) || name.startsWith('mcp__');

type JsonRead =
  | { kind: 'value'; value: ToolArgs; end: number }
  | { kind: 'empty' }
  | { kind: 'error'; message: string; eof: boolean };

/** Lê um objeto JSON no começo do texto, parando no fim dele. */
function readJsonObject(body: string): JsonRead {
  if (!body.startsWith('{')) return { kind: 'empty' };
  let depth = 0;
  let inString = false;
  for (let at = 0; at < body.length; at++) {
    const c = body[at];
    if (inString) {
      if (c === '\\') at++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return { kind: 'value', value: JSON.parse(body.slice(0, at + 1)) as ToolArgs, end: at + 1 };
      } catch (err) {
        return { kind: 'error', message: (err as Error).message, eof: false };
      }
    }
  }
  return { kind: 'error', message: 'fim inesperado', eof: true };
}

/** Remove `<think>` de um texto que chega em pedaços, mesmo com a tag partida. */
export class ReasoningFilter {
  private inside = false;
  private pending = '';
  private skipSpace = false;

  push(chunk: string): string {
    this.pending += chunk;
    let out = '';
    for (;;) {
      const tag = this.inside ? '</think>' : '<think>';
      const pos = this.pending.indexOf(tag);
      if (pos >= 0) {
        if (!this.inside) out += this.pending.slice(0, pos);
        this.pending = this.pending.slice(pos + tag.length);
        this.inside = !this.inside;
        this.skipSpace = !this.inside;
        continue;
      }
      let keep = 0;
      for (let len = tag.length - 1; len > 0; len--) {
        if (this.pending.endsWith(tag.slice(0, len))) {
          keep = len;
          break;
        }
      }
      const cut = this.pending.length - keep;
      if (!this.inside) out += this.pending.slice(0, cut);
      if (this.skipSpace) {
        out = out.trimStart();
        if (out) this.skipSpace = false;
      }
      this.pending = this.pending.slice(cut);
      return out;
    }
  }
}

export const stripReasoning = (content: string) => new ReasoningFilter().push(content);

function normalizeToolMarkup(text: string): string {
  return text
    .replace(/\[(\/?)\s*tool(?:\s+name\s*=\s*["']?([a-z_][a-z0-9_]*)["']?)?\s*\]/gi, (_, __, name?: string) =>
      name ? `<tool name="${name}">` : '</tool>')
    .replace(/<(\/?)([a-z][a-z0-9_]*)>(\s*\{)?/g, (whole, slash: string, name: string, brace?: string) => {
      if (!isKnownTool(name)) return whole;
      if (slash) return '</tool>';
      return brace ? `<tool name="${name}">${brace}` : whole;
    });
}

const stripToolMarkup = (text: string) =>
  text.replace(/<tool_call>[\s\S]*?<\/tool_call>|<tool\b[^>]*>[\s\S]*?(?:<\/tool\s*>|$)|<\/tool\s*>/gi, '');

/** Modelos pequenos repetem o que receberam: isso não é resposta. */
function stripEchoes(input: string): string {
  let text = input;
  const at = ['Resultados reais das ferramentas', 'Resultados das ferramentas']
    .map((marker) => text.indexOf(marker))
    .filter((pos) => pos >= 0);
  if (at.length) {
    const first = Math.min(...at);
    text = text.slice(0, text.lastIndexOf('\n', first) + 1);
  }
  const out: string[] = [];
  let skipQuote = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (skipQuote) {
      if (trimmed) skipQuote = false;
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('[runtime]') || lower.startsWith('[usuário]') || lower.startsWith('[usuario]')) {
      skipQuote = trimmed.endsWith(':');
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/<\/\s*(?:r|s|end|assistant|response|answer)\s*>|<\|[a-z_]+\|>/gi, '');
}

const cleanText = (text: string) => stripEchoes(stripToolMarkup(text)).trim().replace(/^`+|`+$/g, '').trim();

const JSON_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' };
const unescapeJson = (raw: string) => raw.replace(/\\(["\\/ntr])/g, (_, c: string) => JSON_ESCAPES[c] ?? c);

/** Lê `{"path":…,"content":…}` com aspas sem escape. Sem o fechamento, a resposta foi cortada: não recupera. */
function repairFileArguments(raw: string): ToolArgs | null {
  const match = raw.match(/^\s*\{\s*"(?:path|file_path)"\s*:\s*"([^"\n]+)"\s*,\s*"content"\s*:\s*"/);
  if (!match) return null;
  const rest = raw.slice(match[0].length);
  const trimmed = rest.trimEnd();
  let end: number;
  if (trimmed.endsWith('}')) {
    const inner = trimmed.slice(0, -1).trimEnd();
    if (!inner.endsWith('"')) return null;
    end = inner.length - 1;
  } else {
    end = trimmed.replace(/["}]+$/, '').length;
    if (!trimmed.slice(end).startsWith('"}')) return null;
  }
  return { path: match[1], content: unescapeJson(rest.slice(0, end)) };
}

function parseTagTool(content: string): ParsedResponse | null {
  const open = content.match(/<\/?\s*tool(?:\s+name\s*=\s*["']?|\s+|\s*:\s*)([a-z_][a-z0-9_]*)["']?\s*\/?>/i);
  if (!open || open.index === undefined) return null;
  const name = open[1];
  const before = content.slice(0, open.index);
  const body = content.slice(open.index + open[0].length).trimStart();
  const parsed = readJsonObject(body);

  if (parsed.kind === 'error') {
    const close = body.match(/<\/\s*tool\s*>/i);
    const raw = close ? body.slice(0, close.index) : body;
    const text = before + (close && close.index !== undefined ? body.slice(close.index + close[0].length) : '');
    if (['create_file', 'write_file', 'append_file'].includes(name)) {
      const args = repairFileArguments(raw);
      if (args) return { text, tool: { name, args } };
    }
    return {
      text,
      parseError: parsed.eof
        ? `O JSON da ferramenta ${name} ficou incompleto (a resposta foi cortada). Grave um conteúdo menor e complete depois com append_file.`
        : `JSON da ferramenta ${name} inválido: ${parsed.message}. Escape aspas e quebras de linha do conteúdo.`,
    };
  }
  if (parsed.kind === 'empty') {
    const close = body.match(/^<\/\s*tool\s*>/i);
    if (close) return { text: before + body.slice(close[0].length), tool: { name, args: {} } };
    return { text: before, parseError: `A ferramenta ${name} precisa de argumentos JSON logo após a tag: <tool name="${name}">{...}</tool>.` };
  }
  const after = body.slice(parsed.end);
  const close = after.match(/^\s*<\/\s*tool\s*>/i);
  const tail = close ? after.slice(close[0].length) : after.replace(/^["}`]+/, '');
  return { text: before + tail, tool: { name, args: parsed.value } };
}

const isObject = (value: unknown): value is ToolArgs =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function parsePayload(raw: string): { tool?: ToolCall; parseError?: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { parseError: `JSON da ferramenta inválido: ${(err as Error).message}` };
  }
  if (!isObject(value)) return { parseError: 'A chamada de ferramenta precisa ser um objeto JSON.' };
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const only = value[keys[0]];
    if (isObject(only)) return { tool: { name: keys[0], args: only } };
  }
  const name = value.name ?? value.tool ?? value.tool_name;
  if (typeof name !== 'string') return { parseError: 'A chamada de ferramenta não informou o nome.' };
  let args = value.arguments ?? value.parameters ?? value.args ?? value.input ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return { tool: { name, args: isObject(args) ? args : {} } };
}

function parseFenced(content: string): { text: string; raw: string } | null {
  for (const match of content.matchAll(/```(?:json|tool)?\s*(\{[\s\S]*?\})\s*```/gi)) {
    let value: unknown;
    try {
      value = JSON.parse(match[1]);
    } catch {
      return null;
    }
    if (!isObject(value)) continue;
    const keys = Object.keys(value);
    const looksLikeTool = 'name' in value || 'tool' in value || 'tool_name' in value
      || (keys.length === 1 && isObject(value[keys[0]]));
    if (looksLikeTool) {
      return { text: content.slice(0, match.index) + content.slice(match.index + match[0].length), raw: match[1] };
    }
  }
  return null;
}

/** Alguns modelos escrevem só os argumentos, sem a tag. */
function parseBareFile(content: string): ParsedResponse | null {
  const found = content.match(/\{\s*"(?:path|file_path)"\s*:\s*"[^"\n]+"\s*,\s*"content"\s*:\s*"/);
  if (!found || found.index === undefined) return null;
  const before = content.slice(0, found.index);
  const body = content.slice(found.index);
  const parsed = readJsonObject(body);
  if (parsed.kind === 'value') {
    const tail = body.slice(parsed.end).replace(/^["}`]+/, '');
    return {
      text: cleanText(before + tail),
      tool: { name: 'write_file', args: { path: parsed.value.path ?? parsed.value.file_path, content: parsed.value.content } },
    };
  }
  const args = repairFileArguments(body);
  if (args) return { text: cleanText(before), tool: { name: 'write_file', args } };
  return {
    text: cleanText(before),
    parseError: 'O JSON do arquivo ficou incompleto ou inválido. Use <tool name="write_file">{json}</tool> com um conteúdo menor.',
  };
}

export function parseResponse(raw: string): ParsedResponse {
  const content = normalizeToolMarkup(stripReasoning(raw));
  const trimmed = content.trim();
  if (!trimmed) return { text: '' };

  const tag = parseTagTool(content);
  if (tag) return { ...tag, text: cleanText(tag.text) };

  const toolCall = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  if (toolCall && toolCall.index !== undefined) {
    const text = content.slice(0, toolCall.index) + content.slice(toolCall.index + toolCall[0].length);
    return { ...parsePayload(toolCall[1].trim()), text: cleanText(text) };
  }
  const fenced = parseFenced(content);
  if (fenced) return { ...parsePayload(fenced.raw), text: cleanText(fenced.text) };

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const bare = parsePayload(trimmed);
    if (bare.tool) return { ...bare, text: '' };
  }
  const bareFile = parseBareFile(content);
  if (bareFile) return bareFile;

  if (content.includes('<tool')) {
    return { text: cleanText(content), parseError: 'Formato de ferramenta inválido. Use <tool name="nome">{json}</tool>.' };
  }
  return { text: cleanText(content) };
}

/** O que dá para mostrar enquanto a resposta chega: sem raciocínio e sem chamada de ferramenta. */
export function streamView(raw: string): string {
  const text = stripReasoning(raw);
  const marker = text.search(/<\/?\s*tool|\[\/?\s*tool|```(?:json|tool)|\{\s*"(?:path|file_path|name|tool)"\s*:/i);
  let visible = marker >= 0 ? text.slice(0, marker) : text;
  for (const match of visible.matchAll(/<([a-z][a-z0-9_]*)>/g)) {
    if (isKnownTool(match[1])) {
      visible = visible.slice(0, match.index);
      break;
    }
  }
  return visible.replace(/<[a-z_/]*$/i, '').trimStart();
}

/** A resposta bateu no limite de tokens no meio de uma chamada: o JSON não está inteiro. */
export function toolCallWasCut(content: string, completionTokens: number, limit: number): boolean {
  // Sem contagem do provedor, estima pelo tamanho: um token tem de 2 a 4 caracteres.
  const reached = completionTokens >= limit || (completionTokens === 0 && content.length >= limit * 2);
  const lower = content.toLowerCase();
  return reached && !lower.includes('</tool') && (lower.includes('<tool') || lower.includes('[tool') || lower.includes('"content"'));
}

const PROMISES = new Set(['vou', 'irei', 'vamos', 'delegarei', 'chamarei', 'passarei', "i'll", "let's", 'going']);

/** Termina prometendo uma ação sem chamar ferramenta. Pergunta não conta. */
export function announcesAction(input: string): boolean {
  const text = input.trim().toLowerCase();
  if (!text || text.endsWith('?')) return false;
  const sentences = text.split(/[.!\n]/).map((part) => part.trim()).filter(Boolean);
  const words = (sentences.at(-1) ?? '').split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  return words.some((word, index) => PROMISES.has(word) && words[index - 1] !== 'não');
}

export const fingerprint = (text: string) => text.split(/\s+/).join(' ').trim().toLowerCase();
