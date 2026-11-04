// Fluxos de ponta a ponta contra um servidor local de verdade, que fala SSE como o
// provedor. Nada aqui usa a internet nem credencial real.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../src/agents/runtime.ts';
import { buildContext, buildSystemPrompt, TEAM } from '../src/agents/team.ts';
import { loadCredential, saveCredential } from '../src/auth/credentials.ts';
import { deviceLogin } from '../src/auth/device-login.ts';
import { McpClient } from '../src/plugins/mcp-client.ts';
import { nodeMeetsRea, Plugins } from '../src/plugins/plugins.ts';
import { chat, freeTextModels, parseCredential, sanitizeError } from '../src/provider/client.ts';
import { approvalFor } from '../src/tools/approval.ts';
import { runLocalTool } from '../src/tools/local.ts';
import type { ApprovalRequest, Approver, HistoryItem, ToolArgs, UiLine } from '../src/types.ts';

type Step = string | { text: string; usage?: object; delay?: number } | { status: number; body: string };

interface SeenBody {
  stream: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  features?: unknown;
  messages: Array<{ content: string }>;
}

let server: Server;
let script: Step[] = [];
let requests: Array<{ headers: IncomingHttpHeaders; body: SeenBody }> = [];
let polls = 0;
let catalog: Array<{ id: string; category: string }> = [{ id: 'community/x/m-free', category: 'text' }];

function sse(content: string, usage?: object): string {
  const pieces = content.match(/[\s\S]{1,12}/g) ?? [];
  const events = pieces.map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  if (usage) events.push(`data: ${JSON.stringify({ usage })}\n\n`);
  return `${events.join('')}data: [DONE]\n\n`;
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      if (req.url === '/api/device/code') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://x/device', verification_uri_complete: 'https://x/device?c', expires_in: 60, interval: 5 }));
        return;
      }
      if (req.url === '/api/device/token') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(++polls < 2 ? { error: 'authorization_pending' } : { access_token: 'sk_teste', token_type: 'bearer' }));
        return;
      }
      if (req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: catalog }));
        return;
      }
      requests.push({ headers: req.headers, body: JSON.parse(body) as SeenBody });
      const step = script.shift();
      if (step === undefined) {
        res.statusCode = 500;
        res.end('{"error":{"message":"roteiro acabou"}}');
      } else if (typeof step === 'object' && 'status' in step) {
        res.statusCode = step.status;
        res.end(step.body);
      } else {
        res.setHeader('Content-Type', 'text/event-stream');
        const payload = typeof step === 'string' ? sse(step) : sse(step.text, step.usage);
        const delay = typeof step === 'object' && 'delay' in step ? step.delay ?? 0 : 0;
        setTimeout(() => res.end(payload), delay);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.MULTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.MULTER_AUTH_URL = process.env.MULTER_BASE_URL;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'multer-config-'));
  delete process.env.POLLINATIONS_API_KEY;
});

after(() => server.close());

function setup({ approve = async () => 'yes', plugins, leadTimeoutMs }: { approve?: Approver; plugins?: Plugins; leadTimeoutMs?: number } = {}) {
  script = [];
  requests = [];
  const root = mkdtempSync(join(tmpdir(), 'multer-projeto-'));
  const lines: UiLine[] = [];
  const runtime = new Runtime({ root, plugins, getCredential: () => 'sk_teste', model: 'm', maxTokens: 100, approve, leadTimeoutMs });
  runtime.on('line', (line) => lines.push(line));
  return { root, runtime, lines };
}

const tool = (name: string, args: ToolArgs) => `<tool name="${name}">${JSON.stringify(args)}</tool>`;
const textOf = (line: UiLine | undefined) => (line && 'text' in line ? line.text : '');
const lastNote = (index: number) => requests[index].body.messages.at(-1)?.content ?? '';

