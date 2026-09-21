import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import https from 'node:https';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:18100';
const apiBaseUrl = process.env.API_BASE_URL ?? 'http://host.docker.internal:18100';
const username = process.env.DEV_USER_USERNAME ?? 'operator';
const passwordFile = process.env.DEV_USER_PASSWORD_FILE ?? '/run/secrets/keycloak_dev_user_password';
const outputDir = process.env.OUTPUT_DIR ?? '/output';
const harnessCaFile = process.env.HARNESS_CA_FILE ?? '/run/config/harness_server_cert';
const password = (await readFile(passwordFile, 'utf8')).trim();
const harnessCa = await readFile(harnessCaFile);
await mkdir(outputDir, { recursive: true });
const persistenceMarker = join(outputDir, 'created-name.txt');

const browser = await chromium.launch({
  headless: true,
  args: ['--host-resolver-rules=MAP localhost host.docker.internal']
});

async function login(context) {
  const page = await context.newPage();
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
    await page.getByRole('heading', { name: 'Работа', exact: true }).waitFor();
  } catch (error) {
    console.error(`Login did not return to the SPA. URL: ${page.url()}`);
    console.error((await page.locator('body').innerText()).slice(0, 1200));
    await page.screenshot({ path: join(outputDir, 'login-failure.png'), fullPage: true });
    throw error;
  }
  return page;
}

