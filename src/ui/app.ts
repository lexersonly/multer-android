// A interface de terminal, no jeito do Claude Code: caixa de boas-vindas, marcadores ● com
// o resultado em ⎿, lista de tarefas ☒ ◼ ☐, pedido de permissão com opções numeradas, menu
// de / navegável e ? para os atalhos. Pensada para telas estreitas de celular.
// Sem JSX: assim o Node roda o TypeScript direto, sem etapa de build.

import { spawn } from 'node:child_process';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { createElement as h, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import type { Runtime } from '../agents/runtime.ts';
import { TEAM } from '../agents/team.ts';
import { loadCredential } from '../auth/credentials.ts';
import { saveSecret } from '../auth/secrets.ts';
import { saveToken } from '../auth/token-login.ts';
import type { Plugins } from '../plugins/plugins.ts';
import { notify } from '../phone.ts';
import { checkForUpdate, localVersion } from '../update.ts';
import type { Agent, ApprovalAnswer, ApprovalRequest, UiLine } from '../types.ts';
import { type CommandContext, type PasteTarget, runCommand, suggest } from './commands.ts';
import { deleteBefore, deleteWord, EMPTY_INPUT, insert, inputAt, type InputState, move, splitAtCursor } from './input.ts';
import { Logo, logoWidth } from './logo.ts';
import { Markdown } from './markdown.ts';
import { shortName } from './models.ts';
import { agentColor, SPINNER, THEME, THINKING_VERBS, toolLabel } from './theme.ts';

type KeyedLine = UiLine & { key: number };
type PendingApproval = ApprovalRequest & { resolve: (answer: ApprovalAnswer) => void };
type PasteState = PasteTarget & { reason?: string };
type Suggestion = { names: string[]; hint: string; usage: string };

const MAX_SUGGESTIONS = 6;
const MAX_MODEL_WIDTH = 22;
const STAGES = ['desenvolvedor', 'revisor', 'testador'];
const BASH_TIMEOUT_MS = 60_000;
const BASH_LINES = 12;
/** Duas vezes Esc dentro deste tempo apaga o texto, como no Claude Code. */
const DOUBLE_ESC_MS = 700;
/** Segundo Ctrl+C dentro deste tempo fecha o Multer. */
const EXIT_WINDOW_MS = 2000;

const SHORTCUTS: Array<[string, string]> = [
  ['/', 'comandos'],
  ['!', 'roda um comando direto'],
  ['shift+tab', 'aprovar tudo (/auto)'],
  ['esc 2x', 'apaga o texto'],
  ['@revisor', 'falar com um agente'],
  ['↑ ↓', 'pedidos anteriores'],
  ['tab', 'completa o comando'],
  ['esc', 'interrompe a equipe'],
  ['ctrl+u', 'apaga o texto'],
  ['ctrl+w', 'apaga a palavra'],
  ['ctrl+c 2x', 'fecha o Multer'],
];

/** A parte em português da dica: "trocar de modelo · switch model" vira "trocar de modelo". */
const hintPt = (hint: string): string => hint.split(' · ')[0];
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

interface WelcomeInfo {
  root: string;
  model: string;
  columns: number;
  saved: { openTasks: number } | null;
  loggedIn: boolean;
  animate: boolean;
}

/** A borda de cima com o título dentro, como "╭─── Claude Code v2 ───╮". */
function TitleBorder({ title, width }: { title: string; width: number }): ReactElement {
  const fill = Math.max(width - Array.from(title).length - 7, 0);
  return h(Text, null,
    h(Text, { color: THEME.accent }, '╭─── '),
    h(Text, { bold: true }, title),
    h(Text, { color: THEME.accent }, ` ${'─'.repeat(fill)}╮`));
}

/** A tela de boas-vindas do Claude Code: logo, modelo e pasta; dicas e atividade recente. */
function Welcome({ info }: { info: WelcomeInfo }): ReactElement {
  const width = Math.max(Math.min(info.columns, 100), 20);
  // Duas colunas só quando o logo grande cabe à esquerda.
  const wide = width >= 2 * (logoWidth('big') + 4);
  // A fonte cabe no espaço da coluna da esquerda, não na tela toda.
  const room = (wide ? Math.floor(width / 2) : width) - 4;
  const font = room >= logoWidth('big') ? 'big' : room >= logoWidth('small') ? 'small' : null;
  const tips = [
    ['Peça em português: ', '"crie um bot do Discord"'],
    ['', '/ajuda mostra os comandos'],
    ['', '@revisor fala direto com um agente'],
    ['', '!ls roda um comando direto'],
  ];
  const activity = info.saved
    ? `Conversa salva${info.saved.openTasks ? ` com ${info.saved.openTasks} tarefa(s) aberta(s)` : ''} · /retomar`
    : info.loggedIn ? 'Nenhuma atividade recente' : 'Sem login: /login e cole o token do APK';
  const left = h(Box, { flexDirection: 'column', alignItems: 'center', width: wide ? '50%' : undefined, flexShrink: 0 },
    h(Text, { bold: true }, 'Bem-vindo ao Multer!'),
    h(Box, { marginY: 1 }, font ? h(Logo, { font, animate: info.animate }) : h(Text, { color: THEME.accent, bold: true }, '✻ MULTER')),
    h(Text, { color: THEME.muted, wrap: 'truncate-end' }, `${shortName(info.model)} · Pollinations`),
    h(Text, { color: THEME.muted, wrap: 'truncate-middle' }, info.root));
  const right = h(Box, { flexDirection: 'column', flexGrow: 1, paddingLeft: wide ? 2 : 0, marginTop: wide ? 0 : 1 },
    h(Text, { bold: true, color: THEME.accent }, 'Dicas para começar'),
    ...tips.map(([lead, tip], index) => h(Text, { key: index, wrap: 'wrap' }, h(Text, { color: THEME.muted }, lead), tip)),
    h(Text, { color: THEME.muted }, '─'.repeat(Math.max(Math.min(wide ? width / 2 - 6 : width - 6, 40), 8))),
    h(Text, { bold: true, color: THEME.accent }, 'Atividade recente'),
    h(Text, { color: THEME.muted, wrap: 'wrap' }, activity));
  return h(Box, { flexDirection: 'column', width },
    h(TitleBorder, { title: `Multer v${localVersion()}`, width }),
    h(Box, { borderStyle: 'round', borderTop: false, borderColor: THEME.accent, paddingX: 1, flexDirection: wide ? 'row' : 'column' }, left, right),
    h(Box, { flexWrap: 'wrap', marginTop: 1, paddingX: 1 },
      ...TEAM.map((agent) => h(Text, { key: agent.id, color: agentColor(agent.id) }, `● ${agent.name}  `))));
}

/** Como a lista de tarefas do Claude Code: ☒ feito, ◼ agora, ☐ falta. */
function TaskList({ runtime, active }: { runtime: Runtime; active: string | null }): ReactElement | null {
  if (!runtime.tasks.length) return null;
  return h(Box, { flexDirection: 'column', paddingLeft: 2 },
    ...STAGES.map((id, index) => {
      const agent = TEAM.find((member) => member.id === id) as Agent;
      const last = runtime.tasks.filter((task) => task.assignee === id).at(-1);
      const now = active === id;
      const done = !now && last?.status === 'completed';
      const failed = !now && last?.status === 'blocked';
      const box = now ? '◼' : done ? '☒' : failed ? '☒' : '☐';
      const color = now ? agentColor(id) : done ? THEME.muted : failed ? THEME.bad : THEME.muted;
      const title = last?.title ? ` · ${last.title.replace(/^(Revisar|Testar|Corrigir): /, '')}` : '';
      return h(Text, { key: id, wrap: 'truncate-end' },
        h(Text, { color: THEME.muted }, index ? '   ' : '⎿  '),
        h(Text, { color, bold: now, strikethrough: done }, `${box} ${agent.name}`),
        h(Text, { color: THEME.muted }, title));
    }),
    runtime.files.length ? h(Text, { color: THEME.muted }, `   ${runtime.files.length} arquivo(s) alterado(s)`) : null);
}

/** O banner fica salvo com o que se sabia ao abrir; a largura é a da tela agora. */
const welcomeOf = (line: Extract<UiLine, { type: 'banner' }>): WelcomeInfo => ({
  root: line.root,
  model: line.model,
  columns: process.stdout.columns ?? 80,
  saved: line.saved ?? null,
  loggedIn: Boolean(loadCredential()),
  animate: false,
});

function Line({ line }: { line: UiLine }): ReactElement {
  switch (line.type) {
    case 'banner':
      return h(Welcome, { info: welcomeOf(line) });
    case 'user':
      return h(Box, { marginTop: 1 },
        h(Box, { flexShrink: 0 }, h(Text, { color: THEME.muted }, '> ')),
        h(Text, { color: THEME.muted }, line.text));
    case 'agent':
      return h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, null, h(Text, { color: agentColor(line.agent.id) }, '● '), h(Text, { bold: true, color: agentColor(line.agent.id) }, line.agent.name)),
        h(Box, { paddingLeft: 2 }, h(Markdown, { text: line.text })));
    case 'tool': {
      const color = line.ok ? THEME.ok : THEME.bad;
      return h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, { wrap: 'truncate-end' },
          h(Text, { color }, '● '), h(Text, { bold: true }, toolLabel(line.tool)),
          line.detail ? h(Text, { color: THEME.muted }, `(${line.detail})`) : null),
        // A saída do !comando aparece inteira; a das ferramentas, numa linha.
        h(Text, { color: line.ok ? THEME.muted : THEME.bad, wrap: line.tool === 'bash' ? 'wrap' : 'truncate-end' }, `  ⎿  ${line.summary}`));
    }
    case 'delegate':
      return h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, { wrap: 'truncate-end' },
          h(Text, { color: agentColor(line.to.id) }, '● '), h(Text, { bold: true }, 'Delegar'), h(Text, { color: THEME.muted }, `(${line.to.name})`)),
        h(Text, { color: THEME.muted, wrap: 'truncate-end' }, `  ⎿  ${line.text}`));
    case 'review': {
      const color = line.approved ? THEME.ok : THEME.bad;
      return h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, null, h(Text, { color }, '● '), h(Text, { bold: true, color }, line.approved ? 'Revisão aprovada' : 'Revisão reprovada')),
        h(Box, { paddingLeft: 2 }, h(Markdown, { text: line.text })));
    }
    case 'error':
      return h(Box, { marginTop: 1 },
        h(Box, { flexShrink: 0 }, h(Text, { color: THEME.bad }, '✗ ')),
        h(Text, { color: THEME.bad }, line.text));
    default:
      return h(Box, null,
        h(Box, { flexShrink: 0 }, h(Text, { color: THEME.muted }, '  ⎿  ')),
        h(Text, { color: THEME.muted }, line.text));
  }
}

