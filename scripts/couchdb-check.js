// Credentials arrive on hidden stdin, never through command-line arguments or files.
import PouchDB from 'pouchdb';
import assert from 'node:assert/strict';
import { mkdtemp, rmdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MovieStore } from '../public/movies.js';
import { SyncController, databaseURL } from '../public/sync.js';
import { createServer } from '../server.js';
import { chromium } from 'playwright';

async function readInput() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write('Ready for CouchDB test JSON on stdin (input hidden).\n');
  let input = '';
  return new Promise((resolve, reject) => {
    const onData = chunk => {
      input += chunk.toString();
      if (input.includes('\u0003')) process.exit(130);
      if (!input.includes('\n') && !input.includes('\r')) return;
      process.stdin.off('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      try { resolve(JSON.parse(input.trim())); } catch { reject(new Error('Expected one JSON object on stdin.')); }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

const input = await readInput();
const url = databaseURL(input.url);
const auth = { username: input.username, password: input.password };
const headers = { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
const endpoint = new URL(url);
const root = endpoint.origin;
const remote = new PouchDB(url, { auth, skip_setup: true });
const info = await remote.info();
console.log(`Connected to CouchDB database: ${info.db_name} (${info.doc_count} live documents)`);
for (const route of ['/_node/_local/_config/chttpd/enable_cors', '/_node/_local/_config/cors']) {
  const response = await fetch(root + route, { headers });
  console.log('CORS configuration:', route, response.status, JSON.stringify(await response.json()));
}
if (input.configureCors) {
  const configBase = root + '/_node/_local/_config/';
  const current = await (await fetch(configBase + 'cors/origins', { headers })).json();
  const origins = new Set(typeof current === 'string' ? current.split(',').map(value => value.trim()) : []);
  origins.delete('*');
  origins.add('http://localhost:8000');
  origins.add('http://127.0.0.1:8000');
  for (const [key, value] of Object.entries({
    'chttpd/enable_cors': 'true', 'cors/origins': [...origins].join(','),
    'cors/credentials': 'true', 'cors/methods': 'GET, PUT, POST, HEAD, DELETE, OPTIONS',
    'cors/headers': 'accept, authorization, content-type, origin, referer'
  })) {
    const response = await fetch(configBase + key, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(value)
    });
    if (!response.ok) throw new Error(`Cannot configure ${key}: HTTP ${response.status}`);
  }
  console.log('Enabled CouchDB CORS for localhost:8000 and 127.0.0.1:8000.');
}
if (input.inspectOnly) {
  await remote.close();
  process.exit(0);
}

const dir = await mkdtemp(path.join(tmpdir(), 'offline-movies-couchdb-'));
const local = new PouchDB(path.join(dir, 'local'));
const other = new PouchDB(path.join(dir, 'other'));
const store = new MovieStore(local);
const prefix = `offline-demo-check-${crypto.randomUUID()}`;
const ids = ['created', 'updated', 'deleted', 'conflict'].map(suffix => `${prefix}-${suffix}`);
const [created, updated, deleted, conflicted] = ids;
const base = { title: 'Integration demonstration', actors: ['Carrie Fisher'], genres: ['History'], year: 1977 };
const report = [];
async function waitFor(condition) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for CouchDB replication.');
}

try {
  // Restrict all test replication to this run's new IDs, never existing coursework records.
  for (const id of [updated, deleted, conflicted]) await store.create(base, id);
  await local.replicate.to(remote, { doc_ids: ids });
  await other.replicate.from(remote, { doc_ids: ids });

  await store.create(base, created);
  await assert.rejects(remote.get(created), { status: 404 });
  report.push('PASS: create while offline exists locally and is absent from CouchDB');

  await store.update(await store.get(updated), { ...base, title: 'Offline update' });
  assert.equal((await remote.get(updated)).title, base.title);
  report.push('PASS: update while offline changes local data while CouchDB retains baseline');

  await store.remove(await store.get(deleted));
  await assert.rejects(local.get(deleted), { status: 404 });
  assert.equal((await remote.get(deleted)).title, base.title);
  report.push('PASS: delete while offline creates a local tombstone while CouchDB remains live');

  // doc_ids is used only by this test harness to isolate its temporary records.
  const isolatedLocal = { sync: (target, options) => local.sync(target, { ...options, doc_ids: ids }) };
  const reconnect = new SyncController(isolatedLocal, () => {});
  reconnect.setOffline(true);
  reconnect.connect(remote);
  reconnect.setOffline(false);
  try {
    await waitFor(async () => {
      const rows = (await remote.allDocs({ keys: ids, include_docs: true })).rows;
      return rows.find(row => row.id === created)?.doc?.title === base.title
        && rows.find(row => row.id === updated)?.doc?.title === 'Offline update'
        && rows.find(row => row.id === deleted)?.value?.deleted === true;
    });
  } finally { reconnect.disconnect(); }
  report.push('PASS: automatic live replication after reconnect sends create/update/delete to real CouchDB');

  await store.update(await store.get(conflicted), { ...base, title: 'Local conflict branch' });
  const remoteEdit = await other.get(conflicted);
  await other.put({ ...remoteEdit, title: 'Remote conflict branch' });
  await other.replicate.to(remote, { doc_ids: [conflicted] });
  await local.sync(remote, { doc_ids: [conflicted] });
  const versions = await store.versions(conflicted);
  assert.equal(versions.length, 2);
  assert.deepEqual(versions.map(doc => doc.title).sort(), ['Local conflict branch', 'Remote conflict branch']);
  await store.resolve(versions[0], versions[1]._rev);
  await local.sync(remote, { doc_ids: [conflicted] });
  const resolved = await remote.get(conflicted, { conflicts: true });
  assert.equal(resolved.title, versions[1].title);
  assert.equal(resolved._conflicts, undefined);
  report.push('PASS: conflict round trip through CouchDB preserves both branches and replicates manual resolution');
  if (input.browser) {
    const server = createServer();
    let browser;
    const browserId = `${prefix}-browser`;
    ids.push(browserId);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(8000, '127.0.0.1', resolve);
      });
      for (const channel of ['msedge', 'chrome', undefined]) {
        try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; }
        catch { /* Use an existing browser installation. */ }
      }
      if (!browser) throw new Error('No installed browser available for the CouchDB browser check.');
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://localhost:8000');
      await page.getByLabel('Document ID').fill(browserId);
      await page.getByLabel('Title', { exact: true }).fill('Temporary browser integration movie');
      await page.getByLabel('Year', { exact: true }).fill('1977');
      await page.getByRole('button', { name: 'Save locally' }).click();
      await page.getByRole('heading', { name: 'Temporary browser integration movie (1977)' }).waitFor();
      await page.getByLabel('Find a movie', { exact: true }).fill(browserId);
      await page.getByLabel('CouchDB database URL').fill(url);
      await page.getByLabel('Username', { exact: true }).fill(auth.username);
      await page.getByLabel('Password', { exact: true }).fill(auth.password);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await waitFor(async () => {
        try { return (await remote.get(browserId)).title === 'Temporary browser integration movie'; }
        catch (error) { if (error.status === 404) return false; throw error; }
      });
      // Confirm the reverse direction reaches IndexedDB as well.
      const remoteMovie = await remote.get(browserId);
      await remote.put({ ...remoteMovie, title: 'CouchDB browser round trip' });
      await page.getByRole('heading', { name: 'CouchDB browser round trip (1977)' }).waitFor().catch(async error => {
        console.error('Browser sync diagnostic:', await page.locator('.connection').innerText());
        console.error('Browser activity:', await page.locator('#activity').innerText());
        console.error('Browser errors:', errors);
        console.error('Local test document:', await page.evaluate(async id => {
          try { return await new PouchDB('schema-a-movies').get(id, { conflicts: true }); }
          catch (problem) { return { status: problem.status, message: problem.message }; }
        }, browserId));
        throw error;
      });
      assert.deepEqual(errors, []);
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
      report.push('PASS: actual browser authenticates with CouchDB over CORS and replicates in both directions');
    } finally {
      await browser?.close();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  }
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  const body = `${report.join('\n')}\nDatabase: ${info.db_name}\nTemporary records were deleted after the check; replication tombstones remain.\n`;
  await writeFile(new URL('../test-results/couchdb-check.txt', import.meta.url), body);
  console.log(body);
} finally {
  // Only delete revisions belonging to the unique IDs created by this run.
  for (const id of ids) {
    try {
      const doc = await remote.get(id, { conflicts: true });
      for (const rev of doc._conflicts || []) await remote.remove(id, rev);
      await remote.remove(doc);
    } catch (error) { if (error.status !== 404) console.error(`Cleanup failed for test ID ${id}: ${error.status || 'network error'}`); }
  }
  await Promise.all([local.destroy(), other.destroy(), remote.close()]);
  await rmdir(dir);
}
