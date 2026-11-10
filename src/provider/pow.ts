// Prova de trabalho do pool: achar a contagem que faz o sha256 do desafio começar com bits zero.
// É o preço para raspar: barato no celular, caro em volume.

import { createHash } from 'node:crypto';

const LIMITE = 50_000_000;

function zeros(bytes: Uint8Array): number {
  let total = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      total += 8;
      continue;
    }
    total += Math.clz32(byte) - 24;
    break;
  }
  return total;
}

/** Devolve a contagem que satisfaz o desafio. */
export function solve(nonce: string, bits: number): number {
  for (let counter = 0; counter < LIMITE; counter++) {
    if (zeros(createHash('sha256').update(`${nonce}:${counter}`).digest()) >= bits) return counter;
  }
  throw new Error('Não consegui resolver o desafio do pool.');
}
