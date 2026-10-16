// Uses an installed Edge/Chrome, or Playwright's Chromium. No browser download needed on Windows.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from '../server.js';

const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; }
    catch { /* Try the next installed browser. */ }
  }
  if (!browser) throw new Error('No browser found. Install Edge/Chrome or run npx playwright install chromium.');
  const context = await browser.newContext({ viewport: { width: 1200, height: 950 } });
  const page = await context.newPage();
  const errors = [];
  const results = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByText('Page cached · ready to reopen offline').waitFor();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.getByLabel('Simulate offline').check();
  await context.setOffline(true);
  await page.getByLabel('Document ID').fill('browser-test');
  await page.getByLabel('Title', { exact: true }).fill('Star Wars');
  await page.getByLabel('Year', { exact: true }).fill('1977');
  await page.getByLabel('Actors', { exact: true }).fill('Carrie Fisher, Harrison Ford');
  await page.getByLabel('Genres', { exact: true }).fill('Animation, History, Sport');
  await page.getByRole('button', { name: 'Save locally' }).click();
  await page.getByRole('heading', { name: 'Star Wars (1977)', exact: true }).waitFor();
  results.push('PASS: create while browser network is offline');
  await page.reload();
  await page.getByRole('heading', { name: 'Star Wars (1977)', exact: true }).waitFor();
  results.push('PASS: offline reload loads cached page and preserves IndexedDB movie');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Star Wars offline update');
  await page.getByRole('button', { name: 'Save locally' }).click();
  await page.getByRole('heading', { name: 'Star Wars offline update (1977)' }).waitFor();
  results.push('PASS: update while browser network is offline');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByText('No movies yet. Add your first movie.').waitFor();
  const deleted = await page.evaluate(async () => {
    const db = new PouchDB('schema-a-movies');
    const result = await db.changes({ since: 0 });
    return result.results.find(row => row.id === 'browser-test').deleted;
  });
  assert.equal(deleted, true);
  results.push('PASS: offline delete produces a tombstone');
  await context.setOffline(false);

  // A separate IndexedDB database represents another replica for UI conflict testing.
  // This does not claim to be a real CouchDB server integration test.
  await page.evaluate(async () => {
    const local = new PouchDB('schema-a-movies');
    const peer = new PouchDB('browser-test-peer');
    const { MovieStore } = await import('/movies.js');
    const store = new MovieStore(local);
    const movie = { title: 'Base movie', actors: ['Carrie Fisher'], genres: ['History'], year: 1977 };
    await store.create(movie, 'conflict-test');
    await local.sync(peer);
    await store.update(await store.get('conflict-test'), { ...movie, title: 'Local branch' });
    const remote = await peer.get('conflict-test');
    await peer.put({ ...remote, title: 'Remote branch' });
    await local.sync(peer);
    // PouchDB close() closes shared browser handles. Keep the application's
    // database open until the isolated browser context is disposed.
  });
  await page.getByRole('button', { name: 'Resolve conflict', exact: true }).click();
  const chosen = await page.locator('.version').nth(1).locator('pre').textContent();
  const chosenTitle = JSON.parse(chosen).title;
  await page.locator('.version').nth(1).getByRole('button', { name: 'Keep this version' }).click();
  await page.getByRole('heading', { name: `${chosenTitle} (1977)`, exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Resolve conflict', exact: true }).count(), 0);
  await page.getByLabel('Find a movie', { exact: true }).fill('no-such-movie');
  await page.getByText('No matching movies.', { exact: true }).waitFor();
  await page.getByLabel('Find a movie', { exact: true }).fill('conflict-test');
  await page.getByRole('heading', { name: `${chosenTitle} (1977)`, exact: true }).waitFor();
  results.push('PASS: collection search filters by title or document ID');
  await page.evaluate(async () => {
    const local = new PouchDB('schema-a-movies');
    const peer = new PouchDB('browser-test-peer');
    await local.sync(peer);
    const doc = await peer.get('conflict-test', { conflicts: true });
    if (doc._conflicts) throw new Error('Unresolved conflict at peer');
  });
  results.push('PASS: conflict UI displays branches, keeps chosen contents and replicates resolution');

  await page.getByLabel('CouchDB database URL').fill('http://127.0.0.1:65534/movies');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#sync-state[data-state="retrying"]').waitFor().catch(async error => {
    console.error('Retry check diagnostic:', await page.locator('.connection').innerText());
    throw error;
  });
  results.push('PASS: unavailable CouchDB shows automatic retry status');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.locator('#sync-state[data-state="local"]').waitFor();
  await page.getByLabel('CouchDB database URL').fill('http://localhost:5984/schema_a_movies');
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('../test-results/desktop.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  results.push('PASS: mobile layout has no horizontal overflow');
  assert.deepEqual(errors, []);
  results.push('PASS: no uncaught browser errors');
  const report = `${results.join('\n')}\n\nThis command uses a local peer. See couchdb-check.txt for the separate real CouchDB integration results.\n`;
  await writeFile(new URL('../test-results/browser-check.txt', import.meta.url), report);
  console.log(report);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
