import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { modelCatalogFixture, nodeSettingsFixture } from './node-settings-fixture.mjs';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:18505';
const apiBaseUrl = process.env.API_BASE_URL ?? 'http://host.docker.internal:18505';
const username = process.env.DEV_USER_USERNAME ?? 'operator';
const passwordFile = process.env.DEV_USER_PASSWORD_FILE ?? '/run/secrets/keycloak_dev_user_password';
const outputDir = process.env.OUTPUT_DIR ?? '/output';
const harnessCaFile = process.env.HARNESS_CA_FILE ?? '/run/config/harness_server_cert';
const projectNamespace = process.env.ACCEPTANCE_PROJECT_NAMESPACE ?? '';
const composeProject = process.env.COMPOSE_PROJECT_NAME ?? '';

assert.equal(process.env.ACCEPTANCE_ISOLATED, 'true', 'Refusing to run: ACCEPTANCE_ISOLATED must be exactly "true".');
assert.match(projectNamespace, /^(?:hl305|hl320)-[a-z0-9][a-z0-9-]*$/, 'Refusing to run without a dedicated hl305-* or hl320-* namespace.');
assert.equal(composeProject, projectNamespace, 'COMPOSE_PROJECT_NAME must equal ACCEPTANCE_PROJECT_NAMESPACE.');
for (const [name, value] of [['BASE_URL', baseUrl], ['API_BASE_URL', apiBaseUrl]]) {
  const host = new URL(value).hostname;
  assert.ok(['localhost', '127.0.0.1', 'host.docker.internal'].includes(host), `${name} must target the isolated local stack.`);
}

const password = (await readFile(passwordFile, 'utf8')).trim();
const harnessCa = await readFile(harnessCaFile);
await mkdir(outputDir, { recursive: true });
const manifestPath = join(outputDir, `fixtures-${projectNamespace}.json`);
let diagnosticPage = null;
const pageErrors = new Map();

function stableUuid(label) {
  const bytes = createHash('sha256').update(`${projectNamespace}\0${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeTestId(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function workRowTestId(item) {
  return `work-row-${safeTestId(`${item.nodeId}:${item.requestId}`)}`;
}

function historyRowTestId(item) {
  return `history-row-${safeTestId(`${item.nodeId}:${item.requestId}`)}`;
}

function initialManifest() {
  const command = (label) => ({ commandId: stableUuid(label), references: null });
  return {
    version: 2,
    projectNamespace,
    connections: {
      cursor: { name: 'Cursor fixture', baseUri: 'https://cursor-harness:8443/', connectionId: null },
      codex: { name: 'Codex fixture', baseUri: 'https://codex-harness:8443/', connectionId: null }
    },
    cursor: {
      hostname: 'cursor-harness',
      nodeId: '11111111-1111-4111-8111-111111111111',
      historyTitle: 'Проверка двух завершённых обращений',
      workTitle: 'Очередь Cursor',
      commands: {
        historyDialog: command('cursor-history-dialog'),
        terminalOne: command('cursor-terminal-one'),
        cancelTerminalOne: command('cursor-cancel-terminal-one'),
        terminalTwo: command('cursor-terminal-two'),
        cancelTerminalTwo: command('cursor-cancel-terminal-two'),
        workDialog: command('cursor-work-dialog-v2'),
        queuedWork: command('cursor-queued-work')
      },
      lifecycle: { terminalOneQueuedObserved: false, terminalTwoQueuedObserved: false }
    },
    codex: {
      hostname: 'codex-harness',
      nodeId: '22222222-2222-4222-8222-222222222222',
      workTitle: 'Очередь Codex',
      commands: {
        workDialog: command('codex-work-dialog'),
        queuedWork: command('codex-queued-work')
      }
    }
  };
}

async function saveManifest(manifest) {
  const temporary = `${manifestPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporary, manifestPath);
}

async function loadManifest() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    manifest = initialManifest();
    await saveManifest(manifest);
  }
  if (manifest.version === 1) {
    const rejected = manifest.cursor?.commands?.workDialog;
    assert.equal(rejected?.commandId, stableUuid('cursor-work-dialog'), 'Version 1 manifest has an unexpected Cursor Work command.');
    assert.equal(rejected?.references, null, 'Refusing to replace a Cursor Work command that has an accepted receipt.');
    rejected.commandId = stableUuid('cursor-work-dialog-v2');
    manifest.version = 2;
    await saveManifest(manifest);
  }
  assert.equal(manifest.version, 2, 'Unsupported acceptance fixture manifest version.');
  assert.equal(manifest.projectNamespace, projectNamespace, 'Fixture manifest belongs to another Compose project.');
  const expected = initialManifest();
  for (const key of ['cursor', 'codex']) {
    assert.equal(manifest[key].nodeId, expected[key].nodeId, `${key} fixture node changed.`);
    for (const commandName of Object.keys(expected[key].commands)) {
      assert.equal(manifest[key].commands[commandName].commandId, expected[key].commands[commandName].commandId,
        `${key}.${commandName} command identity changed.`);
    }
  }
  return manifest;
}

async function poll(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`${description}: ${lastError?.message ?? 'timed out'}`, { cause: lastError });
}

async function unique(locator, description) {
  await poll(async () => {
    assert.equal(await locator.count(), 1, `${description} must resolve to exactly one element.`);
    assert.equal(await locator.isVisible(), true, `${description} must be visible.`);
  }, `${description} visibility`, 15_000);
  return locator;
}

async function login(context, existingPage = null) {
  const page = existingPage ?? await context.newPage();
  diagnosticPage = page;
  const errors = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error?.stack ?? error?.message ?? String(error)));
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 15_000 });
      await page.getByRole('button', { name: 'Войти', exact: true }).waitFor({ timeout: 5_000 });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await page.waitForTimeout(2_000);
    }
  }
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  try {
    await page.getByTestId('screen-work').waitFor({ timeout: 30_000 });
  } catch (error) {
    console.error(`Login did not return to the SPA. URL: ${page.url()}`);
    console.error((await page.locator('body').innerText()).slice(0, 1600));
    await page.screenshot({ path: join(outputDir, 'login-failure.png'), fullPage: true });
    throw error;
  }
  return page;
}

function assertNoPageErrors(page, description) {
  const errors = pageErrors.get(page) ?? [];
  assert.deepEqual(errors, [], `${description} emitted browser runtime errors:\n${errors.join('\n---\n')}`);
}

async function accessToken(page) {
  return page.evaluate(() => {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith('oidc.user:')) continue;
      return JSON.parse(sessionStorage.getItem(key)).access_token;
    }
    return null;
  });
}

async function apiRaw(page, method, path, data) {
  const token = await accessToken(page);
  assert.ok(token, 'Authenticated API request requires an OIDC access token.');
  return page.request.fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data
  });
}

async function apiJson(page, path) {
  const response = await apiRaw(page, 'GET', path);
  assert.equal(response.status(), 200, `GET ${path} must return 200: ${await response.text()}`);
  return response.json();
}

