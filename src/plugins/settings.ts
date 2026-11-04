import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../auth/credentials.ts';

export interface Settings {
  model?: string;
  reaEnabled?: boolean;
}

const settingsPath = () => join(configDir(), 'settings.json');

export function loadSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8')) as Settings;
  } catch {
    return {};
  }
}

export function saveSettings(patch: Settings): Settings {
  const next = { ...loadSettings(), ...patch };
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
