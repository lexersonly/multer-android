// O token colado, contra um servidor local que responde como o Pollinations.
// Os valores aqui são de mentira.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { deleteCredential, loadCredential } from '../src/auth/credentials.ts';
import { normalizeToken, saveToken } from '../src/auth/token-login.ts';

const TOKEN = 'token=jwt-de-teste; oauth_session_id=sessao-de-teste';

let server: Server;
let status = 200;
let seen: IncomingHttpHeaders | undefined;

before(async () => {
  server = createServer((req, res) => {
    seen = req.headers;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(status === 200 ? '{"data":[]}' : '{"detail":"recusado"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.MULTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'multer-token-'));
  delete process.env.POLLINATIONS_API_KEY;
});

beforeEach(() => {
  status = 200;
  deleteCredential();
});

after(() => server.close());

test('aceita o formato do app e limpa a colagem', () => {
  assert.equal(normalizeToken(TOKEN), TOKEN);
  assert.equal(normalizeToken(`  "${TOKEN}"\n`), TOKEN);
  assert.equal(normalizeToken('sk_chave_de_teste'), 'sk_chave_de_teste');
});

test('recusa o que o Pollinations recusaria, sem repetir o valor', () => {
  for (const bad of ['token=jwt-de-teste', 'jwt-solto-de-teste', 'token=jwt-de-teste; oauth_session_id=None']) {
    assert.throws(() => normalizeToken(bad), (err: Error) => {
      assert.match(err.message, /oauth_session_id/);
      assert.ok(!err.message.includes('jwt'));
      return true;
    }, bad);
  }
  assert.throws(() => normalizeToken('   '), /Nada colado/);
});

test('token aceito é guardado e vai como Bearer e Cookie, igual ao app', async () => {
  assert.deepEqual(await saveToken(TOKEN), { verified: true });
  assert.equal(loadCredential(), TOKEN);
  assert.equal(seen?.authorization, 'Bearer jwt-de-teste');
  assert.equal(seen?.cookie, TOKEN);
});

test('token recusado não é guardado', async () => {
  status = 401;
  await assert.rejects(saveToken(TOKEN), /recusou este token/);
  assert.equal(loadCredential(), null);
});

test('erro do servidor não guarda nem finge que deu certo', async () => {
  status = 500;
  await assert.rejects(saveToken(TOKEN), /não conseguiu conferir/);
  assert.equal(loadCredential(), null);
});

test('sem internet guarda e avisa que não conferiu', async () => {
  const base = process.env.MULTER_BASE_URL;
  process.env.MULTER_BASE_URL = 'http://127.0.0.1:1';
  try {
    assert.deepEqual(await saveToken(TOKEN), { verified: false });
    assert.equal(loadCredential(), TOKEN);
  } finally {
    process.env.MULTER_BASE_URL = base;
  }
});
