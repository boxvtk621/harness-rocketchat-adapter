import assert from 'node:assert/strict';
import { buildNodeSettingsPutPayload } from '../../src/Client/src/app/node-settings-contract.ts';
import { nodeSettingsPutFixture } from './node-settings-fixture.mjs';

const actual = buildNodeSettingsPutPayload(
  nodeSettingsPutFixture.input.expectedRevision,
  nodeSettingsPutFixture.input.draft
);
const servers = actual.draft.mcpDocument.servers;
assert.equal(actual.expectedRevision, 8);
assert.equal(actual.draft.mcpDocument.schemaId, 'harness-mcp-document-v2');
assert.equal(servers[0].transport, 'streamable_http');
assert.equal(servers[3].transport, 'stdio', 'serializer must never force a transport');
assert.equal(JSON.stringify(actual).includes('bearerTokenConfigured'), false, 'GET-only status must not be sent');
assert.equal(JSON.stringify(actual).includes('configured'), true, 'stable server ID remains');
assert.equal(servers[0].auth.secretAction, 'remove');
assert.equal(servers[0].auth.secret, undefined);
assert.equal(servers[1].auth.secretAction, 'keep');
assert.equal(servers[1].auth.secret, undefined);
assert.equal(servers[2].auth.secret, 'fixture-replacement');
assert.deepEqual(servers[3].secretSlots, [{ slot: 'TOKEN', action: 'keep' }]);
assert.equal(nodeSettingsPutFixture.input.draft.mcpDocument.servers[1].auth.secret, 'discard-me', 'input remains untouched');

console.log('PASS V2 MCP transport and secret action serialization');
