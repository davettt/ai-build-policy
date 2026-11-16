// Sample from the guidebook (MIT licence). It shows how I write a read-only production smoke
// test; read it and adapt it to your project rather than copying it as is.
// See guide 3.2.
// Production smoke test: a starter. Add the site's key pages to PAGES and any
// site-specific check (a JSON file that must parse, a heading that must read
// a certain way). Read-only: GET requests and page loads only. Never submit a
// form, book, pay or sign in from here.
import { test, expect } from '@playwright/test';

// Pages that must answer 200 and render a heading.
const PAGES = ['/'];

for (const path of PAGES) {
  test(`${path} loads with a heading and no console errors`, async ({ page }) => {
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(path);
    expect(res && res.status()).toBe(200);
    await expect(page.locator('h1').first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('internal links on the home page resolve', async ({ page, request, baseURL }) => {
  await page.goto('/');
  const origin = new URL(baseURL).origin;
  const hrefs = await page.$$eval('a[href]', (links) => links.map((a) => a.href));
  const internal = [
    ...new Set(
      hrefs
        .map((h) => new URL(h))
        .filter((u) => u.origin === origin)
        .map((u) => u.origin + u.pathname + u.search),
    ),
  ];
  expect(internal.length).toBeGreaterThan(0);
  for (const href of internal) {
    const res = await request.get(href);
    expect(res.status(), href).toBeLessThan(400);
  }
});
