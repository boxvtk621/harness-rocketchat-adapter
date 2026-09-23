// Run in the client build image, with /src pointing to the current client source.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire('/app/package.json');
const { buildSync } = require('esbuild');
buildSync({ entryPoints: ['/src/src/app/dialogs/dialogs.component.ts'], outfile: '/app/recovery-component.mjs',
  bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: '/src/tsconfig.json' });
await import(pathToFileURL(require.resolve('@angular/compiler')));
const { DialogsComponent } = await import('/app/recovery-component.mjs');
const values = new Map();
globalThis.sessionStorage = { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key) ?? null };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function component() {
  const c = new DialogsComponent({}); c.sessionKey = 'old'; c.lastSessionKey = 'old';
  c.dialogs.set([{ nodeId: 'node', dialogId: 'dialog', connectionId: 'fixture', configEpoch: 1 }]); c.selectedDialogId.set('node:dialog');
  c.identities.set({ fixture: { adapter: { kind: 'codex', version: '1' }, registryVersion: 1, identityEpoch: 1 } });
  c.canWriteSelected = () => true; c.refreshSelectedDialog = async () => {}; c.loadDialogs = async () => {};
  return c;
}
function changeSession(c) { c.sessionKey = 'new'; c.ngOnChanges({ sessionKey: {} }); }
const base = { commandId: 'command', kind: 'attempt.retry', connectionId: 'fixture', nodeId: 'node', configEpoch: 1,
  registryVersion: 1, identityEpoch: 1, adapterKind: 'codex', adapterVersion: '1', dialogId: 'dialog', priorAttemptId: 'attempt' };
{
  const c = component(), hash = deferred(); c.sha256 = () => hash.promise; c.intentHash = async () => 'intent';
  const pending = c.retainPending({}, base); changeSession(c); hash.resolve('hash');
  await assert.rejects(pending, /session changed/); assert.equal(values.size, 0); assert.deepEqual(c.pendingCommands(), []);
}
for (const reject of [false, true]) {
  values.clear(); const c = component(), post = deferred();
  c.retryTail = () => [{ messageId: 'message' }]; c.latestAttempt = () => ({ attemptId: 'attempt', generation: 1 });
  c.post = () => post.promise;
  const run = c.retryMessages(true);
  while (!c.pendingCommands().length) await new Promise(resolve => setTimeout(resolve, 1));
  changeSession(c); c.actionError.set('new-session'); c.retryProgress.set('new-progress'); c.retrying.set(true);
  if (reject) post.reject(new Error('late rejection')); else post.resolve({});
  await run;
  assert.equal(c.actionError(), 'new-session'); assert.equal(c.retryProgress(), 'new-progress'); assert.equal(c.retrying(), true);
  assert.deepEqual(c.pendingCommands(), []); assert.equal(values.has('hl307:pending:new'), false);
  assert.equal(JSON.parse(values.get('hl307:pending:old')).length, 1);
}
{
  const c = component(); let queued = [];
  c.messages.set([{ role: 'user', messageId: 'message', requestId: 'request' }]);
  c.requests.set([{ requestId: 'request', inputMessageId: 'message', status: 'failed' }]);
  c.activityRequestStates.set('request', 'active'); c.activityRequestsLoaded.add('request');
  c.enqueueActivityRequest = (id, refresh) => queued.push([id, refresh]); c.pumpActivityQueue = () => {};
  c.queueVisibleActivities(c.messages(), c.selectedDialog(), true); assert.deepEqual(queued, [['request', true]]);
}
for (const capped of [false, true]) {
  const c = component(); let calls = 0;
  const attempt = { attemptId: 'attempt', generation: 1, state: 'failed', effectStatus: 'none' };
  c.get = async (_path, _epoch, query) => { calls++; assert.equal(query.after, (calls - 1) * 100); return {
    items: calls === 2 ? [{ ...attempt, seq: 101, errorCode: 'codex_model_unsupported', safeMessage: 'model unavailable' }] : [],
    nextCursor: !capped && calls === 2 ? null : String(calls * 100)
  }; };
  await c.readAttemptFailure(c.selectedDialog(), attempt, c.activityGeneration);
  assert.equal(calls, capped ? 5 : 2); assert.equal(c.completeDiagnostics.has('attempt'), !capped);
  assert.equal(c.attemptFailures().attempt.errorCode, capped ? 'diagnostics_incomplete' : 'codex_model_unsupported');
}
{
  const c = component(), diagnostic = deferred(); let finished = false;
  c.get = async () => ({ items: [{ attemptId: 'attempt', state: 'failed' }], nextCursor: null });
  c.readAttemptFailure = () => diagnostic.promise;
  const read = c.readRequestActivities('request').then(() => finished = true);
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(finished, false);
  diagnostic.resolve(); await read; assert.equal(finished, true);
}
{
  const c = component();
  c.messages.set([1, 2].map(i => ({ role: 'user', messageId: `message${i}`, requestId: `request${i}` })));
  c.requests.set([1, 2].map(i => ({ requestId: `request${i}`, inputMessageId: `message${i}`, status: 'failed', queueSequence: i })));
  const old = Array.from({ length: 99 }, (_, i) => ({ attemptId: `old${i}`, generation: i + 1, state: 'failed', effectStatus: 'none', startedAt: 'now' }));
  const recent = [0, 1].map(i => ({ attemptId: `recent${i}`, generation: i + 1, state: 'failed', effectStatus: 'none', startedAt: 'now' }));
  c.messageAttempts.set({ request1: old, request2: recent });
  c.activityRequestsLoaded.add('request1'); c.activityRequestsLoaded.add('request2');
  for (const attempt of [...old, ...recent]) {
    c.completeDiagnostics.add(attempt.attemptId);
    c.attemptFailures.update(all => ({ ...all, [attempt.attemptId]: { errorCode: 'codex_model_unsupported' } }));
  }
  assert.equal(c.retryTail().length, 1, 'All historical generations count against native proof limit');
  assert.match(c.retryBoundExplanation(), /100/);
  c.messageAttempts.set({ request1: old.slice(1), request2: recent });
  assert.equal(c.retryTail().length, 2, 'Exactly 100 proven attempts supported');
  c.completeDiagnostics.delete('old1'); assert.equal(c.retryTail().length, 1, 'Await all historical diagnostic pages');
  c.activityRequestsLoaded.delete('request2'); assert.equal(c.retryTail().length, 0, 'Await complete request attempts');
}
{
  const c = component(); c.accessToken = 'fixture'; let nextCursor = 'page-two';
  delete c.loadDialogs;
  c.nodeContexts = () => [{ nodeId: 'node', connectionId: 'fixture', configEpoch: 1 }];
  c.selectDialog = async () => {};
  c.get = async path => path.endsWith('/dialogs') ? { items: [{ dialogId: 'first-page', state: 'completed' }], nextCursor }
    : path.endsWith('/snapshot') ? { pendingQueue: [], activeAttempt: null } : { adapter: { kind: 'codex' } };
  await c.loadDialogs(true);
  assert.equal(c.selectedDialog()?.dialogId, 'dialog', 'First-page refresh must retain the selected later-page conversation');
  assert.equal(c.dialogs().length, 2);
  nextCursor = null; await c.loadDialogs(true);
  assert.equal(c.selectedDialog(), null, 'A complete refreshed list can remove an absent dialog');
}
console.log('PASS recovery component: session boundaries, terminal cache, diagnostics, quota, proof bound, paginated selected-dialog retention');
