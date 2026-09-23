import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  computed,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import {
  AttemptFailure,
  CommandReceipt,
  CommandStatus,
  DialogListRow,
  DialogNodeProjection,
  HarnessAttempt,
  HarnessDialog,
  HarnessIdentity,
  HarnessMessage,
  HarnessPage,
  HarnessRequest,
  HarnessSnapshot,
  PendingCommand,
  PENDING_COMMAND_STORAGE_PREFIX,
  SafeContent,
  ToolCallDetail,
  ToolCallPage,
  ToolCallRead,
  ToolCallSummary
} from './dialogs.models';
import { MarkdownRendererComponent } from '../markdown/markdown-renderer.component';
import { ToolActivityComponent } from './tool-activity.component';
import { ToolActivityGroup, ToolActivityPage, ToolActivitySelection } from './tool-activity.models';
import { buildToolActivityGroups, dedupeToolCalls } from './tool-activity';
import { UiIconComponent } from '../ui-icon.component';

interface NodeReadContext {
  connectionId: string;
  nodeId: string;
  nodeName: string;
  configEpoch: number;
}

interface DialogPageState {
  nextCursor: string | null;
  loadingMore: boolean;
}

interface ApiFailure {
  status: number;
  code: string;
  message: string;
  correlationId?: string;
}

const HISTORY_LIMIT = 40;
const DIALOG_LIMIT = 50;
const REQUEST_LIMIT = 50;
const ATTEMPT_LIMIT = 20;
const TOOL_LIMIT = 50;
const MESSAGE_LIMIT = 16_000;