test('equipe inteira: arquiteto delega e a revisão e o teste vêm sozinhos', async () => {
  const { root, runtime, lines } = setup();
  script = [
    `Vou delegar. ${tool('assign_task', { title: 'Criar site', assignee: 'desenvolvedor' })}`,
    'Entreguei ao Desenvolvedor.',
    tool('write_file', { path: 'index.html', content: '<h1>Oi</h1>' }),
    tool('update_task', { status: 'completed', result: 'index.html criado' }),
    tool('read_file', { path: 'index.html' }),
    tool('submit_review', { approved: true, summary: 'Tudo certo' }),
    'Testei abrindo o arquivo: está certo.',
    'A tarefa foi concluída e aprovada.',
  ];
  await runtime.send('crie um site');
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), '<h1>Oi</h1>');
  assert.deepEqual(runtime.tasks.map((task) => `${task.assignee}:${task.status}`), ['desenvolvedor:completed', 'revisor:completed', 'testador:completed']);
  assert.match(runtime.tasks[0].description, /crie um site/, 'o desenvolvedor recebe o pedido inteiro');
  assert.ok(lines.some((line) => line.type === 'review' && line.approved));
  assert.equal(textOf(lines.at(-1)), 'A tarefa foi concluída e aprovada.');
  assert.equal(script.length, 0);
  assert.equal(requests[0].headers.authorization, 'Bearer sk_teste');
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.features, undefined);
});

test('o streaming chega em pedaços e sem a chamada de ferramenta', async () => {
  const { runtime } = setup();
  const seen: string[] = [];
  runtime.on('delta', (delta) => {
    if (delta) seen.push(delta.text);
  });
  script = ['Oi, tudo bem com você hoje? Espero que sim.'];
  await runtime.send('oi');
  assert.ok(seen.length > 1);
  assert.equal(seen.at(-1), 'Oi, tudo bem com você hoje? Espero que sim.');
  script = [`Vou ler isso.${tool('read_file', { path: 'nao-existe' })}`, 'Não existe.'];
  seen.length = 0;
  await runtime.send('leia');
  assert.ok(seen.every((text) => !text.includes('tool')), seen.join('|'));
});

test('promessa sem ferramenta recebe lembrete e depois chama', async () => {
  const { runtime, lines } = setup();
  script = ['Vou delegar ao Desenvolvedor.', tool('assign_task', { title: 'X', assignee: 'desenvolvedor' }), 'Feito.', tool('update_task', { status: 'completed', result: 'ok' }), 'Concluído.'];
  await runtime.send('faça');
  assert.match(lastNote(1), /não chamou ferramenta/);
  assert.equal(runtime.tasks.length, 1);
  assert.equal(textOf(lines.at(-1)), 'Concluído.');
});

test('resposta cortada no limite pede gravação em partes, sem gravar nada', async () => {
  const { root, runtime, lines } = setup();
  script = [
    { text: '<tool name="write_file">{"path":"a.html","content":"<div>', usage: { completion_tokens: 100 } },
    tool('write_file', { path: 'a.html', content: 'parte 1\n' }),
    tool('append_file', { path: 'a.html', content: 'parte 2\n' }),
    'Gravei.',
  ];
  await runtime.send('@desenvolvedor grave um arquivo grande');
  assert.match(lastNote(1), /foi cortada: nada foi gravado/);
  assert.equal(readFileSync(join(root, 'a.html'), 'utf8'), 'parte 1\nparte 2\n');
  assert.ok(lines.some((line) => line.type === 'status' && /cortada/.test(line.text)));
});

test('comando perigoso pede aprovação; recusa não executa', async () => {
  const asked: ApprovalRequest[] = [];
  const { root, runtime } = setup({ approve: async (request) => { asked.push(request); return 'no'; } });
  writeFileSync(join(root, 'alvo.txt'), 'x');
  script = [tool('run_command', { command: 'rm -rf alvo.txt' }), 'Recusado, parei.'];
  await runtime.send('@desenvolvedor apague');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].offerAlways, false);
  assert.ok(existsSync(join(root, 'alvo.txt')));
  assert.match(lastNote(1), /recusou/);
});

test('comando aprovado roda de verdade e não recebe a chave', async () => {
  const { root, runtime } = setup();
  process.env.POLLINATIONS_API_KEY = 'sk_nao_vaza';
  script = [tool('run_command', { command: 'echo "chave=$POLLINATIONS_API_KEY" > saida.txt' }), 'Pronto.'];
  await runtime.send('@testador rode');
  delete process.env.POLLINATIONS_API_KEY;
  assert.equal(readFileSync(join(root, 'saida.txt'), 'utf8'), 'chave=\n');
});

test('papel limita ferramenta: o líder não grava', async () => {
  const { root, runtime } = setup();
  script = [tool('write_file', { path: 'x.txt', content: 'x' }), 'Certo.'];
  await runtime.send('grave');
  assert.ok(!existsSync(join(root, 'x.txt')));
  assert.match(lastNote(1), /não usa write_file/);
});

