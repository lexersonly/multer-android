// Token só de leitura do pool gratuito. Fica no repositório porque o app é público e precisa
// funcionar sem configuração; não dá acesso a nada além de ler chaves descartáveis, e pode ser
// trocado no servidor a qualquer momento (quem quiser outro usa MULTER_FREE_TOKEN).
//
// Guardado em pedaços, em base64 e ao contrário: quem abre o arquivo não leva o token de
// bandeja, e no build ainda vai tudo minificado. Não é segredo de verdade — é atrito.
// Separado do token que ESCREVE chaves: vazar este não deixa ninguém injetar no pool.

const PARTES = ['NDc1MmM0MzE3YTI2NzQ0N2', 'UxNDZlNmEyOTdlOGU1Yjcw', 'MDg2MDE2MzEwMGMwNWFj'];

const embutido = (): string =>
  Buffer.from(PARTES.join(''), 'base64').toString().split('').reverse().join('');

export const FREE_TOKEN = process.env.MULTER_FREE_TOKEN?.trim() || embutido();
