import { HarnessAttempt, HarnessMessage, ToolCallSummary } from './dialogs.models';

export type ToolActivityState = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'unknown';

export interface ToolActivityPage {
  requestId: string;
  attempt: HarnessAttempt;
  inputMessageId: string;
  items: readonly ToolCallSummary[];
  nextCursor: string | null;
  loading?: boolean;
}

export interface ToolActivityAnchor {
  messageId: string | null;
  placement: 'before' | 'after' | 'tail';
}

export interface ToolActivityPagination {
  loadedCount: number;
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
}

export interface ToolActivityGroup {
  key: string;
  requestId: string;
  attemptId: string;
  generation: number;
  state: ToolActivityState;
  anchor: ToolActivityAnchor;
  calls: readonly ToolCallSummary[];
  pagination: ToolActivityPagination;
}

export interface ToolActivitySelection {
  requestId: string;
  attemptId: string;
  toolCall: ToolCallSummary;
}

export interface ToolActivityBuildInput {
  pages: readonly ToolActivityPage[];
  messages: readonly HarnessMessage[];
}
