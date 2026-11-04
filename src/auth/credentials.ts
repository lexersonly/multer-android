// A credencial fica só neste aparelho, em um arquivo que só o Termux lê.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const configDir = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'multer-android');

const credentialPath = () => join(configDir(), 'credential');

export function loadCredential(): string | null {
  if (process.env.POLLINATIONS_API_KEY) return process.env.POLLINATIONS_API_KEY.trim();
  try {
    return readFileSync(credentialPath(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function saveCredential(credential: string): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(credentialPath(), `${credential.trim()}\n`, { mode: 0o600 });
  chmodSync(credentialPath(), 0o600);
}

export function deleteCredential(): void {
  rmSync(credentialPath(), { force: true });
}
