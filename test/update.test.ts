import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { checkForUpdate, isNewer, localVersion } from '../src/update.ts';

test('compara versões número a número', () => {
  assert.ok(isNewer('0.10.0', '0.9.0'));
  assert.ok(isNewer('1.0.0', '0.99.9'));
  assert.ok(!isNewer('0.3.0', '0.3.0'));
  assert.ok(!isNewer('0.2.9', '0.3.0'));
});

test('avisa quando há versão nova e fica quieto sem internet', async () => {
  const server = createServer((_, res) => res.end(JSON.stringify({ version: '99.0.0' })));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.MULTER_UPDATE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const found = await checkForUpdate();
  assert.deepEqual(found, { current: localVersion(), latest: '99.0.0', available: true });
  server.close();
  process.env.MULTER_UPDATE_URL = 'http://127.0.0.1:1';
  assert.equal(await checkForUpdate(), null);
});
