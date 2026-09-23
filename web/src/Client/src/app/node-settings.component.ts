import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Component, Input, OnChanges, OnDestroy, SimpleChanges, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { buildNodeSettingsPutPayload, McpServer, SettingsSnapshot } from './node-settings-contract';
interface SettingsOperation { operationId: string; commandId: string; targetRevision: number; status: string; phase: string; reasonCode?: string | null; }
interface SettingsEnvelope {
  schemaId: string; nodeId: string; draftRevision: number; appliedRevision: number;
  draft: SettingsSnapshot; applied: SettingsSnapshot | null; capabilities?: Record<string, unknown>;
  operation?: SettingsOperation | null;
}
interface CatalogChoice { id: string; isDefault?: boolean; }
interface ModelChoice { id: string; displayName: string; toolCalling?: boolean; reasoningEfforts: CatalogChoice[]; speedModes: CatalogChoice[]; }
interface ModelCatalog {
  schemaId: string; nodeId: string; catalogRevision?: string | number; runtimeVersion?: string; fetchedAt?: string;
  state: 'fresh' | 'stale' | 'unavailable' | 'unsupported'; models: ModelChoice[]; nextCursor?: string | null;
}

@Component({
  selector: 'node-settings', standalone: true, imports: [CommonModule, FormsModule],
  template: `
    <section class="node-settings inspector-card" data-testid="node-settings" aria-labelledby="node-settings-title">
      <div class="inspector-section-head">
        <div><h3 id="node-settings-title">Исполнение</h3><p>MCP и модель для всех диалогов этой ноды.</p></div>
        <span *ngIf="envelope()" [class]="'status ' + (settingsApplied() ? 'ready' : 'unknown')">{{ settingsStatus() }}</span>
      </div>
      <p *ngIf="!canManage" class="muted">Доступно пользователям с правом управления подключениями.</p>
      <p *ngIf="canManage && (!nodeId || conflict)" class="muted">Сначала требуется подтверждённая уникальная нода.</p>
        <p *ngIf="loading() && !envelope()" role="status">Загрузка настроек…</p>
      <div *ngIf="error()" class="settings-error" role="alert"><span>{{ error() }}</span><button type="button" (click)="read()">Повторить</button></div>
      <ng-container *ngIf="canManage && envelope() as value">
        <div class="settings-revisions" aria-label="Ревизии настроек"><span>Черновик <strong>{{ value.draftRevision }}</strong></span><span>Применено <strong>{{ value.appliedRevision }}</strong></span></div>
        <p class="hint" role="status" data-testid="settings-guidance">{{ settingsGuidance() }}</p>
        <p *ngIf="applyUnsupported()" class="hint" data-testid="settings-apply-unavailable">Эта нода не поддерживает применение настроек через Web. Сохранение черновика не изменит работающую модель. Для смены модели требуется обновление конфигурации и перезапуск ноды администратором.</p>

        <fieldset class="settings-fieldset" *ngIf="draft() as settings" [disabled]="busy()">
          <legend>Модель</legend>
          <div class="settings-grid">
            <label>Модель
              <select data-testid="node-model" [(ngModel)]="settings.inference.modelId" (ngModelChange)="modelChanged()">
                <option [ngValue]="null">По умолчанию провайдера</option>
                <option *ngIf="settings.inference.modelId && !selectedModel()" [value]="settings.inference.modelId">{{ settings.inference.modelId }} (из настроек)</option>
                <option *ngFor="let model of catalog()?.models || []; trackBy: trackModel" [value]="model.id">{{ model.displayName || model.id }}</option>
              </select>
            </label>
            <label>Режим скорости
              <select data-testid="node-speed" [(ngModel)]="settings.inference.speedMode" [disabled]="!selectedModel()?.speedModes?.length">
                <option [ngValue]="null">По умолчанию провайдера</option>
                <option *ngFor="let item of selectedModel()?.speedModes || []; trackBy: trackChoice" [value]="item.id">{{ item.id }}</option>
              </select>
            </label>
            <label>Глубина рассуждений
              <select data-testid="node-reasoning" [(ngModel)]="settings.inference.reasoningEffort" [disabled]="!selectedModel()?.reasoningEfforts?.length">
                <option [ngValue]="null">По умолчанию провайдера</option>
                <option *ngFor="let item of selectedModel()?.reasoningEfforts || []; trackBy: trackChoice" [value]="item.id">{{ item.id }}</option>
              </select>
            </label>
          </div>
          <div class="catalog-line">
            <span [class]="'status ' + catalogClass()">{{ catalogLabel() }}</span>
            <button type="button" (click)="loadCatalog(true)" [disabled]="catalogLoading()">{{ catalogLoading() ? 'Обновление…' : 'Обновить каталог' }}</button>
            <button *ngIf="catalog()?.nextCursor" type="button" (click)="loadCatalog(false)" [disabled]="catalogLoading()">Ещё модели</button>
          </div>
          <p class="hint">Список и допустимые сочетания сообщает текущая Harness под её авторизацией. Режим скорости не заменяет глубину рассуждений.</p>
        </fieldset>

        <fieldset class="settings-fieldset" *ngIf="draft() as settings" [disabled]="busy()">
          <legend>MCP‑серверы</legend>
          <div class="mcp-list" *ngIf="settings.mcpServers.length; else noMcp">
            <article class="mcp-row" *ngFor="let server of settings.mcpServers; let index=index; trackBy: trackMcp">
              <div class="mcp-row-head"><label class="toggle"><input type="checkbox" [(ngModel)]="server.enabled"> Включён</label><button type="button" class="danger-text" (click)="removeMcp(index)">Удалить</button></div>
              <label>Название<input [(ngModel)]="server.name" maxlength="80" autocomplete="off"></label>
              <label>URL<input [(ngModel)]="server.url" type="url" autocomplete="url" placeholder="https://mcp.example/sse"></label>
              <div class="settings-grid compact"><label>Таймаут, мс<input [(ngModel)]="server.timeoutMs" type="number" min="100" max="120000"></label><label>Авторизация
                <select [(ngModel)]="server.auth.kind" (ngModelChange)="authKindChanged(server)"><option value="none">Без авторизации</option><option value="bearer">Bearer</option></select></label></div>
              <label *ngIf="server.auth.kind==='bearer'">Bearer‑секрет
                <select [(ngModel)]="server.auth.secretAction" (ngModelChange)="secretActionChanged(server)"><option *ngIf="server.auth.bearerTokenConfigured" value="keep">Не менять</option><option value="replace">Заменить</option><option *ngIf="server.auth.bearerTokenConfigured" value="remove">Удалить</option></select></label>
              <label *ngIf="server.auth.secretAction==='replace'">Новый секрет<input [(ngModel)]="server.auth.secret" type="password" maxlength="16384" autocomplete="new-password" spellcheck="false"></label>
              <div class="mcp-row-foot"><span class="hint">{{ server.auth.bearerTokenConfigured ? 'Секрет настроен; значение скрыто.' : 'Секрет не настроен.' }}</span><button type="button" (click)="checkMcp(server)" [disabled]="checkingId()===server.id">{{ checkingId()===server.id ? 'Проверка…' : 'Проверить' }}</button></div>
              <p *ngIf="checkResults()[server.id]" class="hint" role="status">{{ checkResults()[server.id] }}</p>
            </article>
          </div>
          <ng-template #noMcp><p class="hint">MCP‑серверы не добавлены.</p></ng-template>
          <button type="button" (click)="addMcp()">Добавить MCP</button>
        </fieldset>

        <div class="actions settings-actions">
          <button data-testid="settings-save" type="button" (click)="saveDraft()" [disabled]="busy() || !hasUnsavedChanges()">Сохранить черновик</button>
          <button data-testid="settings-apply" class="primary" type="button" (click)="confirmApply.set(true)" [disabled]="busy() || hasUnsavedChanges() || applyUnsupported() || value.draftRevision===value.appliedRevision">{{ applyUnsupported() ? 'Применение недоступно' : 'Применить ревизию ' + value.draftRevision }}</button>
        </div>
        <div *ngIf="confirmApply()" class="apply-confirm" role="group" aria-label="Подтверждение применения настроек">
          <strong>Применить ревизию {{ value.draftRevision }}?</strong>
          <p>Активные попытки завершатся. Процесс агента может перезапуститься; контейнер, диалоги и история сохранятся.</p>
          <div class="actions"><button data-testid="settings-confirm-apply" class="primary" type="button" (click)="apply()" [disabled]="busy()">Подтвердить</button><button type="button" (click)="confirmApply.set(false)" [disabled]="busy()">Отмена</button></div>
        </div>
        <div *ngIf="value.operation as operation" class="settings-operation" role="status"><span>Операция {{ operation.phase || operation.status }}</span><strong>{{ operationLabel(operation) }}</strong></div>
        <p *ngIf="!applyUnsupported()" class="hint">Применение начнётся на границе попыток. MCP может потребовать управляемого перезапуска процесса агента; контейнер не перезапускается.</p>
      </ng-container>
    </section>`
})
export class NodeSettingsComponent implements OnChanges, OnDestroy {
  @Input() connectionId = '';
  @Input() nodeId: string | null = null;
  @Input() configEpoch = 0;
  @Input() accessToken = '';
  @Input() sessionKey = '';
  @Input() canManage = false;
  @Input() conflict = false;
  readonly envelope = signal<SettingsEnvelope | null>(null);
  readonly draft = signal<SettingsSnapshot | null>(null);
  readonly catalog = signal<ModelCatalog | null>(null);
  readonly loading = signal(false); readonly busy = signal(false); readonly catalogLoading = signal(false);
  readonly error = signal(''); readonly checkingId = signal(''); readonly checkResults = signal<Record<string, string>>({});
  readonly confirmApply = signal(false);
  private generation = 0; private poll?: number;
  private savedDraft = '';
  constructor(private readonly http: HttpClient) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (this.sessionKey && Object.keys(changes).every(key => key === 'accessToken') && !changes['accessToken']?.firstChange) return;
    this.generation++; this.clearSecrets();
    if (this.poll !== undefined) { window.clearInterval(this.poll); this.poll = undefined; }
    this.envelope.set(null); this.draft.set(null); this.catalog.set(null); this.error.set(''); this.confirmApply.set(false);
    this.loading.set(false); this.catalogLoading.set(false); this.busy.set(false); this.checkingId.set(''); this.checkResults.set({});
    if (this.canManage && this.nodeId && !this.conflict) { this.read(); this.loadCatalog(true); }
  }
  ngOnDestroy(): void { this.generation++; this.clearSecrets(); if (this.poll !== undefined) { window.clearInterval(this.poll); this.poll = undefined; } }
  private base(): string { return `/api/connections/${encodeURIComponent(this.connectionId)}/node-settings`; }
  private headers(): HttpHeaders { return new HttpHeaders({ Authorization: `Bearer ${this.accessToken}` }); }
  private params(extra: Record<string, string> = {}): HttpParams {
    let params = new HttpParams().set('nodeId', this.nodeId || '').set('configEpoch', this.configEpoch);
    for (const [key, value] of Object.entries(extra)) params = params.set(key, value);
    return params;
  }
  read(): void {
    if (!this.nodeId || !this.canManage || this.conflict || this.loading()) return;
    const generation = this.generation; this.loading.set(true); this.error.set('');
    this.http.get<SettingsEnvelope>(this.base(), { headers: this.headers(), params: this.params() }).subscribe({
      next: value => {
        if (generation !== this.generation) return;
        this.loading.set(false);
        if (!this.validEnvelope(value)) { this.error.set('Harness вернула неподдерживаемый формат настроек.'); return; }
        this.accept(value);
      },
      error: failure => { if (generation === this.generation) { this.loading.set(false); this.error.set(this.failureLabel(failure)); } }
    });
  }
  loadCatalog(reset: boolean): void {
    if (!this.nodeId || this.catalogLoading()) return;
    const generation = this.generation; const cursor = reset ? null : this.catalog()?.nextCursor; this.catalogLoading.set(true);
    this.http.get<ModelCatalog>(this.base() + '/model-catalog', { headers: this.headers(), params: this.params(cursor ? { cursor } : {}) }).subscribe({
      next: value => {
        if (generation !== this.generation) return;
        if (value.nodeId !== this.nodeId || !Array.isArray(value.models)) { this.catalogLoading.set(false); return; }
        const prior = reset ? [] : this.catalog()?.models || [];
        const normalized = value.models.map(model => ({ ...model,
          speedModes: Array.isArray(model.speedModes) ? model.speedModes : [],
          reasoningEfforts: Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [] }));
        this.catalog.set({ ...value, models: [...prior, ...normalized.filter(model => !prior.some(old => old.id === model.id))] });
        this.catalogLoading.set(false);
      },
      error: () => { if (generation === this.generation) { this.catalog.set({ schemaId: 'harness-model-catalog-v1', nodeId: this.nodeId!, state: 'unavailable', models: [] }); this.catalogLoading.set(false); } }
    });
  }
  saveDraft(): void {
    const settings = this.draft(); const current = this.envelope(); if (!settings || !current || this.busy()) return;
    const payload = buildNodeSettingsPutPayload(current.draftRevision, settings);
    this.mutate('PUT', '', payload);
  }
  apply(): void {
    const current = this.envelope(); if (!current || this.busy() || this.hasUnsavedChanges() || this.applyUnsupported() || current.draftRevision === current.appliedRevision) return;
    this.confirmApply.set(false);
    this.mutate('POST', '/apply', { expectedRevision: current.draftRevision, targetRevision: current.draftRevision, commandId: crypto.randomUUID() });
  }
  checkMcp(server: McpServer): void {
    if (this.checkingId()) return; this.checkingId.set(server.id);
    this.http.post<{ state?: string; reasonCode?: string; toolsCount?: number }>(this.base() + '/mcp-checks',
      { expectedRevision: this.envelope()?.draftRevision, mcpServerId: server.id }, { headers: this.headers(), params: this.params() }).subscribe({
      next: value => { this.checkingId.set(''); const suffix = value.toolsCount === undefined ? '' : ` · инструментов: ${value.toolsCount}`; this.checkResults.update(all => ({ ...all, [server.id]: `${value.state || 'Проверено'}${suffix}` })); },
      error: failure => { this.checkingId.set(''); this.checkResults.update(all => ({ ...all, [server.id]: this.failureLabel(failure) })); }
    });
  }
  addMcp(): void {
    const settings = this.draft(); if (!settings) return;
    settings.mcpServers.push({ id: crypto.randomUUID(), name: '', enabled: true, transport: 'streamable_http', url: '', timeoutMs: 30000,
      auth: { kind: 'none', bearerTokenConfigured: false, secretAction: 'remove' } });
  }
  removeMcp(index: number): void { this.draft()?.mcpServers.splice(index, 1); }
  secretActionChanged(server: McpServer): void { if (server.auth.secretAction !== 'replace') server.auth.secret = undefined; }
  authKindChanged(server: McpServer): void {
    server.auth.secret = undefined;
    server.auth.secretAction = server.auth.kind === 'bearer' ? (server.auth.bearerTokenConfigured ? 'keep' : 'replace') : 'remove';
  }
  modelChanged(): void {
    const settings = this.draft(); const model = this.selectedModel(); if (!settings) return;
    if (!model) { settings.inference.speedMode = null; settings.inference.reasoningEffort = null; return; }
    if (!model.speedModes.some(x => x.id === settings.inference.speedMode)) settings.inference.speedMode = null;
    if (!model.reasoningEfforts.some(x => x.id === settings.inference.reasoningEffort)) settings.inference.reasoningEffort = null;
  }
  selectedModel(): ModelChoice | undefined { const id = this.draft()?.inference.modelId; return id ? this.catalog()?.models.find(x => x.id === id) : undefined; }
  hasUnsavedChanges(): boolean { return !!this.draft() && JSON.stringify(this.draft()) !== this.savedDraft; }
  applyUnsupported(): boolean { return this.envelope()?.capabilities?.['nativeRestart'] === 'unsupported'; }
  settingsApplied(): boolean { const value = this.envelope(); return !!value?.applied && value.draftRevision === value.appliedRevision && !this.hasUnsavedChanges(); }
  settingsStatus(): string { return this.hasUnsavedChanges() ? 'Не сохранено' : this.settingsApplied() ? 'Применено' : this.envelope()?.draftRevision === 0 ? 'Исходные настройки' : 'Есть черновик'; }
  settingsGuidance(): string {
    if (this.hasUnsavedChanges()) return 'Есть несохранённые изменения. Нажмите «Сохранить черновик». Работающая модель пока не изменена.';
    if (this.settingsApplied()) return 'Сохранённые настройки применены к ноде.';
    if (this.envelope()?.draftRevision === 0) return 'Настройки через Web ещё не применялись. Выбор в форме не меняет работающую модель.';
    return this.applyUnsupported() ? 'Черновик сохранён, но не применён к ноде.' : 'Черновик сохранён. Нажмите «Применить ревизию» и подтвердите изменение.';
  }
  catalogLabel(): string { return ({ fresh: 'Каталог актуален', stale: 'Каталог устарел', unavailable: 'Каталог недоступен', unsupported: 'Каталог не поддерживается' } as Record<string,string>)[this.catalog()?.state || 'unavailable']; }
  catalogClass(): string { return this.catalog()?.state === 'fresh' ? 'ready' : this.catalog()?.state === 'stale' ? 'unknown' : 'attention'; }
  operationLabel(value: SettingsOperation): string { return ({ queued: 'В очереди', running: 'Выполняется', succeeded: 'Применено', failed: 'Не применено', cancelled: 'Отменено' } as Record<string,string>)[value.status] || value.status; }
  trackModel = (_: number, value: ModelChoice) => value.id; trackChoice = (_: number, value: CatalogChoice) => value.id; trackMcp = (_: number, value: McpServer) => value.id;

  private mutate(method: 'PUT' | 'POST', suffix: string, payload: unknown): void {
    const generation = this.generation; this.busy.set(true); this.error.set('');
    const request = method === 'PUT' ? this.http.put<SettingsEnvelope>(this.base() + suffix, payload, { headers: this.headers(), params: this.params() })
      : this.http.post<SettingsEnvelope | { nodeId: string; operation: SettingsOperation }>(this.base() + suffix, payload, { headers: this.headers(), params: this.params() });
    request.subscribe({
      next: value => {
        if (generation !== this.generation) return; this.busy.set(false); this.clearSecrets();
        if (this.validEnvelope(value)) this.accept(value); else { this.read(); this.startPolling(); }
      },
      error: failure => { if (generation === this.generation) { this.busy.set(false); this.clearSecrets(); this.error.set(this.failureLabel(failure)); } }
    });
  }
  private accept(value: SettingsEnvelope): void {
    this.clearSecrets(); this.envelope.set(value);
    this.draft.set(structuredClone(value.draft));
    for (const server of this.draft()!.mcpServers) {
      server.auth.secretAction = server.auth.kind === 'bearer'
        ? (server.auth.bearerTokenConfigured ? 'keep' : 'replace')
        : 'remove';
    }
    this.savedDraft = JSON.stringify(this.draft());
    if (value.operation && ['queued', 'running'].includes(value.operation.status)) this.startPolling();
    else if (this.poll !== undefined) { window.clearInterval(this.poll); this.poll = undefined; }
  }
  private validEnvelope(value: unknown): value is SettingsEnvelope {
    const item = value as SettingsEnvelope;
    return item?.schemaId === 'harness-node-settings-v1' && item.nodeId === this.nodeId && Number.isInteger(item.draftRevision) &&
      Number.isInteger(item.appliedRevision) && Array.isArray(item.draft?.mcpServers) && !!item.draft?.inference;
  }
  private startPolling(): void { if (this.poll === undefined) this.poll = window.setInterval(() => { if (!document.hidden && !this.loading() && !this.busy() && !this.hasUnsavedChanges()) this.read(); }, 2000); }
  private clearSecrets(): void { for (const server of this.draft()?.mcpServers || []) server.auth.secret = undefined; }
  private failureLabel(failure: HttpErrorResponse): string {
    if (failure.status === 401) return 'Сессия Web истекла. Войдите снова.';
    if (failure.status === 403) return 'Недостаточно прав для управления настройками.';
    if (failure.status === 409 || failure.status === 412) return failure.error?.code === 'connection_changed' ? 'Подключение изменилось. Выберите ноду снова.' : 'Настройки изменились параллельно. Обновите данные.';
    if (failure.status === 413) return 'Настройки превышают допустимый размер.';
    if (failure.status === 422) return 'Harness отклонила сочетание настроек.';
    return 'Не удалось подтвердить результат операции. Обновите состояние.';
  }
}
