export interface McpServer {
  id: string; name: string; enabled: boolean; transport: 'streamable_http'; url: string; timeoutMs: number;
  auth: { kind: string; bearerTokenConfigured?: boolean; secretAction?: 'keep' | 'replace' | 'remove'; secret?: string };
}

export interface InferenceSettings { modelId: string | null; speedMode: string | null; reasoningEffort: string | null; }
export interface SettingsSnapshot { mcpServers: McpServer[]; inference: InferenceSettings; }

export function buildNodeSettingsPutPayload(expectedRevision: number, value: SettingsSnapshot): { expectedRevision: number; draft: SettingsSnapshot } {
  const draft = structuredClone(value);
  for (const server of draft.mcpServers) {
    server.transport = 'streamable_http';
    if (server.auth.secretAction !== 'replace') delete server.auth.secret;
    delete server.auth.bearerTokenConfigured;
  }
  return { expectedRevision, draft };
}
