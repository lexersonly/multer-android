import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const inPath = (name: string): boolean =>
  (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, name)));

/** Abre no navegador do aparelho. Devolve false se nada pôde abrir: o endereço fica na tela. */
export function openBrowser(url: string): boolean {
  const command = ['termux-open-url', 'xdg-open'].find(inPath);
  if (!command) return false;
  const child = spawn(command, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
  return true;
}
