import { expect, test } from '@playwright/test';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { displayFormats } from '../src/api';

const file = process.env.E2E_SOURCE!;
async function replace(contents: string) {
  await writeFile(file + '.writing', contents, 'utf8');
  await rename(file + '.writing', file);
}

test('срочные события всплывают один раз, просмотр ленты снимает точку', async ({page}) => {
  const original = await readFile(file, 'utf8');
  const issue = {id: 'NOTICE-1', stateEnum: 'Assigned', priorityId: 2, assignedGroupName: '', deadline: ''};
  const records = JSON.parse(original);
  const publish = () => replace(JSON.stringify([...records, issue]));
  const bell = page.getByRole('button', {name: /^Оповещения/});
  const dot = bell.locator('i');
  const panel = page.locator('.notifications-panel');
  const toast = page.locator('.toast').filter({hasText: issue.id});
  try {
    await publish();
    await page.goto('/login');
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/incidents/events')),
      page.getByRole('button', {name: 'Войти', exact: true}).click(),
    ]);
    await bell.click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', {name: 'Открепить ИИ-чат'}).click();
    await page.getByRole('button', {name: 'Развернуть чат'}).click();
    Object.assign(issue, {priorityId: 4, assignedGroupName: 'КЦ ИТ Координаторы Массовых Инцидентов'});
    await publish();
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText('Критический инцидент поступил координаторам');
    await expect(dot).toBeVisible();
    await toast.getByRole('button').click();
    await expect(dot).toBeVisible();
    await bell.click();
    await expect(panel.getByRole('link').filter({hasText: issue.id})).toHaveCount(1);
    await expect(dot).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(bell).toBeVisible();
    await expect(dot).toHaveCount(0);

    issue.deadline = new Date(Date.now() - 1000).toISOString();
    await publish();
    await expect(toast).toContainText('Нарушен срок SLA');
    await toast.getByRole('button').click();
    issue.stateEnum = 'Research';
    await publish();
    await bell.click();
    const issueEvents = panel.getByRole('link').filter({hasText: issue.id});
    await expect(issueEvents.filter({hasText: 'Инцидент перешёл в исследование'})).toBeVisible();
    await expect(toast).toHaveCount(0);
    issue.stateEnum = 'Resolved';
    await publish();
    await expect(issueEvents.filter({hasText: 'Инцидент решён'})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dot).toHaveCount(0);
    await expect(toast).toHaveCount(0);
  } finally { await replace(original); }
});

