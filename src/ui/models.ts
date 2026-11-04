// Escolha de modelo por número ou por pedaço do nome: `/modelo 2`, `/model glm`.

export type Resolution =
  | { kind: 'one'; id: string }
  | { kind: 'many'; ids: string[] }
  | { kind: 'none' };

export const shortName = (id: string): string => id.split('/').pop() ?? id;

/** `community/dono/nome` mostra o dono ao lado, para diferenciar cópias do mesmo modelo. */
export const ownerOf = (id: string): string => {
  const parts = id.split('/');
  return parts.length >= 3 ? parts[1] : parts.length === 2 ? parts[0] : '';
};

export function resolveModel(input: string, list: string[]): Resolution {
  const arg = input.trim().toLowerCase();
  if (!arg) return { kind: 'none' };
  if (/^\d+$/.test(arg)) {
    const id = list[Number(arg) - 1];
    return id ? { kind: 'one', id } : { kind: 'none' };
  }
  const tiers: Array<(id: string) => boolean> = [
    (id) => id.toLowerCase() === arg,
    (id) => shortName(id).toLowerCase() === arg,
    (id) => shortName(id).toLowerCase().startsWith(arg),
    (id) => id.toLowerCase().startsWith(arg),
    (id) => shortName(id).toLowerCase().includes(arg),
    (id) => id.toLowerCase().includes(arg),
  ];
  for (const matches of tiers) {
    const found = list.filter(matches);
    if (found.length === 1) return { kind: 'one', id: found[0] };
    if (found.length > 1) return { kind: 'many', ids: found };
  }
  return { kind: 'none' };
}

export function formatModels(list: string[], current: string): string {
  const width = Math.min(Math.max(...list.map((id) => shortName(id).length), 8), 30);
  return list
    .map((id, index) => {
      const mark = id === current ? '●' : ' ';
      const owner = ownerOf(id);
      return `${String(index + 1).padStart(2)} ${mark} ${shortName(id).padEnd(width)}${owner ? `  ${owner}` : ''}`;
    })
    .join('\n');
}
