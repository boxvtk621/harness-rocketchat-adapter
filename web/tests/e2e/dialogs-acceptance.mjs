import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project ?? '', /^hl307-[a-z0-9-]+$/);
assert.equal(process.env.ACCEPTANCE_ISOLATED, 'true');
const base = process.env.BASE_URL;
const apiBase = process.env.API_BASE_URL;
const authBlocked = process.env.EXPECT_PROVIDER_AUTH_BLOCKED === 'true';
for (const url of [base, apiBase]) assert.ok(['localhost', 'host.docker.internal', '127.0.0.1'].includes(new URL(url).hostname));
const out = process.env.OUTPUT_DIR ?? '/output';
await mkdir(out, { recursive: true });
const password = (await readFile(process.env.DEV_USER_PASSWORD_FILE, 'utf8')).trim();
const uuid = label => {
  const bytes = createHash('sha256').update(`${project}:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};
const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP localhost host.docker.internal'] });
const context = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
const page = await context.newPage();
const errors = [];
const fences = new Map();
page.on('pageerror', error => errors.push(error.message));
async function poll(fn, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (true) {
    try { return await fn(); } catch (error) {
      if (Date.now() > deadline) throw new Error(`${label}: ${error.message}`);
      await page.waitForTimeout(300);
    }
  }
}
async function api(method, path, data) {
  const token = await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(k => k.startsWith('oidc.user:'));
    return key ? JSON.parse(sessionStorage.getItem(key)).access_token : null;
  });
  assert.ok(token);
  const nodeId = path.match(/\/nodes\/([^/]+)/)?.[1];
  return page.request.fetch(apiBase + path, { method, headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? fences.get(nodeId) : {}) }, data });
}
async function json(path) {
  const response = await api('GET', path);
  assert.equal(response.status(), 200, `GET ${path} failed (${response.status()})`);
  return response.json();
}
const fixtures = [];
try {
  assert.equal((await context.request.get(apiBase + '/api/dialogs/missing/nodes/' + uuid('anonymous') + '/dialogs?configEpoch=1')).status(), 401);
  await poll(async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Войти', exact: true }).waitFor({ timeout: 3000 });
  }, 'SPA ready');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.locator('#username').fill('operator');
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await page.getByTestId('screen-work').waitFor({ timeout: 45000 });
  const existingConnections = await json('/api/connections');
  for (const name of ['cursor', 'codex']) {
    if (existingConnections.some(connection => connection.baseUri === `https://${name}-harness:8443/`)) continue;
    const response = await api('POST', '/api/connections', { name: `${name} · проверка HL-307`, baseUri: `https://${name}-harness:8443/`, observationIntervalSeconds: 2, requestTimeoutSeconds: 5, staleThresholdSeconds: 15 });
    assert.ok([200,201].includes(response.status()), `Connection registration failed: ${response.status()} ${await response.text()}`);
  }
  const nodes = await poll(async () => {
    const value = await json('/api/projections/nodes');
    assert.equal(value.length, 2);
    assert.ok(value.every(n => n.observation.ready === !authBlocked && n.identityStatus === 'unique'));
    return value;
  }, 'Two actual Harness nodes ready');
  for (const node of nodes) {
    const root = `/api/dialogs/${node.connectionId}/nodes/${node.observation.nodeId}`;
    const q = `configEpoch=${node.configEpoch}`;
    const identity = await json(`${root}/identity?${q}`);
    fences.set(identity.nodeId, {
      'X-Harness-Expected-Node-ID': identity.nodeId,
      'X-Harness-Expected-Registry-Version': String(identity.registryVersion),
      'X-Harness-Expected-Identity-Epoch': String(identity.identityEpoch),
      'X-Harness-Expected-Adapter-Kind': identity.adapter.kind,
      'X-Harness-Expected-Adapter-Version': identity.adapter.version
    });
    const create = { protocolVersion: 1, schemaId: 'harness-wire-v2', commandId: uuid(`${node.observation.nodeId}:create`), kind: 'dialog.create', target: { nodeId: node.observation.nodeId }, expected: { registryVersion: identity.registryVersion }, payload: { title: `HL-307 · ${node.name} · очередь без модели` } };
    if (authBlocked) {
      const prior = await json(`${root}/commands/${create.commandId}?${q}`);
      assert.equal(prior.status, 'accepted');
      const dialogId = prior.receipt.references.dialogId;
      const history = await json(`${root}/dialogs/${dialogId}/history?${q}&order=latest&limit=10`);
      assert.equal(history.items.length, 2);
      const requests = await json(`${root}/requests?${q}&dialogId=${dialogId}&limit=30`);
      assert.equal(requests.items.length, 2);
      assert.ok(requests.items.every(request => request.status === 'queued'));
      const rejected = await api('POST', `${root}/commands?${q}`, { ...create, commandId: uuid(`${node.observation.nodeId}:auth-blocked-create`) });
      assert.equal(rejected.status(), 503);
      assert.equal((await rejected.json()).code, 'node_not_ready');
      fixtures.push({ node, root, q, dialogId, requests: requests.items });
      continue;
    }
    const created = await api('POST', `${root}/commands?${q}`, create);
    assert.ok([200,202].includes(created.status()), `Create failed: ${created.status()}`);
    const receipt = await created.json();
    const repeated = await api('POST', `${root}/commands?${q}`, create);
    assert.equal(repeated.status(), 200);
    assert.deepEqual(await repeated.json(), receipt);
    const dialogId = receipt.references.dialogId;
    for (let index = 0; index < 2; index++) {
      const command = { protocolVersion: 1, schemaId: 'harness-wire-v2', commandId: uuid(`${node.observation.nodeId}:message:${index}`), kind: 'message.enqueue', target: { nodeId: node.observation.nodeId, dialogId }, expected: { dialogVersion: index + 1 }, payload: { text: `Тестовая очередь ${index + 1}. Исполнение модели отключено в этом контуре.` } };
      const responses = await Promise.all([api('POST', `${root}/commands?${q}`, command), api('POST', `${root}/commands?${q}`, command)]);
      for (const response of responses) assert.ok([200,202].includes(response.status()));
      const receipts = await Promise.all(responses.map(r => r.json()));
      assert.deepEqual(receipts[0], receipts[1]);
      const status = await json(`${root}/commands/${command.commandId}?${q}`);
      assert.deepEqual(status.receipt, receipts[0]);
      assert.equal(status.status, 'accepted');
      assert.equal((await api('POST', `${root}/commands?${q}`, { ...command, payload: { text: 'Different payload must never execute' } })).status(), 409);
    }
    const history = await json(`${root}/dialogs/${dialogId}/history?${q}&order=latest&limit=1`);
    assert.equal(history.items.length, 1); assert.ok(history.nextCursor);
    const older = await json(`${root}/dialogs/${dialogId}/history?${q}&order=latest&limit=1&cursor=${encodeURIComponent(history.nextCursor)}`);
    assert.equal(older.items.length, 1); assert.ok(older.items[0].sequence < history.items[0].sequence);
    const requests = await json(`${root}/requests?${q}&dialogId=${dialogId}&limit=30`);
    assert.equal(requests.items.length, 2);
    assert.ok(requests.items.every(r => r.status === 'queued'));
    assert.notEqual(requests.items[0].queueSequence, requests.items[1].queueSequence);
    assert.equal((await api('POST', `${root}/commands?configEpoch=${node.configEpoch + 1}`, create)).status(), 409);
    const stale = { ...create, commandId: uuid(`${node.observation.nodeId}:stale`), kind: 'message.enqueue', target: { nodeId: node.observation.nodeId, dialogId }, expected: { dialogVersion: 1 }, payload: { text: 'stale version' } };
    assert.equal((await api('POST', `${root}/commands?${q}`, stale)).status(), 409);
    fixtures.push({ node, root, q, dialogId, requests: requests.items });
  }
  await writeFile(join(out, authBlocked ? 'dialogs-auth-blocked-evidence.json' : 'dialogs-real-api-evidence.json'), JSON.stringify({ providerCalls: 0, mode: authBlocked ? 'integrated provider auth: retained history and rejected new commands' : 'actual Harness persisted queue / manual dispatch', fixtures }, null, 2));
  await page.getByTestId('nav-dialogs').click();
  await page.getByTestId('screen-dialogs').waitFor();
  await page.getByTestId(`dialog-row-${fixtures[0].dialogId}`).click();
  await page.getByTestId('message-input').waitFor();
  if (authBlocked) {
    await page.getByTestId('message-input').fill('Blocked draft must not be submitted');
    assert.ok(await page.getByTestId('send-message').isDisabled());
  }
  const screenshotPrefix = authBlocked ? 'dialogs-real-auth-blocked' : 'dialogs-real-queue';
  await page.screenshot({ path: join(out, `${screenshotPrefix}-qhd.png`), fullPage: true });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '13px');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: join(out, `${screenshotPrefix}-390.png`), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(authBlocked ? 'PASS integrated Harness auth: two nodes, persisted receipts/history/queue, rejected new commands; provider calls=0.' : 'PASS actual Harness API: two nodes, exact replay/concurrent enqueue, payload conflict, stale versions, persisted bounded history, existing queue; provider calls=0.');
} catch (error) {
  await page.screenshot({ path: join(out, 'dialogs-failure.png'), fullPage: true }).catch(() => {});
  console.error(String(error.message));
  throw error;
} finally { await browser.close(); }
