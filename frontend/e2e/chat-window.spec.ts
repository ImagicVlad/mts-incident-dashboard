import { expect, test, type Locator, type Page } from '@playwright/test';

async function openDashboard(page: Page) {
  await page.route('**/api/health', route => route.fulfill({json: {
    status: 'ok', aiConfigured: true, displayTimezone: 'Europe/Moscow',
  }}));
  await page.goto('/login');
  await page.getByRole('button', {name: 'Войти', exact: true}).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

function bounds(locator: Locator) {
  return locator.evaluate(el => {
    const {x, y, width, height} = el.getBoundingClientRect();
    return {x, y, width, height};
  });
}

async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  const {x, y, width, height} = await bounds(handle);
  const left = x + Math.min(width / 2, 60), top = y + height / 2;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(left + dx, top + dy, {steps: 5});
  await page.mouse.up();
}

test('открепление, перемещение, размеры и восстановление одного окна', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 840});
  await openDashboard(page);
  const chat = page.getByRole('region', {name: 'ИИ-чат', exact: true});
  const button = (name: string) => chat.getByRole('button', {name, exact: true});
  const input = chat.getByRole('textbox');
  await chat.getByRole('button', {name: 'Какие инциденты на координаторах?'}).click();
  const draft = await input.inputValue();
  const embedded = await bounds(chat);
  const oldQueue = await bounds(page.locator('.queue'));
  await chat.evaluate(el => el.setAttribute('data-instance', 'original'));
  await button('Открепить ИИ-чат').click();
  const initial = await bounds(chat);
  const screen = await page.evaluate(() => ({w: document.documentElement.clientWidth, h: document.documentElement.clientHeight}));
  expect(initial.width).toBeCloseTo(embedded.width, 0);
  expect(initial.height).toBeCloseTo(embedded.height, 0);
  expect(screen.w - initial.x - initial.width).toBeCloseTo(20, 0);
  expect(screen.h - initial.y - initial.height).toBeCloseTo(20, 0);
  expect((await bounds(page.locator('.queue'))).width).toBeGreaterThan(oldQueue.width);
  await drag(page, chat.locator('header'), -180, -80);
  const moved = await bounds(chat);
  expect(moved.x).toBeCloseTo(initial.x - 180, 0);
  expect(moved.y).toBeCloseTo(initial.y - 80, 0);
  await drag(page, button('Изменить размер окна'), 110, 50);
  const resized = await bounds(chat);
  expect(resized.width).toBeCloseTo(initial.width + 110, 0);
  expect(resized.height).toBeCloseTo(initial.height + 50, 0);
  await page.getByTestId('group-critical').getByRole('button').click();
  await page.evaluate(() => window.scrollBy(0, 360));
  expect(await bounds(chat)).toEqual(resized);
  await button('Свернуть чат').click();
  expect((await bounds(chat)).height).toBeLessThan(60);
  await expect(input).toBeHidden();
  await button('Восстановить чат').click();
  expect(await bounds(chat)).toEqual(resized);
  await button('Развернуть чат').click();
  expect(await bounds(chat)).toEqual({x: 0, y: 0, width: screen.w, height: screen.h});
  await expect(button('Изменить размер окна')).toHaveCount(0);
  await drag(page, chat.locator('header'), 100, 75);
  expect((await bounds(chat)).x).toBe(0);
  await button('Свернуть чат').click();
  await button('Восстановить чат').click();
  await button('Восстановить размер').click();
  expect(await bounds(chat)).toEqual(resized);
  await page.setViewportSize({width: 320, height: 360});
  const small = await bounds(chat);
  expect(small.x).toBeGreaterThanOrEqual(0);
  expect(small.y).toBeGreaterThanOrEqual(0);
  expect(small.x + small.width).toBeLessThanOrEqual(320);
  expect(small.y + small.height).toBeLessThanOrEqual(360);
  await page.setViewportSize({width: 1280, height: 840});
  await button('Закрыть окно и вернуть чат на дашборд').click();
  await expect(chat).toHaveAttribute('data-mode', 'docked');
  await expect(chat).toHaveAttribute('data-instance', 'original');
  await expect(input).toHaveValue(draft);
  expect((await bounds(page.locator('.queue'))).width).toEqual(oldQueue.width);
});