async function assertNativeSettingsContracts(page, manifest) {
  for (const key of ['cursor', 'codex']) {
    const fixture = manifest[key];
    const connectionId = manifest.connections[key].connectionId;
    const query = `nodeId=${encodeURIComponent(fixture.nodeId)}&configEpoch=1`;
    const base = `/api/connections/${encodeURIComponent(connectionId)}/node-settings`;
    const settings = await apiJson(page, `${base}?${query}`);
    assert.equal(settings.schemaId, 'harness-node-settings-v2', `${key} must return the versioned settings contract.`);
    assert.equal(settings.draft?.mcpDocument?.schemaId, 'harness-mcp-document-v2');
    assert.ok(Number.isSafeInteger(settings.resourceRevision), `${key} must return an Adapter resource revision.`);
    const catalog = await apiJson(page, `${base}/model-catalog?${query}`);
    assert.equal(catalog.schemaId, 'harness-model-catalog-v2', `${key} must return a versioned model catalog.`);
    assert.ok(Array.isArray(catalog.models), `${key} catalog must contain a models array.`);
    const validation = await apiRaw(page, 'POST', `${base}/mcp-validate?${query}`,
      { mcpDocument: settings.draft.mcpDocument });
    assert.equal(validation.status(), 200, `${key} must validate its own saved MCP document: ${await validation.text()}`);
    assert.equal((await validation.json()).valid, true, `${key} saved MCP document must be valid.`);
  }
}

async function assertCodexModeOnlyApply(page, manifest) {
  const fixture = manifest.codex;
  const connectionId = manifest.connections.codex.connectionId;
  const query = `nodeId=${encodeURIComponent(fixture.nodeId)}&configEpoch=1`;
  const base = `/api/connections/${encodeURIComponent(connectionId)}/node-settings`;
  const catalog = await apiJson(page, `${base}/model-catalog?${query}`);
  const defaultModel = catalog.models.find(model => model.isDefault);
  assert.ok(defaultModel?.speedModes?.some(mode => mode.id === 'on'), 'Codex default model must advertise native speed on.');
  let settings = await apiJson(page, `${base}?${query}`);
  assert.equal(settings.draft.inference.modelId, null, 'Mode-only proof starts with the provider default model.');
  if (settings.draft.inference.speedMode !== 'on') {
    const draft = structuredClone(settings.draft);
    draft.inference.speedMode = 'on';
    const response = await apiRaw(page, 'PUT', `${base}?${query}`, { expectedRevision: settings.draftRevision, draft });
    assert.equal(response.status(), 200, `Codex speed-only PUT must succeed: ${await response.text()}`);
    settings = await response.json();
    assert.equal(settings.draft.inference.modelId, null, 'Speed-only PUT must preserve the default model.');
    assert.equal(settings.draft.inference.reasoningEffort, null, 'Speed-only PUT must preserve reasoning default.');
    assert.equal(settings.draft.inference.speedMode, 'on');
  }
  if (settings.appliedRevision !== settings.draftRevision) {
    const commandId = stableUuid('codex-hl320-speed-only-apply-retry');
    const response = await apiRaw(page, 'POST', `${base}/apply?${query}`, {
      expectedRevision: settings.draftRevision, targetRevision: settings.draftRevision, commandId
    });
    assert.ok([200, 202].includes(response.status()), `Codex speed-only apply must be accepted: ${await response.text()}`);
  }
  await poll(async () => {
    const readback = await apiJson(page, `${base}?${query}`);
    assert.equal(readback.draft.inference.speedMode, 'on');
    assert.equal(readback.appliedRevision, readback.draftRevision, `Codex mode-only apply: ${JSON.stringify(readback.operation)}.`);
    assert.equal(readback.applied?.inference.speedMode, 'on');
  }, 'Codex speed-only settings must apply through Adapter', 30_000);
}

async function waitForProjection(page, path, predicate, description, timeout = 45_000) {
  return poll(async () => {
    const value = await apiJson(page, path);
    assert.ok(predicate(value), `${description}; received ${JSON.stringify(value)}`);
    return value;
  }, description, timeout);
}

async function registerConnectionConcurrently(page, manifest, key) {
  const fixture = manifest.connections[key];
  const body = {
    name: fixture.name,
    baseUri: fixture.baseUri,
    observationIntervalSeconds: 2,
    requestTimeoutSeconds: 2,
    staleThresholdSeconds: 6
  };
  const responses = await Promise.all(Array.from({ length: 6 }, () => apiRaw(page, 'POST', '/api/connections', body)));
  const records = [];
  for (const response of responses) {
    assert.ok([200, 201].includes(response.status()), `Duplicate registration returned ${response.status()}: ${await response.text()}`);
    if (response.status() === 200) assert.equal(response.headers()['x-connection-reused'], 'true', 'A reused endpoint must be marked explicitly.');
    records.push(await response.json());
  }
  assert.equal(new Set(records.map((item) => item.id)).size, 1, `Concurrent ${key} registrations must return one identity.`);
  const connectionId = records[0].id;
  assert.ok(connectionId, `${key} registration omitted id.`);
  if (fixture.connectionId) assert.equal(connectionId, fixture.connectionId, `${key} identity changed across acceptance runs.`);
  fixture.connectionId = connectionId;
  await saveManifest(manifest);
  return records[0];
}

