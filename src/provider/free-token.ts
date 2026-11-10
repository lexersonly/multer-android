// Token só de leitura do pool gratuito. Fica no repositório porque o app é público e precisa
// funcionar sem configuração; não dá acesso a nada além de ler chaves descartáveis, e pode ser
// trocado no servidor a qualquer momento (quem quiser outro usa MULTER_FREE_TOKEN).
// Separado do token que ESCREVE chaves: vazar este não deixa ninguém injetar no pool.

export const FREE_TOKEN = process.env.MULTER_FREE_TOKEN?.trim() || 'ca50c001361068007b5e8e792a6e641e744762a7134c2574';
