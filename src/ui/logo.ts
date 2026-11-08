// O nome MULTER em letras de bloco, com um brilho que passa da esquerda para a direita ao abrir.
// Duas fontes: a grande (como o "CLAUDE CODE" antigo) para telas largas e uma de 3 linhas para o celular.

import { Box, Text } from 'ink';
import { createElement as h, type ReactElement, useEffect, useState } from 'react';

const BIG: Record<string, string[]> = {
  M: ['███╗   ███╗', '████╗ ████║', '██╔████╔██║', '██║╚██╔╝██║', '██║ ╚═╝ ██║', '╚═╝     ╚═╝'],
  U: ['██╗   ██╗', '██║   ██║', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
  L: ['██╗     ', '██║     ', '██║     ', '██║     ', '███████╗', '╚══════╝'],
  T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
};

const SMALL: Record<string, string[]> = {
  M: ['█▄ ▄█', '█ ▀ █', '▀   ▀'],
  U: ['█   █', '█   █', '▀▄▄▄▀'],
  L: ['█    ', '█    ', '█▄▄▄▄'],
  T: ['▀▀█▀▀', '  █  ', '  ▀  '],
  E: ['█▀▀▀▀', '█▀▀▀ ', '█▄▄▄▄'],
  R: ['█▀▀▀▄', '█▄▄▄▀', '▀   ▀'],
};

/** As linhas do nome na fonte escolhida, com uma coluna vazia entre as letras. */
export function logoRows(word: string, font: 'big' | 'small'): string[] {
  const letters = Array.from(word).map((letter) => (font === 'big' ? BIG : SMALL)[letter]);
  return letters[0].map((_, row) => letters.map((letter) => letter[row]).join(font === 'big' ? '' : ' '));
}

export const logoWidth = (font: 'big' | 'small'): number => Array.from(logoRows('MULTER', font)[0]).length;

/** Roxo do Multer até o azul e o rosa, como no site. */
const STOPS = [[139, 92, 246], [96, 165, 250], [244, 114, 182]];

function gradient(t: number): string {
  const scaled = Math.min(Math.max(t, 0), 1) * (STOPS.length - 1);
  const index = Math.min(Math.floor(scaled), STOPS.length - 2);
  const local = scaled - index;
  const [a, b] = [STOPS[index], STOPS[index + 1]];
  const mix = a.map((value, channel) => Math.round(value + (b[channel] - value) * local));
  return `#${mix.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

const SHINE_FRAMES = 22;

/**
 * O logo com o gradiente. `animate` faz um brilho branco atravessar o nome uma vez; depois
 * ele fica parado, para o celular não redesenhar à toa.
 */
export function Logo({ font, animate }: { font: 'big' | 'small'; animate: boolean }): ReactElement {
  const rows = logoRows('MULTER', font);
  const width = Array.from(rows[0]).length;
  const [frame, setFrame] = useState(animate ? 0 : SHINE_FRAMES);
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setFrame((old) => {
      if (old >= SHINE_FRAMES) clearInterval(timer);
      return Math.min(old + 1, SHINE_FRAMES);
    }), 55);
    return () => clearInterval(timer);
  }, [animate]);
  const shine = frame < SHINE_FRAMES ? (frame / SHINE_FRAMES) * (width + 12) - 6 : -100;
  return h(Box, { flexDirection: 'column' },
    ...rows.map((row, y) => h(Text, { key: y },
      ...Array.from(row).map((char, x) => {
        if (char === ' ') return ' ';
        const near = Math.abs(x - y - shine) < 3;
        return h(Text, { key: x, color: near ? '#ffffff' : gradient(x / width) }, char);
      }))));
}