async function harnessCommand(fixture, command, kind, target, expected, payload) {
  const body = JSON.stringify({ protocolVersion: 1, schemaId: 'harness-wire-v2', commandId: command.commandId, kind,
    target: { nodeId: fixture.nodeId, ...target }, expected, payload });
  const response = await new Promise((resolve, reject) => {
    const request = https.request({
      hostname: fixture.hostname, servername: fixture.hostname, port: 8443,
      path: `/v1/nodes/${fixture.nodeId}/commands`, method: 'POST', ca: harnessCa, rejectUnauthorized: true,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
  assert.ok([200, 202].includes(response.status),
    `${fixture.hostname} ${kind} must return 202 when first accepted or 200 for an exact replay: ${response.body}`);
  const receipt = JSON.parse(response.body);
  assert.equal(receipt.commandId, command.commandId, `${kind} receipt commandId mismatch.`);
  assert.equal(receipt.commandKind, kind, `${kind} receipt command kind mismatch.`);
  assert.equal(receipt.nodeId, fixture.nodeId, `${kind} receipt node mismatch.`);
  assert.equal(receipt.result, 'admitted', `${kind} command must be admitted, not silently rejected.`);
  assert.ok(receipt.references && typeof receipt.references === 'object', `${kind} receipt must include references.`);
  if (command.references) assert.deepEqual(receipt.references, command.references, `${kind} replay returned different references.`);
  command.references = receipt.references;
  return receipt;
}

async function dispatchAndPersist(manifest, fixture, commandName, kind, target, expected, payload) {
  const receipt = await harnessCommand(fixture, fixture.commands[commandName], kind, target, expected, payload);
  await saveManifest(manifest);
  return receipt.references;
}

async function ensureHarnessFixtures(page, manifest) {
  const cursor = manifest.cursor;
  const codex = manifest.codex;
  const history = await dispatchAndPersist(manifest, cursor, 'historyDialog', 'dialog.create', {},
    { registryVersion: 1 }, { title: cursor.historyTitle });
  const terminalOne = await dispatchAndPersist(manifest, cursor, 'terminalOne', 'message.enqueue',
    { dialogId: history.dialogId }, { dialogVersion: 1 }, { text: 'Первое завершённое обращение' });
  if (!cursor.lifecycle.terminalOneQueuedObserved) {
    await waitForProjection(page, '/api/projections/work',
      (items) => items.some((item) => item.requestId === terminalOne.requestId && item.status === 'queued'),
      'The first terminal fixture must be observed in Work before cancellation.');
    cursor.lifecycle.terminalOneQueuedObserved = true;
    await saveManifest(manifest);
  }
  await dispatchAndPersist(manifest, cursor, 'cancelTerminalOne', 'request.cancel',
    { requestId: terminalOne.requestId }, { requestVersion: 1 }, {});
  await waitForProjection(page, '/api/projections/history',
    (items) => items.some((item) => item.requestId === terminalOne.requestId && item.status === 'cancelled'),
    'The first terminal fixture must move to History.');

  const terminalTwo = await dispatchAndPersist(manifest, cursor, 'terminalTwo', 'message.enqueue',
    { dialogId: history.dialogId }, { dialogVersion: 2 }, { text: 'Второе завершённое обращение' });
  if (!cursor.lifecycle.terminalTwoQueuedObserved) {
    await waitForProjection(page, '/api/projections/work',
      (items) => items.some((item) => item.requestId === terminalTwo.requestId && item.status === 'queued'),
      'The second terminal fixture must be observed in Work before cancellation.');
    cursor.lifecycle.terminalTwoQueuedObserved = true;
    await saveManifest(manifest);
  }
  await dispatchAndPersist(manifest, cursor, 'cancelTerminalTwo', 'request.cancel',
    { requestId: terminalTwo.requestId }, { requestVersion: 1 }, {});

  const cursorWorkDialog = await dispatchAndPersist(manifest, cursor, 'workDialog', 'dialog.create', {},
    { registryVersion: 1 }, { title: cursor.workTitle });
  const cursorWork = await dispatchAndPersist(manifest, cursor, 'queuedWork', 'message.enqueue',
    { dialogId: cursorWorkDialog.dialogId }, { dialogVersion: 1 }, { text: 'Стабильная очередь Cursor' });
  const codexWorkDialog = await dispatchAndPersist(manifest, codex, 'workDialog', 'dialog.create', {},
    { registryVersion: 1 }, { title: codex.workTitle });
  const codexWork = await dispatchAndPersist(manifest, codex, 'queuedWork', 'message.enqueue',
    { dialogId: codexWorkDialog.dialogId }, { dialogVersion: 1 }, { text: 'Стабильная очередь Codex' });
  return {
    terminal: [{ requestId: terminalOne.requestId, dialogId: history.dialogId }, { requestId: terminalTwo.requestId, dialogId: history.dialogId }],
    work: [
      { connectionId: manifest.connections.cursor.connectionId, requestId: cursorWork.requestId, dialogId: cursorWorkDialog.dialogId, nodeId: cursor.nodeId, title: cursor.workTitle, nodeName: manifest.connections.cursor.name },
      { connectionId: manifest.connections.codex.connectionId, requestId: codexWork.requestId, dialogId: codexWorkDialog.dialogId, nodeId: codex.nodeId, title: codex.workTitle, nodeName: manifest.connections.codex.name }
    ]
  };
}

async function openSection(page, section) {
  const button = await unique(page.getByTestId(`nav-${section}`), `${section} navigation`);
  await button.click();
  await page.getByTestId(`screen-${section}`).waitFor();
}

async function assertTableRows(page, tableId, count, description) {
  const table = page.getByTestId(tableId);
  await poll(async () => {
    assert.equal(await table.count(), 1, `${description} must render exactly one list.`);
    assert.equal(await (tableId === 'history-list' ? table.locator(':scope > button[data-testid]') : table.locator('tbody > tr[data-testid]')).count(), count,
      `${description} must render exactly ${count} entity rows (group headers excluded).`);
  }, `${description} row count`);
  return table;
}

function assertExactIds(items, key, expected, description) {
  const actual = items.map((item) => item[key]);
  assert.equal(items.length, expected.length, `${description} count.`);
  assert.equal(new Set(actual).size, items.length, `${description} ${key} values must be unique.`);
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${description} identities.`);
}

function nodeFilterCategory(item) {
  if (item.identityStatus === 'node_id_conflict') return 'conflict';
  const observation = item.observation;
  if (observation.attemptedAt === null) return 'unknown';
  if (observation.httpReachable === false) return 'offline';
  if (observation.heartbeatFresh === false) return 'stale';
  if (observation.ready === true) return 'ready';
  if (observation.occupancy === 'active') return 'busy';
  return 'not-ready';
}

async function assertRealIntegration(first, second, manifest, expected) {
  const connections = await waitForProjection(first, '/api/connections', (items) => items.length === 2,
    'The isolated registry must contain exactly two connections.');
  assertExactIds(connections, 'id', [manifest.connections.cursor.connectionId, manifest.connections.codex.connectionId], 'Connections');
  assert.equal(new Set(connections.map((item) => item.endpointKey)).size, 2, 'Connection endpoint identities must be unique.');
  const nodes = await waitForProjection(first, '/api/projections/nodes',
    (items) => items.length === 2 && items.every((item) => item.observation?.nodeId),
    'Exactly two observed nodes must become available.', 60_000);
  assertExactIds(nodes.map((item) => ({ nodeId: item.observation.nodeId })), 'nodeId', [manifest.cursor.nodeId, manifest.codex.nodeId], 'Nodes');
  assert.ok(nodes.every((item) => item.identityStatus === 'unique'), 'Both real nodes must have unique executor identities.');
  assert.ok(nodes.every((item) => item.observation.availability === 'available'), 'Both real Harness APIs must be available.');
  assert.ok(nodes.every((item) => item.observation.executorHealthy === true), 'Both real Harness executors must be healthy.');
  assert.ok(nodes.every((item) => item.observation.heartbeatFresh === true), 'Both real Harness heartbeats must be fresh.');
  assert.ok(nodes.every((item) => ['idle', 'active', 'unknown'].includes(item.observation.occupancy)), 'Real occupancy must use the public idle/active/unknown contract.');
  const work = await waitForProjection(first, '/api/projections/work', (items) => items.length === 2,
    'Work must settle at exactly two persistent queued requests.');
  assertExactIds(work, 'requestId', expected.work.map((item) => item.requestId), 'Work');
  assert.ok(work.every((item) => item.status === 'queued'), 'Persistent Work fixtures must remain queued and never call a provider.');
  assert.ok(work.every((item) => item.title && item.nodeName), 'Work must expose human-readable title and node name.');
  const history = await waitForProjection(first, '/api/projections/history', (items) => items.length === 2,
    'History must retain exactly two request-level terminal rows.');
  assertExactIds(history, 'requestId', expected.terminal.map((item) => item.requestId), 'History');
  assert.equal(new Set(history.map((item) => item.dialogId)).size, 1, 'Both History rows must retain the same dialog without collapsing.');
  assert.ok(history.every((item) => item.status === 'cancelled'), 'Terminal fixtures must report their truthful status.');
  assert.ok(history.every((item) => item.title && item.nodeName), 'History must expose human-readable title and node name.');

  await assertTableRows(second, 'work-table', 2, 'Second-client Work table');
  for (const item of expected.work) await unique(second.getByTestId(workRowTestId(item)), `Work row ${item.requestId}`);
  await openSection(first, 'work');
  await assertTableRows(first, 'work-table', 2, 'Work table');
  for (const item of expected.work) {
    const row = await unique(first.getByTestId(workRowTestId(item)), `Work row ${item.requestId}`);
    const text = await row.innerText();
    assert.ok(text.includes(item.title), 'Work main table must show the request title.');
    assert.ok(text.includes(item.nodeName), 'Work main table must show the node name.');
    assert.ok(!text.includes(item.requestId) && !text.includes(item.nodeId), 'Work UUIDs belong in details, not the main table.');
  }
  const workItem = expected.work[0];
  const workButton = await unique(first.getByTestId(workRowTestId(workItem)).getByRole('button'), 'Work row action');
  await workButton.focus();
  await first.keyboard.press('Enter');
  const workInspector = await unique(first.getByTestId('work-inspector'), 'Work inspector');
  await workInspector.getByRole('heading', { name: 'Детали обращения', exact: true }).waitFor();
  await unique(workInspector.locator('details'), 'Work diagnostic disclosure').then((locator) => locator.locator('summary').click());
  assert.ok((await workInspector.innerText()).includes(workItem.requestId), 'Work inspector must expose request UUID in its diagnostic details.');
  assert.ok((await workInspector.innerText()).includes(workItem.nodeId), 'Work inspector must expose node UUID in its diagnostic details.');
  const workSearch = await unique(first.getByTestId('work-search'), 'Work search');
  await workSearch.fill('Cursor');
  await assertTableRows(first, 'work-table', 1, 'Filtered Work table');
  await workSearch.fill('');
  await unique(first.getByTestId('work-status'), 'Work status filter').then((locator) => locator.selectOption('queued'));
  await assertTableRows(first, 'work-table', 2, 'Status-filtered Work table');
  const workMetrics = await first.evaluate((rowTestId) => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    const screen = document.querySelector('[data-testid="screen-work"]');
    return {
      fontSize: screen ? Number.parseFloat(getComputedStyle(screen).fontSize) : null,
      sidebarWidth: rect('.sidebar')?.width,
      inspectorWidth: rect('[data-testid="work-inspector"]')?.width,
      rowHeight: rect(`[data-testid="${rowTestId}"]`)?.height
    };
  }, workRowTestId(workItem));
  assert.deepEqual(workMetrics, { fontSize: 13, sidebarWidth: 172, inspectorWidth: 460, rowHeight: 36 },
    'QHD Work must preserve the current compact 13/172/460/36 geometry.');
  await nonemptyScreenshot(first, 'real-01-work-qhd.png');

  await openSection(first, 'history');
  await assertTableRows(first, 'history-list', 2, 'History list');
  for (const item of expected.terminal) {
    const row = await unique(first.getByTestId(historyRowTestId({ ...item, nodeId: manifest.cursor.nodeId })), `History row ${item.requestId}`);
    const text = await row.innerText();
    assert.ok(text.includes(manifest.cursor.historyTitle), 'History main table must show the dialog title.');
    assert.ok(text.includes(manifest.connections.cursor.name), 'History main table must show the node name.');
    assert.ok(!text.includes(item.requestId) && !text.includes(item.dialogId), 'History UUIDs belong in details, not the main table.');
  }
  await unique(first.getByTestId(historyRowTestId({ ...expected.terminal[0], nodeId: manifest.cursor.nodeId })), 'History row action').then((locator) => locator.click());
  const historyInspector = await unique(first.getByTestId('history-inspector'), 'History inspector');
  await historyInspector.getByRole('heading', { level: 2 }).waitFor();
  await unique(historyInspector.locator('details'), 'History diagnostic disclosure').then((locator) => locator.locator('summary').click());
  assert.ok((await historyInspector.innerText()).includes(expected.terminal[0].requestId), 'History inspector must expose request UUID in its diagnostic details.');
  await unique(first.getByTestId('history-search'), 'History search').then((locator) => locator.fill('двух завершённых'));
  await assertTableRows(first, 'history-list', 2, 'Filtered History list');
  const historyStatus = await unique(first.getByTestId('history-status'), 'History status filter');
  await historyStatus.selectOption('cancelled');
  await assertTableRows(first, 'history-list', 2, 'Status-filtered History list');
  await unique(first.getByTestId('history-node'), 'History node filter').then((locator) => locator.selectOption(manifest.connections.cursor.connectionId));
  await assertTableRows(first, 'history-list', 2, 'Node-filtered History list');
  await first.getByTestId('history-search').fill('');
  await first.getByTestId('history-status').selectOption('all');
  await first.getByTestId('history-node').selectOption('all');
  await nonemptyScreenshot(first, 'real-02-history-qhd.png');

  await openSection(first, 'nodes');
  await assertTableRows(first, 'nodes-table', 2, 'Nodes table');
  for (const [key, fixture] of [['cursor', manifest.cursor], ['codex', manifest.codex]]) {
    const row = await unique(first.getByTestId(`node-row-${manifest.connections[key].connectionId}`), `${key} node row`);
    const text = await row.innerText();
    assert.ok(text.includes(manifest.connections[key].name), 'Nodes main table must show the configured node name.');
    assert.ok(text.includes(fixture.nodeId), 'Nodes table must show the confirmed Node ID.');
  }
  await unique(first.getByTestId(`node-row-${manifest.connections.cursor.connectionId}`), 'Node row action').then((locator) => locator.click());
  const nodeInspector = await unique(first.getByTestId('node-inspector'), 'Node inspector');
  await nodeInspector.getByRole('heading', { name: manifest.connections.cursor.name, exact: true }).waitFor();
  await unique(nodeInspector.locator('details'), 'Node diagnostic disclosure').then((locator) => locator.locator('summary').click());
  assert.ok((await nodeInspector.innerText()).includes(manifest.cursor.nodeId), 'Node inspector must expose node UUID in its diagnostic details.');
  await unique(first.getByTestId('nodes-search'), 'Nodes search').then((locator) => locator.fill('Cursor'));
  await assertTableRows(first, 'nodes-table', 1, 'Filtered Nodes table');
  const cursorNode = nodes.find((item) => item.connectionId === manifest.connections.cursor.connectionId);
  assert.ok(cursorNode, 'Cursor node must be present before filtering.');
  const realNodeState = nodeFilterCategory(cursorNode);
  await unique(first.getByTestId('nodes-state'), 'Nodes state filter').then((locator) => locator.selectOption(realNodeState));
  await assertTableRows(first, 'nodes-table', 1, 'State-filtered Nodes table');
  await first.getByTestId('nodes-search').fill('');
  await first.getByTestId('nodes-state').selectOption('all');
  await assertTableRows(first, 'nodes-table', 2, 'Restored Nodes table');
  await nonemptyScreenshot(first, 'real-03-nodes-qhd.png');

  await first.getByTestId('node-inspector').getByTestId('connection-name').waitFor();
  await nonemptyScreenshot(first, 'real-04-node-settings-qhd.png');
}

function observation(availability, now, overrides = {}) {
  const available = availability === 'available';
  const attemptedAt = availability === 'unknown' ? null : new Date(now - 5_000).toISOString();
  const heartbeatAt = availability === 'stale' ? new Date(now - 300_000).toISOString()
    : available ? new Date(now - 2_000).toISOString() : null;
  return {
    attemptedAt, successfulAt: available || availability === 'stale' ? attemptedAt : null,
    httpReachable: availability === 'unknown' ? null : availability !== 'unavailable',
    executorHealthy: availability === 'unknown' ? null : availability !== 'unavailable',
    ready: availability === 'unknown' ? null : available,
    capacity: available || availability === 'stale' ? '100' : null, heartbeatAt,
    heartbeatFresh: availability === 'unknown' ? null : available,
    bootId: availability === 'unknown' ? null : stableUuid(`boot-${availability}`),
    nodeId: availability === 'unknown' ? null : (overrides.nodeId ?? stableUuid(`node-${availability}`)),
    protocolVersion: availability === 'unknown' ? null : 1,
    schemaId: availability === 'unknown' ? null : 'harness-wire-v2', compatibility: availability === 'unknown' ? 'unknown' : 'compatible',
    availability, occupancy: availability === 'available' || availability === 'stale' ? 'idle' : 'unknown',
    errorCode: availability === 'unavailable' ? 'connection_failed' : null, ...overrides
  };
}

function controlledFixtures(now) {
  const connection = (suffix, name, availability) => ({
    id: stableUuid(`controlled-connection-${suffix}`), name, baseUri: `https://${suffix}.acceptance.invalid/harness/`,
    endpointKey: `https://${suffix}.acceptance.invalid/harness/`, identityStatus: 'unique', conflictingConnectionIds: [],
    configEpoch: 1, observationIntervalSeconds: 15, requestTimeoutSeconds: 5, staleThresholdSeconds: 45,
    observation: observation(availability, now, { nodeId: stableUuid(`controlled-${suffix}-node`) }),
    createdAt: new Date(now - 86_400_000).toISOString(), updatedAt: new Date(now - 5_000).toISOString()
  });
  const connections = [connection('ready', 'Основная нода', 'available'), connection('busy', 'Нода обработки', 'available'),
    connection('stale', 'Давно не отвечала', 'stale'), connection('offline', 'Недоступная нода', 'unavailable'),
    connection('unknown', 'Ожидает первой проверки', 'unknown'), connection('conflict', 'Конфликтующая нода', 'available')];
  connections[5].identityStatus = 'node_id_conflict';
  connections[5].conflictingConnectionIds = [connections[0].id, connections[5].id];
  connections[5].observation.nodeId = connections[0].observation.nodeId;
  connections[1].observation = observation('available', now,
    { nodeId: stableUuid('controlled-busy-node'), occupancy: 'active', ready: false, capacity: '100' });
  const nodes = connections.map((item) => ({
    connectionId: item.id, name: item.name, baseUri: item.baseUri, endpointKey: item.endpointKey,
    identityStatus: item.identityStatus, conflictingConnectionIds: item.conflictingConnectionIds, configEpoch: 1,
    occupancy: item.observation.occupancy, observation: item.observation
  }));
  const work = [
    { connectionId: connections[1].id, nodeId: nodes[1].observation.nodeId, nodeName: connections[1].name,
      requestId: stableUuid('controlled-active-request'), dialogId: stableUuid('controlled-active-dialog'), title: 'Синхронизация домашней лаборатории',
      status: 'active', version: 2, queueSequence: 1, attentionRequired: false, observedAt: new Date(now - 5_000).toISOString(),
      activeAttempt: { attemptId: stableUuid('controlled-attempt'), requestId: stableUuid('controlled-active-request'), state: 'running', effectStatus: 'none', generation: 1, version: 1, startedAt: new Date(now - 60_000).toISOString(), finishedAt: null } },
    { connectionId: connections[0].id, nodeId: nodes[0].observation.nodeId, nodeName: connections[0].name,
      requestId: stableUuid('controlled-queued-request'), dialogId: stableUuid('controlled-queued-dialog'), title: 'Проверка резервного копирования',
      status: 'queued', version: 1, queueSequence: 2, attentionRequired: false, observedAt: new Date(now - 5_000).toISOString(), activeAttempt: null },
    { connectionId: connections[2].id, nodeId: nodes[2].observation.nodeId, nodeName: connections[2].name,
      requestId: stableUuid('controlled-unknown-request'), dialogId: stableUuid('controlled-unknown-dialog'), title: 'Состояние требует проверки',
      status: 'unknown', version: 1, queueSequence: 3, attentionRequired: true, observedAt: new Date(now - 300_000).toISOString(), activeAttempt: null }
  ];
  const history = [
    { connectionId: connections[0].id, nodeId: nodes[0].observation.nodeId, nodeName: connections[0].name,
      requestId: stableUuid('controlled-completed-request'), dialogId: stableUuid('controlled-history-dialog'), title: 'Обновление контейнеров',
      status: 'completed', createdAt: new Date(now - 2_400_000).toISOString(), completedAt: new Date(now - 2_100_000).toISOString(),
      attempts: [{ attemptId: stableUuid('controlled-completed-attempt'), state: 'completed', effectStatus: 'known' }],
      messages: [{ messageId: stableUuid('controlled-completed-message'), role: 'user', sequence: 1, createdAt: new Date(now - 2_400_000).toISOString(), text: 'Обновить контейнеры', requestId: stableUuid('controlled-completed-request') }] },
    { connectionId: connections[1].id, nodeId: nodes[1].observation.nodeId, nodeName: connections[1].name,
      requestId: stableUuid('controlled-failed-request'), dialogId: stableUuid('controlled-failed-dialog'), title: 'Проверка дискового массива',
      status: 'failed', createdAt: new Date(now - 3_000_000).toISOString(), completedAt: new Date(now - 2_880_000).toISOString(),
      attempts: [{ attemptId: stableUuid('controlled-failed-attempt'), state: 'failed', effectStatus: 'unknown' }],
      messages: [{ messageId: stableUuid('controlled-failed-message'), role: 'user', sequence: 1, createdAt: new Date(now - 3_000_000).toISOString(), text: 'Проверить массив', requestId: stableUuid('controlled-failed-request') }] },
    { connectionId: connections[2].id, nodeId: nodes[2].observation.nodeId, nodeName: connections[2].name,
      requestId: stableUuid('controlled-cancelled-request'), dialogId: stableUuid('controlled-cancelled-dialog'), title: 'Отменённая диагностика',
      status: 'cancelled', createdAt: new Date(now - 3_600_000).toISOString(), completedAt: null, attempts: [],
      messages: [{ messageId: stableUuid('controlled-cancelled-message'), role: 'user', sequence: 1, createdAt: new Date(now - 3_600_000).toISOString(), text: 'Диагностика', requestId: stableUuid('controlled-cancelled-request') }] }
  ];
  return { connections, nodes, work, history };
}

async function installControlledRoutes(page, fixtures) {
  const state = { workMode: 'data', workRelease: null, counts: { connections: 0, nodes: 0, work: 0, workScoped: 0, history: 0 } };
  await page.route('**/api/connections', (route) => {
    state.counts.connections++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures.connections) });
  });
  await page.route('**/api/projections/nodes', (route) => {
    state.counts.nodes++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures.nodes) });
  });
  await page.route('**/api/projections/history', (route) => {
    state.counts.history++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures.history) });
  });
  await page.route('**/api/projections/work', async (route) => {
    state.counts.work++;
    if (state.workMode === 'error') {
      state.workMode = 'data';
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return;
    }
    if (state.workMode === 'blocked') {
      await new Promise((resolve) => { state.workRelease = resolve; });
      state.workMode = 'data';
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures.work) });
  });
  await page.route('**/api/projections/work/*', route => {
    state.counts.workScoped++;
    const url = new URL(route.request().url());
    const connectionId = url.pathname.split('/').at(-1);
    const item = fixtures.work.find(value => value.connectionId === connectionId && value.requestId === url.searchParams.get('requestId'));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      resource: 'work', connectionId, configEpoch: 1, revision: 7, listRevision: 1,
      lastObservedAt: new Date().toISOString(), syncedAt: new Date().toISOString(), item: item || null
    }) });
  });
  return state;
}

