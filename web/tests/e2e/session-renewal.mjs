import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

assert.equal(process.env.ACCEPTANCE_ISOLATED, 'true');
assert.match(process.env.COMPOSE_PROJECT_NAME ?? '', /^hl307-/);
const base = process.env.BASE_URL;
const out = process.env.OUTPUT_DIR;
await mkdir(out, { recursive: true });
const userPassword = (await readFile('/run/secrets/keycloak_dev_user_password', 'utf8')).trim();
const adminPassword = (await readFile('/run/secrets/keycloak_admin_password', 'utf8')).trim();
const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP localhost host.docker.internal'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const adminTokenResponse = await context.request.post('http://keycloak:8080/realms/master/protocol/openid-connect/token', {
  form: { client_id: 'admin-cli', grant_type: 'password', username: 'admin', password: adminPassword }
});
assert.equal(adminTokenResponse.status(), 200);
const adminToken = (await adminTokenResponse.json()).access_token;
const realmResponse = await context.request.get('http://keycloak:8080/admin/realms/harness', { headers: { authorization: `Bearer ${adminToken}` } });
assert.equal(realmResponse.status(), 200);
const originalRealm = await realmResponse.json();
const shortRealm = { ...originalRealm, accessTokenLifespan: 4 };
const updateRealm = await context.request.put('http://keycloak:8080/admin/realms/harness', { headers: { authorization: `Bearer ${adminToken}` }, data: shortRealm });
assert.ok([200, 204].includes(updateRealm.status()));

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function poll(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (true) {
    try { return await fn(); }
    catch (error) { if (Date.now() > end) throw new Error(`${label}: ${error.message}`); await delay(150); }
  }
}
async function login(page) {
  await page.goto(base);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.locator('#username').fill('operator');
  await page.locator('#password').fill(userPassword);
  await page.locator('#kc-login').click();
  await page.getByTestId('screen-work').waitFor({ timeout: 45000 });
}
async function storedUser(page) {
  return page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(item => item.startsWith('oidc.user:'));
    if (!key) return null;
    const value = JSON.parse(sessionStorage.getItem(key));
    return { key, accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: value.expires_at };
  });
}
async function waitForTokenChange(page, previous, label) {
  return poll(async () => {
    const current = await storedUser(page);
    assert.ok(current?.accessToken && current.accessToken !== previous);
    return current;
  }, label, 25000);
}

let commandRequests = 0;
let refreshFailures = 0;
let activeRefreshes = 0;
let maximumConcurrentRefreshes = 0;
const page = await context.newPage();
page.on('request', request => { if (/\/commands(?:\/|$)/.test(new URL(request.url()).pathname) && request.method() !== 'GET') commandRequests++; });
try {
  await login(page);
  let session = await storedUser(page);
  assert.ok(session?.accessToken && session?.refreshToken);

  let failNextRefresh = true;
  await page.route('**/realms/harness/protocol/openid-connect/token', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    activeRefreshes++;
    maximumConcurrentRefreshes = Math.max(maximumConcurrentRefreshes, activeRefreshes);
    await delay(250);
    try {
      if (failNextRefresh) {
        failNextRefresh = false;
        refreshFailures++;
        return route.abort('failed');
      }
      return route.continue();
    } finally {
      activeRefreshes--;
    }
  });
  await poll(async () => assert.equal(refreshFailures, 1), 'One refresh request is interrupted', 10000);
  session = await storedUser(page);
  session = await waitForTokenChange(page, session.accessToken, 'Recovery after one temporary refresh failure');
  assert.equal(refreshFailures, 1);
  assert.equal(maximumConcurrentRefreshes, 1, 'Only the coordinated application renewer calls the token endpoint');
  await page.unroute('**/realms/harness/protocol/openid-connect/token');

  session = await waitForTokenChange(page, session.accessToken, 'First automatic short-lifespan renewal');
  session = await waitForTokenChange(page, session.accessToken, 'Second automatic short-lifespan renewal');

  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await delay(6000);
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  session = await waitForTokenChange(page, session.accessToken, 'Renewal after background resume');

  const concurrentStatuses = await page.evaluate(async accessToken => Promise.all([
    '/api/session',
    '/api/projections/nodes',
    '/api/projections/work'
  ].map(async url => (await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } })).status)), session.accessToken);
  assert.ok(concurrentStatuses.every(status => status === 200), 'Concurrent safe reads use the renewed token');
  assert.equal(commandRequests, 0, 'Renewal never submits a command');

  const usersResponse = await context.request.get('http://keycloak:8080/admin/realms/harness/users?username=operator&exact=true', {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  assert.equal(usersResponse.status(), 200);
  const [operator] = await usersResponse.json();
  assert.ok(operator?.id, 'Operator exists in the isolated realm');
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  const revoke = await context.request.post(`http://keycloak:8080/admin/realms/harness/users/${operator.id}/logout`, {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  assert.equal(revoke.status(), 204);
  await delay(5000);
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Войти', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await storedUser(page), null, 'Revoked refresh session is removed and requires login');

  const explicit = await context.newPage();
  await login(explicit);
  await explicit.getByRole('button', { name: 'Выйти', exact: true }).click();
  await explicit.getByRole('button', { name: 'Войти', exact: true }).waitFor({ timeout: 25000 });
  assert.equal(await storedUser(explicit), null, 'Explicit logout removes the local OIDC user');
  await explicit.close();

  await writeFile(join(out, 'session-renewal-evidence.json'), JSON.stringify({
    mode: 'real isolated Keycloak refresh-token flow; no model/provider calls',
    accessTokenLifespanSeconds: 4,
    automaticRenewalCycles: 2,
    temporaryRefreshFailures: refreshFailures,
    maximumConcurrentRefreshes,
    backgroundResume: 'passed',
    revokedSessionRequiresLogin: true,
    explicitLogoutCleanup: true,
    commandRequests
  }, null, 2));
  console.log('PASS real Keycloak session renewal: two cycles, temporary failure recovery, background resume, revocation and logout cleanup; zero command/provider calls.');
} finally {
  await context.request.put('http://keycloak:8080/admin/realms/harness', { headers: { authorization: `Bearer ${adminToken}` }, data: originalRealm }).catch(() => {});
  await browser.close();
}
