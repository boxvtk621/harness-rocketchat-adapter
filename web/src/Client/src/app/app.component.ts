import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Centrifuge, Subscription } from 'centrifuge';
import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { runtimeConfig } from './runtime-config';

interface Connection {
  id: string;
  name: string;
  baseUri: string;
  observationStatus: string;
  lastObservationAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type Section = 'work' | 'history' | 'nodes' | 'settings';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit, OnDestroy {
  readonly section = signal<Section>('work');
  readonly user = signal<User | null>(null);
  readonly authReady = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly connections = signal<Connection[]>([]);
  readonly selected = signal<Connection | null>(null);
  readonly realtimeState = signal('Не подключено');

  form = { id: '', name: '', baseUri: '' };
  private centrifuge?: Centrifuge;
  private subscription?: Subscription;
  private readonly users = new UserManager({
    authority: runtimeConfig.oidcAuthority,
    client_id: runtimeConfig.oidcClientId,
    redirect_uri: `${location.origin}/auth/callback`,
    post_logout_redirect_uri: location.origin,
    response_type: 'code',
    scope: 'openid profile',
    userStore: new WebStorageStateStore({ store: sessionStorage }),
    automaticSilentRenew: false
  });

  constructor(private readonly http: HttpClient) {}

  async ngOnInit(): Promise<void> {
    try {
      if (location.pathname === '/auth/callback') {
        await this.users.signinRedirectCallback();
        history.replaceState({}, '', '/');
      }
      this.user.set(await this.users.getUser());
      if (this.user()?.expired) {
        await this.users.removeUser();
        this.user.set(null);
      }
      if (this.user()) await this.startRealtime();
    } catch {
      this.error.set('Не удалось завершить вход. Повторите попытку.');
    } finally {
      this.authReady.set(true);
    }
  }

  ngOnDestroy(): void { this.centrifuge?.disconnect(); }

  login(): Promise<void> { return this.users.signinRedirect(); }
  logout(): Promise<void> { return this.users.signoutRedirect(); }

  open(section: Section): void {
    this.section.set(section);
    this.error.set('');
    if (section === 'settings') this.loadConnections();
  }

  select(connection: Connection): void {
    this.selected.set(connection);
    this.form = { id: connection.id, name: connection.name, baseUri: connection.baseUri };
  }

  clearForm(): void {
    this.selected.set(null);
    this.form = { id: '', name: '', baseUri: '' };
  }

  loadConnections(): void {
    const headers = this.headers();
    if (!headers) return;
    this.loading.set(true);
    this.error.set('');
    this.http.get<Connection[]>('/api/connections', { headers }).subscribe({
      next: value => {
        this.connections.set(value);
        const current = this.selected();
        if (current) this.selected.set(value.find(x => x.id === current.id) ?? null);
        this.loading.set(false);
      },
      error: error => this.handleHttpError(error)
    });
  }

  save(): void {
    const headers = this.headers();
    if (!headers) return;
    this.loading.set(true);
    this.error.set('');
    this.notice.set('');
    const body = { name: this.form.name.trim(), baseUri: this.form.baseUri.trim() };
    const request = this.form.id
      ? this.http.put<Connection>(`/api/connections/${encodeURIComponent(this.form.id)}`, body, { headers })
      : this.http.post<Connection>('/api/connections', body, { headers });
    request.subscribe({
      next: saved => {
        this.notice.set('Подключение сохранено. Состояние наблюдения сброшено: Не проверено.');
        this.form.id = saved.id;
        this.selected.set(saved);
        this.loadConnections();
      },
      error: error => this.handleHttpError(error)
    });
  }

  trackConnection(_: number, item: Connection): string { return item.id; }

  private headers(): HttpHeaders | null {
    const token = this.user()?.access_token;
    if (!token) {
      this.error.set('Сессия истекла. Войдите снова.');
      this.user.set(null);
      return null;
    }
    return new HttpHeaders({ Authorization: `Bearer ${token}` });
  }

  private handleHttpError(error: HttpErrorResponse): void {
    this.loading.set(false);
    if (error.status === 401) {
      this.error.set('Сессия истекла. Войдите снова.');
      this.user.set(null);
    } else if (error.status === 403) {
      this.error.set('Недостаточно прав для этого действия.');
    } else {
      const detail = typeof error.error === 'object' ? error.error?.detail : '';
      this.error.set(detail || 'Не удалось выполнить запрос. Данные не изменены.');
    }
  }

  private async startRealtime(): Promise<void> {
    const headers = this.headers();
    if (!headers) return;
    try {
      const reply = await this.http.get<{token: string}>('/api/realtime/token', { headers }).toPromise();
      if (!reply) throw new Error('Token endpoint returned no data.');
      this.centrifuge = new Centrifuge(runtimeConfig.centrifugoWebsocketUrl, {
        token: reply.token,
        getToken: async () => {
          const refreshed = await this.http.get<{token: string}>('/api/realtime/token', { headers: this.headers()! }).toPromise();
          return refreshed!.token;
        }
      });
      this.centrifuge.on('connected', () => {
        this.realtimeState.set('Подключено');
        if (this.section() === 'settings') this.loadConnections();
      });
      this.centrifuge.on('disconnected', () => this.realtimeState.set('Переподключение…'));
      this.subscription = this.centrifuge.newSubscription('connections');
      this.subscription.on('publication', () => {
        if (this.section() === 'settings') this.loadConnections();
      });
      this.subscription.subscribe();
      this.centrifuge.connect();
    } catch {
      this.realtimeState.set('Уведомления недоступны');
    }
  }
}