async function nonemptyScreenshot(page, filename) {
  const path = join(outputDir, filename);
  const qhd = filename.endsWith('-qhd.png');
  const image = await page.screenshot({ path, fullPage: !qhd });
  assert.ok((await stat(path)).size > 10_000, `${filename} must be a nonempty rendered screenshot.`);
  if (qhd) {
    assert.equal(image.readUInt32BE(16), 2560, `${filename} must be exactly 2560px wide.`);
    assert.equal(image.readUInt32BE(20), 1440, `${filename} must be exactly 1440px high.`);
  }
}

async function controlledUiSuite(browser) {
  const context = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets = [];
    function AcceptanceWebSocket(...args) { const socket = new NativeWebSocket(...args); sockets.push(socket); return socket; }
    AcceptanceWebSocket.prototype = NativeWebSocket.prototype;
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) AcceptanceWebSocket[key] = NativeWebSocket[key];
    Object.defineProperty(window, 'WebSocket', { value: AcceptanceWebSocket });
    Object.defineProperty(window, '__acceptanceSockets', { value: sockets });
  });
  const controlledNow = Date.now();
  const page = await context.newPage();
  // Freeze Date only; real timers must keep advancing so the Centrifugo
  // reconnect/backoff path remains a real browser interaction.
  await page.clock.setFixedTime(new Date(controlledNow));
  await login(context, page);
  const fixtures = controlledFixtures(controlledNow);
  const routeState = await installControlledRoutes(page, fixtures);
  routeState.settingsReads = 0;
  routeState.settingsRevision = 0;
  await page.route(/\/api\/connections\/[^/]+\/node-settings(?:\/[^?]*)?(?:\?.*)?$/, route => {
    const path = new URL(route.request().url()).pathname;
    const nodeId = new URL(route.request().url()).searchParams.get('nodeId');
    if (path.endsWith('/node-settings')) routeState.settingsReads++;
    const data = path.endsWith('/model-catalog')
      ? { ...modelCatalogFixture, nodeId }
      : { ...nodeSettingsFixture, nodeId, resourceRevision: routeState.settingsRevision };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.evaluate(() => {
    const banner = document.createElement('div');
    banner.dataset.testid = 'controlled-data-banner';
    banner.textContent = 'КОНТРОЛИРУЕМЫЕ ACCEPTANCE-ДАННЫЕ · page.route';
    Object.assign(banner.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
      padding: '7px 10px', background: '#fff4ce', border: '1px solid #b88700',
      color: '#5c4300', font: '600 12px/1.2 system-ui', pointerEvents: 'none'
    });
    document.body.appendChild(banner);
  });
  await openSection(page, 'work');
  await assertTableRows(page, 'work-table', 3, 'Controlled Work table');
  await page.getByText('Подключено', { exact: true }).waitFor();
  const beforeScopedEvent = { ...routeState.counts };
  const event = { schemaVersion: 1, resource: 'work', connectionId: fixtures.work[0].connectionId,
    nodeId: fixtures.work[0].nodeId, configEpoch: 1, entityId: fixtures.work[0].requestId,
    revision: 7, kind: 'request.updated', listRevision: 1 };
  const injectEvent = change => page.evaluate(payload => {
    const socket = window.__acceptanceSockets.find(candidate => candidate.readyState === WebSocket.OPEN);
    if (!socket) throw new Error('No connected realtime WebSocket for controlled invalidation.');
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ push: { channel: 'connections', pub: { data: payload } } }) + '\n' }));
  }, change);
  await injectEvent(event);
  await poll(async () => assert.equal(routeState.counts.workScoped, beforeScopedEvent.workScoped + 1),
    'A Work invalidation must fetch only its exact request');
  assert.equal(routeState.counts.work, beforeScopedEvent.work, 'Exact Work event must not refetch the collection.');
  await injectEvent(event);
  await injectEvent({ ...event, revision: 6 });
  await page.waitForTimeout(250);
  assert.equal(routeState.counts.workScoped, beforeScopedEvent.workScoped + 1, 'Duplicate and older events must not refetch.');
  const selectedButton = await unique(page.getByTestId(workRowTestId(fixtures.work[0])).getByRole('button'), 'Controlled selected Work action');
  await selectedButton.focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('work-inspector').waitFor();
  await poll(async () => assert.equal(await selectedButton.getAttribute('aria-pressed'), 'true'),
    'Selected Work row must expose pressed state');
  await unique(page.getByTestId('work-search'), 'Controlled Work search').then((locator) => locator.fill('Синхронизация'));
  await assertTableRows(page, 'work-table', 1, 'Controlled filtered Work table');

  routeState.workMode = 'blocked';
  await page.getByTestId('refresh-current').click();
  await poll(async () => assert.equal(typeof routeState.workRelease, 'function'), 'Blocked Work request must reach the route');
  routeState.workRelease();
  await poll(async () => {
    assert.equal(await page.getByTestId('work-search').inputValue(), 'Синхронизация', 'Filter must survive refetch.');
    assert.equal(await page.getByTestId(workRowTestId(fixtures.work[0])).getByRole('button').getAttribute('aria-pressed'), 'true',
      'Selection must survive refetch.');
  }, 'Filter and selection must survive refetch');

  const countsBeforeReconnect = { ...routeState.counts };
  await page.getByTestId(workRowTestId(fixtures.work[0])).getByRole('button').focus();
  await page.evaluate(() => {
    const open = window.__acceptanceSockets.find((socket) => socket.readyState === WebSocket.OPEN);
    if (!open) throw new Error('No connected realtime WebSocket was captured.');
    open.close(4000, 'acceptance reconnect');
  });
  await page.getByText('Переподключение…', { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText('Подключено', { exact: true }).waitFor({ timeout: 30_000 });
  const refetchedButton = page.getByTestId(workRowTestId(fixtures.work[0])).getByRole('button');
  await poll(async () => assert.ok(routeState.counts.work > countsBeforeReconnect.work),
    'Reconnect must refetch visible Work after the actual response');
  await poll(async () => {
    assert.equal(await refetchedButton.evaluate((element) => document.activeElement === element), true,
      'Focused row must survive realtime refetch.');
    assert.equal(await refetchedButton.getAttribute('aria-pressed'), 'true', 'Selection must survive reconnect.');
    assert.equal(await page.getByTestId('work-search').inputValue(), 'Синхронизация', 'Filter must survive reconnect.');
  }, 'Focus, selection, and filter must survive reconnect');
  assert.equal(routeState.counts.history - countsBeforeReconnect.history, 0, 'Reconnect must not fetch hidden History.');

  routeState.workMode = 'error';
  await page.getByTestId('refresh-current').click();
  await page.getByText('Не удалось загрузить данные. Сохранён предыдущий снимок.', { exact: true }).waitFor();
  await assertTableRows(page, 'work-table', 1, 'Work table after controlled error');
  await poll(async () => assert.equal(
    await page.getByTestId(workRowTestId(fixtures.work[0])).getByRole('button').getAttribute('aria-pressed'), 'true'),
  'Selection must survive a read error');
  await page.getByTestId('work-search').fill('');
  await page.getByTestId('refresh-current').click();
  await assertTableRows(page, 'work-table', 3, 'Recovered controlled Work table');
  await page.locator('.loading-line').waitFor({ state: 'hidden' });
  await page.locator('.banner.error').waitFor({ state: 'hidden' });
  await nonemptyScreenshot(page, 'controlled-01-work-qhd.png');

  await openSection(page, 'history');
  await assertTableRows(page, 'history-list', 3, 'Controlled History list');
  const controlledHistoryButton = page.getByTestId(historyRowTestId(fixtures.history[0]));
  await controlledHistoryButton.click();
  await poll(async () => assert.equal(await controlledHistoryButton.getAttribute('aria-pressed'), 'true'),
    'Controlled History selection must render before screenshot');
  await unique(page.getByTestId('history-inspector').locator('details'), 'Controlled History details');
  await nonemptyScreenshot(page, 'controlled-02-history-qhd.png');
  await openSection(page, 'nodes');
  await assertTableRows(page, 'nodes-table', 6, 'Controlled Nodes table');
  const nodesText = await page.getByTestId('nodes-table').innerText();
  for (const label of ['Ожидает проверки', 'Готово', 'Устарело', 'Недоступно']) {
    assert.ok(nodesText.includes(label), `Controlled Nodes must render state: ${label}`);
  }
  for (const label of ['Приём закрыт', 'Конфликт идентичности']) {
    assert.ok(nodesText.includes(label), `Controlled Nodes must render readiness/identity state: ${label}`);
  }
  const readyNodeText = await page.getByTestId(`node-row-${fixtures.nodes[0].connectionId}`).innerText();
  assert.ok(readyNodeText.includes('Готово'), 'Ready fixture must show a ready state in Nodes.');
  const busyNodeText = await page.getByTestId(`node-row-${fixtures.nodes[1].connectionId}`).innerText();
  assert.ok(busyNodeText.includes('Приём закрыт'), 'Busy fixture must be closed to new work in Nodes.');
  assert.ok((await page.getByTestId(`node-row-${fixtures.nodes[3].connectionId}`).innerText()).includes('Недоступно'),
    'Unavailable fixture must show the unavailable state.');
  const controlledNodeButton = page.getByTestId(`node-row-${fixtures.nodes[0].connectionId}`);
  await controlledNodeButton.click();
  await poll(async () => assert.equal(await controlledNodeButton.getAttribute('aria-selected'), 'true'),
    'Controlled Node selection must render before screenshot');
  const keyboardNode = page.getByTestId(`node-row-${fixtures.nodes[1].connectionId}`);
  await keyboardNode.focus();
  await page.keyboard.press('Enter');
  await poll(async () => assert.equal(await keyboardNode.getAttribute('aria-selected'), 'true'),
    'Enter must select the whole Node row');
  await controlledNodeButton.focus();
  await page.keyboard.press('Space');
  await poll(async () => assert.equal(await controlledNodeButton.getAttribute('aria-selected'), 'true'),
    'Space must select the whole Node row');
  await page.getByTestId('open-agent-settings').click();
  const popup = page.getByTestId('settings-popup');
  await popup.waitFor();
  const agentSettingsShot = join(outputDir, 'controlled-agent-settings.png');
  await popup.screenshot({ path: agentSettingsShot });
  assert.ok((await stat(agentSettingsShot)).size > 10_000, 'Agent settings screenshot must be nonempty.');
  await page.setViewportSize({ width: 640, height: 360 });
  const agentBounds = await popup.boundingBox();
  assert.ok(agentBounds && agentBounds.x >= 0 && agentBounds.x + agentBounds.width <= 640
    && agentBounds.y >= 0 && agentBounds.y + agentBounds.height <= 360,
  'Agent settings popup must fit the effective CSS viewport at 200% zoom.');
  const compactAgentSettingsShot = join(outputDir, 'controlled-agent-settings-640.png');
  await popup.screenshot({ path: compactAgentSettingsShot });
  assert.ok((await stat(compactAgentSettingsShot)).size > 10_000, 'Compact agent settings screenshot must be nonempty.');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileAgentSettingsShot = join(outputDir, 'controlled-agent-settings-390.png');
  await popup.screenshot({ path: mobileAgentSettingsShot });
  assert.ok((await stat(mobileAgentSettingsShot)).size > 10_000, 'Mobile agent settings screenshot must be nonempty.');
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.getByTestId('node-speed-options').getByText('Быстрая', { exact: true }).click();
  await page.keyboard.press('Escape');
  await popup.getByRole('group', { name: 'Несохранённые изменения' }).waitFor();
  await popup.getByRole('button', { name: 'Продолжить редактирование' }).click();
  assert.equal(await page.getByTestId('node-speed').isChecked(), true, 'Dirty speed selection must survive a cancelled close.');
  await popup.getByRole('button', { name: 'Закрыть настройки' }).click();
  await popup.getByRole('button', { name: 'Закрыть без сохранения' }).click();
  await page.getByTestId('open-mcp-settings').click();
  await page.getByTestId('mcp-json-editor').fill('{ invalid json');
  await page.getByTestId('mcp-validate').click();
  await popup.getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('mcp-json-editor').inputValue(), '{ invalid json', 'Malformed JSON must remain editable.');
  const beforeSettingsEvent = routeState.settingsReads;
  routeState.settingsRevision = 1;
  await injectEvent({ schemaVersion: 1, resource: 'node_settings', connectionId: fixtures.connections[0].id,
    nodeId: fixtures.nodes[0].observation.nodeId, configEpoch: 1, entityId: fixtures.nodes[0].observation.nodeId,
    revision: 1, kind: 'changed' });
  await poll(async () => assert.equal(routeState.settingsReads, beforeSettingsEvent + 1),
    'Selected settings event must read only the current node');
  assert.equal(await page.getByTestId('mcp-json-editor').inputValue(), '{ invalid json',
    'Settings readback must preserve the dirty MCP editor.');
  await injectEvent({ schemaVersion: 1, resource: 'node_settings', connectionId: fixtures.connections[1].id,
    nodeId: fixtures.nodes[1].observation.nodeId, configEpoch: 1, entityId: fixtures.nodes[1].observation.nodeId,
    revision: 1, kind: 'changed' });
  await page.waitForTimeout(250);
  assert.equal(routeState.settingsReads, beforeSettingsEvent + 1, 'Other-node settings event must not read this editor.');
  await page.setViewportSize({ width: 640, height: 360 });
  const bounds = await popup.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 640 && bounds.y >= 0 && bounds.y + bounds.height <= 360,
    'Popup must fit the effective CSS viewport at 200% zoom.');
  await popup.getByRole('button', { name: 'Закрыть настройки' }).click();
  await popup.getByRole('button', { name: 'Закрыть без сохранения' }).click();
  await page.setViewportSize({ width: 2560, height: 1440 });
  await unique(page.getByTestId('node-inspector').locator('details'), 'Controlled Node details');
  await nonemptyScreenshot(page, 'controlled-03-nodes-qhd.png');
  const connectionsText = await page.getByTestId('nodes-table').innerText();
  assert.ok(connectionsText.includes('Конфликт идентичности'),
    'Controlled Nodes must show the identity conflict explicitly.');
  await page.getByTestId('node-inspector').getByTestId('connection-name').waitFor();
  await nonemptyScreenshot(page, 'controlled-04-node-settings-qhd.png');

  await page.setViewportSize({ width: 390, height: 844 });
  for (const section of ['work', 'history', 'nodes']) {
    await openSection(page, section);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390,
      `${section} must not overflow the 390px document width.`);
    if (section === 'work') await nonemptyScreenshot(page, 'controlled-05-work-390.png');
  }
  assertNoPageErrors(page, 'Controlled UI page');
  await context.close();
}

