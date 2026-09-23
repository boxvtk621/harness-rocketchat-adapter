export interface DialogNodeObservation {
  attemptedAt?: string | null;
  httpReachable?: boolean | null;
  executorHealthy?: boolean | null;
  ready?: boolean | null;
  nodeId?: string | null;
  availability?: 'unknown' | 'available' | 'stale' | 'unavailable' | null;
  identityConflict?: boolean | null;
  conflict?: boolean | null;
  conflictDetail?: string | null;
  occupancy?: string | number | boolean | null;
  errorCode?: string | null;
}

export interface DialogNodeProjection {
  connectionId: string;
  name: string;
  configEpoch: number;
  observation: DialogNodeObservation;
  identityConflict?: boolean | null;
  conflictDetail?: string | null;
  identityStatus?: 'unverified' | 'unique' | 'node_id_conflict' | null;
  occupancy?: string | number | boolean | null;
}

export interface HarnessDialog {
  dialogId: string;
  version: number;
  title?: string;
  createdAt: string;
  lastActivityAt?: string;
  state?: 'active' | 'queued' | 'idle' | 'unavailable' | string;
  activeRequestId?: string;
  activeAttemptId?: string;
}

export interface HarnessIdentity {
  nodeId: string;
  registryVersion: number;
  identityEpoch: number;
  adapter: {
    kind: string;
    version: string;
  };
}

export interface HarnessPage<T> {
  nodeId: string;
  epoch: number;
  snapshotStateVersion: number;
  lastEventSeq: number;
  items: T[];
  nextCursor: string | null;
  pageType: string;
  dialogId?: string;
  requestId?: string;
  attemptId?: string;
}

export interface HarnessSnapshot {
  nodeId: string;
  epoch: number;
  stateVersion: number;
  lastEventSeq: number;
  capturedAt: string;
  node: {
    transportAvailability: 'online' | 'stale' | 'offline';
    engineReadiness: 'ready' | 'blocked' | 'unknown';
    occupancy: 'idle' | 'active' | 'unknown';
    queuePaused: boolean;
    queueVersion: number;
    pendingCount: number;
    blockedReasons: string[];
    activeAttemptId: string | null;
  };
  pendingQueue: HarnessRequest[];
  activeAttempt: HarnessAttempt | null;
}

export interface HarnessRequest {
  requestId: string;
  dialogId: string;
  inputMessageId: string;
  queueSequence: number;
  version: number;
  status: 'queued' | 'cancelled' | 'dispatching' | 'active' | 'completed' | 'failed' | 'interrupted' | 'unknown';
}

export interface HarnessAttempt {
  attemptId: string;
  dialogId: string;
  requestId: string;
  generation: number;
  version: number;
  state: 'dispatching' | 'running' | 'waiting_input' | 'stopping' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  effectStatus: 'none' | 'known' | 'unknown';
  startedAt?: string;
  finishedAt?: string;
}

export interface InlineContent {
  kind: 'inline';
  content: string;
  redaction: 'none' | 'applied';
  truncated: boolean;
}

export interface ArtifactContent {
  kind: 'artifact';
  artifactId: string;
  sizeBytes: number;
  sha256: string;
  redaction: 'none' | 'applied';
  truncated: boolean;
}

export interface UnavailableContent {
  kind: 'unavailable';
  reason: string;
  redaction: 'none' | 'applied' | 'unknown';
  truncated: boolean;
}

export type SafeContent = InlineContent | ArtifactContent | UnavailableContent;

export type HarnessMessage = {
  messageId: string;
  role: 'user';
  dialogId: string;
  sequence: number;
  version: number;
  createdAt: string;
  text: string;
  disposition: 'queued' | 'steer_pending' | 'applied' | 'cancelled' | 'unknown';
  commandId: string;
  requestId: string;
} | {
  messageId: string;
  role: 'assistant';
  dialogId: string;
  sequence: number;
  version: number;
  createdAt: string;
  attemptId: string;
  content: SafeContent;
  finishReason: 'complete' | 'length' | 'cancelled' | 'error';
};

export interface ToolCallSummary {
  toolCallId: string;
  toolName: string;
  state: 'running' | 'succeeded' | 'failed' | 'unknown';
  startedAt: string;
  finishedAt?: string;
  detailVersion: number;
}

export interface ToolOutput {
  index: number;
  stream: 'stdout' | 'stderr' | 'result' | 'diagnostic' | string;
  content: SafeContent;
  observedAt: string;
}

export interface ToolCallDetail extends ToolCallSummary {
  nodeId: string;
  dialogId: string;
  requestId: string;
  attemptId: string;
  input: SafeContent;
  result?: SafeContent;
  outputs: ToolOutput[];
  nextOutputCursor?: string | null;
}

export interface ToolCallRead {
  nodeId: string;
  dialogId: string;
  requestId: string;
  attemptId: string;
  snapshotStateVersion: number;
  lastEventSeq: number;
  toolCall: ToolCallSummary & {
    input: SafeContent;
    result?: SafeContent;
    outputs: ToolOutput[];
    nextOutputCursor?: string | null;
  };
}

export interface ToolCallPage extends HarnessPage<ToolCallSummary> {
  pageType: 'tool_calls';
  dialogId: string;
  requestId: string;
  attemptId: string;
}

export interface CommandReceipt {
  commandId: string;
  commandKind: 'dialog.create' | 'message.enqueue' | 'attempt.retry';
  receiptId: string;
  acceptedAt: string;
  nodeId: string;
  eventSeq: number;
  result: 'admitted' | 'applied';
  blockingReason?: string;
  references: {
    dialogId?: string;
    priorAttemptId?: string;
    messageId?: string;
    requestId?: string;
  };
}

export interface CommandStatus {
  nodeId: string;
  commandId: string;
  canonicalPayloadHash: string;
  status: 'accepted';
  receipt: CommandReceipt;
}

export interface PendingCommand {
  v: 1;
  commandId: string;
  kind: 'dialog.create' | 'message.enqueue' | 'attempt.retry';
  connectionId: string;
  nodeId: string;
  configEpoch: number;
  registryVersion: number;
  identityEpoch: number;
  adapterKind: string;
  adapterVersion: string;
  dialogId?: string;
  priorAttemptId?: string;
  canonicalPayloadHash: string;
  intentHash: string;
  createdAt: string;
}

export interface DialogListRow extends HarnessDialog {
  connectionId: string;
  nodeId: string;
  nodeName: string;
  configEpoch: number;
  activity: 'idle' | 'queued' | 'cancelled' | 'dispatching' | 'active' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'unavailable';
  lastActivityAt: string;
}

export const PENDING_COMMAND_STORAGE_PREFIX = 'hl307:pending:';

export interface AttemptFailure {
  seq: number;
  attemptId: string;
  generation: number;
  type: string;
  effectStatus: string;
  errorCode: string;
  safeMessage: string;
}