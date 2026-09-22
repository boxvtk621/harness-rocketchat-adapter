import { HarnessAttempt, HarnessMessage, ToolCallSummary } from './dialogs.models';
import { ToolActivityComponent } from './tool-activity.component';
import { ToolActivityGroup } from './tool-activity.models';
import { buildToolActivityGroups, dedupeToolCalls, resolveToolActivityAnchor, toolActivityState } from './tool-activity';

const attempt = (overrides: Partial<HarnessAttempt> = {}): HarnessAttempt => ({
  attemptId: 'attempt-1', dialogId: 'dialog-1', requestId: 'request-1', generation: 1,
  version: 1, state: 'running', effectStatus: 'none', ...overrides
});

const call = (overrides: Partial<ToolCallSummary> = {}): ToolCallSummary => ({
  toolCallId: 'call-1', toolName: 'workspace.read', state: 'running',
  startedAt: '2026-09-22T08:00:00Z', detailVersion: 1, ...overrides
});

describe('tool activity grouping', () => {
  it('deduplicates cursor overlap by id and keeps the newest version', () => {
    const calls = dedupeToolCalls([
      call(),
      call({ state: 'succeeded', finishedAt: '2026-09-22T08:00:01Z', detailVersion: 2 })
    ]);
    expect(calls.length).toBe(1);
    expect(calls[0].state).toBe('succeeded');
    expect(calls[0].detailVersion).toBe(2);
  });

  it('anchors before the response belonging to the exact attempt', () => {
    const messages: HarnessMessage[] = [
      { messageId: 'input-1', role: 'user', dialogId: 'dialog-1', sequence: 1, version: 1,
        createdAt: '2026-09-22T08:00:00Z', text: 'hi', disposition: 'applied', commandId: 'cmd', requestId: 'request-1' },
      { messageId: 'answer-other', role: 'assistant', dialogId: 'dialog-1', sequence: 2, version: 1,
        createdAt: '2026-09-22T08:00:01Z', attemptId: 'attempt-other',
        content: { kind: 'inline', content: 'old', redaction: 'none', truncated: false }, finishReason: 'complete' },
      { messageId: 'answer-1', role: 'assistant', dialogId: 'dialog-1', sequence: 3, version: 1,
        createdAt: '2026-09-22T08:00:02Z', attemptId: 'attempt-1',
        content: { kind: 'inline', content: 'ok', redaction: 'none', truncated: false }, finishReason: 'complete' }
    ];
    expect(resolveToolActivityAnchor(messages, 'attempt-1', 'request-1', 'input-1'))
      .toEqual({ messageId: 'answer-1', placement: 'before' });
  });

  it('falls back after the request while the response is still absent', () => {
    const messages: HarnessMessage[] = [{
      messageId: 'input-1', role: 'user', dialogId: 'dialog-1', sequence: 1, version: 1,
      createdAt: '2026-09-22T08:00:00Z', text: 'hi', disposition: 'applied', commandId: 'cmd', requestId: 'request-1'
    }];
    expect(resolveToolActivityAnchor(messages, 'attempt-1', 'request-1', 'input-1'))
      .toEqual({ messageId: 'input-1', placement: 'after' });
  });

  it('keeps separate attempts and exposes pagination state', () => {
    const groups = buildToolActivityGroups({
      messages: [],
      pages: [
        { requestId: 'request-1', inputMessageId: 'input-1', attempt: attempt(), items: [call()], nextCursor: 'next' },
        { requestId: 'request-1', inputMessageId: 'input-1',
          attempt: attempt({ attemptId: 'attempt-2', generation: 2 }),
          items: [call({ toolCallId: 'call-2' })], nextCursor: null }
      ]
    });
    expect(groups.map(group => group.key)).toEqual(['request-1:attempt-1', 'request-1:attempt-2']);
    expect(groups[0].pagination).toEqual({ loadedCount: 1, nextCursor: 'next', hasMore: true, loading: false });
  });

  it('does not present a terminal attempt as live when a partial tool page is stale', () => {
    expect(toolActivityState(
      attempt({ state: 'completed', finishedAt: '2026-09-22T08:00:02Z' }),
      [call()]
    )).toBe('unknown');
  });

  it('rejects a stale page whose request does not own the attempt', () => {
    const groups = buildToolActivityGroups({
      messages: [],
      pages: [{ requestId: 'request-other', inputMessageId: 'input-other', attempt: attempt(), items: [call()], nextCursor: null }]
    });
    expect(groups).toEqual([]);
  });
});

describe('ToolActivityComponent expansion', () => {
  const group = (state: ToolActivityGroup['state']): ToolActivityGroup => ({
    key: 'request-1:attempt-1', requestId: 'request-1', attemptId: 'attempt-1', generation: 1,
    state, anchor: { messageId: 'input-1', placement: 'after' }, calls: [call()],
    pagination: { loadedCount: 1, nextCursor: null, hasMore: false, loading: false }
  });

  it('opens a live group by default and preserves a manual close across updates', () => {
    const component = new ToolActivityComponent();
    component.group = group('running');
    component.ngOnChanges({ group: { currentValue: component.group } as never });
    expect(component.open).toBeTrue();

    component.toggle({ currentTarget: { open: false }, isTrusted: true } as unknown as Event);
    component.group = group('running');
    component.ngOnChanges({ group: { currentValue: component.group } as never });
    expect(component.open).toBeFalse();
  });

  it('starts a historical group collapsed', () => {
    const component = new ToolActivityComponent();
    component.group = group('succeeded');
    component.ngOnChanges({ group: { currentValue: component.group } as never });
    expect(component.open).toBeFalse();
  });
});
