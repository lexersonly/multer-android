// O laço dos agentes: um integrante por vez, com a fila que assign_task e send_message
// alimentam. O trabalho segue sozinho pela equipe inteira: o arquiteto entrega ao
// desenvolvedor, depois vêm a revisão e o teste, e o arquiteto resume no fim.

import { EventEmitter } from 'node:events';
import { listSecretNames, SECRET_NAME, saveSecret } from '../auth/secrets.ts';
import type { Plugins } from '../plugins/plugins.ts';
import { saveSettings } from '../plugins/settings.ts';
import { chat, type ChatResult, DEFAULT_MODEL, modelIds, type ProviderError } from '../provider/client.ts';
import { approvalFor } from '../tools/approval.ts';
import { isLocalTool, runLocalTool } from '../tools/local.ts';
import { ProcessManager } from '../tools/processes.ts';
import type { Agent, Approver, HistoryItem, Task, ToolArgs, ToolCall, ToolOutcome, UiLine } from '../types.ts';
import { shortName } from '../ui/models.ts';
import { announcesAction, fingerprint, parseResponse, streamView, toolCallWasCut } from './parser.ts';
import { buildContext, buildSystemPrompt, findAgent, leadAgent, mentionedAgent, TEAM } from './team.ts';

const CONTEXT_BUDGET_CHARS = 12_000;
const MAX_TOOL_RESULT_CHARS = 6_000;
const MAX_TOOL_RESULTS_IN_CONTEXT = 6;
const MAX_ACTION_REMINDERS = 2;
const MAX_CUT_REPLIES = 3;
const MAX_BAD_CALLS = 4;
const MAX_REPEATS = 3;
const MAX_FIX_ROUNDS = 1;
/** O arquiteto só reparte o trabalho: passou disso, o pedido vai direto ao desenvolvedor. */
const LEAD_TIMEOUT_MS = 60_000;
const AGENT_TIMEOUT_MS = 240_000;
const TEAM_TOOLS = [
  'assign_task', 'send_message', 'update_task', 'submit_review', 'find_tools', 'request_plugin',
  'start_process', 'process_logs', 'stop_process', 'request_secret',
];
const FILE_CHANGE = new Set(['write_file', 'create_file', 'append_file', 'edit_file']);

