import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Component, Input, OnChanges, OnDestroy, SimpleChanges, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { buildNodeSettingsPutPayload, McpDocument, McpServer, SettingsSnapshot } from './node-settings-contract';

interface SettingsOperation {
  operationId: string; commandId: string; targetRevision: number; status: string; phase: string; reasonCode?: string | null;
}
interface SettingsEnvelope {
  schemaId: string; nodeId: string; draftRevision: number; appliedRevision: number; resourceRevision?: number;
  draft: SettingsSnapshot; applied: SettingsSnapshot | null; capabilities?: Record<string, unknown>;
  mcpSchema?: unknown; operation?: SettingsOperation | null;
}
interface CatalogChoice { id: string; isDefault?: boolean; }
interface ModelChoice {
  id: string; displayName: string; isDefault?: boolean;
  reasoningEfforts: CatalogChoice[]; speedModes: CatalogChoice[];
  combinations?: { speedMode: string | null; reasoningEffort: string | null; isDefault?: boolean }[];
}
interface ModelCatalog {
  schemaId: string; nodeId: string; catalogRevision?: string | number; runtimeVersion?: string;
  state: 'fresh' | 'stale' | 'unavailable' | 'unsupported';
  models: ModelChoice[]; nextCursor?: string | null;
}
interface ValidationResult { valid: boolean; errors?: { path: string; code: string }[]; }

@Component({
  selector: 'node-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './node-settings.component.html'
})
export class NodeSettingsComponent implements OnChanges, OnDestroy {
  @Input() connectionId = '';
  @Input() displayName = '';
  @Input() nodeId: string | null = null;
  @Input() configEpoch = 0;
  @Input() accessToken = '';
  @Input() sessionKey = '';
  @Input() canManage = false;
  @Input() conflict = false;
  @Input() refreshVersion = 0;
  @Input() refreshEvent: { connectionId: string; nodeId?: string | null; configEpoch: number; revision: number } | null = null;

  readonly envelope = signal<SettingsEnvelope | null>(null);
  readonly draft = signal<SettingsSnapshot | null>(null);
  readonly catalog = signal<ModelCatalog | null>(null);
  readonly popup = signal<'agent' | 'mcp' | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly catalogLoading = signal(false);
  readonly error = signal('');
  readonly jsonErrors = signal<string[]>([]);
  readonly jsonValidating = signal(false);
  readonly jsonValidated = signal(false);
  readonly checkingId = signal('');
  readonly checkResults = signal<Record<string, string>>({});
  readonly confirmApply = signal(false);
  readonly confirmClose = signal(false);
  mcpText = '';

  private generation = 0;
  private reading = false;
  private readAgain = false;
  private opener: HTMLElement | null = null;
  private pendingCommandId: string | null = null;
  private pendingRevision: number | null = null;
  private savedDraft = '';
  private savedMcpText = '';

  constructor(private readonly http: HttpClient) {}

  ngOnChanges(changes: SimpleChanges): void {
    const keys = Object.keys(changes);
    if (keys.every(key => ['accessToken', 'refreshVersion', 'refreshEvent', 'displayName'].includes(key)) &&
      this.sessionKey && !keys.some(key => changes[key].firstChange)) {
      if (changes['refreshVersion'] || changes['refreshEvent']) this.read(true);
      return;
    }
    this.generation++;
    this.reading = false;
    this.readAgain = false;
    this.pendingCommandId = null;
    this.pendingRevision = null;
    this.popup.set(null);
    this.envelope.set(null);
    this.draft.set(null);
    this.catalog.set(null);
    this.mcpText = '';
    this.savedMcpText = '';
    this.savedDraft = '';
    this.error.set('');
    this.jsonErrors.set([]);
    this.confirmApply.set(false);
    this.confirmClose.set(false);
    if (this.canManage && this.nodeId && !this.conflict) {
      this.read();
      this.loadCatalog(true);
    }
  }

  ngOnDestroy(): void {
    this.generation++;
    this.mcpText = '';
    this.clearReplacementSecrets();
  }

  private base(): string { return `/api/connections/${encodeURIComponent(this.connectionId)}/node-settings`; }
  private headers(): HttpHeaders { return new HttpHeaders({ Authorization: `Bearer ${this.accessToken}` }); }
  private params(extra: Record<string, string> = {}): HttpParams {
    let params = new HttpParams().set('nodeId', this.nodeId || '').set('configEpoch', this.configEpoch);
    for (const [key, value] of Object.entries(extra)) params = params.set(key, value);
    return params;
  }