/** O texto com um brilho que corre pelas letras, como o "Thinking…" do Claude Code. */
function Shimmer({ text, frame }: { text: string; frame: number }): ReactElement {
  const letters = Array.from(text);
  const at = frame % (letters.length + 8) - 4;
  return h(Text, { wrap: 'truncate-end' },
    ...letters.map((letter, index) => h(Text, { key: index, color: Math.abs(index - at) <= 1 ? THEME.shine : THEME.accent }, letter)));
}

/** O "pensando" do Claude Code: símbolo que gira, texto com brilho, tempo e como interromper. */
function Spinner({ label, narrow }: { label: string; narrow: boolean }): ReactElement {
  const [frame, setFrame] = useState(0);
  const started = useRef(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setFrame((old) => old + 1), 120);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((Date.now() - started.current) / 1000);
  // O tempo nunca some: o rótulo é que encolhe numa tela estreita.
  return h(Box, { marginTop: 1 },
    h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: THEME.accent }, SPINNER[frame % SPINNER.length])),
    h(Box, { flexShrink: 1 }, h(Shimmer, { text: label, frame })),
    h(Box, { flexShrink: 0, marginLeft: 1 }, h(Text, { color: THEME.muted }, narrow ? `(${duration(seconds)})` : `(${duration(seconds)} · esc interrompe)`)));
}

