import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

assert.equal(process.env.ACCEPTANCE_ISOLATED, 'true');
const base = process.env.BASE_URL;
const out = process.env.OUTPUT_DIR;
await mkdir(out, { recursive: true });
const id = n => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;
const nodeId = id(1), dialogId = id(2), at = '2026-09-23T00:00:00Z';
const node = { connectionId: 'fixture', name: 'Codex recovery fixture', configEpoch: 1, identityStatus: 'unique', observation: {
  nodeId, ready: true, httpReachable: true, executorHealthy: true, heartbeatFresh: true, compatibility: 'compatible', availability: 'available', occupancy: 'idle' } };
const env = { protocolVersion: 1, schemaId: 'harness-wire-v2', nodeId, epoch: 1, snapshotStateVersion: 20, lastEventSeq: 20 };
const pageDto = (items, pageType, extra = {}) => ({ ...env, items, pageType, nextCursor: null, ...extra });
let requests, attempts, messages, posts, mode, kind, held, receipts, receiptAvailable, eventMode;
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
function reset(nextMode = 'success') {
  mode = nextMode; kind = 'codex'; posts = []; held = null;
  receipts = new Map(); receiptAvailable = false; eventMode = '';
  messages = [1, 2, 3].map(i => ({ messageId: id(100 + i), role: 'user', dialogId, sequence: i, version: 1, createdAt: at,
    text: `Оригинальное сообщение ${i}`, disposition: 'applied', commandId: id(200 + i), requestId: id(300 + i) }));
  requests = messages.map((m, i) => ({ requestId: m.requestId, dialogId, inputMessageId: m.messageId, queueSequence: i + 1, version: 1, status: 'failed' }));
  attempts = requests.map((r, i) => ({ attemptId: id(400 + i), dialogId, requestId: r.requestId, generation: 1, version: 3, state: 'failed', effectStatus: 'none', startedAt: at, finishedAt: at }));
}
reset();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(() => sessionStorage.setItem('oidc.user:http://localhost:18180/realms/harness:harness-web', JSON.stringify({
  access_token: 'fixture', token_type: 'Bearer', profile: { sub: 'fixture', name: 'Fixture' }, expires_at: Math.floor(Date.now() / 1000) + 3600 })));
