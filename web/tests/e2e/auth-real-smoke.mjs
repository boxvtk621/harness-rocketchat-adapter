// Real Harness transport/status smoke. Starts zero turns and never completes a provider login.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
assert.equal(process.env.ACCEPTANCE_ISOLATED, 'true');
assert.match(process.env.COMPOSE_PROJECT_NAME ?? '', /^hl306-/);
const output = process.env.OUTPUT_DIR ?? '/output'; await mkdir(output, { recursive: true });
const password = (await readFile('/run/secrets/keycloak_dev_user_password', 'utf8')).trim();
const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP localhost host.docker.internal'] });
const context = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
const page = await context.newPage();
async function poll(fn, wait = 90000) { const end = Date.now() + wait; while (true) { try { return await fn(); } catch(error) { if(Date.now() > end) throw error; await new Promise(r => setTimeout(r, 1000)); } } }
const evidence = { realProviderLogin: false, modelCalls: 0, nodes: [] };
try {
  await poll(async () => {
    assert.equal((await context.request.get('http://keycloak:8080/realms/harness/.well-known/openid-configuration', { timeout: 5000 })).status(), 200);
    assert.equal((await context.request.get('http://adapter:8080/health/ready', { timeout: 5000 })).status(), 200);
  }, 120000);
  await poll(async () => { await page.goto(process.env.BASE_URL); await page.getByRole('button', { name: 'Войти', exact: true }).waitFor({ timeout: 3000 }); });
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.locator('#username').fill('operator'); await page.locator('#password').fill(password); await page.locator('#kc-login').click();
  await page.getByTestId('screen-work').waitFor({ timeout: 45000 });
  const token = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('oidc.user:')).map(key => JSON.parse(sessionStorage.getItem(key)).access_token)[0]);
  const api = async (method, path, data) => {
    try { return await page.request.fetch(process.env.API_BASE_URL + path, { method, headers: { authorization: 'Bearer ' + token }, data }); }
    catch { throw Error('Real Harness transport failed (details suppressed).'); }
  };
  for (const spec of [{ name: 'Cursor', host: 'cursor-harness', method: 'secret', nodeId: '11111111-1111-4111-8111-111111111111' },
      { name: 'Codex', host: 'codex-harness', method: 'device_code', nodeId: '22222222-2222-4222-8222-222222222222' }]) {
    const registration = await api('POST', '/api/connections', { name: spec.name, baseUri: 'https://' + spec.host + ':8443/', observationIntervalSeconds: 3, requestTimeoutSeconds: 15, staleThresholdSeconds: 20 });
    assert.ok([200, 201].includes(registration.status())); const registered = await registration.json();
    const connection = await poll(async () => {
      const c = await (await api('GET', '/api/connections/' + registered.id)).json();
      assert.equal(c.identityStatus, 'unique'); assert.equal(c.observation.nodeId, spec.nodeId); assert.equal(c.observation.executorHealthy, true); return c;
    });
    assert.equal(connection.observation.ready, false, 'fresh node without provider login must not be ready');
    const base = '/api/connections/' + connection.id + '/provider-auth'; const query = '?configEpoch=' + connection.configEpoch;
    const read = async () => { const response = await api('GET', base + query + '&nodeId=' + spec.nodeId); assert.equal(response.status(), 200); return response.json(); };
    const command = (action, extra = {}) => api('POST', base + '/' + action + query, { nodeId: spec.nodeId, commandId: randomUUID(), ...extra });
    let auth = await read();
    assert.deepEqual(auth.capabilities.methods, [spec.method]); assert.notEqual(auth.state, 'authenticated');
    if (auth.operation?.status === 'pending') await command('operations/' + auth.operation.operationId + '/cancel');
    const checked = await command('check'); assert.ok([200, 503].includes(checked.status())); auth = await read();
    assert.notEqual(auth.state, 'authenticated');
    const item = { name: spec.name, nodeId: spec.nodeId, method: spec.method, state: auth.state, checked: auth.checkedAt !== null,
      reasonCode: auth.reasonCode, ready: connection.observation.ready, deviceInitiation: 'not_attempted' };
    // Device initiation/cancel is zero-model-call and does not authenticate the owner.
    if (spec.method === 'device_code') {
      const started = await command('operations', { method: 'device_code' });
      assert.ok([200, 202, 503].includes(started.status()));
      let attempt = await read();
      attempt = await poll(async () => { const value = await read(); assert.ok(value.operation && (value.operation.status !== 'pending' || value.operation.verificationUrl)); return value; }, 45000);
      item.deviceInitiation = attempt.operation.status;
      item.deviceReasonCode = attempt.operation.reasonCode;
      if (attempt.operation.status === 'pending') {
        assert.equal(new URL(attempt.operation.verificationUrl).protocol, 'https:');
        assert.ok(attempt.operation.userCode);
        const cancelled = await command('operations/' + attempt.operation.operationId + '/cancel'); assert.equal(cancelled.status(), 200);
        assert.equal((await read()).operation.status, 'cancelled'); item.deviceInitiation = 'code_received_and_cancelled';
      }
    }
    evidence.nodes.push(item);
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('connection-row-' + connection.id).getByRole('button').click();
    await poll(async () => {
      assert.equal(await page.getByTestId('connection-name').inputValue(), spec.name);
      assert.equal(await page.getByTestId('provider-auth-state').innerText(), 'Вход не выполнен');
      assert.equal(await page.getByTestId(spec.method === 'secret' ? 'provider-secret' : 'provider-start-device').isVisible(), true);
    });
    // Codes are cancelled before any real-Harness screenshot.
    await poll(async () => assert.equal(await page.getByTestId('provider-user-code').count(), 0));
    await page.screenshot({ path: output + '/auth-real-' + spec.name.toLowerCase() + '-qhd.png', fullPage: true });
  }
  const connections = await (await api('GET', '/api/connections')).json();
  assert.equal(connections.length, 3, 'two real nodes plus one explicitly controlled fixture, no duplicate registration');
  await writeFile(output + '/auth-real-smoke.json', JSON.stringify(evidence, null, 2));
  console.log('PASS: real Harness health/readiness/capabilities; no authenticated account and zero model calls.');
} catch(error) {
  console.error('FAIL: real auth smoke (request details suppressed).');
  console.error(String(error.message).split('Call log:')[0].split('authorization:')[0].replace(/Bearer\s+\S+/g, 'Bearer [redacted]').slice(0, 500));
  process.exitCode = 1;
} finally { await browser.close(); }
