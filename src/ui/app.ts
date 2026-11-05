// A interface de terminal, no jeito do Claude Code: marcadores ●, resultados com ⎿,
// texto formatado e uma caixa de entrada. Pensada para telas estreitas de celular.
// Sem JSX: assim o Node roda o TypeScript direto, sem etapa de build.

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
import { Markdown } from './markdown.ts';
import { shortName } from './models.ts';
import { agentColor, SPINNER, THEME, toolLabel } from './theme.ts';

type KeyedLine = UiLine & { key: number };
type PendingApproval = ApprovalRequest & { resolve: (answer: ApprovalAnswer) => void };
type PasteState = PasteTarget & { reason?: string };

const MAX_SUGGESTIONS = 6;
const MAX_MODEL_WIDTH = 22;
const STAGES = ['desenvolvedor', 'revisor', 'testador'];

function Banner({ line }: { line: Extract<UiLine, { type: 'banner' }> }): ReactElement {
  return h(Box, { flexDirection: 'column' },
    h(Text, null, h(Text, { color: THEME.accent, bold: true }, '✻ Multer'), h(Text, { color: THEME.muted }, ` ${localVersion()} · equipe de agentes`)),
    h(Text, { color: THEME.muted, wrap: 'truncate-middle' }, line.root),
    h(Box, { flexWrap: 'wrap', marginTop: 1 },
      ...TEAM.map((agent) => h(Text, { key: agent.id, color: agentColor(agent.id) }, `● ${agent.name}  `))),
    h(Text, { color: THEME.muted }, 'Escreva o pedido. ',
      h(Text, { color: THEME.accent }, '/'), ' comandos, ',
      h(Text, { color: THEME.accent }, '@revisor'), ' fala com um agente.'));
}

/** Onde o pedido está: quem já passou, quem trabalha agora e quem falta. */
function Progress({ runtime, active, narrow }: { runtime: Runtime; active: string | null; narrow: boolean }): ReactElement | null {
  if (!runtime.tasks.length) return null;
  const files = runtime.files.length;
  return h(Box, { marginTop: 1 },
    h(Text, { wrap: 'truncate-end' },
      ...STAGES.flatMap((id, index) => {
        const agent = TEAM.find((member) => member.id === id) as Agent;
        const tasks = runtime.tasks.filter((task) => task.assignee === id);
        const last = tasks.at(-1);
        const mark = active === id ? '●' : last?.status === 'completed' ? '✓' : last?.status === 'blocked' ? '✗' : '○';
        const color = active === id ? agentColor(id) : last?.status === 'completed' ? THEME.ok : last?.status === 'blocked' ? THEME.bad : THEME.muted;
        return [index ? h(Text, { key: `sep${id}`, color: THEME.muted }, ' › ') : null, h(Text, { key: id, color }, `${mark} ${narrow && id === 'desenvolvedor' ? 'Dev' : agent.name}`)];
      }),
      files ? h(Text, { color: THEME.muted }, `  ${files} arq.`) : null));
}

function Line({ line }: { line: UiLine }): ReactElement {
  switch (line.type) {
    case 'banner':
      return h(Banner, { line });
    case 'user':
      return h(Box, { marginTop: 1, paddingX: 1, backgroundColor: THEME.block },
        h(Text, { color: THEME.accent }, '> '), h(Text, null, line.text));
    case 'agent':
      return h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, null, h(Text, { color: agentColor(line.agent.id) }, '● '), h(Text, { bold: true, color: agentColor(line.agent.id) }, line.agent.name)),
        h(Box, { paddingLeft: 2 }, h(Markdown, { text: line.text })));
    case 'tool': {
      const color = line.ok ? THEME.ok : THEME.bad;
      return h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, { wrap: 'truncate-end' },
          h(Text, { color }, '● '), h(Text, { bold: true }, toolLabel(line.tool)),
          line.detail ? h(Text, { color: THEME.muted }, ` (${line.detail})`) : null),
        h(Text, { color: line.ok ? THEME.muted : THEME.bad, wrap: 'truncate-end' }, `  ⎿  ${line.summary}`));
    }
    case 'delegate':
      return h(Box, { marginTop: 1 },
        h(Text, { wrap: 'truncate-end' },
          h(Text, { color: agentColor(line.to.id) }, '↳ '), h(Text, { bold: true, color: agentColor(line.to.id) }, line.to.name),
          h(Text, { color: THEME.muted }, `  ${line.text}`)));
    case 'review': {
      const color = line.approved ? THEME.ok : THEME.bad;
      return h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, null, h(Text, { color }, '● '), h(Text, { bold: true, color }, line.approved ? 'Revisão aprovada' : 'Revisão reprovada')),
        h(Box, { paddingLeft: 2 }, h(Markdown, { text: line.text })));
    }
    case 'error':
      return h(Box, { marginTop: 1 }, h(Text, { color: THEME.bad }, '✗ '), h(Text, { color: THEME.bad }, line.text));
    default:
      return h(Box, { paddingLeft: 2 }, h(Text, { color: THEME.muted }, line.text));
  }
}