export const duration = (seconds: number): string => (seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}min ${seconds % 60}s`);

/** "executando run_command" vira "Comando"; "pensando" vira o verbo do pedido. */
export function activityLabel(agent: string, text: string, verb = 'Pensando'): string {
  const tool = text.match(/^executando (\S+)/)?.[1];
  if (tool) return `${agent} · ${toolLabel(tool)}…`;
  return `${agent} · ${text === 'pensando' ? verb : text}…`;
}

function describeCall({ tool, args }: ApprovalRequest): string {
  const text = typeof args.command === 'string' ? args.command : `${toolLabel(tool)} ${JSON.stringify(args)}`;
  // Comando enorme não pode empurrar as opções para fora da tela do celular.
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function approvalOptions(approval: ApprovalRequest): Array<{ answer: ApprovalAnswer; label: string }> {
  return [
    { answer: 'yes', label: 'Sim' },
    ...(approval.offerAlways ? [{ answer: 'always' as const, label: 'Sim, e não perguntar de novo nesta conversa' }] : []),
    { answer: 'no', label: 'Não (esc)' },
  ];
}

/** O pedido de permissão do Claude Code: o que vai rodar e as opções numeradas com ❯. */
function Approval({ approval, choice }: { approval: PendingApproval; choice: number }): ReactElement {
  return h(Box, { flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: THEME.warn, paddingX: 1 },
    h(Text, { bold: true, color: THEME.warn }, capitalize(approval.reason || 'pedido de permissão')),
    h(Box, { paddingLeft: 2, marginY: 1 }, h(Text, null, describeCall(approval))),
    h(Text, null, `${approval.agent.name} quer continuar. Você deixa?`),
    ...approvalOptions(approval).map((option, index) => h(Text, { key: option.answer, color: index === choice ? THEME.accent : undefined },
      index === choice ? '❯ ' : '  ', `${index + 1}. ${option.label}`)));
}

/** As últimas linhas que cabem em `height` linhas de tela, contando a quebra na largura. */
export function tailThatFits(text: string, width: number, height: number): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const size = Math.max(1, Math.ceil(Array.from(lines[index]).length / width));
    if (used + size > height) {
      // A linha que não cabe inteira entra só com o fim, para o texto não pular.
      if (!kept.length) kept.unshift(Array.from(lines[index]).slice(-(height * width)).join(''));
      break;
    }
    used += size;
    kept.unshift(lines[index]);
  }
  return kept.join('\n');
}

export interface AppProps {
  runtime: Runtime;
  plugins: Plugins;
  root: string;
}

export function App({ runtime, plugins, root }: AppProps): ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [lines, setLines] = useState<KeyedLine[]>([]);
  const [live, setLive] = useState<{ agent: Agent; text: string } | null>(null);
  const [state, setState] = useState<{ agent: Agent; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState<InputState>(EMPTY_INPUT);
  const value = input.text;
  // A caixa de texto mais recente, mesmo antes do próximo desenho: teclas rápidas não se perdem.
  const inputRef = useRef<InputState>(EMPTY_INPUT);
  const change = (next: InputState | ((old: InputState) => InputState)): void => {
    inputRef.current = typeof next === 'function' ? next(inputRef.current) : next;
    setInput(inputRef.current);
  };
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [choice, setChoice] = useState(0);
  const [paste, setPaste] = useState<PasteState | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [model, setModel] = useState(runtime.model);
  const [pick, setPick] = useState(0);
  const [help, setHelp] = useState(false);
  const [exitArmed, setExitArmed] = useState(false);
  const [verb, setVerb] = useState(THINKING_VERBS[0]);
  // Os primeiros instantes: o logo anima fora do histórico e só depois vai para ele.
  const [intro, setIntro] = useState(true);
  const introRef = useRef(true);
  const queued = useRef<UiLine[]>([]);
  const [auto, setAuto] = useState(false);
  // Lido uma vez: a animação do logo redesenha várias vezes e não precisa reler o disco.
  const savedAtStart = useMemo(() => runtime.savedSession(), []);
  const autoRef = useRef(false);
  const busyStart = useRef(0);
  const lastEsc = useRef(0);
  const nextKey = useRef(0);
  const loginAbort = useRef<AbortController | null>(null);
  const sent = useRef<string[]>([]);
  const sentAt = useRef(0);
  const pendingDelta = useRef<{ agent: Agent; text: string } | null | undefined>(undefined);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const add = (line: UiLine) => {
    if (introRef.current) {
      queued.current.push(line);
      return;
    }
    setLines((old) => [...old, { ...line, key: nextKey.current++ }]);
  };
  const toggleAuto = (): void => {
    autoRef.current = !autoRef.current;
    setAuto(autoRef.current);
  };
  const note = (text: string) => add({ type: 'status', text });
  const error = (text: string) => add({ type: 'error', text });

  useEffect(() => {
    // O desenho do Ink pesa no celular: no máximo 12 quadros por segundo.
    const timer = setInterval(() => {
      if (pendingDelta.current !== undefined) {
        setLive(pendingDelta.current);
        pendingDelta.current = undefined;
      }
    }, 80);
    runtime.on('line', add);
    runtime.on('delta', (delta) => {
      pendingDelta.current = delta;
      if (delta === null) setLive(null);
    });
    runtime.on('state', setState);
    runtime.on('busy', (value: boolean) => {
      if (value) {
        busyStart.current = Date.now();
        setVerb(THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)]);
      } else if (busyStart.current) {
        // Como o "Worked for 12s" do Claude Code, ao fim de cada pedido.
        add({ type: 'status', text: `✻ Trabalhou por ${duration(Math.round((Date.now() - busyStart.current) / 1000))}` });
        busyStart.current = 0;
      }
      setBusy(value);
    });
    runtime.on('model', setModel);
    runtime.approve = (request) => new Promise((resolve) => {
      if (autoRef.current) {
        add({ type: 'status', text: `⏵⏵ Aprovado sozinho: ${toolLabel(request.tool)}` });
        return resolve(request.offerAlways ? 'always' : 'yes');
      }
      notify('Multer', `${request.agent.name} pede permissão: ${request.reason}`);
      setChoice(0);
      setApproval({ ...request, resolve });
    });
    runtime.askSecret = (name, reason) => new Promise((resolve) => setPaste({ kind: 'secret', name, reason, resolve }));

    const saved = runtime.savedSession();
    // O logo brilha uma vez; depois a tela de boas-vindas entra no histórico com o que veio na fila.
    const introTimer = setTimeout(() => {
      introRef.current = false;
      setIntro(false);
      add({ type: 'banner', root, model: runtime.model, saved: saved ? { openTasks: saved.openTasks } : null });
      for (const line of queued.current.splice(0)) add(line);
    }, 1400);
    if (!process.env.MULTER_NO_UPDATE_CHECK) {
      void checkForUpdate().then((found) => {
        if (found?.available) note(`Versão nova: ${found.current} → ${found.latest}. Digite /atualizar.`);
      });
    }
    if (plugins.enabled) {
      plugins.connect()
        .then((count) => note(`REA ligado: ${count} ferramentas. A primeira chamada de cada conversa pede sua autorização.`))
        .catch((err: Error) => error(`O REA não iniciou: ${err.message}`));
    }
    return () => {
      clearInterval(timer);
      clearTimeout(introTimer);
      if (exitTimer.current) clearTimeout(exitTimer.current);
      runtime.removeAllListeners();
    };
  }, []);

  const commands: CommandContext = {
    runtime,
    plugins,
    note,
    error,
    setWorking,
    setModel,
    startPaste: (target) => setPaste(target),
    exit,
    toggleAuto,
    setLoginAbort: (controller) => {
      loginAbort.current = controller;
    },
  };

  const rememberSent = (text: string): void => {
    sent.current.push(text);
    sentAt.current = sent.current.length;
  };

  const submitPaste = (target: PasteState, text: string): void => {
    setPaste(null);
    if (!text) {
      if (target.kind === 'secret') target.resolve?.(null);
      return note('Nada colado.');
    }
    if (target.kind === 'token') {
      setWorking('Conferindo o token');
      void saveToken(text)
        .then(({ verified }) => note(verified
          ? 'Login feito. O token ficou salvo só neste aparelho.'
          : 'Token salvo, mas sem conferir: não consegui falar com o Pollinations agora.'))
        .catch((err: Error) => error(err.message))
        .finally(() => setWorking(null));
      return;
    }
    if (target.resolve) return target.resolve(text);
    try {
      saveSecret(target.name, text);
      note(`${target.name} salvo. Os agentes usam só o nome, nunca o valor.`);
    } catch (err) {
      error((err as Error).message);
    }
  };

  const matches: Suggestion[] = !paste && !approval && value.startsWith('/') && !value.includes(' ') ? suggest(value.slice(1)) : [];
  const shown = matches.slice(0, MAX_SUGGESTIONS);
  const selected = shown[Math.min(pick, shown.length - 1)];

  const submit = (raw = inputRef.current.text): void => {
    const text = raw.trim();
    change(EMPTY_INPUT);
    setPick(0);
    if (paste) return submitPaste(paste, text);
    if (!text) return;
    rememberSent(text);
    if (text.startsWith('/')) {
      void runCommand(commands, text);
      return;
    }
    if (text.startsWith('!')) return runBash(text.slice(1).trim());
    if (busy || working) return error('Espere terminar ou aperte Esc.');
    if (!loadCredential()) return error('Faça /login antes.');
    void runtime.send(text).catch((err: Error) => error(err.message));
  };

  /** "!comando" do Claude Code: roda direto na pasta, sem passar pela equipe. */
  const runBash = (command: string): void => {
    if (!command) return;
    if (busy || working) return error('Espere terminar ou aperte Esc.');
    setWorking(`Rodando ${command}`);
    const child = spawn('sh', ['-c', command], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + String(chunk)).slice(-6000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const limit = setTimeout(() => child.kill('SIGTERM'), BASH_TIMEOUT_MS);
    const finish = (code: number | null) => {
      clearTimeout(limit);
      setWorking(null);
      const shownLines = output.trimEnd().split('\n').slice(-BASH_LINES).join('\n      ');
      add({ type: 'tool', agent: TEAM[0], tool: 'bash', detail: command, ok: code === 0, summary: shownLines || (code === 0 ? 'Sem saída' : `Saiu com código ${code}`) });
    };
    child.on('close', finish);
    child.on('error', () => finish(127));
  };

  const answer = (pending: PendingApproval, picked: ApprovalAnswer): void => {
    note(`${picked === 'no' ? '✗ Recusado' : '✓ Aprovado'}: ${toolLabel(pending.tool)}`);
    pending.resolve(picked);
    setApproval(null);
  };

  /** Ctrl+C do Claude Code: para o trabalho, limpa o texto e só fecha na segunda vez seguida. */
  const ctrlC = (): void => {
    if (approval) return answer(approval, 'no');
    if (paste) {
      if (paste.kind === 'secret') paste.resolve?.(null);
      setPaste(null);
      return change(EMPTY_INPUT);
    }
    if (busy || working) {
      loginAbort.current?.abort();
      runtime.cancel();
      return;
    }
    if (inputRef.current.text) return change(EMPTY_INPUT);
    if (exitArmed) return exit();
    setExitArmed(true);
    exitTimer.current = setTimeout(() => setExitArmed(false), EXIT_WINDOW_MS);
  };

  useInput((typed, key) => {
    if (key.ctrl && typed === 'c') return ctrlC();
    if (exitArmed) setExitArmed(false);
    if (approval) {
      const options = approvalOptions(approval);
      if (key.upArrow) return setChoice((old) => (old + options.length - 1) % options.length);
      if (key.downArrow) return setChoice((old) => (old + 1) % options.length);
      if (key.return) return answer(approval, options[choice]?.answer ?? 'no');
      if (key.escape) return answer(approval, 'no');
      const letter = typed.toLowerCase();
      const byNumber = options[Number(letter) - 1]?.answer;
      const byLetter = letter === 's' || letter === 'y' ? 'yes'
        : letter === 'n' ? 'no'
          : (letter === 't' || letter === 'a') && approval.offerAlways ? 'always' : null;
      const picked = byNumber ?? byLetter;
      if (picked) answer(approval, picked);
      return;
    }
    if (help && !(typed === '?' && !inputRef.current.text)) setHelp(false);
    if (key.escape) {
      if (paste) {
        if (paste.kind === 'secret') paste.resolve?.(null);
        setPaste(null);
        change(EMPTY_INPUT);
        return;
      }
      if (shown.length) return change(EMPTY_INPUT);
      if (busy || working) {
        loginAbort.current?.abort();
        runtime.cancel();
        return;
      }
      // Parado e com texto: Esc duas vezes seguidas apaga, como no Claude Code.
      const now = Date.now();
      if (inputRef.current.text && now - lastEsc.current < DOUBLE_ESC_MS) change(EMPTY_INPUT);
      lastEsc.current = now;
      return;
    }
    if (key.tab && key.shift) return toggleAuto();
    if (shown.length && (key.upArrow || key.downArrow)) {
      setPick((old) => (old + (key.upArrow ? shown.length - 1 : 1)) % shown.length);
      return;
    }
    if (key.tab) {
      if (selected) change(inputAt(`/${selected.names[0]} `));
      setPick(0);
      return;
    }
    if (key.return) {
      // Enter no menu de /: comando sem argumento roda; com argumento, completa e espera o resto.
      if (selected && inputRef.current.text !== `/${selected.names[0]}`) {
        const usage = selected.usage.trim();
        if (usage.includes(' ')) {
          setPick(0);
          return change(inputAt(`/${selected.names[0]} `));
        }
        return submit(`/${selected.names[0]}`);
      }
      return submit();
    }
    if (key.backspace || key.delete) {
      setPick(0);
      return change(deleteBefore);
    }
    if (key.ctrl && typed === 'u') return change(EMPTY_INPUT);
    if (key.ctrl && typed === 'w') return change(deleteWord);
    if (key.ctrl && typed === 'a') return change((old) => ({ ...old, cursor: 0 }));
    if (key.ctrl && typed === 'e') return change((old) => inputAt(old.text));
    if (key.leftArrow) return change((old) => move(old, -1));
    if (key.rightArrow) return change((old) => move(old, 1));
    if (key.upArrow && !paste) {
      if (sentAt.current > 0) change(inputAt(sent.current[--sentAt.current]));
      return;
    }
    if (key.downArrow && !paste) {
      if (sentAt.current < sent.current.length) change(inputAt(sent.current[++sentAt.current] ?? ''));
      return;
    }
    if (typed === '?' && !inputRef.current.text && !paste) return setHelp((old) => !old);
    if (typed && !key.ctrl && !key.meta) {
      setPick(0);
      // Texto e Enter no mesmo pedaço (celular lento, digitação rápida): grava o texto e envia.
      // Colar várias linhas continua sem enviar no meio: as quebras viram espaço.
      const body = typed.replace(/\r$/, '');
      const enter = body !== typed && !/[\r\n]/.test(body);
      const next = insert(inputRef.current, body.replace(/\r\n?|\n/g, ' '));
      if (enter) return submit(next.text);
      change(next);
    }
  });

  const rows = (stdout as NodeJS.WriteStream | undefined)?.rows ?? 24;
  const columns = (stdout as NodeJS.WriteStream | undefined)?.columns ?? 80;
  const narrow = columns < 56;
  // Só o fim do texto em andamento, do tamanho da tela: desenhar mais faz o terminal piscar.
  const liveTail = useMemo(() => {
    if (!live?.text) return '';
    return tailThatFits(live.text, Math.max(columns - 4, 10), Math.max(rows - 16, 3));
  }, [live, rows, columns]);
  // O tamanho do segredo também não aparece.
  const [beforeCursor, underCursor, afterCursor] = paste ? [value ? '••••••••' : '', ' ', ''] : splitAtCursor(input);
  const promptLabel = paste ? (paste.kind === 'token' ? 'token' : paste.name) : null;
  const activity = working ?? (state ? activityLabel(state.agent.name, state.text, verb) : null);
  const placeholder = 'Peça algo à equipe';
  const footer = exitArmed ? 'Aperte Ctrl+C de novo para sair'
    : busy || working ? 'esc interrompe'
      : paste ? 'esc cancela'
        : '? atalhos';
  const nameWidth = Math.max(...shown.map((command) => command.names[0].length + 1), 0) + 2;

  const bashMode = !paste && value.startsWith('!');
  const ruleColor = paste ? THEME.warn : bashMode ? THEME.bash : THEME.muted;
  const rule = h(Text, { color: ruleColor }, '─'.repeat(Math.max(columns - 1, 10)));

  return h(Box, { flexDirection: 'column' },
    h(Static<KeyedLine>, { items: lines, children: (line) => h(Box, { key: line.key }, h(Line, { line })) }),
    intro ? h(Welcome, { info: { root, model, columns, saved: savedAtStart, loggedIn: Boolean(loadCredential()), animate: true } }) : null,
    live?.text
      ? h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, null, h(Text, { color: agentColor(live.agent.id) }, '● '), h(Text, { bold: true, color: agentColor(live.agent.id) }, live.agent.name)),
        h(Box, { paddingLeft: 2 }, h(Markdown, { text: liveTail })))
      : null,
    activity ? h(Spinner, { label: activity, narrow }) : null,
    busy ? h(TaskList, { runtime, active: state?.agent.id ?? null }) : null,
    paste?.reason ? h(Text, { color: THEME.warn }, paste.reason) : null,
    approval
      ? h(Approval, { approval, choice })
      : h(Box, { flexDirection: 'column', marginTop: 1 },
        // A caixa do Claude Code 2: uma linha em cima, outra embaixo, e o > na frente.
        rule,
        h(Box, { paddingX: 1 },
          // Quebra a linha em vez de cortar: na tela do celular, o texto longo sumia.
          h(Text, null,
            h(Text, { color: paste ? THEME.warn : bashMode ? THEME.bash : undefined, bold: bashMode }, promptLabel ? `${promptLabel}> ` : bashMode ? '! ' : '> '),
            bashMode ? beforeCursor.replace(/^!/, '') : beforeCursor,
            h(Text, { inverse: true }, underCursor),
            afterCursor,
            !value && !paste ? h(Text, { color: THEME.muted }, placeholder) : null)),
        rule,
        shown.length
          ? h(Box, { flexDirection: 'column', paddingX: 2 },
            ...shown.map((command) => {
              const active = command === selected;
              return h(Box, { key: command.names[0] },
                h(Box, { width: nameWidth, flexShrink: 0 }, h(Text, { color: active ? THEME.accent : undefined, bold: active }, `/${command.names[0]}`)),
                h(Text, { color: active ? THEME.accent : THEME.muted, wrap: 'truncate-end' }, hintPt(command.hint)));
            }))
          : help
            ? h(Box, { flexDirection: 'column', paddingX: 2 },
              ...SHORTCUTS.map(([keys, what]) => h(Box, { key: keys },
                h(Box, { width: 12, flexShrink: 0 }, h(Text, null, keys)),
                h(Text, { color: THEME.muted, wrap: 'truncate-end' }, what))))
            : h(Box, { justifyContent: 'space-between', paddingX: 2 },
              h(Box, { flexShrink: 0 },
                auto && !exitArmed
                  ? h(Text, { color: THEME.bash }, narrow ? '⏵⏵ aprovar tudo' : '⏵⏵ aprovar tudo ligado (shift+tab)')
                  : h(Text, { color: exitArmed ? THEME.warn : bashMode ? THEME.bash : THEME.muted }, bashMode ? '! roda direto no terminal' : footer)),
              // O aviso de sair ocupa a linha toda: numa tela estreita ele encostava no modelo.
              exitArmed ? null : h(Box, { marginLeft: 2, flexShrink: 1 }, h(Text, { color: THEME.muted, wrap: 'truncate-end' }, shortName(model).slice(0, MAX_MODEL_WIDTH))))));
}

