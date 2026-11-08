// Os comandos que começam com /. Cada um tem nome em português e em inglês.

import type { Runtime } from '../agents/runtime.ts';
import { TEAM } from '../agents/team.ts';
import { openBrowser } from '../auth/browser.ts';
import { deleteCredential, loadCredential, saveCredential } from '../auth/credentials.ts';
import { deviceLogin } from '../auth/device-login.ts';
import { deleteSecret, listSecretNames, SECRET_NAME } from '../auth/secrets.ts';
import type { Plugins } from '../plugins/plugins.ts';
import { saveSettings } from '../plugins/settings.ts';
import { freeModelCatalog, workingFreeModels } from '../provider/client.ts';
import { checkForUpdate, localVersion, runUpdate } from '../update.ts';
import { formatModels, resolveModel, shortName } from './models.ts';

export type PasteTarget =
  | { kind: 'token' }
  | { kind: 'secret'; name: string; resolve?: (value: string | null) => void };

export interface CommandContext {
  runtime: Runtime;
  plugins: Plugins;
  note: (text: string) => void;
  error: (text: string) => void;
  setWorking: (text: string | null) => void;
  setModel: (model: string) => void;
  startPaste: (target: PasteTarget) => void;
  exit: () => void;
  /** Liga e desliga o modo que aprova tudo sozinho (o mesmo do Shift+Tab). */
  toggleAuto?: () => void;
  /** Quem cancela o login em andamento, com Esc. */
  setLoginAbort: (controller: AbortController | null) => void;
}

interface Command {
  names: string[];
  usage: string;
  hint: string;
  run: (ctx: CommandContext, arg: string) => Promise<void> | void;
}

/** A última lista de modelos, para `/modelo 2`. */
let modelList: string[] = [];

async function loginWithKey(ctx: CommandContext): Promise<void> {
  const controller = new AbortController();
  ctx.setLoginAbort(controller);
  ctx.setWorking('Aguardando a aprovação no navegador (Esc cancela)');
  try {
    const key = await deviceLogin({
      signal: controller.signal,
      onCode: ({ userCode, url }) => {
        ctx.note(openBrowser(url) ? 'Abri o navegador do celular.' : 'Não consegui abrir o navegador.');
        ctx.note(`Endereço: ${url}\nCódigo: ${userCode}`);
      },
    });
    saveCredential(key);
    ctx.note('Login feito. A chave ficou só neste aparelho e vale por tempo limitado (7 dias, se você não mudou).');
  } catch (err) {
    ctx.error((err as Error).message);
  } finally {
    ctx.setLoginAbort(null);
    ctx.setWorking(null);
  }
}

async function listModels(ctx: CommandContext): Promise<void> {
  const credential = loadCredential();
  if (!credential) return ctx.error('Faça /login antes.');
  ctx.setWorking('Testando os modelos gratuitos');
  try {
    modelList = await workingFreeModels(credential, (done, total) => ctx.setWorking(`Testando os modelos gratuitos ${done}/${total}`));
    ctx.note(modelList.length
      ? `${formatModels(modelList, ctx.runtime.model)}\nTroque com /modelo 2 ou /model glm (número ou começo do nome).`
      : 'Nenhum modelo gratuito respondeu agora.');
  } catch (err) {
    ctx.error((err as Error).message);
  } finally {
    ctx.setWorking(null);
  }
}

async function changeModel(ctx: CommandContext, arg: string): Promise<void> {
  const { runtime } = ctx;
  if (!arg) {
    if (!modelList.length) return listModels(ctx);
    return ctx.note(`Modelo atual: ${shortName(runtime.model)}\n${formatModels(modelList, runtime.model)}\nTroque com /modelo 2 ou /model glm.`);
  }
  const credential = loadCredential();
  // Para achar pelo nome basta o catálogo, que é rápido; testar cada modelo é o /modelos.
  if (!modelList.length && credential && !/^\d+$/.test(arg)) {
    modelList = await freeModelCatalog(credential).catch(() => []);
  }
  const found = resolveModel(arg, modelList);
  let picked: string | null = null;
  if (found.kind === 'one') picked = found.id;
  else if (found.kind === 'many') return ctx.note(`Mais de um modelo combina com "${arg}". Seja mais específico ou use o número:\n${formatModels(found.ids, runtime.model)}`);
  else if (arg.includes('/')) picked = arg;
  else return ctx.error(`Nenhum modelo combina com "${arg}". Veja a lista com /modelos.`);
  runtime.model = picked;
  ctx.setModel(picked);
  saveSettings({ model: picked });
  return ctx.note(`Modelo: ${shortName(picked)}`);
}