  read(preserveError = false): void {
    if (!this.nodeId || !this.canManage || this.conflict) return;
    if (this.reading) { this.readAgain = true; return; }
    const generation = this.generation;
    this.reading = true;
    this.loading.set(true);
    if (!preserveError) this.error.set('');
    this.http.get<SettingsEnvelope>(this.base(), { headers: this.headers(), params: this.params() }).subscribe({
      next: value => {
        if (generation !== this.generation) return;
        this.finishRead();
        if (!this.validEnvelope(value)) { this.error.set('Harness вернула неподдерживаемую версию настроек.'); return; }
        if ((value.resourceRevision ?? -1) < Math.max(this.minimumResourceRevision(), this.envelope()?.resourceRevision ?? -1)) {
          this.error.set('Получен устаревший снимок настроек. Обновите состояние.');
          return;
        }
        this.accept(value);
      },
      error: failure => {
        if (generation !== this.generation) return;
        this.finishRead();
        this.error.set(this.failureLabel(failure));
      }
    });
  }

  private finishRead(): void {
    this.reading = false;
    this.loading.set(false);
    if (this.readAgain) { this.readAgain = false; queueMicrotask(() => this.read(true)); }
  }

  private minimumResourceRevision(): number {
    const event = this.refreshEvent;
    return event?.connectionId === this.connectionId && event.configEpoch === this.configEpoch &&
      (!event.nodeId || event.nodeId === this.nodeId) ? event.revision : -1;
  }

  loadCatalog(reset: boolean): void {
    if (!this.nodeId || this.catalogLoading()) return;
    const generation = this.generation;
    const cursor = reset ? null : this.catalog()?.nextCursor;
    this.catalogLoading.set(true);
    this.http.get<ModelCatalog>(this.base() + '/model-catalog', {
      headers: this.headers(), params: this.params(cursor ? { cursor } : {})
    }).subscribe({
      next: value => {
        if (generation !== this.generation) return;
        const prior = reset ? [] : this.catalog()?.models || [];
        if (value.schemaId === 'harness-model-catalog-v2' && value.nodeId === this.nodeId && Array.isArray(value.models)) {
          const models = value.models.map(model => ({ ...model,
            speedModes: Array.isArray(model.speedModes) ? model.speedModes : [],
            reasoningEfforts: Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [] }));
          this.catalog.set({ ...value, models: [...prior, ...models.filter(model => !prior.some(old => old.id === model.id))] });
        } else this.catalog.set({ schemaId: 'harness-model-catalog-v2', nodeId: this.nodeId!, state: 'unavailable', models: [] });
        this.catalogLoading.set(false);
      },
      error: () => {
        if (generation !== this.generation) return;
        this.catalog.set({ schemaId: 'harness-model-catalog-v2', nodeId: this.nodeId!, state: 'unavailable', models: [] });
        this.catalogLoading.set(false);
      }
    });
  }

  openPopup(kind: 'agent' | 'mcp', event: Event): void {
    if (!this.envelope()) return;
    this.opener = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.popup.set(kind);
    this.confirmApply.set(false);
    this.confirmClose.set(false);
    this.error.set('');
    window.setTimeout(() => document.querySelector<HTMLElement>('[data-testid="settings-popup"] [data-popup-first]')?.focus(), 0);
  }

  closePopup(discard = false): void {
    if (!discard && this.hasUnsavedChanges()) { this.confirmClose.set(true); return; }
    if (discard) this.restoreDraft();
    this.popup.set(null);
    this.confirmClose.set(false);
    this.confirmApply.set(false);
    queueMicrotask(() => this.opener?.focus());
  }

  onPopupKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); this.closePopup(); return; }
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget as HTMLElement;
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  selectedModel(): ModelChoice | undefined {
    const id = this.draft()?.inference.modelId;
    return id ? this.catalog()?.models.find(model => model.id === id)
      : this.catalog()?.models.find(model => model.isDefault);
  }
  modelDefaultSupported(): boolean { return this.envelope()?.capabilities?.['modelDefault'] === 'supported'; }
  speedDefaultSupported(): boolean { return this.envelope()?.capabilities?.['speedDefault'] === 'supported'; }
  reasoningDefaultSupported(): boolean { return this.envelope()?.capabilities?.['reasoningDefault'] === 'supported'; }
  modelRequired(): boolean { return this.draft()?.inference.modelId === null && !this.modelDefaultSupported(); }
  catalogFresh(): boolean { return this.catalog()?.state === 'fresh'; }
  catalogLabel(): string {
    return ({ fresh: 'Каталог актуален', stale: 'Каталог устарел', unavailable: 'Каталог недоступен', unsupported: 'Каталог не поддерживается' } as Record<string, string>)[this.catalog()?.state || 'unavailable'];
  }
  speedOptionSupported(mode: 'on' | 'off'): boolean {
    return this.catalogFresh() && !!this.selectedModel()?.speedModes.some(choice => choice.id === mode);
  }
  speedLabel(): string {
    return ({ on: 'Включён', off: 'Выключен' } as Record<string, string>)[this.draft()?.inference.speedMode || ''] || 'Настройка модели';
  }
  reasoningSupported(): boolean { return this.catalogFresh() && !!this.selectedModel()?.reasoningEfforts.length; }
  reasoningChoiceSupported(value: string): boolean {
    return !!this.selectedModel()?.reasoningEfforts.some(choice => choice.id === value);
  }
  setSpeed(enabled: boolean): void {
    const mode = enabled ? 'on' : 'off';
    const draft = this.draft();
    if (draft && this.speedOptionSupported(mode)) draft.inference.speedMode = mode;
  }
  resetSpeed(): void { const draft = this.draft(); if (draft) draft.inference.speedMode = null; }
  resetReasoning(): void { const draft = this.draft(); if (draft) draft.inference.reasoningEffort = null; }
  setReasoning(value: string): void {
    const draft = this.draft();
    if (draft && this.reasoningSupported() && this.selectedModel()?.reasoningEfforts.some(choice => choice.id === value)) {
      draft.inference.reasoningEffort = value;
    }
  }
  setReasoningSelection(value: string | null): void {
    if (!value) {
      if (this.reasoningDefaultSupported()) this.resetReasoning();
      return;
    }
    this.setReasoning(value);
  }
  reasoningLabel(value: string): string {
    return ({ none: 'Без рассуждений', minimal: 'Минимальная', low: 'Низкая', medium: 'Средняя',
      high: 'Высокая', xhigh: 'Сверхвысокая', max: 'Максимальная', ultra: 'Ультра' } as Record<string, string>)[value] || value;
  }
  incompatibleChoice(kind: 'speed' | 'reasoning'): boolean {
    const selected = kind === 'speed' ? this.draft()?.inference.speedMode : this.draft()?.inference.reasoningEffort;
    if (!selected || !this.catalogFresh()) return false;
    const model = this.selectedModel();
    if (!model) return true;
    return !(kind === 'speed' ? model.speedModes : model.reasoningEfforts).some(choice => choice.id === selected);
  }
  incompatibleTuple(): boolean {
    const model = this.selectedModel();
    const combinations = model?.combinations;
    if (!this.catalogFresh() || !combinations?.length) return false;
    const inference = this.draft()?.inference;
    return !!inference && !combinations.some(item =>
      (inference.speedMode === null || item.speedMode === inference.speedMode) &&
      (inference.reasoningEffort === null || item.reasoningEffort === inference.reasoningEffort));
  }
  inferenceChanged(): boolean {
    return !!this.draft() && JSON.stringify(this.draft()!.inference) !== JSON.stringify(this.envelope()?.draft.inference);
  }
  hasUnsavedChanges(): boolean { return this.inferenceChanged() || this.mcpText !== this.savedMcpText; }
  applyUnsupported(): boolean { return !['supported', 'managed'].includes(String(this.envelope()?.capabilities?.['nativeRestart'] || '')); }
  operationInFlight(): boolean { return ['pending', 'queued', 'running'].includes(this.envelope()?.operation?.status || ''); }
  settingsApplied(): boolean {
    const value = this.envelope();
    return !!value?.applied && value.draftRevision === value.appliedRevision && !this.hasUnsavedChanges() && value.operation?.status !== 'failed';
  }
  settingsStatus(): string {
    return this.operationInFlight() ? 'Применяется' : this.hasUnsavedChanges() ? 'Есть правки'
      : this.settingsApplied() ? 'Применено' : this.envelope()?.draftRevision === 0 ? 'Исходные настройки' : 'Не применено';
  }
  appliedMcpNames(value: SettingsSnapshot): string {
    return value.mcpDocument.servers.filter(server => server.enabled).map(server => server.name).join(', ') || 'нет';
  }
  currentMcpNames(): string {
    return this.envelope()?.draft.mcpDocument.servers.filter(server => server.enabled).map(server => server.name).join(', ') || 'нет';
  }
  trackModel = (_: number, value: ModelChoice) => value.id;
  trackMcp = (_: number, value: McpServer) => value.id;

  checkJson(): void {
    const document = this.parseMcp();
    if (!document || this.jsonValidating()) return;
    const generation = this.generation;
    this.jsonValidating.set(true);
    this.jsonValidated.set(false);
    this.http.post<ValidationResult>(this.base() + '/mcp-validate', { mcpDocument: document }, {
      headers: this.headers(), params: this.params()
    }).subscribe({
      next: result => {
        if (generation !== this.generation) return;
        this.jsonValidating.set(false);
        this.jsonValidated.set(result.valid);
        this.jsonErrors.set((result.errors || []).map(item => `${item.path || '/'}: ${item.code}`));
      },
      error: failure => {
        if (generation !== this.generation) return;
        this.jsonValidating.set(false);
        this.jsonErrors.set([this.failureLabel(failure)]);
      }
    });
  }

  private parseMcp(): McpDocument | null {
    try {
      const parsed: unknown = JSON.parse(this.mcpText);
      if (!parsed || typeof parsed !== 'object' || (parsed as McpDocument).schemaId !== 'harness-mcp-document-v2' ||
        !Array.isArray((parsed as McpDocument).servers)) {
        this.jsonErrors.set(['/schemaId: ожидается harness-mcp-document-v2 и массив servers']);
        return null;
      }
      this.jsonErrors.set([]);
      return parsed as McpDocument;
    } catch (error) {
      this.jsonErrors.set([error instanceof Error ? error.message : 'Некорректный JSON']);
      return null;
    }
  }

  checkMcp(server: McpServer): void {
    if (this.checkingId() || this.hasUnsavedChanges()) return;
    const revision = this.envelope()?.draftRevision;
    if (revision === undefined) return;
    this.checkingId.set(server.id);
    this.http.post<{ state?: string; reasonCode?: string; toolsCount?: number }>(this.base() + '/mcp-checks',
      { expectedRevision: revision, mcpServerId: server.id }, { headers: this.headers(), params: this.params() }).subscribe({
      next: value => {
        this.checkingId.set('');
        const suffix = value.toolsCount === undefined ? '' : ` · инструментов: ${value.toolsCount}`;
        this.checkResults.update(all => ({ ...all, [server.id]: `${value.state || 'Проверено'}${suffix}` }));
      },
      error: failure => {
        this.checkingId.set('');
        this.checkResults.update(all => ({ ...all, [server.id]: this.failureLabel(failure) }));
      }
    });
  }

  apply(): void {
    const current = this.envelope();
    const draft = this.draft();
    if (!current || !draft || this.busy() || this.operationInFlight() || this.applyUnsupported() ||
      this.modelRequired() || this.incompatibleChoice('speed') || this.incompatibleChoice('reasoning') || this.incompatibleTuple() ||
      (this.inferenceChanged() && !this.catalogFresh())) return;
    const mcpDocument = this.parseMcp();
    if (!mcpDocument) return;
    this.confirmApply.set(false);
    if (this.hasUnsavedChanges()) {
      const generation = this.generation;
      this.busy.set(true);
      this.error.set('');
      this.http.put<SettingsEnvelope>(this.base(),
        buildNodeSettingsPutPayload(current.draftRevision, { inference: structuredClone(draft.inference), mcpDocument }),
        { headers: this.headers(), params: this.params() }).subscribe({
        next: value => {
          if (generation !== this.generation) return;
          if (!this.validEnvelope(value)) { this.busy.set(false); this.error.set('Сохранение не подтверждено.'); return; }
          this.accept(value, true);
          this.sendApply(value.draftRevision);
        },
        error: failure => {
          if (generation !== this.generation) return;
          this.busy.set(false);
          this.error.set(this.failureLabel(failure));
          if (failure.status === 409 || failure.status === 412) this.read(true);
        }
      });
      return;
    }
    if (current.draftRevision !== current.appliedRevision) this.sendApply(current.draftRevision);
  }

  private sendApply(revision: number): void {
    if (this.pendingRevision !== revision) { this.pendingRevision = revision; this.pendingCommandId = crypto.randomUUID(); }
    const generation = this.generation;
    this.busy.set(true);
    this.http.post<SettingsEnvelope>(this.base() + '/apply',
      { expectedRevision: revision, targetRevision: revision, commandId: this.pendingCommandId },
      { headers: this.headers(), params: this.params() }).subscribe({
      next: value => {
        if (generation !== this.generation) return;
        this.busy.set(false);
        if (this.validEnvelope(value)) this.accept(value);
        else this.read(true);
      },
      error: failure => {
        if (generation !== this.generation) return;
        this.busy.set(false);
        this.error.set(failure.status === 0 || failure.status >= 500
          ? 'Ответ о применении не получен. Команда не повторена; обновите состояние.'
          : this.failureLabel(failure));
        this.read(true);
      }
    });
  }

  private accept(value: SettingsEnvelope, replaceDraft = false): void {
    if (this.pendingCommandId && value.operation?.commandId === this.pendingCommandId &&
      !['pending', 'queued', 'running'].includes(value.operation.status)) {
      this.pendingCommandId = null;
      this.pendingRevision = null;
    }
    const dirty = this.hasUnsavedChanges();
    this.envelope.set(value);
    if (!dirty || replaceDraft || !this.draft()) this.restoreDraft();
  }

  private restoreDraft(): void {
    const serverDraft = this.envelope()?.draft;
    if (!serverDraft) return;
    const draft = structuredClone(serverDraft);
    for (const server of draft.mcpDocument.servers) {
      if (server.auth) {
        server.auth.secretAction = server.auth.bearerTokenConfigured ? 'keep' : 'remove';
        delete server.auth.bearerTokenConfigured;
      }
      for (const slot of server.secretSlots || []) {
        slot.action = slot.configured ? 'keep' : 'remove';
        delete slot.configured;
      }
    }
    this.draft.set(draft);
    this.savedDraft = JSON.stringify(draft);
    this.mcpText = JSON.stringify(draft.mcpDocument, null, 2);
    this.savedMcpText = this.mcpText;
    this.jsonErrors.set([]);
    this.jsonValidated.set(false);
  }

  private validEnvelope(value: unknown): value is SettingsEnvelope {
    const item = value as SettingsEnvelope;
    return item?.schemaId === 'harness-node-settings-v2' && item.nodeId === this.nodeId &&
      Number.isInteger(item.draftRevision) && Number.isInteger(item.appliedRevision) &&
      item.draft?.mcpDocument?.schemaId === 'harness-mcp-document-v2' &&
      Array.isArray(item.draft.mcpDocument.servers) && !!item.draft.inference;
  }

  private clearReplacementSecrets(): void {
    for (const server of this.draft()?.mcpDocument.servers || []) {
      if (server.auth) delete server.auth.secret;
      for (const slot of server.secretSlots || []) delete slot.secret;
    }
  }

  operationLabel(value: SettingsOperation): string {
    return ({ pending: 'Ожидает выполнения', queued: 'В очереди', running: 'Выполняется',
      succeeded: 'Применено', failed: 'Не применено', cancelled: 'Отменено' } as Record<string, string>)[value.status] || value.status;
  }
  operationPhaseLabel(value: SettingsOperation): string {
    return ({ preflight: 'Проверка', draining: 'Ожидание работы', waiting: 'Ожидание работы',
      restarting: 'Перезапуск агента', stopping: 'Перезапуск агента', verifying: 'Проверка применения',
      rollback: 'Восстановление', complete: 'Завершено' } as Record<string, string>)[value.phase] || 'Состояние применения';
  }
  private failureLabel(failure: HttpErrorResponse): string {
    if (failure.status === 401) return 'Сессия Web истекла. Войдите снова.';
    if (failure.status === 403) return 'Недостаточно прав для управления настройками.';
    if (failure.status === 409 || failure.status === 412) return 'Настройки изменились параллельно. Ваш ввод сохранён; сравните с новой версией.';
    if (failure.status === 413) return 'Настройки превышают допустимый размер.';
    if (failure.status === 422) {
      const path = typeof failure.error?.path === 'string' ? failure.error.path : '';
      const code = typeof failure.error?.code === 'string' ? failure.error.code : 'validation_failed';
      return path ? `${path}: ${code}` : `Harness отклонила настройки: ${code}`;
    }
    return 'Не удалось подтвердить результат операции. Обновите состояние.';
  }
}