/** O "pensando" com o tempo, como no Claude Code. Só ele redesenha várias vezes por segundo. */
function Spinner({ label }: { label: string }): ReactElement {
  const [frame, setFrame] = useState(0);
  const started = useRef(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setFrame((old) => old + 1), 150);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((Date.now() - started.current) / 1000);
  return h(Box, { marginTop: 1 },
    h(Text, { color: THEME.accent }, `${SPINNER[frame % SPINNER.length]} `),
    h(Text, { wrap: 'truncate-end' }, label, h(Text, { color: THEME.muted }, ` (${seconds}s · esc interrompe)`)));
}

function describeCall({ tool, args }: ApprovalRequest): string {
  if (typeof args.command === 'string') return args.command;
  return `${tool} ${JSON.stringify(args).slice(0, 300)}`;
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
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [paste, setPaste] = useState<PasteState | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [model, setModel] = useState(runtime.model);
  const nextKey = useRef(0);
  const loginAbort = useRef<AbortController | null>(null);
  const sent = useRef<string[]>([]);
  const sentAt = useRef(0);
  const pendingDelta = useRef<{ agent: Agent; text: string } | null | undefined>(undefined);

  const add = (line: UiLine) => setLines((old) => [...old, { ...line, key: nextKey.current++ }]);
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
    runtime.on('busy', setBusy);
    runtime.on('model', setModel);
    runtime.approve = (request) => new Promise((resolve) => {
      notify('Multer', `${request.agent.name} pede permissão: ${request.reason}`);
      setApproval({ ...request, resolve });
    });
    runtime.askSecret = (name, reason) => new Promise((resolve) => setPaste({ kind: 'secret', name, reason, resolve }));

    add({ type: 'banner', root, model: runtime.model });
    if (!loadCredential()) note('Sem login ainda: digite /login e cole o token do APK Multer Token.');
    const saved = runtime.savedSession();
    if (saved) note(`Há uma conversa salva nesta pasta${saved.openTasks ? `, com ${saved.openTasks} tarefa(s) aberta(s)` : ''}. Digite /retomar para voltar a ela.`);
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

  const matches = !paste && !approval && value.startsWith('/') && !value.includes(' ') ? suggest(value.slice(1)) : [];

  const submit = (): void => {
    const text = value.trim();
    setInput(EMPTY_INPUT);
    if (paste) return submitPaste(paste, text);
    if (!text) return;
    rememberSent(text);
    if (text.startsWith('/')) {
      void runCommand(commands, text);
      return;
    }
    if (busy || working) return error('Espere terminar ou aperte Esc.');
    if (!loadCredential()) return error('Faça /login antes.');
    void runtime.send(text).catch((err: Error) => error(err.message));
  };

  useInput((typed, key) => {
    if (approval) {
      const answer = typed.toLowerCase();
      const pick: ApprovalAnswer | null = answer === 's' || answer === 'y' ? 'yes'
        : answer === 'n' || key.escape ? 'no'
          : (answer === 't' || answer === 'a') && approval.offerAlways ? 'always' : null;
      if (pick) {
        note(`${pick === 'no' ? '✗ Recusado' : '✓ Aprovado'}: ${approval.tool}`);
        approval.resolve(pick);
        setApproval(null);
      }
      return;
    }
    if (key.escape) {
      if (paste) {
        if (paste.kind === 'secret') paste.resolve?.(null);
        setPaste(null);
        setInput(EMPTY_INPUT);
        return;
      }
      loginAbort.current?.abort();
      runtime.cancel();
      return;
    }
    if (key.return) return submit();
    if (key.tab) {
      if (matches.length) setInput(inputAt(`/${matches[0].names[0]} `));
      return;
    }
    if (key.backspace || key.delete) return setInput(deleteBefore);
    if (key.ctrl && typed === 'u') return setInput(EMPTY_INPUT);
    if (key.ctrl && typed === 'w') return setInput(deleteWord);
    if (key.ctrl && typed === 'a') return setInput((old) => ({ ...old, cursor: 0 }));
    if (key.ctrl && typed === 'e') return setInput((old) => inputAt(old.text));
    if (key.leftArrow) return setInput((old) => move(old, -1));
    if (key.rightArrow) return setInput((old) => move(old, 1));
    if (key.upArrow && !paste) {
      if (sentAt.current > 0) setInput(inputAt(sent.current[--sentAt.current]));
      return;
    }
    if (key.downArrow && !paste) {
      if (sentAt.current < sent.current.length) setInput(inputAt(sent.current[++sentAt.current] ?? ''));
      return;
    }
    if (typed && !key.ctrl && !key.meta) {
      // Colar várias linhas não pode enviar a mensagem no meio.
      setInput((old) => insert(old, typed.replace(/\r\n?|\n/g, ' ')));
    }
  });

  const rows = (stdout as NodeJS.WriteStream | undefined)?.rows ?? 24;
  const columns = (stdout as NodeJS.WriteStream | undefined)?.columns ?? 80;
  // Só o fim do texto em andamento: desenhar mais que a tela faz o terminal piscar.
  const liveTail = useMemo(() => {
    if (!live?.text) return '';
    return live.text.split('\n').slice(-Math.max(rows - 10, 4)).join('\n');
  }, [live, rows]);
  // O tamanho do segredo também não aparece.
  const [beforeCursor, underCursor, afterCursor] = paste ? [value ? '••••••••' : '', ' ', ''] : splitAtCursor(input);
  const promptLabel = paste ? (paste.kind === 'token' ? 'token' : paste.name) : null;
  const activity = working ?? (state ? `${state.agent.name} · ${state.text}…` : null);
  const placeholder = 'Peça algo à equipe · Ask the team';

  return h(Box, { flexDirection: 'column' },
    h(Static<KeyedLine>, { items: lines, children: (line) => h(Box, { key: line.key }, h(Line, { line })) }),
    live?.text
      ? h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, null, h(Text, { color: agentColor(live.agent.id) }, '● '), h(Text, { bold: true, color: agentColor(live.agent.id) }, live.agent.name)),
        h(Box, { paddingLeft: 2 }, h(Markdown, { text: liveTail })))
      : null,
    busy ? h(Progress, { runtime, active: state?.agent.id ?? null, narrow: columns < 56 }) : null,
    activity ? h(Spinner, { label: activity }) : null,
    paste?.reason ? h(Text, { color: THEME.warn }, paste.reason) : null,
    approval
      ? h(Box, { flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: THEME.warn, paddingX: 1 },
        h(Text, { bold: true, color: THEME.warn }, `${approval.agent.name} pede permissão`),
        h(Text, { color: THEME.muted }, approval.reason),
        h(Box, { backgroundColor: THEME.blockWarn, paddingX: 1, marginY: 1 }, h(Text, null, describeCall(approval))),
        h(Text, null,
          h(Text, { color: THEME.ok }, '[s] sim  '),
          approval.offerAlways ? h(Text, { color: THEME.info }, '[t] sempre nesta conversa  ') : null,
          h(Text, { color: THEME.bad }, '[n] não')))
      : h(Box, { flexDirection: 'column', marginTop: 1 },
        matches.length
          ? h(Box, { flexDirection: 'column', paddingX: 1 },
            ...matches.slice(0, MAX_SUGGESTIONS).map((command) => h(Text, { key: command.names[0], wrap: 'truncate-end' },
              h(Text, { color: THEME.accent }, command.names.map((name) => `/${name}`).join(' ')), h(Text, { color: THEME.muted }, `  ${command.hint}`))),
            h(Text, { color: THEME.muted }, 'tab completa'))
          : null,
        h(Box, { borderStyle: 'round', borderColor: paste ? THEME.warn : THEME.muted, paddingX: 1 },
          // Quebra a linha em vez de cortar: na tela do celular, o texto longo sumia.
          h(Text, null,
            h(Text, { color: paste ? THEME.warn : THEME.accent }, promptLabel ? `${promptLabel}> ` : '> '),
            beforeCursor,
            h(Text, { inverse: true }, underCursor),
            afterCursor,
            !value && !paste ? h(Text, { color: THEME.muted }, placeholder) : null)),
        h(Box, { justifyContent: 'space-between', paddingX: 1 },
          // Em tela estreita, a dica não pode encostar no nome do modelo.
          h(Text, { color: THEME.muted, wrap: 'truncate-end' }, columns < 56 ? '/ comandos' : '/ comandos · esc interrompe'),
          h(Text, { color: THEME.muted, wrap: 'truncate-end' }, shortName(model).slice(0, MAX_MODEL_WIDTH)))));
}