@Component({
  selector: 'app-dialogs',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownRendererComponent, ToolActivityComponent, UiIconComponent],
  templateUrl: './dialogs.component.html',
  styleUrl: './dialogs.component.css'
})
export class DialogsComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) accessToken = '';
  @Input({ required: true }) sessionKey = '';
  @Input({ required: true }) nodes: DialogNodeProjection[] = [];
  @Input() refreshVersion = 0;
  @Input() navigationTarget: { connectionId: string; nodeId: string; dialogId: string; requestId: string | null; nonce: number } | null = null;

  @Output() readonly settingsRequested = new EventEmitter<string>();
  @Output() readonly sessionExpired = new EventEmitter<void>();

  @ViewChild('historyViewport') private historyViewport?: ElementRef<HTMLElement>;

  readonly dialogs = signal<DialogListRow[]>([]);
  readonly selectedDialogId = signal<string | null>(null);
  readonly messages = signal<HarnessMessage[]>([]);
  readonly requests = signal<HarnessRequest[]>([]);
  readonly attempts = signal<HarnessAttempt[]>([]);
  readonly toolDetail = signal<ToolCallDetail | null>(null);
  readonly selectedRequestId = signal<string | null>(null);
  readonly selectedAttemptId = signal<string | null>(null);
  readonly selectedToolCallId = signal<string | null>(null);
  readonly listLoading = signal(false);
  readonly historyLoading = signal(false);
  readonly contextLoading = signal(false);
  readonly attemptLoading = signal(false);
  readonly executionError = signal('');
  readonly requestMoreLoading = signal(false);
  readonly toolLoading = signal(false);
  readonly sending = signal(false);
  readonly retrying = signal(false);
  readonly retryProgress = signal('');
  readonly messageAttempts = signal<Record<string, HarnessAttempt[]>>({});
  readonly attemptFailures = signal<Record<string, AttemptFailure>>({});
  readonly creating = signal(false);
  readonly listError = signal('');
  readonly historyError = signal('');
  readonly contextError = signal('');
  readonly actionError = signal('');
  readonly actionNotice = signal('');
  readonly freshnessAt = signal<string | null>(null);
  readonly historyNextCursor = signal<string | null>(null);
  readonly requestNextCursor = signal<string | null>(null);
  readonly attemptNextCursor = signal<string | null>(null);
  readonly historyLoadingOlder = signal(false);
  readonly listMoreLoading = signal(false);
  readonly pendingCommands = signal<PendingCommand[]>([]);
  readonly reconcilingCommandId = signal<string | null>(null);
  readonly snapshots = signal<Record<string, HarnessSnapshot>>({});
  readonly identities = signal<Record<string, HarnessIdentity>>({});
  readonly activityPages = signal<ToolActivityPage[]>([]);
  readonly activityErrors = signal<Record<string, string>>({});
  readonly activityGroups = computed(() => buildToolActivityGroups({
    pages: this.activityPages(),
    messages: this.messages()
  }));

  dialogQuery = '';
  nodeFilter = 'all';
  stateFilter = 'all';
  createNodeConnectionId = '';
  createTitle = '';
  draft = '';

  private dialogPages: Record<string, DialogPageState> = {};
  private listGeneration = 0;
  private selectionGeneration = 0;
  private requestGeneration = 0;
  private attemptGeneration = 0;
  private toolGeneration = 0;
  private refreshTimer?: number;
  private historyCursorInitialized = false;
  private historyAutoScrollArmed = false;
  private historyScrollFrame?: number;
  private historySettleFrame?: number;
  private appliedNavigationNonce = 0;
  private applyingNavigationNonce = 0;
  private lastSessionKey = '';
  private sessionGeneration = 0;
  private readonly activityRequestStates = new Map<string, string>();
  private readonly completeDiagnostics = new Set<string>();
  private activityGeneration = 0;
  private readonly activityQueued = new Set<string>();
  private readonly activityInFlight = new Set<string>();
  private readonly activityLoaded = new Set<string>();
  private readonly activityRequestsLoaded = new Set<string>();
  private readonly activityQueue: string[] = [];
  private static readonly ACTIVITY_CONCURRENCY = 4;

  constructor(private readonly http: HttpClient) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['sessionKey'] || changes['accessToken']) {
      if (this.sessionKey !== this.lastSessionKey) {
        this.lastSessionKey = this.sessionKey;
        this.sessionGeneration++;
        this.retrying.set(false);
        this.retryProgress.set('');
        this.reconcilingCommandId.set(null);
        this.restorePendingCommands();
      }
    }
    if (changes['nodes']) {
      if (!this.nodes.some(node => node.connectionId === this.createNodeConnectionId)) {
        this.createNodeConnectionId = this.nodes.find(node => !!this.nodeId(node))?.connectionId ?? '';
      }
      void this.loadDialogs(false);
    }
    if (changes['refreshVersion'] && !changes['refreshVersion'].firstChange) this.scheduleInvalidationReadback();
    if (changes['navigationTarget'] && this.navigationTarget) void this.applyNavigationTarget();
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.cancelPendingHistoryScroll();
  }

  selectedDialog(): DialogListRow | null {
    const key = this.selectedDialogId();
    return this.dialogs().find(dialog => this.dialogKey(dialog) === key) ?? null;
  }

  selectedAttempt(): HarnessAttempt | null {
    return this.attempts().find(attempt => attempt.attemptId === this.selectedAttemptId()) ?? null;
  }

  filteredDialogs(): DialogListRow[] {
    const query = this.dialogQuery.trim().toLocaleLowerCase('ru');
    return this.dialogs().filter(dialog => {
      const text = `${dialog.title ?? ''} ${dialog.dialogId} ${dialog.nodeName}`.toLocaleLowerCase('ru');
      return (!query || text.includes(query))
        && (this.nodeFilter === 'all' || dialog.connectionId === this.nodeFilter)
        && (this.stateFilter === 'all' || dialog.activity === this.stateFilter);
    });
  }

  selectableNodes(): DialogNodeProjection[] {
    return this.nodes.filter(node => !!this.nodeId(node));
  }

  async loadDialogs(preserveSelection = true): Promise<void> {
    if (!this.accessToken) return;
    const generation = ++this.listGeneration;
    this.listLoading.set(true);
    this.listError.set('');
    const contexts = this.nodeContexts();
    const previous = this.dialogs();

    const results = await Promise.allSettled(contexts.map(async context => {
      const [snapshot, identity, page] = await Promise.all([
        this.get<HarnessSnapshot>(this.route(context, 'snapshot'), context.configEpoch),
        this.get<HarnessIdentity>(this.route(context, 'identity'), context.configEpoch),
        this.get<HarnessPage<HarnessDialog>>(this.route(context, 'dialogs'), context.configEpoch, {
          limit: DIALOG_LIMIT,
          view: 'activity'
        })
      ]);
      return { context, snapshot, identity, page };
    }));
    if (generation !== this.listGeneration) return;

    const successful: DialogListRow[] = [];
    const nextSnapshots = { ...this.snapshots() };
    const nextIdentities = { ...this.identities() };
    const errors: string[] = [];
    results.forEach((result, index) => {
      const context = contexts[index];
      if (result.status === 'rejected') {
        errors.push(`${context.nodeName}: ${this.failure(result.reason).message}`);
        return;
      }
      const { snapshot, identity, page } = result.value;
      nextSnapshots[context.connectionId] = snapshot;
      nextIdentities[context.connectionId] = identity;
      this.dialogPages[context.connectionId] = { nextCursor: page.nextCursor, loadingMore: false };
      successful.push(...page.items.map(item => this.dialogRow(context, item, snapshot)));
    });

    this.snapshots.set(nextSnapshots);
    this.identities.set(nextIdentities);
    if (successful.length || !errors.length) {
      const failedConnections = new Set(contexts.filter((_, index) => results[index].status === 'rejected').map(item => item.connectionId));
      const retained = previous.filter(dialog => failedConnections.has(dialog.connectionId));
      // A first-page refresh cannot disprove a selected dialog loaded from a
      // later page. Keep its view mounted while pagination remains incomplete.
      const selected = this.selectedDialog();
      if (selected && this.dialogPages[selected.connectionId]?.nextCursor
        && contexts.some(context => context.connectionId === selected.connectionId)
        && !successful.some(dialog => this.dialogKey(dialog) === this.dialogKey(selected))
        && !retained.some(dialog => this.dialogKey(dialog) === this.dialogKey(selected))) retained.push(selected);
      this.dialogs.set(this.sortDialogs([...successful, ...retained]));
    }
    this.listError.set(errors.join(' '));
    this.listLoading.set(false);
    this.freshnessAt.set(new Date().toISOString());

    if (this.navigationTarget && this.navigationTarget.nonce !== this.appliedNavigationNonce) void this.applyNavigationTarget();
    else if (preserveSelection && this.selectedDialog()) void this.refreshSelectedDialog(true);
    else if (!this.selectedDialog() && this.dialogs().length) void this.selectDialog(this.dialogs()[0]);
    this.restorePendingCommands();
  }

  async loadMoreDialogs(): Promise<void> {
    if (this.listMoreLoading()) return;
    const generation = this.listGeneration;
    const contexts = this.nodeContexts().filter(context => this.dialogPages[context.connectionId]?.nextCursor);
    if (!contexts.length) return;
    this.listMoreLoading.set(true);
    this.listError.set('');
    const results = await Promise.allSettled(contexts.map(async context => {
      const state = this.dialogPages[context.connectionId];
      state.loadingMore = true;
      const page = await this.get<HarnessPage<HarnessDialog>>(this.route(context, 'dialogs'), context.configEpoch, {
        limit: DIALOG_LIMIT,
        view: 'activity',
        cursor: state.nextCursor
      });
      return { context, page };
    }));
    const additions: DialogListRow[] = [];
    const errors: string[] = [];
    if (generation !== this.listGeneration) {
      this.listMoreLoading.set(false);
      return;
    }
    results.forEach((result, index) => {
      const context = contexts[index];
      const state = this.dialogPages[context.connectionId];
      state.loadingMore = false;
      if (result.status === 'rejected') {
        errors.push(`${context.nodeName}: ${this.failure(result.reason).message}`);
        return;
      }
      state.nextCursor = result.value.page.nextCursor;
      const snapshot = this.snapshots()[context.connectionId];
      additions.push(...result.value.page.items.map(item => this.dialogRow(context, item, snapshot)));
    });
    this.dialogs.set(this.mergeDialogs(this.dialogs(), additions));
    this.listError.set(errors.join(' '));
    this.listMoreLoading.set(false);
  }

  hasMoreDialogs(): boolean {
    return Object.values(this.dialogPages).some(page => !!page.nextCursor);
  }

  async selectDialog(dialog: DialogListRow): Promise<void> {
    const key = this.dialogKey(dialog);
    if (this.selectedDialogId() === key) return;
    this.selectedDialogId.set(key);
    this.requestGeneration++;
    this.toolGeneration++;
    this.contextLoading.set(false);
    this.attemptLoading.set(false);
    this.executionError.set('');
    this.messageAttempts.set({});
    this.attemptFailures.set({});
    this.messages.set([]);
    this.requests.set([]);
    this.attempts.set([]);
    this.toolDetail.set(null);
    this.selectedRequestId.set(null);
    this.selectedAttemptId.set(null);
    this.selectedToolCallId.set(null);
    this.historyNextCursor.set(null);
    this.requestNextCursor.set(null);
    this.attemptNextCursor.set(null);
    this.resetActivityCache();
    this.historyCursorInitialized = false;
    this.historyError.set('');
    this.contextError.set('');
    this.actionError.set('');
    await this.refreshSelectedDialog(false);
  }

  async refreshSelectedDialog(merge: boolean): Promise<void> {
    const dialog = this.selectedDialog();
    if (!dialog || !this.accessToken) return;
    const generation = ++this.selectionGeneration;
    this.historyLoading.set(true);
    this.historyError.set('');
    try {
      const [historyPage, requestPage] = await Promise.all([
        this.get<HarnessPage<HarnessMessage>>(this.dialogRoute(dialog, `dialogs/${encodeURIComponent(dialog.dialogId)}/history`), dialog.configEpoch, {
          limit: HISTORY_LIMIT,
          order: 'latest'
        }),
        this.readDialogRequests(dialog)
      ]);
      if (generation !== this.selectionGeneration || this.selectedDialogId() !== this.dialogKey(dialog)) return;
      const previousMessages = this.messages();
      const nextMessages = merge ? this.mergeMessages(previousMessages, historyPage.items) : this.sortMessages(historyPage.items);
      const renderedHistoryChanged = !merge || this.renderedHistoryChanged(previousMessages, nextMessages);
      const currentMaxSequence = previousMessages.reduce((maximum, message) => Math.max(maximum, message.sequence), 0);
      const freshMinSequence = historyPage.items.reduce((minimum, message) => Math.min(minimum, message.sequence), Number.MAX_SAFE_INTEGER);
      this.messages.set(nextMessages);
      this.requests.set(requestPage.items);
      if (renderedHistoryChanged) this.armHistoryAutoScroll();
      this.queueVisibleActivities(nextMessages, dialog, merge);
      const freshPageStartsAfterGap = merge
        && currentMaxSequence > 0
        && freshMinSequence !== Number.MAX_SAFE_INTEGER
        && freshMinSequence > currentMaxSequence + 1;
      if (!merge || !this.historyCursorInitialized || freshPageStartsAfterGap) this.historyNextCursor.set(historyPage.nextCursor);
      this.historyCursorInitialized = true;
      this.requestNextCursor.set(requestPage.nextCursor);
      this.freshnessAt.set(new Date().toISOString());
      this.historyLoading.set(false);

      const openedRequestId = this.selectedRequestId();
      if (openedRequestId) void this.selectRequest({ requestId: openedRequestId }, true);

      if (renderedHistoryChanged) this.scheduleHistoryScrollToEnd();
    } catch (error) {
      if (generation !== this.selectionGeneration) return;
      this.historyLoading.set(false);
      this.historyError.set(this.failure(error).message);
    }
  }

  async loadOlderMessages(): Promise<void> {
    const dialog = this.selectedDialog();
    const cursor = this.historyNextCursor();
    const viewport = this.historyViewport?.nativeElement;
    if (!dialog || !cursor || this.historyLoadingOlder()) return;
    this.disarmHistoryAutoScroll();
    const oldHeight = viewport?.scrollHeight ?? 0;
    const oldTop = viewport?.scrollTop ?? 0;
    this.historyLoadingOlder.set(true);
    this.historyError.set('');
    try {
      const page = await this.get<HarnessPage<HarnessMessage>>(
        this.dialogRoute(dialog, `dialogs/${encodeURIComponent(dialog.dialogId)}/history`),
        dialog.configEpoch,
        { limit: HISTORY_LIMIT, order: 'latest', cursor }
      );
      if (this.selectedDialogId() !== this.dialogKey(dialog)) return;
      const merged = this.mergeMessages(page.items, this.messages());
      this.messages.set(merged);
      this.queueVisibleActivities(merged, dialog, false);
      this.historyNextCursor.set(page.nextCursor);
      window.setTimeout(() => {
        if (viewport) viewport.scrollTop = oldTop + viewport.scrollHeight - oldHeight;
      });
    } catch (error) {
      this.historyError.set(this.failure(error).message);
    } finally {
      this.historyLoadingOlder.set(false);
    }
  }

  async loadMoreRequests(): Promise<void> {
    const dialog = this.selectedDialog();
    const cursor = this.requestNextCursor();
    if (!dialog || !cursor || this.requestMoreLoading()) return;
    const generation = this.selectionGeneration;
    this.requestMoreLoading.set(true);
    try {
      const page = await this.get<HarnessPage<HarnessRequest>>(this.dialogRoute(dialog, 'requests'), dialog.configEpoch, {
        dialogId: dialog.dialogId,
        limit: REQUEST_LIMIT,
        cursor
      });
      if (generation !== this.selectionGeneration || this.selectedDialogId() !== this.dialogKey(dialog)) return;
      const byId = new Map(this.requests().map(item => [item.requestId, item]));
      page.items.forEach(item => byId.set(item.requestId, item));
      this.requests.set([...byId.values()].sort((a, b) => a.queueSequence - b.queueSequence));
      this.requestNextCursor.set(page.nextCursor);
    } catch (error) {
      if (generation === this.selectionGeneration) this.contextError.set(this.failure(error).message);
    } finally {
      this.requestMoreLoading.set(false);
    }
  }

  async selectRequest(request: Pick<HarnessRequest, 'requestId'>, preserveAttempt = false): Promise<void> {
    const dialog = this.selectedDialog();
    if (!dialog) return;
    const generation = ++this.requestGeneration;
    this.selectedRequestId.set(request.requestId);
    this.contextLoading.set(true);
    this.executionError.set('');
    if (!preserveAttempt) {
      this.disarmHistoryAutoScroll();
      this.attempts.set([]);
      this.attemptNextCursor.set(null);
      this.selectedAttemptId.set(null);
      this.attemptLoading.set(false);
    }
    try {
      const input = this.requests().find(item => item.requestId === request.requestId)?.inputMessageId;
      const related = input ? this.requests().filter(item => item.inputMessageId === input) : [request];
      const pages = related.length > 1 ? await Promise.all(related.map(item => this.readRequestAttempts(dialog, item.requestId)))
        : [await this.get<HarnessPage<HarnessAttempt>>(this.dialogRoute(dialog, 'attempts'), dialog.configEpoch, { requestId: request.requestId, limit: ATTEMPT_LIMIT })];
      const page = { items: pages.flatMap(item => item.items), nextCursor: related.length > 1 ? null : pages[0].nextCursor };
      if (generation !== this.requestGeneration || this.selectedRequestId() !== request.requestId) return;
      const byId = new Map((preserveAttempt ? this.attempts() : []).map(item => [item.attemptId, item]));
      const firstPageLeavesGap = page.items.length > 0 && page.items.every(item => !byId.has(item.attemptId));
      page.items.forEach(item => byId.set(item.attemptId, item));
      this.attempts.set([...byId.values()].sort((a, b) => a.generation - b.generation));
      // A new first page can expose a gap even after pagination was exhausted.
      if (!preserveAttempt || firstPageLeavesGap) this.attemptNextCursor.set(page.nextCursor);
      this.contextLoading.set(false);
      const current = this.attempts().find(item => item.attemptId === this.selectedAttemptId());
      const preferred = current ?? [...page.items].sort((a, b) => b.generation - a.generation)[0];
      if (preferred) await this.selectAttempt(preferred);
    } catch (error) {
      if (generation !== this.requestGeneration) return;
      this.contextLoading.set(false);
      this.executionError.set(this.failure(error).message);
    }
  }

  async loadMoreAttempts(): Promise<void> {
    const dialog = this.selectedDialog();
    const requestId = this.selectedRequestId();
    const cursor = this.attemptNextCursor();
    if (!dialog || !requestId || !cursor || this.contextLoading()) return;
    const generation = this.requestGeneration;
    this.contextLoading.set(true);
    this.executionError.set('');
    try {
      const page = await this.get<HarnessPage<HarnessAttempt>>(this.dialogRoute(dialog, 'attempts'), dialog.configEpoch, {
        requestId,
        limit: ATTEMPT_LIMIT,
        cursor
      });
      if (generation !== this.requestGeneration || this.selectedRequestId() !== requestId) return;
      const byId = new Map(this.attempts().map(item => [item.attemptId, item]));
      page.items.forEach(item => byId.set(item.attemptId, item));
      this.attempts.set([...byId.values()].sort((a, b) => a.generation - b.generation));
      this.attemptNextCursor.set(page.nextCursor);
    } catch (error) {
      if (generation === this.requestGeneration) this.executionError.set(this.failure(error).message);
    } finally {
      if (generation === this.requestGeneration) this.contextLoading.set(false);
    }
  }

  isMessageSelected(message: HarnessMessage): boolean {
    return message.role === 'user' && (this.selectedRequestId() === message.requestId ||
      this.requests().some(request => request.requestId === this.selectedRequestId() && request.inputMessageId === message.messageId));
  }

  selectMessageRequest(message: HarnessMessage): void {
    if (message.role !== 'user') return;
    if (this.isMessageSelected(message)) {
      this.requestGeneration++;
      this.selectedRequestId.set(null);
      this.selectedAttemptId.set(null);
      this.contextLoading.set(false);
      this.attemptLoading.set(false);
      return;
    }
    void this.selectRequest(message);
  }

  async selectAttempt(attempt: HarnessAttempt): Promise<void> {
    const dialog = this.selectedDialog();
    if (!dialog) return;
    const generation = this.requestGeneration;
    const attemptGeneration = ++this.attemptGeneration;
    this.selectedAttemptId.set(attempt.attemptId);
    this.attemptLoading.set(true);
    this.executionError.set('');
    try {
      const page = await this.get<ToolCallPage>(
        this.dialogRoute(dialog, `attempts/${encodeURIComponent(attempt.attemptId)}/tool-calls`),
        dialog.configEpoch,
        { limit: TOOL_LIMIT }
      );
      if (generation !== this.requestGeneration || attemptGeneration !== this.attemptGeneration || this.selectedAttemptId() !== attempt.attemptId) return;
      this.mergeActivityPage(attempt, page);
      this.attemptLoading.set(false);
    } catch (error) {
      if (generation !== this.requestGeneration || attemptGeneration !== this.attemptGeneration || this.selectedAttemptId() !== attempt.attemptId) return;
      this.attemptLoading.set(false);
      this.executionError.set(this.failure(error).message);
    }
  }

  selectAttemptById(attemptId: string): void {
    const attempt = this.attempts().find(item => item.attemptId === attemptId);
    if (attempt) void this.selectAttempt(attempt);
  }

  hasAttemptActivity(attemptId: string): boolean {
    return this.activityGroups().some(group => group.attemptId === attemptId);
  }

  showAttemptActivity(attemptId: string): void {
    this.disarmHistoryAutoScroll();
    const details = this.historyViewport?.nativeElement.querySelector<HTMLDetailsElement>(
      `[data-attempt-id="${CSS.escape(attemptId)}"]`);
    if (!details) return;
    details.open = true;
    details.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    details.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }

  async selectToolCall(tool: ToolCallSummary, explicitAttemptId?: string, preserveOutputs = false): Promise<void> {
    const dialog = this.selectedDialog();
    const attemptId = explicitAttemptId ?? this.selectedAttempt()?.attemptId;
    if (!dialog || !attemptId) return;
    const generation = ++this.toolGeneration;
    this.selectedToolCallId.set(tool.toolCallId);
    this.toolLoading.set(true);
    this.contextError.set('');
    try {
      const read = await this.get<ToolCallRead>(
        this.dialogRoute(dialog, `attempts/${encodeURIComponent(attemptId)}/tool-calls/${encodeURIComponent(tool.toolCallId)}`),
        dialog.configEpoch,
        { limit: TOOL_LIMIT }
      );
      if (generation !== this.toolGeneration || this.selectedToolCallId() !== tool.toolCallId) return;
      const next = this.toolDetailFromRead(read);
      const previous = this.toolDetail();
      if (preserveOutputs && previous?.toolCallId === next.toolCallId) {
        const outputs = new Map(previous.outputs.map(item => [item.index, item]));
        next.outputs.forEach(item => outputs.set(item.index, item));
        next.outputs = [...outputs.values()].sort((a, b) => a.index - b.index);
        const previousLast = previous.outputs.at(-1)?.index ?? -1;
        const nextLast = read.toolCall.outputs.at(-1)?.index ?? -1;
        if (previousLast > nextLast) next.nextOutputCursor = previous.nextOutputCursor ?? next.nextOutputCursor;
      }
      this.toolDetail.set(next);
      this.toolLoading.set(false);
    } catch (error) {
      if (generation !== this.toolGeneration) return;
      this.toolLoading.set(false);
      this.contextError.set(this.failure(error).message);
    }
  }

  async loadMoreToolOutputs(): Promise<void> {
    const dialog = this.selectedDialog();
    const detail = this.toolDetail();
    if (!dialog || !detail?.nextOutputCursor || this.toolLoading()) return;
    const generation = ++this.toolGeneration;
    this.toolLoading.set(true);
    try {
      const read = await this.get<ToolCallRead>(
        this.dialogRoute(dialog, `attempts/${encodeURIComponent(detail.attemptId)}/tool-calls/${encodeURIComponent(detail.toolCallId)}`),
        dialog.configEpoch,
        { after: detail.nextOutputCursor, limit: TOOL_LIMIT }
      );
      if (generation !== this.toolGeneration || this.selectedToolCallId() !== detail.toolCallId) return;
      const next = this.toolDetailFromRead(read);
      const outputs = new Map(detail.outputs.map(item => [item.index, item]));
      next.outputs.forEach(item => outputs.set(item.index, item));
      this.toolDetail.set({ ...next, outputs: [...outputs.values()].sort((a, b) => a.index - b.index) });
    } catch (error) {
      if (generation === this.toolGeneration) this.contextError.set(this.failure(error).message);
    } finally {
      if (generation === this.toolGeneration) this.toolLoading.set(false);
    }
  }

  async createDialog(): Promise<void> {
    const node = this.nodes.find(item => item.connectionId === this.createNodeConnectionId);
    const nodeId = node ? this.nodeId(node) : null;
    const snapshot = node ? this.snapshots()[node.connectionId] : null;
    const identity = node ? this.identities()[node.connectionId] : null;
    const title = this.createTitle.trim();
    if (!node || !nodeId || !snapshot || !identity || this.creating()) return;
    if (!this.canWriteToNode(node)) {
      this.actionError.set(this.nodeDisabledReason(node));
      return;
    }
    if (this.utf8Length(title) > 200) {
      this.actionError.set('Название должно занимать не более 200 байт UTF-8.');
      return;
    }

    this.creating.set(true);
    this.actionError.set('');
    this.actionNotice.set('');
    const commandId = crypto.randomUUID();
    const body = {
      protocolVersion: 1,
      schemaId: 'harness-wire-v2',
      commandId,
      kind: 'dialog.create',
      target: { nodeId },
      expected: { registryVersion: identity.registryVersion },
      payload: title ? { title } : {}
    } as const;
    try {
      if (await this.hasMatchingPendingIntent(body, 'dialog.create', node.connectionId)) {
        this.creating.set(false);
        this.actionError.set('Такая команда создания уже ожидает подтверждения. Сначала проверьте её квитанцию.');
        return;
      }
    } catch {
      this.creating.set(false);
      this.actionError.set('Не удалось безопасно проверить идентичность команды. Команда не отправлена.');
      return;
    }
    let pending: PendingCommand;
    try {
      pending = await this.retainPending(body, {
        commandId,
        kind: 'dialog.create',
        connectionId: node.connectionId,
        nodeId,
        configEpoch: node.configEpoch,
        registryVersion: identity.registryVersion,
        identityEpoch: identity.identityEpoch,
        adapterKind: identity.adapter.kind,
        adapterVersion: identity.adapter.version
      });
    } catch {
      this.creating.set(false);
      this.actionError.set('Не удалось безопасно сохранить идентификатор команды в этой Web-сессии. Команда не отправлена.');
      return;
    }

    try {
      const receipt = await this.post<CommandReceipt>(this.route(this.contextFor(node)!, 'commands'), node.configEpoch, body, identity);
      if (!this.completeCommand(pending, receipt)) return;
      this.createTitle = '';
      this.actionNotice.set(receipt.blockingReason
        ? `Диалог принят, но нода заблокирована: ${this.blockedReasonLabel(receipt.blockingReason)}.`
        : 'Диалог создан.');
      await this.loadDialogs(false);
      const created = this.dialogs().find(dialog => dialog.nodeId === nodeId && dialog.dialogId === receipt.references.dialogId);
      if (created) await this.selectDialog(created);
    } catch (error) {
      await this.handleCommandFailure(pending, error);
    } finally {
      this.creating.set(false);
    }
  }

  async sendMessage(): Promise<void> {
    const dialog = this.selectedDialog();
    const text = this.draft.trim();
    if (!dialog || !text || this.sending() || this.retrying()) return;
    const node = this.nodes.find(item => item.connectionId === dialog.connectionId);
    const identity = this.identities()[dialog.connectionId];
    if (!node || !identity || !this.canWriteToNode(node)) {
      this.actionError.set(node ? this.nodeDisabledReason(node) : 'Нода больше недоступна.');
      return;
    }
    if (this.utf8Length(text) > MESSAGE_LIMIT) {
      this.actionError.set(`Сообщение должно занимать не более ${MESSAGE_LIMIT.toLocaleString('ru-RU')} байт UTF-8.`);
      return;
    }

    this.sending.set(true);
    this.actionError.set('');
    this.actionNotice.set('');
    const commandId = crypto.randomUUID();
    const body = {
      protocolVersion: 1,
      schemaId: 'harness-wire-v2',
      commandId,
      kind: 'message.enqueue',
      target: { nodeId: dialog.nodeId, dialogId: dialog.dialogId },
      expected: { dialogVersion: dialog.version },
      payload: { text }
    } as const;
    try {
      if (await this.hasMatchingPendingIntent(body, 'message.enqueue', dialog.connectionId, dialog.dialogId)) {
        this.sending.set(false);
        this.actionError.set('Это сообщение уже ожидает подтверждения. Сначала проверьте квитанцию; повторной отправки не будет.');
        return;
      }
    } catch {
      this.sending.set(false);
      this.actionError.set('Не удалось безопасно проверить идентичность сообщения. Сообщение не отправлено.');
      return;
    }
    let pending: PendingCommand;
    try {
      pending = await this.retainPending(body, {
        commandId,
        kind: 'message.enqueue',
        connectionId: dialog.connectionId,
        nodeId: dialog.nodeId,
        configEpoch: dialog.configEpoch,
        registryVersion: identity.registryVersion,
        identityEpoch: identity.identityEpoch,
        adapterKind: identity.adapter.kind,
        adapterVersion: identity.adapter.version,
        dialogId: dialog.dialogId
      });
    } catch {
      this.sending.set(false);
      this.actionError.set('Не удалось безопасно сохранить идентификатор команды в этой Web-сессии. Сообщение не отправлено.');
      return;
    }
    this.armHistoryAutoScroll();
    this.scheduleHistoryScrollToEnd();

    try {
      const receipt = await this.post<CommandReceipt>(this.dialogRoute(dialog, 'commands'), dialog.configEpoch, body, identity);
      if (!this.completeCommand(pending, receipt)) return;
      if (this.draft.trim() === text) this.draft = '';
      this.actionNotice.set(receipt.blockingReason
        ? `Сообщение принято в очередь, но выполнение заблокировано: ${this.blockedReasonLabel(receipt.blockingReason)}.`
        : 'Сообщение принято в очередь.');
      await this.loadDialogs(false);
      await this.refreshSelectedDialog(true);
    } catch (error) {
      await this.handleCommandFailure(pending, error);
    } finally {
      this.sending.set(false);
      this.scheduleHistoryScrollToEnd();
    }
  }

  onDraftKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void this.sendMessage();
  }

  latestRequest(message: HarnessMessage): HarnessRequest | undefined {
    return this.requests().filter(request => request.inputMessageId === message.messageId)
      .sort((a, b) => b.queueSequence - a.queueSequence)[0];
  }

  latestAttempt(message: HarnessMessage): HarnessAttempt | undefined {
    const request = this.latestRequest(message);
    return request && [...(this.messageAttempts()[request.requestId] ?? [])].sort((a, b) => b.generation - a.generation)[0];
  }

  messageStatus(message: HarnessMessage): string {
    return this.latestRequest(message)?.status ?? (message.role === 'user' ? message.disposition : 'completed');
  }

  messageFailure(message: HarnessMessage): string {
    const attempt = this.latestAttempt(message);
    if (!attempt) return '';
    if (attempt.effectStatus !== 'none') return 'Возможны побочные эффекты. Перед повтором требуется сверка состояния.';
    return this.attemptFailures()[attempt.attemptId]?.safeMessage ?? (attempt.state === 'failed' ? 'Попытка завершилась ошибкой.' : '');
  }

  retryTail(): HarnessMessage[] {
    const dialog = this.selectedDialog();
    if (!dialog || this.requestNextCursor() || this.historyLoading() || this.historyError() || !this.canWriteSelected() ||
      this.pendingCommands().some(item => item.connectionId === dialog.connectionId && item.dialogId === dialog.dialogId)) return [];
    const originals = this.messages().filter(message => message.role === 'user' && !!this.latestRequest(message));
    const tail: HarnessMessage[] = [];
    let nativeAttempts: HarnessAttempt[] = [];
    for (const message of [...originals].reverse()) {
      const related = this.requests().filter(request => request.inputMessageId === message.messageId);
      if (related.some(request => !this.activityRequestsLoaded.has(request.requestId))) break;
      const known = related.flatMap(request => this.messageAttempts()[request.requestId] ?? []).filter(attempt => !!attempt.startedAt);
      const suffix = [...known, ...nativeAttempts];
      const attempt = this.latestAttempt(message);
      if (!attempt || !['failed', 'interrupted'].includes(this.messageStatus(message)) ||
        !['failed', 'interrupted'].includes(attempt.state) || attempt.effectStatus !== 'none') break;
      // Only Codex has the scoped ledger/native proof for a backward replay.
      if (tail.length && (this.identities()[dialog.connectionId]?.adapter.kind !== 'codex' ||
        suffix.length > 100 || suffix.some(item => item.state !== 'failed' || item.effectStatus !== 'none' ||
          !this.completeDiagnostics.has(item.attemptId) || this.attemptFailures()[item.attemptId]?.errorCode !== 'codex_model_unsupported'))) break;
      tail.unshift(message);
      nativeAttempts = suffix;
    }
    return tail;
  }

  retryBoundExplanation(): string {
    const failed = this.messages().filter(message => message.role === 'user' && ['failed', 'interrupted'].includes(this.messageStatus(message)));
    return failed.length > this.retryTail().length
      ? 'Серия ограничена подтверждённым контекстом: требуется полная диагностика всех поколений; поддерживается не более 100 предыдущих попыток.' : '';
  }

  canRetryMessage(message: HarnessMessage): boolean {
    const tail = this.retryTail();
    return !!tail.length && tail[tail.length - 1].messageId === message.messageId;
  }

  async retryMessages(series: boolean): Promise<void> {
    if (this.retrying() || this.sending()) return;
    const dialog = this.selectedDialog();
    const identity = dialog && this.identities()[dialog.connectionId];
    const tail = this.retryTail();
    if (!dialog || !identity || !tail.length) return;
    const targets = (series ? tail : tail.slice(-1)).map(message => this.latestAttempt(message)!);
    const generation = this.selectionGeneration;
    const session = this.sessionKey;
    const sessionGeneration = this.sessionGeneration;
    const currentSession = () => session === this.sessionKey && sessionGeneration === this.sessionGeneration;
    this.retrying.set(true);
    this.actionError.set(''); this.actionNotice.set('');
    let accepted = 0;
    try {
      for (const attempt of targets) {
        if (generation !== this.selectionGeneration || !currentSession() || this.selectedDialogId() !== this.dialogKey(dialog)) break;
        const commandId = crypto.randomUUID();
        const body = { protocolVersion: 1, schemaId: 'harness-wire-v2', commandId, kind: 'attempt.retry',
          target: { nodeId: dialog.nodeId, attemptId: attempt.attemptId },
          expected: { attemptGeneration: attempt.generation }, payload: { acknowledgeKnownEffects: false } };
        const pending = await this.retainPending(body, { commandId, kind: 'attempt.retry', connectionId: dialog.connectionId,
          nodeId: dialog.nodeId, configEpoch: dialog.configEpoch, registryVersion: identity.registryVersion,
          identityEpoch: identity.identityEpoch, adapterKind: identity.adapter.kind, adapterVersion: identity.adapter.version,
          dialogId: dialog.dialogId, priorAttemptId: attempt.attemptId });
        if (generation !== this.selectionGeneration || !currentSession()) { if (currentSession()) this.removePending(commandId); break; }
        try {
          const receipt = await this.post<CommandReceipt>(this.dialogRoute(dialog, 'commands'), dialog.configEpoch, body, identity);
          // The old session retains its pending ID for later readback.
          if (!currentSession()) break;
          // Reconcile the receipt, but never continue a stale dialog series.
          if (!this.completeCommand(pending, receipt)) break;
          accepted++;
          this.retryProgress.set(`Принято в очередь ${accepted} из ${targets.length}. Выполнение подтверждается отдельно.`);
          if (generation !== this.selectionGeneration || session !== this.sessionKey) break;
        } catch (error) {
          if (!currentSession()) break;
          await this.handleCommandFailure(pending, error);
          break;
        }
      }
    } catch {
      if (currentSession()) this.actionError.set('Не удалось сохранить команду. Серия остановлена; проверьте квитанции.');
    } finally {
      if (!currentSession()) return;
      this.retrying.set(false);
      this.retryProgress.set(`Принято в очередь ${accepted} из ${targets.length}.`);
      if (accepted < targets.length) this.actionNotice.set('Серия остановлена. Обновите состояние перед продолжением.');
      if (session === this.sessionKey && this.selectedDialogId() === this.dialogKey(dialog)) await this.refreshSelectedDialog(true);
    }
  }

  private async readDialogRequests(dialog: DialogListRow): Promise<HarnessPage<HarnessRequest>> {
    let cursor: string | null = null;
    const items: HarnessRequest[] = [];
    for (let count = 0; count < 20; count++) {
      const page: HarnessPage<HarnessRequest> = await this.get<HarnessPage<HarnessRequest>>(this.dialogRoute(dialog, 'requests'), dialog.configEpoch,
        { dialogId: dialog.dialogId, limit: 100, cursor });
      items.push(...page.items); cursor = page.nextCursor;
      if (!cursor || count === 19) return { ...page, items };
    }
    throw new Error('Request limit reached');
  }

  private async readRequestAttempts(dialog: DialogListRow, requestId: string): Promise<HarnessPage<HarnessAttempt>> {
    let cursor: string | null = null;
    const items: HarnessAttempt[] = [];
    for (let count = 0; count < 20; count++) {
      const page: HarnessPage<HarnessAttempt> = await this.get<HarnessPage<HarnessAttempt>>(this.dialogRoute(dialog, 'attempts'), dialog.configEpoch,
        { requestId, limit: 100, cursor });
      items.push(...page.items); cursor = page.nextCursor;
      if (!cursor) return { ...page, items };
    }
    throw new Error('Слишком много попыток для одной страницы выполнения.');
  }

  private async readAttemptFailure(dialog: DialogListRow, attempt: HarnessAttempt, generation: number): Promise<void> {
    const current = () => generation === this.activityGeneration && this.selectedDialogId() === this.dialogKey(dialog);
    this.completeDiagnostics.delete(attempt.attemptId);
    try {
      let after = 0;
      let latest: AttemptFailure | undefined;
      for (let count = 0; count < 5; count++) {
        const page = await this.get<HarnessPage<AttemptFailure>>(this.dialogRoute(dialog, `attempts/${encodeURIComponent(attempt.attemptId)}/events`),
          dialog.configEpoch, { limit: 100, after });
        if (generation !== this.activityGeneration || this.selectedDialogId() !== this.dialogKey(dialog)) return;
        latest = page.items.filter(item => item.generation === attempt.generation && item.attemptId === attempt.attemptId).sort((a, b) => b.seq - a.seq)[0] ?? latest;
        if (!page.nextCursor) {
          this.completeDiagnostics.add(attempt.attemptId);
          if (latest) this.attemptFailures.update(all => ({ ...all, [attempt.attemptId]: latest! }));
          return;
        }
        const next = Number(page.nextCursor);
        if (!Number.isSafeInteger(next) || next <= after) break;
        after = next;
      }
    } catch { /* History stays visible when diagnostic enrichment fails. */ }
    if (current()) this.attemptFailures.update(all => ({ ...all, [attempt.attemptId]: {
      seq: 0, attemptId: attempt.attemptId, generation: attempt.generation, type: 'attempt.failed',
      effectStatus: attempt.effectStatus, errorCode: 'diagnostics_incomplete',
      safeMessage: 'Диагностика неполная или недоступна. Причина и безопасность повтора серии не подтверждены.'
    } }));
  }

  async reconcilePending(pending: PendingCommand): Promise<void> {
    if (this.reconcilingCommandId()) return;
    const session = this.sessionGeneration;
    this.reconcilingCommandId.set(pending.commandId);
    this.actionError.set('');
    try {
      const currentNode = this.nodes.find(node => node.connectionId === pending.connectionId && this.nodeId(node) === pending.nodeId);
      const readConfigEpoch = currentNode?.configEpoch ?? pending.configEpoch;
      const context: NodeReadContext = {
        connectionId: pending.connectionId,
        nodeId: pending.nodeId,
        nodeName: '',
        configEpoch: readConfigEpoch
      };
      const status = await this.get<CommandStatus>(
        this.route(context, `commands/${encodeURIComponent(pending.commandId)}`),
        readConfigEpoch
      );
      if (session !== this.sessionGeneration) return;
      if (status.canonicalPayloadHash !== pending.canonicalPayloadHash) {
        this.actionError.set('Квитанция найдена, но хеш команды не совпадает. Команда оставлена без автоматического повтора.');
        return;
      }
      if (!this.completeCommand(pending, status.receipt)) return;
      this.actionNotice.set('Квитанция найдена: команда была принята.');
      await this.loadDialogs(false);
      if (session !== this.sessionGeneration) return;
      const dialogId = status.receipt.references.dialogId ?? pending.dialogId;
      const dialog = this.dialogs().find(item => item.nodeId === pending.nodeId && item.dialogId === dialogId);
      if (dialog) await this.selectDialog(dialog);
    } catch (error) {
      if (session !== this.sessionGeneration) return;
      const failure = this.failure(error);
      if (failure.status === 404) {
        this.actionError.set('Квитанция пока не найдена. Исход остаётся неизвестным; команда не будет отправлена повторно автоматически.');
      } else {
        this.actionError.set(`Не удалось проверить квитанцию: ${failure.message}`);
      }
    } finally {
      if (session === this.sessionGeneration) this.reconcilingCommandId.set(null);
    }
  }

  canWriteSelected(): boolean {
    const dialog = this.selectedDialog();
    const node = dialog ? this.nodes.find(item => item.connectionId === dialog.connectionId) : null;
    return !!dialog && !!node && this.canWriteToNode(node) && !!this.identities()[dialog.connectionId];
  }

  sendDisabledReason(): string {
    const dialog = this.selectedDialog();
    if (!dialog) return 'Выберите диалог.';
    const node = this.nodes.find(item => item.connectionId === dialog.connectionId);
    if (!node) return 'Нода больше недоступна.';
    if (!this.identities()[dialog.connectionId]) return 'Идентичность ноды ещё не загружена.';
    return this.nodeDisabledReason(node);
  }

  canCreate(): boolean {
    const node = this.nodes.find(item => item.connectionId === this.createNodeConnectionId);
    return !!node && !!this.snapshots()[node.connectionId] && !!this.identities()[node.connectionId] && this.canWriteToNode(node);
  }

  createDisabledReason(): string {
    const node = this.nodes.find(item => item.connectionId === this.createNodeConnectionId);
    if (!node) return 'Выберите ноду.';
    if (!this.snapshots()[node.connectionId] || !this.identities()[node.connectionId]) return 'Снимок и идентичность ноды ещё не загружены.';
    return this.nodeDisabledReason(node);
  }

  requestStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      queued: 'В очереди', cancelled: 'Отменено', dispatching: 'Назначается', active: 'Выполняется',
      completed: 'Завершено', failed: 'Ошибка', interrupted: 'Прервано', unknown: 'Исход неизвестен',
      running: 'Выполняется', waiting_input: 'Ожидает ввода', stopping: 'Останавливается',
      succeeded: 'Успешно', applied: 'Принято', steer_pending: 'Перенаправляется'
    };
    return labels[status] ?? 'Неизвестно';
  }

  stateClass(status: string): string {
    if (['active', 'running', 'dispatching'].includes(status)) return 'running';
    if (['queued', 'waiting_input'].includes(status)) return 'queued';
    if (['completed', 'succeeded'].includes(status)) return 'done';
    if (['failed', 'interrupted', 'unknown'].includes(status)) return 'attention';
    return 'idle';
  }

  dialogStateLabel(state: DialogListRow['activity']): string {
    return ({
      active: 'Выполняется', queued: 'В очереди', completed: 'Завершён', failed: 'Ошибка',
      cancelled: 'Отменён', dispatching: 'Назначается', interrupted: 'Прерван', unknown: 'Исход неизвестен',
      idle: 'Сохранён', unavailable: 'Нода недоступна'
    })[state];
  }

  messageText(message: HarnessMessage): string {
    if (message.role === 'user') return message.text;
    return message.content.kind === 'inline' ? message.content.content : '';
  }

  activityBefore(message: HarnessMessage): ToolActivityGroup[] {
    return this.activityGroups().filter(group => group.anchor.placement === 'before' && group.anchor.messageId === message.messageId);
  }

  activityAfter(message: HarnessMessage): ToolActivityGroup[] {
    return this.activityGroups().filter(group => group.anchor.placement === 'after' && group.anchor.messageId === message.messageId);
  }

  tailActivities(): ToolActivityGroup[] {
    return this.activityGroups().filter(group => group.anchor.placement === 'tail');
  }

  activityErrorBefore(message: HarnessMessage): string {
    return message.role === 'assistant' ? (this.activityErrors()[message.attemptId] ?? '') : '';
  }

  activityErrorAfter(message: HarnessMessage): string {
    if (message.role !== 'user') return '';
    const dialog = this.selectedDialog();
    if (!dialog?.activeAttemptId || dialog.activeRequestId !== message.requestId) return '';
    const hasResponse = this.messages().some(item => item.role === 'assistant' && item.attemptId === dialog.activeAttemptId);
    return hasResponse ? '' : (this.activityErrors()[dialog.activeAttemptId] ?? '');
  }

  async inspectInlineTool(selection: ToolActivitySelection): Promise<void> {
    await this.selectToolCall(selection.toolCall, selection.attemptId);
  }

  closeInlineTool(): void {
    this.toolGeneration++;
    this.selectedToolCallId.set(null);
    this.toolDetail.set(null);
    this.toolLoading.set(false);
  }

  async loadMoreInlineActivity(group: ToolActivityGroup): Promise<void> {
    const dialog = this.selectedDialog();
    if (!dialog || !group.pagination.nextCursor || group.pagination.loading) return;
    const generation = this.activityGeneration;
    this.activityPages.update(pages => pages.map(page =>
      page.attempt.attemptId === group.attemptId && page.nextCursor === group.pagination.nextCursor
        ? { ...page, loading: true }
        : page));
    try {
      const page = await this.get<ToolCallPage>(
        this.dialogRoute(dialog, `attempts/${encodeURIComponent(group.attemptId)}/tool-calls`),
        dialog.configEpoch,
        { limit: TOOL_LIMIT, cursor: group.pagination.nextCursor }
      );
      if (generation !== this.activityGeneration || this.selectedDialogId() !== this.dialogKey(dialog)) return;
      const attempt = this.activityPages().find(item => item.attempt.attemptId === group.attemptId)?.attempt;
      if (!attempt) return;
      this.activityPages.update(pages => [
        ...pages.map(item => item.attempt.attemptId === group.attemptId ? { ...item, loading: false } : item),
        {
          requestId: page.requestId,
          inputMessageId: this.inputMessageId(page.requestId),
          attempt,
          items: page.items,
          nextCursor: page.nextCursor,
          loading: false
        }
      ]);
      this.scheduleHistoryScrollToEnd();
    } catch (error) {
      if (generation !== this.activityGeneration) return;
      this.activityPages.update(pages => pages.map(item => item.attempt.attemptId === group.attemptId ? { ...item, loading: false } : item));
      this.activityErrors.update(errors => ({ ...errors, [group.attemptId]: this.failure(error).message }));
      this.scheduleHistoryScrollToEnd();
    }
  }

  safeContentText(content?: SafeContent): string {
    if (!content) return 'Нет результата';
    if (content.kind === 'inline') return content.content;
    if (content.kind === 'artifact') return `Артефакт ${content.artifactId} · ${this.fileSize(content.sizeBytes)}`;
    return `Содержимое недоступно: ${this.unavailableReasonLabel(content.reason)}`;
  }

  safeContentNote(content?: SafeContent): string {
    if (!content) return '';
    const notes: string[] = [];
    if (content.redaction === 'applied') notes.push('секреты скрыты');
    else if (content.redaction === 'unknown') notes.push('статус редактирования неизвестен');
    if (content.truncated) notes.push('содержимое сокращено');
    return notes.join(' · ');
  }

  toolTimingLabel(tool: Pick<ToolCallSummary, 'state' | 'startedAt' | 'finishedAt'>): string {
    const started = new Date(tool.startedAt);
    if (Number.isNaN(started.getTime())) return 'Время начала неизвестно';
    const startLabel = this.formatTime(tool.startedAt);
    if (!tool.finishedAt || tool.state === 'running' || tool.state === 'unknown') return `Начат ${startLabel}`;
    const finished = new Date(tool.finishedAt);
    if (Number.isNaN(finished.getTime()) || finished.getTime() < started.getTime()) return `Начат ${startLabel}`;
    const duration = finished.getTime() - started.getTime();
    return `${startLabel}–${this.formatTime(tool.finishedAt)} · ${this.durationLabel(duration)}`;
  }

  toolActionLabel(tool: ToolCallSummary | ToolCallDetail): string {
    if ('input' in tool && tool.input?.kind === 'inline') {
      const source = tool.input.content.trim();
      try {
        const parsed = JSON.parse(source) as Record<string, unknown>;
        const command = typeof parsed['command'] === 'string' ? parsed['command'].trim() : '';
        const path = typeof parsed['path'] === 'string' ? parsed['path'].trim() : '';
        if (command) return command;
        if (path) return path;
      } catch {
        const command = source.match(/(?:Команда|command)\s*:\s*([^\r\n]+)/i)?.[1]?.trim();
        if (command) return command;
      }
    }
    const friendly: Record<string, string> = {
      'cursor.command': 'Команда',
      'shell.command': 'Команда',
      'read_file': 'Чтение файла',
      'write_file': 'Запись файла',
      'list_files': 'Список файлов'
    };
    return friendly[tool.toolName] ?? tool.toolName.replace(/[._-]+/g, ' ');
  }

  selectedToolActionLabel(tool: ToolCallSummary): string {
    const detail = this.toolDetail();
    return detail?.toolCallId === tool.toolCallId ? this.toolActionLabel(detail) : this.toolActionLabel(tool);
  }

  openSettings(connectionId: string): void {
    this.settingsRequested.emit(connectionId);
  }

  isDialogSelected(dialog: DialogListRow): boolean {
    return this.selectedDialogId() === this.dialogKey(dialog);
  }

  formatTime(value?: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }

  shortId(value?: string | null): string {
    return value ? `${value.slice(0, 8)}…` : '—';
  }

  trackById(_: number, item: { dialogId?: string; messageId?: string; requestId?: string; attemptId?: string; toolCallId?: string }): string {
    return item.dialogId ?? item.messageId ?? item.requestId ?? item.attemptId ?? item.toolCallId ?? String(_);
  }

  private scheduleInvalidationReadback(): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      void this.loadDialogs(true);
    }, 180);
  }

  private nodeContexts(): NodeReadContext[] {
    return this.nodes.flatMap(node => {
      const context = this.contextFor(node);
      return context ? [context] : [];
    });
  }

  private contextFor(node: DialogNodeProjection): NodeReadContext | null {
    const nodeId = this.nodeId(node);
    return nodeId ? { connectionId: node.connectionId, nodeId, nodeName: node.name, configEpoch: node.configEpoch } : null;
  }

  private nodeId(node: DialogNodeProjection): string | null {
    return node.observation?.nodeId?.trim() || null;
  }

  private route(context: NodeReadContext, suffix: string): string {
    return `/api/dialogs/${encodeURIComponent(context.connectionId)}/nodes/${encodeURIComponent(context.nodeId)}/${suffix}`;
  }

  private dialogRoute(dialog: DialogListRow, suffix: string): string {
    return this.route(dialog, suffix);
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' });
  }

  private async get<T>(url: string, configEpoch: number, query: Record<string, string | number | null | undefined> = {}): Promise<T> {
    let params = new HttpParams().set('configEpoch', configEpoch);
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') params = params.set(key, value);
    });
    try {
      return await firstValueFrom(this.http.get<T>(url, { headers: this.headers(), params }));
    } catch (error) {
      this.emitExpired(error);
      throw error;
    }
  }

  private async post<T>(url: string, configEpoch: number, body: unknown, identity: HarnessIdentity): Promise<T> {
    const headers = this.headers()
      .set('X-Harness-Expected-Node-ID', identity.nodeId)
      .set('X-Harness-Expected-Registry-Version', String(identity.registryVersion))
      .set('X-Harness-Expected-Identity-Epoch', String(identity.identityEpoch))
      .set('X-Harness-Expected-Adapter-Kind', identity.adapter.kind)
      .set('X-Harness-Expected-Adapter-Version', identity.adapter.version);
    try {
      return await firstValueFrom(this.http.post<T>(url, body, {
        headers,
        params: new HttpParams().set('configEpoch', configEpoch)
      }));
    } catch (error) {
      this.emitExpired(error);
      throw error;
    }
  }

  private emitExpired(error: unknown): void {
    if (error instanceof HttpErrorResponse && error.status === 401) this.sessionExpired.emit();
  }

  private failure(error: unknown): ApiFailure {
    if (!(error instanceof HttpErrorResponse)) return { status: 0, code: 'network', message: 'Сервер не ответил. Уже загруженные данные сохранены.' };
    const body = error.error as { code?: string; message?: string; detail?: string; correlationId?: string } | null;
    const code = body?.code ?? '';
      const known: Record<string, string> = {
      no_session: 'Сессия завершена. Войдите снова.', forbidden: 'Недостаточно прав для этого действия.',
      not_found: 'Объект не найден или больше недоступен.', stale: 'Данные изменились. Обновите состояние и повторите действие.',
      id_conflict: 'Идентификатор команды уже связан с другим содержимым.', protocol_mismatch: 'Версия протокола ноды несовместима.',
      schema_mismatch: 'Схема ноды несовместима.', too_large: 'Данные превышают допустимый размер.', unsupported: 'Операция не поддерживается нодой.',
      queue_full: 'Очередь ноды заполнена.', node_unavailable: 'Нода сейчас недоступна.', not_durable: 'Нода не может надёжно сохранить команду.',
      command_outcome_unknown: 'Нода изменилась во время отправки; результат команды неизвестен.',
      config_epoch_required: 'Не указана версия конфигурации подключения.', stale_config_epoch: 'Конфигурация подключения изменилась.',
      node_identity_changed: 'Идентичность ноды изменилась.', invalid_expected_identity: 'Ожидаемая идентичность ноды некорректна.',
      invalid_request: 'Запрос отклонён как некорректный.', upstream_unavailable: 'Нода не ответила через Adapter.'
    };
    return {
      status: error.status,
      code,
      message: known[code] ?? this.genericHttpError(error.status),
      correlationId: body?.correlationId
    };
  }

  private async handleCommandFailure(pending: PendingCommand, error: unknown): Promise<void> {
    const failure = this.failure(error);
    const uncertain = failure.status === 0
      || failure.status === 408
      || failure.status >= 500
      || failure.code === 'command_outcome_unknown';
    if (uncertain) {
      this.actionError.set('Результат отправки неизвестен. Автоматического повтора не будет; проверьте квитанцию.');
      await this.reconcilePending(pending);
      return;
    }
    this.removePending(pending.commandId);
    this.actionError.set(failure.message);
  }

  private completeCommand(pending: PendingCommand, receipt: CommandReceipt): boolean {
    const kindMatches = receipt.commandKind === pending.kind;
    const dialogMatches = pending.kind === 'attempt.retry' ? receipt.references.priorAttemptId === pending.priorAttemptId && !!receipt.references.requestId : !!receipt.references.dialogId
      && (pending.kind === 'dialog.create' || receipt.references.dialogId === pending.dialogId);
    const enqueueReferencesComplete = pending.kind !== 'message.enqueue'
      || (!!receipt.references.messageId && !!receipt.references.requestId);
    if (receipt.commandId !== pending.commandId || receipt.nodeId !== pending.nodeId || !kindMatches || !dialogMatches || !enqueueReferencesComplete) {
      this.actionError.set('Сервер вернул квитанцию для другой команды. Исход оставлен неизвестным.');
      return false;
    }
    this.removePending(pending.commandId);
    return true;
  }

  private async retainPending(body: unknown, base: Omit<PendingCommand, 'v' | 'canonicalPayloadHash' | 'intentHash' | 'createdAt'>): Promise<PendingCommand> {
    const session = this.sessionGeneration;
    const sessionKey = this.sessionKey;
    const pending: PendingCommand = {
      v: 1,
      ...base,
      canonicalPayloadHash: await this.sha256(this.canonicalJson(body)),
      intentHash: await this.intentHash(body),
      createdAt: new Date().toISOString()
    };
    if (session !== this.sessionGeneration || sessionKey !== this.sessionKey) throw new Error('Web session changed.');
    const next = [...this.pendingCommands().filter(item => item.commandId !== pending.commandId), pending];
    this.persistPendingCommands(next);
    this.pendingCommands.set(next);
    return pending;
  }

  private removePending(commandId: string): void {
    const next = this.pendingCommands().filter(item => item.commandId !== commandId);
    this.pendingCommands.set(next);
    this.persistPendingCommands(next);
  }

  private restorePendingCommands(): void {
    if (!this.sessionKey) {
      this.pendingCommands.set([]);
      return;
    }
    try {
      const parsed = JSON.parse(sessionStorage.getItem(this.storageKey()) ?? '[]') as PendingCommand[];
      const safe = Array.isArray(parsed) ? parsed.filter(item => item?.v === 1
        && typeof item.commandId === 'string'
        && typeof item.nodeId === 'string'
        && typeof item.registryVersion === 'number'
        && typeof item.identityEpoch === 'number'
        && typeof item.adapterKind === 'string'
        && typeof item.adapterVersion === 'string'
        && typeof item.intentHash === 'string'
        && typeof item.canonicalPayloadHash === 'string') : [];
      this.pendingCommands.set(safe);
    } catch {
      this.pendingCommands.set([]);
    }
  }

  private persistPendingCommands(commands: PendingCommand[]): void {
    if (!this.sessionKey) throw new Error('Missing Web session key.');
    sessionStorage.setItem(this.storageKey(), JSON.stringify(commands));
  }

  private storageKey(): string {
    return `${PENDING_COMMAND_STORAGE_PREFIX}${encodeURIComponent(this.sessionKey)}`;
  }

  private canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(item => this.canonicalJson(item)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${this.canonicalJson(record[key])}`).join(',')}}`;
  }

  private async sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  private async intentHash(body: unknown): Promise<string> {
    const command = body as { kind?: unknown; target?: unknown; payload?: unknown };
    return this.sha256(this.canonicalJson({ kind: command.kind, target: command.target, payload: command.payload }));
  }

  private async hasMatchingPendingIntent(
    body: unknown,
    kind: PendingCommand['kind'],
    connectionId: string,
    dialogId?: string
  ): Promise<boolean> {
    const hash = await this.intentHash(body);
    return this.pendingCommands().some(item => item.kind === kind
      && item.connectionId === connectionId
      && item.dialogId === dialogId
      && item.intentHash === hash);
  }

  private dialogRow(context: NodeReadContext, item: HarnessDialog, snapshot: HarnessSnapshot): DialogListRow {
    const active = item.state === 'active' || (!item.state && snapshot.activeAttempt?.dialogId === item.dialogId);
    const queued = item.state === 'queued' || (!item.state && snapshot.pendingQueue.some(request => request.dialogId === item.dialogId));
    const knownState = ['idle', 'queued', 'cancelled', 'dispatching', 'active', 'completed', 'failed', 'interrupted', 'unknown'].includes(item.state ?? '')
      ? item.state as DialogListRow['activity']
      : 'idle';
    return {
      ...item,
      ...context,
      activity: active ? 'active' : queued ? 'queued' : knownState,
      lastActivityAt: item.lastActivityAt ?? item.createdAt
    };
  }

  private mergeDialogs(current: DialogListRow[], additions: DialogListRow[]): DialogListRow[] {
    const byId = new Map(current.map(item => [`${item.nodeId}:${item.dialogId}`, item]));
    additions.forEach(item => byId.set(`${item.nodeId}:${item.dialogId}`, item));
    return this.sortDialogs([...byId.values()]);
  }

  private sortDialogs(items: DialogListRow[]): DialogListRow[] {
    return [...items].sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)
      || a.dialogId.localeCompare(b.dialogId));
  }

  private mergeMessages(left: HarnessMessage[], right: HarnessMessage[]): HarnessMessage[] {
    const byId = new Map<string, HarnessMessage>();
    [...left, ...right].forEach(message => {
      const prior = byId.get(message.messageId);
      if (!prior || message.version >= prior.version) byId.set(message.messageId, message);
    });
    return this.sortMessages([...byId.values()]);
  }

  private sortMessages(items: HarnessMessage[]): HarnessMessage[] {
    return [...items].sort((a, b) => a.sequence - b.sequence || a.messageId.localeCompare(b.messageId));
  }

  private resetActivityCache(): void {
    this.activityGeneration++;
    this.activityPages.set([]);
    this.activityErrors.set({});
    this.activityQueued.clear();
    // Keys include the generation, so late finalizers cannot remove entries from
    // the new dialog. Release the UI concurrency quota immediately; stale HTTP
    // responses are still rejected by generation and dialog identity checks.
    this.activityInFlight.clear();
    this.activityLoaded.clear();
    this.activityRequestsLoaded.clear();
    this.activityRequestStates.clear();
    this.completeDiagnostics.clear();
    this.activityQueue.length = 0;
  }

  private queueVisibleActivities(messages: HarnessMessage[], dialog: DialogListRow, refresh: boolean): void {
    const attemptIds = new Set(messages
      .filter((message): message is Extract<HarnessMessage, { role: 'assistant' }> => message.role === 'assistant')
      .map(message => message.attemptId));
    if (dialog.activeAttemptId) attemptIds.add(dialog.activeAttemptId);
    const runningIds = new Set(this.activityPages()
      .filter(page => ['dispatching', 'running', 'waiting_input', 'stopping'].includes(page.attempt.state))
      .map(page => page.attempt.attemptId));
    const activeRequestIds = new Set(this.requests()
      .filter(request => ['dispatching', 'active'].includes(request.status))
      .map(request => request.requestId));
    for (const requestId of new Set(messages
      .filter((message): message is Extract<HarnessMessage, { role: 'user' }> => message.role === 'user')
      .flatMap(message => this.requests().filter(request => request.inputMessageId === message.messageId).map(request => request.requestId).concat(message.requestId)))) {
      const state = this.requests().find(request => request.requestId === requestId)?.status ?? '';
      this.enqueueActivityRequest(requestId, refresh && (activeRequestIds.has(requestId) || this.activityRequestStates.get(requestId) !== state));
    }
    for (const attemptId of attemptIds) {
      if (this.activityLoaded.has(attemptId) && (!refresh || !runningIds.has(attemptId))) continue;
      this.enqueueActivity(attemptId);
    }
    this.pumpActivityQueue();
  }

  private enqueueActivity(attemptId: string): void {
    const key = `${this.activityGeneration}\u0000attempt\u0000${attemptId}`;
    if (!attemptId || this.activityQueued.has(key) || this.activityInFlight.has(key)) return;
    this.activityQueued.add(key);
    this.activityQueue.push(key);
  }

  private enqueueActivityRequest(requestId: string, refresh: boolean): void {
    if (!requestId || (this.activityRequestsLoaded.has(requestId) && !refresh)) return;
    const key = `${this.activityGeneration}\u0000request\u0000${requestId}`;
    if (this.activityQueued.has(key) || this.activityInFlight.has(key)) return;
    if (refresh) this.activityRequestsLoaded.delete(requestId);
    this.activityQueued.add(key);
    this.activityQueue.push(key);
  }

  private pumpActivityQueue(): void {
    while (this.activityInFlight.size < DialogsComponent.ACTIVITY_CONCURRENCY && this.activityQueue.length) {
      const key = this.activityQueue.shift();
      if (!key) continue;
      const [, kind, id] = key.split('\u0000');
      this.activityQueued.delete(key);
      this.activityInFlight.add(key);
      const read = kind === 'request' ? this.readRequestActivities(id) : this.readActivity(id);
      void read.finally(() => {
        this.activityInFlight.delete(key);
        this.pumpActivityQueue();
      });
    }
  }

  private async readRequestActivities(requestId: string): Promise<void> {
    const dialog = this.selectedDialog();
    if (!dialog) return;
    const generation = this.activityGeneration;
    const requestState = this.requests().find(request => request.requestId === requestId)?.status ?? '';
    try {
      let cursor: string | null = null;
      let pageCount = 0;
      do {
        const page: HarnessPage<HarnessAttempt> = await this.get<HarnessPage<HarnessAttempt>>(
          this.dialogRoute(dialog, 'attempts'), dialog.configEpoch,
          { requestId, limit: ATTEMPT_LIMIT, cursor }
        );
        if (generation !== this.activityGeneration || this.selectedDialogId() !== this.dialogKey(dialog)) return;
        this.messageAttempts.update(all => ({ ...all, [requestId]: [...(cursor ? all[requestId] ?? [] : []), ...page.items] }));
        for (const attempt of page.items) {
          if (['failed', 'interrupted', 'unknown'].includes(attempt.state)) await this.readAttemptFailure(dialog, attempt, generation);
          if (generation !== this.activityGeneration || this.selectedDialogId() !== this.dialogKey(dialog)) return;
        }
        page.items.forEach((attempt: HarnessAttempt) => {
          const running = ['dispatching', 'running', 'waiting_input', 'stopping'].includes(attempt.state);
          if (!this.activityLoaded.has(attempt.attemptId) || running) this.enqueueActivity(attempt.attemptId);
        });
        cursor = page.nextCursor;
        pageCount++;
      } while (cursor && pageCount < 5);
      if (!cursor) this.activityRequestsLoaded.add(requestId);
      this.activityRequestStates.set(requestId, requestState);
      this.messageAttempts.update(all => ({ ...all }));
      if (cursor) this.contextError.set('Показаны первые 100 попыток обращения. Остальные можно загрузить через «Выполнение» под его сообщением.');
    } catch (error) {
      if (generation !== this.activityGeneration || this.selectedDialogId() !== this.dialogKey(dialog)) return;
      this.contextError.set(this.failure(error).message);
    }
  }

  private async readActivity(attemptId: string): Promise<void> {
    const dialog = this.selectedDialog();
    if (!dialog) return;
    const generation = this.activityGeneration;
    try {
      const [attemptRead, page] = await Promise.all([
        this.get<{ attempt: HarnessAttempt }>(
          this.dialogRoute(dialog, `attempts/${encodeURIComponent(attemptId)}`), dialog.configEpoch),
        this.get<ToolCallPage>(
          this.dialogRoute(dialog, `attempts/${encodeURIComponent(attemptId)}/tool-calls`),
          dialog.configEpoch, { limit: TOOL_LIMIT })
      ]);
      if (generation !== this.activityGeneration || this.selectedDialogId() !== this.dialogKey(dialog)) return;
      const requestId = page.requestId || attemptRead.attempt.requestId;
      const next: ToolActivityPage = {
        requestId,
        inputMessageId: this.inputMessageId(requestId),
        attempt: attemptRead.attempt,
        items: page.items,
        nextCursor: page.nextCursor,
        loading: false
      };
      const previous = this.activityPages().find(item => item.attempt.attemptId === attemptId);
      const renderedActivityChanged = !previous || this.activityRenderKey(previous) !== this.activityRenderKey(next);
      this.mergeActivityPage(attemptRead.attempt, page);
      this.activityErrors.update(errors => {
        const { [attemptId]: _removed, ...rest } = errors;
        return rest;
      });
      this.activityLoaded.add(attemptId);
      if (renderedActivityChanged) this.scheduleHistoryScrollToEnd();
    } catch (error) {
      if (generation !== this.activityGeneration || this.selectedDialogId() !== this.dialogKey(dialog)) return;
      const message = this.failure(error).message;
      const changed = this.activityErrors()[attemptId] !== message;
      this.activityErrors.update(errors => ({ ...errors, [attemptId]: message }));
      if (changed) this.scheduleHistoryScrollToEnd();
    }
  }

  private inputMessageId(requestId: string): string {
    return this.requests().find(item => item.requestId === requestId)?.inputMessageId
      ?? this.messages().find(message => message.role === 'user' && message.requestId === requestId)?.messageId
      ?? '';
  }

  private mergeActivityPage(attempt: HarnessAttempt, page: ToolCallPage): void {
    const previous = this.activityPages().filter(item => item.attempt.attemptId === attempt.attemptId);
    const latest = previous.at(-1);
    const previousItems = dedupeToolCalls(previous.flatMap(item => item.items));
    const next: ToolActivityPage = {
      requestId: attempt.requestId, inputMessageId: this.inputMessageId(attempt.requestId),
      attempt: latest && latest.attempt.version > attempt.version ? latest.attempt : attempt,
      items: dedupeToolCalls([...previousItems, ...page.items]),
      nextCursor: previousItems.length > page.items.length ? latest!.nextCursor : page.nextCursor,
      loading: previous.some(item => item.loading)
    };
    this.activityPages.update(pages => [...pages.filter(item => item.attempt.attemptId !== attempt.attemptId), next]);
    const detail = this.toolDetail();
    const current = next.items.find(item => item.toolCallId === this.selectedToolCallId());
    if (!this.toolLoading() && detail?.attemptId === attempt.attemptId && current && current.detailVersion > detail.detailVersion) {
      void this.selectToolCall(current, attempt.attemptId, true);
    }
  }

  private canWriteToNode(node: DialogNodeProjection): boolean {
    const observation = node.observation;
    return !!this.nodeId(node)
      && observation.ready === true
      && observation.httpReachable !== false
      && observation.executorHealthy !== false
      && observation.availability !== 'stale'
      && observation.availability !== 'unavailable'
      && node.identityStatus !== 'node_id_conflict'
      && !node.identityConflict
      && !observation.identityConflict
      && !observation.conflict;
  }

  private nodeDisabledReason(node: DialogNodeProjection): string {
    const observation = node.observation;
    if (node.identityStatus === 'node_id_conflict' || node.identityConflict || observation.identityConflict || observation.conflict) return 'У ноды конфликт идентичности.';
    if (!this.nodeId(node)) return 'Идентификатор ноды ещё не подтверждён.';
    if (observation.httpReachable === false || observation.availability === 'unavailable') return 'Нода недоступна.';
    if (observation.availability === 'stale') return 'Данные о ноде устарели.';
    if (observation.executorHealthy === false) return 'Исполнитель ноды не готов.';
    if (observation.ready !== true) {
      const reasons = this.snapshots()[node.connectionId]?.node.blockedReasons ?? [];
      return reasons.length ? `Нода не готова: ${reasons.map(reason => this.blockedReasonLabel(reason)).join(', ')}.` : 'Нода не готова к новым сообщениям.';
    }
    return '';
  }

  private blockedReasonLabel(reason: string): string {
    const labels: Record<string, string> = {
      engine_unavailable: 'исполнитель недоступен', auth_unavailable: 'требуется авторизация провайдера',
      quota_exhausted: 'исчерпана квота', policy_unavailable: 'политика недоступна', capability_missing: 'нет обязательной возможности',
      storage_unavailable: 'хранилище недоступно', execution_unknown: 'предыдущее выполнение не определено',
      adapter_protocol: 'ошибка протокола адаптера', operator_pause: 'очередь остановлена оператором'
    };
    return labels[reason] ?? reason;
  }

  private unavailableReasonLabel(reason: string): string {
    const labels: Record<string, string> = {
      not_observed: 'не наблюдалось', provider_redacted: 'скрыто провайдером', output_limit: 'превышен лимит вывода', unmapped: 'формат не распознан'
    };
    return labels[reason] ?? reason;
  }

  private utf8Length(value: string): number {
    return new TextEncoder().encode(value).byteLength;
  }

  private toolDetailFromRead(read: ToolCallRead): ToolCallDetail {
    return {
      ...read.toolCall,
      nodeId: read.nodeId,
      dialogId: read.dialogId,
      requestId: read.requestId,
      attemptId: read.attemptId,
      input: read.toolCall.input,
      result: read.toolCall.result,
      outputs: read.toolCall.outputs,
      nextOutputCursor: read.toolCall.nextOutputCursor ?? null
    };
  }

  private fileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КиБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МиБ`;
  }

  private durationLabel(milliseconds: number): string {
    if (milliseconds < 1_000) return `${milliseconds} мс`;
    const seconds = milliseconds / 1_000;
    if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} с`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return remainingSeconds ? `${minutes} мин ${remainingSeconds} с` : `${minutes} мин`;
  }

  private async applyNavigationTarget(): Promise<void> {
    const target = this.navigationTarget;
    if (!target || target.nonce === this.appliedNavigationNonce || target.nonce === this.applyingNavigationNonce) return;
    this.applyingNavigationNonce = target.nonce;
    try {
      let dialog = this.dialogs().find(item => item.connectionId === target.connectionId
        && item.nodeId === target.nodeId
        && item.dialogId === target.dialogId);
      while (!dialog && this.hasMoreDialogs() && this.navigationTarget?.nonce === target.nonce) {
        const before = this.dialogCursorSignature();
        await this.loadMoreDialogs();
        dialog = this.dialogs().find(item => item.connectionId === target.connectionId
          && item.nodeId === target.nodeId
          && item.dialogId === target.dialogId);
        if (before === this.dialogCursorSignature()) break;
      }
      if (!dialog || this.navigationTarget?.nonce !== target.nonce) return;

      if (this.selectedDialogId() !== this.dialogKey(dialog)) await this.selectDialog(dialog);
      else if (!this.messages().length) await this.refreshSelectedDialog(false);
      if (!target.requestId) {
        this.appliedNavigationNonce = target.nonce;
        return;
      }

      let request = this.requests().find(item => item.requestId === target.requestId);
      while (!request && this.requestNextCursor() && this.navigationTarget?.nonce === target.nonce) {
        const before = this.requestNextCursor();
        await this.loadMoreRequests();
        request = this.requests().find(item => item.requestId === target.requestId);
        if (before === this.requestNextCursor()) break;
      }
      if (!request || this.navigationTarget?.nonce !== target.nonce) return;
      await this.selectRequest(request);
      while (!this.messages().some(item => item.role === 'user' && item.messageId === request!.inputMessageId)
        && this.historyNextCursor() && this.navigationTarget?.nonce === target.nonce) {
        const before = this.historyNextCursor();
        await this.loadOlderMessages();
        if (before === this.historyNextCursor()) break;
      }
      if (this.navigationTarget?.nonce !== target.nonce) return;
      if (!this.messages().some(item => item.role === 'user' && item.messageId === request!.inputMessageId)) return;
      window.requestAnimationFrame(() => {
        if (this.selectedDialogId() !== this.dialogKey(dialog!) || this.navigationTarget?.nonce !== target.nonce) return;
        this.disarmHistoryAutoScroll();
        const message = this.historyViewport?.nativeElement.querySelector<HTMLElement>(
          `[data-testid="message-${CSS.escape(request!.inputMessageId)}"]`);
        message?.querySelector<HTMLElement>('.message-context')?.focus({ preventScroll: true });
        message?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      });
      this.appliedNavigationNonce = target.nonce;
    } finally {
      if (this.applyingNavigationNonce === target.nonce) this.applyingNavigationNonce = 0;
    }
  }

  private dialogCursorSignature(): string {
    return JSON.stringify(Object.entries(this.dialogPages)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([connectionId, page]) => [connectionId, page.nextCursor]));
  }

  private renderedHistoryChanged(previous: HarnessMessage[], next: HarnessMessage[]): boolean {
    if (previous.length !== next.length) return true;
    return previous.some((message, index) => this.messageRenderKey(message) !== this.messageRenderKey(next[index]));
  }

  private messageRenderKey(message: HarnessMessage): string {
    return JSON.stringify(message);
  }

  private activityRenderKey(page: ToolActivityPage): string {
    return JSON.stringify({ attempt: page.attempt, items: page.items, nextCursor: page.nextCursor });
  }

  private armHistoryAutoScroll(): void {
    this.historyAutoScrollArmed = true;
  }

  private disarmHistoryAutoScroll(): void {
    this.historyAutoScrollArmed = false;
    this.cancelPendingHistoryScroll();
  }

  private cancelPendingHistoryScroll(): void {
    if (this.historyScrollFrame !== undefined) window.cancelAnimationFrame(this.historyScrollFrame);
    if (this.historySettleFrame !== undefined) window.cancelAnimationFrame(this.historySettleFrame);
    this.historyScrollFrame = undefined;
    this.historySettleFrame = undefined;
  }

  private scheduleHistoryScrollToEnd(): void {
    if (!this.historyAutoScrollArmed) return;
    this.cancelPendingHistoryScroll();
    this.historyScrollFrame = window.requestAnimationFrame(() => {
      this.scrollHistoryToEnd();
      this.historyScrollFrame = undefined;
      this.historySettleFrame = window.requestAnimationFrame(() => {
        this.scrollHistoryToEnd();
        this.historySettleFrame = undefined;
      });
    });
  }

  private scrollHistoryToEnd(): void {
    const element = this.historyViewport?.nativeElement;
    if (element) element.scrollTop = element.scrollHeight;
  }

  private dialogKey(dialog: Pick<DialogListRow, 'nodeId' | 'dialogId'>): string {
    return `${dialog.nodeId}:${dialog.dialogId}`;
  }

  private genericHttpError(status: number): string {
    if (status === 400) return 'Сервер отклонил некорректный запрос.';
    if (status === 401) return 'Сессия завершена. Войдите снова.';
    if (status === 403) return 'Недостаточно прав для этого действия.';
    if (status === 404) return 'Объект не найден или больше недоступен.';
    if (status === 409) return 'Состояние изменилось. Обновите данные перед следующим действием.';
    if (status === 413) return 'Данные превышают допустимый размер.';
    if (status === 422) return 'Операция не поддерживается нодой.';
    if (status === 429) return 'Очередь временно не принимает новые команды.';
    if (status >= 500) return 'Сервер временно недоступен. Уже загруженные данные сохранены.';
    return `Ошибка HTTP ${status || 'сети'}.`;
  }
}
