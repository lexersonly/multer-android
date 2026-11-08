// Sem argumentos abre a interface na pasta atual.

import { existsSync, realpathSync } from 'node:fs';
import { createElement } from 'react';
import { Runtime } from './agents/runtime.ts';
import { inPath } from './auth/browser.ts';
import { loadCredential } from './auth/credentials.ts';
import { nodeMeetsRea, Plugins, REA_VERSION, reaScript } from './plugins/plugins.ts';
import { loadSettings } from './plugins/settings.ts';
import { attachPhone } from './phone.ts';
import { baseUrlFor, DEFAULT_MODEL } from './provider/client.ts';
import { sessionPath } from './session.ts';
import { checkForUpdate, localVersion, runUpdate } from './update.ts';

const USAGE = `multer                abre a interface na pasta atual
multer -p "pedido"    roda um pedido sem interface e recusa o que precisar de aprovação
multer --doutor       confere Node, navegador, login e REA
multer --doutor-rea   além disso, inicia o REA de verdade
multer --versao       mostra a versão
multer --atualizar    atualiza para a versão mais nova`;

async function doctor(startRea: boolean): Promise<number> {
  const credential = loadCredential();
  console.log(`Node ${process.version} em ${process.platform}/${process.arch}`);
  console.log(`Abrir navegador: ${inPath('termux-open-url') ? 'termux-open-url' : inPath('xdg-open') ? 'xdg-open' : 'nada encontrado (o endereço aparece na tela)'}`);
  console.log(`Login: ${credential ? `salvo (usa ${baseUrlFor(credential)})` : 'ainda não'}`);
  console.log(`Manter acordado: ${inPath('termux-wake-lock') ? 'termux-wake-lock' : 'indisponível fora do Termux'}`);
  console.log(`Avisos no celular: ${inPath('termux-notification') ? 'sim' : 'não (pkg install termux-api e o app Termux:API)'}`);
  console.log(`REA ${REA_VERSION} instalado: ${existsSync(reaScript()) ? 'sim' : 'não'}`);
  console.log(`Node atende ao REA: ${nodeMeetsRea() ? 'sim' : 'não (exige ^22.23.4, ^24.22.1 ou >=26.12.1)'}`);
  console.log(`REA autorizado: ${loadSettings().reaEnabled ? 'sim' : 'não (desligado até você autorizar)'}`);
  if (!startRea) return 0;
  const plugins = new Plugins();
  try {
    console.log(`REA iniciou: ${await plugins.connect()} ferramentas.`);
    return 0;
  } catch (err) {
    console.log(`REA NÃO iniciou: ${(err as Error).message}`);
    return 1;
  } finally {
    plugins.close();
  }
}

async function runOnce(prompt: string, runtime: Runtime): Promise<void> {
  runtime.on('line', (line) => {
    if (line.type === 'agent') console.log(`\n${line.agent.name}: ${line.text}`);
    else if (line.type === 'tool') console.log(`  ${line.ok ? 'ok' : 'erro'} ${line.tool}: ${line.summary}`);
    else if (line.type === 'delegate') console.log(`  -> ${line.to.name}: ${line.text}`);
    else if (line.type === 'review') console.log(`Revisão ${line.approved ? 'aprovada' : 'reprovada'}: ${line.text}`);
    else if (line.type === 'status' || line.type === 'error') console.log(line.text);
  });
  await runtime.send(prompt);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--ajuda') || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args.includes('--versao') || args.includes('--version')) {
    console.log(`multer-android ${localVersion()}`);
    return 0;
  }
  if (args.includes('--atualizar') || args.includes('--update') || args[0] === 'update') {
    const found = await checkForUpdate();
    if (!found) {
      console.error('Não consegui consultar a versão mais nova. Veja a internet e tente de novo.');
      return 1;
    }
    if (!found.available) {
      console.log(`Você já está na versão mais nova (${found.current}).`);
      return 0;
    }
    console.log(`Atualizando ${found.current} → ${found.latest}...`);
    const result = await runUpdate((line) => console.log(line));
    console.log(result.ok ? `Atualizado para ${localVersion()}.` : 'A atualização falhou. Veja a mensagem acima.');
    return result.ok ? 0 : 1;
  }
  if (args.includes('--doutor') || args.includes('--doutor-rea')) return doctor(args.includes('--doutor-rea'));

  const root = realpathSync(process.cwd());
  const plugins = new Plugins();
  const print = args.indexOf('-p');
  const runtime = new Runtime({
    root,
    plugins,
    getCredential: loadCredential,
    model: loadSettings().model ?? DEFAULT_MODEL,
    approve: async () => 'no',
    sessionFile: print >= 0 ? undefined : sessionPath(root),
  });

  // Fechar o terminal ou Ctrl+C não pode deixar um bot rodando escondido.
  process.on('exit', () => runtime.shutdown());
  process.on('SIGHUP', () => process.exit(129));
  process.on('SIGTERM', () => process.exit(143));

  if (print >= 0) {
    const prompt = args[print + 1];
    if (!prompt) {
      console.error(USAGE);
      return 2;
    }
    if (!loadCredential()) {
      console.error('Sem login. Abra o multer e use /login, ou defina POLLINATIONS_API_KEY.');
      return 1;
    }
    try {
      await runOnce(prompt, runtime);
      return 0;
    } finally {
      runtime.shutdown();
      plugins.close();
    }
  }

  if (!process.stdin.isTTY) {
    console.error('A interface precisa de um terminal. Sem terminal, use: multer -p "pedido"');
    return 2;
  }
  const { render } = await import('ink');
  const { App } = await import('./ui/app.ts');
  const releasePhone = attachPhone(runtime);
  process.on('exit', releasePhone);
  // Ctrl+C fica com o app: interrompe ou limpa, e só fecha na segunda vez, como no Claude Code.
  const app = render(createElement(App, { runtime, plugins, root }), { exitOnCtrlC: false });
  await app.waitUntilExit();
  releasePhone();
  runtime.shutdown();
  plugins.close();
  return 0;
}

process.exitCode = await main();