const page = await context.newPage();
const runtimeErrors = []; page.on('pageerror', error => runtimeErrors.push(error.message));
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  const json = data => route.fulfill({ json: data });
  if (url.pathname === '/api/session') return json({ canManageConnections: true });
  if (url.pathname === '/api/projections/nodes') return json([node]);
  if (url.pathname === '/api/connections') return json([{ id: 'fixture', name: node.name, configEpoch: 1, observation: node.observation }]);
  if (url.pathname.startsWith('/api/projections/')) return json([]);
  if (url.pathname === '/api/realtime/token') return route.fulfill({ status: 503, json: { code: 'fixture_offline' } });
  const path = url.pathname.split(`/nodes/${nodeId}/`)[1];
  if (path === 'identity') return json({ ...env, registryVersion: 1, identityEpoch: 1, adapter: { kind, version: 'fixture' } });
  if (path === 'snapshot') return json({ ...env, stateVersion: 20, node: { transportAvailability: 'online', engineReadiness: 'ready', occupancy: 'idle', queuePaused: false, pendingCount: 0, blockedReasons: [] }, pendingQueue: [], activeAttempt: null });
  if (path === 'dialogs') return json(pageDto([{ dialogId, version: 4, title: 'Восстановление сообщений', createdAt: at, lastActivityAt: at, state: 'failed' }], 'dialogs'));
  if (path === `dialogs/${dialogId}/history`) return json(pageDto(messages, 'history', { dialogId }));
  if (path === 'requests') return json(pageDto(requests, 'requests'));
  if (path === 'attempts') return json(pageDto(attempts.filter(a => a.requestId === url.searchParams.get('requestId')), 'attempts', { requestId: url.searchParams.get('requestId') }));
  const match = /^attempts\/([^/]+)(?:\/(.*))?$/.exec(path ?? '');
  if (match) {
    const attempt = attempts.find(a => a.attemptId === match[1]);
    if (!attempt) return route.fulfill({ status: 404, json: { code: 'not_found' } });
    if (match[2] === 'events') {
      const after = Number(url.searchParams.get('after') ?? 0);
      return json(pageDto(eventMode && after === 0 ? [] : [{ seq: after + 20, attemptId: attempt.attemptId, generation: attempt.generation, type: 'attempt.failed', effectStatus: attempt.effectStatus,
        errorCode: 'codex_model_unsupported', safeMessage: 'Модель Codex недоступна для этой учётной записи. Выберите доступную модель и повторите сообщение.' }], 'events',
        { nextCursor: eventMode === 'cap' || eventMode === 'later' && after === 0 ? String(after + 100) : null }));
    }
    if (match[2] === 'tool-calls') return json(pageDto([], 'tool_calls', { dialogId, attemptId: attempt.attemptId, requestId: attempt.requestId }));
    return json({ ...env, attempt });
  }
  if (path?.startsWith('commands/') && receiptAvailable && receipts.has(path.slice(9))) return json(receipts.get(path.slice(9)));
  if (path === 'commands' && route.request().method() === 'POST') {
    const command = route.request().postDataJSON(); posts.push(command);
    assert.equal(command.kind, 'attempt.retry'); assert.deepEqual(command.payload, { acknowledgeKnownEffects: false });
    assert.equal(route.request().headers()['x-harness-expected-node-id'], nodeId);
    if (mode === 'partial' && posts.length === 2) return route.fulfill({ status: 409, json: { code: 'stale' } });
    if (mode === 'unknown') return route.abort('failed');
    if (mode === 'held') await new Promise(resolve => { held = resolve; });
    const prior = attempts.find(a => a.attemptId === command.target.attemptId);
    const original = requests.find(r => r.requestId === prior.requestId);
    const requestId = id(500 + posts.length);
    requests.push({ ...original, requestId, queueSequence: 10 + posts.length, status: 'queued' });
    const receipt = { commandId: command.commandId, commandKind: 'attempt.retry', receiptId: id(700 + posts.length), nodeId, eventSeq: 21, result: 'admitted', acceptedAt: at,
      references: { priorAttemptId: mode === 'wrong-prior' ? id(999) : prior.attemptId, requestId } };
    receipts.set(command.commandId, { canonicalPayloadHash: createHash('sha256').update(canonical(command)).digest('hex'), receipt });
    if (mode === 'receipt-later') return route.abort('failed');
    return json(receipt);
  }
  return route.fulfill({ status: 404, json: { code: 'not_found' } });
});
async function open() { await page.goto(base); await page.getByTestId('nav-dialogs').click(); await page.getByTestId('message-input').waitFor(); }
async function poll(check) { for (let i=0;i<100;i++) { try { await check(); return; } catch { await page.waitForTimeout(50); } } await check(); }
async function refresh() { await page.getByTestId('refresh-current').click(); await page.waitForTimeout(500); }
async function advanceRetries(state) {
  for (const [i, command] of posts.entries()) {
    const request = requests.find(r => r.requestId === id(501 + i)); if (!request) continue;
    request.status = state === 'running' ? 'active' : state;
    let attempt = attempts.find(a => a.requestId === request.requestId);
    if (!attempt) { const prior = attempts.find(a => a.attemptId === command.target.attemptId); attempt = { ...prior, attemptId: id(601 + i), requestId: request.requestId, generation: prior.generation + 1 }; attempts.push(attempt); }
    attempt.state = state; attempt.version++;
  }
  await refresh();
}
try {
  await open();
  await page.getByTestId('retry-series').waitFor();
  assert.equal(await page.locator('.failed-message').count(), 3);
  assert.equal(await page.locator('article.message header').filter({ hasText: 'Ошибка' }).count(), 3);
  await page.screenshot({ path: join(out, 'hl318-failed-tail.png'), fullPage: true });
  await page.getByTestId('retry-series').click();
  await poll(() => assert.equal(posts.length, 3));
  assert.deepEqual(posts.map(p => p.target.attemptId), [id(400),id(401),id(402)]);
  assert.equal(requests.filter(r => r.status === 'queued').length, 3);
  await advanceRetries('running'); await advanceRetries('completed');
  await poll(async () => assert.equal(await page.locator('.failed-message').count(), 0));
  assert.equal(await page.locator('article.message').count(), 3);
  await page.getByTestId(`message-${id(101)}`).getByRole('button', { name: 'Выполнение', exact: true }).click();
  await poll(async () => assert.equal(await page.locator('.message-execution-detail option').count(), 2));
  assert.equal(new Set(requests.map(r=>r.requestId)).size,6,'Retries use distinct request IDs');
  reset(); requests[2].status = 'queued'; const queuedAttempt = attempts.pop(); await open();
  await poll(async () => assert.equal(await page.getByTestId('retry-message').count(), 0));
  requests[2].status = 'active'; queuedAttempt.state = 'running'; attempts.push(queuedAttempt); await refresh();
  requests[2].status = 'failed'; queuedAttempt.state = 'failed'; queuedAttempt.version++; await refresh();
  await page.getByTestId('retry-series').waitFor();
  reset(); eventMode = 'later'; await open(); await page.getByTestId('retry-series').waitFor();
  reset(); eventMode = 'cap'; await open();
  await poll(async () => assert.match(await page.locator('app-dialogs').innerText(), /Диагностика неполная/)); assert.equal(await page.getByTestId('retry-series').count(), 0);
  reset('receipt-later'); await open(); await page.getByTestId('retry-series').click();
  await poll(async () => assert.match(await page.locator('app-dialogs').innerText(), /Исход остаётся неизвестным/));
  receiptAvailable = true; await page.reload(); await page.getByTestId('nav-dialogs').click(); await page.getByTestId('reconcile-command').click();
  await poll(async () => assert.equal(await page.getByTestId('reconcile-command').count(), 0)); assert.equal(posts.length, 1);
  reset('wrong-prior'); await open(); await page.getByTestId('retry-series').click();
  await poll(async () => assert.match(await page.locator('app-dialogs').innerText(), /квитанцию для другой команды/)); assert.equal(posts.length, 1);
  await page.evaluate(() => { for (const key of Object.keys(sessionStorage)) if (key.startsWith('hl307:pending:')) sessionStorage.removeItem(key); });
  reset('partial'); await open(); await page.getByTestId('retry-series').waitFor(); await page.getByTestId('retry-series').click();
  await poll(async () => assert.match(await page.locator('.retry-progress').innerText(), /1 из 3/)); assert.equal(posts.length,2);
  reset('unknown'); await open(); await page.getByTestId('retry-series').waitFor(); await page.getByTestId('retry-series').click();
  await poll(async () => assert.match(await page.locator('app-dialogs').innerText(), /Исход остаётся неизвестным/)); assert.equal(posts.length,1);
  await page.reload(); await page.getByTestId('nav-dialogs').click(); await page.getByTestId('message-input').waitFor(); assert.equal(posts.length,1);
  await page.evaluate(() => { for (const key of Object.keys(sessionStorage)) if (key.startsWith('hl307:pending:')) sessionStorage.removeItem(key); });
  reset(); attempts[2].effectStatus='unknown'; await open();
  await poll(async () => assert.match(await page.locator('app-dialogs').innerText(), /требуется сверка состояния/)); assert.equal(await page.getByTestId('retry-message').count(),0);
  reset(); kind='cursor'; await open(); await page.getByTestId('retry-message').waitFor(); assert.equal(await page.getByTestId('retry-series').count(),0);
  reset('held'); await open(); await page.getByTestId('retry-series').waitFor();
  await page.getByTestId('retry-series').dblclick(); await poll(()=>assert.ok(held)); assert.equal(posts.length,1,'Double click reserves only one command');
  // A refetch changes the selection generation; a late receipt may reconcile
  // the first command but cannot continue the captured series.
  await page.reload(); held(); await page.getByTestId('nav-dialogs').click(); await page.getByTestId('message-input').waitFor();
  await page.waitForTimeout(200); assert.equal(posts.length,1);
  assert.deepEqual(runtimeErrors,[]);
  const checks = ['historical failure highlighting','three distinct retry requests ordered oldest first','queued-running-completed retry readback','all generations retained',
    'queued-running-failed original cache refresh','later-page terminal diagnostic','diagnostic cap disables backward replay','receipt reconciliation after reload',
    'wrong priorAttemptId receipt rejected','partial conflict stops series','transport uncertainty receipt and no reload replay','uncertain effects excluded',
    'Cursor backward retry explained','double click and stale response fenced'];
  await writeFile(join(out,'hl318-recovery-ui.json'),JSON.stringify({providerCalls:0,checks},null,2));
  console.log(`PASS failed-message recovery UI: ${checks.length} controlled checks, zero provider calls`);
} finally { await browser.close(); }
