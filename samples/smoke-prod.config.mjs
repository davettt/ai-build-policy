// Sample from the guidebook (MIT licence). It shows how I configure a read-only production
// smoke test; read it and adapt it to your project rather than copying it as is.
// See guide 3.2.
// Production smoke test.
// Run after every deploy with: npm run smoke:prod
//
// It tests the deployed site, so it starts no local server: smoke:prod sets
// PLAYWRIGHT_BASE_URL to the production URL, and a local server here would
// mean the "production" run tested localhost. The main Playwright config
// ignores tests/smoke-prod (testIgnore), so the local flows never run it.
// Read-only and unauthenticated: no form submits, bookings, payments or
// sign-ins.
import { defineConfig } from '@playwright/test';

if (!process.env.PLAYWRIGHT_BASE_URL) {
  throw new Error('PLAYWRIGHT_BASE_URL is not set: run npm run smoke:prod');
}

export default defineConfig({
  testDir: './tests/smoke-prod',
  retries: 1,
  reporter: 'list',
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
