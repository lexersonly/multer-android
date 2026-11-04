/** Assinatura curta e uma frase, que é o que basta para o modelo acertar os argumentos. */
export const TOOL_SPECS: Record<string, { args: string[]; about: string }> = {
  read_file: { args: ['path', 'offset?', 'limit?'], about: 'Lê um arquivo de texto.' },
  list_files: { args: ['path?', 'depth?'], about: 'Lista arquivos e pastas.' },
  search_code: { args: ['query', 'path?'], about: 'Procura texto nos arquivos.' },
  write_file: { args: ['path', 'content'], about: 'Cria ou substitui um arquivo.' },
  append_file: { args: ['path', 'content'], about: 'Acrescenta ao fim de um arquivo.' },
  edit_file: { args: ['path', 'old', 'new'], about: 'Troca um trecho exato e único de um arquivo.' },
  run_command: { args: ['command', 'timeout?'], about: 'Roda um comando na pasta do projeto.' },
  start_process: { args: ['name', 'command', 'env?'], about: 'Roda em segundo plano, como um bot. env lista nomes de segredos.' },
  process_logs: { args: ['name', 'lines?'], about: 'Mostra as últimas linhas do processo.' },
  stop_process: { args: ['name'], about: 'Para um processo em segundo plano.' },
  request_secret: { args: ['name', 'reason'], about: 'Pede ao usuário um segredo, como DISCORD_TOKEN. Você não vê o valor.' },
  assign_task: { args: ['title', 'assignee', 'description?'], about: 'Cria uma tarefa e entrega a um integrante.' },
  send_message: { args: ['to', 'text'], about: 'Manda mensagem a um integrante.' },
  update_task: { args: ['status', 'result?'], about: 'Atualiza a sua tarefa (completed ou blocked).' },
  submit_review: { args: ['approved', 'summary'], about: 'Registra o resultado da revisão.' },
  find_tools: { args: ['query'], about: 'Procura ferramentas de plugins.' },
  request_plugin: { args: ['plugin', 'reason'], about: 'Pede para ligar um plugin; o usuário decide.' },
};

/** Nomes de arquivo que nenhuma ferramenta abre e nenhum comando toca sem perguntar. */
export const SENSITIVE = /(^|[\s/"'=])(\.env(\.[\w-]+)?|\.netrc|\.npmrc|\.git-credentials|credentials?(\.\w+)?|secrets?\.\w+|id_(rsa|ed25519|ecdsa)|[\w-]+\.pem)($|[\s/"'])/i;
