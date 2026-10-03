import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'tests/e2e', timeout:30000, fullyParallel:false, workers:1,
  use:{ baseURL:'http://localhost:4173', viewport:{ width:1440,height:950 }, trace:'retain-on-failure', serviceWorkers:'allow' },
  webServer:{ command:'bun run build && bun run preview', url:'http://localhost:4173', reuseExistingServer:!process.env.CI, timeout:30000 },
  reporter:'list'
});
