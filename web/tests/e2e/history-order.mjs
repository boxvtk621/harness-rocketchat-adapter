// Run in the e2e Docker image with CLIENT_DIST and OUTPUT_DIR pointing at mounted artifacts.
// Controlled public DTO fixtures; no provider calls or real credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';

const out = process.env.OUTPUT_DIR;
await mkdir(out, { recursive: true });
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    const file = path === '/' ? 'index.html' : path.slice(1);
    const body = await readFile(join(process.env.CLIENT_DIST, file));
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Europe/Astrakhan' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const row = (id, time, extra = {}) => ({
  connectionId: 'one', nodeId: 'node-a', nodeName: 'Codex · тест', dialogId: 'dialog', requestId: id,
  requestTitle: `Обращение ${id}`, title: 'Проверка истории', status: 'completed',
  createdAt: '2026-09-23T23:59:00Z', completedAt: time, dialogVersion: 1, messages: [], result: `Ответ ${id}`, ...extra
});
let data = [row('old', '2026-09-22T08:47:00Z'), row('tie-b', '2026-09-23T09:39:00Z'),
  row('missing', null), row('middle', '2026-09-22T23:00:00Z', { connectionId: 'two', nodeId: 'node-b', status: 'failed' }),
  row('tie-a', '2026-09-23T13:39:00+04:00')];
let fetches = 0, socket;
await page.addInitScript(() => {
  sessionStorage.setItem('oidc.user:http://localhost:18180/realms/harness:harness-web', JSON.stringify({
    access_token: 'fixture-only', token_type: 'Bearer', profile: { sub: 'fixture', preferred_username: 'UI fixture' },
    expires_at: Math.floor(Date.now() / 1000) + 3600
  }));
});
await page.route('**/api/**', route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/session') return route.fulfill({ json: { canManageConnections: false } });
  if (path === '/api/connections') return route.fulfill({ json: ['one', 'two'].map(id => ({ id, name: id, configEpoch: 1 })) });
  if (path === '/api/realtime/token') return route.fulfill({ json: { token: 'fixture' } });
  if (path === '/api/projections/history') { fetches++; return route.fulfill({ json: data }); }
  if (path === '/api/projections/nodes') return route.fulfill({ json: ['one', 'two'].map(connectionId => ({
    connectionId, name: connectionId, configEpoch: 1, observation: { nodeId: connectionId === 'one' ? 'node-a' : 'node-b' }
  })) });
  if (path.startsWith('/api/dialogs/')) return route.fulfill({ json: { items: [], nextCursor: null } });
  return route.fulfill({ json: [] });
});
await page.routeWebSocket('**/realtime/connection/websocket', ws => {
  socket = ws;
  ws.onMessage(message => {
    for (const line of String(message).split('\n')) {
      const command = JSON.parse(line);
      if (command.connect) ws.send(JSON.stringify({ id: command.id, connect: { client: 'fixture', version: '5' } }));
      if (command.subscribe) ws.send(JSON.stringify({ id: command.id, subscribe: {} }));
    }
  });
});
const rows = page.locator('[data-testid^="history-row-"]');
async function poll(check) {
  const until = Date.now() + 10000;
  while (true) { try { return await check(); } catch (error) { if (Date.now() > until) throw error; await page.waitForTimeout(50); } }
}
async function order(ids) {
  await poll(async () => assert.deepEqual(await rows.locator('strong').allTextContents(), ids.map(id => `Обращение ${id}`)));
}
try {
  await page.goto(base);
  await page.getByTestId('nav-history').click();
  await order(['tie-a', 'tie-b', 'middle', 'old', 'missing']);
  await rows.nth(1).click();
  await poll(async () => assert.equal(await page.getByTestId('history-request-title').innerText(), 'Обращение tie-b'));
  await page.getByTestId('history-status').selectOption('failed');
  await order(['middle']);
  await page.getByTestId('history-status').selectOption('all');
  await page.getByTestId('history-node').selectOption('one');
  await order(['tie-a', 'tie-b', 'old', 'missing']);
  await page.getByTestId('history-node').selectOption('all');
  await page.getByTestId('history-search').fill('tie');
  await order(['tie-a', 'tie-b']);
  data.reverse();
  const beforeManual = fetches;
  await page.getByTestId('refresh-current').click();
  await poll(() => assert.ok(fetches > beforeManual));
  await order(['tie-a', 'tie-b']);
  await page.getByTestId('history-search').fill('');
  await order(['tie-a', 'tie-b', 'middle', 'old', 'missing']);
  const before = fetches;
  data.push(row('newest', '2026-09-23T10:00:00Z'));
  await poll(() => assert.ok(socket));
  socket.send(JSON.stringify({ push: { channel: 'connections', pub: { data: { resource: 'history' } } } }));
  await poll(() => assert.ok(fetches > before));
  await order(['newest', 'tie-a', 'tie-b', 'middle', 'old', 'missing']);
  assert.equal(await page.getByTestId('history-request-title').innerText(), 'Обращение tie-b');
  await poll(async () => assert.ok((await page.getByTestId('history-tools').innerText()).includes('инструменты не использовались')));
  await page.screenshot({ path: join(out, 'history-desc-desktop.png'), fullPage: true });
  await page.reload();
  await page.getByTestId('nav-history').click();
  await order(['newest', 'tie-a', 'tie-b', 'middle', 'old', 'missing']);
  // Legacy grouped DTOs are flattened before sorting, with the same request key.
  data = [{ ...row('group', null), completedRequests: [row('old', '2026-09-22T08:47:00Z'), row('tie-b', '2026-09-23T09:39:00Z')].map(item => ({ ...item, title: item.requestTitle })) },
    row('tie-a', '2026-09-23T09:39:00Z')];
  await page.getByTestId('refresh-current').click();
  await order(['tie-a', 'tie-b', 'old']);
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'history-order.json'), JSON.stringify({ passed: true, fetches, checks: [
    'DESC completedAt across two days', 'equal instant with different offsets uses stable key', 'missing timestamp last',
    'status/node/search filters', 'reversed input on refetch', 'realtime inserts newest without duplicates',
    'selected details retained', 'reload', 'grouped requests flattened before sorting', 'no browser runtime errors'
  ] }, null, 2));
  console.log('History ordering: all checks passed');
} catch (error) {
  await page.screenshot({ path: join(out, 'history-order-failure.png'), fullPage: true });
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
