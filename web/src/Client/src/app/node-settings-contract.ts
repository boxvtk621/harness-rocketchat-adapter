export interface SecretSlot {
  slot: string;
  configured?: boolean;
  action?: 'keep' | 'replace' | 'remove';
  secret?: string;
}

export interface McpServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'streamable_http' | 'sse' | 'stdio';
  url?: string;
  timeoutMs?: number;
  command?: string;
  args?: string[];
  auth?: {
    kind: 'none' | 'bearer';
    bearerTokenConfigured?: boolean;
    secretAction?: 'keep' | 'replace' | 'remove';
    secret?: string;
  };
  secretSlots?: SecretSlot[];
}

export interface McpDocument {
  schemaId: 'harness-mcp-document-v2';
  servers: McpServer[];
}

export interface InferenceSettings {
  modelId: string | null;
  speedMode: 'off' | 'on' | null;
  reasoningEffort: string | null;
}

export interface SettingsSnapshot {
  mcpDocument: McpDocument;
  inference: InferenceSettings;
}

export function buildNodeSettingsPutPayload(expectedRevision: number, value: SettingsSnapshot): { expectedRevision: number; draft: SettingsSnapshot } {
  const draft = structuredClone(value);
  for (const server of draft.mcpDocument.servers) {
    if (server.auth) {
      if (server.auth.secretAction !== 'replace') delete server.auth.secret;
      delete server.auth.bearerTokenConfigured;
    }
    for (const slot of server.secretSlots || []) {
      if (slot.action !== 'replace') delete slot.secret;
      delete slot.configured;
    }
  }
  return { expectedRevision, draft };
}
