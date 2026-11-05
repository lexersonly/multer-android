// O que só existe no celular: manter o Termux acordado enquanto a equipe trabalha e avisar
// quando ela termina ou pede permissão. Sem essas ferramentas, nada muda.

import { spawn } from 'node:child_process';
import type { Runtime } from './agents/runtime.ts';
import { inPath } from './auth/browser.ts';

const NOTIFY_AFTER_MS = 20_000;

export type Launcher = (command: string, args: string[]) => void;

const launch: Launcher = (command, args) => {
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
};

export function notify(title: string, text: string, run: Launcher = launch, has: (name: string) => boolean = inPath): void {
  if (has('termux-notification')) run('termux-notification', ['--id', 'multer', '--title', title, '--content', text]);
}

/** Liga a trava enquanto a equipe trabalha. Devolve quem solta tudo ao fechar. */
export function attachPhone(runtime: Runtime, run: Launcher = launch, has: (name: string) => boolean = inPath): () => void {
  let locked = false;
  let startedAt = 0;
  const setLock = (on: boolean): void => {
    if (on === locked) return;
    locked = on;
    const command = on ? 'termux-wake-lock' : 'termux-wake-unlock';
    if (has(command)) run(command, []);
  };
  runtime.on('busy', (busy) => {
    setLock(busy);
    if (busy) startedAt = Date.now();
    else if (Date.now() - startedAt >= NOTIFY_AFTER_MS) notify('Multer', 'A equipe terminou.', run, has);
  });
  return () => setLock(false);
}
