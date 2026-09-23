// Contract fixture shared by focused browser scenarios once the isolated HL-312 stack is enabled.
// Deliberately contains only masked secret state; a readable secret is a test failure, not fixture data.
export const nodeSettingsFixture = Object.freeze({
  schemaId: 'harness-node-settings-v1',
  nodeId: '11111111-1111-4111-8111-111111111111',
  draftRevision: 8,
  appliedRevision: 7,
  draft: {
    mcpServers: [{
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Issue tracker',
      enabled: true,
      transport: 'streamable_http',
      url: 'https://mcp.example.test/api',
      timeoutMs: 30000,
      auth: { kind: 'bearer', bearerTokenConfigured: true }
    }],
    inference: { modelId: 'fixture/model', speedMode: 'standard', reasoningEffort: 'medium' }
  },
  applied: {
    mcpServers: [],
    inference: { modelId: 'fixture/model', speedMode: null, reasoningEffort: null }
  },
  capabilities: {},
  operation: null
});

export const modelCatalogFixture = Object.freeze({
  schemaId: 'harness-model-catalog-v1',
  nodeId: nodeSettingsFixture.nodeId,
  catalogRevision: 'fixture-1',
  runtimeVersion: 'fixture',
  fetchedAt: '2026-09-23T00:00:00Z',
  state: 'fresh',
  models: [{
    id: 'fixture/model', displayName: 'Fixture model', toolCalling: true,
    reasoningEfforts: [{ id: 'low' }, { id: 'medium', isDefault: true }],
    speedModes: [{ id: 'standard', isDefault: true }, { id: 'fast' }]
  }],
  nextCursor: null
});

export const nodeSettingsPutFixture = Object.freeze({
  input: {
    expectedRevision: 8,
    draft: {
      mcpServers: [
        { id: 'none', name: 'No auth', enabled: true, transport: 'streamable_http', url: 'https://none.example.test', timeoutMs: 30000,
          auth: { kind: 'none', bearerTokenConfigured: false, secretAction: 'remove', secret: 'must-be-removed' } },
        { id: 'configured', name: 'Configured bearer', enabled: true, transport: 'streamable_http', url: 'https://configured.example.test', timeoutMs: 30000,
          auth: { kind: 'bearer', bearerTokenConfigured: true, secretAction: 'keep', secret: 'must-be-removed' } },
        { id: 'replacement', name: 'New bearer', enabled: true, transport: 'streamable_http', url: 'https://replacement.example.test', timeoutMs: 30000,
          auth: { kind: 'bearer', bearerTokenConfigured: false, secretAction: 'replace', secret: 'fixture-replacement' } }
      ],
      inference: { modelId: null, speedMode: null, reasoningEffort: null }
    }
  },
  expected: {
    expectedRevision: 8,
    draft: {
      mcpServers: [
        { id: 'none', name: 'No auth', enabled: true, transport: 'streamable_http', url: 'https://none.example.test', timeoutMs: 30000,
          auth: { kind: 'none', secretAction: 'remove' } },
        { id: 'configured', name: 'Configured bearer', enabled: true, transport: 'streamable_http', url: 'https://configured.example.test', timeoutMs: 30000,
          auth: { kind: 'bearer', secretAction: 'keep' } },
        { id: 'replacement', name: 'New bearer', enabled: true, transport: 'streamable_http', url: 'https://replacement.example.test', timeoutMs: 30000,
          auth: { kind: 'bearer', secretAction: 'replace', secret: 'fixture-replacement' } }
      ],
      inference: { modelId: null, speedMode: null, reasoningEffort: null }
    }
  }
});
