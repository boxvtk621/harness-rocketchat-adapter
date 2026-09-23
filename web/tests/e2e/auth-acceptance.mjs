import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import { chromium } from 'playwright';

assert.equal(process.env.ACCEPTANCE_ISOLATED, 'true');
assert.match(process.env.COMPOSE_PROJECT_NAME ?? '', /^hl306-/);
const base = process.env.BASE_URL;
const apiBase = process.env.API_BASE_URL;
const output = process.env.OUTPUT_DIR ?? '/output';
const password = (await readFile('/run/secrets/keycloak_dev_user_password', 'utf8')).trim();
const viewerPassword = (await readFile('/run/secrets/keycloak_dev_viewer_password', 'utf8')).trim();
const ca = await readFile('/run/config/harness_server_cert');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP localhost host.docker.internal'] });
const context = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
const errors = [];
async function poll(fn, milliseconds = 40000) {
  const end = Date.now() + milliseconds;
  while (true) { try { return await fn(); } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 400)); } }
}
async function login(ctx, username, secret) {
  await poll(async () => {
    assert.equal((await ctx.request.get('http://keycloak:8080/realms/harness/.well-known/openid-configuration', { timeout: 5000 })).status(), 200);
    assert.equal((await ctx.request.get('http://adapter:8080/health/ready', { timeout: 5000 })).status(), 200);
  }, 120000);
  const page = await ctx.newPage(); page.on('pageerror', error => errors.push(error.message));
  await poll(async () => { await page.goto(base); await page.getByRole('button', { name: 'Войти', exact: true }).waitFor({ timeout: 3000 }); }, 120000);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.locator('#username').fill(username); await page.locator('#password').fill(secret); await page.locator('#kc-login').click();
  // A realm imported before profile names were supplied may require this once.
  if (username === 'observer') {
    try {
      await page.locator('#firstName').waitFor({ timeout: 4000 });
      await page.locator('#firstName').fill('Local'); await page.locator('#lastName').fill('Observer');
      await page.locator('input[type="submit"],button[type="submit"]').click();
    } catch { /* Already complete profiles go directly to the SPA. */ }
  }
  await page.getByTestId('screen-work').waitFor({ timeout: 45000 }); return page;
}
async function api(page, method, path, data) {
  const token = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('oidc.user:')).map(key => JSON.parse(sessionStorage.getItem(key)).access_token)[0]);
  assert.ok(token);
  try { return await page.request.fetch(apiBase + path, { method, headers: { authorization: 'Bearer ' + token }, data }); }
  catch { throw new Error('Authenticated test request failed (details suppressed).'); }
}
async function json(page, path) { const response = await api(page, 'GET', path); assert.equal(response.status(), 200); return response.json(); }
async function control(status, operationId) {
  return new Promise((resolve, reject) => {
    const req = https.request('https://auth-fixture:8443/fixture/control', { method: 'POST', ca, headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject); req.end(JSON.stringify({ status, operationId }));
  });
}
async function select(page, id, section = 'nodes') {
  await page.getByTestId('nav-' + section).click();
  await page.getByTestId('node-row-' + id).getByRole('button').click();
  await page.getByTestId('provider-auth-state').waitFor();
}
const evidence = { type: 'controlled-provider-through-real-Adapter-Gateway-Keycloak', realProviderLogin: false, checks: [] };
let page;
try {
  page = await login(context, 'operator', password);
  assert.equal((await json(page, '/api/session')).canManageConnections, true);
  const registration = await api(page, 'POST', '/api/connections', { name: 'Тест авторизации (контролируемый)', baseUri: 'https://auth-fixture:8443/fixture?tenant=auth', observationIntervalSeconds: 2, requestTimeoutSeconds: 5, staleThresholdSeconds: 10 });
  assert.ok([200, 201].includes(registration.status()));
  let connection = await registration.json();
  connection = await poll(async () => { const c = await json(page, '/api/connections/' + connection.id); assert.equal(c.identityStatus, 'unique'); return c; });
  const nodeId = connection.observation.nodeId;
  const route = '/api/connections/' + connection.id + '/provider-auth';
  const suffix = '?configEpoch=' + connection.configEpoch;
  const getRoute = route + suffix + '&nodeId=' + nodeId;
  const post = (action, extra = {}) => api(page, 'POST', route + '/' + action + suffix, { nodeId, commandId: randomUUID(), ...extra });
  let current = await json(page, getRoute);
  const oversized = await post('operations', { method: 'secret', secret: 'x'.repeat(40000) });
  assert.equal(oversized.status(), 413, 'oversized credential body rejected at the Web boundary');
  if (current.operation?.status === 'pending') await post('operations/' + current.operation.operationId + '/cancel');
  if (current.state === 'authenticated') await post('logout');
  await select(page, connection.id);
  await page.getByTestId('provider-secret').fill('synthetic-invalid');
  await page.getByTestId('provider-start-secret').click();
  await poll(async () => assert.ok(await page.getByTestId('provider-secret').count() === 0 || await page.getByTestId('provider-secret').inputValue() === ''));
  await poll(async () => assert.equal(await page.getByTestId('provider-operation-state').innerText(), 'Не завершена'));
  assert.equal(await page.getByTestId('provider-secret').inputValue(), '');
  assert.equal((await json(page, getRoute)).state, 'unauthenticated');
  evidence.checks.push('invalid secret, write-only field cleared, no false authentication');
  await page.getByTestId('provider-secret').fill('synthetic-valid');
  await page.getByTestId('provider-start-secret').click();
  await poll(async () => assert.equal(await page.getByTestId('provider-auth-state').innerText(), 'Аккаунт подключён'));
  await page.screenshot({ path: output + '/auth-secret-qhd.png', fullPage: true });
  const authResponse = await api(page, 'GET', getRoute);
  assert.ok(authResponse.headers()['cache-control'].includes('no-store'));
  assert.ok(!(await authResponse.text()).includes('synthetic-valid'));
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.ok(!storage.includes('synthetic-valid') && !storage.includes('TEST-CODE'));
  await page.getByTestId('provider-logout').click();
  assert.equal((await json(page, getRoute)).state, 'authenticated', 'logout needs confirmation');
  await page.getByTestId('provider-confirm-logout').click();
  await poll(async () => assert.equal(await page.getByTestId('provider-auth-state').innerText(), 'Вход не выполнен'));
  evidence.checks.push('synthetic success, secret absent in API/storage, confirmed logout');

  const commandId = randomUUID();
  const startBody = { nodeId, commandId, method: 'device_code' };
  const first = await api(page, 'POST', route + '/operations' + suffix, startBody);
  const started = await first.json(); assert.equal(started.operation.status, 'pending');
  const replay = await api(page, 'POST', route + '/operations' + suffix, startBody);
  assert.equal((await replay.json()).operation.operationId, started.operation.operationId);
  assert.equal((await post('operations', { method: 'device_code' })).status(), 409);
  await page.reload(); await page.getByTestId('screen-work').waitFor(); await select(page, connection.id, 'nodes');
  await page.getByTestId('provider-user-code').waitFor();
  assert.equal(await page.getByTestId('provider-user-code').innerText(), 'TEST-CODE');
  assert.equal(await page.getByTestId('provider-verification-link').getAttribute('rel'), 'noopener noreferrer');
  await page.screenshot({ path: output + '/auth-device-qhd.png', fullPage: true });
  await context.setOffline(true); await page.waitForTimeout(800); await context.setOffline(false);
  await poll(async () => assert.equal(await page.getByTestId('provider-user-code').innerText(), 'TEST-CODE'));
  await page.getByTestId('provider-cancel').click();
  await poll(async () => assert.equal(await page.getByTestId('provider-operation-state').innerText(), 'Отменена'));
  assert.equal(await page.getByTestId('provider-user-code').count(), 0);
  await control('succeeded'); assert.equal((await json(page, getRoute)).state, 'unauthenticated', 'late completion cannot revive cancellation');
  evidence.checks.push('device code, replay, concurrency conflict, reload/reconnect, cancellation, late event');

  await page.getByTestId('provider-start-device').click(); await page.getByTestId('provider-user-code').waitFor();
  await control('succeeded', started.operation.operationId);
  assert.equal((await json(page, getRoute)).operation.status, 'pending', 'late old completion cannot replace a newer attempt');
  await control('expired');
  await poll(async () => assert.equal(await page.getByTestId('provider-operation-state').innerText(), 'Истекло время подтверждения'));
  await page.screenshot({ path: output + '/auth-expired-qhd.png', fullPage: true });
  await page.getByTestId('provider-start-device').click(); await page.getByTestId('provider-user-code').waitFor();
  await control('succeeded');
  await poll(async () => assert.equal(await page.getByTestId('provider-auth-state').innerText(), 'Аккаунт подключён'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: output + '/auth-mobile-390.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 2560, height: 1440 });
  evidence.checks.push('expiry and retry, confirmed synthetic account, mobile overflow');

  // Simulate a lost ACK after a successful logout: authoritative readback recovers.
  let dropLogout = true;
  const authMatcher = '**/api/connections/*/provider-auth/**';
  await page.route(authMatcher, async intercepted => {
    if (dropLogout && intercepted.request().method() === 'POST' && intercepted.request().url().includes('/logout?')) {
      dropLogout = false;
      try { await intercepted.fetch({ url: intercepted.request().url().replace(base, apiBase) }); }
      catch { errors.push('Lost-ACK transport failed (details suppressed).'); }
      await intercepted.abort(); return;
    }
    await intercepted.continue();
  });
  await page.getByTestId('provider-logout').click(); await page.getByTestId('provider-confirm-logout').click();
  await poll(async () => assert.equal(await page.getByTestId('provider-auth-state').innerText(), 'Вход не выполнен'));
  await page.unroute(authMatcher);
  // A start that never reached Harness is explicitly retried with the SAME command ID.
  let lostStartId; let retryStartId;
  await page.route(authMatcher, async intercepted => {
    const request = intercepted.request();
    if (request.method() === 'POST' && request.url().includes('/operations?')) {
      if (!lostStartId) { lostStartId = request.postDataJSON().commandId; await intercepted.abort(); return; }
      retryStartId = request.postDataJSON().commandId;
    }
    await intercepted.continue();
  });
  await page.getByTestId('provider-start-device').click();
  await page.getByTestId('provider-retry').waitFor(); await page.getByTestId('provider-retry').click();
  await page.getByTestId('provider-user-code').waitFor();
  assert.equal(retryStartId, lostStartId);
  await page.unroute(authMatcher);
  await page.getByTestId('provider-cancel').click();
  await poll(async () => assert.equal(await page.getByTestId('provider-operation-state').innerText(), 'Отменена'));
  let activeReads = 0; let maximumReads = 0; let delayedReads = 0;
  const getMatcher = '**/api/connections/*/provider-auth?*';
  await page.route(getMatcher, async intercepted => {
    activeReads++; maximumReads = Math.max(maximumReads, activeReads); delayedReads++;
    await new Promise(resolve => setTimeout(resolve, 9500));
    try { await intercepted.continue(); } finally { activeReads--; }
  });
  await poll(async () => assert.ok(delayedReads > 0));
  await page.waitForTimeout(10000);
  assert.equal(maximumReads, 1, 'slow API reads must not multiply polling');
  await page.unroute(getMatcher);
  evidence.checks.push('lost ACK logout readback, unaccepted start same-ID retry, no overlapping slow polling');

  const observerContext = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
  const observer = await login(observerContext, 'observer', viewerPassword);
  assert.equal((await json(observer, '/api/session')).canManageConnections, false);
  assert.equal((await api(observer, 'GET', getRoute)).status(), 403, 'observer auth read denied');
  assert.equal((await api(observer, 'GET', getRoute.replace('/provider-auth', '/Provider-Auth'))).status(), 403, 'mixed-case auth route denied');
  const upperPrefix = await api(observer, 'GET', getRoute.replace('/api/connections/', '/API/Connections/'));
  assert.ok(!(await upperPrefix.text()).includes('harness-provider-auth-v1'), 'unrecognized nginx prefix cannot expose auth data');
  assert.equal((await api(observer, 'POST', route + '/logout' + suffix, { nodeId, commandId: randomUUID() })).status(), 403);
  assert.equal((await api(observer, 'POST', '/api/connections', { name: 'denied', baseUri: 'https://auth-fixture:8443/fixture' })).status(), 403);
  await observer.getByTestId('nav-nodes').click();
  await observer.getByTestId('node-row-' + connection.id).getByRole('button').click();
  await observer.getByText('Доступно пользователям с правом управления подключениями.').waitFor();
  assert.equal(await observer.getByTestId('provider-secret').count(), 0);
  await observer.screenshot({ path: output + '/auth-observer-qhd.png', fullPage: true });
  await observerContext.close();
  evidence.checks.push('viewer: GET code and all commands 403, UI hides credentials');
  assert.deepEqual(errors, []);
  await post('logout');
  await writeFile(output + '/auth-acceptance.json', JSON.stringify(evidence, null, 2));
  console.log('PASS: controlled auth through real Gateway/Adapter; ' + evidence.checks.join('; '));
} catch (error) {
  if (page) await page.screenshot({ path: output + '/auth-failure.png', fullPage: true });
  console.error('FAIL: auth acceptance (request details suppressed).');
  console.error(String(error.message).split('Call log:')[0].split('authorization:')[0].replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 500));
  if (error instanceof assert.AssertionError) console.error(error.message.replace(/Bearer\s+\S+/g, 'Bearer [redacted]'));
  process.exitCode = 1;
} finally { await browser.close(); }
