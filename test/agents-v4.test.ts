// A memória do turno, a retomada e o que evita tarefa falsa ou modelo preso.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asksToContinue, collapseRepeats, composeNote, streamIsLooping, TurnLedger } from '../src/agents/ledger.ts';
import { TEAM } from '../src/agents/team.ts';
import { attachPhone, notify } from '../src/phone.ts';
import { deleteBefore, deleteWord, inputAt, insert, move, splitAtCursor } from '../src/ui/input.ts';
import { EventEmitter } from 'node:events';
import type { Runtime } from '../src/agents/runtime.ts';

const agent = (id: string) => TEAM.find((member) => member.id === id)!;

test('o que foi lido fica em todo passo, e o arquivo alterado sai da memória', () => {
  const ledger = new TurnLedger(1000);
  for (const name of ['package.json', 'src/App.tsx', 'src/main.tsx', 'src/index.css']) ledger.remember(`read_file ${name}`, `conteúdo de ${name}`, name, name);
  assert.ok(ledger.render().includes('conteúdo de package.json'));
  ledger.changed('package.json');
  assert.ok(!ledger.render().includes('conteúdo de package.json'));
  assert.ok(ledger.render().includes('Arquivos alterados: package.json.'));
  assert.equal(ledger.has('package.json'), false);
});

test('a memória esquece o mais antigo quando passa do limite', () => {
  const ledger = new TurnLedger(10);
  ledger.remember('a', '12345678', 'chave-a');
  ledger.remember('b', '12345678', 'chave-b');
  assert.equal(ledger.has('chave-a'), false);
  assert.equal(ledger.has('chave-b'), true);
});

test('explorar sem agir é cobrado e depois bloqueado, conforme o papel', () => {
  const ledger = new TurnLedger(100);
  for (let i = 0; i < 5; i++) ledger.countRead();
  assert.equal(ledger.pressure(agent('desenvolvedor'), true), 'nudge');
  assert.equal(ledger.pressure(agent('revisor'), true), 'free');
  assert.equal(ledger.pressure(agent('arquiteto'), false), 'nudge');
  for (let i = 0; i < 5; i++) ledger.countRead();
  assert.equal(ledger.pressure(agent('desenvolvedor'), true), 'block');
  assert.equal(ledger.pressure(agent('desenvolvedor'), false), 'nudge', 'sem tarefa, só cobra');
  ledger.acted('bun install', true);
  assert.equal(ledger.pressure(agent('desenvolvedor'), true), 'free');
});

test('a nota resume resultados antigos e mantém os dois últimos', () => {
  const note = composeNote('Tarefa', '', ['um\ncorpo-um', 'dois\ncorpo-dois', 'tres\ncorpo-tres'], '');
  assert.ok(!note.includes('corpo-um') && note.includes('corpo-dois') && note.includes('corpo-tres'));
  assert.equal(composeNote('Tarefa', '', [], ''), 'Tarefa');
});

test('pedido curto de continuar é reconhecido', () => {
  assert.ok(asksToContinue('continua ai a tarefa'));
  assert.ok(!asksToContinue('como continuar?'));
  assert.ok(!asksToContinue('oi'));
});

test('modelo preso numa frase é detectado, e o texto fica com uma cópia', () => {
  const line = 'Vou buscar uma fonte atual com a cotação do dia.';
  assert.ok(!streamIsLooping(line.repeat(3)));
  assert.ok(streamIsLooping(`Vou abrir.\n\n${line.repeat(4)}`));
  assert.ok(!streamIsLooping('Sim. '.repeat(10)), 'frase curta pode repetir');
  assert.equal(collapseRepeats(line.repeat(5)), line);
  const code = '```\nconsole.log("uma linha bem comprida aqui.");\nconsole.log("uma linha bem comprida aqui.");\n```';
  assert.equal(collapseRepeats(code), code);
});

test('caixa de texto: cursor, apagar e emoji', () => {
  let state = inputAt('oi😀');
  state = deleteBefore(state);
  assert.equal(state.text, 'oi', 'emoji sai inteiro');
  state = insert(move(state, -1), 'X');
  assert.deepEqual(state, { text: 'oXi', cursor: 2 });
  assert.deepEqual(splitAtCursor(state), ['oX', 'i', '']);
  assert.equal(deleteWord(inputAt('uma frase  ')).text, 'uma ');
  assert.equal(move(inputAt('a'), 5).cursor, 1);
});

test('celular: trava só enquanto trabalha, e sem as ferramentas nada roda', () => {
  const calls: string[] = [];
  const runtime = new EventEmitter() as unknown as Runtime;
  const release = attachPhone(runtime, (command) => calls.push(command), () => true);
  runtime.emit('busy', true);
  runtime.emit('busy', true);
  assert.deepEqual(calls, ['termux-wake-lock']);
  runtime.emit('busy', false);
  assert.deepEqual(calls, ['termux-wake-lock', 'termux-wake-unlock'], 'tarefa curta não notifica');
  runtime.emit('busy', true);
  release();
  assert.equal(calls.at(-1), 'termux-wake-unlock');
  const none: string[] = [];
  notify('a', 'b', (command) => none.push(command), () => false);
  assert.deepEqual(none, []);
});
