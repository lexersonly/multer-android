# multer-android

Uma equipe de agentes de IA no terminal do seu Android. O Multer roda dentro do Termux e trabalha nos arquivos reais do seu projeto, com a resposta aparecendo em streaming.

> **Estado do projeto:** funciona no Termux e **recebe atualizações toda semana**. Para pegar as novas versões, digite `/atualizar`. Como todo projeto em evolução, **pode bugar**: entre no [Discord](https://discord.gg/tjbU6Vknm) ou veja como [reportar bugs e dar sugestões](#bugs-e-sugestões).

## Novidades

O Multer recebe atualizações toda semana. Para receber, digite `/atualizar`.

**0.4.0**
- Os agentes guardam o que já leram e param de reler os mesmos arquivos. Quem lê demais sem agir é cobrado e depois precisa fazer a tarefa.
- Desenvolvedor que só fala não conclui mais a tarefa: ela volta uma vez com o que já foi feito e, se não andar, aparece como não concluída.
- Digite `continua` e a tarefa aberta volta direto para quem cuida dela.
- A conversa fica salva por pasta: se o Android fechar o Termux, `/retomar` traz de volta.
- O Termux fica acordado enquanto a equipe trabalha. Com o Termux:API, o celular avisa quando ela termina ou pede permissão.
- Caixa de texto com cursor, quebra de linha e emoji que apaga inteiro, e uma linha mostrando em que etapa o pedido está.
- Modelo preso repetindo a mesma frase é cortado, em vez de gastar a cota.
- Novos comandos: `/retomar`, `/cancelar` e `/arquivos`.

**0.3.0**
- A equipe trabalha sozinha: o arquiteto entrega o pedido, e o desenvolvedor, o revisor e o testador seguem em sequência. Se o arquiteto demorar, o pedido vai direto ao desenvolvedor.
- Atualização pelo próprio Multer, com `/atualizar`, sem repetir a linha de instalação.
- Interface no estilo do Claude Code, com o texto dos agentes formatado.
- Troca de modelo por número ou pelo começo do nome, e recuperação automática de um modelo que a conta não conhece.
- Comandos em português e inglês, com sugestões enquanto você digita.
- Bots e servidores em segundo plano, com segredos que os agentes nunca veem, para criar e rodar um bot do Discord.
- Instalação sem git e sem login no GitHub, com plano B caso o Bun falhe.

**0.2.0**
- Login com o token copiado do APK Multer Token, no lugar do adb.

## Recursos

- **Equipe de quatro agentes:** o arquiteto entrega o pedido ao desenvolvedor, e a revisão e o teste vêm sozinhos em seguida. Se o arquiteto demorar mais de 60 segundos, o pedido vai direto ao desenvolvedor.
- **Ferramentas reais:** ler, escrever e editar arquivos, buscar no código e rodar comandos.
- **Aprovação de ações perigosas:** você decide antes de um comando arriscado rodar.
- **Feito para modelos pequenos:** o prompt é curto e o parser entende chamadas de ferramenta malformadas. Respostas cortadas são gravadas em partes.
- **Bots e servidores:** os agentes rodam processos em segundo plano e guardam tokens sem ver o valor.
- **Comandos em português e inglês**, com sugestões enquanto você digita.
- **Conversa salva por pasta:** só neste aparelho, em arquivo privado. `/retomar` volta a ela, e `/limpar` apaga.
- **Feito para o celular:** mantém o Termux acordado durante o trabalho e, com `pkg install termux-api` e o app Termux:API, avisa quando termina ou pede permissão.
- **REA incluído:** o plugin de análise vem instalado e fica desligado até você autorizar.

## Requisitos

- Android com [Termux](https://termux.dev).
- Node.js `>=22.18` e Bun. O instalador cuida dos dois.
- Uma conta no Pollinations.
- **O APK Multer Token** (cerca de 8 MB), para pegar o token de login: [baixar o APK](https://multer-phi.vercel.app/downloads/multer-token.apk) ou ver a [página de downloads](https://multer-phi.vercel.app/#downloads). Sem ele, use o [`/login chave`](#login-pelo-navegador-sem-o-apk).

## Instalação

No Termux, cole esta linha. Ela não usa git e não pede login no GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/lexersonly/multer-android/main/bootstrap.sh | bash
```

Ela baixa o projeto em `~/multer-android` e instala o `nodejs-lts`, o `bun` e o comando `multer`. Se preferir ler o script antes de rodar, ele é o [`bootstrap.sh`](bootstrap.sh).

Para conferir a instalação:

```bash
multer --doutor
```

### Instalar com git

O repositório é público, então o clone não precisa de conta. Se pedir username, o endereço está errado: veja [Problemas comuns](#instalação-1).

```bash
pkg update -y && pkg install -y git
```

```bash
GIT_TERMINAL_PROMPT=0 git clone https://github.com/lexersonly/multer-android.git ~/multer-android
```

```bash
bash ~/multer-android/install.sh
```

### Atualizar

Dentro do `multer`, digite `/atualizar` (ou `/update`). Ele confere a versão no GitHub, baixa a nova e reinstala, e mantém o seu login e as suas configurações, que ficam em `~/.config/multer-android`. Depois, feche e abra o `multer`.

Ao abrir, o Multer avisa se há versão nova. Fora da interface, use `multer --atualizar`.

Não guarde arquivos seus dentro de `~/multer-android`: a atualização troca a pasta inteira.

### Desinstalar

```bash
rm -rf ~/multer-android ~/.config/multer-android "$PREFIX/bin/multer"
```

## Login

### Com o token do APK

1. [Baixe o APK Multer Token](https://multer-phi.vercel.app/downloads/multer-token.apk), instale, abra, entre com o Discord e faça o login no Pollinations.
2. O APK mostra o token. Toque em **Copiar**.
3. No Termux, abra o `multer`, digite `/login`, cole o token e aperte Enter.

O token tem este formato, e o `oauth_session_id` é obrigatório:

```text
token=<seu-token>; oauth_session_id=<sua-sessão>
```

O Multer confere o token no Pollinations antes de guardar. Ele não aparece na tela e fica só em `~/.config/multer-android/credential`, com leitura restrita ao Termux. Trate-o como uma senha: quem tiver o token acessa a sua sessão.

### Login pelo navegador, sem o APK

`/login chave` usa o login oficial do Pollinations para terminais: abre o navegador, você aprova e o Multer recebe uma chave `sk_`, válida por 7 dias se você não mudar. Ela usa a API `gen.pollinations.ai`, em vez do Open WebUI do token.

### Variável de ambiente

`POLLINATIONS_API_KEY` também é aceita e tem prioridade sobre a credencial salva.

## Uso

Entre na pasta do projeto e abra o Multer:

```bash
cd ~/meu-projeto
```

```bash
multer
```

Escreva o pedido e aperte Enter: ele vai para o arquiteto. Para falar direto com um integrante, comece com o nome dele, como `@revisor olhe o index.html`.

Para rodar um pedido sem interface, use `multer -p "pedido"`. Nesse modo, tudo o que precisaria de aprovação é recusado.

### Comandos

Todo comando tem nome em português e em inglês. Digite `/` para ver a lista e aperte `Tab` para completar.

| Comando | O que faz |
| --- | --- |
| `/login`, `/entrar` | Colar o token do APK |
| `/login chave`, `/login key` | Entrar pelo navegador, sem o APK |
| `/logout`, `/sair-da-conta` | Apagar a credencial do aparelho |
| `/modelos`, `/models` | Testar e listar os modelos gratuitos |
| `/modelo N`, `/model N` | Trocar de modelo por número ou pelo começo do nome |
| `/segredo NOME`, `/secret NOME` | Guardar um segredo, como `DISCORD_TOKEN` |
| `/processos`, `/ps` | Ver bots e servidores em segundo plano |
| `/logs NOME`, `/parar NOME`, `/stop NOME` | Ver a saída ou parar um processo |
| `/equipe`, `/team` | Ver os agentes |
| `/tarefas`, `/tasks` | Ver as tarefas |
| `/rea ligar`, `/rea desligar` | Autorizar ou desligar o REA |
| `/limpar`, `/clear` | Começar outra conversa |
| `/atualizar`, `/update` | Atualizar o Multer |
| `/ajuda`, `/help` | Ver a ajuda |
| `/sair`, `/exit` | Fechar |
| `@revisor texto` | Falar direto com um agente |
| `Esc` | Cancelar o que estiver rodando |

Para trocar de modelo, rode `/modelos` e use o número (`/modelo 2`) ou o começo do nome (`/model glm`). Se mais de um combinar, o Multer mostra as opções.

## Bot do Discord

Peça ao Multer, por exemplo: `crie um bot de Discord que responde /ping e rode ele`. O desenvolvedor escreve o bot com discord.js e o roda em segundo plano, enquanto o `multer` estiver aberto.

1. **Crie o bot** no [Portal de Desenvolvedores do Discord](https://discord.com/developers/applications), copie o token dele e convide o bot para o seu servidor.
2. **Entregue o token** quando o agente pedir, ou antes, com `/segredo DISCORD_TOKEN`. Ele é colado sem aparecer na tela e fica em `~/.config/multer-android/secrets.json`, com leitura restrita ao Termux.
3. **Aprove** quando o agente pedir para rodar o bot. O comando e os segredos usados aparecem na tela.

Os agentes só sabem o **nome** do segredo. O valor vai direto para o ambiente do bot e é trocado por `***` em qualquer log que volte para o modelo. Veja o que está rodando com `/processos` e pare com `/parar NOME`.

Ao fechar o `multer`, os bots são encerrados. Para um bot rodar com o celular bloqueado, use `termux-wake-lock` e deixe o Termux aberto. O Android pode encerrá-lo em segundo plano.

### Aprovação

| Situação | O que acontece |
| --- | --- |
| Comando que só lê dentro do projeto | Roda direto |
| Outros comandos | Pergunta: `[s] sim`, `[t] sempre nesta conversa` ou `[n] não` |
| Comandos destrutivos, credenciais, `git push`, `adb`, `pkg install` e parecidos | Pergunta toda vez |
| Rodar algo em segundo plano, como um bot | Pergunta, mostrando o comando e os segredos usados |

As ferramentas de arquivo não saem da pasta do projeto nem abrem `.env` e arquivos parecidos. Os comandos dos agentes não recebem a sua credencial pelas variáveis de ambiente.

## REA

O [`rea-agents`](https://www.npmjs.com/package/rea-agents) 6.8.0 é o plugin de análise de bytes, formatos binários e aplicações. Ele fica desligado até você usar `/rea ligar` ou aprovar o pedido de um agente. As 229 ferramentas ficam fora do prompt: os agentes as procuram com `find_tools`.

O REA exige Node `^22.23.4 || ^24.22.1 || >=26.12.1`. O Termux oferece `nodejs-lts` 24.22.2 e `nodejs` 26.13.0, e os dois atendem. Com um Node mais antigo, o Multer explica o motivo e não liga o REA.

Use o REA só para análise lícita.

## Dicas no celular

- **Colar:** toque e segure na tela do Termux e escolha **Paste**.
- **Esc e Ctrl:** ficam na linha de teclas extras do Termux. Se ela não aparecer, aperte **Volume + e Q**.
- **Tarefas longas:** o Android pode encerrar o Termux em segundo plano. Antes de tarefas longas, rode `termux-wake-lock`; ao terminar, `termux-wake-unlock`.
- **Pastas do celular:** o Multer trabalha melhor em pastas do Termux, como `~/meu-projeto`. Para acessar os arquivos do aparelho, rode `termux-setup-storage` uma vez; eles aparecem em `~/storage/shared`.
- **Espaço:** reserve cerca de 200 MB para o projeto, além do Node e do Bun, que somam cerca de 130 MB.

## Problemas comuns

Comece sempre por `multer --doutor`: ele mostra o Node, o login e o REA, sem revelar a credencial.

### Instalação

| O que aparece | Causa provável | Solução |
| --- | --- | --- |
| `Username for 'https://github.com'` | Endereço digitado errado: o GitHub pede login quando o repositório não existe ou é privado | Aperte `Ctrl+C`, não digite senha e use a linha de instalação com `curl` |
| `curl: (6) Could not resolve host` | Sem internet ou DNS falhando | Confira a conexão, troque entre Wi-Fi e dados móveis e tente de novo |
| `curl: (22)` ou `O download veio incompleto` | Falha no download | Rode a linha de novo: a instalação anterior só é trocada depois de um download completo |
| `Unable to locate package` ou erro de repositório no `pkg` | Lista de pacotes velha ou espelho fora do ar | Rode `pkg update`. Se continuar, rode `termux-change-repo`, escolha outro espelho e tente de novo |
| `pkg` falhando sempre, mesmo trocando o espelho | Termux antigo, como o da Play Store | Instale a versão atual pelo [F-Droid](https://f-droid.org/packages/com.termux/) ou pelo [GitHub do Termux](https://github.com/termux/termux-app/releases) |
| `Este instalador é para o Termux` | O script rodou fora do Termux | Rode dentro do app Termux |
| `Não consegui instalar o Bun` ou `O bun install falhou` | Espelho do Termux fora do ar, download cortado ou falta de espaço | O instalador tenta o pacote do Termux, depois o Bun oficial e, por último, segue com o `npm`. Se até o `npm` falhar, rode `termux-change-repo` e `df -h ~` e instale de novo |
| `bun: command not found` | Instalação antiga, de antes dessas tentativas | Rode a linha de instalação com `curl` de novo |
| `multer: command not found` | A instalação não terminou ou o terminal não atualizou | Feche e abra o Termux. Se continuar, rode a instalação de novo |
| `bad interpreter: /usr/bin/env` | Você rodou `bin/multer.js` direto | Use o comando `multer`, que o instalador cria |
| `ERR_UNKNOWN_FILE_EXTENSION` ou erro de sintaxe ao abrir | Node anterior ao 22.18 | Rode `pkg install nodejs-lts` |

### Login

| O que aparece | Causa provável | Solução |
| --- | --- | --- |
| `O token veio sem o oauth_session_id` | Só parte do texto foi colada | No APK, toque em **Copiar** de novo e cole o texto inteiro |
| `O Pollinations recusou este token` | Token vencido ou de outra sessão | Faça login de novo no APK e copie outra vez |
| `Token salvo, mas sem conferir` | Sem conexão com o Pollinations | Pode usar assim: se o token for inválido, o erro aparece no primeiro pedido |
| `A sessão expirou ou é inválida: rode /login` | O login venceu durante o uso | Rode `/login` e cole um token novo |
| `Faça /login antes` | Ainda não há credencial | Rode `/login` ou `/login chave` |
| O navegador não abre no `/login chave` | `termux-open-url` indisponível | Abra no navegador o endereço que aparece na tela e digite o código |
| `O código de login expirou` | Passaram os 30 minutos do código | Rode `/login chave` de novo |

### Modelos e agentes

| O que aparece | Causa provável | Solução |
| --- | --- | --- |
| `Model not found` | O modelo salvo não existe na conta que você usa agora | O Multer confere a lista da conta e troca sozinho para um modelo que existe. Se ainda aparecer, a mensagem mostra o modelo e o endereço usados: me mande isso |
| `demorou mais de 60s` | Modelo de raciocínio lento no arquiteto | O pedido segue direto para o desenvolvedor. Para evitar, troque o modelo com `/modelos` |
| `Nenhum modelo gratuito respondeu agora` | Modelos comunitários fora do ar | Tente mais tarde. Se usar o token, confira também se ele ainda vale |
| `disse que ia agir, mas o modelo não chamou a ferramenta` | Modelo pequeno demais para o protocolo | Troque com `/modelos` e `/modelo N` |
| `errou o formato da ferramenta` ou `repetiu a mesma` | O modelo ficou preso | Troque de modelo e peça de novo |
| `foi cortado N vezes no limite` | Arquivo grande demais para o modelo | Peça em partes menores ou troque de modelo |
| `A equipe ainda está trabalhando` ou `Espere terminar` | Há uma tarefa rodando | Espere ou aperte `Esc` |

### REA

| O que aparece | Causa provável | Solução |
| --- | --- | --- |
| `O REA 6.8.0 exige Node` | Node sem a versão exigida | Rode `pkg install nodejs-lts` |
| `O rea-agents não está instalado` | Instalação incompleta | Rode a instalação de novo |
| `O REA não iniciou` | Falha ao abrir o plugin | Rode `multer --doutor-rea` para ver o erro |
| Uma ferramenta do REA falha e as outras funcionam | Ela pode depender de `node-pty` ou `frida`, sem binário para Android | É uma limitação conhecida; peça ao agente outra ferramenta com `find_tools` |

### Ainda com problema

[Reporte na seção de bugs](#bugs-e-sugestões), com a saída de `multer --doutor` e o erro completo.

## Limitações

- **Pode bugar:** cada celular e cada versão do Android é diferente, e os modelos gratuitos mudam de comportamento. Se algo falhar no seu, [reporte o bug](#bugs-e-sugestões) no Discord.
- **REA no Android:** o `@lydell/node-pty` e o `frida` não têm binário para Android, então ferramentas que dependem de PTY ou de instrumentação de processo podem falhar.
- **Conversa sem persistência:** ao fechar o `multer`, a conversa e as tarefas se perdem.
- **Modelos gratuitos:** são comunitários e podem sair do ar. Use `/modelos` para ver quais respondem agora.
- **Validade do login:** o token e a chave `sk_` expiram. Quando isso acontecer, faça o login de novo.
- **Sem pesquisa na internet:** os agentes não têm ferramenta de busca na web.

## Bugs e sugestões

O Multer está em evolução e pode bugar, principalmente em modelos que respondem de um jeito diferente e em aparelhos diferentes. O melhor jeito de ajudar é contar o que aconteceu:

- **Discord:** [entre no servidor](https://discord.gg/tjbU6Vknm) para reportar bugs, dar sugestões e acompanhar as novidades da semana.
- **Bug ou ideia:** [abra uma issue](https://github.com/lexersonly/multer-android/issues/new). Vale tanto para erro quanto para sugestão de melhoria.
- **Inclua:** o que você pediu, o que aconteceu, o texto do erro e a saída de `multer --doutor` e de `multer --versao`.
- **Nunca publique o seu token.**

## Desenvolvimento

O código é TypeScript, e o Node remove os tipos ao carregar. Por isso não há etapa de build no celular.

```bash
bun install
```

```bash
bun run check
```

```text
bin/multer.js   entrada
src/cli.ts      argumentos e modos
src/agents/     parser, equipe, prompt e laço dos agentes
src/auth/       credencial, token colado e login pelo navegador
src/provider/   chat com streaming
src/tools/      arquivos, busca, comandos e aprovação
src/plugins/    cliente MCP e REA
src/ui/         interface e comandos
test/           testes
```

A interface usa [Ink](https://github.com/vadimdemedes/ink), porque roda no Node do Termux sem compilar nada e é o mesmo Node de que o REA precisa.

## Licença

[MIT](LICENSE).
