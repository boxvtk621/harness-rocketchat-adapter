import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Centrifuge, Subscription } from 'centrifuge';
import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { runtimeConfig } from './runtime-config';
import { DialogsComponent } from './dialogs/dialogs.component';
import { ProviderAuthComponent } from './provider-auth.component';
import { MarkdownRendererComponent } from './markdown/markdown-renderer.component';
import { UiIconComponent } from './ui-icon.component';
import { firstValueFrom } from 'rxjs';
import { ToolCallDetail, ToolCallRead, ToolCallSummary } from './dialogs/dialogs.models';
import { ToolActivityComponent } from './dialogs/tool-activity.component';
import { ToolActivityGroup, ToolActivitySelection, ToolActivityState } from './dialogs/tool-activity.models';

interface Observation {
  attemptedAt: string | null;
  successfulAt: string | null;
  httpReachable: boolean | null;
  executorHealthy: boolean | null;
  ready: boolean | null;
  capacity: string | null;
  heartbeatAt: string | null;
  heartbeatFresh: boolean | null;
  bootId: string | null;
  nodeId: string | null;
  protocolVersion: number | null;
  schemaId: string | null;
  compatibility: string;
  errorCode: string | null;
  availability?: 'unknown' | 'available' | 'stale' | 'unavailable' | null;
  identityConflict?: boolean | null;
  conflict?: boolean | null;
  conflictDetail?: string | null;
  occupancy?: 'idle' | 'active' | 'unknown' | string | null;
}

interface Connection {
  id: string;
  name: string;
  baseUri: string;
  configEpoch: number;
  observationIntervalSeconds: number;
  requestTimeoutSeconds: number;
  staleThresholdSeconds: number;
  observation: Observation;
  createdAt: string | null;
  updatedAt: string;
  endpointKey?: string | null;
  identityStatus?: 'unverified' | 'unique' | 'node_id_conflict' | null;
  conflictingConnectionIds?: string[];
}

interface NodeProjection {
  connectionId: string;
  name: string;
  configEpoch: number;
  observation: Observation;
  baseUri?: string | null;
  identityConflict?: boolean | null;
  conflictDetail?: string | null;
  endpointKey?: string | null;
  identityStatus?: 'unverified' | 'unique' | 'node_id_conflict' | null;
  conflictingConnectionIds?: string[];
  occupancy?: string | number | boolean | null;
}

interface AttemptProjection {
  attemptId: string;
  requestId: string;
  state: string;
  effectStatus: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  result?: string | null;
  generation?: number;
}

interface HarnessPage<T> {
  items: T[];
  nextCursor?: string | null;
}

interface WorkProjection {
  connectionId: string;
  nodeId: string;
  nodeName?: string | null;
  requestId: string;
  dialogId: string;
  title?: string | null;
  requestTitle?: string | null;
  dialogTitle?: string | null;
  status: string;
  effectStatus?: string | null;
  version: number;
  queueSequence: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  acceptedAt?: string | null;
  observedAt?: string | null;
  attentionRequired?: boolean;
  activeAttempt: AttemptProjection | null;
}

interface MessageProjection {
  messageId: string;
  role: string;
  sequence: number;
  version?: number;
  createdAt: string;
  text: string | null;
  content: unknown;
  requestId?: string | null;
  attemptId?: string | null;
}

interface CompletedRequestProjection {
  requestId: string;
  title?: string | null;
  status?: string | null;
  effectStatus?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
  result?: string | null;
  messages?: MessageProjection[];
}

interface HistoryProjection {
  connectionId: string;
  nodeId: string;
  nodeName?: string | null;
  dialogId: string;
  requestId?: string | null;
  title: string | null;
  requestTitle?: string | null;
  status?: string | null;
  effectStatus?: string | null;
  dialogVersion: number;
  createdAt: string | null;
  completedAt?: string | null;
  result?: string | null;
  messages: MessageProjection[];
  requests?: CompletedRequestProjection[];
  completedRequests?: CompletedRequestProjection[];
  attempts?: AttemptProjection[];
}

interface HistoryRow {
  key: string;
  connectionId: string;
  nodeId: string;
  nodeName?: string | null;
  dialogId: string;
  requestId: string | null;
  requestTitle: string | null;
  dialogTitle: string | null;
  status: string;
  effectStatus: string | null;
  createdAt: string | null;
  completedAt: string | null;
  result: string | null;
  messages: MessageProjection[];
}

interface ManagedNodeRow {
  connection: Connection;
  projection: NodeProjection | null;
}

interface DialogNavigationTarget {
  connectionId: string;
  nodeId: string;
  dialogId: string;
  requestId: string | null;
  nonce: number;
}

