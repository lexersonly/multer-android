// Cores. Truecolor no Termux; terminais com menos cores aproximam sozinhos.

export const THEME = {
  accent: '#d97757',
  accentDim: '#8a5a48',
  ok: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
  info: '#60a5fa',
  muted: '#8b8fa3',
  block: '#26233a',
  code: '#f0abfc',
  blockWarn: '#2e2a1a',
} as const;

const AGENT_COLORS: Record<string, string> = {
  arquiteto: '#c084fc',
  desenvolvedor: '#60a5fa',
  revisor: '#fbbf24',
  testador: '#34d399',
};

export const agentColor = (id: string): string => AGENT_COLORS[id] ?? THEME.accent;

export const SPINNER = ['✻', '✽', '✶', '✳', '✢', '·'];

export const TOOL_LABEL: Record<string, string> = {
  read_file: 'Ler', write_file: 'Gravar', create_file: 'Gravar', append_file: 'Acrescentar', edit_file: 'Editar',
  list_files: 'Listar', search_code: 'Buscar', run_command: 'Comando', start_process: 'Iniciar', process_logs: 'Logs',
  stop_process: 'Parar', request_secret: 'Segredo', assign_task: 'Delegar', send_message: 'Mensagem', update_task: 'Tarefa',
  submit_review: 'Revisão', find_tools: 'Ferramentas', request_plugin: 'Plugin',
};

export const toolLabel = (name: string): string =>
  TOOL_LABEL[name] ?? (name.startsWith('mcp__') ? `REA ${name.split('__').pop()}` : name);
