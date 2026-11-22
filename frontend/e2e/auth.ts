import type { Page } from '@playwright/test';

export async function signIn(page:Page) {
  const password = process.env.E2E_COORDINATOR_PASSWORD;
  if (!password) throw new Error('Тестовый пароль отсутствует в окружении Playwright.');
  await page.getByLabel('Логин',{exact:true}).fill('e2e.coordinator');
  await page.getByLabel('Пароль',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Войти',exact:true}).click();
}
