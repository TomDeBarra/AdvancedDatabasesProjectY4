import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import PouchDB from 'pouchdb';
import { MovieStore } from '../public/movies.js';
import { SyncController, databaseURL } from '../public/sync.js';
import { EventEmitter } from 'node:events';

const starWars = {
  title: 'Star Wars', actors: ['Carrie Fisher', 'Harrison Ford', 'Mark Hamill', 'Peter Cushing'],
  genres: ['Animation', 'History', 'Sport'], year: 1977
};

async function pair(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'offline-movies-test-'));
  const local = new PouchDB(path.join(dir, 'local'));
  const peer = new PouchDB(path.join(dir, 'peer'));
  t.after(async () => {
    await Promise.all([local.destroy(), peer.destroy()]);
    await rmdir(dir);
  });
  return { local, peer, store: new MovieStore(local) };
}

async function waitFor(condition) {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for replication');
}

test('create while offline persists locally, with no document at the peer', async t => {
  const { local, peer, store } = await pair(t);
  await store.create(starWars, '1');
  assert.equal((await local.get('1')).title, 'Star Wars');
  await assert.rejects(peer.get('1'), { status: 404 });
  assert.equal((await store.list()).length, 1);
});

test('update while offline changes the local revision; reconnect transfers it', async t => {
  const { local, peer, store } = await pair(t);
  await store.create(starWars, '1');
  await local.sync(peer);
  const original = await store.get('1');
  await store.update(original, { ...starWars, title: 'Star Wars — offline edit' });
  assert.notEqual((await local.get('1'))._rev, original._rev);
  assert.equal((await peer.get('1')).title, 'Star Wars');
  await local.sync(peer);
  assert.equal((await peer.get('1')).title, 'Star Wars — offline edit');
});

test('delete while offline creates a tombstone which propagates on reconnect', async t => {
  const { local, peer, store } = await pair(t);
  await store.create(starWars, '1');
  await local.sync(peer);
  await store.remove(await store.get('1'));
  assert.equal((await store.list()).length, 0);
  assert.equal((await peer.get('1')).title, 'Star Wars');
  const changes = await local.changes({ since: 0 });
  assert.equal(changes.results.find(change => change.id === '1').deleted, true);
  await local.sync(peer);
  await assert.rejects(peer.get('1'), { status: 404 });
  assert.equal((await peer.changes({ since: 0 })).results[0].deleted, true);
});

test('reconnect automatically transfers offline create/update/delete and remote changes', async t => {
  const { local, peer, store } = await pair(t);
  await store.create(starWars, 'update');
  await store.create(starWars, 'delete');
  await local.sync(peer);
  const states = [];
  const sync = new SyncController(local, state => states.push(state));
  t.after(() => sync.disconnect());
  sync.setOffline(true);
  sync.connect(peer);
  await store.create(starWars, 'create');
  await store.update(await store.get('update'), { ...starWars, title: 'Offline update' });
  await store.remove(await store.get('delete'));
  await peer.put({ _id: 'remote', ...starWars, title: 'Remote addition' });
  await assert.rejects(peer.get('create'), { status: 404 });
  sync.setOffline(false); // No manual replicate call: same path as the UI reconnect.
  await waitFor(async () => {
    const remote = await peer.allDocs({ include_docs: true });
    const docs = remote.rows.map(row => row.doc);
    return docs.some(doc => doc._id === 'create')
      && docs.some(doc => doc.title === 'Offline update')
      && !docs.some(doc => doc._id === 'delete')
      && (await store.list()).some(doc => doc._id === 'remote');
  });
  assert.ok(states.includes('change'));
});

for (const choice of ['winner', 'competing']) {
  test(`conflict update preserves both versions; keeping ${choice} converges to one live branch`, async t => {
    const { local, peer, store } = await pair(t);
    await store.create(starWars, '1');
    await local.sync(peer);
    await store.update(await store.get('1'), { ...starWars, title: 'Local edit' });
    const other = await peer.get('1');
    await peer.put({ ...other, title: 'Remote edit' });
    await local.sync(peer);
    const versions = await store.versions('1');
    assert.equal(versions.length, 2);
    assert.deepEqual(versions.map(doc => doc.title).sort(), ['Local edit', 'Remote edit']);
    await assert.rejects(store.remove(versions[0]), /Resolve/);
    const selected = versions[choice === 'winner' ? 0 : 1];
    await store.resolve(versions[0], selected._rev);
    await local.sync(peer);
    for (const db of [local, peer]) {
      const doc = await db.get('1', { conflicts: true });
      assert.equal(doc.title, selected.title);
      assert.equal(doc._conflicts, undefined);
      const leaves = await db.get('1', { open_revs: 'all' });
      assert.equal(leaves.filter(leaf => leaf.ok && !leaf.ok._deleted).length, 1);
    }
  });
}

test('stale form updates are rejected without overwriting a newer save', async t => {
  const { store } = await pair(t);
  await store.create(starWars, '1');
  const stale = await store.get('1');
  await store.update(stale, { ...starWars, title: 'Newer save' });
  await assert.rejects(store.update(stale, { ...starWars, title: 'Stale save' }), { status: 409 });
  assert.equal((await store.get('1')).title, 'Newer save');
  await assert.rejects(store.create(starWars, '1'), { status: 409 });
});

test('validation rejects invalid movies and unsafe remote URL formats', async t => {
  const { store } = await pair(t);
  assert.throws(() => store.create({ ...starWars, title: '' }, '1'), /title/);
  assert.throws(() => store.create({ ...starWars, year: '1977.5' }, '1'), /year/);
  assert.throws(() => databaseURL('http://admin:secret@localhost:5984/movies'), /credentials/);
  assert.throws(() => databaseURL('http://localhost:5984/'), /database URL/);
  assert.equal(databaseURL('http://localhost:5984/movies/'), 'http://localhost:5984/movies');
});

test('a retrying direction cannot be masked by an idle direction; cancelled events are ignored', () => {
  const states = [];
  const replication = new EventEmitter();
  replication.push = new EventEmitter();
  replication.pull = new EventEmitter();
  replication.cancel = () => {};
  const controller = new SyncController({ sync: () => replication }, state => states.push(state));
  controller.connect({});
  replication.push.emit('paused', new Error('Connection refused'));
  replication.pull.emit('paused');
  assert.equal(states.at(-1), 'retrying');
  replication.push.emit('active');
  assert.equal(states.at(-1), 'syncing');
  replication.push.emit('paused');
  assert.equal(states.at(-1), 'idle');
  controller.setOffline(true);
  replication.pull.emit('active');
  assert.equal(states.at(-1), 'offline');
});
