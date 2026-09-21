export interface RuntimeConfig {
  oidcAuthority: string;
  oidcClientId: string;
  centrifugoWebsocketUrl: string;
}

export const runtimeConfig: RuntimeConfig = {
  oidcAuthority: 'http://localhost:18180/realms/harness',
  oidcClientId: 'harness-web',
  centrifugoWebsocketUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/realtime/connection/websocket`
};
