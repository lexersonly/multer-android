import type { ToolArgs } from '../types.ts';
import { SENSITIVE } from './specs.ts';

// Sempre perguntam, mesmo depois de "sempre" nesta conversa. O adb entra aqui porque
// alcança o aparelho inteiro, muito além da pasta do projeto.
const DESTRUCTIVE = /\brm\s+-\w*[rf]|\bdd\s|\bmkfs|\bshred\b|>\s*\/|\bchmod\s+-R|\bchown\s+-R|\bgit\s+(push|reset\s+--hard|clean)|\b(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh|\bsu\b|\bsudo\b|\bpkg\s+(un)?install|\bapt\s|\bnpm\s+publish|\bkill(all)?\b|\badb\b|:\(\)\s*\{/i;
const READ_ONLY = /^(ls|pwd|cat|head|tail|wc|grep|rg|file|stat|du|which|echo|date|uname|node\s+-v|node\s+--version|bun\s+--version|python3?\s+--version|git\s+(status|diff|log|show|branch))\b/;
const OUTSIDE_PROJECT = /(^|\s)(\/|~|\.\.)/;

export interface ApprovalNeed {
  ask: boolean;
  /** Ignora o "sempre" da conversa. */
  always?: boolean;
  reason?: string;
}

export function approvalFor(name: string, args: ToolArgs): ApprovalNeed {
  if (name !== 'run_command') return { ask: false };
  const command = String(args.command ?? '').trim();
  if (DESTRUCTIVE.test(command)) return { ask: true, always: true, reason: 'comando destrutivo ou fora do projeto' };
  if (SENSITIVE.test(command)) return { ask: true, always: true, reason: 'comando toca em credenciais' };
  if (READ_ONLY.test(command) && !/[;&|<>$`\n]/.test(command) && !OUTSIDE_PROJECT.test(command)) return { ask: false };
  return { ask: true, reason: 'comando no terminal' };
}
