import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

interface AuthOperation {
  operationId: string; commandId: string; method: string; status: string;
  reasonCode: string | null; verificationUrl: string | null; userCode: string | null;
  expiresAt: string | null; timeoutAt: string | null;
}
export interface ProviderAuthSnapshot {
  nodeId: string; revision: number; state: string; checkedAt: string | null; reasonCode: string | null;
  capabilities: { methods: string[]; canCheck: boolean; canLogout: boolean };
  operation: AuthOperation | null;
}

export function providerAuthStateLabel(value: string): string {
  return ({ unknown: 'Не подтверждена', unauthenticated: 'Вход не выполнен', authenticated: 'Вход подтверждён', reauthentication_required: 'Нужен повторный вход' } as Record<string,string>)[value] ?? 'Неизвестно';
}

export function providerAuthStateClass(value: string): string {
  return value === 'authenticated' ? 'ready' : value === 'unauthenticated' || value === 'reauthentication_required' ? 'attention' : 'unknown';
}

@Component({
  selector: 'provider-auth', standalone: true, imports: [CommonModule, FormsModule],
  template: `
    <section class="provider-auth inspector-card" data-testid="provider-auth" aria-labelledby="provider-auth-title">
      <div class="inspector-section-head provider-auth-head">
        <div><h3 id="provider-auth-title">Вход у провайдера</h3><p>Учётная запись, которой пользуется исполнитель.</p></div>
        <span *ngIf="snapshot() as auth" [class]="'status ' + stateClass(auth.state)">{{ stateLabel(auth.state) }}</span>
      </div>
      <p *ngIf="!canManage" class="muted">Доступно пользователям с правом управления подключениями.</p>
      <ng-container *ngIf="canManage">
        <p *ngIf="!nodeId || conflict" class="muted">Сначала требуется подтверждённая уникальная нода.</p>
        <p *ngIf="loading()" role="status">Проверка состояния…</p>
        <p *ngIf="error()" class="error" role="alert">{{ error() }}</p>
        <ng-container *ngIf="snapshot() as auth">
          <dl class="provider-auth-facts"><dt>Авторизация</dt><dd data-testid="provider-auth-state">{{ stateLabel(auth.state) }}</dd>
            <dt>Последняя проверка</dt><dd>{{ auth.checkedAt ? (auth.checkedAt | date:'dd.MM HH:mm:ss') : 'Не проверено' }}</dd></dl>
          <p *ngIf="auth.reasonCode" class="hint">{{ reasonLabel(auth.reasonCode) }}</p>
          <ng-container *ngIf="auth.operation as op">
            <p data-testid="provider-operation-state" role="status">{{ operationLabel(op.status) }}</p>
            <p *ngIf="op.reasonCode" class="hint">{{ reasonLabel(op.reasonCode) }}</p>
            <div *ngIf="op.status==='pending' && op.method==='device_code'" class="device-code-view">
              <ng-container *ngIf="safeUrl(op.verificationUrl) as url">
                <a data-testid="provider-verification-link" [href]="url" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Подтвердить вход на сайте провайдера ↗</a>
                <p class="hint">Проверьте адрес сайта. Введите этот одноразовый код:</p>
                <code data-testid="provider-user-code" class="device-code">{{ op.userCode }}</code>
              </ng-container>
              <p *ngIf="!op.verificationUrl" class="hint">Получение кода…</p>
              <p class="hint" *ngIf="op.expiresAt">Код действует до {{ op.expiresAt | date:'HH:mm:ss' }}.</p>
              <p class="hint" *ngIf="!op.expiresAt && op.timeoutAt">Ожидаем до {{ op.timeoutAt | date:'HH:mm:ss' }} — таймаут этой попытки.</p>
              <p class="hint">После подтверждения состояние обновится автоматически. Можно закрыть страницу.</p>
            </div>
          </ng-container>
          <p *ngIf="!auth.capabilities.methods.length" class="hint">Управляемый вход не поддерживается этой нодой.</p>
          <div class="provider-auth-entry" *ngIf="auth.operation?.status!=='pending' && !uncertain() && auth.capabilities.methods.includes('secret')">
            <form (ngSubmit)="start('secret')" autocomplete="off">
              <label>Секрет провайдера<input data-testid="provider-secret" type="password" name="providerSecret" [(ngModel)]="secret" autocomplete="new-password" maxlength="16384" spellcheck="false" [disabled]="busy()"></label>
              <p class="hint">Текущее значение не отображается. Пустое поле его не изменяет.</p>
              <button data-testid="provider-start-secret" type="submit" [disabled]="busy() || !secret.trim()">{{ auth.state==='authenticated' ? 'Заменить секрет' : 'Авторизовать' }}</button>
            </form>
          </div>
          <div class="actions provider-auth-actions">
            <button *ngIf="auth.operation?.status!=='pending' && !uncertain() && auth.capabilities.methods.includes('device_code')" class="primary provider-auth-primary" data-testid="provider-start-device" type="button" (click)="start('device_code')" [disabled]="busy()">{{ auth.state==='authenticated' ? 'Повторить вход' : 'Авторизовать' }}</button>
            <button *ngIf="auth.capabilities.canCheck" data-testid="provider-check" type="button" (click)="command('check')" [disabled]="busy() || uncertain()">Проверить</button>
            <button *ngIf="auth.operation?.status==='pending'" data-testid="provider-cancel" type="button" (click)="command('operations/' + auth.operation!.operationId + '/cancel')" [disabled]="busy()">Отменить вход</button>
            <button *ngIf="auth.capabilities.canLogout && auth.state!=='unauthenticated' && auth.operation?.status!=='pending'" class="provider-auth-logout" data-testid="provider-logout" type="button" (click)="confirmLogout.set(true)" [disabled]="busy()">Выйти</button>
          </div>
          <div *ngIf="confirmLogout()" role="group" aria-label="Подтверждение выхода">
            <p>Удалить вход у провайдера на этой ноде? Приём новой работы будет закрыт.</p>
            <div class="actions"><button data-testid="provider-confirm-logout" type="button" (click)="command('logout')" [disabled]="busy()">Подтвердить выход</button><button type="button" (click)="confirmLogout.set(false)">Оставить вход</button></div>
          </div>
        </ng-container>
        <p *ngIf="uncertain()" class="hint">Ответ не получен. Перечитайте состояние перед новой командой; секрет повторно не отправляется.</p>
        <div *ngIf="uncertain() && pendingAction && pendingCommand">
          <label *ngIf="pendingMethod==='secret'">Введите секрет повторно для той же команды<input data-testid="provider-retry-secret" type="password" [(ngModel)]="secret" autocomplete="new-password" maxlength="16384" spellcheck="false"></label>
          <button data-testid="provider-retry" type="button" (click)="retry()" [disabled]="busy() || (pendingMethod==='secret' && !secret.trim())">Повторить ту же команду</button>
        </div>
        <button *ngIf="error() || uncertain()" type="button" (click)="read()" [disabled]="loading()">Обновить состояние</button>
      </ng-container>
    </section>`
})
export class ProviderAuthComponent implements OnChanges, OnDestroy {
  @Input() connectionId = '';
  @Input() nodeId: string | null = null;
  @Input() configEpoch = 0;
  @Input() accessToken = '';
  @Input() canManage = false;
  @Input() conflict = false;
  @Output() readonly snapshotChange = new EventEmitter<ProviderAuthSnapshot>();
  readonly snapshot = signal<ProviderAuthSnapshot | null>(null);
  readonly error = signal(''); readonly busy = signal(false); readonly loading = signal(false);
  readonly uncertain = signal(false); readonly confirmLogout = signal(false);
  secret = '';
  private generation = 0;
  private poll?: number;
  private reading = false;
  pendingCommand?: string;
  pendingAction?: string;
  pendingMethod?: string;
  constructor(private readonly http: HttpClient) {}

