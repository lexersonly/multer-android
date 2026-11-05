// A caixa de texto: cursor por caractere, para emoji não virar lixo ao apagar.

export interface InputState {
  text: string;
  cursor: number;
}

export const EMPTY_INPUT: InputState = { text: '', cursor: 0 };

const chars = (text: string): string[] => Array.from(text);

export const inputAt = (text: string): InputState => ({ text, cursor: chars(text).length });

export function insert({ text, cursor }: InputState, typed: string): InputState {
  const list = chars(text);
  const added = chars(typed);
  list.splice(cursor, 0, ...added);
  return { text: list.join(''), cursor: cursor + added.length };
}

export function deleteBefore({ text, cursor }: InputState): InputState {
  if (cursor === 0) return { text, cursor };
  const list = chars(text);
  list.splice(cursor - 1, 1);
  return { text: list.join(''), cursor: cursor - 1 };
}

export function deleteWord({ text, cursor }: InputState): InputState {
  const list = chars(text);
  let start = cursor;
  while (start > 0 && list[start - 1] === ' ') start--;
  while (start > 0 && list[start - 1] !== ' ') start--;
  list.splice(start, cursor - start);
  return { text: list.join(''), cursor: start };
}

export function move({ text, cursor }: InputState, by: number): InputState {
  return { text, cursor: Math.min(chars(text).length, Math.max(0, cursor + by)) };
}

/** O que vem antes do cursor, o caractere sob ele e o resto. */
export function splitAtCursor({ text, cursor }: InputState): [string, string, string] {
  const list = chars(text);
  return [list.slice(0, cursor).join(''), list[cursor] ?? ' ', list.slice(cursor + 1).join('')];
}
