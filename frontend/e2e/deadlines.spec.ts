import { signIn } from './auth';
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { Incident } from '../src/api';

const file = process.env.E2E_SOURCE!;

async function publish(contents: string) {
  await writeFile(file + '.writing', contents, 'utf8');
  // The Windows watcher can briefly hold the destination open.
  await expect(() => rename(file + '.writing', file)).toPass({intervals:[25,50,100],timeout:1500});
}

interface TestSource {
  issue(id: string, minutes: number | null, overrides?: Partial<Incident> & {stateId?: number}): Incident;
  update(issues: Incident[]): Promise<void>;
}

const test = base.extend<{ source: TestSource }>({
  source: async ({}, use) => {
    const original = await readFile(file, 'utf8');
    const [template] = JSON.parse(original);
    const now = Date.now();
    try {
      await use({
        issue: (id, minutes, overrides) => ({
          ...template, id, sysId: 'sys-' + id, header: 'Инцидент ' + id,
          stateEnum: 'Assigned', stateId: 0, state: 'Назначен', completionDate: null,
          assignedGroupName: 'КЦ ИТ Координаторы Массовых Инцидентов',
          priorityId: 4, priority: 'Наивысший',
          deadline: minutes === null ? null : new Date(now + minutes * 60_000).toISOString(),
          ...overrides,
        }),
        update: issues => publish(JSON.stringify(issues)),
      });
    } finally {
      await publish(original);
    }
  },
});

async function login(page: Page) {
  await page.goto('/login');
  await signIn(page);
  await expect(page.locator('.deadline-focus')).toBeVisible();
}

async function expectIncident(widget: Locator, id: string) {
  await expect(widget.locator('.deadline-incident h3 a')).toHaveAttribute('href', '/incidents/' + id);
}

test('чат получает ту же область поиска сроков, что и таймер', async ({page, source}) => {
  const next = source.issue('SCOPE-NEXT', 10);
  const late = source.issue('SCOPE-LATE', -5);
  await source.update([next, late]);
  await page.route('**/api/health', route => route.fulfill({json: {
    status:'ok', aiConfigured:true, displayTimezone:'Europe/Moscow',
  }}));
  await page.route('**/api/ai/chat', route => route.fulfill({json: {
    answer:'Проверено', epoch:'test', snapshotVersion:1, asOf:new Date().toISOString(), stale:false,
  }}));
  await login(page);
  const widget = page.locator('.deadline-focus');
  await expectIncident(widget, next.id);
  await expect(page.getByText('В этой категории нет инцидентов.', {exact:true})).toHaveCount(0);
  const search = page.getByRole('searchbox');
  await search.fill(late.id);
  await expectIncident(widget, late.id);
  await page.getByRole('button', {name:'У какого инцидента ближайший срок?'}).click();
  const request = page.waitForRequest('**/api/ai/chat');
  await page.getByRole('button', {name:'Отправить сообщение'}).click();
  expect((await request).postDataJSON().deadlineScope).toEqual([late.id]);
});

async function expectList(page: Page, ids: string[]) {
  const results = page.locator('.queue').getByTestId('deadline-results');
  await expect(results).toBeVisible();
  const links = results.locator('a.incident');
  await expect.poll(() => links.evaluateAll(nodes => nodes.map(link => link.getAttribute('href'))))
    .toEqual(ids.map(id => '/incidents/' + id));
}

test('верх таймера совпадает с первой карточкой при смене очереди и фильтров', async ({page, source}) => {
  const higher = source.issue('ALIGN-HIGH', 180, {priorityId:3, priority:'Высокий', assignedGroupName:'Сеть'});
  await source.update([higher]);
  await page.setViewportSize({width:1200, height:900});
  await login(page);
  const widget = page.locator('.deadline-focus');
  const first = page.locator('.queue a.incident').first();
  async function expectAligned(id: string) {
    await expect(first).toHaveAttribute('data-incident-id', id);
    await expect.poll(async () => {
      const [card, timer] = await Promise.all([first.boundingBox(), widget.boundingBox()]);
      return card && timer ? Math.abs(card.y - timer.y) : Infinity;
    }).toBeLessThanOrEqual(1);
  }
  await expectAligned(higher.id);
  const critical = source.issue('ALIGN-CRITICAL', 15);
  await source.update([higher, critical]);
  await expectAligned(critical.id);
  await widget.locator('.deadline-all').click();
  await page.setViewportSize({width:800, height:900});
  await expectAligned(critical.id);
});

