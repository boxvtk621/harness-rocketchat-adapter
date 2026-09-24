export const nodeSettingsFixture = Object.freeze({
  schemaId: 'harness-node-settings-v2',
  nodeId: '11111111-1111-4111-8111-111111111111',
  draftRevision: 8,
  appliedRevision: 7,
  draft: {
    mcpDocument: {
      schemaId: 'harness-mcp-document-v2',
      servers: [{
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Issue tracker',
        enabled: true,
        transport: 'streamable_http',
        url: 'https://mcp.example.test/api',
        timeoutMs: 30000,
        auth: { kind: 'bearer', bearerTokenConfigured: true }
      }]
    },
    inference: { modelId: 'fixture/model', speedMode: 'off', reasoningEffort: 'medium' }
  },
  applied: {
    mcpDocument: { schemaId: 'harness-mcp-document-v2', servers: [] },
    inference: { modelId: 'fixture/model', speedMode: null, reasoningEffort: null }
  },
  capabilities: { nativeRestart: 'managed', modelDefault: 'supported', speedDefault: 'supported', reasoningDefault: 'supported' },
  operation: null
});

export const modelCatalogFixture = Object.freeze({
  schemaId: 'harness-model-catalog-v2',
  nodeId: nodeSettingsFixture.nodeId,
  state: 'fresh',
  models: [{
    id: 'fixture/model', displayName: 'Fixture model', isDefault: true,
    reasoningEfforts: [{ id: 'low' }, { id: 'medium', isDefault: true }],
    speedModes: [{ id: 'off', isDefault: true }, { id: 'on' }],
    combinations: [{ speedMode: 'off', reasoningEffort: 'low' }, { speedMode: 'off', reasoningEffort: 'medium' }, { speedMode: 'on', reasoningEffort: 'medium' }]
  }],
  nextCursor: null
});

export const nodeSettingsPutFixture = Object.freeze({
  input: {
    expectedRevision: 8,
    draft: {
      mcpDocument: {
        schemaId: 'harness-mcp-document-v2',
        servers: [
          { id: 'none', name: 'No auth', enabled: true, transport: 'streamable_http', url: 'https://none.example.test', timeoutMs: 30000,
            auth: { kind: 'none', bearerTokenConfigured: false, secretAction: 'remove', secret: 'discard-me' } },
          { id: 'configured', name: 'Configured bearer', enabled: true, transport: 'streamable_http', url: 'https://configured.example.test', timeoutMs: 30000,
            auth: { kind: 'bearer', bearerTokenConfigured: true, secretAction: 'keep', secret: 'discard-me' } },
          { id: 'replacement', name: 'New bearer', enabled: true, transport: 'streamable_http', url: 'https://replacement.example.test', timeoutMs: 30000,
            auth: { kind: 'bearer', bearerTokenConfigured: false, secretAction: 'replace', secret: 'fixture-replacement' } },
          { id: 'stdio', name: 'Local tool', enabled: true, transport: 'stdio', command: 'tool', args: [], timeoutMs: 30000,
            secretSlots: [{ slot: 'TOKEN', configured: true, action: 'keep', secret: 'discard-me' }] }
        ]
      },
      inference: { modelId: null, speedMode: null, reasoningEffort: null }
    }
  }
});
