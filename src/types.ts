export type ToolArgs = Record<string, unknown>;

export interface ToolCall {
  name: string;
  args: ToolArgs;
}

export interface ParsedResponse {
  text: string;
  tool?: ToolCall;
  parseError?: string;
}

export interface ToolOutcome {
  ok: boolean;
  summary: string;
  content: string;
  /** O turno do agente termina aqui (revisão registrada, tarefa fechada). */
  endsTurn?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  color: string;
  lead?: boolean;
  tools: string[];
  rule: string;
}

export type TaskStatus = 'in_progress' | 'completed' | 'blocked' | 'cancelled';

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string;
  status: TaskStatus;
  result?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type HistoryItem =
  | { type: 'user'; text: string }
  | { type: 'agent'; agentId: string; name: string; text: string };

export type ApprovalAnswer = 'yes' | 'always' | 'no';

export interface ApprovalRequest {
  agent: Agent;
  tool: string;
  args: ToolArgs;
  reason: string;
  offerAlways: boolean;
}

export type Approver = (request: ApprovalRequest) => Promise<ApprovalAnswer>;

/** O que aparece no histórico da tela. */
export type UiLine =
  | { type: 'banner'; root: string; model: string }
  | { type: 'user'; text: string }
  | { type: 'agent'; agent: Agent; text: string }
  | { type: 'tool'; agent: Agent; tool: string; detail: string; ok: boolean; summary: string }
  | { type: 'delegate'; to: Agent; text: string }
  | { type: 'review'; approved: boolean; text: string }
  | { type: 'status'; text: string }
  | { type: 'error'; text: string };

export interface PluginTool {
  fullName: string;
  remoteName: string;
  description: string;
  schema: { properties?: unknown };
}