for (const width of [375, 1440]) {
  test(`заголовок таймера занимает одну строку и открывает инцидент при ширине ${width}px`, async ({page, source}) => {
    await page.setViewportSize({width, height: 900});
    const short = source.issue('TITLE-SHORT', 10, {header: 'Сбой сети'});
    const long = source.issue('TITLE-LONG', 20, {header: 'Задержка восстановления связи между филиалами. '.repeat(6).trim()});
    await source.update([short, long]);
    await login(page);

    const widget = page.locator('.deadline-focus');
    const link = widget.locator('.deadline-incident h3 a');
    const title = link.locator(':scope > span.deadline-title');
    const arrow = link.locator(':scope > span.deadline-title + svg');
    for (const issue of [short, long]) {
      await widget.getByRole('button', {name: new RegExp(issue.id)}).click();
      await expect(link).toHaveAttribute('href', '/incidents/' + issue.id);
      await expect(link).toHaveAttribute('title', issue.header!);
      await expect(link).toHaveAccessibleName(issue.header!);
      await expect(title).toHaveText(issue.header!);
      await expect(title).toHaveCSS('white-space', 'nowrap');
      await expect(title).toHaveCSS('text-overflow', 'ellipsis');
      await expect(title).toHaveCSS('overflow-x', 'hidden');
      const clipped = await title.evaluate(el => el.scrollWidth > el.clientWidth);
      expect(clipped).toBe(issue === long);
      await expect(arrow).toBeVisible();
      const textBox = (await title.boundingBox())!;
      const iconBox = (await arrow.boundingBox())!;
      const cardBox = (await widget.boundingBox())!;
      expect(textBox.width).toBeGreaterThan(0);
      expect(iconBox.x).toBeGreaterThanOrEqual(textBox.x + textBox.width - 1);
      expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      const iconCenterY = iconBox.y + iconBox.height / 2;
      expect(iconCenterY).toBeGreaterThan(textBox.y);
      expect(iconCenterY).toBeLessThan(textBox.y + textBox.height);
    }
    await (width === 375 ? arrow : title).click();
    await expect(page).toHaveURL('/incidents/' + long.id);
    await expect(page.getByRole('heading', {level: 1, name: long.header!, exact: true})).toBeVisible();
  });
}

