// Session status constants
export const SessionStatus = {
  creating: 'creating',
  running: 'running',
  stopped: 'stopped',
  error: 'error',
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

// Message type constants
export const MessageType = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
  result: 'result',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

// Session interface
export interface Session {
  id: string;
  name: string;
  repoUrl: string;
  branch: string;
  worktreePath: string;
  containerId: string | null;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
}

// Message interface
export interface Message {
  id: string;
  sessionId: string;
  sequence: number;
  type: MessageType;
  content: string;
  createdAt: Date;
}
