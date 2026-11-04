// Cliente MCP por stdio: JSON-RPC, uma mensagem por linha.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { PluginTool } from '../types.ts';

const PROTOCOL_VERSION = '2025-03-26';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESULT_CHARS = 20_000;

export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcReply {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

export interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface ToolList {
  tools?: Array<{ name: string; description?: string; inputSchema?: PluginTool['schema'] }>;
  nextCursor?: string;
}

export class McpClient {
  closed: string | null = null;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private stderr = '';

  constructor(command: string, args: string[], env: Record<string, string> = {}) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-1500);
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.on('error', (err) => this.onClose(err.message));
    this.child.on('close', (code) => this.onClose(`O plugin encerrou (código ${code}).`));
    this.child.stdin.on('error', () => {});
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let value: RpcReply;
      try {
        value = JSON.parse(line) as RpcReply;
      } catch {
        continue;
      }
      const waiting = value.id === undefined ? undefined : this.pending.get(value.id);
      if (!waiting || value.id === undefined) continue;
      this.pending.delete(value.id);
      clearTimeout(waiting.timer);
      if (value.error) waiting.reject(new Error(clip(value.error.message ?? 'erro desconhecido', 500)));
      else waiting.resolve(value.result);
    }
  }

  private onClose(reason: string): void {
    this.closed = reason;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(this.stderr.trim() ? `${reason}\n${clip(this.stderr.trim(), 600)}` : reason));
    }
    this.pending.clear();
  }

  request<T>(method: string, params: object = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`O plugin não respondeu a ${method} em ${REQUEST_TIMEOUT_MS / 1000}s.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private notify(method: string): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async listTools(serverName: string): Promise<PluginTool[]> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'multer-android', version: '0.2.0' },
    });
    this.notify('notifications/initialized');
    const tools: PluginTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await this.request<ToolList>('tools/list', cursor ? { cursor } : {});
      for (const tool of result.tools ?? []) {
        tools.push({
          fullName: `mcp__${serverName}__${tool.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`,
          remoteName: tool.name,
          description: clip(tool.description ?? '', 300),
          schema: tool.inputSchema ?? {},
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  close(): void {
    this.closed ??= 'Encerrado.';
    this.child.kill();
  }
}

export function resultText(result: ToolCallResult | null | undefined): string {
  const parts = (result?.content ?? []).map((item) =>
    item.type === 'text' ? item.text ?? '' : `[conteúdo do tipo ${item.type}]`);
  return clip(parts.length ? parts.join('\n') : JSON.stringify(result ?? null), MAX_RESULT_CHARS);
}