  ngOnChanges(): void {
    this.generation++; this.secret = ''; this.snapshot.set(null); this.error.set('');
    this.busy.set(false); this.loading.set(false); this.uncertain.set(false); this.confirmLogout.set(false);
    this.pendingCommand = undefined; this.pendingAction = undefined; this.pendingMethod = undefined; this.reading = false;
    if (this.poll) window.clearInterval(this.poll);
    if (this.canManage && this.nodeId && !this.conflict) {
      this.read();
      this.poll = window.setInterval(() => { if (!document.hidden && !this.loading() && !this.busy()) this.read(false); }, 4000);
    }
  }
  ngOnDestroy(): void { this.generation++; this.secret = ''; if (this.poll) window.clearInterval(this.poll); }
  private base(): string { return '/api/connections/' + encodeURIComponent(this.connectionId) + '/provider-auth'; }
  private headers(): HttpHeaders { return new HttpHeaders({ Authorization: 'Bearer ' + this.accessToken }); }
  read(showLoading = true): void {
    if (!this.nodeId || !this.canManage || this.conflict || this.reading) return;
    this.reading = true;
    const generation = this.generation;
    if (showLoading) this.loading.set(true);
    this.http.get<ProviderAuthSnapshot>(this.base(), { headers: this.headers(), params: { nodeId: this.nodeId, configEpoch: this.configEpoch } }).subscribe({
      next: value => {
        if (generation !== this.generation) return;
        this.accept(value); this.loading.set(false); this.reading = false; this.error.set('');
        // Lost ACK is reconciled by command identity, never by automatic resubmission.
        if (value.operation?.commandId === this.pendingCommand ||
            (this.pendingAction === 'logout' && value.state === 'unauthenticated') ||
            (this.pendingAction?.endsWith('/cancel') && value.operation?.operationId === this.pendingAction.split('/')[1] && value.operation?.status !== 'pending')) this.uncertain.set(false);
      },
      error: failure => { if (generation === this.generation) { this.loading.set(false); this.reading = false; this.error.set(this.failureLabel(failure)); } }
    });
  }
  private accept(value: ProviderAuthSnapshot): void {
    if (value.nodeId !== this.nodeId || (this.snapshot()?.revision ?? -1) > value.revision) return;
    this.snapshot.set(value);
    this.snapshotChange.emit(value);
  }
  start(method: string): void {
    if (this.busy() || this.uncertain() || (method === 'secret' && !this.secret.trim())) return;
    const value = method === 'secret' ? this.secret : undefined;
    this.secret = '';
    this.command('operations', { method, ...(value !== undefined ? { secret: value } : {}) });
  }
  retry(): void {
    if (!this.pendingAction || !this.pendingCommand) return;
    const extra: Record<string, string> = this.pendingMethod ? { method: this.pendingMethod } : {};
    if (this.pendingMethod === 'secret') extra['secret'] = this.secret;
    this.secret = '';
    this.command(this.pendingAction, extra, this.pendingCommand);
  }
  command(action: string, extra: Record<string, string> = {}, retryId?: string): void {
    if (this.busy() || !this.nodeId || !this.canManage) return;
    this.busy.set(true); this.error.set(''); this.confirmLogout.set(false);
    const generation = this.generation; const commandId = retryId ?? crypto.randomUUID(); this.pendingCommand = commandId; this.pendingAction = action; this.pendingMethod = extra['method'];
    this.http.post<ProviderAuthSnapshot>(this.base() + '/' + action, { nodeId: this.nodeId, commandId, ...extra },
      { headers: this.headers(), params: { configEpoch: this.configEpoch } }).subscribe({
      next: value => { if (generation === this.generation) { this.accept(value); this.busy.set(false); this.uncertain.set(false); } },
      error: (failure: HttpErrorResponse) => {
        if (generation !== this.generation) return;
        this.busy.set(false); this.error.set(this.failureLabel(failure));
        if (failure.status === 0 || failure.status >= 500) { this.uncertain.set(true); this.read(false); }
      }
    });
  }
  safeUrl(value: string | null): string | null {
    try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  }
  stateLabel(value: string): string { return providerAuthStateLabel(value); }
  stateClass(value: string): string { return providerAuthStateClass(value); }
  operationLabel(value: string): string { return ({ pending: 'Ожидаем завершения входа', succeeded: 'Вход подтверждён', failed: 'Вход не завершён', cancelled: 'Вход отменён', expired: 'Время ожидания истекло' } as Record<string,string>)[value] ?? 'Состояние неизвестно'; }
  reasonLabel(value: string): string { return ({ busy: 'Нода выполняет работу. Дождитесь её завершения.', cancelled: 'Попытка отменена. Можно начать новый вход.', verification_failed: 'Подтверждение аккаунта не получено.', provider_operation_missing: 'Провайдер больше не видит эту попытку. Повторите вход.', invalid_secret: 'Секрет не принят провайдером.', credential_rejected: 'Провайдер отклонил авторизацию.', unsupported_version: 'Установленная версия не поддерживает этот способ входа.', provider_unavailable: 'Проверка провайдера сейчас недоступна.', restarted: 'Нода перезапущена. Начните новую попытку.', interrupted_by_restart: 'Нода перезапущена. Начните новую попытку.', managed_auth_required: 'Нужен вход через аккаунт провайдера.', provider_protocol_error: 'Версия провайдера вернула неподдерживаемый ответ.', pending_operation: 'На ноде уже идёт вход.', timeout: 'Истёк таймаут попытки.', expired: 'Время ожидания истекло.', unauthenticated: 'Требуется вход у провайдера.' } as Record<string,string>)[value] ?? 'Результат требует проверки состояния.'; }
  private failureLabel(failure: HttpErrorResponse): string {
    if (failure.status === 401) return 'Сессия Web истекла. Войдите снова.';
    if (failure.status === 403) return 'Недостаточно прав для управления подключениями.';
    if (failure.status === 404 || failure.status === 422) return 'Эта нода не поддерживает действие.';
    if (failure.error?.code === 'connection_changed') return 'Подключение изменилось. Обновите список нод.';
    if (failure.status === 409) return this.reasonLabel(failure.error?.code);
    return 'Не удалось получить подтверждённый результат. Проверьте состояние.';
  }
}
