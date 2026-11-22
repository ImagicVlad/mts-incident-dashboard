import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.platform === 'win32' ? 'backend/.venv/Scripts/python.exe' : 'backend/.venv/bin/python';
process.env.E2E_SOURCE ??= path.join(root, 'data', 'runtime', 'e2e-' + randomUUID() + '.json');
process.env.E2E_COORDINATOR_PASSWORD ??= randomUUID();

export default defineConfig({
  testDir: './e2e', workers: 1, timeout: 60_000, expect: { timeout: 10_000 },
  use: { baseURL: 'http://127.0.0.1:5186', reducedMotion: 'reduce',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } },
  webServer: [
    {command: '"' + path.resolve(root, python) + '" scripts/e2e_server.py', cwd: root, url: 'http://127.0.0.1:8016/api/health', timeout: 45_000},
    {command: 'npm run dev -- --host 127.0.0.1 --port 5186 --strictPort', url: 'http://127.0.0.1:5186',
      env:{API_PROXY_TARGET: 'http://127.0.0.1:8016'}, timeout: 60_000},
  ],
});