async function updateCommand(ctx: CommandContext): Promise<void> {
  if (ctx.runtime.running) return ctx.error('Espere a equipe terminar antes de atualizar.');
  ctx.setWorking('Procurando atualização');
  try {
    const found = await checkForUpdate();
    if (!found) return ctx.error('Não consegui consultar a versão mais nova. Veja a internet e tente de novo.');
    if (!found.available) return ctx.note(`Você já está na versão mais nova (${found.current}).`);
    ctx.note(`Atualizando ${found.current} → ${found.latest}...`);
    const result = await runUpdate((line) => ctx.setWorking(`Atualizando… ${line.slice(0, 40)}`));
    if (!result.ok) return ctx.error(`A atualização falhou:\n${result.output.split('\n').slice(-6).join('\n')}`);
    ctx.note(`Atualizado para ${localVersion()}. Feche e abra o multer para usar a versão nova. Seu login foi mantido.`);
  } finally {
    ctx.setWorking(null);
  }
}

async function reaCommand(ctx: CommandContext, arg: string): Promise<void> {
  const { plugins } = ctx;
  const reason = plugins.unavailableReason();
  if (/^(desligar|off|disable)$/i.test(arg)) {
    plugins.disable();
    return ctx.note('REA desligado.');
  }
  if (!/^(ligar|on|enable)$/i.test(arg)) {
    return ctx.note(reason ?? (plugins.tools.length ? `REA ligado: ${plugins.tools.length} ferramentas.` : 'REA instalado e desligado. /rea ligar autoriza.'));
  }
  if (reason) return ctx.error(reason);
  ctx.setWorking('Iniciando o REA');
  try {
    ctx.note(`REA ligado: ${await plugins.enable()} ferramentas.`);
  } catch (err) {
    ctx.error(`O REA não iniciou: ${(err as Error).message}`);
  } finally {
    ctx.setWorking(null);
  }
}

function secretCommand(ctx: CommandContext, arg: string): void {
  const [first, second] = arg.split(/\s+/);
  if (!first) {
    const names = listSecretNames();
    return ctx.note(names.length
      ? `Segredos salvos (só os nomes): ${names.join(', ')}\nNovo: /segredo NOME. Apagar: /segredo apagar NOME.`
      : 'Nenhum segredo salvo. Para um bot do Discord: /segredo DISCORD_TOKEN');
  }
  if (/^(apagar|remover|rm|delete)$/i.test(first)) {
    if (!second) return ctx.error('Qual? Use /segredo apagar NOME.');
    return ctx.note(deleteSecret(second) ? `${second} apagado.` : `Não há segredo ${second}.`);
  }
  if (!SECRET_NAME.test(first)) return ctx.error('Nome inválido: use MAIÚSCULAS, números e _, como DISCORD_TOKEN.');
  ctx.startPaste({ kind: 'secret', name: first });
  ctx.note(`Cole o valor de ${first} e aperte Enter. Nada aparece na tela e os agentes nunca o veem. Esc cancela.`);
}

function processesCommand(ctx: CommandContext): void {
  const list = ctx.runtime.processes.list();
  ctx.note(list.length
    ? list.map((item) => `${item.running ? '●' : '○'} ${item.name}  ${item.running ? `${item.seconds}s` : `terminou (${item.exitCode})`}  ${item.command}`).join('\n')
    : 'Nenhum processo em segundo plano.');
}

function resumeCommand(ctx: CommandContext): void {
  const open = ctx.runtime.restoreSession();
  if (open === null) return ctx.note('Não há conversa salva nesta pasta.');
  ctx.note(open
    ? `Conversa recuperada, com ${open} tarefa(s) aberta(s). Digite continua para seguir.`
    : 'Conversa recuperada. Pode seguir de onde parou.');
}

