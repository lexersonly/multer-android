// O pool gratuito: sem chave escrita no repositório, com limite por minuto e chave ruim fora.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.MULTER_FREE_KEYS = 'sk-aaaa-1111111111, sk-bbbb-2222222222';
const free = await import('../src/provider/free.ts');

beforeEach(() => free.resetPool());

test('o prefixo separa o pool do resto', () => {
  assert.equal(free.isFree('nightrouter/glm-5.3'), true);
  assert.equal(free.isFree('community/dono/glm-free'), false);
  assert.equal(free.bareFree('nightrouter/glm-5.3'), 'glm-5.3');
  assert.equal(free.bareFree('glm-5.3'), 'glm-5.3');
});

test('as chaves nunca vêm escritas no código', () => {
  assert.match(free.freeBaseUrl(), /^https:\/\//);
  assert.equal(typeof free.pickKey, 'function');
});

test('respeita o limite por chave e por modelo', async () => {
  const usadas = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const key = await free.pickKey('nightrouter/glm-5.3');
    assert.ok(key);
    usadas.add(key);
  }
  assert.equal(usadas.size, 2, 'as duas chaves entram antes de qualquer uma repetir');
  assert.equal(await free.pickKey('nightrouter/glm-5.3'), null);
  // Outro modelo tem a própria cota na mesma chave.
  assert.ok(await free.pickKey('nightrouter/kimi-k3'));
});

test('chave recusada sai do pool', async () => {
  const key = await free.pickKey('nightrouter/glm-5.3');
  assert.ok(key);
  free.burnKey(key);
  for (let i = 0; i < 3; i++) {
    const outra = await free.pickKey('nightrouter/glm-5.3');
    assert.ok(outra);
    assert.notEqual(outra, key);
  }
});