test('краткие карточки показывают команду и живой SLA, исполнитель и срок доступны в подробностях', async ({page}) => {
  const original = await readFile(file, 'utf8');
  const [urgent, coordinator, sparse, , review] = JSON.parse(original);
  urgent.deadline = new Date(Date.now() - 3_600_000).toISOString();
  urgent.header = 'Нарушена доставка событий в региональные системы мониторинга. '.repeat(4).trim();
  urgent.assignedGroupName = 'Поддержка ' + 'МежрегиональнаяПлатформа'.repeat(5);
  urgent.assignedEmployee = 'Дежурный ' + 'ДвойнаяФамилия'.repeat(6);
  urgent.productName = 'МониторингСети'.repeat(6);
  Object.assign(sparse, {priorityId: 4, productName: null, header: null, submitDate: null, deadline: null,
    assignedGroupName: null, lastAssignmentToTeamDateTime: null});
  review.deadline = null;
  const card = (group: string, id: string) => page.getByTestId('group-' + group).locator(`[data-incident-id="${id}"]`);
  try {
    await replace(JSON.stringify([urgent, coordinator, sparse, review]));
    await page.clock.install();
    await page.goto('/login');
    await page.getByRole('button', {name: 'Войти', exact: true}).click();
    const overdue = card('critical', urgent.id);
    const high = card('high', coordinator.id);
    const research = card('review', review.id);
    await expect(overdue.locator('.time-left')).toContainText('Просрочен');
    await expect(high.locator('.time-left')).toContainText('Осталось');
    await expect(high.locator('.coordinator-since')).toContainText('У координаторов с');
    await expect(research.locator('.time-left')).toContainText('Сбой устранён');
    await expect(page.locator('.incident').filter({hasText: /Исполнитель|Срок устранения/i})).toHaveCount(0);
    await expect(overdue).not.toContainText(urgent.assignedEmployee);
    await expect(overdue).not.toContainText(displayFormats().stamp(urgent.deadline));
    const minimal = card('critical', sparse.id);
    await expect(minimal).toBeVisible();
    await expect(minimal.locator('h3, .product, .card-meta, .card-foot')).toHaveCount(0);
    for (const [item, source] of [[coordinator, high], [review, research]] as const) {
      await expect(card('assigned', item.id)).toHaveText(await source.innerText(), {useInnerText: true});
    }

    for (const width of [1440, 820, 390, 320]) {
      await page.setViewportSize({width, height: 900});
      for (const entry of [overdue, high, card('assigned', coordinator.id), research]) {
        const layout = await entry.evaluate(el => {
          const rect = (selector: string) => el.querySelector(selector)!.getBoundingClientRect();
          const header = rect('.card-top'), pill = rect('.pill'), identity = rect('.card-identity');
          const id = rect('.mono'), product = rect('.product');
          const title = rect('h3'), meta = rect('.card-meta'), foot = rect('.card-foot');
          const start = rect('.card-meta > span'), team = rect('.card-team'), timer = rect('.time-left');
          return {
            statusRight: header.right - pill.right, statusTop: pill.top - header.top,
            timerRight: foot.right - timer.right, timerBottom: foot.bottom - timer.bottom,
            metadataLeft: meta.left - foot.left, zonesSeparate: meta.right <= timer.left,
            inlineWhenWide: innerWidth < 1440 || (start.right <= team.left && Math.abs(start.top - team.top) < 1),
            identityOrdered: id.right <= product.left && product.right <= pill.left && product.top < id.bottom,
            rowsOrdered: identity.right <= pill.left && header.bottom < title.top && title.bottom < foot.top && meta.bottom === foot.bottom,
            overflows: el.scrollWidth > el.clientWidth || document.documentElement.scrollWidth > innerWidth,
          };
        });
        expect(layout).toEqual({statusRight: 0, statusTop: 0, timerRight: 0, timerBottom: 0, metadataLeft: 0,
          zonesSeparate: true, inlineWhenWide: true, identityOrdered: true, rowsOrdered: true, overflows: false});
      }
    }
    const timer = high.locator('.time-left');
    const before = await timer.innerText();
    await page.clock.fastForward(60_000);
    await expect(timer).not.toHaveText(before);
    await expect(timer).toContainText('Осталось');
    await overdue.click();
    await expect(page.getByRole('heading', {name: urgent.header, exact: true})).toBeVisible();
    const facts = page.locator('.facts');
    await expect(facts.getByText('Исполнитель', {exact: true}).locator('+ dd')).toHaveText(urgent.assignedEmployee);
    await expect(facts.getByText('Плановый срок устранения', {exact: true}).locator('+ dd')).toHaveText(displayFormats().stamp(urgent.deadline));
  } finally { await replace(original); }
});