const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP localhost host.docker.internal'] });
try {
  if (process.env.ACCEPTANCE_CONTROLLED_ONLY === 'true') {
    await controlledUiSuite(browser);
    console.log('PASS: controlled browser UI, agent settings interactions and responsive screenshots.');
  } else {
  const manifest = await loadManifest();
  const anonymous = await browser.newContext();
  const unauthorized = await anonymous.request.get(`${apiBaseUrl}/api/connections`);
  assert.equal(unauthorized.status(), 401, 'Unauthenticated Gateway request must return 401.');
  await anonymous.close();

  const firstContext = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
  const secondContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const first = await login(firstContext);
  const second = await login(secondContext);
  diagnosticPage = first;
  await registerConnectionConcurrently(first, manifest, 'cursor');
  await registerConnectionConcurrently(first, manifest, 'codex');
  await waitForProjection(first, '/api/projections/nodes',
    (items) => items.length === 2 && items.every((item) => item.identityStatus === 'unique' && item.observation?.nodeId),
    'Both registered Harness executors must be observed exactly once.', 60_000);
  await assertNativeSettingsContracts(first, manifest);
  await assertCodexModeOnlyApply(first, manifest);
  await controlledUiSuite(browser);
  await openSection(second, 'work');
  const expected = await ensureHarnessFixtures(first, manifest);
  await assertRealIntegration(first, second, manifest, expected);

  await registerConnectionConcurrently(first, manifest, 'cursor');
  await registerConnectionConcurrently(first, manifest, 'codex');
  assert.equal((await apiJson(first, '/api/connections')).length, 2, 'Repeated registration must not accumulate connections.');
  assert.equal((await apiJson(first, '/api/projections/work')).length, 2, 'Repeated fixture replay must not accumulate Work.');
  assert.equal((await apiJson(first, '/api/projections/history')).length, 2, 'Repeated fixture replay must not accumulate History.');

  diagnosticPage = second;
  await second.getByRole('button', { name: 'Выйти', exact: true }).click();
  await second.getByRole('button', { name: 'Войти', exact: true }).waitFor();
  diagnosticPage = first;
  await first.evaluate(() => {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith('oidc.user:')) continue;
      const value = JSON.parse(sessionStorage.getItem(key));
      value.expires_at = 1;
      sessionStorage.setItem(key, JSON.stringify(value));
    }
  });
  await first.reload({ waitUntil: 'networkidle' });
  await poll(async () => assert.ok(
    await first.getByRole('button', { name: 'Войти', exact: true }).isVisible() ||
    await first.getByTestId('screen-work').isVisible()),
  'Expired local session must either renew or request login');
  assertNoPageErrors(first, 'Primary integration page');
  assertNoPageErrors(second, 'Secondary integration page');
  await firstContext.close();
  await secondContext.close();
  console.log('PASS: isolated exact-cardinality lifecycle, concurrent registration idempotency, request-level History, realtime refetch, retained UI state, separate real and clearly-labelled controlled mixed-state screenshots, auth and 390px layout; zero provider calls.');
  }
} catch (error) {
  const redact = (value) => String(value)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/(authorization|access_token|refresh_token)["'=:\s]+[^\s,"'}]+/gi, '$1=[redacted]');
  console.error(`ACCEPTANCE FAILURE: ${redact(error?.stack ?? error)}`);
  if (diagnosticPage && !diagnosticPage.isClosed()) {
    try {
      await diagnosticPage.screenshot({ path: join(outputDir, 'failure.png'), fullPage: true });
      console.error(`Visible page at failure (${redact(diagnosticPage.url())}):\n${redact((await diagnosticPage.locator('body').innerText()).slice(0, 2400))}`);
      const runtimeErrors = pageErrors.get(diagnosticPage) ?? [];
      if (runtimeErrors.length) console.error(`Browser runtime errors:\n${runtimeErrors.map(redact).join('\n---\n')}`);
    } catch (diagnosticError) {
      console.error(`Could not capture failure page: ${redact(diagnosticError?.message ?? diagnosticError)}`);
    }
  }
  throw error;
} finally {
  await browser.close();
}
