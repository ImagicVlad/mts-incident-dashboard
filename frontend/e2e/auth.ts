import type { Page } from '@playwright/test';

export async function signIn(page:Page, role:'coordinator'|'executor'='coordinator') {
  const password = process.env[role==='coordinator'?'E2E_COORDINATOR_PASSWORD':'E2E_EXECUTOR_PASSWORD'];
  if (!password) throw new Error('Тестовый пароль отсутствует в окружении Playwright.');
  await page.getByLabel('Логин',{exact:true}).fill('e2e.'+role);
  await page.getByLabel('Пароль',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();
}