test('название команды сокращается по ширине карточки и раскрывается при откреплении чата', async ({page}) => {
  const original = await readFile(file, 'utf8');
  const [source, ...others] = JSON.parse(original);
  const team = 'Группа сопровождения региональной платёжной платформы';
  const long = {...source, assignedGroupName: team};
  const short = {...source, id: 'TEAM-0000', sysId: 'team-layout-test', assignedGroupName: 'ИТ'};
  const critical = page.getByTestId('group-critical');
  const longCard = critical.locator(`[data-incident-id="${long.id}"]`);
  const shortCard = critical.locator(`[data-incident-id="${short.id}"]`);
  const value = longCard.locator('.card-team b');
  const clipped = () => value.evaluate(el => el.scrollWidth > el.clientWidth);
  try {
    await replace(JSON.stringify([long, short, ...others]));
    await page.goto('/login');
    await page.getByRole('button', {name: 'Войти', exact: true}).click();
    await expect(value).toHaveText(team);
    await expect(value).toHaveAttribute('title', team);
    await expect(value).toHaveCSS('text-overflow', 'ellipsis');
    await expect(value).toHaveCSS('white-space', 'nowrap');

    for (const width of [1920, 1280, 820, 390, 320, 1920]) {
      await page.setViewportSize({width, height: 900});
      if (width === 1920) expect(await clipped()).toBe(false);
      if (width <= 390) expect(await clipped()).toBe(true);
      const shortValue = shortCard.locator('.card-team b');
      expect(await shortValue.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const fullHeight = await longCard.evaluate(el => el.getBoundingClientRect().height);
      expect(await shortCard.evaluate(el => el.getBoundingClientRect().height)).toBe(fullHeight);
    }

    await page.setViewportSize({width: 1100, height: 900});
    await value.hover();
    expect(await clipped()).toBe(true);
    await page.getByRole('button', {name: 'Открепить ИИ-чат'}).click();
    await expect.poll(clipped).toBe(false);
    await page.getByRole('button', {name: 'Закрыть окно и вернуть чат на дашборд'}).click();
    await expect.poll(clipped).toBe(true);
    await longCard.click();
    await expect(page.locator('.facts').getByText(team, {exact: true})).toBeVisible();
  } finally { await replace(original); }
});

test('сводка показывает пример назначения и скрывает совет после передачи команде', async ({page}) => {
  const original = await readFile(file, 'utf8');
  const records = JSON.parse(original);
  const [incident, example] = records;
  incident.assignedGroupName = null;
  try {
    await replace(JSON.stringify(records));
    await page.route('**/api/health', route => route.fulfill({json: {
      status: 'ok', aiConfigured: true, displayTimezone: 'Europe/Moscow',
    }}));
    await page.goto('/login');
    await page.getByRole('button', {name: 'Войти', exact: true}).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/incidents/' + incident.id);
    await expect(page.getByRole('heading', {name: 'Данные инцидента'})).toBeVisible();
    await expect(page.getByRole('region', {name: 'ИИ-чат', exact: true})).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'Открыть ИИ-чат'})).toHaveCount(0);
    const section = page.locator('section.ai-note');
    const paper = page.locator('.record-grid > .paper');
    const bottom = (locator: typeof paper) => locator.evaluate(el => el.getBoundingClientRect().bottom);
    expect(await bottom(section)).toBeLessThan(await bottom(paper));
    await page.route('**/api/ai/summary', async route => {
      const live = await page.request.get('/api/incidents');
      const {epoch, snapshotVersion, serverTime, incidents} = await live.json();
      const assigned = incidents.find((row: {id: string}) => row.id === incident.id).assignedGroupName;
      await route.fulfill({json: {epoch, snapshotVersion, asOf: serverTime, answer: 'Сводка', assessment: {
        situation: 'Пробные платежи задерживаются.', impact: 'Два платежа находятся в обработке. '.repeat(80),
        check: 'Сверить время зачисления двух платежей.',
        routing: assigned ? null : {team: 'Расчёты', exampleId: example.id, reason: 'Совпадает сервис зачисления.'},
      }}});
    });
    await section.getByRole('button', {name: 'Сформировать сводку'}).click();
    await expect(section.getByRole('heading', {name: 'Что проверить'})).toBeVisible();
    const summaryText = section.getByRole('region', {name: 'Текст ИИ-сводки'});
    await expect.poll(async () => Math.abs(await bottom(section) - await bottom(paper))).toBeLessThan(1);
    await summaryText.press('Control+End');
    await expect.poll(() => summaryText.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await bottom(section.getByRole('button'))).toBeLessThan(await bottom(section));
    await expect(section.getByRole('link', {name: 'Похожий инцидент · ' + example.id})).toHaveAttribute('href', '/incidents/' + example.id);
    incident.assignedGroupName = 'Расчёты';
    await replace(JSON.stringify(records));
    await expect(section.getByText(/данные изменились/)).toBeVisible();
    await expect(section.getByRole('heading', {name: 'Рекомендация по команде'})).toHaveCount(0);
    await section.getByRole('button', {name: 'Обновить сводку'}).click();
    await expect(section.getByText(/данные изменились/)).toHaveCount(0);
    await expect(section.getByRole('link')).toHaveCount(0);
  } finally { await replace(original); }
});