test('все сроки объединяют карточки разных очередей, сохраняют выбор таймера и обновляются по SSE', async ({page, source}) => {
  const a = source.issue('SLA-A', 15);
  const b = source.issue('SLA-B', 30, {
    stateEnum: 'WorkInProgress', stateId: 2, state: 'Выполняется', priorityId: 2, priority: 'Средний',
  });
  const c = source.issue('SLA-C', 30);
  const later = source.issue('SLA-LATER', 180, {priorityId: 3, priority: 'Высокий', assignedGroupName: 'Сеть'});
  const fresh = source.issue('PAST-NEW', -10, {priorityId: 2, priority: 'Средний', assignedGroupName: 'Сеть'});
  const old = source.issue('PAST-OLD', -120);
  const records = [old, later, c, fresh, b, a];
  await source.update(records);
  await login(page);

  const widget = page.locator('.deadline-focus');
  const slots = widget.locator('.deadline-switch button[aria-pressed]');
  const all = widget.locator('.deadline-all');
  const reset = page.getByRole('button', {name: 'Сбросить фильтр по срокам'});
  await expect(all).toHaveText(/Все сроки\s*·\s*6/);
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  await expect(slots).toHaveCount(3);
  await expectIncident(widget, a.id);
  await expect(widget.locator('.big-clock')).toHaveText('00:15');
  await expect(widget.locator('.deadline-now, .clock-note')).toHaveCount(0);
  for (const [position, item] of [a, b, c].entries()) {
    await slots.nth(position).click();
    await expect(slots.nth(position)).toHaveAttribute('aria-pressed', 'true');
    await expect(widget.locator('.deadline-switch [aria-pressed="true"]')).toHaveCount(1);
    await expectIncident(widget, item.id);
  }
  await slots.nth(1).click();
  await all.click();
  await expectList(page, [a.id, b.id, c.id, later.id, fresh.id, old.id]);
  await expect(all).toHaveAccessibleName('Сбросить фильтры');
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  const listHeading = page.getByTestId('deadline-results').getByRole('heading', {level: 2});
  await expect(listHeading).toBeFocused();
  await expect(page.getByTestId('group-critical')).toBeHidden();
  await expect(widget.locator('.big-clock')).toBeVisible();
  await expectIncident(widget, b.id);
  await all.click();
  await expect(page.getByTestId('deadline-results')).toBeHidden();
  await expect(page.getByTestId('group-critical')).toBeVisible();
  await expect(all).toHaveAccessibleName(/Все сроки\s*·\s*6/);
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  await expect(slots.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await all.click();
  await expectList(page, [a.id, b.id, c.id, later.id, fresh.id, old.id]);

  b.header = 'Изменён срок восстановления';
  b.deadline = source.issue(b.id, 5).deadline;
  await source.update(records);
  await expectList(page, [b.id, a.id, c.id, later.id, fresh.id, old.id]);
  await expect(widget.locator('.deadline-incident')).toContainText(b.header);
  await expectIncident(widget, b.id);
  await expect(slots.first()).toHaveAttribute('aria-pressed', 'true');

  await slots.nth(2).click();
  await reset.click();
  await expect(page.getByTestId('deadline-results')).toBeHidden();
  await expect(page.getByTestId('group-critical')).toBeVisible();
  await expect(page.getByTestId('group-high')).toContainText(later.id);
  await expectIncident(widget, c.id);
  await all.click();
  await expectList(page, [b.id, a.id, c.id, later.id, fresh.id, old.id]);
  await page.getByTestId('deadline-results').getByRole('link').last().click();
  await expect(page).toHaveURL('/incidents/' + old.id);
  await expect(page.getByRole('heading', {name: old.header!, exact: true})).toBeVisible();
});

test('свободные места занимают самые свежие просрочки, поиск и фильтры меняют набор сроков', async ({page, source}) => {
  const future = source.issue('DUE-01', 40);
  const recent = source.issue('PAST-01', -15);
  const tie = source.issue('PAST-02', -15);
  const old = source.issue('PAST-03', -180, {assignedGroupName: 'Сеть'});
  const research = source.issue('REVIEW', 2, {stateEnum: 'Research', stateId: 20, state: 'Исследование ситуации'});
  const closed = source.issue('DONE', 1, {stateEnum: 'Closed', stateId: 10, state: 'Закрыт'});
  const missing = source.issue('NO-DATE', null);
  await source.update([old, tie, research, recent, closed, missing, future]);
  await login(page);

  const widget = page.locator('.deadline-focus');
  const slots = widget.locator('.deadline-switch button[aria-pressed]');
  const all = widget.locator('.deadline-all');
  await expect(all).toContainText(/Все сроки\s*·\s*4/);
  await expectIncident(widget, future.id);
  await slots.nth(1).click();
  await expectIncident(widget, recent.id);
  await expect(widget.locator('.big-clock')).toBeVisible();
  await expect(widget.locator('.clock-note')).toHaveCount(0);
  await slots.nth(2).click();
  await expectIncident(widget, tie.id);
  const search = page.getByRole('searchbox');
  await search.fill('PAST-');
  await expect(all).toContainText(/Все сроки\s*·\s*3/);
  const panel = page.getByRole('dialog', {name: 'Настройки списка инцидентов'});
  const filterButton = page.getByRole('banner').getByRole('button', {name: /Фильтры/});
  await filterButton.click();
  const sort = panel.getByRole('button', {name: 'Сортировка', exact: true});
  await sort.click();
  await page.getByRole('option', {name: 'Сначала высокий приоритет', exact: true}).click();
  await panel.getByRole('button', {name: 'На координаторах', exact: true}).click();
  await panel.getByRole('button', {name: 'Готово'}).click();
  await all.click();
  await expectList(page, [recent.id, tie.id]);
  await slots.first().click();
  await expectIncident(widget, recent.id);
  await source.update([tie, research, old, missing, closed, future]);
  await expectList(page, [tie.id]);
  await expect(slots).toHaveCount(1);
  await expectIncident(widget, tie.id);

  await page.getByRole('button', {name: 'Сбросить фильтр по срокам'}).click();
  await expect(search).toHaveValue('PAST-');
  await expect(page.getByTestId('group-assigned').locator('a.incident')).toHaveCount(1);
  await expect(page.getByTestId('group-assigned')).toContainText(tie.id);
  await expect(page.getByTestId('group-critical')).toBeHidden();
  await all.click();
  await search.fill(future.id);
  await expectList(page, [future.id]);
  await expectIncident(widget, future.id);
  await expect(all).toHaveAccessibleName('Сбросить фильтры');

  await search.press('Escape');
  await expectList(page, [future.id, tie.id]);
  await filterButton.click();
  await panel.getByRole('button', {name: 'На координаторах', exact: true}).click();
  await panel.getByRole('button', {name: 'Исследование ситуации', exact: true}).click();
  await panel.getByRole('button', {name: 'Готово'}).click();
  await search.fill(research.id);
  await expectList(page, []);
  await expect(widget.locator('.deadline-incident')).toHaveCount(0);
  await expect(slots).toHaveCount(0);
  await expect(widget).toContainText(/Нет активных инцидентов с указанным сроком/i);
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(all).toBeEnabled();
  await all.click();
  await expect(page.getByTestId('deadline-results')).toBeHidden();
  await expect(search).toHaveValue('');
  await expect(all).toHaveAccessibleName(/Все сроки\s*·\s*3/);
  await expect(page.getByRole('navigation', {name: 'Группы инцидентов'})).toBeVisible();
  await expect(page.getByTestId('group-critical')).toBeVisible();
  await expect(page.getByTestId('group-review')).toContainText(research.id);
  await expect(page.getByTestId('group-history')).toContainText(closed.id);
  await filterButton.click();
  await expect(sort).toHaveText('По умолчанию');
});

test('единственный активный срок пропадает и появляется в основном списке при обновлении источника', async ({page, source}) => {
  const one = source.issue('SINGLE', 20);
  const missing = source.issue('NO-DATE', null);
  const invalid = source.issue('BAD-DATE', null, {deadline: 'неизвестно'});
  const done = source.issue('DONE', 2, {stateEnum: 'Resolved', stateId: 7, state: 'Завершен'});
  const records = [missing, invalid, done, one];
  await source.update(records);
  await login(page);

  const widget = page.locator('.deadline-focus');
  await widget.getByRole('button', {name: /Все сроки\s*·\s*1/}).click();
  await expectList(page, [one.id]);
  await expectIncident(widget, one.id);

  one.deadline = null;
  await source.update(records);
  await expectList(page, []);
  await expect(widget).toContainText(/Нет активных инцидентов с указанным сроком/i);
  missing.deadline = source.issue(missing.id, -5).deadline;
  await source.update(records);
  await expectList(page, [missing.id]);
  await expectIncident(widget, missing.id);
});

test('на телефоне кнопка приводит к результатам, а снятие фильтра возвращает прежнюю сортировку', async ({page, source}) => {
  await page.setViewportSize({width:375,height:780});
  const first = source.issue('DUE-SOON', 18, {priorityId:2,priority:'Средний'});
  const later = source.issue('DUE-LATER', 60);
  await source.update([later,first]);
  await login(page);
  const filter = page.getByRole('banner').getByRole('button', {name:/Фильтры/});
  const panel = page.getByRole('dialog', {name:'Настройки списка инцидентов'});
  const sort = panel.getByRole('button', {name:'Сортировка',exact:true});
  await filter.click();
  await sort.click();
  await page.getByRole('option', {name:'Сначала высокий приоритет'}).click();
  await panel.getByRole('button', {name:'Готово'}).click();
  await page.locator('.deadline-all').click();
  await expectList(page,[first.id,later.id]);
  const heading = page.getByTestId('deadline-results').getByRole('heading', {level:2});
  await expect(heading).toBeFocused();
  const header = await page.getByRole('banner').boundingBox();
  expect((await heading.boundingBox())!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
  await page.reload();
  await expectList(page,[first.id,later.id]);
  await page.getByRole('button', {name:'Сбросить фильтр по срокам'}).click();
  await filter.click();
  await expect(sort).toHaveText('Сначала высокий приоритет');
});
