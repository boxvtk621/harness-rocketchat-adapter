import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

assert.match(process.env.COMPOSE_PROJECT_NAME ?? '', /^hl307-/);
assert.equal(process.env.ACCEPTANCE_ISOLATED, 'true');
const base = process.env.BASE_URL;
const out = process.env.OUTPUT_DIR;
await mkdir(out, { recursive: true });
const password = (await readFile(process.env.DEV_USER_PASSWORD_FILE, 'utf8')).trim();
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const nodeId = id(1), dialogId = id(2), requestId = id(3), attemptId = id(4), toolId = id(5);
const now = '2026-09-21T16:00:00Z';
const safe = (content, truncated = false) => ({ kind: 'inline', content, redaction: 'none', truncated });
const node = { connectionId: 'fixture', name: 'Тестовый Harness · UI fixture', configEpoch: 1, identityStatus: 'unique', observation: {
  nodeId, ready: true, attemptedAt: now, successfulAt: now, httpReachable: true, executorHealthy: true, heartbeatFresh: true, heartbeatAt: now, bootId: id(9), compatibility: 'compatible', availability: 'available', occupancy: 'idle'
} };
let dialog = { dialogId, version: 41, title: 'Проверка workspace и инструментов · fixture', createdAt: now, lastActivityAt: now, state: 'completed' };
const request = { requestId, dialogId, inputMessageId: id(100), queueSequence: 1, version: 2, status: 'completed' };
const attempt = { attemptId, dialogId, requestId, generation: 1, version: 2, state: 'completed', effectStatus: 'known', startedAt: now, finishedAt: now };
const messages = Array.from({ length: 80 }, (_, index) => index % 2 === 0 ? {
  messageId: id(100 + index), role: 'user', dialogId, sequence: index + 1, version: 1, createdAt: now, text: `Сообщение ${index + 1}: прочитай тестовый файл и объясни результат.`, disposition: 'applied', commandId: id(300 + index), requestId
} : {
  messageId: id(100 + index), role: 'assistant', dialogId, sequence: index + 1, version: 1, createdAt: now, attemptId,
  content: safe(index === 79 ? 'Прочитан безопасный тестовый файл.\n```text\nHL-307 fixture content\n```\n<script>window.hacked=true</script>' : `Ответ ${index + 1}. Результат сохранён и доступен после перезагрузки.\nПроверка относится к контролируемой UI fixture.`), finishReason: 'complete'
});
const summary = { toolCallId: toolId, toolName: 'read_test_file', state: 'succeeded', startedAt: now, finishedAt: now, detailVersion: 3 };
const failedTool = { toolCallId: id(6), toolName: 'fixture_failure', state: 'failed', startedAt: now, finishedAt: now, detailVersion: 4 };
const envelope = { protocolVersion: 1, schemaId: 'harness-wire-v2', nodeId, epoch: 1, snapshotStateVersion: 90, stateVersion: 90, lastEventSeq: 90 };
const pageDto = (items, pageType, extra = {}) => ({ ...envelope, items, nextCursor: null, pageType, ...extra });
const canonical = x => x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
const commandStatuses = new Map();
let posts = 0, historyError = false, receiptReadable = false, detailFetches = 0, historyFetches = 0;
const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP localhost host.docker.internal'] });
const context = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
await context.addInitScript(() => {
  const NativeWebSocket = window.WebSocket;
  const sockets = [];
  function CapturedWebSocket(...args) { const socket = new NativeWebSocket(...args); sockets.push(socket); return socket; }
  CapturedWebSocket.prototype = NativeWebSocket.prototype;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) CapturedWebSocket[key] = NativeWebSocket[key];
  Object.defineProperty(window, 'WebSocket', { value: CapturedWebSocket });
  Object.defineProperty(window, '__dialogSockets', { value: sockets });
});
const page = await context.newPage();
const runtimeErrors = [];
page.on('pageerror', error => runtimeErrors.push(error.message));
await page.route('**/api/projections/nodes', route => route.fulfill({ json: [node] }));
await page.route('**/api/dialogs/**', async route => {
  const url = new URL(route.request().url());
  const path = url.pathname.split(`/nodes/${nodeId}/`)[1];
  const json = data => route.fulfill({ json: data });
  const error = (status, code) => route.fulfill({ status, json: { code } });
  if (path === 'identity') return json({ ...envelope, schemaSHA256: '0'.repeat(64), registryVersion: 1, identityEpoch: 1, adapter: { kind: 'fixture', version: '1' }, capabilities: { chat: 'verified', tool_results: 'verified' } });
  if (path === 'snapshot') return json({ ...envelope, capturedAt: now, completeness: 'complete', node: { transportAvailability: 'online', engineReadiness: node.observation.ready ? 'ready' : 'blocked', occupancy: 'idle', queuePaused: false, queueVersion: 1, pendingCount: 0, blockedReasons: node.observation.ready ? [] : ['auth_unavailable'], activeAttemptId: null }, pendingQueue: [], activeAttempt: null });
  if (path === 'dialogs') return json(pageDto([dialog], 'dialogs', { schemaId: 'dialog-view-v1' }));
  if (path === `dialogs/${dialogId}`) return json({ ...envelope, schemaId: 'dialog-view-v1', dialog });
  if (path === `dialogs/${dialogId}/history`) {
    historyFetches++;
    if (historyError) return error(503, 'read_unavailable');
    const end = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : messages.length;
    const start = Math.max(0, end - Number(url.searchParams.get('limit') ?? 30));
    return json(pageDto(messages.slice(start, end), 'history', { dialogId, nextCursor: start ? String(start) : null }));
  }
  if (path === 'requests') return json(pageDto([request], 'requests'));
  if (path === 'attempts') return json(pageDto([attempt], 'attempts', { dialogId, requestId }));
  if (path === `attempts/${attemptId}`) return json({ ...envelope, attempt });
  if (path === `attempts/${attemptId}/tool-calls`) return json(pageDto([summary, failedTool], 'tool_calls', { schemaId: 'tool-timeline-v1', dialogId, requestId, attemptId }));
  if (path?.startsWith(`attempts/${attemptId}/tool-calls/`)) {
    detailFetches++;
    const selected = path.endsWith(toolId) ? summary : failedTool;
    const later = url.searchParams.has('after');
    return json({ ...envelope, schemaId: 'tool-timeline-v1', dialogId, requestId, attemptId, toolCall: {
      ...selected, input: safe('{"path":"/workspace/hl307-test.txt"}'),
      result: selected.state === 'failed' ? { kind: 'unavailable', reason: 'unmapped', redaction: 'unknown', truncated: false } : safe('HL-307 fixture content', true),
      outputs: [{ index: later ? 2 : 1, stream: 'stdout', content: safe(later ? 'Последняя часть результата' : 'Начало большого результата\n' + 'Безопасная строка тестового вывода.\n'.repeat(12)), observedAt: now }], nextOutputCursor: later ? null : '1'
    } });
  }
  if (path === 'commands' && route.request().method() === 'POST') {
    posts++;
    const body = route.request().postDataJSON();
    assert.ok(route.request().headers()['x-harness-expected-identity-epoch']);
    const receipt = { ...envelope, commandId: body.commandId, commandKind: body.kind, receiptId: id(800 + posts), acceptedAt: now, eventSeq: 100 + posts, result: 'admitted', references: { dialogId, messageId: id(850 + posts), requestId: id(900 + posts) } };
    commandStatuses.set(body.commandId, { ...envelope, commandId: body.commandId, canonicalPayloadHash: createHash('sha256').update(canonical(body)).digest('hex'), status: 'accepted', receipt });
    if (body.kind === 'message.enqueue') {
      messages.push({ messageId: receipt.references.messageId, role: 'user', dialogId, sequence: messages.length + 1, version: 1, createdAt: now, text: body.payload.text, disposition: 'queued', commandId: body.commandId, requestId: receipt.references.requestId });
      dialog = { ...dialog, version: dialog.version + 1, state: 'queued' };
    }
    return route.fulfill({ status: 504, json: { code: 'upstream_timeout' } }); // Persisted acceptance followed by generic proxy timeout, controlled fixture.
  }
  if (path?.startsWith('commands/')) {
    if (!receiptReadable) return error(503, 'read_unavailable');
    const result = commandStatuses.get(path.split('/')[1]);
    return result ? json(result) : error(404, 'not_found');
  }
  return error(404, 'not_found');
});
async function poll(fn, label) {
  const end = Date.now() + 20000;
  while (true) { try { return await fn(); } catch (error) { if (Date.now() > end) throw new Error(`${label}: ${error.message}`); await page.waitForTimeout(100); } }
}
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.locator('#username').fill('operator'); await page.locator('#password').fill(password); await page.locator('#kc-login').click();
  await page.getByTestId('screen-work').waitFor({ timeout: 45000 });
  await page.getByTestId('nav-dialogs').click();
  await page.getByTestId(`tool-call-${toolId}`).waitFor();
  assert.equal(detailFetches, 0, 'Tool details must load lazily');
  await page.getByTestId(`tool-call-${toolId}`).click();
  await page.getByTestId('tool-details').waitFor();
  await page.getByTestId('tool-details').getByText('Поток вывода', { exact: false }).click();
  await page.getByRole('button', { name: 'Загрузить ещё вывод', exact: true }).click();
  await poll(async () => assert.ok((await page.getByTestId('tool-details').innerText()).includes('Последняя часть результата')), 'Bounded tool output continuation');
  const composerBox = await page.getByTestId('message-input').boundingBox();
  assert.ok(composerBox && composerBox.y + composerBox.height <= 1440, 'Composer remains in QHD viewport');
  assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), 'Desktop workspace scrolls internally');
  assert.equal(await page.evaluate(() => window.hacked), undefined);
  assert.equal(await page.locator('app-dialogs script').count(), 0);
  await page.getByTestId('message-input').fill('Черновик остаётся при ошибке');
  historyError = true;
  await page.getByTestId('refresh-current').click();
  await poll(async () => assert.ok(await page.locator('.read-error').isVisible()), 'Read failure visible');
  assert.ok(await page.locator('[data-testid^="message-"]').count() > 0);
  assert.equal(await page.getByTestId('message-input').inputValue(), 'Черновик остаётся при ошибке');
  historyError = false;
  await page.getByTestId('refresh-current').click();
  await poll(async () => assert.equal(await page.locator('.read-error').count(), 0), 'Read recovery');
  const scroller = page.getByTestId('messages-scroll');
  await scroller.evaluate(el => { el.scrollTop = 0; });
  const before = await page.locator('article.message').first().getAttribute('data-testid');
  await page.getByTestId('load-older-messages').click();
  await poll(async () => assert.ok(await page.locator('article.message').count() > 30), 'Older page');
  assert.ok(await page.getByTestId(before).count());
  await poll(async () => assert.ok(await scroller.evaluate(el => el.scrollTop) > 0), 'Older load must retain visual anchor');
  await scroller.evaluate(el => { el.style.scrollBehavior = 'auto'; el.scrollTop = el.scrollHeight; });
  await page.getByTestId(`tool-call-${toolId}`).click();
  await page.getByTestId('tool-details').waitFor();
  await page.screenshot({ path: join(out, 'dialogs-fixture-qhd.png'), fullPage: true });
  await page.getByTestId('message-input').focus();
  assert.notEqual(await page.getByTestId('message-input').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
  await page.keyboard.press('Enter');
  assert.equal(posts, 0, 'Enter adds a line, not a command');
  await page.getByTestId('message-input').fill('LOST_ACK_fixture_text_must_not_be_in_storage');
  await page.keyboard.press('Control+Enter');
  await page.locator('[data-testid^="pending-command-"]').waitFor();
  assert.equal(posts, 1);
  const storage = await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('hl307:pending:')).map(k => sessionStorage.getItem(k)).join(''));
  assert.ok(!storage.includes('LOST_ACK_fixture_text'));
  assert.ok(!storage.includes('access_token'));
  receiptReadable = true;
  await page.reload();
  await page.getByTestId('nav-dialogs').click();
  await page.getByTestId('screen-dialogs').waitFor();
  const reconcile = page.getByTestId('reconcile-command');
  if (await reconcile.count()) await reconcile.click();
  await poll(async () => assert.equal(await page.locator('[data-testid^="pending-command-"]').count(), 0), 'Reload reconciles exact receipt');
  assert.equal(posts, 1, 'Reload/readback must never resubmit');
  await poll(async () => { const box = await page.getByTestId('message-input').boundingBox(); assert.ok(box && box.y + box.height <= 1440); }, 'Composer remains visible with action notices');
  await page.getByTestId('messages-scroll').evaluate(el => { el.style.scrollBehavior = 'auto'; el.scrollTop = 0; });
  for (let i = 0; i < 60; i++) messages.push({ ...messages[0], messageId: id(1000 + i), sequence: messages.length + 1, text: `Позднее сообщение ${i + 1}`, commandId: id(1100 + i) });
  await page.getByTestId('refresh-current').click();
  await page.getByTestId(`message-${id(1059)}`).waitFor();
  await poll(async () => assert.ok(await page.getByRole('button', { name: /Новые сообщения:/ }).isVisible()), 'New-message indicator without forced scroll');
  assert.ok(await page.getByTestId('messages-scroll').evaluate(el => el.scrollTop < el.scrollHeight - el.clientHeight - 40));
  await page.getByTestId('load-older-messages').click();
  await page.getByTestId(`message-${id(1000)}`).waitFor();
  const messageIds = await page.locator('article.message').evaluateAll(items => items.map(item => item.dataset.testid));
  assert.equal(new Set(messageIds).size, messageIds.length, 'Catch-up pages deduplicate retained history');
  const beforeReconnect = historyFetches;
  await poll(async () => assert.ok(await page.evaluate(() => window.__dialogSockets.some(socket => socket.readyState === WebSocket.OPEN))), 'Realtime socket connected');
  const socketsBeforeReconnect = await page.evaluate(() => window.__dialogSockets.length);
  await page.evaluate(() => window.__dialogSockets.find(socket => socket.readyState === WebSocket.OPEN).close(4000, 'HL307 acceptance reconnect'));
  await poll(async () => assert.ok(await page.evaluate(count => window.__dialogSockets.slice(count).some(socket => socket.readyState === WebSocket.OPEN), socketsBeforeReconnect)), 'New realtime socket connected');
  await poll(async () => assert.ok(historyFetches > beforeReconnect), 'Realtime reconnect refetches persisted history');
  assert.equal(posts, 1, 'Realtime reconnect never submits a command');
  assert.ok(await page.getByTestId(`message-${id(1000)}`).count(), 'Reconnect retains older loaded history');
  await page.getByTestId(`tool-call-${toolId}`).click();
  await page.getByTestId('tool-details').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: join(out, 'dialogs-fixture-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1440);
  await page.screenshot({ path: join(out, 'dialogs-fixture-laptop.png'), fullPage: true });
  node.observation.ready = false;
  node.observation.engineReadiness = 'blocked';
  node.observation.blockedReasons = ['auth_unavailable'];
  await page.reload();
  await page.getByTestId('nav-dialogs').click();
  await page.getByTestId('message-input').waitFor();
  await page.getByTestId('message-input').fill('Недоступная нода не должна принять сообщение');
  assert.ok(await page.getByTestId('send-message').isDisabled());
  assert.ok(await page.getByTestId('create-dialog').isDisabled());
  assert.ok(await page.locator('article.message').count() > 0, 'Persisted history remains readable without provider auth');
  assert.ok(await page.getByRole('button', { name: 'Настройки ноды', exact: true }).count() > 0);
  assert.ok((await page.locator('app-dialogs').innerText()).includes('требуется авторизация провайдера'));
  assert.equal(posts, 1);
  await page.screenshot({ path: join(out, 'dialogs-fixture-auth-blocked.png'), fullPage: true });
  await page.getByTestId('nav-work').click();
  await poll(async () => assert.equal(await page.locator('app-dialogs').isVisible(), false), 'Hidden dialogs must not leak into other screens');
  assert.deepEqual(runtimeErrors, []);
  await writeFile(join(out, 'dialogs-ui-evidence.json'), JSON.stringify({ mode: 'controlled public API DTO fixtures; not provider execution', posts, detailFetches, historyFetches, providerCalls: 0, checks: ['safe code/text', 'lazy details', 'retained data/draft', 'older-page anchor', '60-message catch-up and no forced scroll', 'blocked auth preserves history', 'tool output continuation', 'keyboard', 'pending IDs only', 'reload receipt no replay', 'QHD/390/laptop'] }, null, 2));
  console.log('PASS controlled UI fixtures: lazy tools, safe output, pagination anchor, retained errors/draft, keyboard, lost ACK/reload readback without replay, responsive screenshots.');
} catch (error) {
  await page.screenshot({ path: join(out, 'dialogs-ui-failure.png'), fullPage: true }).catch(() => {});
  console.error(error.message);
  throw error;
} finally { await browser.close(); }