test('две вкладки получают изменения, переживают ошибку файла и возвращаются к сессии', async ({page,context}) => {
  const initial = await readFile(file, 'utf8');
  const data = JSON.parse(initial) as Array<Record<string, string | number | boolean | null>>;
  const issue = data[0];
  try {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByRole('button',{name:'Войти',exact:true}).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    const high = page.getByTestId('group-high');
    await expect(high.locator('[data-incident-id]')).toHaveCount(2);
    await high.getByRole('button').click();
    await expect(high.locator('[data-incident-id]')).toHaveCount(3);
    const history = page.getByTestId('group-history');
    await history.getByRole('button').click();
    for (const record of data.filter(row => row.stateEnum === 'Resolved' || row.stateEnum === 'Closed')) {
      await expect(history.locator(`[data-incident-id="${record.id}"] .pill`)).toHaveText('Решён');
    }
    await history.getByRole('button').click();
    await expect(page.getByText('ИИ не настроен', {exact:false}).first()).toBeVisible();
    const tab = await context.newPage();
    await tab.goto('/routes/itsm/incident/#' + issue.id);
    await expect(tab.getByRole('heading',{name:String(issue.header),exact:true})).toBeVisible();
    await page.evaluate(() => { document.documentElement.dataset.liveTest='same-page'; });
    const search = page.getByRole('searchbox');
    await search.fill(String(issue.id));
    await expect(page.locator('.search-results a')).toHaveCount(1);
    issue.header='Проверка обновления без перезагрузки';
    issue.assignedGroupName='КЦ ИТ Координаторы Массовых Инцидентов';
    issue.deadline=new Date(Date.now()+95*60_000).toISOString();
    await replace(JSON.stringify(data));
    await expect(tab.getByRole('heading',{name:String(issue.header),exact:true})).toBeVisible();
    await expect(search).toHaveValue(String(issue.id));
    await search.press('Escape');
    await expect(high.getByRole('button')).toHaveAttribute('aria-expanded','true');
    const critical = page.getByTestId('group-critical');
    await expect(critical.getByText(String(issue.header))).toBeVisible();
    await page.getByRole('button',{name:/Оповещения/}).click();
    await expect(page.locator('.notifications-panel')).toContainText(String(issue.id));
    await page.keyboard.press('Escape');
    issue.stateEnum='Resolved'; issue.state='Завершен'; issue.stateId=7; issue.priorityId=2;
    issue.priority='Средний'; issue.completionDate=new Date().toISOString();
    await replace(JSON.stringify(data));
    await expect(critical.locator('[data-incident-id]')).toHaveCount(0);
    await expect(history.locator(`[data-incident-id="${issue.id}"] .pill`)).toHaveText('Решён');
    await expect(tab.locator('.record-label .pill')).toHaveText('Завершен');
    await replace('[{');
    await expect.poll(async () => (await (await context.request.get('/api/incidents')).json()).sourceStatus).toBe('error');
    await expect(tab.getByRole('heading',{name:String(issue.header),exact:true})).toBeVisible();
    await replace(initial);
    await expect(critical.locator('[data-incident-id]')).toHaveCount(1);
    await expect(page.locator('html')).toHaveAttribute('data-live-test','same-page');
    await context.setOffline(true);
    await context.setOffline(false);
    await page.getByRole('button',{name:'Аккаунт',exact:true}).click();
    await page.getByRole('button',{name:'Выйти из аккаунта'}).click();
    await expect(page).toHaveURL(/\/login$/);
    expect((await context.request.get('/api/incidents')).status()).toBe(401);
  } finally { await replace(initial); }
});

test('инцидент меняет очередь при достижении порога и переносе срока', async ({page}) => {
  const initial = await readFile(file, 'utf8');
  const data = JSON.parse(initial);
  const issue = data.find((row: {priorityId:number; stateEnum:string}) =>
    row.priorityId === 3 && row.stateEnum === 'WorkInProgress');
  try {
    await page.goto('/login');
    await page.getByRole('button', {name:'Войти', exact:true}).click();
    const critical = page.getByTestId('group-critical');
    await expect(critical).toBeVisible();
    const high = page.getByTestId('group-high');
    await high.getByRole('button').click();
    const selector = `[data-incident-id="${issue.id}"]`;
    const highCard = high.locator(selector);
    const criticalCard = critical.locator(selector);
    const highCount = page.locator('.metric[href="#high"] .count');
    const criticalCount = page.locator('.metric[href="#critical"] .count');

    const bell = page.getByRole('button', {name: /Оповещения/});
    const alerts = page.locator('.notifications-panel .result-link')
      .filter({hasText: issue.id}).filter({hasText: 'Инцидент стал критическим'});
    await bell.click();
    const earlierAlerts = await alerts.count();
    await page.keyboard.press('Escape');

    // The final quarter of this 160-second interval starts six seconds from now.
    const now = Date.now();
    issue.submitDate = new Date(now - 114_000).toISOString();
    issue.deadline = new Date(now + 46_000).toISOString();
    issue.header = 'Проверка окна срочности';
    await replace(JSON.stringify(data));
    await expect(highCard).toContainText(issue.header);
    await expect(highCard).toHaveAttribute('data-priority','high');
    await expect(criticalCard).toHaveCount(0);
    await expect(highCount).toHaveText('3');
    await expect(criticalCard).toBeVisible({timeout:15_000});
    await expect(criticalCard).toHaveAttribute('data-priority','critical');
    await expect(highCard).toHaveCount(0);
    await expect(highCount).toHaveText('2');
    await expect(criticalCount).toHaveText('2');

    await bell.click();
    await expect(alerts).toHaveCount(earlierAlerts + 1);
    await page.keyboard.press('Escape');
    issue.deadline = new Date(now + 4 * 3_600_000).toISOString();
    await replace(JSON.stringify(data));
    await expect(highCard).toHaveAttribute('data-priority','high');
    await expect(criticalCard).toHaveCount(0);
    await expect(highCount).toHaveText('3');
    await expect(criticalCount).toHaveText('1');
  } finally { await replace(initial); }
});