type Section = 'work' | 'history' | 'nodes' | 'dialogs';
type Resource = 'connections' | 'nodes' | 'work' | 'history';
type RefreshTarget = Resource | 'dialogs';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, DialogsComponent, ProviderAuthComponent, MarkdownRendererComponent, ToolActivityComponent, UiIconComponent],
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit, OnDestroy {
  readonly section = signal<Section>('work');
  readonly user = signal<User | null>(null);
  readonly authReady = signal(false);
  readonly canManageConnections = signal(false);
  readonly notice = signal('');
  readonly connections = signal<Connection[]>([]);
  readonly nodes = signal<NodeProjection[]>([]);
  readonly work = signal<WorkProjection[]>([]);
  readonly history = signal<HistoryProjection[]>([]);
  readonly realtimeState = signal('Подключение…');
  readonly loadingResources = signal<Record<Resource, boolean>>({ connections: false, nodes: false, work: false, history: false });
  readonly resourceErrors = signal<Record<Resource, string>>({ connections: '', nodes: '', work: '', history: '' });
  readonly saveBusy = signal(false);
  readonly authError = signal('');
  readonly sessionNotice = signal('');
  readonly clock = signal(Date.now());
  readonly dialogsRefreshVersion = signal(0);
  readonly dialogsOpened = signal(false);
  readonly dialogsSession = signal(sessionStorage.getItem('hl307.web-session') || crypto.randomUUID());
  readonly dialogNavigationTarget = signal<DialogNavigationTarget | null>(null);

  readonly selectedWorkId = signal<string | null>(null);
  readonly selectedHistoryId = signal<string | null>(null);
  readonly historyToolGroups = signal<ToolActivityGroup[]>([]);
  readonly historyToolsLoading = signal(false);
  readonly historyToolsError = signal('');
  readonly historyToolsPartial = signal(false);
  readonly selectedHistoryToolCallId = signal<string | null>(null);
  readonly historyToolDetail = signal<ToolCallDetail | null>(null);
  readonly historyToolDetailLoading = signal(false);
  readonly historyToolDetailError = signal('');
  readonly selectedNodeId = signal<string | null>(null);
  readonly selectedConnectionId = signal<string | null>(null);

  workQuery = '';
  workStatus = 'all';
  historyQuery = '';
  historyStatus = 'all';
  historyNode = 'all';
  nodesQuery = '';
  nodesState = 'all';

  form = this.emptyForm();
  private originalBaseUri = '';
  private centrifuge?: Centrifuge;
  private subscription?: Subscription;
  private refreshTimer?: number;
  private clockTimer?: number;
  private hadRealtimeDisconnect = false;
  private renewal?: Promise<User | null>;
  private renewalRetryTimer?: number;
  private renewalRetryCount = 0;
  private loggingOut = false;
  private readonly inFlight = new Set<Resource>();
  private readonly pending = new Set<Resource>();
  private readonly queuedResources = new Set<RefreshTarget>();
  private historyToolsLoadRevision = 0;
  private historyToolDetailRevision = 0;
  private lastHistoryToolSelection: ToolActivitySelection | null = null;
  private readonly users = new UserManager({
    authority: runtimeConfig.oidcAuthority,
    client_id: runtimeConfig.oidcClientId,
    redirect_uri: `${location.origin}/auth/callback`,
    post_logout_redirect_uri: location.origin,
    response_type: 'code',
    scope: 'openid profile',
    userStore: new WebStorageStateStore({ store: sessionStorage }),
    automaticSilentRenew: false,
    accessTokenExpiringNotificationTimeInSeconds: 1
  });

  constructor(private readonly http: HttpClient) {}

  private readonly onUserLoaded = (loaded: User): void => {
    this.user.set(loaded);
    this.sessionNotice.set('');
    this.authError.set('');
    this.renewalRetryCount = 0;
    if (this.authReady()) void this.resumeAuthenticatedApp();
  };
  private readonly onUserUnloaded = (): void => {
    if (!this.loggingOut && this.user()) this.expireSession('Сессия Keycloak завершена. Войдите снова.');
  };
  private readonly onAccessTokenExpiring = (): void => { void this.renewSession('token-expiring'); };
  private readonly onAccessTokenExpired = (): void => { void this.renewSession('token-expired'); };
  private readonly onSilentRenewError = (error: Error): void => { this.handleRenewFailure(error); };
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') void this.ensureFreshSession('foreground');
  };
  private readonly onOnline = (): void => { void this.ensureFreshSession('network-restored'); };

  async ngOnInit(): Promise<void> {
    this.registerAuthEvents();
    this.clockTimer = window.setInterval(() => this.clock.set(Date.now()), 1000);
    try {
      if (location.pathname === '/auth/callback') {
        await this.users.signinRedirectCallback();
        this.clearDialogPending();
        this.dialogsSession.set(crypto.randomUUID());
        history.replaceState({}, '', '/');
      }
      sessionStorage.setItem('hl307.web-session', this.dialogsSession());
      const stored = await this.users.getUser();
      this.user.set(stored);
      if (stored?.expired) await this.renewSession('startup');
      if (this.user() && !this.user()?.expired) await this.resumeAuthenticatedApp();
    } catch {
      this.authError.set('Не удалось завершить вход. Повторите попытку.');
    } finally {
      this.authReady.set(true);
    }
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    if (this.clockTimer) window.clearInterval(this.clockTimer);
    if (this.renewalRetryTimer) window.clearTimeout(this.renewalRetryTimer);
    this.unregisterAuthEvents();
    this.subscription?.unsubscribe();
    this.centrifuge?.disconnect();
  }

  login(): Promise<void> { return this.users.signinRedirect(); }
  logout(): Promise<void> {
    this.loggingOut = true;
    if (this.renewalRetryTimer) window.clearTimeout(this.renewalRetryTimer);
    this.clearDialogPending();
    sessionStorage.removeItem('hl307.web-session');
    return this.users.signoutRedirect();
  }

  dialogSessionKey(): string { return `${this.user()?.profile.sub ?? ''}:${this.dialogsSession()}`; }
  private clearDialogPending(): void {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith('hl307:pending:')) sessionStorage.removeItem(key);
  }
  dialogSessionExpired(): void {
    void this.renewSession('dialogs-401').then(loaded => {
      if (loaded) this.dialogsRefreshVersion.update(value => value + 1);
    });
  }
  openDialogSettings(connectionId: string): void {
    this.open('nodes');
    const connection = this.connectionFor(connectionId);
    if (connection) {
      this.selectConnection(connection);
      const projection = this.nodes().find(item => item.connectionId === connectionId);
      if (projection) this.selectedNodeId.set(projection.connectionId);
    }
  }

  open(section: Section): void {
    if (section === 'dialogs') this.dialogsOpened.set(true);
    this.section.set(section);
    this.notice.set('');
    this.refreshCurrent();
  }

  refreshCurrent(): void {
    const section = this.section();
    if (section === 'dialogs') {
      this.loadProjection('nodes', false);
      this.dialogsRefreshVersion.update(value => value + 1);
    }
    else if (section === 'nodes') {
      this.loadConnections();
      this.loadProjection('nodes');
    } else this.loadProjection(section);
  }

  currentResource(): RefreshTarget {
    return this.section();
  }

  selectWork(item: WorkProjection): void { this.selectedWorkId.set(this.workKey(item)); }
  selectHistory(item: HistoryRow): void {
    this.selectedHistoryId.set(item.key);
    void this.loadHistoryTools(item);
  }
  selectNode(item: NodeProjection): void { this.selectedNodeId.set(item.connectionId); }

  selectManagedNode(item: ManagedNodeRow): void {
    this.selectConnection(item.connection);
    this.selectedNodeId.set(item.connection.id);
  }

  openHistoryDialog(item: HistoryRow): void {
    this.dialogNavigationTarget.set({
      connectionId: item.connectionId,
      nodeId: item.nodeId,
      dialogId: item.dialogId,
      requestId: item.requestId,
      nonce: Date.now()
    });
    this.open('dialogs');
  }

  selectConnection(connection: Connection): void {
    this.selectedConnectionId.set(connection.id);
    this.originalBaseUri = connection.baseUri;
    this.form = {
      id: connection.id,
      name: connection.name,
      baseUri: connection.baseUri,
      observationIntervalSeconds: connection.observationIntervalSeconds,
      requestTimeoutSeconds: connection.requestTimeoutSeconds,
      staleThresholdSeconds: connection.staleThresholdSeconds
    };
  }

  clearForm(): void {
    this.selectedConnectionId.set(null);
    this.originalBaseUri = '';
    this.notice.set('');
    this.form = this.emptyForm();
  }

  save(): void {
    const headers = this.headers();
    if (!headers || this.saveBusy() || !this.canManageConnections()) return;
    this.saveBusy.set(true);
    this.setResourceError('connections', '');
    this.notice.set('');
    const body = {
      name: this.form.name.trim(),
      baseUri: this.form.baseUri.trim(),
      observationIntervalSeconds: this.form.observationIntervalSeconds,
      requestTimeoutSeconds: this.form.requestTimeoutSeconds,
      staleThresholdSeconds: this.form.staleThresholdSeconds
    };
    const wasNew = !this.form.id;
    const uriChanged = !wasNew && body.baseUri !== this.originalBaseUri;
    const request = this.form.id
      ? this.http.put<Connection>(`/api/connections/${encodeURIComponent(this.form.id)}`, body, { headers, observe: 'response' })
      : this.http.post<Connection>('/api/connections', body, { headers, observe: 'response' });
    request.subscribe({
      next: response => {
        const saved = response.body;
        if (!saved) {
          this.saveBusy.set(false);
          this.setResourceError('connections', 'Сервер не вернул сохранённое подключение.');
          return;
        }
        this.saveBusy.set(false);
        this.selectConnection(saved);
        const reused = response.headers.get('X-Connection-Reused')?.toLocaleLowerCase('ru') === 'true';
        this.notice.set(reused
          ? 'Это подключение уже зарегистрировано. Открыта существующая запись.'
          : wasNew
            ? 'Подключение добавлено. Ожидается первое наблюдение.'
          : uriChanged
            ? 'Подключение сохранено. Наблюдение будет выполнено заново.'
            : 'Подключение сохранено.');
        this.loadConnections();
      },
      error: error => {
        this.saveBusy.set(false);
        this.handleHttpError('connections', error, 'Не удалось сохранить подключение. Данные не изменены.');
      }
    });
  }

  loadConnections(showLoading = true): void {
    const headers = this.headers();
    if (!headers || !this.beginLoad('connections', showLoading)) return;
    this.http.get<Connection[]>('/api/connections', { headers }).subscribe({
      next: value => {
        this.connections.set(value);
        this.finishLoad('connections');
      },
      error: error => {
        this.handleHttpError('connections', error, undefined, true);
        this.finishLoad('connections');
      }
    });
  }

  filteredWork(): WorkProjection[] {
    const query = this.workQuery.trim().toLocaleLowerCase('ru');
    return this.work().filter(item => {
      const text = [this.workTitle(item), this.workNodeName(item), item.requestId, item.dialogId].join(' ').toLocaleLowerCase('ru');
      return (!query || text.includes(query)) && (this.workStatus === 'all' || this.workCategory(item) === this.workStatus);
    });
  }

  workGroups(): { key: string; title: string; rows: WorkProjection[] }[] {
    const rows = this.filteredWork();
    return [
      { key: 'attention', title: 'Требуют внимания', rows: rows.filter(item => this.workCategory(item) === 'attention') },
      { key: 'running', title: 'Выполняются', rows: rows.filter(item => this.workCategory(item) === 'running') },
      { key: 'queued', title: 'В очереди', rows: rows.filter(item => this.workCategory(item) === 'queued') },
      { key: 'done', title: 'Недавно завершены', rows: rows.filter(item => this.workCategory(item) === 'done') }
    ].filter(group => group.rows.length > 0);
  }

  historyRows(): HistoryRow[] {
    return this.history().flatMap(dialog => {
      const requests = dialog.completedRequests ?? dialog.requests;
      if (requests?.length) {
        return requests.map((request, index): HistoryRow => ({
          key: request.requestId ? `${dialog.nodeId}:${request.requestId}` : `${dialog.nodeId}:${dialog.dialogId}:${index}`,
          connectionId: dialog.connectionId,
          nodeId: dialog.nodeId,
          nodeName: dialog.nodeName,
          dialogId: dialog.dialogId,
          requestId: request.requestId || null,
          requestTitle: request.title ?? null,
          dialogTitle: dialog.title,
          status: request.status ?? 'completed',
          effectStatus: request.effectStatus ?? null,
          createdAt: request.createdAt ?? null,
          completedAt: request.completedAt ?? null,
          result: request.result ?? null,
          messages: request.messages ?? dialog.messages.filter(message => message.requestId === request.requestId)
        }));
      }
      return [{
        key: `${dialog.nodeId}:${dialog.requestId ?? dialog.dialogId}`,
        connectionId: dialog.connectionId,
        nodeId: dialog.nodeId,
        nodeName: dialog.nodeName,
        dialogId: dialog.dialogId,
        requestId: dialog.requestId ?? null,
        requestTitle: dialog.requestTitle ?? null,
        dialogTitle: dialog.title,
        status: dialog.status ?? 'completed',
        effectStatus: dialog.effectStatus ?? null,
        createdAt: dialog.createdAt,
        completedAt: dialog.completedAt ?? null,
        result: dialog.result ?? null,
        messages: dialog.messages
      }];
    });
  }

  filteredHistory(): HistoryRow[] {
    const query = this.historyQuery.trim().toLocaleLowerCase('ru');
    return this.historyRows().filter(item => {
      const text = [this.historyTitle(item), this.historySessionTitle(item), this.historyNodeName(item), item.requestId, item.dialogId, this.resultText(item)].join(' ').toLocaleLowerCase('ru');
      const statusMatches = this.historyStatus === 'all' || this.historyStatusKey(item.status) === this.historyStatus;
      const nodeMatches = this.historyNode === 'all' || item.connectionId === this.historyNode;
      return (!query || text.includes(query)) && statusMatches && nodeMatches;
    });
  }

  filteredNodes(): NodeProjection[] {
    const query = this.nodesQuery.trim().toLocaleLowerCase('ru');
    return this.nodes().filter(item => {
      const text = [this.nodeName(item), item.baseUri, this.connectionFor(item.connectionId)?.baseUri, item.observation.nodeId].join(' ').toLocaleLowerCase('ru');
      return (!query || text.includes(query)) && (this.nodesState === 'all' || this.nodeCategory(item) === this.nodesState);
    });
  }

  managedNodes(): ManagedNodeRow[] {
    const projections = new Map(this.nodes().map(item => [item.connectionId, item]));
    return this.connections().map(connection => ({
      connection,
      projection: projections.get(connection.id) ?? null
    }));
  }

  filteredManagedNodes(): ManagedNodeRow[] {
    const query = this.nodesQuery.trim().toLocaleLowerCase('ru');
    return this.managedNodes().filter(item => {
      const projection = item.projection;
      const text = [item.connection.name, item.connection.baseUri, projection?.observation.nodeId].join(' ').toLocaleLowerCase('ru');
      const category = projection ? this.nodeCategory(projection) : this.connectionCategory(item.connection);
      return (!query || text.includes(query)) && (this.nodesState === 'all' || category === this.nodesState);
    });
  }

  selectedWork(): WorkProjection | null { return this.work().find(item => this.workKey(item) === this.selectedWorkId()) ?? null; }
  selectedHistory(): HistoryRow | null { return this.historyRows().find(item => item.key === this.selectedHistoryId()) ?? null; }
  selectedNode(): NodeProjection | null { return this.nodes().find(item => item.connectionId === this.selectedNodeId()) ?? null; }
  selectedManagedNode(): ManagedNodeRow | null {
    const connection = this.selectedConnection();
    if (!connection) return null;
    return { connection, projection: this.nodes().find(item => item.connectionId === connection.id) ?? null };
  }
  selectedConnection(): Connection | null { return this.connections().find(item => item.id === this.selectedConnectionId()) ?? null; }

  workTitle(item: WorkProjection): string { return item.requestTitle ?? item.title ?? item.dialogTitle ?? 'Обращение без названия'; }
  historyTitle(item: HistoryRow): string {
    return this.requestMessageText(item) ?? item.requestTitle?.trim() ?? 'Завершённое обращение';
  }
  historyListTitle(item: HistoryRow): string { return this.truncate(this.historyTitle(item), 112); }
  historySessionTitle(item: HistoryRow): string {
    return item.dialogTitle?.trim() || 'Сессия без названия';
  }

  historyAnswer(item: HistoryRow): string | null {
    if (item.result?.trim()) return item.result.trim();
    const exact = item.messages
      .filter(message => message.role.toLocaleLowerCase('ru') === 'assistant')
      .sort((a, b) => b.sequence - a.sequence)[0];
    if (!exact) return null;
    if (exact.text?.trim()) return exact.text.trim();
    if (typeof exact.content === 'string' && exact.content.trim()) return exact.content.trim();
    if (exact.content && typeof exact.content === 'object') {
      const content = exact.content as { kind?: unknown; content?: unknown };
      if (content.kind === 'inline' && typeof content.content === 'string' && content.content.trim()) return content.content.trim();
    }
    return null;
  }

  historyAnswerIdentity(item: HistoryRow): string {
    const message = item.messages.filter(candidate => candidate.role.toLocaleLowerCase('ru') === 'assistant').sort((a, b) => b.sequence - a.sequence)[0];
    return message?.messageId ?? item.key;
  }

  historyAnswerVersion(item: HistoryRow): number {
    const message = item.messages.filter(candidate => candidate.role.toLocaleLowerCase('ru') === 'assistant').sort((a, b) => b.sequence - a.sequence)[0];
    return message?.version ?? 1;
  }
  workNodeName(item: WorkProjection): string { return item.nodeName ?? this.displayNodeName(item.connectionId, item.nodeId); }
  historyNodeName(item: HistoryRow): string { return item.nodeName ?? this.displayNodeName(item.connectionId, item.nodeId); }
  nodeName(item: NodeProjection): string { return item.name || this.connectionFor(item.connectionId)?.name || 'Нода без названия'; }

  workUpdatedAt(item: WorkProjection): string | null {
    return item.observedAt ?? item.updatedAt ?? item.activeAttempt?.updatedAt ?? item.acceptedAt ?? item.createdAt ?? null;
  }

  workKey(item: WorkProjection): string { return `${item.nodeId}:${item.requestId}`; }

  workCategory(item: WorkProjection): string {
    return item.attentionRequired ? 'attention' : this.statusCategory(item.status, item.effectStatus ?? item.activeAttempt?.effectStatus);
  }
  nodeCategory(item: NodeProjection): string {
    if (this.hasConflict(item)) return 'conflict';
    if (item.observation.attemptedAt === null) return 'unknown';
    if (item.observation.availability === 'unavailable' || item.observation.httpReachable === false) return 'offline';
    if (item.observation.availability === 'stale') return 'stale';
    if (this.effectiveHeartbeatFresh(item.observation, item.connectionId) === false) return 'stale';
    if (item.observation.executorHealthy === false) return 'offline';
    if (this.occupancyIsBusy(item.observation.occupancy ?? item.occupancy)) return 'busy';
    if (item.observation.ready === true) return 'ready';
    if (item.observation.ready === false && item.observation.executorHealthy === true) return 'not-ready';
    return 'unknown';
  }
  connectionCategory(item: Connection): string {
    const projection = this.nodes().find(node => node.connectionId === item.id);
    if (projection) return this.nodeCategory(projection);
    if (item.identityStatus === 'node_id_conflict') return 'conflict';
    if (item.observation.availability === 'unavailable' || item.observation.httpReachable === false) return 'offline';
    if (item.observation.availability === 'stale') return 'stale';
    return item.observation.attemptedAt ? 'offline' : 'unknown';
  }

  statusLabel(status?: string | null, effectStatus?: string | null): string {
    const normalized = (status ?? '').trim().toLocaleLowerCase('ru');
    if (normalized === 'queued') return 'В очереди';
    if (normalized === 'dispatching') return 'Назначается';
    if (normalized === 'active' || normalized === 'running' || normalized === 'in_progress') return 'Выполняется';
    if (normalized === 'completed' || normalized === 'succeeded' || normalized === 'done') return 'Завершено';
    if (normalized === 'failed' || normalized === 'error') return 'Ошибка';
    if (normalized === 'cancelled' || normalized === 'canceled') return 'Отменено';
    if (normalized === 'interrupted') return 'Прервано';
    if (normalized === 'unknown') return 'Исход неизвестен';
    const category = this.statusCategory(status, effectStatus);
    return category === 'running' ? 'Выполняется' : category === 'queued' ? 'В очереди' : category === 'attention' ? 'Исход неизвестен' : 'Завершено';
  }

  effectLabel(effectStatus?: string | null): string {
    const normalized = (effectStatus ?? '').trim().toLocaleLowerCase('ru');
    if (!normalized) return 'Нет данных';
    if (normalized === 'none') return 'Нет внешнего эффекта';
    if (normalized === 'known') return 'Эффект известен';
    if (normalized === 'unknown') return 'Состояние неизвестно';
    return 'Состояние неизвестно';
  }

  statusClass(status?: string | null, effectStatus?: string | null): string { return this.statusCategory(status, effectStatus); }
  availabilityLabel(observation: Observation): string {
    if (observation.availability === 'available') return 'API доступен';
    if (observation.availability === 'stale') return 'Данные API устарели';
    if (observation.availability === 'unavailable') return 'API недоступен';
    if (observation.availability === 'unknown') return 'Доступность неизвестна';
    if (observation.attemptedAt === null) return 'Ещё не проверено';
    if (observation.httpReachable === false) return 'API недоступен';
    if (observation.httpReachable === true) return 'API доступен';
    return 'Доступность неизвестна';
  }
  healthLabel(observation: Observation, connectionId?: string): string {
    if (this.effectiveHeartbeatFresh(observation, connectionId) === false) return 'Здоровье не подтверждено';
    if (observation.executorHealthy === true) return 'Исполнитель исправен';
    if (observation.executorHealthy === false) return 'Исполнитель неисправен';
    return 'Здоровье неизвестно';
  }
  readinessLabel(observation: Observation, connectionId?: string): string {
    if (this.effectiveHeartbeatFresh(observation, connectionId) === false) return 'Готовность не подтверждена';
    if (observation.ready === true) return 'Принимает новые';
    if (observation.ready === false) return 'Приём закрыт';
    return 'Готовность неизвестна';
  }
  heartbeatLabel(observation: Observation, connectionId?: string): string {
    const fresh = this.effectiveHeartbeatFresh(observation, connectionId);
    if (fresh === true) return 'Heartbeat актуален';
    if (fresh === false) return 'Heartbeat устарел';
    return 'Heartbeat неизвестен';
  }
  occupancyLabel(occupancy: NodeProjection['occupancy'] | Observation['occupancy']): string {
    if (occupancy === null || occupancy === undefined || occupancy === '') return 'Неизвестно';
    if (typeof occupancy === 'string' && occupancy.toLocaleLowerCase('ru') === 'unknown') return 'Неизвестно';
    return this.occupancyIsBusy(occupancy) ? 'Занята' : 'Свободна';
  }
  observationLabel(observation: Observation, connectionId?: string): string {
    if (observation.errorCode?.toLocaleLowerCase('ru').includes('conflict')) return 'Конфликт идентичности';
    if (observation.attemptedAt === null) return 'Ожидает проверки';
    if (observation.httpReachable === false) return 'Недоступно';
    if (this.effectiveHeartbeatFresh(observation, connectionId) === false) return 'Устарело';
    if (observation.executorHealthy === false) return 'Неисправно';
    if (observation.ready === true) return 'Готово';
    if (observation.ready === false && observation.executorHealthy === true) return 'Приём закрыт';
    return 'Состояние неизвестно';
  }
  observationClass(observation: Observation, connectionId?: string): string {
    if (observation.errorCode?.toLocaleLowerCase('ru').includes('conflict')) return 'attention';
    if (observation.attemptedAt === null) return 'unknown';
    if (observation.httpReachable === false || observation.executorHealthy === false) return 'offline';
    if (this.effectiveHeartbeatFresh(observation, connectionId) === false) return 'stale';
    if (observation.ready === true) return 'ready';
    if (observation.ready === false && observation.executorHealthy === true) return 'not-ready';
    return 'unknown';
  }

  resultText(item: HistoryRow): string {
    return this.historyAnswer(item) ?? 'Ответ отсутствует в публичной проекции для этого обращения.';
  }

  requestText(item: HistoryRow): string {
    return this.requestMessageText(item) ?? item.requestTitle?.trim() ?? 'Текст обращения не предоставлен.';
  }

  historyToolsCountLabel(): string {
    const count = this.historyToolGroups().reduce((total, group) => total + group.calls.length, 0);
    const remainder = count % 100;
    const digit = count % 10;
    const noun = remainder >= 11 && remainder <= 14 ? 'операций' : digit === 1 ? 'операция' : digit >= 2 && digit <= 4 ? 'операции' : 'операций';
    return `${count} ${noun}`;
  }
  retryHistoryTools(): void {
    const selected = this.selectedHistory();
    if (selected) void this.loadHistoryTools(selected);
  }

  async inspectHistoryTool(selection: ToolActivitySelection): Promise<void> {
    const item = this.selectedHistory();
    const connection = item ? this.connectionFor(item.connectionId) : undefined;
    const headers = this.headers();
    if (!item || !connection || !headers) return;

    const revision = ++this.historyToolDetailRevision;
    this.lastHistoryToolSelection = selection;
    this.selectedHistoryToolCallId.set(selection.toolCall.toolCallId);
    this.historyToolDetail.set(null);
    this.historyToolDetailError.set('');
    this.historyToolDetailLoading.set(true);
    const base = `/api/dialogs/${encodeURIComponent(item.connectionId)}/nodes/${encodeURIComponent(item.nodeId)}`;
    const params = new HttpParams().set('configEpoch', connection.configEpoch).set('limit', 50);
    try {
      const read = await firstValueFrom(this.http.get<ToolCallRead>(
        `${base}/attempts/${encodeURIComponent(selection.attemptId)}/tool-calls/${encodeURIComponent(selection.toolCall.toolCallId)}`,
        { headers, params }
      ));
      if (revision !== this.historyToolDetailRevision || this.selectedHistoryId() !== item.key) return;
      this.historyToolDetail.set(this.historyToolDetailFromRead(read));
    } catch {
      if (revision === this.historyToolDetailRevision && this.selectedHistoryId() === item.key) {
        this.historyToolDetailError.set('Не удалось загрузить аргументы и результат операции.');
      }
    } finally {
      if (revision === this.historyToolDetailRevision) this.historyToolDetailLoading.set(false);
    }
  }

  closeHistoryToolDetail(): void {
    this.historyToolDetailRevision++;
    this.lastHistoryToolSelection = null;
    this.selectedHistoryToolCallId.set(null);
    this.historyToolDetail.set(null);
    this.historyToolDetailError.set('');
    this.historyToolDetailLoading.set(false);
  }

  retryHistoryToolDetail(): void {
    if (this.lastHistoryToolSelection) void this.inspectHistoryTool(this.lastHistoryToolSelection);
  }

  async loadMoreHistoryToolOutputs(): Promise<void> {
    const item = this.selectedHistory();
    const connection = item ? this.connectionFor(item.connectionId) : undefined;
    const detail = this.historyToolDetail();
    const headers = this.headers();
    if (!item || !connection || !detail?.nextOutputCursor || !headers || this.historyToolDetailLoading()) return;

    const revision = ++this.historyToolDetailRevision;
    this.historyToolDetailLoading.set(true);
    this.historyToolDetailError.set('');
    const base = `/api/dialogs/${encodeURIComponent(item.connectionId)}/nodes/${encodeURIComponent(item.nodeId)}`;
    const params = new HttpParams()
      .set('configEpoch', connection.configEpoch)
      .set('after', detail.nextOutputCursor)
      .set('limit', 50);
    try {
      const read = await firstValueFrom(this.http.get<ToolCallRead>(
        `${base}/attempts/${encodeURIComponent(detail.attemptId)}/tool-calls/${encodeURIComponent(detail.toolCallId)}`,
        { headers, params }
      ));
      if (revision !== this.historyToolDetailRevision || this.selectedHistoryId() !== item.key) return;
      const next = this.historyToolDetailFromRead(read);
      const outputs = new Map(detail.outputs.map(output => [output.index, output]));
      next.outputs.forEach(output => outputs.set(output.index, output));
      this.historyToolDetail.set({ ...next, outputs: [...outputs.values()].sort((left, right) => left.index - right.index) });
    } catch {
      if (revision === this.historyToolDetailRevision && this.selectedHistoryId() === item.key) {
        this.historyToolDetailError.set('Не удалось загрузить продолжение журнала операции.');
      }
    } finally {
      if (revision === this.historyToolDetailRevision) this.historyToolDetailLoading.set(false);
    }
  }

  connectionFor(connectionId: string): Connection | undefined { return this.connections().find(item => item.id === connectionId); }
  isLoading(resource: RefreshTarget): boolean { return resource === 'dialogs' ? false : this.loadingResources()[resource]; }
  errorFor(resource: Resource): string { return this.resourceErrors()[resource]; }
  trackConnection(_: number, item: Connection): string { return item.id; }
  trackNode(_: number, item: NodeProjection): string { return item.connectionId; }
  trackGroup(_: number, group: { key: string }): string { return group.key; }
  readonly trackWork = (_: number, item: WorkProjection): string => this.workKey(item);
  trackHistory(_: number, item: HistoryRow): string { return item.key; }
  safeTestId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, '-'); }

  private requestMessageText(item: HistoryRow): string | null {
    return item.messages.find(message => message.role.toLocaleLowerCase('ru') === 'user' && message.text?.trim())?.text?.trim() ?? null;
  }

  private async loadHistoryTools(item: HistoryRow): Promise<void> {
    const revision = ++this.historyToolsLoadRevision;
    this.historyToolDetailRevision++;
    this.historyToolGroups.set([]);
    this.historyToolsError.set('');
    this.historyToolsPartial.set(false);
    this.historyToolsLoading.set(false);
    this.lastHistoryToolSelection = null;
    this.selectedHistoryToolCallId.set(null);
    this.historyToolDetail.set(null);
    this.historyToolDetailError.set('');
    this.historyToolDetailLoading.set(false);
    if (!item.requestId) return;

    const connection = this.connectionFor(item.connectionId);
    const headers = this.headers();
    if (!connection || !headers) {
      this.historyToolsError.set('Не удалось определить подключение для этого обращения.');
      return;
    }

    this.historyToolsLoading.set(true);
    const base = `/api/dialogs/${encodeURIComponent(item.connectionId)}/nodes/${encodeURIComponent(item.nodeId)}`;
    const common = new HttpParams().set('configEpoch', connection.configEpoch).set('limit', 100);
    try {
      const attempts = await this.readHistoryPages<AttemptProjection>(`${base}/attempts`, common.set('requestId', item.requestId), headers);
      const toolPages = await Promise.all(attempts.items.map(attempt => this.readHistoryPages<ToolCallSummary>(
        `${base}/attempts/${encodeURIComponent(attempt.attemptId)}/tool-calls`,
        common,
        headers
      )));
      if (revision !== this.historyToolsLoadRevision || this.selectedHistoryId() !== item.key) return;
      const groups = attempts.items.map((attempt, index): ToolActivityGroup => ({
        key: `${item.requestId}:${attempt.attemptId}`,
        requestId: item.requestId!,
        attemptId: attempt.attemptId,
        generation: attempt.generation ?? index + 1,
        state: this.historyToolGroupState(attempt, toolPages[index].items),
        anchor: { messageId: null, placement: 'tail' },
        calls: [...toolPages[index].items].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)),
        pagination: { loadedCount: toolPages[index].items.length, nextCursor: null, hasMore: false, loading: false }
      })).filter(group => group.calls.length > 0).sort((left, right) => left.generation - right.generation);
      this.historyToolGroups.set(groups);
      this.historyToolsPartial.set(attempts.partial || toolPages.some(page => page.partial));
      const firstGroup = groups[0];
      const firstTool = firstGroup?.calls[0];
      if (firstGroup && firstTool) void this.inspectHistoryTool({ requestId: firstGroup.requestId, attemptId: firstGroup.attemptId, toolCall: firstTool });
    } catch {
      if (revision === this.historyToolsLoadRevision && this.selectedHistoryId() === item.key) {
        this.historyToolsError.set('Не удалось загрузить операции именно этого обращения.');
      }
    } finally {
      if (revision === this.historyToolsLoadRevision) this.historyToolsLoading.set(false);
    }
  }

  private async readHistoryPages<T>(url: string, initialParams: HttpParams, headers: HttpHeaders): Promise<{ items: T[]; partial: boolean }> {
    const items: T[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const params: HttpParams = cursor ? initialParams.set('cursor', cursor) : initialParams;
      const page: HarnessPage<T> = await firstValueFrom(this.http.get<HarnessPage<T>>(url, { headers, params }));
      items.push(...page.items);
      cursor = page.nextCursor ?? null;
      pages++;
    } while (cursor && pages < 10);
    return { items, partial: !!cursor };
  }

  private historyToolGroupState(attempt: AttemptProjection, calls: readonly ToolCallSummary[]): ToolActivityState {
    const state = attempt.state.toLocaleLowerCase('en');
    if (['dispatching', 'running', 'waiting_input', 'stopping'].includes(state)) return 'running';
    if (state === 'failed') return 'failed';
    if (state === 'interrupted') return 'interrupted';
    if (state === 'completed' && calls.some(call => call.state === 'failed')) return 'failed';
    if (state === 'completed' && calls.every(call => call.state === 'succeeded')) return 'succeeded';
    return 'unknown';
  }

  private historyToolDetailFromRead(read: ToolCallRead): ToolCallDetail {
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

  private loadProjection(kind: 'nodes' | 'work' | 'history', showLoading = true): void {
    const headers = this.headers();
    if (!headers || !this.beginLoad(kind, showLoading)) return;
    this.http.get<NodeProjection[] | WorkProjection[] | HistoryProjection[]>(`/api/projections/${kind}`, { headers }).subscribe({
      next: value => {
        if (kind === 'nodes') this.nodes.set(value as NodeProjection[]);
        else if (kind === 'work') this.work.set(value as WorkProjection[]);
        else this.history.set(value as HistoryProjection[]);
        this.finishLoad(kind);
      },
      error: error => {
        this.handleHttpError(kind, error, undefined, true);
        this.finishLoad(kind);
      }
    });
  }

  private beginLoad(resource: Resource, showLoading: boolean): boolean {
    if (this.inFlight.has(resource)) {
      this.pending.add(resource);
      return false;
    }
    this.inFlight.add(resource);
    if (showLoading) this.setLoading(resource, true);
    this.setResourceError(resource, '');
    return true;
  }

  private finishLoad(resource: Resource): void {
    this.inFlight.delete(resource);
    this.setLoading(resource, false);
    if (!this.pending.delete(resource)) return;
    window.setTimeout(() => resource === 'connections' ? this.loadConnections(false) : this.loadProjection(resource, false), 0);
  }

  private setLoading(resource: Resource, value: boolean): void {
    this.loadingResources.update(current => ({ ...current, [resource]: value }));
  }

  private setResourceError(resource: Resource, value: string): void {
    this.resourceErrors.update(current => ({ ...current, [resource]: value }));
  }

  private registerAuthEvents(): void {
    this.users.events.addUserLoaded(this.onUserLoaded);
    this.users.events.addUserUnloaded(this.onUserUnloaded);
    this.users.events.addAccessTokenExpiring(this.onAccessTokenExpiring);
    this.users.events.addAccessTokenExpired(this.onAccessTokenExpired);
    this.users.events.addSilentRenewError(this.onSilentRenewError);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('online', this.onOnline);
  }

  private unregisterAuthEvents(): void {
    this.users.events.removeUserLoaded(this.onUserLoaded);
    this.users.events.removeUserUnloaded(this.onUserUnloaded);
    this.users.events.removeAccessTokenExpiring(this.onAccessTokenExpiring);
    this.users.events.removeAccessTokenExpired(this.onAccessTokenExpired);
    this.users.events.removeSilentRenewError(this.onSilentRenewError);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('online', this.onOnline);
  }

  private async resumeAuthenticatedApp(): Promise<void> {
    const headers = this.headers();
    if (!headers) return;
    try {
      const session = await this.http.get<{ canManageConnections: boolean }>('/api/session', { headers }).toPromise();
      this.canManageConnections.set(session?.canManageConnections === true);
      this.loadConnections(false);
      this.loadProjection('nodes', false);
      this.loadProjection(this.section() === 'history' ? 'history' : 'work', false);
      if (!this.centrifuge) void this.startRealtime();
      else this.dialogsRefreshVersion.update(value => value + 1);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) await this.renewSession('session-401');
      else this.sessionNotice.set('Сессия сохранена, но сервер временно недоступен. Чтение будет повторено после восстановления связи.');
    }
  }

  private async ensureFreshSession(reason: string): Promise<User | null> {
    const current = this.user() ?? await this.users.getUser();
    if (!current) return null;
    const expiresIn = current.expires_in ?? 0;
    if (!current.expired && expiresIn > 60) return current;
    return this.renewSession(reason);
  }

  private renewSession(reason: string): Promise<User | null> {
    if (this.loggingOut) return Promise.resolve(null);
    if (this.renewal) return this.renewal;
    this.sessionNotice.set('Продление сессии…');
    this.renewal = this.users.signinSilent()
      .then(loaded => {
        this.user.set(loaded);
        this.sessionNotice.set('');
        this.authError.set('');
        this.renewalRetryCount = 0;
        return loaded;
      })
      .catch((error: unknown) => {
        this.handleRenewFailure(error, reason);
        return null;
      })
      .finally(() => { this.renewal = undefined; });
    return this.renewal;
  }

  private handleRenewFailure(error: unknown, reason = 'automatic'): void {
    const text = this.oidcErrorText(error);
    if (/invalid_grant|login_required|interaction_required|session.*expired|refresh.*expired/i.test(text)) {
      this.expireSession('Сессия Keycloak завершена или отозвана. Войдите снова.');
      return;
    }
    this.sessionNotice.set('Не удалось продлить сессию из-за временной ошибки сети или Keycloak. Загруженные данные сохранены; повторим автоматически.');
    if (this.renewalRetryCount >= 3 || this.renewalRetryTimer) return;
    const delay = 1000 * 2 ** this.renewalRetryCount++;
    this.renewalRetryTimer = window.setTimeout(() => {
      this.renewalRetryTimer = undefined;
      void this.renewSession(`retry:${reason}`);
    }, delay);
  }

  private oidcErrorText(error: unknown): string {
    if (!error || typeof error !== 'object') return String(error ?? '');
    const value = error as Record<string, unknown>;
    const direct = ['name', 'message', 'error', 'error_description', 'code']
      .map(key => value[key])
      .filter((item): item is string => typeof item === 'string');
    const cause = value['cause'];
    return [...direct, cause && cause !== error ? this.oidcErrorText(cause) : ''].filter(Boolean).join(' ');
  }

  private expireSession(message: string): void {
    if (this.renewalRetryTimer) window.clearTimeout(this.renewalRetryTimer);
    this.renewalRetryTimer = undefined;
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.centrifuge?.disconnect();
    this.centrifuge = undefined;
    this.canManageConnections.set(false);
    this.sessionNotice.set('');
    this.authError.set(message);
    this.user.set(null);
    void this.users.removeUser();
  }

  private recoverSafeRead(resource: Resource): void {
    void this.renewSession(`${resource}-401`).then(loaded => {
      if (!loaded) return;
      if (resource === 'connections') this.loadConnections(false);
      else this.loadProjection(resource, false);
    });
  }

  private headers(): HttpHeaders | null {
    const token = this.user()?.access_token;
    if (!token) {
      this.authError.set('Сессия истекла. Войдите снова.');
      this.user.set(null);
      return null;
    }
    return new HttpHeaders({ Authorization: `Bearer ${token}` });
  }

  private handleHttpError(resource: Resource, error: HttpErrorResponse, fallback = 'Не удалось загрузить данные. Сохранён предыдущий снимок.', retrySafeRead = false): void {
    if (error.status === 401) {
      if (retrySafeRead) this.recoverSafeRead(resource);
      else this.sessionNotice.set('Токен устарел во время команды. Сессия будет продлена, но команда не повторяется автоматически. Проверьте её квитанцию.');
      void this.renewSession(`${resource}-401`);
      return;
    }
    if (error.status === 403) {
      this.setResourceError(resource, 'Недостаточно прав для этого действия.');
      return;
    }
    if (error.status === 409 && error.error?.code === 'node_id_conflict') {
      const conflicts = Array.isArray(error.error?.conflicts) ? error.error.conflicts : [];
      const details = conflicts.map((item: { nodeId?: string; baseUris?: string[] }) =>
        `${item.nodeId || 'неизвестный nodeId'}: ${(item.baseUris ?? []).join(', ')}`).join('; ');
      this.setResourceError(resource, `Конфликт идентичности нод. Проекция недоступна${details ? `: ${details}` : '.'}`);
      return;
    }
    const detail = typeof error.error === 'object' ? error.error?.detail : '';
    this.setResourceError(resource, detail || fallback);
  }

  private async startRealtime(): Promise<void> {
    await this.ensureFreshSession('realtime-connect');
    const headers = this.headers();
    if (!headers) return;
    try {
      const reply = await this.http.get<{ token: string }>('/api/realtime/token', { headers }).toPromise();
      if (!reply) throw new Error('Token endpoint returned no data.');
      this.centrifuge = new Centrifuge(runtimeConfig.centrifugoWebsocketUrl, {
        token: reply.token,
        getToken: async () => {
          await this.ensureFreshSession('realtime-refresh');
          const refreshedHeaders = this.headers();
          if (!refreshedHeaders) throw new Error('Session expired.');
          const refreshed = await this.http.get<{ token: string }>('/api/realtime/token', { headers: refreshedHeaders }).toPromise();
          if (!refreshed) throw new Error('Token endpoint returned no data.');
          return refreshed.token;
        }
      });
      this.centrifuge.on('connected', () => {
        this.realtimeState.set('Подключено');
        if (this.hadRealtimeDisconnect) this.queueRefresh(this.currentResource());
        this.hadRealtimeDisconnect = false;
      });
      this.centrifuge.on('connecting', () => {
        if (this.realtimeState() === 'Подключено') this.hadRealtimeDisconnect = true;
        this.realtimeState.set(this.hadRealtimeDisconnect ? 'Переподключение…' : 'Подключение…');
      });
      this.centrifuge.on('disconnected', () => {
        this.hadRealtimeDisconnect = true;
        this.realtimeState.set('Уведомления недоступны');
      });
      this.subscription = this.centrifuge.newSubscription('connections');
      this.subscription.on('subscribed', () => {
        this.queueRefresh('connections');
        this.queueRefresh('nodes');
        this.queueRefresh(this.currentResource());
      });
      this.subscription.on('publication', event => {
        const resource = this.invalidationResource(event.data);
        const visible = this.currentResource();
        if (visible === 'dialogs') {
          this.queueRefresh('dialogs');
          if (resource === 'nodes' || resource === 'connections') this.queueRefresh('nodes');
          return;
        }
        if (resource === 'nodes' && visible === 'connections')
          this.queueRefresh('connections');
        else if (resource === null || resource === visible || resource === 'connections')
          this.queueRefresh(resource ?? visible);
      });
      this.subscription.subscribe();
      this.centrifuge.connect();
    } catch {
      this.realtimeState.set('Уведомления недоступны');
    }
  }

  private queueRefresh(resource: RefreshTarget): void {
    this.queuedResources.add(resource);
    if (this.refreshTimer) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      const resources = [...this.queuedResources];
      this.queuedResources.clear();
      for (const queued of resources) {
        if (queued === 'dialogs') this.dialogsRefreshVersion.update(value => value + 1);
        else if (queued === 'connections') this.loadConnections(false);
        else this.loadProjection(queued, false);
      }
    }, 180);
  }

  private invalidationResource(data: unknown): Resource | null {
    if (!data || typeof data !== 'object' || !('resource' in data)) return null;
    const resource = (data as { resource?: unknown }).resource;
    return resource === 'connections' || resource === 'nodes' || resource === 'work' || resource === 'history' ? resource : null;
  }

  private statusCategory(status?: string | null, effectStatus?: string | null): string {
    const normalized = (status ?? '').trim().toLocaleLowerCase('ru');
    if (/^(unknown|failed|error|cancelled|canceled|interrupted)$/.test(normalized)) return 'attention';
    if (/^(queued|dispatching|pending|created)$/.test(normalized)) return 'queued';
    if (/^(active|running|in_progress|accepted)$/.test(normalized)) return 'running';
    if (/^(completed|succeeded|done)$/.test(normalized)) return 'done';
    if (/unknown|uncertain|lost|error|fail|conflict|неизвест|ошиб|потер/.test(normalized)) return 'attention';
    if (/queue|pending|created|dispatch|ожида|очеред/.test(normalized)) return 'queued';
    if (/run|progress|accepted|active|выполн|работ/.test(normalized)) return 'running';
    return 'done';
  }

  private historyStatusKey(status?: string | null): string {
    const normalized = (status ?? '').trim().toLocaleLowerCase('ru');
    if (/^(completed|succeeded|done)$/.test(normalized)) return 'completed';
    if (/^(failed|error)$/.test(normalized)) return 'failed';
    if (/^(cancelled|canceled)$/.test(normalized)) return 'cancelled';
    if (normalized === 'interrupted') return 'interrupted';
    if (normalized === 'unknown') return 'unknown';
    return normalized || 'unknown';
  }

  private occupancyIsBusy(occupancy: NodeProjection['occupancy'] | Observation['occupancy']): boolean {
    if (typeof occupancy === 'boolean') return occupancy;
    if (typeof occupancy === 'number') return occupancy > 0;
    return /busy|active|occupied|занят|выполн/i.test(occupancy ?? '');
  }

  private hasConflict(item: NodeProjection): boolean {
    return item.identityStatus === 'node_id_conflict'
      || item.identityConflict === true
      || item.observation.identityConflict === true
      || item.observation.conflict === true
      || item.observation.errorCode?.toLocaleLowerCase('ru').includes('conflict') === true;
  }

  private displayNodeName(connectionId: string, nodeId: string): string {
    return this.nodes().find(item => item.connectionId === connectionId)?.name
      || this.connectionFor(connectionId)?.name
      || (nodeId && !this.looksLikeUuid(nodeId) ? nodeId : 'Нода без названия');
  }

  private effectiveHeartbeatFresh(observation: Observation, connectionId?: string): boolean | null {
    if (observation.heartbeatFresh === false) return false;
    if (!observation.heartbeatAt) return observation.heartbeatFresh;
    const thresholdSeconds = connectionId ? this.connectionFor(connectionId)?.staleThresholdSeconds : undefined;
    if (!thresholdSeconds) return observation.heartbeatFresh;
    const heartbeatTime = Date.parse(observation.heartbeatAt);
    if (!Number.isFinite(heartbeatTime)) return observation.heartbeatFresh;
    return this.clock() - heartbeatTime <= thresholdSeconds * 1000;
  }

  private looksLikeUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value); }
  private truncate(value: string, length: number): string { return value.length > length ? `${value.slice(0, length - 1)}…` : value; }
  private emptyForm() {
    return { id: '', name: '', baseUri: '', observationIntervalSeconds: 15, requestTimeoutSeconds: 5, staleThresholdSeconds: 45 };
  }
}