const shorten = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}\n[... cortado ...]`);
const denied = (message: string): ToolOutcome => ({ ok: false, summary: message, content: message });

/** O que mostrar ao lado do nome da ferramenta: o arquivo, o comando, a busca. */
function toolDetail(args: ToolArgs): string {
  const value = args.path ?? args.file_path ?? args.command ?? args.query ?? args.name ?? args.title ?? args.to ?? '';
  return String(value).replace(/\s+/g, ' ').slice(0, 70);
}

interface QueuedTurn {
  agent: Agent;
  note: string;
  task?: Task;
}

/** Onde o trabalho está, para a equipe seguir sozinha de uma etapa à outra. */
interface Pipeline {
  reviewQueued: boolean;
  testQueued: boolean;
  fixes: number;
  closing: boolean;
}

interface RuntimeEvents {
  line: [UiLine];
  delta: [{ agent: Agent; text: string } | null];
  state: [{ agent: Agent; text: string } | null];
  busy: [boolean];
  model: [string];
}

export interface RuntimeOptions {
  root: string;
  plugins?: Plugins;
  getCredential: () => string | null;
  model?: string;
  maxTokens?: number;
  approve: Approver;
  askSecret?: SecretAsker;
  leadTimeoutMs?: number;
  agentTimeoutMs?: number;
}

/** Pede o valor à pessoa. Devolve null se ela recusar. */
export type SecretAsker = (name: string, reason: string) => Promise<string | null>;

export class Runtime extends EventEmitter<RuntimeEvents> {
  readonly root: string;
  readonly plugins?: Plugins;
  readonly getCredential: () => string | null;
  readonly maxTokens: number;
  readonly leadTimeoutMs: number;
  readonly agentTimeoutMs: number;
  model: string;
  approve: Approver;
  askSecret: SecretAsker;
  readonly processes: ProcessManager;
  tasks: Task[] = [];
  private history: HistoryItem[] = [];
  private queue: QueuedTurn[] = [];
  private delegated = new Set<string>();
  private changedFiles = new Set<string>();
  private pipeline: Pipeline = { reviewQueued: false, testQueued: false, fixes: 0, closing: false };
  private lastUserText = '';
  private allowAlways = false;
  private controller: AbortController | null = null;
  private nextTask = 1;

  constructor(options: RuntimeOptions) {
    super();
    this.root = options.root;
    this.plugins = options.plugins;
    this.getCredential = options.getCredential;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? 4096;
    this.leadTimeoutMs = options.leadTimeoutMs ?? LEAD_TIMEOUT_MS;
    this.agentTimeoutMs = options.agentTimeoutMs ?? AGENT_TIMEOUT_MS;
    this.approve = options.approve;
    this.askSecret = options.askSecret ?? (async () => null);
    this.processes = new ProcessManager(options.root);
  }

  /** Ao fechar o Multer, nada fica rodando sozinho. */
  shutdown(): void {
    this.processes.killAll();
  }

  get running(): boolean {
    return this.controller !== null;
  }

  cancel(): void {
    this.controller?.abort();
  }

  clear(): void {
    this.history = [];
    this.tasks = [];
    this.queue = [];
    this.allowAlways = false;
    this.nextTask = 1;
  }

  private status(text: string): void {
    this.emit('line', { type: 'status', text });
  }

  /** Mensagem da pessoa: vai ao líder, ou a quem ela citou com @. */
  async send(text: string): Promise<void> {
    if (this.running) throw new Error('A equipe ainda está trabalhando.');
    const agent = mentionedAgent(text) ?? leadAgent();
    this.history.push({ type: 'user', text });
    this.emit('line', { type: 'user', text });
    this.lastUserText = text;
    this.queue.push({ agent, note: 'Atenda à última mensagem do usuário.' });
    this.delegated = new Set();
    this.changedFiles = new Set();
    this.pipeline = { reviewQueued: false, testQueued: false, fixes: 0, closing: false };
    const controller = new AbortController();
    this.controller = controller;
    this.emit('busy', true);
    try {
      while (this.queue.length && !controller.signal.aborted) {
        const next = this.queue.shift() as QueuedTurn;
        await this.runAgent(next, controller.signal);
      }
      if (controller.signal.aborted) this.status('Cancelado.');
    } finally {
      this.queue = [];
      this.controller = null;
      this.emit('state', null);
      this.emit('busy', false);
    }
  }

  /** O modelo que a conta não conhece (ou que mudou de nome) não pode travar a equipe. */
  private async recoverModel(): Promise<boolean> {
    const credential = this.getCredential();
    if (!credential) return false;
    let ids: { all: string[]; free: string[] };
    try {
      ids = await modelIds(credential);
    } catch {
      return false;
    }
    // O modelo existe: o catálogo acabou de ser lido, então vale tentar de novo.
    if (ids.all.includes(this.model)) return true;
    const wanted = shortName(this.model).toLowerCase();
    const next = ids.all.find((id) => shortName(id).toLowerCase() === wanted)
      ?? (ids.free.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : ids.free[0]);
    if (!next) return false;
    this.status(`O modelo ${shortName(this.model)} não existe nesta conta. Troquei para ${shortName(next)}.`);
    this.model = next;
    saveSettings({ model: next });
    this.emit('model', next);
    return true;
  }

  private async requestModel(agent: Agent, note: string, signal: AbortSignal): Promise<ChatResult | null | 'timeout'> {
    let recovered = false;
    for (;;) {
      let raw = '';
      try {
        return await chat({
          credential: this.getCredential() ?? '',
          model: this.model,
          system: buildSystemPrompt({ agent, root: this.root, tasks: this.tasks, pluginSection: this.plugins?.promptSection() }),
          messages: buildContext(this.history, agent, note, CONTEXT_BUDGET_CHARS),
          maxTokens: this.maxTokens,
          timeoutMs: agent.lead ? this.leadTimeoutMs : this.agentTimeoutMs,
          signal,
          onDelta: (delta) => {
            raw += delta;
            this.emit('delta', { agent, text: streamView(raw) });
          },
        });
      } catch (err) {
        const failure = err as ProviderError;
        if (signal.aborted || failure.name === 'AbortError') return null;
        if (failure.timedOut) return 'timeout';
        if (failure.modelNotFound && !recovered) {
          recovered = true;
          if (await this.recoverModel()) continue;
        }
        const hint = failure.needsLogin ? ' A sessão expirou ou é inválida: rode /login.' : '';
        this.emit('line', { type: 'error', text: `${agent.name}: ${failure.message}${hint}` });
        // Sem modelo não há como seguir: a fila inteira pararia no mesmo erro.
        this.queue = [];
        return null;
      } finally {
        this.emit('delta', null);
      }
    }
  }

  /** O arquiteto não repassou: o pedido da pessoa vai direto ao desenvolvedor. */
  private fallbackDelegate(reason: string): boolean {
    if (this.delegated.size || this.pipeline.closing || !this.lastUserText) return false;
    this.status(`${reason} Passei o pedido direto ao Desenvolvedor.`);
    this.createTask(this.lastUserText.replace(/\s+/g, ' ').slice(0, 70), findAgent('desenvolvedor') as Agent, this.lastUserText.slice(0, 600));
    return true;
  }

  private async runAgent({ agent, note: trigger, task }: QueuedTurn, signal: AbortSignal): Promise<void> {
    const toolResults: string[] = [];
    const seenCalls = new Map<string, number>();
    const seenTexts = new Map<string, number>();
    let reminders = 0;
    let cuts = 0;
    let badCalls = 0;

    for (;;) {
      if (signal.aborted) return;
      this.emit('state', { agent, text: 'pensando' });
      const note = toolResults.length
        ? `${trigger}\n\nResultados reais das ferramentas nesta rodada:\n${toolResults.join('\n\n')}\n\nContinue: chame a próxima ferramenta ou termine em poucas frases.`
        : trigger;
      const response = await this.requestModel(agent, note, signal);
      if (!response) return;
      if (response === 'timeout') {
        const waited = Math.round((agent.lead ? this.leadTimeoutMs : this.agentTimeoutMs) / 1000);
        if (agent.lead && this.fallbackDelegate(`${agent.name} demorou mais de ${waited}s.`)) return;
        this.status(`${agent.name} demorou mais de ${waited}s e foi interrompido. Troque o modelo com /modelos ou tente de novo.`);
        if (task?.status === 'in_progress') this.closeTask(agent, task, 'blocked', 'O modelo demorou demais para responder.');
        return;
      }
      const parsed = parseResponse(response.content);

      if (toolCallWasCut(response.content, response.completionTokens, this.maxTokens)) {
        if (++cuts >= MAX_CUT_REPLIES) {
          this.status(`${agent.name} foi cortado ${cuts} vezes no limite de ${this.maxTokens} tokens. Troque o modelo ou peça algo menor.`);
          return;
        }
        if (cuts === 1) this.status(`A resposta de ${agent.name} passou do limite de ${this.maxTokens} tokens e foi cortada. Pedi para gravar em partes.`);
        toolResults.push(`Sua resposta passou do limite de ${this.maxTokens} tokens e foi cortada: nada foi gravado. Não releia os arquivos nem repita o conteúdo inteiro. Grave no máximo 150 linhas agora com write_file e, em seguida, o restante com append_file, uma parte por resposta.`);
        continue;
      }
      if (parsed.parseError) {
        if (++badCalls >= MAX_BAD_CALLS) {
          if (agent.lead && this.fallbackDelegate(`${agent.name} errou o formato da ferramenta.`)) return;
          this.status(`${agent.name} errou o formato da ferramenta ${badCalls} vezes e foi encerrado. Troque o modelo com /modelos.`);
          return;
        }
        toolResults.push(parsed.parseError);
        continue;
      }
      if (parsed.text) {
        // Só o detector de repetição encerra um modelo preso: não há teto de passos.
        const key = fingerprint(parsed.text);
        const count = (seenTexts.get(key) ?? 0) + 1;
        seenTexts.set(key, count);
        if (count >= MAX_REPEATS) {
          this.status(`${agent.name} repetiu a mesma resposta ${count} vezes neste turno e foi encerrado.`);
          return;
        }
        this.say(agent, parsed.text);
      }
      if (parsed.tool) {
        const key = `${parsed.tool.name}:${JSON.stringify(parsed.tool.args)}`;
        const count = (seenCalls.get(key) ?? 0) + 1;
        seenCalls.set(key, count);
        if (count >= MAX_REPEATS) {
          this.status(`${agent.name} repetiu a mesma chamada de ${parsed.tool.name} ${count} vezes e foi encerrado.`);
          return;
        }
        this.emit('state', { agent, text: `executando ${parsed.tool.name}` });
        const outcome = await this.executeTool(agent, parsed.tool, task, signal);
        this.emit('line', { type: 'tool', agent, tool: parsed.tool.name, detail: toolDetail(parsed.tool.args), ok: outcome.ok, summary: outcome.summary });
        toolResults.push(`Resultado de ${parsed.tool.name}: ${outcome.summary}\n${shorten(outcome.content, MAX_TOOL_RESULT_CHARS)}`);
        while (toolResults.length > MAX_TOOL_RESULTS_IN_CONTEXT) toolResults.shift();
        if (outcome.endsTurn) return;
        continue;
      }
      if (announcesAction(parsed.text)) {
        if (reminders < MAX_ACTION_REMINDERS) {
          reminders++;
          toolResults.push(`Você escreveu "${shorten(parsed.text.trim(), 300)}", mas não chamou ferramenta, então nada aconteceu. Chame a ferramenta agora, no formato <tool>. Se não há nada a fazer, diga isso em uma frase.`);
          continue;
        }
        if (agent.lead && this.fallbackDelegate(`${agent.name} disse que ia delegar, mas não chamou a ferramenta.`)) return;
        this.status(`${agent.name} disse que ia agir, mas o modelo não chamou a ferramenta. Tente de novo ou troque o modelo com /modelos.`);
      } else if (!parsed.text) {
        this.status(`${agent.name} não respondeu nada (modelo vazio). Tente de novo ou troque com /modelos.`);
      }
      // Encerrou sem update_task: a tarefa não pode ficar aberta para sempre.
      if (task?.status === 'in_progress') {
        this.closeTask(agent, task, 'completed', parsed.text || 'Terminou sem relatar o resultado.');
      }
      return;
    }
  }

  private say(agent: Agent, text: string): void {
    this.history.push({ type: 'agent', agentId: agent.id, name: agent.name, text });
    this.emit('line', { type: 'agent', agent, text });
  }

  private createTask(title: string, assignee: Agent, description: string): Task {
    const task: Task = { id: `t${this.nextTask++}`, title, description, assignee: assignee.id, status: 'in_progress' };
    this.tasks.push(task);
    this.emit('line', { type: 'delegate', to: assignee, text: title });
    this.queue.push({
      agent: assignee,
      task,
      note: `Sua tarefa ${task.id}: ${title}${description ? `\n${description}` : ''}`,
    });
    return task;
  }

  /** Fecha a tarefa e põe a próxima etapa na fila, sem depender do arquiteto lembrar. */
  private closeTask(agent: Agent, task: Task, status: 'completed' | 'blocked', result: string, approved?: boolean): void {
    task.status = status;
    task.result = result;
    if (agent.lead) return;
    const files = [...this.changedFiles].slice(0, 12).join(', ');
    const short = task.title.replace(/^(Revisar|Corrigir|Testar): /, '').slice(0, 50);

    if (status === 'completed' && this.changedFiles.size) {
      if (agent.id === 'desenvolvedor' && !this.pipeline.reviewQueued) {
        this.pipeline.reviewQueued = true;
        this.createTask(`Revisar: ${short}`, findAgent('revisor') as Agent,
          `Revise os arquivos alterados: ${files}. Pedido original: ${this.lastUserText.slice(0, 300)}`);
        return;
      }
      if (agent.id === 'revisor' && approved === false && this.pipeline.fixes < MAX_FIX_ROUNDS) {
        this.pipeline.fixes++;
        this.pipeline.reviewQueued = false;
        this.createTask(`Corrigir: ${short}`, findAgent('desenvolvedor') as Agent, `A revisão apontou: ${shorten(result, 500)}`);
        return;
      }
      if (agent.id === 'revisor' && !this.pipeline.testQueued) {
        this.pipeline.testQueued = true;
        this.createTask(`Testar: ${short}`, findAgent('testador') as Agent,
          `Teste o que foi feito (rode os testes ou o programa) e relate só o que o terminal mostrou. Arquivos: ${files}.`);
        return;
      }
    }
    this.pipeline.closing = true;
    const summary = this.tasks.map((item) => `- ${item.title} (${item.assignee}): ${item.status}${item.result ? ` — ${shorten(item.result, 250)}` : ''}`).join('\n');
    this.queue.push({
      agent: leadAgent(),
      note: `O trabalho da equipe terminou:\n${summary}\nResponda ao usuário em duas ou três frases, dizendo o que foi feito e o que falhou. Não delegue mais nada.`,
    });
  }

  private async executeTool(agent: Agent, call: ToolCall, task: Task | undefined, signal: AbortSignal): Promise<ToolOutcome> {
    const { name, args } = call;
    const isPlugin = name.startsWith('mcp__');
    if (!isLocalTool(name) && !isPlugin && !TEAM_TOOLS.includes(name)) return denied(`A ferramenta ${name} não existe. Use só as da lista.`);
    const allowed = agent.tools.includes(name) || isPlugin || (name === 'create_file' && agent.tools.includes('write_file'));
    if (!allowed) return denied(`${agent.name} não usa ${name} neste papel.${agent.lead ? ' Delegue com assign_task.' : ''}`);

    if (isLocalTool(name)) {
      const need = approvalFor(name, args);
      if (need.ask && (need.always || !this.allowAlways)) {
        const answer = await this.approve({ agent, tool: name, args, reason: need.reason ?? 'ação sensível', offerAlways: !need.always });
        if (answer === 'no') return denied('O usuário recusou esta ação. Não tente de novo do mesmo jeito.');
        if (answer === 'always') this.allowAlways = true;
      }
      const outcome = await runLocalTool(name, this.root, args, signal);
      if (outcome.ok && FILE_CHANGE.has(name)) this.changedFiles.add(String(args.path ?? args.file_path ?? ''));
      return outcome;
    }
    if (isPlugin) return this.callPlugin(agent, name, args);

    switch (name) {
      case 'assign_task': return this.assignTask(args);
      case 'send_message': return this.sendMessage(agent, args);
      case 'update_task': return this.updateTask(agent, args, task);
      case 'submit_review': return this.submitReview(agent, args, task);
      case 'start_process': return this.startProcess(agent, args);
      case 'process_logs': return this.processes.logs(String(args.name ?? ''), Number(args.lines) || 40);
      case 'stop_process': return this.processes.stop(String(args.name ?? ''));
      case 'request_secret': return this.requestSecret(agent, args);
      case 'find_tools': return { ok: true, summary: `Busca: ${String(args.query ?? '')}`, content: this.plugins?.find(args.query) ?? 'Nenhum plugin disponível.' };
      default: return this.requestPlugin(agent, args);
    }
  }

  private async startProcess(agent: Agent, args: ToolArgs): Promise<ToolOutcome> {
    const name = String(args.name ?? '').trim();
    const command = String(args.command ?? '').trim();
    if (!name || !command) return denied('Os campos name e command são obrigatórios.');
    const env = Array.isArray(args.env) ? args.env.map(String) : String(args.env ?? '').split(/[,\s]+/).filter(Boolean);
    const known = listSecretNames();
    const missing = env.filter((item) => !known.includes(item));
    if (missing.length) return denied(`Falta o segredo ${missing.join(', ')}. Chame request_secret antes.`);
    const need = approvalFor('run_command', { command });
    if (need.ask && (need.always || !this.allowAlways)) {
      const withSecrets = env.length ? `, com ${env.join(', ')}` : '';
      const answer = await this.approve({
        agent, tool: 'start_process', args: { command }, reason: `rodar em segundo plano${withSecrets}`, offerAlways: !need.always,
      });
      if (answer === 'no') return denied('O usuário recusou esta ação. Não tente de novo do mesmo jeito.');
      if (answer === 'always') this.allowAlways = true;
    }
    return this.processes.start(name, command, env);
  }

  private async requestSecret(agent: Agent, args: ToolArgs): Promise<ToolOutcome> {
    const name = String(args.name ?? '').trim();
    if (!SECRET_NAME.test(name)) return denied('Nome inválido: use MAIÚSCULAS e _, como DISCORD_TOKEN.');
    if (listSecretNames().includes(name)) return { ok: true, summary: `${name} já existe`, content: `${name} já está salvo. Use env:["${name}"] no start_process.` };
    const why = String(args.reason ?? '').trim() || `${agent.name} precisa de ${name}`;
    const value = await this.askSecret(name, why);
    if (!value) return denied('O usuário não informou o segredo.');
    try {
      saveSecret(name, value);
    } catch (err) {
      return denied((err as Error).message);
    }
    return { ok: true, summary: `${name} salvo`, content: `Salvo. Use env:["${name}"] no start_process. Você nunca vê o valor.` };
  }

  private assignTask(args: ToolArgs): ToolOutcome {
    if (this.pipeline.closing) return denied('Tudo já foi feito neste pedido. Resuma ao usuário em duas frases.');
    const title = String(args.title ?? '').trim();
    if (!title) return denied('O campo title é obrigatório.');
    const assignee = findAgent(args.assignee ?? args.to ?? args.agent);
    if (!assignee || assignee.lead) {
      return denied(`Integrante desconhecido. Use: ${TEAM.filter((member) => !member.lead).map((member) => member.id).join(', ')}.`);
    }
    // A revisão e o teste são pedidos sozinhos quando o desenvolvedor termina.
    if (assignee.id === 'revisor' || assignee.id === 'testador') {
      return denied(`${assignee.name} é chamado sozinho depois do desenvolvedor. Entregue só ao desenvolvedor.`);
    }
    const dedupe = `${assignee.id}:${title.toLowerCase()}`;
    if (this.delegated.has(dedupe)) return denied(`Esta tarefa já foi entregue a ${assignee.name} neste pedido. Não delegue de novo: resuma o resultado.`);
    this.delegated.add(dedupe);
    // O desenvolvedor precisa do pedido inteiro, não só de um título.
    const description = String(args.description ?? '').trim() || this.lastUserText.slice(0, 600);
    const task = this.createTask(title, assignee, description);
    return { ok: true, summary: `Tarefa ${task.id} entregue a ${assignee.name}`, content: 'Entregue. Termine agora com uma frase: o resultado chega a você depois.' };
  }

  private sendMessage(agent: Agent, args: ToolArgs): ToolOutcome {
    const target = findAgent(args.to ?? args.agent ?? args.recipient);
    const text = String(args.text ?? args.message ?? '').trim();
    if (!text) return denied('O campo text é obrigatório.');
    if (!target) return denied(`Integrante desconhecido. Use: ${TEAM.map((member) => member.id).join(', ')}.`);
    if (target === agent) return denied('Você não pode mandar mensagem a si mesmo.');
    this.queue.push({ agent: target, note: `${agent.name} mandou: ${text}` });
    this.emit('line', { type: 'delegate', to: target, text });
    return { ok: true, summary: `Mensagem enviada a ${target.name}`, content: 'Enviada. Termine agora: a resposta chega depois.' };
  }

  private updateTask(agent: Agent, args: ToolArgs, current: Task | undefined): ToolOutcome {
    const task = current ?? this.tasks.find((item) => item.id === args.id || item.id === args.task_id);
    if (!task) return { ok: true, summary: 'Sem tarefa aberta', content: 'Você não tem tarefa aberta. Responda em poucas frases.' };
    const status = args.status === 'blocked' ? 'blocked' : 'completed';
    this.closeTask(agent, task, status, String(args.result ?? args.summary ?? 'Sem detalhes.'));
    return { ok: true, summary: `Tarefa ${task.id}: ${status}`, content: 'Registrado. Responda em uma frase e pare.', endsTurn: true };
  }

  private submitReview(agent: Agent, args: ToolArgs, task: Task | undefined): ToolOutcome {
    const summary = String(args.summary ?? '').trim();
    if (!summary) return denied('O campo summary é obrigatório.');
    const approved = args.approved === true || args.approved === 'true';
    const verdict = `Revisão ${approved ? 'aprovada' : 'reprovada'}: ${summary}`;
    this.emit('line', { type: 'review', approved, text: summary });
    this.history.push({ type: 'agent', agentId: agent.id, name: agent.name, text: verdict });
    if (task) this.closeTask(agent, task, 'completed', verdict, approved);
    else this.queue.push({ agent: leadAgent(), note: verdict });
    return { ok: true, summary: `Revisão ${approved ? 'aprovada' : 'reprovada'}`, content: 'Registrada.', endsTurn: true };
  }

  private async requestPlugin(agent: Agent, args: ToolArgs): Promise<ToolOutcome> {
    const plugin = String(args.plugin ?? 'rea').toLowerCase();
    if (plugin !== 'rea') return denied(`O plugin "${plugin}" não existe. Só há o REA.`);
    if (!this.plugins) return denied('Plugins indisponíveis.');
    const blocked = this.plugins.unavailableReason();
    if (blocked) return denied(blocked);
    const why = String(args.reason ?? '').trim();
    const answer = await this.approve({ agent, tool: 'request_plugin', args, reason: `ligar o REA${why ? ` (${why})` : ''}`, offerAlways: false });
    if (answer === 'no') return denied('O usuário não autorizou o REA.');
    try {
      const count = await this.plugins.enable();
      return { ok: true, summary: `REA ligado: ${count} ferramentas`, content: 'Ligado. Chame find_tools com o que precisa, em inglês.' };
    } catch (err) {
      return denied(`O REA não iniciou: ${(err as Error).message}`);
    }
  }

  private async callPlugin(agent: Agent, name: string, args: ToolArgs): Promise<ToolOutcome> {
    if (!this.plugins?.tools.length) return denied('Nenhum plugin conectado. Chame request_plugin primeiro.');
    if (!this.plugins.authorized) {
      const answer = await this.approve({ agent, tool: name, args, reason: 'ferramenta de plugin externo', offerAlways: true });
      if (answer === 'no') return denied('O usuário recusou esta ação.');
      if (answer === 'always') this.plugins.authorized = true;
    }
    try {
      const { text, isError } = await this.plugins.call(name, args);
      return { ok: !isError, summary: `${name} ${isError ? 'falhou' : 'respondeu'}`, content: text };
    } catch (err) {
      return denied((err as Error).message);
    }
  }
}