test('команда координаторов и стадия исследования меняются независимо', async ({page}) => {
  const initial = await readFile(file, 'utf8');
  const issue = {
    ...JSON.parse(initial)[0], id:'DEMO-COORD', priorityId:4, priority:'Наивысший',
    stateEnum:'Assigned', stateId:0, state:'Назначен', assignedGroupName:null,
    completionDate:null, deadline:new Date(Date.now() + 3_600_000).toISOString(),
  };
  const publish = () => replace(JSON.stringify([issue]));
  const selector = `[data-incident-id="${issue.id}"]`;
  const assigned = page.getByTestId('group-assigned').locator(selector);
  const research = page.getByTestId('group-review').locator(selector);
  const critical = page.getByTestId('group-critical').locator(selector);
  const history = page.getByTestId('group-history').locator(selector);
  const reviewAction = 'Передать разбор причин профильной команде';
  try {
    await publish();
    await page.goto('/login');
    await page.getByRole('button', {name:'Войти', exact:true}).click();
    await expect(critical).toBeVisible();
    await expect(assigned).toHaveCount(0);

    issue.assignedGroupName = 'КЦ ИТ Координаторы Массовых Инцидентов';
    await publish();
    await expect(assigned.locator('.pill')).toHaveText('Назначен координаторам');
    const detail = await page.context().newPage();
    await detail.goto('/incidents/' + issue.id);
    const handoff = detail.locator('.facts dt').filter({hasText:'Следующий шаг'}).locator('+ dd');
    await expect(handoff).toHaveText('Передать инцидент профильной команде');
    await expect(assigned).not.toContainText('Передать инцидент');

    Object.assign(issue, {stateEnum:'WorkInProgress', stateId:2, state:'Выполняется'});
    await publish();
    await expect(assigned.locator('.pill')).toHaveText('В работе у координаторов');

    Object.assign(issue, {stateEnum:'Research', stateId:20, state:'Исследование ситуации',
      completionDate:new Date().toISOString()});
    await publish();
    for (const card of [assigned, research]) {
      await expect(card.locator('.pill')).toHaveText('Разбор причин');
      await expect(card).not.toContainText(/Осталось|Просрочен/);
    }
    await expect(handoff).toHaveText(reviewAction);
    await expect(assigned).not.toContainText(reviewAction);
    await expect(critical).toHaveCount(0);
    await expect(history).toHaveCount(0);

    await replace(JSON.stringify([issue, {id:'TEAM-EXAMPLE', stateEnum:'Closed',
      assignedGroupName:'Платёжные сервисы', assignedEmployee:'Дежурный инженер'}]));
    await expect(detail.locator('.facts')).toContainText('Ещё не назначена');
    await detail.locator('.paper footer').getByRole('button', {name:'Назначить команду'}).click();
    await expect(detail.getByRole('button', {name:'Передать команде'})).toBeDisabled();
    await detail.getByRole('button', {name:'Профильная команда', exact:true}).click();
    await expect(detail.getByRole('option', {name:issue.assignedGroupName!})).toHaveCount(0);
    await detail.getByRole('option', {name:'Платёжные сервисы'}).click();
    await detail.getByRole('button', {name:'Исполнитель', exact:true}).click();
    await detail.getByRole('option', {name:'Дежурный инженер'}).click();
    await detail.getByRole('button', {name:'Передать команде', exact:true}).click();
    await expect(research).toContainText('Платёжные сервисы');
    await detail.reload();
    await expect(detail.locator('.facts dd').filter({hasText:'Дежурный инженер'})).toBeVisible();
    await expect(handoff).toHaveCount(0);
    await expect(research).not.toContainText(reviewAction);
    await expect(assigned).toHaveCount(0);

    Object.assign(issue, {stateEnum:'Closed', stateId:10, state:'Закрыт'});
    await publish();
    await expect(history.locator('.pill')).toHaveText('Решён');
    await expect(research).toHaveCount(0);
    await expect(assigned).toHaveCount(0);
  } finally { await replace(initial); }
});
