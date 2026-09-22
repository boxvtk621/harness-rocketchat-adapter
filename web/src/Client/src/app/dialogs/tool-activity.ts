import { HarnessAttempt, HarnessMessage, ToolCallSummary } from './dialogs.models';
import {
  ToolActivityAnchor,
  ToolActivityBuildInput,
  ToolActivityGroup,
  ToolActivityPage,
  ToolActivityState
} from './tool-activity.models';

function time(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function earlier(left: string, right: string): string {
  return time(left) <= time(right) ? left : right;
}

/**
 * Merges overlapping cursor pages without allowing an older summary to replace a
 * newer one. The first observation controls ordering so reconnects do not move rows.
 */
export function dedupeToolCalls(items: readonly ToolCallSummary[]): ToolCallSummary[] {
  const calls = new Map<string, { item: ToolCallSummary; order: number }>();

  items.forEach((candidate, index) => {
    const current = calls.get(candidate.toolCallId);
    if (!current) {
      calls.set(candidate.toolCallId, { item: candidate, order: index });
      return;
    }

    const newer = candidate.detailVersion >= current.item.detailVersion ? candidate : current.item;
    const older = newer === candidate ? current.item : candidate;
    calls.set(candidate.toolCallId, {
      order: current.order,
      item: {
        ...older,
        ...newer,
        startedAt: earlier(current.item.startedAt, candidate.startedAt),
        finishedAt: newer.finishedAt ?? older.finishedAt
      }
    });
  });

  return [...calls.values()]
    .sort((left, right) => {
      const byTime = time(left.item.startedAt) - time(right.item.startedAt);
      return byTime || left.order - right.order;
    })
    .map(entry => entry.item);
}

export function toolActivityState(attempt: HarnessAttempt, calls: readonly ToolCallSummary[]): ToolActivityState {
  if (['dispatching', 'running', 'waiting_input', 'stopping'].includes(attempt.state)) return 'running';
  if (attempt.state === 'failed') return 'failed';
  if (attempt.state === 'interrupted') return 'interrupted';
  if (attempt.state === 'unknown') return 'unknown';
  if (attempt.state === 'completed' && calls.some(call => call.state === 'failed')) return 'failed';
  if (attempt.state === 'completed' && calls.every(call => call.state === 'succeeded')) return 'succeeded';
  return 'unknown';
}

/** Finds the exact response for the attempt; only then falls back to its request. */
export function resolveToolActivityAnchor(
  messages: readonly HarnessMessage[],
  attemptId: string,
  requestId: string,
  inputMessageId: string
): ToolActivityAnchor {
  const response = messages.find(message => message.role === 'assistant' && message.attemptId === attemptId);
  if (response) return { messageId: response.messageId, placement: 'before' };

  const request = messages.find(message =>
    message.role === 'user'
    && (message.messageId === inputMessageId || message.requestId === requestId)
  );
  if (request) return { messageId: request.messageId, placement: 'after' };
  return { messageId: null, placement: 'tail' };
}

function groupKey(page: Pick<ToolActivityPage, 'requestId' | 'attempt'>): string {
  return `${page.requestId}:${page.attempt.attemptId}`;
}

export function buildToolActivityGroups(input: ToolActivityBuildInput): ToolActivityGroup[] {
  const pages = new Map<string, ToolActivityPage[]>();
  for (const page of input.pages) {
    // A stale response from a previous selection must never be attached to the
    // current request merely because the attempt id happened to be retained.
    if (page.requestId !== page.attempt.requestId) continue;
    const key = groupKey(page);
    pages.set(key, [...(pages.get(key) ?? []), page]);
  }

  return [...pages.entries()]
    .map(([key, attemptPages]) => {
      const latest = attemptPages.reduce((left, right) =>
        right.attempt.version >= left.attempt.version ? right : left
      );
      const calls = dedupeToolCalls(attemptPages.flatMap(page => page.items));
      return {
        key,
        requestId: latest.requestId,
        attemptId: latest.attempt.attemptId,
        generation: latest.attempt.generation,
        state: toolActivityState(latest.attempt, calls),
        anchor: resolveToolActivityAnchor(
          input.messages,
          latest.attempt.attemptId,
          latest.requestId,
          latest.inputMessageId
        ),
        calls,
        pagination: {
          loadedCount: calls.length,
          nextCursor: latest.nextCursor,
          hasMore: latest.nextCursor !== null,
          loading: attemptPages.some(page => page.loading === true)
        }
      } satisfies ToolActivityGroup;
    })
    .filter(group => group.calls.length > 0)
    .sort((left, right) => left.generation - right.generation);
}

export function toolCallDuration(tool: Pick<ToolCallSummary, 'startedAt' | 'finishedAt'>): string {
  if (!tool.finishedAt) return '';
  const duration = Date.parse(tool.finishedAt) - Date.parse(tool.startedAt);
  if (!Number.isFinite(duration) || duration < 0) return '';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(duration / 1000)} с`;
}
