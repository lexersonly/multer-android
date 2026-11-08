// O que o Multer confere sozinho no trabalho do desenvolvedor: a sintaxe de cada arquivo gravado
// e se dá para fechar a tarefa. Modelos pequenos dizem "pronto" cedo demais; aqui não basta dizer.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const CHECK_SECONDS = 15;
const MAX_ERROR_CHARS = 600;

function run(command: string, args: string[], cwd: string): Promise<{ code: number | null; output: string } | null> {
  return new Promise((done) => {
    let output = '';
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), CHECK_SECONDS * 1000);
    child.stdout.on('data', (chunk: Buffer) => { output += String(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { output += String(chunk); });
    // Programa que não existe no aparelho (sem Python, por exemplo): não dá para conferir, e tudo bem.
    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, output: output.trim() });
    });
  });
}

const short = (text: string): string => (text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text);

/**
 * Confere a sintaxe sem rodar o programa. Devolve o erro, ou null quando está certo ou quando
 * não há como conferir esse tipo de arquivo neste aparelho.
 */
export async function syntaxError(root: string, path: string): Promise<string | null> {
  const full = resolve(root, path);
  const ext = extname(path).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(readFileSync(full, 'utf8'));
      return null;
    } catch (err) {
      return short(`JSON inválido: ${(err as Error).message}`);
    }
  }
  let result: Awaited<ReturnType<typeof run>> = null;
  if (ext === '.py') {
    result = await run('python3', ['-m', 'py_compile', full], root);
    if (!result) result = await run('python', ['-m', 'py_compile', full], root);
  } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    result = await run(process.execPath, ['--check', full], root);
  } else if (ext === '.sh') {
    result = await run('sh', ['-n', full], root);
  }
  if (!result || result.code === 0) return null;
  return short(result.output.replaceAll(full, path) || `Erro de sintaxe em ${path}.`);
}

const CHECKABLE = new Set(['.py', '.js', '.mjs', '.cjs', '.json', '.sh']);
export const canCheck = (path: string): boolean => CHECKABLE.has(extname(path).toLowerCase());

/**
 * As partes de um pedido, para o desenvolvedor conferir antes de fechar.
 * "jogo da cobrinha com placar, recorde salvo e controles por toque" vira três itens.
 */
export function requestParts(text: string): string[] {
  const parts = text
    .replace(/\s+/g, ' ')
    .split(/[\n;]|,\s*|\s+e\s+|\s+com\s+|\s+-\s+|\.\s+/i)
    .map((part) => part.trim().replace(/^(e|com|também|tambem)\s+/i, '').replace(/[.!?]+$/, ''))
    .filter((part) => part.length >= 6 && part.split(' ').length >= 2);
  return [...new Set(parts)].slice(0, 6);
}

export interface Gate {
  /** Arquivo gravado com erro de sintaxe, e o erro. */
  broken: Map<string, string>;
  /** O último comando que falhou, se nada mudou depois dele. */
  failedCommand: { command: string; summary: string } | null;
  changedFiles: number;
  okCommands: number;
  /** Quantas vezes o fechamento desta tarefa já foi recusado. */
  refusals: number;
  checklistShown: boolean;
  parts: string[];
}

export const MAX_GATE_REFUSALS = 3;

/**
 * Por que a tarefa ainda não pode ser concluída, ou null se pode. Depois de algumas recusas
 * deixa passar: o revisor e o testador vêm em seguida, e travar para sempre seria pior.
 */
export function closeRefusal(gate: Gate): { reason: string; checklist?: boolean } | null {
  if (gate.refusals >= MAX_GATE_REFUSALS) return null;
  if (!gate.changedFiles && !gate.okCommands) {
    return { reason: 'Você ainda não alterou nenhum arquivo nem rodou nada que deu certo, então a tarefa não está feita. Faça o trabalho agora com write_file ou edit_file e só depois use update_task. Se não for possível, use update_task com status blocked e explique o motivo.' };
  }
  if (gate.broken.size) {
    const list = [...gate.broken].map(([path, error]) => `- ${path}: ${error}`).join('\n');
    return { reason: `Ainda há erro de sintaxe no que você gravou:\n${list}\nCorrija com edit_file ou write_file e só depois use update_task.` };
  }
  if (gate.failedCommand) {
    return { reason: `O último comando falhou: ${gate.failedCommand.command} (${gate.failedCommand.summary}). Corrija e rode de novo antes de concluir. Se o erro não tem a ver com a tarefa, rode outro comando que mostre que ela funciona.` };
  }
  if (!gate.checklistShown && gate.parts.length >= 2) {
    const list = gate.parts.map((part) => `- ${part}`).join('\n');
    return { checklist: true, reason: `Antes de fechar, confira se o pedido inteiro foi feito:\n${list}\nSe faltou alguma parte, faça agora. Se está tudo feito, chame update_task de novo.` };
  }
  return null;
}
