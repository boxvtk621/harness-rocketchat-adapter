import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const standalone = process.env.UI_FIXTURE_ONLY === 'true';
assert.match(process.env.COMPOSE_PROJECT_NAME ?? '', standalone ? /^hl317-/ : /^hl307-/);
assert.equal(process.env.ACCEPTANCE_ISOLATED, 'true');
const base = process.env.BASE_URL;
const out = process.env.OUTPUT_DIR;
await mkdir(out, { recursive: true });
const password = standalone ? '' : (await readFile(process.env.DEV_USER_PASSWORD_FILE, 'utf8')).trim();
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const nodeId = id(1), dialogId = id(2), requestId = id(3), attemptId = id(4), toolId = id(5);
const requestId2 = id(13), attemptId2 = id(14), toolId2 = id(15);
const retryAttemptId = id(16), retryToolId = id(17);
const requestId3 = id(23), attemptId3 = id(24), toolId3 = id(25);
const deepDialogId = id(32), deepRequestId = id(33), deepDecoyRequestId = id(34), deepAttemptId = id(35), deepToolId = id(36);
const now = '2026-09-21T16:00:00Z';
const safe = (content, truncated = false) => ({ kind: 'inline', content, redaction: 'none', truncated });
const node = { connectionId: 'fixture', name: 'Тестовый Harness · UI fixture', configEpoch: 1, identityStatus: 'unique', observation: {
  nodeId, ready: true, attemptedAt: now, successfulAt: now, httpReachable: true, executorHealthy: true, heartbeatFresh: true, heartbeatAt: now, bootId: id(9), compatibility: 'compatible', availability: 'available', occupancy: 'idle'
} };
const connection = { id: 'fixture', name: node.name, baseUri: 'https://fixture-harness:8443/', configEpoch: 1, observationIntervalSeconds: 15, requestTimeoutSeconds: 5, staleThresholdSeconds: 45, observation: node.observation, createdAt: now, updatedAt: now, identityStatus: 'unique' };
let dialog = { dialogId, version: 41, title: 'Проверка workspace и инструментов · fixture', createdAt: now, lastActivityAt: now, state: 'active', activeRequestId: requestId3, activeAttemptId: attemptId3 };
const request = { requestId, dialogId, inputMessageId: id(100), queueSequence: 1, version: 2, status: 'completed' };
const attempt = { attemptId, dialogId, requestId, generation: 1, version: 2, state: 'completed', effectStatus: 'known', startedAt: now, finishedAt: now };
const request2 = { requestId: requestId2, dialogId, inputMessageId: id(178), queueSequence: 2, version: 2, status: 'completed' };
const request3 = { requestId: requestId3, dialogId, inputMessageId: id(180), queueSequence: 3, version: 2, status: 'active' };
const deepDialog = { dialogId: deepDialogId, version: 2, title: 'Архивный диалог второй страницы', createdAt: now, lastActivityAt: now, state: 'completed', activeRequestId: null, activeAttemptId: null };
const deepDecoyRequest = { requestId: deepDecoyRequestId, dialogId: deepDialogId, inputMessageId: id(1177), queueSequence: 1, version: 1, status: 'completed' };
const deepRequest = { requestId: deepRequestId, dialogId: deepDialogId, inputMessageId: id(1178), queueSequence: 2, version: 1, status: 'completed' };
const deepAttempt = { attemptId: deepAttemptId, dialogId: deepDialogId, requestId: deepRequestId, generation: 1, version: 1, state: 'completed', effectStatus: 'known', startedAt: now, finishedAt: now };
const attempt2 = { attemptId: attemptId2, dialogId, requestId: requestId2, generation: 2, version: 2, state: 'completed', effectStatus: 'known', startedAt: now, finishedAt: now };
const retryAttempt = { attemptId: retryAttemptId, dialogId, requestId: requestId2, generation: 1, version: 2, state: 'failed', effectStatus: 'known', startedAt: now, finishedAt: now };
const attempt3 = { attemptId: attemptId3, dialogId, requestId: requestId3, generation: 3, version: 2, state: 'running', effectStatus: 'known', startedAt: now };
const gfmFixture = '# Проверка GFM\n\n**жирный** и *курсив*, ~~удалено~~, `inline`.\n\n1. Пункт\n   - вложенный\n\n> Цитата\n\n- [x] готово\n- [ ] позже\n\n| Колонка | Очень длинное значение |\n| --- | --- |\n| A | ' + 'длинный текст '.repeat(20) + '|\n\n---\n\n```ts\nconst exact = "  spaces  ";\n```\n\n[безопасная ссылка](https://example.org/docs) [опасная](javascript:alert(1)) ![tracker](https://example.test/pixel.png)\n\n<script>window.hacked=true</script>\n<img src=x onerror="window.hacked=true">';
const messages = Array.from({ length: 78 }, (_, index) => index % 2 === 0 ? {
  messageId: id(100 + index), role: 'user', dialogId, sequence: index + 1, version: 1, createdAt: now, text: `Сообщение ${index + 1}: прочитай тестовый файл и объясни результат.`, disposition: 'applied', commandId: id(300 + index), requestId
} : {
  messageId: id(100 + index), role: 'assistant', dialogId, sequence: index + 1, version: 1, createdAt: now, attemptId,
  content: safe(`Ответ ${index + 1}. Результат сохранён и доступен после перезагрузки.\nПроверка относится к контролируемой UI fixture.`), finishReason: 'complete'
});
messages.push(
  { messageId: id(178), role: 'user', dialogId, sequence: 79, version: 1, createdAt: now, text: 'Покажи Markdown и отдельные действия.', disposition: 'applied', commandId: id(378), requestId: requestId2 },
  { messageId: id(179), role: 'assistant', dialogId, sequence: 80, version: 3, createdAt: now, attemptId: attemptId2,
    content: safe(gfmFixture), finishReason: 'complete' },
  { messageId: id(180), role: 'user', dialogId, sequence: 81, version: 1, createdAt: now, text: 'Текущее обращение ещё выполняется.', disposition: 'applied', commandId: id(380), requestId: requestId3 }
);
const deepMessages = [
  { messageId: id(1178), role: 'user', dialogId: deepDialogId, sequence: 1, version: 1, createdAt: now, text: 'Покажи Markdown и отдельные действия.', disposition: 'applied', commandId: id(1378), requestId: deepRequestId },
  { messageId: id(1179), role: 'assistant', dialogId: deepDialogId, sequence: 2, version: 1, createdAt: now, attemptId: deepAttemptId, content: safe(gfmFixture), finishReason: 'complete' }
];
const summary = { toolCallId: toolId, toolName: 'read_test_file', state: 'succeeded', startedAt: now, finishedAt: now, detailVersion: 3 };
const failedTool = { toolCallId: id(6), toolName: 'fixture_failure', state: 'failed', startedAt: now, finishedAt: now, detailVersion: 4 };
const summary2 = { toolCallId: toolId2, toolName: 'render_markdown_fixture', state: 'succeeded', startedAt: now, finishedAt: now, detailVersion: 1 };
const retrySummary = { toolCallId: retryToolId, toolName: 'failed_retry_fixture', state: 'failed', startedAt: now, finishedAt: now, detailVersion: 1 };
const summary3 = { toolCallId: toolId3, toolName: 'running_fixture', state: 'running', startedAt: now, detailVersion: 1 };
const deepSummary = { toolCallId: deepToolId, toolName: 'cursor.command', state: 'succeeded', startedAt: now, finishedAt: now, detailVersion: 1 };
const envelope = { protocolVersion: 1, schemaId: 'harness-wire-v2', nodeId, epoch: 1, snapshotStateVersion: 90, stateVersion: 90, lastEventSeq: 90 };
const pageDto = (items, pageType, extra = {}) => ({ ...envelope, items, nextCursor: null, pageType, ...extra });
const canonical = x => x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
const commandStatuses = new Map();
let posts = 0, historyError = false, receiptReadable = false, detailFetches = 0, historyFetches = 0;
let attemptsError = false, attemptsEmpty = false, attemptsPaged = false;
const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP localhost host.docker.internal'] });
const context = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
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
if (standalone) {
  await context.addInitScript(() => sessionStorage.setItem('oidc.user:http://localhost:18180/realms/harness:harness-web', JSON.stringify({
    access_token: 'fixture', token_type: 'Bearer', profile: { sub: 'fixture', name: 'UI fixture' }, expires_at: Math.floor(Date.now() / 1000) + 3600
  })));
  await page.route('**/api/session', route => route.fulfill({ json: { canManageConnections: true } }));
  await page.route('**/api/projections/work', route => route.fulfill({ json: [] }));
  await page.route('**/api/realtime/token', route => route.fulfill({ status: 503, json: { code: 'fixture_offline' } }));
}
const runtimeErrors = [];
const externalImageRequests = [];
page.on('pageerror', error => runtimeErrors.push(error.message));
page.on('request', request => { if (request.url().startsWith('https://example.test/')) externalImageRequests.push(request.url()); });
await page.route('**/api/projections/nodes', route => route.fulfill({ json: [node] }));
await page.route('**/api/connections', route => route.fulfill({ json: [connection] }));
await page.route('**/api/projections/history', route => route.fulfill({ json: [{ connectionId: 'fixture', nodeId, nodeName: node.name, dialogId: deepDialogId, title: 'Проверка Markdown и действий', dialogVersion: 2, createdAt: now, completedAt: now, status: 'completed', completedRequests: [{ requestId: deepRequestId, title: 'Покажи Markdown и отдельные действия.', status: 'completed', createdAt: now, completedAt: now, messages: deepMessages }], messages: [] }] }));
await page.route('**/api/connections/fixture/provider-auth?*', route => route.fulfill({ json: { schemaId: 'harness-provider-auth-v1', nodeId, revision: 1, state: 'authenticated', checkedAt: now, reasonCode: null, capabilities: { methods: [], canCheck: true, canLogout: true } } }));
await page.route('**/api/dialogs/**', async route => {
  const url = new URL(route.request().url());
  const path = url.pathname.split(`/nodes/${nodeId}/`)[1];
  const json = data => route.fulfill({ json: data });
  const error = (status, code) => route.fulfill({ status, json: { code } });
  if (path === 'identity') return json({ ...envelope, schemaSHA256: '0'.repeat(64), registryVersion: 1, identityEpoch: 1, adapter: { kind: 'fixture', version: '1' }, capabilities: { chat: 'verified', tool_results: 'verified' } });
  if (path === 'snapshot') return json({ ...envelope, capturedAt: now, completeness: 'complete', node: { transportAvailability: 'online', engineReadiness: node.observation.ready ? 'ready' : 'blocked', occupancy: 'active', queuePaused: false, queueVersion: 1, pendingCount: 0, blockedReasons: node.observation.ready ? [] : ['auth_unavailable'], activeAttemptId: attemptId3 }, pendingQueue: [], activeAttempt: attempt3 });
  if (path === 'dialogs') return url.searchParams.has('cursor')
    ? json(pageDto([deepDialog], 'dialogs', { schemaId: 'dialog-view-v1' }))
    : json(pageDto([dialog], 'dialogs', { schemaId: 'dialog-view-v1', nextCursor: 'older-dialogs' }));
  if (path === `dialogs/${dialogId}`) return json({ ...envelope, schemaId: 'dialog-view-v1', dialog });
  if (path === `dialogs/${deepDialogId}`) return json({ ...envelope, schemaId: 'dialog-view-v1', dialog: deepDialog });
  if (path === `dialogs/${dialogId}/history`) {
    historyFetches++;
    if (historyError) return error(503, 'read_unavailable');
    const end = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : messages.length;
    const start = Math.max(0, end - Number(url.searchParams.get('limit') ?? 30));
    return json(pageDto(messages.slice(start, end), 'history', { dialogId, nextCursor: start ? String(start) : null }));
  }
  if (path === `dialogs/${deepDialogId}/history`) return json(pageDto(deepMessages, 'history', { dialogId: deepDialogId }));
  if (path === 'requests') {
    if (url.searchParams.get('dialogId') === deepDialogId) return url.searchParams.has('cursor')
      ? json(pageDto([deepRequest], 'requests'))
      : json(pageDto([deepDecoyRequest], 'requests', { nextCursor: 'older-requests' }));
    return json(pageDto([request2, request3], 'requests'));
  }
  if (path === 'attempts') {
    const requested = url.searchParams.get('requestId');
    if (attemptsError) return error(503, 'read_unavailable');
    if (attemptsEmpty) return json(pageDto([], 'attempts'));
    if (attemptsPaged && requested === requestId2) return json(pageDto(url.searchParams.has('cursor') ? [retryAttempt] : [attempt2], 'attempts', { nextCursor: url.searchParams.has('cursor') ? null : 'earlier-attempts' }));
    if (requested === deepDecoyRequestId) await new Promise(resolve => setTimeout(resolve, 1500));
    const selectedAttempts = requested === deepRequestId ? [deepAttempt] : requested === requestId2 ? [retryAttempt, attempt2] : requested === requestId3 ? [attempt3] : [attempt];
    return json(pageDto(selectedAttempts, 'attempts', { dialogId, requestId: requested }));
  }
  if (path === `attempts/${attemptId}`) return json({ ...envelope, attempt });
  if (path === `attempts/${attemptId2}`) return json({ ...envelope, attempt: attempt2 });
  if (path === `attempts/${retryAttemptId}`) return json({ ...envelope, attempt: retryAttempt });
  if (path === `attempts/${attemptId3}`) return json({ ...envelope, attempt: attempt3 });
  if (path === `attempts/${deepAttemptId}`) return json({ ...envelope, attempt: deepAttempt });
  if (path === `attempts/${attemptId}/tool-calls`) return json(pageDto([summary, failedTool], 'tool_calls', { schemaId: 'tool-timeline-v1', dialogId, requestId, attemptId }));
  if (path === `attempts/${attemptId2}/tool-calls`) return json(pageDto([summary2], 'tool_calls', { schemaId: 'tool-timeline-v1', dialogId, requestId: requestId2, attemptId: attemptId2 }));
  if (path === `attempts/${retryAttemptId}/tool-calls`) return json(pageDto([retrySummary], 'tool_calls', { schemaId: 'tool-timeline-v1', dialogId, requestId: requestId2, attemptId: retryAttemptId }));
  if (path === `attempts/${attemptId3}/tool-calls`) return json(pageDto([summary3], 'tool_calls', { schemaId: 'tool-timeline-v1', dialogId, requestId: requestId3, attemptId: attemptId3 }));
  if (path === `attempts/${attemptId3}/tool-calls/${toolId3}`) {
    const after = url.searchParams.has('after');
    const indices = after ? (summary3.detailVersion > 1 ? [2, 3] : [2]) : [1];
    return json({ ...envelope, dialogId, requestId: requestId3, attemptId: attemptId3,
      toolCall: { ...summary3, input: safe('fixture operation'), result: safe(summary3.detailVersion > 1 ? 'Обновлённый результат операции' : 'Операция выполняется'),
        outputs: indices.map(index => ({ index, stream: 'stdout', content: safe(`Продолжение операции ${index}`), observedAt: now })), nextOutputCursor: after ? null : '1' } });
  }
  if (path === `attempts/${deepAttemptId}/tool-calls`) return json(pageDto([deepSummary], 'tool_calls', { schemaId: 'tool-timeline-v1', dialogId: deepDialogId, requestId: deepRequestId, attemptId: deepAttemptId }));
  if (path === `attempts/${deepAttemptId}/tool-calls/${deepToolId}`) {
    const continuation = url.searchParams.has('after');
    return json({ ...envelope, schemaId: 'tool-timeline-v1', dialogId: deepDialogId, requestId: deepRequestId, attemptId: deepAttemptId, toolCall: {
      ...deepSummary,
      input: safe('{"command":"ls -la /workspace","cwd":"/workspace","access":"read-only"}'),
      result: safe('Файлы рабочей папки прочитаны; изменений не выполнено.'),
      outputs: [{ index: continuation ? 2 : 1, stream: 'stdout', content: safe(continuation ? 'README.md' : 'total 8\ndrwxr-xr-x workspace'), observedAt: now }],
      nextOutputCursor: continuation ? null : '1'
    } });
  }
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
  if (!standalone) {
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.locator('#username').fill('operator'); await page.locator('#password').fill(password); await page.locator('#kc-login').click();
  }
  await page.getByTestId('screen-work').waitFor({ timeout: 45000 });
  await page.getByTestId('nav-dialogs').click();
  await page.getByTestId(`inline-tool-call-${toolId}`).waitFor({ state: 'attached' });
  await page.getByTestId(`inline-tool-call-${toolId2}`).waitFor({ state: 'attached' });
  await page.getByTestId(`inline-tool-call-${retryToolId}`).waitFor({ state: 'attached' });
  await page.getByTestId(`inline-tool-call-${toolId3}`).waitFor();
  assert.equal(await page.locator('.context-pane').count(), 0, 'Execution inspector no longer consumes a permanent right column');
  assert.equal(await page.locator('.execution-strip, [data-testid="request-select"]').count(), 0, 'Global execution navigation is removed');
  const scroller = page.getByTestId('messages-scroll');
  const assertAtBottom = async label => poll(async () => assert.ok(await scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 40)), label);
  await assertAtBottom('Opening a dialog settles at the latest rendered Markdown/activity');
  const execution2 = page.getByTestId(`message-${id(178)}`);
  const execution3 = page.getByTestId(`message-${id(180)}`);
  await execution3.getByRole('button', { name: 'Выполнение', exact: true }).focus();
  await page.keyboard.press('Enter');
  await execution3.getByRole('button', { name: 'Показать действия в переписке' }).waitFor();
  assert.equal(await execution3.getByRole('combobox').count(), 0, 'Single attempt does not offer a selector');
  await execution2.getByRole('button', { name: 'Выполнение', exact: true }).click();
  await execution2.getByRole('combobox').waitFor();
  assert.equal(await execution3.locator('.message-execution-detail').count(), 0, 'Details belong to one exact message');
  await execution2.getByRole('combobox').selectOption(retryAttemptId);
  await execution2.getByRole('button', { name: 'Показать действия в переписке' }).click();
  await poll(async () => assert.equal(await page.evaluate(() => document.activeElement?.closest('details')?.dataset.attemptId), retryAttemptId), 'Jump focuses selected retry activity');
  assert.equal(await page.locator('app-tool-activity').count(), 4, 'Attempt selection preserves other inline groups');
  for (const width of [320, 390, 768, 1440, 2560]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1440 });
    await execution2.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `No horizontal overflow at ${width}`);
    await page.screenshot({ path: join(out, `hl317-execution-${width}.png`), fullPage: true });
  }
  await execution2.getByRole('button', { name: 'Выполнение', exact: true }).click();
  attemptsError = true;
  await execution2.getByRole('button', { name: 'Выполнение', exact: true }).click();
  await execution2.getByRole('alert').waitFor();
  attemptsError = false;
  attemptsPaged = true;
  await execution2.getByRole('button', { name: 'Повторить загрузку' }).click();
  await execution2.getByRole('button', { name: 'Показать более ранние попытки' }).waitFor();
  attemptsError = true;
  await execution2.getByRole('button', { name: 'Показать более ранние попытки' }).click();
  await execution2.getByRole('alert').waitFor();
  attemptsError = false;
  await execution2.getByRole('button', { name: 'Показать более ранние попытки' }).click();
  await poll(async () => assert.equal(await execution2.getByRole('combobox').locator('option').count(), 2), 'Attempt pagination restores earlier retry');
  assert.equal(await execution2.getByRole('alert').count(), 0, 'Successful pagination retry clears the error');
  const beforeExhaustedRefresh = historyFetches;
  await page.getByTestId('refresh-current').click();
  await poll(async () => assert.ok(historyFetches > beforeExhaustedRefresh), 'Refresh exhausted attempt pagination');
  await execution2.getByRole('button', { name: 'Показать действия в переписке' }).waitFor();
  assert.equal(await execution2.getByRole('button', { name: 'Показать более ранние попытки' }).count(), 0, 'Exhausted attempt pagination remains exhausted after refresh');
  let releaseOldRead;
  let oldReadStarted = false;
  let interceptCount = 0;
  await execution2.getByRole('combobox').selectOption(retryAttemptId);
  const delayedAttemptUrl = `**/attempts/${attemptId2}/tool-calls*`;
  await page.route(delayedAttemptUrl, async route => {
    if (++interceptCount !== 1) return route.fallback();
    oldReadStarted = true;
    await new Promise(resolve => { releaseOldRead = resolve; });
    await route.fulfill({ status: 503, json: { code: 'obsolete_failure' } });
  });
  await execution2.getByRole('combobox').selectOption(attemptId2);
  await poll(async () => assert.ok(oldReadStarted), 'Delayed attempt read starts');
  await execution2.getByRole('combobox').selectOption(retryAttemptId);
  await execution2.getByRole('combobox').selectOption(attemptId2);
  await execution2.getByRole('button', { name: 'Показать действия в переписке' }).waitFor();
  const obsoleteResponse = page.waitForResponse(response => response.url().includes(`/attempts/${attemptId2}/tool-calls`) && response.status() === 503);
  releaseOldRead();
  await obsoleteResponse;
  await page.waitForTimeout(100);
  assert.equal(await execution2.getByRole('alert').count(), 0, 'A → B → A ignores obsolete A failure');
  await page.unroute(delayedAttemptUrl);
  summary2.toolName = 'updated_cached_activity';
  summary2.detailVersion = 2;
  await execution2.getByRole('combobox').selectOption(retryAttemptId);
  await execution2.getByRole('combobox').selectOption(attemptId2);
  await poll(async () => assert.match(await page.getByTestId(`inline-tool-call-${toolId2}`).textContent(), /updated cached activity/), 'Selection merges fresh summaries into cached activity');
  attemptsPaged = false;
  await execution2.getByRole('button', { name: 'Выполнение', exact: true }).click();
  attemptsEmpty = true;
  await execution2.getByRole('button', { name: 'Выполнение', exact: true }).click();
  await execution2.getByText('Выполнение ещё не началось.').waitFor();
  attemptsEmpty = false;
  attemptsPaged = true;
  await page.getByTestId('refresh-current').click();
  await execution2.getByRole('button', { name: 'Показать более ранние попытки' }).waitFor();
  attemptsPaged = false;
  await execution2.getByRole('button', { name: 'Выполнение', exact: true }).click();
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  assert.equal(await page.locator('app-tool-activity').count(), 4, 'Each request/attempt, including a failed retry without an answer, keeps a distinct inline activity group');
  const firstGroup = page.getByTestId(`inline-tool-call-${toolId}`).locator('xpath=ancestor::details');
  await firstGroup.locator(':scope > summary').click();
  const runningGroup = page.getByTestId(`inline-tool-call-${toolId3}`).locator('xpath=ancestor::details');
  assert.ok(await runningGroup.getAttribute('open') !== null, 'Running activity opens by default');
  const secondGroup = page.getByTestId(`inline-tool-call-${toolId2}`).locator('xpath=ancestor::details');
  assert.equal(await secondGroup.locator('xpath=ancestor::app-tool-activity/following-sibling::article[1]').getAttribute('data-testid'), `message-${id(179)}`, 'Completed activity anchors before its exact response');
  const retryGroup = page.getByTestId(`inline-tool-call-${retryToolId}`).locator('xpath=ancestor::details');
  assert.equal(await retryGroup.locator('xpath=ancestor::app-tool-activity/preceding-sibling::article[1]').getAttribute('data-testid'), `message-${id(178)}`, 'Failed retry without a response anchors after its exact request');
  assert.equal(await runningGroup.locator('xpath=ancestor::app-tool-activity/preceding-sibling::article[1]').getAttribute('data-testid'), `message-${id(180)}`, 'Current activity anchors after its request while no response exists');
  const markdownMessage = page.getByTestId(`message-${id(179)}`);
  assert.equal(await markdownMessage.locator('h1').innerText(), 'Проверка GFM');
  assert.equal(await markdownMessage.locator('table').count(), 1);
  assert.equal(await markdownMessage.locator('.markdown-task-checkbox').count(), 2);
  assert.equal(await markdownMessage.locator('s').innerText(), 'удалено');
  assert.equal(await markdownMessage.locator('script, img, a[href^="javascript:"], a[href^="data:"]').count(), 0, 'Untrusted HTML, images and unsafe URLs stay inert');
  assert.equal(externalImageRequests.length, 0, 'Markdown images never initiate external requests');
  const safeLink = markdownMessage.locator('a[href="https://example.org/docs"]');
  assert.equal(await safeLink.getAttribute('target'), '_blank');
  assert.ok((await safeLink.getAttribute('rel')).includes('noopener'));
  const codeSource = 'const exact = "  spaces  ";\n';
  assert.equal(await markdownMessage.locator('.markdown-code code').textContent(), codeSource);
  await markdownMessage.locator('.markdown-copy-code').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), codeSource, 'Copy keeps exact fenced source');
  await scroller.evaluate(el => { el.style.scrollBehavior = 'auto'; el.scrollTop = 0; });
  messages[79] = { ...messages[79], version: 4, content: safe('Частичная версия\n\n```ts\nconst pending = true;') };
  await page.getByTestId('refresh-current').click();
  await poll(async () => assert.ok((await markdownMessage.innerText()).includes('const pending = true;')), 'Partial fence update renders safely');
  await assertAtBottom('Updated partial Markdown scrolls to the latest message after render');
  await scroller.evaluate(el => { el.scrollTop = 0; });
  messages[79] = { ...messages[79], version: 5, content: safe(gfmFixture) };
  await page.getByTestId('refresh-current').click();
  await poll(async () => assert.equal(await markdownMessage.locator('h1').innerText(), 'Проверка GFM'), 'Final message version replaces partial DOM');
  await assertAtBottom('Final Markdown height settles at the latest message');
  assert.equal(await page.getByTestId(`message-${id(179)}`).count(), 1, 'Message versions do not duplicate DOM');
  await markdownMessage.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, 'hl311-markdown-actions-qhd.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await markdownMessage.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, 'hl311-markdown-actions-390.png') });
  await page.setViewportSize({ width: 2560, height: 1440 });
  assert.equal(detailFetches, 0, 'Tool details must load lazily');
  await page.getByTestId(`inline-tool-call-${toolId3}`).click();
  await page.getByTestId('tool-details').getByText('Операция выполняется', { exact: true }).waitFor();
  await page.getByTestId('tool-details').getByText('Журнал вывода', { exact: false }).click();
  await page.getByRole('button', { name: 'Загрузить продолжение', exact: true }).click();
  await page.getByText('Продолжение операции 2', { exact: true }).waitFor();
  summary3.detailVersion = 2;
  summary3.state = 'succeeded';
  await page.getByTestId('refresh-current').click();
  await page.getByTestId('tool-details').getByText('Обновлённый результат операции', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Загрузить продолжение', exact: true }).click();
  await page.getByText('Продолжение операции 3', { exact: true }).waitFor();
  assert.equal(await page.getByText('Продолжение операции 2', { exact: true }).count(), 1, 'New output remains reachable after previously exhausting output pages, without duplicates');
  await page.getByTestId(`inline-tool-call-${toolId3}`).click();
  await page.getByTestId(`inline-tool-call-${toolId}`).click();
  await page.getByTestId('tool-details').waitFor();
  assert.equal(await page.getByTestId('tool-details').locator('xpath=ancestor::app-tool-activity').count(), 1, 'Operation details stay inline with their chat activity group');
  assert.ok((await page.getByTestId('tool-details').innerText()).includes('Что было передано'));
  assert.ok((await page.getByTestId('tool-details').innerText()).includes('Что получилось'));
  await page.getByTestId('tool-details').getByText('Журнал вывода', { exact: false }).click();
  await page.getByRole('button', { name: 'Загрузить продолжение', exact: true }).click();
  await poll(async () => assert.ok((await page.getByTestId('tool-details').innerText()).includes('Последняя часть результата')), 'Bounded tool output continuation');
  const inlineOperation = page.getByTestId('tool-details').locator('xpath=ancestor::app-tool-activity');
  await inlineOperation.screenshot({ path: join(out, 'hl311-inline-operation-qhd.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await inlineOperation.scrollIntoViewIfNeeded();
  await inlineOperation.screenshot({ path: join(out, 'hl311-inline-operation-390.png') });
  await page.setViewportSize({ width: 2560, height: 1440 });
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
  await scroller.evaluate(el => { el.scrollTop = 0; });
  const before = await page.locator('article.message').first().getAttribute('data-testid');
  await page.getByTestId('load-older-messages').click();
  await poll(async () => assert.ok(await page.locator('article.message').count() > 30), 'Older page');
  assert.ok(await page.getByTestId(before).count());
  await poll(async () => assert.ok(await scroller.evaluate(el => el.scrollTop) > 0), 'Older load must retain visual anchor');
  await scroller.evaluate(el => { el.style.scrollBehavior = 'auto'; el.scrollTop = el.scrollHeight; });
  const reloadedInlineTool = page.getByTestId(`inline-tool-call-${toolId}`);
  await reloadedInlineTool.waitFor({ state: 'attached' });
  const reloadedGroup = reloadedInlineTool.locator('xpath=ancestor::details');
  if (await reloadedGroup.getAttribute('open') === null) await reloadedGroup.locator(':scope > summary').click();
  if (await reloadedInlineTool.getAttribute('aria-expanded') !== 'true') await reloadedInlineTool.click();
  await page.getByTestId('tool-details').waitFor();
  await page.screenshot({ path: join(out, 'dialogs-fixture-qhd.png'), fullPage: true });
  await page.getByTestId('message-input').focus();
  assert.notEqual(await page.getByTestId('message-input').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
  await page.getByTestId('message-input').fill('Первая строка');
  await page.keyboard.press('Shift+Enter');
  assert.equal(posts, 0, 'Shift+Enter adds a line without a command');
  assert.equal(await page.getByTestId('message-input').inputValue(), 'Первая строка\n');
  await page.getByTestId('message-input').evaluate(el => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(event, 'isComposing', { value: true });
    el.dispatchEvent(event);
  });
  assert.equal(posts, 0, 'IME composition Enter never submits');
  await page.getByTestId('message-input').fill('LOST_ACK_fixture_text_must_not_be_in_storage');
  await page.keyboard.press('Enter');
  await page.locator('[data-testid^="pending-command-"]').waitFor();
  assert.equal(posts, 1);
  await assertAtBottom('Sending scrolls to the latest message without replaying the command');
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
  await assertAtBottom('New messages always move the chat to the latest rendered message');
  await scroller.evaluate(el => { el.scrollTop = 0; });
  const beforeUnchangedRefresh = historyFetches;
  await page.getByTestId('refresh-current').click();
  await poll(async () => assert.ok(historyFetches > beforeUnchangedRefresh), 'Unchanged history refetched');
  await page.waitForTimeout(250);
  assert.equal(await scroller.evaluate(el => el.scrollTop), 0, 'Unchanged refetch does not create a scroll loop');
  await page.getByTestId('load-older-messages').click();
  await page.getByTestId(`message-${id(1000)}`).waitFor();
  const messageIds = await page.locator('article.message').evaluateAll(items => items.map(item => item.dataset.testid));
  assert.equal(new Set(messageIds).size, messageIds.length, 'Catch-up pages deduplicate retained history');
  if (!standalone) {
  const beforeReconnect = historyFetches;
  await poll(async () => assert.ok(await page.evaluate(() => window.__dialogSockets.some(socket => socket.readyState === WebSocket.OPEN))), 'Realtime socket connected');
  const socketsBeforeReconnect = await page.evaluate(() => window.__dialogSockets.length);
  await page.evaluate(() => window.__dialogSockets.find(socket => socket.readyState === WebSocket.OPEN).close(4000, 'HL307 acceptance reconnect'));
  await poll(async () => assert.ok(await page.evaluate(count => window.__dialogSockets.slice(count).some(socket => socket.readyState === WebSocket.OPEN), socketsBeforeReconnect)), 'New realtime socket connected');
  await poll(async () => assert.ok(historyFetches > beforeReconnect), 'Realtime reconnect refetches persisted history');
  assert.equal(posts, 1, 'Realtime reconnect never submits a command');
  assert.ok(await page.getByTestId(`message-${id(1000)}`).count(), 'Reconnect retains older loaded history');
  }
  await reloadedInlineTool.waitFor({ state: 'attached' });
  if (await reloadedGroup.getAttribute('open') === null) await reloadedGroup.locator('summary').click();
  await reloadedInlineTool.click();
  await page.getByTestId('tool-details').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: join(out, 'dialogs-fixture-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1440);
  await page.screenshot({ path: join(out, 'dialogs-fixture-laptop.png'), fullPage: true });
  await page.getByTestId('nav-history').click();
  const historyRow = page.locator('[data-testid^="history-row-"]').first();
  await historyRow.waitFor();
  await historyRow.click();
  assert.equal(await page.getByTestId('history-table').count(), 0, 'History no longer uses a stretched full-width table');
  assert.equal(await historyRow.locator('strong').first().innerText(), 'Покажи Markdown и отдельные действия.', 'Request text is the primary history label');
  assert.ok((await historyRow.locator('small').innerText()).includes('Сессия: Проверка Markdown и действий'), 'Session title is secondary metadata');
  assert.equal(await page.getByTestId('history-request-title').innerText(), 'Покажи Markdown и отдельные действия.', 'Request text is the inspector heading');
  assert.equal(await page.getByTestId('history-inspector').locator('h1').innerText(), 'Проверка GFM', 'Exact request answer renders as readable Markdown');
  assert.ok((await page.getByTestId('history-inspector').innerText()).includes('Покажи Markdown и отдельные действия.'));
  await page.getByTestId(`inline-tool-call-${deepToolId}`).waitFor();
  const historyTools = page.getByTestId('history-tools');
  await historyTools.getByTestId('tool-details').waitFor();
  assert.ok((await historyTools.innerText()).includes('ls -la /workspace'), 'History opens the exact operation arguments without leaving the request card');
  assert.ok((await historyTools.innerText()).includes('Файлы рабочей папки прочитаны'), 'History shows the exact tool result');
  await historyTools.getByText('Журнал вывода', { exact: false }).click();
  assert.ok((await historyTools.innerText()).includes('total 8'), 'History exposes the persisted output journal');
  await historyTools.getByRole('button', { name: 'Загрузить продолжение', exact: true }).click();
  await poll(async () => assert.ok((await historyTools.innerText()).includes('README.md')), 'History loads bounded output continuation');
  await historyTools.getByText('Диагностика', { exact: false }).click();
  assert.ok((await historyTools.innerText()).includes(deepToolId), 'History exposes exact tool identifiers on demand');
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.screenshot({ path: join(out, 'hl311-followup-history-qhd.png') });
  await page.setViewportSize({ width: 640, height: 360 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 640, 'History has no page-level horizontal overflow at an effective 200% zoom viewport');
  assert.ok(await page.getByRole('button', { name: 'Открыть в диалоге', exact: true }).isVisible(), 'History remains operable at an effective 200% browser zoom viewport');
  await page.screenshot({ path: join(out, 'hl311-followup-history-200-percent.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Открыть в диалоге', exact: true }).click();
  await page.getByTestId(`message-${id(1179)}`).waitFor();
  const deepExecution = page.getByTestId(`message-${id(1178)}`);
  await poll(async () => assert.equal(await deepExecution.getByRole('button', { name: 'Выполнение', exact: true }).getAttribute('aria-expanded'), 'true'), 'History opens execution for the exact request from page two');
  await poll(async () => assert.equal(await page.evaluate(() => document.activeElement?.closest('article')?.dataset.testid), `message-${id(1178)}`), 'History focuses its exact message');
  assert.equal(await page.getByTestId(`message-${id(1179)}`).count(), 1, 'History deep-link loads the exact dialog from the second page without duplicating its response');
  await page.getByTestId('nav-nodes').click();
  assert.equal(await page.getByTestId('nav-settings').count(), 0, 'Duplicating Settings navigation is removed');
  await poll(async () => assert.equal(await page.getByTestId('node-provider-auth-fixture').innerText(), 'Аккаунт подключён'), 'Provider authentication is visible in the Nodes table');
  await page.getByTestId('node-row-fixture').getByRole('button').click();
  await page.getByTestId('provider-auth').waitFor();
  assert.equal(await page.getByTestId('provider-auth').count(), 1, 'Provider auth exists once in the unified Nodes inspector');
  assert.ok(await page.getByTestId('node-inspector').locator('.inspector-card').count() >= 3, 'Node settings are grouped into readable inspector sections');
  await page.getByTestId('connection-uri').waitFor();
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.screenshot({ path: join(out, 'hl311-followup-nodes-qhd.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: join(out, 'hl311-followup-nodes-390.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  node.observation.ready = false;
  node.observation.engineReadiness = 'blocked';
  node.observation.blockedReasons = ['auth_unavailable'];
  await page.reload();
  await page.getByTestId('nav-dialogs').click();
  await page.getByTestId('message-input').waitFor();
  await page.getByTestId('message-input').fill('Недоступная нода не должна принять сообщение');
  assert.ok(await page.getByTestId('send-message').isDisabled());
  await page.keyboard.press('Enter');
  assert.ok(await page.getByTestId('create-dialog').isDisabled());
  assert.ok(await page.locator('article.message').count() > 0, 'Persisted history remains readable without provider auth');
  assert.ok(await page.getByRole('button', { name: 'Настройки ноды', exact: true }).count() > 0);
  assert.ok((await page.locator('app-dialogs').innerText()).includes('требуется авторизация провайдера'));
  assert.equal(posts, 1);
  await page.screenshot({ path: join(out, 'dialogs-fixture-auth-blocked.png'), fullPage: true });
  await page.getByTestId('nav-work').click();
  await poll(async () => assert.equal(await page.locator('app-dialogs').isVisible(), false), 'Hidden dialogs must not leak into other screens');
  assert.deepEqual(runtimeErrors, []);
  await writeFile(join(out, 'dialogs-ui-evidence.json'), JSON.stringify({ mode: 'controlled public API DTO fixtures; not provider execution', posts, detailFetches, historyFetches, providerCalls: 0, checks: ['Enter sends exactly once', 'Shift+Enter newline', 'IME Enter is inert', 'disabled composer is inert', 'open/send/new/update/activity-height auto-scroll', 'older-page anchor', 'unchanged refetch has no scroll loop', 'message execution disclosure, single/multiple attempts, pagination recovery, stale A-B-A response protection', 'operation details expand inline without a permanent right inspector', 'unified Nodes owns connection editor/provider auth/diagnostics', 'duplicating Settings navigation removed', 'History exact request answer Markdown and dialog deep-link', 'four request/attempt-scoped activity groups including failed retry without response', 'live activity before response', 'exact response anchor', 'lazy inline details', 'inline detail/output pagination remains attached to its operation', 'safe GFM structures', 'partial-to-final message versions without duplicate DOM', 'raw HTML and dangerous URL inert', 'no external Markdown image requests', 'exact fenced-source copy', 'long code/table local overflow', 'retained data/draft', standalone ? 'reconnect not exercised in offline DTO mode' : 'reconnect refetch without command replay', 'blocked auth preserves history', 'tool output continuation', 'keyboard focus', 'pending IDs only', 'reload receipt no replay', 'QHD/390/laptop screenshots', 'History effective 200% zoom viewport without page overflow'] }, null, 2));
  console.log('PASS HL-311 follow-up controlled DTO fixtures: Enter/IME, render-aware auto-scroll, message execution details, safe/versioned GFM and zero provider calls.');
} catch (error) {
  await page.screenshot({ path: join(out, 'dialogs-ui-failure.png'), fullPage: true }).catch(() => {});
  console.error(error.message);
  throw error;
} finally { await browser.close(); }
