import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:18000';
const apiBaseUrl = process.env.API_BASE_URL ?? 'http://host.docker.internal:18000';
const username = process.env.DEV_USER_USERNAME ?? 'operator';
const passwordFile = process.env.DEV_USER_PASSWORD_FILE ?? '/run/secrets/keycloak_dev_user_password';
const outputDir = process.env.OUTPUT_DIR ?? '/output';
const password = (await readFile(passwordFile, 'utf8')).trim();
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
  const name = `Acceptance ${suffix}`;
  const initialUri = `https://example.invalid/root/path/${suffix}/?tenant=hl303`;
  const updatedUri = `https://example.invalid/root/updated/${suffix}/?tenant=hl303`;

  await first.getByLabel('Имя').fill(name);
  await first.getByLabel('Полный базовый URI').fill(initialUri);
  await first.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await first.getByText('Подключение сохранено.', { exact: false }).waitFor();
  await second.getByText(name, { exact: true }).waitFor({ timeout: 15000 });
  await second.getByText(initialUri, { exact: true }).waitFor();

  await first.getByLabel('Полный базовый URI').fill(updatedUri);
  await first.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await second.getByText(updatedUri, { exact: true }).waitFor({ timeout: 15000 });
  await writeFile(persistenceMarker, name, 'utf8');
  await second.reload({ waitUntil: 'networkidle' });
  await second.getByRole('button', { name: 'Настройки', exact: true }).click();
  await second.getByText(updatedUri, { exact: true }).waitFor();

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

  console.log('PASS: auth, CRUD path preservation, two-client notification/refetch, reload recovery, logout, expiry and responsive screenshots.');
  await firstContext.close();
  await secondContext.close();
} finally {
  await browser.close();
}