test('modelo preso é encerrado pelo detector de repetição', async () => {
  const { runtime, lines } = setup();
  const same = tool('read_file', { path: 'a.txt' });
  script = [same, same, same];
  await runtime.send('leia');
  assert.ok(lines.some((line) => /repetiu a mesma chamada/.test(textOf(line))));
});

test('erro 401 orienta o login e não mostra a chave', async () => {
  const { runtime, lines } = setup();
  script = [{ status: 401, body: '{"error":{"message":"bad key sk_abcdefghijkl"}}' }];
  await runtime.send('oi');
  const message = textOf(lines.find((line) => line.type === 'error'));
  assert.match(message, /\/login/);
  assert.ok(!message.includes('sk_abcdefghijkl'));
});

test('cancelar interrompe o comando em andamento', async () => {
  const { runtime, lines } = setup();
  script = [tool('run_command', { command: 'sleep 30' })];
  const running = runtime.send('@testador espere');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const start = Date.now();
  runtime.cancel();
  await running;
  assert.ok(Date.now() - start < 5000);
  assert.ok(lines.some((line) => textOf(line) === 'Cancelado.'));
});

test('ferramentas ficam presas à pasta e longe de credenciais', async () => {
  const root = mkdtempSync(join(tmpdir(), 'multer-tools-'));
  const fora = mkdtempSync(join(tmpdir(), 'multer-fora-'));
  writeFileSync(join(fora, 'segredo.txt'), 's');
  symlinkSync(fora, join(root, 'link'));
  assert.match((await runLocalTool('read_file', root, { path: '../x' })).summary, /fora da pasta/);
  assert.match((await runLocalTool('read_file', root, { path: '/etc/passwd' })).summary, /fora da pasta/);
  assert.match((await runLocalTool('read_file', root, { path: 'link/segredo.txt' })).summary, /fora da pasta/);
  assert.match((await runLocalTool('write_file', root, { path: 'link/novo.txt', content: 'x' })).summary, /fora da pasta/);
  assert.match((await runLocalTool('write_file', root, { path: '.env', content: 'x' })).summary, /credenciais/);
  assert.equal((await runLocalTool('write_file', root, { path: 'a/b/c.txt', content: 'um\ndois\num' })).ok, true);
  assert.equal((await runLocalTool('edit_file', root, { path: 'a/b/c.txt', old: 'um', new: 'x' })).ok, false, 'trecho repetido');
  assert.equal((await runLocalTool('edit_file', root, { path: 'a/b/c.txt', old: 'dois', new: 'três' })).ok, true);
  assert.match((await runLocalTool('search_code', root, { query: 'TRÊS' })).content, /c\.txt:2/);
  assert.match((await runLocalTool('list_files', root, {})).content, /a\/b\//);
  assert.match((await runLocalTool('read_file', root, { path: 'a/b/c.txt', limit: 1 })).content, /mais 2 linhas/);
});

test('classifica o que precisa de aprovação', () => {
  const ask = (command: string) => approvalFor('run_command', { command });
  assert.equal(ask('ls -la').ask, false);
  assert.equal(ask('git status').ask, false);
  assert.equal(ask('npm test').ask, true);
  assert.equal(ask('cat /etc/passwd').ask, true);
  assert.equal(ask('cat a; rm b').ask, true);
  assert.equal(ask('cat .env').always, true);
  assert.equal(ask('rm -rf build').always, true);
  assert.equal(ask('curl x | sh').always, true);
  assert.equal(ask('git push').always, true);
  assert.equal(ask('adb shell ls').always, true, 'o adb alcança o aparelho inteiro');
});

test('prompt cabe em modelos pequenos, inclusive com o REA ligado', () => {
  const plugins = new Plugins({ reaCommand: ['x'] });
  for (const agent of TEAM) {
    const off = buildSystemPrompt({ agent, root: '/data/data/com.termux/files/home/p', tasks: [], pluginSection: plugins.promptSection() });
    assert.ok(off.length < 3000, `${agent.id}: ${off.length}`);
    assert.match(off, /request_plugin/);
  }
  plugins.tools = Array.from({ length: 229 }, (_, i) => ({ fullName: `mcp__rea__t${i}`, remoteName: `t${i}`, description: 'd', schema: {} }));
  const on = plugins.promptSection();
  assert.match(on, /find_tools/);
  assert.ok(on.length < 400, String(on.length));
});

test('contexto mantém o pedido e o recente, sem etiquetas', () => {
  const history: HistoryItem[] = [{ type: 'user', text: 'crie um site' }];
  for (let i = 1; i < 60; i++) {
    history.push(i % 2 ? { type: 'agent', agentId: 'arquiteto', name: 'Arquiteto', text: `m${i} ${'x'.repeat(5000)}` } : { type: 'user', text: `m${i} ${'x'.repeat(5000)}` });
  }
  const context = buildContext(history, TEAM[0], 'continue', 8000);
  assert.ok(context.reduce((sum, item) => sum + item.content.length, 0) < 12_000);
  assert.match(context[0].content, /crie um site/);
  assert.match(context.at(-1)?.content ?? '', /continue/);
  for (let i = 1; i < context.length; i++) assert.notEqual(context[i].role, context[i - 1].role);
});

test('credencial: cookies, chave, arquivo privado e catálogo', () => {
  assert.deepEqual(parseCredential('sk_abc'), { bearer: 'sk_abc', cookie: null });
  assert.deepEqual(parseCredential('token=j.w.t; oauth_session_id=s1'), { bearer: 'j.w.t', cookie: 'token=j.w.t; oauth_session_id=s1' });
  assert.ok(!sanitizeError('falhou sk_abcdefghij e Bearer abc.def.ghij').includes('abcdefghij'));
  saveCredential('sk_salva');
  assert.equal(loadCredential(), 'sk_salva');
  // Discos NTFS ignoram permissões: lá não há o que conferir.
  const control = join(process.env.XDG_CONFIG_HOME ?? '', 'controle');
  writeFileSync(control, '', { mode: 0o600 });
  if ((statSync(control).mode & 0o777) === 0o600) {
    assert.equal(statSync(join(process.env.XDG_CONFIG_HOME ?? '', 'multer-android', 'credential')).mode & 0o777, 0o600);
  }
  assert.deepEqual(freeTextModels({ data: [
    { id: 'community/a/x-free', category: 'text', paid_only: false },
    { id: 'community/a/flux-free', category: 'image', paid_only: false },
    { id: 'community/a/voice-free', category: 'text', paid_only: true },
    { id: 'openai/gpt', category: 'text', paid_only: false },
  ] }), ['community/a/x-free']);
});

test('credencial de cookies vai como Bearer e Cookie, com a memória da conta', async () => {
  script = ['ok'];
  requests = [];
  await chat({ credential: 'token=jwt; oauth_session_id=s1', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 50 });
  assert.equal(requests[0].headers.authorization, 'Bearer jwt');
  assert.equal(requests[0].headers.cookie, 'token=jwt; oauth_session_id=s1');
  assert.deepEqual(requests[0].body.features, { memory: true });
});

test('login por chave espera a aprovação e devolve a chave', async () => {
  let shown: { userCode: string; url: string } | undefined;
  const key = await deviceLogin({ onCode: (code) => { shown = code; }, pollScale: 0.01 });
  assert.equal(key, 'sk_teste');
  assert.equal(shown?.userCode, 'ABCD-1234');
  assert.equal(shown?.url, 'https://x/device?c');
});

test('parâmetro recusado: tenta de novo com max_completion_tokens', async () => {
  script = [{ status: 400, body: '{"error":{"message":"Unsupported parameter: max_tokens"}}' }, 'ok'];
  requests = [];
  const result = await chat({ credential: 'sk', model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 50 });
  assert.equal(result.content, 'ok');
  assert.equal(requests[1].body.max_completion_tokens, 50);
  assert.equal(requests[1].body.max_tokens, undefined);
});

test('exige do Node o que o REA 6.8.0 exige', () => {
  for (const good of ['24.22.1', '24.22.2', '22.23.4', '26.12.1', '26.13.0', '27.0.0']) assert.ok(nodeMeetsRea(good), good);
  for (const bad of ['24.20.0', '24.19.0', '22.13.0', '25.9.0', '26.12.0', '20.0.0']) assert.ok(!nodeMeetsRea(bad), bad);
});

function fakeMcpServer(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'multer-mcp-')), 'server.mjs');
  writeFileSync(path, `
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === 'initialize' ? { protocolVersion: '2025-03-26' }
    : m.method === 'tools/list' ? { tools: [{ name: 'inspect-bytes', description: 'inspect bytes', inputSchema: { properties: { p: { type: 'string' } } } }] }
    : { content: [{ type: 'text', text: 'eco ' + m.params.arguments.p }, { type: 'image' }] };
  process.stdout.write('aviso solto\\n' + JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});`);
  return path;
}

