import assert from 'node:assert/strict';
import { buildNodeSettingsPutPayload } from '../../src/Client/src/app/node-settings-contract.ts';
import { nodeSettingsPutFixture } from './node-settings-fixture.mjs';

const actual = buildNodeSettingsPutPayload(
  nodeSettingsPutFixture.input.expectedRevision,
  nodeSettingsPutFixture.input.draft
);

assert.deepEqual(actual, nodeSettingsPutFixture.expected, 'PUT payload must contain only Harness input fields and exact secret actions.');
assert.equal(JSON.stringify(actual).includes('bearerTokenConfigured'), false, 'Output-only configured flags must never be sent.');
assert.equal(actual.draft.mcpServers[0].auth.secretAction, 'remove');
assert.equal(actual.draft.mcpServers[1].auth.secretAction, 'keep');
assert.equal(actual.draft.mcpServers[2].auth.secretAction, 'replace');
assert.equal(actual.draft.mcpServers[2].auth.secret, 'fixture-replacement');

console.log('node-settings PUT contract fixture: passed');
