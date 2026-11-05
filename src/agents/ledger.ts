// Memória de um turno: o que o agente já leu e já fez, repetida a cada passo. Sem ela,
// o conteúdo lido saía do contexto, o modelo relia e nunca chegava a trabalhar.

import type { Agent } from '../types.ts';

export type Pressure = 'free' | 'nudge' | 'block';

interface Remembered {
  label: string;
  content: string;
  callKey: string;
  path?: string;
}

const READ_ONLY = new Set(['read_file', 'list_files', 'search_code', 'process_logs']);
const MAX_COMMANDS = 8;

export const isReadOnly = (tool: string): boolean => READ_ONLY.has(tool);

/** Quem revisa ou testa lê por ofício, e quem só responde a uma pergunta não tem o que entregar. */
function limits(agent: Agent, taskOpen: boolean): [number, number] | null {
  if (agent.id === 'revisor' || agent.id === 'testador') return null;
  if (agent.lead) return [2, 6];
  return taskOpen ? [5, 10] : [8, Number.POSITIVE_INFINITY];
}

export class TurnLedger {
  private memory: Remembered[] = [];
  private files: string[] = [];
  private commands: string[] = [];
  explored = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  countRead(): void {
    this.explored++;
  }

  has(callKey: string): boolean {
    return this.memory.some((item) => item.callKey === callKey);
  }

  /** Guarda o que foi lido. O mais antigo sai quando passa do limite. */
  remember(label: string, content: string, callKey: string, path?: string): void {
    this.memory = this.memory.filter((item) => item.label !== label);
    this.memory.push({ label, content, callKey, path });
    const size = () => this.memory.reduce((sum, item) => sum + item.content.length, 0);
    while (this.memory.length > 1 && size() > this.limit) this.memory.shift();
  }

  /** O arquivo mudou: a cópia lida antes não vale mais. */
  changed(path: string): void {
    this.explored = 0;
    if (!this.files.includes(path)) this.files.push(path);
    this.memory = this.memory.filter((item) => item.path !== path);
  }

  acted(command: string, ok: boolean): void {
    this.explored = 0;
    const line = command.replace(/\s+/g, ' ').slice(0, 80);
    this.commands.push(ok ? line : `${line} (falhou)`);
    if (this.commands.length > MAX_COMMANDS) this.commands.shift();
  }

  pressure(agent: Agent, taskOpen: boolean): Pressure {
    const range = limits(agent, taskOpen);
    if (!range) return 'free';
    if (this.explored >= range[1]) return 'block';
    return this.explored >= range[0] ? 'nudge' : 'free';
  }

  blockedMessage(agent: Agent): string {
    return agent.lead
      ? 'Leitura não executada: você já leu o bastante. Se é pedido de trabalho, chame assign_task agora. Se é pergunta, responda com o que já leu.'
      : 'Leitura não executada: você já leu o bastante e nada mudou ainda. O que precisa está em "Já lido". Agora faça a tarefa: write_file, edit_file ou run_command.';
  }

  nextStep(agent: Agent, taskOpen: boolean): string {
    if (this.pressure(agent, taskOpen) === 'free') return '';
    return agent.lead
      ? 'Pare de explorar. Se é pedido de trabalho, chame assign_task agora. Se é pergunta, responda agora.'
      : 'Pare de explorar: você já leu o bastante e nada mudou ainda. A próxima resposta deve fazer o trabalho com write_file, edit_file ou run_command.';
  }

  render(): string {
    const parts: string[] = [];
    if (this.files.length || this.commands.length) {
      let done = 'Já feito neste turno:';
      if (this.files.length) done += `\nArquivos alterados: ${this.files.join(', ')}.`;
      if (this.commands.length) done += `\nComandos: ${this.commands.join('; ')}.`;
      parts.push(done);
    }
    if (this.memory.length) {
      parts.push(`Já lido neste turno. Use isto e não leia de novo:${this.memory.map((item) => `\n\n--- ${item.label} ---\n${item.content}`).join('')}`);
    }
    return parts.join('\n\n');
  }
}

/** Só os dois últimos resultados vão inteiros: o que foi lido já está na memória do turno. */
export function composeNote(base: string, memory: string, results: string[], nextStep: string): string {
  if (!results.length && !memory) return base;
  const from = Math.max(0, results.length - 2);
  const shown = results.map((result, index) => (index >= from ? result : result.split('\n')[0].slice(0, 160)));
  const blocks = [base, memory, shown.join('\n\n')].filter(Boolean).join('\n\n');
  return `${blocks}\n\nResultados reais das suas ferramentas, não uma mensagem do usuário. ${nextStep || 'Se ainda falta alguma parte, chame a próxima ferramenta agora. Só quando nada faltar, termine em poucas frases.'}`;
}

/** Pedido curto para retomar: não precisa de modelo nenhum para decidir. */
export function asksToContinue(input: string): boolean {
  const text = input.trim().toLowerCase();
  if (!text || text.length > 50 || text.endsWith('?')) return false;
  return ['continua', 'continue', 'prossegue', 'prossiga', 'retoma', 'retome', 'termina', 'termine', 'pode continuar', 'bora continuar'].some((start) => text.startsWith(start));
}

const LOOP_SENTENCE_CHARS = 20;
const LOOP_REPEATS = 4;
const sentences = (text: string): string[] => text.match(/[^.!?\n]*[.!?\n]+|[^.!?\n]+$/g) ?? [];

/** A resposta terminou com a mesma frase várias vezes seguidas: o modelo entrou em laço. */
export function streamIsLooping(text: string): boolean {
  const parts = sentences(text.slice(-4000)).map((part) => part.trim()).filter(Boolean);
  if (parts.length < LOOP_REPEATS) return false;
  const tail = parts.slice(-LOOP_REPEATS);
  return tail[0].length >= LOOP_SENTENCE_CHARS && tail.every((part) => part === tail[0]);
}

/** Deixa uma só cópia de cada frase repetida em sequência. Código fica como está. */
export function collapseRepeats(text: string): string {
  if (text.includes('```') || text.includes('<tool')) return text;
  let out = '';
  let last = '';
  for (const part of sentences(text)) {
    const clean = part.trim();
    if (clean === last && clean.length >= LOOP_SENTENCE_CHARS) continue;
    out += part;
    if (clean) last = clean;
  }
  return out;
}