test('REA começa desligado, liga com autorização e acha ferramenta com find_tools', async () => {
  const plugins = new Plugins({ reaCommand: [process.execPath, fakeMcpServer()] });
  assert.equal(plugins.enabled, false);
  const decisions: string[] = [];
  const { runtime } = setup({ plugins, approve: async (request) => { decisions.push(request.tool); return 'yes'; } });

  script = [tool('mcp__rea__inspect_bytes', { p: 'a' }), 'Sem plugin.'];
  await runtime.send('@desenvolvedor analise');
  assert.match(lastNote(1), /request_plugin/);
  assert.deepEqual(decisions, [], 'sem autorização nada liga');

  script = [
    tool('request_plugin', { plugin: 'rea', reason: 'analisar bytes' }),
    tool('find_tools', { query: 'inspect bytes' }),
    tool('mcp__rea__inspect_bytes', { p: 'oi' }),
    'Analisei.',
  ];
  requests = [];
  await runtime.send('@desenvolvedor analise');
  assert.deepEqual(decisions, ['request_plugin']);
  assert.equal(plugins.enabled, true);
  assert.match(lastNote(2), /mcp__rea__inspect_bytes/);
  assert.match(lastNote(3), /eco oi\n\[conteúdo do tipo image\]/);

  plugins.disable();
  assert.equal(plugins.enabled, false);
  assert.equal(plugins.tools.length, 0);
});

