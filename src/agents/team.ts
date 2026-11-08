// A equipe e o prompt. O prompt é curto de propósito: modelos pequenos têm pouco
// contexto e se perdem com instruções longas.

import { TOOL_SPECS } from '../tools/specs.ts';
import type { Agent, ChatMessage, HistoryItem, Task } from '../types.ts';

const READ = ['read_file', 'list_files', 'search_code'];
const PROCESS = ['start_process', 'process_logs', 'stop_process'];
const COMMON =['send_message', 'find_tools', 'request_plugin'];

export const TEAM: readonly Agent[] = [
  {
    id: 'arquiteto', name: 'Arquiteto', role: 'líder', color: 'magenta', lead: true,
    tools: [...READ, 'assign_task', ...COMMON],
    rule: 'Você lidera: não altere arquivos e não faça plano longo. Para qualquer pedido de trabalho, chame assign_task AGORA para o desenvolvedor, com title curto e description com o pedido completo. A revisão e o teste acontecem sozinhos depois. Quando chegar o resumo, responda ao usuário em duas frases e pare.',
  },
  {
    id: 'desenvolvedor', name: 'Desenvolvedor', role: 'desenvolvedor', color: 'blue',
    tools: [...READ, 'write_file', 'append_file', 'edit_file', 'run_command', ...PROCESS, 'request_secret', 'update_task', ...COMMON],
    rule: 'Cada resposta tem limite de tamanho: grave arquivo grande em partes, write_file com o começo e append_file com o resto. Bot do Discord: discord.js, token só por process.env.DISCORD_TOKEN (peça com request_secret, nunca no código), rode com start_process e confira process_logs. Depois de gravar, rode o programa ou um teste rápido com run_command. Faça o pedido inteiro, não só a primeira parte. Ao terminar, use update_task com o resultado e pare: o Multer confere a sintaxe e recusa o fim se algo falhou.',
  },
  {
    id: 'revisor', name: 'Revisor', role: 'revisor', color: 'yellow',
    tools: [...READ, 'run_command', 'submit_review', ...COMMON],
    rule: 'Você revisa: leia o código real e feche com submit_review uma vez.',
  },
  {
    id: 'testador', name: 'Testador', role: 'testador', color: 'green',
    tools: [...READ, 'write_file', 'edit_file', 'run_command', ...PROCESS, 'update_task', ...COMMON],
    rule: 'Você testa: rode testes reais e relate só o que o terminal mostrou. Ao terminar, use update_task com o resultado.',
  },
];

export const leadAgent = (): Agent => TEAM.find((agent) => agent.lead) as Agent;

export function findAgent(name: unknown): Agent | null {
  const wanted = String(name ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!wanted) return null;
  return TEAM.find((agent) => agent.id === wanted || agent.name.toLowerCase() === wanted || agent.role === wanted) ?? null;
}

/** `@revisor olha isso`: a mensagem vai direto a esse integrante. */
export function mentionedAgent(text: string): Agent | null {
  const match = text.trim().match(/^@([\p{L}]+)/u);
  return match ? findAgent(match[1]) : null;
}

const signature = (name: string) => `${name}(${TOOL_SPECS[name].args.join(', ')})`;

export function buildSystemPrompt(input: { agent: Agent; root: string; tasks: Task[]; pluginSection?: string }): string {
  const { agent, root, tasks, pluginSection } = input;
  let out = `Você é ${agent.name}, ${agent.role} da equipe no Multer, em um terminal Android (Termux). Trabalhe em arquivos reais; nunca invente resultados.\n`;
  out += `\nPasta do projeto: ${root} (use caminhos relativos, como game.py)\n`;
  out += `Equipe: ${TEAM.filter((member) => member !== agent).map((member) => `${member.id} (${member.role})`).join(', ')}\n`;

  const open = tasks.filter((task) => !['completed', 'cancelled'].includes(task.status)).slice(0, 8);
  if (open.length) {
    out += 'Tarefas abertas:\n';
    for (const task of open) {
      out += `- ${task.id} ${task.title} [${task.status}] (${task.assignee})\n`;
      if (task.assignee === agent.id && task.description) out += `  ${task.description.slice(0, 300)}\n`;
    }
  }

  out += '\nRegras: atenda só ao que foi pedido agora; a uma saudação, responda em uma frase e pare, sem chamar a equipe. Leia antes de editar. Não repita o que já fez. Ao terminar, responda em poucas frases e pare. Fale português. Nunca toque em credenciais ou .env.\n';
  out += `${agent.rule}\n`;
  out += '\nPara usar uma ferramenta, escreva exatamente assim e pare de escrever:\n<tool name="read_file">{"path":"index.html"}</tool>\nUma por resposta. O resultado volta na próxima mensagem. Resposta sem ferramenta encerra o seu turno: não anuncie uma ação sem chamá-la.\n\nFerramentas:\n';
  for (const name of agent.tools) out += `${signature(name)} — ${TOOL_SPECS[name].about}\n`;
  return out + (pluginSection ?? '');
}

function shortenForContext(text: string): string {
  const HEAD = 900;
  const TAIL = 500;
  return text.length <= HEAD + TAIL + 40 ? text : `${text.slice(0, HEAD)}\n[...]\n${text.slice(-TAIL)}`;
}

/** Sem etiquetas como `[runtime]`: modelos pequenos passam a imitá-las na resposta. */
export function buildContext(history: HistoryItem[], agent: Agent, note: string | null, budgetChars: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of history) {
    if (item.type === 'user') messages.push({ role: 'user', content: item.text });
    else if (item.agentId === agent.id) messages.push({ role: 'assistant', content: shortenForContext(item.text) });
    else messages.push({ role: 'user', content: `${item.name} escreveu: ${shortenForContext(item.text)}` });
  }
  // Só as mais recentes cabem. A mais antiga fica, porque costuma ser o pedido.
  let total = messages.reduce((sum, item) => sum + item.content.length, 0);
  while (total > budgetChars && messages.length > 3) {
    total -= messages.splice(1, 1)[0].content.length;
  }
  if (note) messages.push({ role: 'user', content: note });

  // Provedores que exigem alternância não aceitam dois papéis iguais em sequência.
  const merged: ChatMessage[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (last?.role === message.role) last.content += `\n\n${message.content}`;
    else merged.push({ ...message });
  }
  if (!merged.length) merged.push({ role: 'user', content: 'Comece analisando o projeto e avance no seu papel.' });
  if (merged.at(-1)?.role === 'assistant') {
    merged.push({ role: 'user', content: 'Continue a partir do estado atual. Se seu trabalho terminou, dê um resumo curto.' });
  }
  return merged;
}
