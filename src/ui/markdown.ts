// Mostra o texto dos agentes com a formatação: negrito, código, títulos, listas e blocos.
// Sem JSX, e sem biblioteca: só o que os modelos costumam escrever.

import { Box, Text } from 'ink';
import { createElement as h, type ReactElement } from 'react';
import { THEME } from './theme.ts';

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*]))/g;

export function inline(text: string, prefix: string): ReactElement[] {
  return text.split(INLINE).filter((part) => part !== '').map((part, index) => {
    const key = `${prefix}${index}`;
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return h(Text, { key, bold: true }, part.slice(2, -2));
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return h(Text, { key, color: THEME.code }, part.slice(1, -1));
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) return h(Text, { key, italic: true }, part.slice(1, -1));
    return h(Text, { key }, part);
  });
}

export function Markdown({ text }: { text: string }): ReactElement {
  const blocks: ReactElement[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let code = null as string[] | null;
  let gap = false;

  lines.forEach((line, index) => {
    const key = `l${index}`;
    if (line.trimStart().startsWith('```')) {
      if (code) {
        blocks.push(h(Box, { key, flexDirection: 'column', backgroundColor: THEME.block, paddingX: 1 },
          ...code.map((row, i) => h(Text, { key: `c${i}`, color: '#e5e7eb' }, row || ' '))));
        code = null;
      } else {
        code = [];
      }
      return;
    }
    if (code) {
      code.push(line);
      return;
    }
    if (!line.trim()) {
      gap = true;
      return;
    }
    if (gap && blocks.length) blocks.push(h(Text, { key: `${key}g` }, ' '));
    gap = false;

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^(\s*)[-*•]\s+(.*)$/);
    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (heading) blocks.push(h(Text, { key, bold: true, color: THEME.accent }, ...inline(heading[2], key)));
    else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) blocks.push(h(Text, { key, color: THEME.muted }, '────────────'));
    else if (bullet) blocks.push(h(Box, { key, paddingLeft: Math.min(bullet[1].length, 6) },
      h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: THEME.accent }, '• ')), h(Text, null, ...inline(bullet[2], key))));
    else if (numbered) blocks.push(h(Box, { key, paddingLeft: Math.min(numbered[1].length, 6) },
      h(Box, { flexShrink: 0, marginRight: 1 }, h(Text, { color: THEME.accent }, `${numbered[2]}.`)), h(Text, null, ...inline(numbered[3], key))));
    else if (quote) blocks.push(h(Text, { key, color: THEME.muted, italic: true }, `▎ ${quote[1]}`));
    else blocks.push(h(Text, { key }, ...inline(line, key)));
  });

  // Bloco de código ainda aberto: o texto está chegando.
  if (code) {
    blocks.push(h(Box, { key: 'open', flexDirection: 'column', backgroundColor: THEME.block, paddingX: 1 },
      ...code.map((row, i) => h(Text, { key: `o${i}`, color: '#e5e7eb' }, row || ' '))));
  }
  return h(Box, { flexDirection: 'column' }, ...blocks);
}