test('plugin que morre vira erro, não trava', async () => {
  const client = new McpClient(process.execPath, ['-e', 'process.exit(3)']);
  await assert.rejects(client.listTools('x'), /encerrou/);
});

test('a linha de comando responde sem terminal', () => {
  const bin = fileURLToPath(new URL('../bin/multer.js', import.meta.url));
  const env = { ...process.env };
  assert.match(execFileSync(process.execPath, [bin, '--versao'], { env, encoding: 'utf8' }), /multer-android/);
  const doctor = execFileSync(process.execPath, [bin, '--doutor'], { env, encoding: 'utf8' });
  assert.match(doctor, /REA 6\.8\.0 instalado/);
  assert.ok(!doctor.includes('adb'), 'o login não usa mais adb');
  assert.ok(!doctor.includes('sk_salva'), 'nunca mostra a credencial');
});

test('arquiteto que demora: o pedido vai direto ao desenvolvedor', async () => {
  const { root, runtime, lines } = setup({ leadTimeoutMs: 150 });
  script = [
    { text: 'pensando muito...', delay: 600 },
    tool('write_file', { path: 'a.txt', content: 'oi' }),
    tool('update_task', { status: 'completed', result: 'feito' }),
    tool('submit_review', { approved: true, summary: 'ok' }),
    'Testado.',
    'Pronto, criei o a.txt.',
  ];
  await runtime.send('crie um a.txt');
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'oi');
  assert.ok(lines.some((line) => textOf(line).includes('demorou mais de')));
  assert.equal(runtime.tasks.length, 3);
});

test('modelo que a conta não conhece: troca sozinho e segue', async () => {
  const { runtime, lines } = setup();
  runtime.model = 'modelo-antigo';
  script = [{ status: 404, body: '{"detail":"Model not found"}' }, 'Olá!'];
  const changed: string[] = [];
  runtime.on('model', (id) => changed.push(id));
  await runtime.send('oi');
  assert.equal(runtime.model, 'community/x/m-free');
  assert.deepEqual(changed, ['community/x/m-free']);
  assert.equal(textOf(lines.at(-1)), 'Olá!');
  assert.ok(lines.some((line) => /não existe nesta conta/.test(textOf(line))));
});

test('modelo que existe mas dá "not found": tenta de novo e mostra qual modelo', async () => {
  const { runtime, lines } = setup();
  runtime.model = 'community/x/m-free';
  script = [{ status: 404, body: '{"detail":"Model not found"}' }, { status: 404, body: '{"detail":"Model not found"}' }];
  await runtime.send('oi');
  const error = textOf(lines.find((line) => line.type === 'error'));
  assert.match(error, /modelo community\/x\/m-free/);
});