const COMMANDS: Command[] = [
  { names: ['retomar', 'resume'], usage: '/retomar', hint: 'voltar à conversa salva · resume saved chat', run: resumeCommand },
  { names: ['cancelar', 'cancel'], usage: '/cancelar', hint: 'interromper a equipe, como o Esc · stop the team', run: (ctx) => {
    if (!ctx.runtime.running) return ctx.note('A equipe não está trabalhando.');
    ctx.runtime.cancel();
  } },
  { names: ['arquivos', 'files'], usage: '/arquivos', hint: 'o que a equipe alterou · changed files', run: (ctx) => {
    ctx.note(ctx.runtime.files.join('\n') || 'Nenhum arquivo alterado neste pedido.');
  } },
  { names: ['login', 'entrar'], usage: '/login', hint: 'colar o token do APK · paste the APK token', run: (ctx, arg) => {
    if (/^(chave|key)$/i.test(arg)) return loginWithKey(ctx);
    ctx.startPaste({ kind: 'token' });
    return ctx.note('No APK Multer Token, faça o login e toque em Copiar. Cole aqui e aperte Enter. Nada aparece na tela. Esc cancela.');
  } },
  { names: ['logout', 'sair-da-conta'], usage: '/logout', hint: 'apagar o login deste aparelho · sign out', run: (ctx) => {
    deleteCredential();
    ctx.note('Credencial apagada deste aparelho.');
  } },
  { names: ['modelo', 'model'], usage: '/modelo N|nome', hint: 'trocar de modelo por número ou nome · switch model', run: changeModel },
  { names: ['modelos', 'models'], usage: '/modelos', hint: 'testar e listar os modelos · list models', run: listModels },
  { names: ['segredo', 'secret'], usage: '/segredo NOME', hint: 'guardar token, como DISCORD_TOKEN · store a secret', run: secretCommand },
  { names: ['processos', 'ps'], usage: '/processos', hint: 'bots e servidores rodando · background processes', run: processesCommand },
  { names: ['logs'], usage: '/logs NOME', hint: 'ver a saída de um processo · process output', run: (ctx, arg) => {
    const out = ctx.runtime.processes.logs(arg.trim(), 30);
    ctx.note(`${out.summary}\n${out.content}`);
  } },
  { names: ['parar', 'stop'], usage: '/parar NOME', hint: 'parar um processo · stop a process', run: async (ctx, arg) => {
    ctx.note((await ctx.runtime.processes.stop(arg.trim())).summary);
  } },
  { names: ['equipe', 'team'], usage: '/equipe', hint: 'ver os agentes · show the agents', run: (ctx) => {
    ctx.note(TEAM.map((agent) => `${agent.name} (@${agent.id}): ${agent.role}`).join('\n'));
  } },
  { names: ['tarefas', 'tasks'], usage: '/tarefas', hint: 'ver as tarefas · show the tasks', run: (ctx) => {
    ctx.note(ctx.runtime.tasks.map((task) => `${task.id} [${task.status}] ${task.title} (${task.assignee})`).join('\n') || 'Nenhuma tarefa.');
  } },
  { names: ['rea'], usage: '/rea ligar|desligar', hint: 'plugin REA · REA plugin on/off', run: reaCommand },
  { names: ['limpar', 'clear'], usage: '/limpar', hint: 'nova conversa · new conversation', run: (ctx) => {
    ctx.runtime.clear();
    ctx.note('Conversa nova.');
  } },
  { names: ['atualizar', 'update'], usage: '/atualizar', hint: 'buscar versão nova · update multer', run: updateCommand },
  { names: ['auto'], usage: '/auto', hint: 'aprovar tudo sozinho, como o shift+tab · auto-approve', run: (ctx) => ctx.toggleAuto?.() },
  { names: ['ajuda', 'help'], usage: '/ajuda', hint: 'mostrar os comandos · show commands', run: (ctx) => ctx.note(HELP) },
  { names: ['sair', 'exit', 'quit'], usage: '/sair', hint: 'fechar · quit', run: (ctx) => ctx.exit() },
];

export const HELP = `${COMMANDS.map((command) => `${command.names.map((name) => `/${name}`).join(' ').padEnd(20)} ${command.hint}`).join('\n')}
@revisor texto       falar direto com um agente · talk to one agent
Esc                  cancelar · cancel`;

/** Para a lista de sugestões enquanto a pessoa digita. */
export function suggest(prefix: string): Array<{ names: string[]; hint: string; usage: string }> {
  const wanted = prefix.toLowerCase();
  return COMMANDS.filter((command) => command.names.some((name) => name.startsWith(wanted)));
}

export async function runCommand(ctx: CommandContext, text: string): Promise<void> {
  const [name, ...rest] = text.slice(1).trim().split(/\s+/);
  const command = COMMANDS.find((item) => item.names.includes(name.toLowerCase()));
  if (!command) return ctx.error(`Comando desconhecido: /${name}. Veja /ajuda.`);
  try {
    await command.run(ctx, rest.join(' '));
  } catch (err) {
    ctx.error((err as Error).message);
  }
}
