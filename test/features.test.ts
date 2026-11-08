import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { listSecretNames, saveSecret } from '../src/auth/secrets.ts';
import { ProcessManager } from '../src/tools/processes.ts';
import { formatModels, resolveModel } from '../src/ui/models.ts';
import { suggest } from '../src/ui/commands.ts';

const LIST = ['community/a/glm-5.3-flash-free', 'community/b/reflection-beam-free', 'community/c/minimax-m3.1-flash-free', 'community/d/glm-5.3-lite-free'];

before(() => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'multer-features-'));
});

test('modelo por número, por começo do nome e por parte', () => {
  assert.deepEqual(resolveModel('2', LIST), { kind: 'one', id: LIST[1] });
  assert.deepEqual(resolveModel('9', LIST), { kind: 'none' });
  assert.deepEqual(resolveModel('refl', LIST), { kind: 'one', id: LIST[1] });
  assert.deepEqual(resolveModel('MINIMAX', LIST), { kind: 'one', id: LIST[2] });
  assert.deepEqual(resolveModel('lite', LIST), { kind: 'one', id: LIST[3] });
  assert.deepEqual(resolveModel('glm', LIST), { kind: 'many', ids: [LIST[0], LIST[3]] });
  assert.deepEqual(resolveModel('glm-5.3-flash-free', LIST), { kind: 'one', id: LIST[0] });
  assert.deepEqual(resolveModel('xyz', LIST), { kind: 'none' });
  assert.match(formatModels(LIST, LIST[1]), /2 ● reflection-beam-free/);
});

test('comandos em português e em inglês levam ao mesmo lugar', () => {
  assert.equal(suggest('mod').length, 2);
  assert.ok(suggest('hel')[0].names.includes('ajuda'));
  assert.ok(suggest('team')[0].names.includes('equipe'));
  assert.ok(suggest('limp')[0].names.includes('clear'));
});

test('processo em segundo plano recebe o segredo e o token nunca aparece nos logs', async () => {
  saveSecret('DISCORD_TOKEN', 'token-de-teste-123456');
  assert.deepEqual(listSecretNames(), ['DISCORD_TOKEN']);
  assert.throws(() => saveSecret('minusculo', 'x'), /Nome inválido/);
  const manager = new ProcessManager(mkdtempSync(join(tmpdir(), 'multer-proc-')));
  const started = await manager.start('bot', 'echo "logado com $DISCORD_TOKEN"; sleep 30', ['DISCORD_TOKEN']);
  assert.equal(started.ok, true);
  assert.match(started.content, /logado com \*\*\*/);
  assert.ok(!started.content.includes('token-de-teste'));
  assert.equal((await manager.start('bot', 'true', [])).ok, false, 'nome repetido enquanto roda');
  assert.equal(manager.list()[0].running, true);
  assert.match((await manager.stop('bot')).summary, /parado/);
  assert.equal(manager.list()[0].running, false);
  const dead = await manager.start('quebrado', 'echo erro; exit 3', []);
  assert.equal(dead.ok, false);
  assert.match(dead.summary, /código 3/);
});

test('texto ao vivo cabe na tela do celular, contando a quebra de linha', async () => {
  const { tailThatFits } = await import('../src/ui/app.ts');
  const text = ['a'.repeat(100), 'linha 2', 'linha 3'].join('\n');
  assert.equal(tailThatFits(text, 40, 2), 'linha 2\nlinha 3');
  assert.equal(tailThatFits(text, 40, 5), text);
  assert.equal(tailThatFits('x'.repeat(200), 10, 3).length, 30);
});

test('o spinner mostra o nome da ferramenta, não o nome técnico', async () => {
  const { activityLabel } = await import('../src/ui/app.ts');
  assert.equal(activityLabel('Desenvolvedor', 'executando run_command'), 'Desenvolvedor · Comando…');
  assert.equal(activityLabel('Arquiteto', 'pensando', 'Matutando'), 'Arquiteto · Matutando…');
});

test('o logo MULTER cabe no celular na fonte pequena e alinha as linhas', async () => {
  const { logoRows, logoWidth } = await import('../src/ui/logo.ts');
  for (const font of ['big', 'small'] as const) {
    const widths = new Set(logoRows('MULTER', font).map((row) => Array.from(row).length));
    assert.equal(widths.size, 1);
  }
  assert.ok(logoWidth('small') <= 40);
});
