// O token vem colado do APK do Multer, que faz o login no Pollinations e lê os
// cookies da sessão: `token=<jwt>; oauth_session_id=<id>`, o formato que o app usa.

import { checkCredential, type ProviderError, parseCredential } from '../provider/client.ts';
import { saveCredential } from './credentials.ts';

const MISSING_SESSION = 'O token veio sem o oauth_session_id, e sem ele o Pollinations recusa os modelos. Copie de novo pelo botão Copiar do APK.';

/** Limpa a colagem e recusa o que não pode funcionar. Devolve a credencial ou lança o motivo. */
export function normalizeToken(pasted: string): string {
  // Colar pode trazer espaços, quebras de linha ou aspas em volta.
  const token = pasted.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!token) throw new Error('Nada colado.');
  if (/^sk[-_]/.test(token)) return token;
  const { cookie } = parseCredential(token);
  if (!cookie || !/(^|;\s*)oauth_session_id=/.test(cookie)) throw new Error(MISSING_SESSION);
  return token;
}

/** Confere no Pollinations e só então guarda. Sem internet, guarda e avisa: dá para conferir depois. */
export async function saveToken(pasted: string): Promise<{ verified: boolean }> {
  const token = normalizeToken(pasted);
  try {
    await checkCredential(token);
  } catch (err) {
    const { status, message } = err as ProviderError;
    if (status === 401 || status === 403) throw new Error('O Pollinations recusou este token. Faça login de novo no APK e copie outra vez.');
    if (status) throw new Error(`O Pollinations não conseguiu conferir o token agora: ${message}`);
    saveCredential(token);
    return { verified: false };
  }
  saveCredential(token);
  return { verified: true };
}
