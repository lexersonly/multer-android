// Segredos como o token de um bot do Discord. O agente só sabe o NOME: o valor
// vai direto para o ambiente do processo e nunca volta para o modelo.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './credentials.ts';

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

const secretsPath = () => join(configDir(), 'secrets.json');

function read(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(secretsPath(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function write(secrets: Record<string, string>): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(secretsPath(), JSON.stringify(secrets, null, 2), { mode: 0o600 });
  chmodSync(secretsPath(), 0o600);
}

export const listSecretNames = (): string[] => Object.keys(read()).sort();

export function getSecrets(names: string[]): Record<string, string> {
  const all = read();
  return Object.fromEntries(names.filter((name) => name in all).map((name) => [name, all[name]]));
}

export function saveSecret(name: string, value: string): void {
  if (!SECRET_NAME.test(name)) throw new Error('Nome inválido: use MAIÚSCULAS, números e _, como DISCORD_TOKEN.');
  const clean = value.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!clean) throw new Error('Nada colado.');
  write({ ...read(), [name]: clean });
}

export function deleteSecret(name: string): boolean {
  const all = read();
  if (!(name in all)) return false;
  delete all[name];
  write(all);
  return true;
}
