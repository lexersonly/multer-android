import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announcesAction, parseResponse, ReasoningFilter, streamView, stripReasoning, toolCallWasCut } from '../src/agents/parser.ts';

test('entende as variações de tag', () => {
  for (const raw of [
    '<tool name="write_file">{"path": "a.txt", "content": "oi"}</tool>',
    '<tool write_file> {"path": "a.txt", "content": "oi"}</tool>',
    '<tool name=write_file>{"path": "a.txt", "content": "oi"}</tool>',
    '<tool:write_file>{"path": "a.txt", "content": "oi"}</tool>',
    '</tool name="write_file">{"path": "a.txt", "content": "oi"}',
    'Vou criar. <tool write_file>{"path": "a.txt", "content": "oi"}',
    '[tool name="write_file"]{"path": "a.txt", "content": "oi"}[/tool]',
    '<write_file>{"path": "a.txt", "content": "oi"}</write_file>',
  ]) {
    const { tool } = parseResponse(raw);
    assert.equal(tool?.name, 'write_file', raw);
    assert.equal(tool?.args.path, 'a.txt', raw);
  }
  assert.equal(parseResponse('<div>{x}</div> normal').tool, undefined);
});

test('conserta arquivo com aspas sem escape', () => {
  const raw = 'Vou criar.<tool name="write_file">{"path":"game.py","content":""""Jogo"""\\nprint("oi")\\n"}</tool>';
  const parsed = parseResponse(raw);
  assert.equal(parsed.tool?.args.content, '"""Jogo"""\nprint("oi")\n');
  assert.equal(parsed.text, 'Vou criar.');
  assert.equal(parsed.parseError, undefined);
});

test('chamada cortada não vira texto nem arquivo', () => {
  const parsed = parseResponse('Vou criar.<tool name="write_file">{"path":"game.py","content":"def main():\\n  print(');
  assert.equal(parsed.tool, undefined);
  assert.equal(parsed.text, 'Vou criar.');
  assert.match(parsed.parseError ?? '', /incompleto/);
});

test('argumentos soltos viram write_file', () => {
  const parsed = parseResponse('Vamos lá.\n{"path":"/p/game.py","content":"x\\n"}"}"\nPronto.');
  assert.equal(parsed.tool?.name, 'write_file');
  assert.equal(parsed.tool?.args.content, 'x\n');
  assert.equal(parsed.text, 'Vamos lá.\n\nPronto.');
});

test('json em bloco, solto e tool_call', () => {
  assert.equal(parseResponse('Veja.\n```json\n{"name":"list_files","arguments":{}}\n```').tool?.name, 'list_files');
  assert.equal(parseResponse('{"name":"list_files","arguments":{"depth":2}}').tool?.args.depth, 2);
  assert.equal(parseResponse('<tool_call>{"name":"list_files","arguments":{}}</tool_call>').tool?.name, 'list_files');
  assert.deepEqual(parseResponse('<tool name="list_files"></tool>').tool?.args, {});
});

test('chamadas extras somem do texto', () => {
  const parsed = parseResponse('Vou criar.\n<tool write_file>{"path": "a.txt", "content": "x"}</tool>\n<tool list_files>{"depth": 1}</tool>');
  assert.equal(parsed.tool?.name, 'write_file');
  assert.equal(parsed.text, 'Vou criar.');
});

test('esconde raciocínio e eco', () => {
  assert.equal(stripReasoning('<think>\nprivado\n</think>\n\nOlá!'), 'Olá!');
  assert.equal(stripReasoning('antes<think>cortado'), 'antes');
  const filter = new ReasoningFilter();
  const out = ['<th', 'ink>segredo</thi', 'nk>', '\n\nOi', ' <', 'b>'].map((chunk) => filter.push(chunk)).join('');
  assert.equal(out, 'Oi <b>');
  assert.equal(parseResponse('[runtime] O usuário enviou:\n\n@Dev continua\n\nVou continuar. </r>').text, 'Vou continuar.');
  assert.equal(parseResponse('Feito.\n\n## Resultados reais das ferramentas nesta rodada\n+<html>').text, 'Feito.');
});

test('streaming não mostra ferramenta nem raciocínio', () => {
  assert.equal(streamView('<think>x</think>Vou ler.<tool name="read_file">{"pa'), 'Vou ler.');
  assert.equal(streamView('Vou ler.<read_file>{"path"'), 'Vou ler.');
  assert.equal(streamView('Vou ler. <to'), 'Vou ler. ');
  assert.equal(streamView('Texto comum'), 'Texto comum');
});

test('percebe corte no limite de tokens', () => {
  const cut = '<tool name="write_file">{"path":"a.html","content":"<div>';
  assert.ok(toolCallWasCut(cut, 8192, 8192));
  assert.ok(!toolCallWasCut(cut, 500, 8192));
  assert.ok(!toolCallWasCut('<tool name="read_file">{"path":"a"}</tool>', 8192, 8192));
  assert.ok(!toolCallWasCut('Um texto longo, sem ferramenta.', 8192, 8192));
  assert.ok(toolCallWasCut(cut + 'x'.repeat(20_000), 0, 8192));
  assert.ok(!toolCallWasCut(cut, 0, 8192));
});

test('percebe promessa sem ferramenta', () => {
  assert.ok(announcesAction('O site está claro para mim; vou delegar ao Desenvolvedor o redesenho.'));
  assert.ok(announcesAction('Li o arquivo.\nVou ler o restante agora.'));
  assert.ok(announcesAction('Delegarei ao Revisor.'));
  assert.ok(!announcesAction('Olá! Como posso ajudar com o projeto hoje?'));
  assert.ok(!announcesAction('Vou mudar o título, pode ser?'));
  assert.ok(!announcesAction('Vou explicar: o site tem 3 páginas. Terminei.'));
  assert.ok(!announcesAction('Não vou alterar nada.'));
  assert.ok(!announcesAction('O redesenho foi entregue.'));
});