test('ответ приходит при свёрнутом чате, история и черновик сохраняются при возврате', async ({page}) => {
  await openDashboard(page);
  let requests = 0;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const answer = 'Проверка срока по данным снимка. '.repeat(120);
  await page.route('**/api/ai/chat', async route => {
    requests++;
    await hold;
    await route.fulfill({json: {answer, asOf: new Date().toISOString(), epoch: 'test', snapshotVersion: 1}});
  });
  const chat = page.locator('.incident-chat');
  const input = chat.getByRole('textbox');
  await input.fill('Проверь срок');
  await input.press('Enter');
  await expect(chat.getByRole('status')).toBeVisible();
  await chat.getByRole('button', {name: 'Открепить ИИ-чат'}).click();
  await chat.getByRole('button', {name: 'Свернуть чат'}).click();
  const response = page.waitForResponse('**/api/ai/chat');
  release();
  await response;
  await chat.getByRole('button', {name: 'Восстановить чат'}).click();
  const log = chat.getByRole('log');
  await expect(log).toContainText(answer.trim());
  await expect.poll(() => log.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
  await input.fill('Второй вопрос');
  await chat.getByRole('button', {name: 'Закрыть окно и вернуть чат на дашборд'}).click();
  await expect(input).toHaveValue('Второй вопрос');
  await expect(log).toContainText('Проверь срок');
  await expect(log).toContainText(answer.trim());
  expect(requests).toBe(1);
});

test('карточка автоматически открывает встроенный чат, а ручной режим сохраняется при навигации', async ({page}) => {
  await openDashboard(page);
  const card = page.getByTestId('group-critical').locator('a').first();
  const chat = page.locator('.incident-chat');
  const input = chat.getByRole('textbox');
  const mode = (name: string) => expect(chat).toHaveAttribute('data-mode', name);
  const back = page.getByRole('link', {name: 'Вернуться на дашборд', exact: true});
  await mode('docked');
  await page.route('**/api/ai/chat', route => route.fulfill({json: {
    answer: 'Сводка по смене. '.repeat(150), epoch: 'test', snapshotVersion: 1, asOf: new Date().toISOString(),
  }}));
  await input.fill('Покажи сводку');
  await input.press('Enter');
  const log = chat.getByRole('log');
  await expect(log).toContainText('Сводка по смене.');
  await input.fill('Уточнить время восстановления');
  await log.evaluate(el => {el.scrollTop = 48;});
  await chat.evaluate(el => el.setAttribute('data-session-test', 'same-chat'));
  await card.click();
  await mode('floating');
  await expect(input).toHaveValue('Уточнить время восстановления');
  expect(await log.evaluate(el => el.scrollTop)).toBe(48);
  await expect(page.getByRole('heading', {name: 'Данные инцидента'})).toBeVisible();
  await expect(page.locator('.compact-focus .big-clock')).toBeVisible();
  await back.click();
  await mode('docked');
  expect(await log.evaluate(el => el.scrollTop)).toBe(48);
  await page.goBack();
  await mode('floating');
  await chat.getByRole('button', {name: 'Закрыть окно чата'}).click();
  await expect(chat).toBeHidden();
  const launcher = page.getByRole('button', {name: 'Открыть ИИ-чат'});
  await expect(launcher).toBeVisible();
  await page.goForward();
  await mode('docked');
  await page.goBack();
  await launcher.click();
  await expect(input).toHaveValue('Уточнить время восстановления');
  await chat.getByRole('button', {name: 'Свернуть чат'}).click();
  await page.goForward();
  await mode('minimized');
  await page.goBack();
  await mode('minimized');
  await chat.getByRole('button', {name: 'Восстановить чат'}).click();
  await chat.getByRole('button', {name: 'Развернуть чат'}).click();
  await page.goForward();
  await mode('maximized');
  await page.goBack();
  await mode('maximized');
  await chat.getByRole('button', {name: 'Восстановить размер'}).click();
  await back.click();
  await mode('floating');
  await chat.getByRole('button', {name: 'Закрыть окно и вернуть чат на дашборд'}).click();
  await mode('docked');
  await expect(chat).toHaveAttribute('data-session-test', 'same-chat');
  await expect(chat).toHaveCount(1);
});

test('плавающий чат переносит запрос, ответ, прокрутку и геометрию между маршрутами', async ({page}) => {
  await openDashboard(page);
  const chat = page.locator('.incident-chat');
  const input = chat.getByRole('textbox');
  const log = chat.getByRole('log');
  const card = page.getByTestId('group-critical').locator('a').first();
  let requests = 0;
  let reply!: () => void;
  const hold = new Promise<void>(resolve => {reply = resolve;});
  const answer = 'Данные по смене проверены. '.repeat(90).trim();
  await page.route('**/api/ai/chat', async route => {
    requests++;
    await hold;
    await route.fulfill({json: {answer, epoch: 'test', snapshotVersion: 1, asOf: new Date().toISOString()}});
  });
  await chat.getByRole('button', {name: 'Открепить ИИ-чат'}).click();
  await drag(page, chat.locator('header'), -100, -80);
  await drag(page, chat.getByRole('button', {name: 'Изменить размер окна'}), 50, 40);
  const windowBounds = await bounds(chat);
  await card.click();
  expect(await bounds(chat)).toEqual(windowBounds);
  await page.evaluate(() => window.scrollBy(0, 600));
  expect(await bounds(chat)).toEqual(windowBounds);
  await input.fill('Проверь сроки по смене');
  await input.press('Enter');
  await expect(chat.getByRole('status')).toBeVisible();
  await page.goBack();
  await expect(chat.getByRole('status')).toBeVisible();
  expect(await bounds(chat)).toEqual(windowBounds);
  reply();
  await expect(log.getByText(answer, {exact: true})).toHaveCount(1);
  await input.fill('Следующий вопрос');
  const scroll = await log.evaluate(el => {el.scrollTop = 64; return el.scrollTop;});
  expect(scroll).toBe(64);
  await page.goForward();
  await expect(input).toHaveValue('Следующий вопрос');
  expect(await log.evaluate(el => el.scrollTop)).toBe(scroll);
  await expect(log.getByText('Проверь сроки по смене', {exact: true})).toHaveCount(1);
  await expect(log.getByText(answer, {exact: true})).toHaveCount(1);
  expect(await bounds(chat)).toEqual(windowBounds);
  expect(requests).toBe(1);
});
