// Alternativa sem depuração do Android: o login para terminais do próprio
// Pollinations (device flow, RFC 8628). Devolve uma chave sk_, não os cookies.

const authBase = () => process.env.MULTER_AUTH_URL || 'https://enter.pollinations.ai';

interface DeviceCode {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface DeviceToken {
  access_token?: string;
  error?: string;
  error_description?: string;
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; value: T }> {
  const response = await fetch(`${authBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  try {
    return { status: response.status, value: JSON.parse(text) as T };
  } catch {
    return { status: response.status, value: {} as T };
  }
}

export interface DeviceLoginOptions {
  onCode: (code: { userCode: string; url: string }) => void;
  signal?: AbortSignal;
  /** Encurta a espera entre consultas, nos testes. */
  pollScale?: number;
}

export async function deviceLogin({ onCode, signal, pollScale = 1 }: DeviceLoginOptions): Promise<string> {
  const { status, value: code } = await postJson<DeviceCode>('/api/device/code', {}, signal);
  if (status >= 400 || !code.device_code) throw new Error(`O Pollinations recusou o login (erro ${status}).`);
  onCode({ userCode: code.user_code ?? '', url: code.verification_uri_complete ?? code.verification_uri ?? '' });
  const deadline = Date.now() + (code.expires_in ?? 1800) * 1000;
  const interval = (code.interval ?? 5) * 1000 * pollScale;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Login cancelado.'));
      }, { once: true });
    });
    const { value } = await postJson<DeviceToken>('/api/device/token', { device_code: code.device_code }, signal);
    if (value.access_token) return value.access_token;
    if (value.error && value.error !== 'authorization_pending' && value.error !== 'slow_down') {
      throw new Error(`Login não concluído: ${value.error_description ?? value.error}.`);
    }
  }
  throw new Error('O código de login expirou. Tente de novo.');
}
