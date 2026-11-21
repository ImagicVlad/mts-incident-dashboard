import { expect, test } from '@playwright/test';
import { readFile, rename, writeFile } from 'node:fs/promises';

const file = process.env.E2E_SOURCE!;
async function replace(contents: string) {
  await writeFile(file + '.writing', contents, 'utf8');
  await rename(file + '.writing', file);
}

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

test('высокий приоритет появляется в критических по часам сервера', async ({page}) => {
  const initial = await readFile(file, 'utf8');
  const data = JSON.parse(initial);
  const issue = data.find((row: {priorityId:number; stateEnum:string}) =>
    row.priorityId === 3 && row.stateEnum === 'WorkInProgress');
  try {
    await page.goto('/login');
    await page.getByRole('button', {name:'Войти', exact:true}).click();
    const critical = page.getByTestId('group-critical');
    await expect(critical).toBeVisible();

    // The final quarter of this 160-second interval starts six seconds from now.
    const now = Date.now();
    issue.submitDate = new Date(now - 114_000).toISOString();
    issue.deadline = new Date(now + 46_000).toISOString();
    issue.header = 'Проверка окна срочности';
    await replace(JSON.stringify(data));
    await expect(page.getByTestId('group-high').getByText(issue.header)).toBeVisible();
    const card = critical.locator(`[data-incident-id="${issue.id}"]`);
    await expect(card).toHaveCount(0);
    await expect(card).toContainText('Высокий приоритет · срок близко', {timeout:15_000});

    await page.getByRole('button', {name:/Оповещения/}).click();
    await expect(page.locator('.notifications-panel .result-link').filter({hasText:issue.id})).toHaveCount(1);
    await expect(page.getByTestId('group-high').getByText(issue.header)).toBeVisible();
  } finally { await replace(initial); }
});
