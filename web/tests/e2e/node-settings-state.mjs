import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { nodeSettingsFixture, modelCatalogFixture } from './node-settings-fixture.mjs';

const require = createRequire('/app/package.json');
const { buildSync } = require('esbuild');
buildSync({
  entryPoints: ['/app/src/app/node-settings.component.ts'],
  outfile: '/app/node-settings-test.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: '/app/tsconfig.json'
});
await import(require.resolve('@angular/compiler'));
const { NodeSettingsComponent } = await import('/app/node-settings-test.mjs');

const saved = structuredClone(nodeSettingsFixture);
let writes = [];
let latest = structuredClone(saved);
const http = {
  get() { return { subscribe(observer) { observer.next(structuredClone(latest)); } }; },
  put(_url, body) {
    writes.push({ method: 'PUT', body });
    return { subscribe(observer) {
      latest = { ...structuredClone(latest), draftRevision: latest.draftRevision + 1, revision: (latest.revision || 0) + 1, draft: structuredClone(body.draft) };
      observer.next(structuredClone(latest));
    } };
  },
  post(_url, body) {
    writes.push({ method: 'POST', body });
    return { subscribe(observer) { observer.next({ ...structuredClone(latest),
      operation: { commandId: body.commandId, operationId: 'op', targetRevision: body.targetRevision, status: 'running', phase: 'draining' } }); } };
  }
};
const component = new NodeSettingsComponent(http);
component.nodeId = saved.nodeId;
component.connectionId = 'connection';
component.canManage = true;
component.accept(structuredClone(saved));
component.catalog.set(structuredClone(modelCatalogFixture));
assert.equal(component.hasUnsavedChanges(), false);

component.draft().inference.speedMode = 'on';
component.draft().inference.reasoningEffort = 'medium';
assert.equal(component.hasUnsavedChanges(), true, 'speed-only mutation is dirty with same model');
component.read();
assert.equal(component.draft().inference.speedMode, 'on', 'readback must preserve dirty mode');
component.apply();
assert.deepEqual(writes.map(item => item.method), ['PUT', 'POST']);
assert.equal(writes[0].body.draft.inference.modelId, 'fixture/model');
assert.equal(writes[0].body.draft.inference.speedMode, 'on');
assert.equal(writes[0].body.draft.inference.reasoningEffort, 'medium');
assert.equal(writes[1].body.targetRevision, saved.draftRevision + 1);

const dirty = new NodeSettingsComponent({ get: http.get, put() { throw Error('unexpected write'); } });
dirty.nodeId = saved.nodeId;
dirty.connectionId = 'connection';
dirty.sessionKey = 'user:session';
dirty.canManage = true;
dirty.accept(structuredClone(saved));
dirty.catalog.set(structuredClone(modelCatalogFixture));
dirty.mcpText = '{ invalid json';
dirty.apply();
assert.equal(dirty.mcpText, '{ invalid json');
assert.ok(dirty.jsonErrors().length, 'malformed JSON remains editable');
dirty.ngOnChanges({ accessToken: { firstChange: false } });
assert.equal(dirty.mcpText, '{ invalid json', 'token renewal preserves dirty JSON');

console.log('PASS mode-only apply, dirty readback, malformed JSON and token renewal');
