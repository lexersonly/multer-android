// A conversa fica salva por pasta: o Android fecha o Termux sem avisar, e o trabalho
// não pode sumir junto. O arquivo é privado, como o do login.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from './auth/credentials.ts';
import type { HistoryItem, Task } from './types.ts';

const MAX_HISTORY = 200;

export interface SavedSession {
  history: HistoryItem[];
  tasks: Task[];
  changedFiles: string[];
  lastUserText: string;
  nextTask: number;
  savedAt: string;
}

export const sessionPath = (root: string): string =>
  join(configDir(), 'sessions', `${createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`);

export function saveSession(path: string, session: SavedSession): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ ...session, history: session.history.slice(-MAX_HISTORY) }), { mode: 0o600 });
}

/** Arquivo que não abre não pode impedir o Multer de abrir. */
export function loadSession(path: string): SavedSession | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as SavedSession;
    return Array.isArray(value.history) && Array.isArray(value.tasks) ? value : null;
  } catch {
    return null;
  }
}

export function deleteSession(path: string): void {
  rmSync(path, { force: true });
}