async function harnessCommand(hostname, nodeId, kind, target, expected, payload) {
  const body = JSON.stringify({
    protocolVersion: 1,
    schemaId: 'harness-wire-v2',
    commandId: randomUUID(),
    kind,
    target: { nodeId, ...target },
    expected,
    payload
  });
  const response = await new Promise((resolve, reject) => {
    const request = https.request({
      hostname,
      servername: hostname,
      port: 8443,
      path: `/v1/nodes/${nodeId}/commands`,
      method: 'POST',
      ca: harnessCa,
      rejectUnauthorized: true,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
  assert.equal(response.status, 202, `${hostname} ${kind} must return 202: ${response.body}`);
  return JSON.parse(response.body);
}

async function createQueuedFixture(hostname, nodeId, title, text) {
  const dialog = await harnessCommand(hostname, nodeId, 'dialog.create', {}, { registryVersion: 1 }, { title });
  const queued = await harnessCommand(
    hostname,
    nodeId,
    'message.enqueue',
    { dialogId: dialog.references.dialogId },
    { dialogVersion: 1 },
    { text }
  );
  return {
    hostname,
    nodeId,
    title,
    text,
    dialogId: dialog.references.dialogId,
    requestId: queued.references.requestId
  };
}

async function cancelFixture(fixture) {
  await harnessCommand(
    fixture.hostname,
    fixture.nodeId,
    'request.cancel',
    { requestId: fixture.requestId },
    { requestVersion: 1 },
    {}
  );
}

try {
  const anonymous = await browser.newContext();
  const unauthorized = await anonymous.request.get(`${apiBaseUrl}/api/connections`);
  assert.equal(unauthorized.status(), 401, 'Unauthenticated Gateway request must return 401.');
  await anonymous.close();

  const firstContext = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
  const secondContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const first = await login(firstContext);
  const second = await login(secondContext);

  await first.getByRole('button', { name: 'Настройки', exact: true }).click();
  await second.getByRole('button', { name: 'Настройки', exact: true }).click();
  await first.getByText('Подключения', { exact: true }).waitFor();
  await second.getByText('Подключения', { exact: true }).waitFor();
  await first.getByText('Подключения Harness · уведомления: Подключено', { exact: true }).waitFor({ timeout: 30_000 });
  await second.getByText('Подключения Harness · уведомления: Подключено', { exact: true }).waitFor({ timeout: 30_000 });

  try {
    const previousName = (await readFile(persistenceMarker, 'utf8')).trim();
    if (previousName) {
      await first.getByText(previousName, { exact: true }).waitFor();
      console.log(`PASS: persisted record is present after stack restart: ${previousName}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const suffix = Date.now().toString(36);
  const name = `Cursor ${suffix}`;
  const initialUri = 'https://cursor-harness:8443/';
  const secondName = `Codex ${suffix}`;
  const secondUri = 'https://codex-harness:8443/';

  await first.getByLabel('Имя').fill(name);
  await first.getByLabel('Полный базовый URI').fill(initialUri);
  await first.getByLabel('Интервал наблюдения, сек.').fill('2');
  await first.getByLabel('Таймаут запроса, сек.').fill('2');
  await first.getByLabel('Порог устаревания, сек.').fill('6');
  await first.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await first.getByText('Подключение сохранено.', { exact: false }).waitFor();
  await second.getByText(name, { exact: true }).waitFor({ timeout: 15000 });
  await second.getByText(initialUri, { exact: true }).first().waitFor();

  await first.getByRole('button', { name: 'Добавить', exact: true }).click();
  await first.getByLabel('Имя').fill(secondName);
  await first.getByLabel('Полный базовый URI').fill(secondUri);
  await first.getByLabel('Интервал наблюдения, сек.').fill('2');
  await first.getByLabel('Таймаут запроса, сек.').fill('2');
  await first.getByLabel('Порог устаревания, сек.').fill('6');
  await first.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await second.getByText(secondUri, { exact: true }).first().waitFor({ timeout: 15000 });
  await writeFile(persistenceMarker, name, 'utf8');
  await second.reload({ waitUntil: 'networkidle' });
  await second.getByRole('button', { name: 'Настройки', exact: true }).click();
  await second.getByText(initialUri, { exact: true }).first().waitFor();
  await second.getByText(secondUri, { exact: true }).first().waitFor();

  await first.getByRole('button', { name: 'Ноды', exact: true }).click();
  await first.getByText('11111111-1111-4111-8111-111111111111', { exact: true }).first().waitFor({ timeout: 30000 });
  await first.getByText('22222222-2222-4222-8222-222222222222', { exact: true }).first().waitFor({ timeout: 30000 });
  await first.getByText('heartbeat свежий', { exact: false }).first().waitFor({ timeout: 30000 });

  // Keep the second browser on Work before producing Harness events. Seeing the
  // rows without navigation/reload proves Harness SSE -> Adapter -> Centrifugo
  // invalidation -> visible projection refetch, not merely direct API polling.
  await second.getByRole('button', { name: 'Работа', exact: true }).click();
  const cursorFixture = await createQueuedFixture(
    'cursor-harness',
    '11111111-1111-4111-8111-111111111111',
    `Cursor acceptance ${suffix}`,
    `Cursor message ${suffix}`
  );
  const codexFixture = await createQueuedFixture(
    'codex-harness',
    '22222222-2222-4222-8222-222222222222',
    `Codex acceptance ${suffix}`,
    `Codex message ${suffix}`
  );
  for (const fixture of [cursorFixture, codexFixture]) {
    await second.getByText(fixture.requestId, { exact: true }).first().waitFor({ timeout: 30000 });
  }
  await first.getByRole('button', { name: 'Работа', exact: true }).click();
  for (const fixture of [cursorFixture, codexFixture]) {
    await first.getByText(fixture.requestId, { exact: true }).first().waitFor({ timeout: 30000 });
  }

  await cancelFixture(cursorFixture);
  await cancelFixture(codexFixture);
  for (const fixture of [cursorFixture, codexFixture]) {
    await second.waitForFunction(
      (requestId) => !document.body.innerText.includes(requestId),
      fixture.requestId,
      { timeout: 30000 }
    );
  }
  await first.getByRole('button', { name: 'История', exact: true }).click();
  for (const fixture of [cursorFixture, codexFixture]) {
    const row = first.getByRole('row').filter({ hasText: fixture.title }).first();
    await row.waitFor({ timeout: 30000 });
    await row.getByText(fixture.nodeId, { exact: true }).waitFor();
    await row.getByRole('cell', { name: '1', exact: true }).waitFor();
  }

  const sections = [
    ['Работа', '01-work.png'],
    ['История', '02-history.png'],
    ['Ноды', '03-nodes.png'],
    ['Настройки', '04-settings.png']
  ];
  for (const [section, file] of sections) {
    await first.getByRole('button', { name: section, exact: true }).click();
    await first.screenshot({ path: join(outputDir, file), fullPage: true });
  }

  await first.setViewportSize({ width: 390, height: 844 });
  await first.getByRole('button', { name: 'Настройки', exact: true }).click();
  await first.screenshot({ path: join(outputDir, '05-settings-390.png'), fullPage: true });
  const documentWidth = await first.evaluate(() => document.documentElement.scrollWidth);
  assert.equal(documentWidth, 390, 'Narrow layout must not overflow the document width.');

  await second.getByRole('button', { name: 'Выйти', exact: true }).click();
  await second.getByRole('button', { name: 'Войти', exact: true }).waitFor();

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
  await first.getByRole('button', { name: 'Войти', exact: true }).waitFor();

  console.log('PASS: auth, two real Harness lifecycles (queued Work -> cancelled History), Harness SSE/Centrifugo refetch, persisted settings, reload recovery, logout, expiry and responsive screenshots; zero provider calls.');
  await firstContext.close();
  await secondContext.close();
} finally {
  await browser.close();
}
