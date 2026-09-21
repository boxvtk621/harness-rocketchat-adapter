export interface RuntimeConfig {
  oidcAuthority: string;
  oidcClientId: string;
  centrifugoWebsocketUrl: string;
}

declare global {
  interface Window {
    __HARNESS_CONFIG__?: Partial<RuntimeConfig>;
  }
}

const injected = window.__HARNESS_CONFIG__ ?? {};

export const runtimeConfig: RuntimeConfig = {
  oidcAuthority: injected.oidcAuthority ?? 'http://localhost:18180/realms/harness',
  oidcClientId: injected.oidcClientId ?? 'harness-web',
  centrifugoWebsocketUrl: injected.centrifugoWebsocketUrl
    ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/realtime/connection/websocket`
};
