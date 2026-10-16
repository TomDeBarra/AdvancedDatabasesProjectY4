import { MovieStore } from '/movies.js';
import { SyncController, databaseURL } from '/sync.js';

const $ = id => document.getElementById(id);
const db = new PouchDB('schema-a-movies');
const movies = new MovieStore(db);
let editing = null;
let renderNumber = 0;
let previousState = '';
let refreshTimer;
let visibleCount = 50;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function log(message) {
  const item = element('li');
  const time = element('time', new Date().toLocaleTimeString());
  time.dateTime = new Date().toISOString();
  item.append(time, document.createTextNode(message));
  $('activity').prepend(item);
  while ($('activity').children.length > 60) $('activity').lastElementChild.remove();
}

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').dataset.error = String(error);
  $('notice').hidden = false;
}

async function run(button, action) {
  if (button) button.disabled = true;
  try { await action(); }
  catch (error) {
    const message = error.status === 409
      ? 'Conflict: that ID already exists, or the movie changed since you opened it. Reopen the latest movie before retrying. Your form has been kept.'
      : error.message || 'Operation failed. Check the activity log.';
    notice(message, true);
    log(message);
  } finally { if (button) button.disabled = false; }
}

const sync = new SyncController(db, (state, message) => {
  if (state === 'change') {
    log(message);
    return;
  }
  $('sync-state').textContent = {
    local: 'Local only', offline: 'Offline', connecting: 'Connecting',
    syncing: 'Syncing', idle: 'Watching for changes', retrying: 'Retrying', error: 'Check connection'
  }[state];
  $('sync-state').dataset.state = state;
  $('sync-detail').textContent = message;
  if (previousState !== state) log(message);
  previousState = state;
});

function button(label, action, className = 'secondary') {
  const node = element('button', label, className);
  node.type = 'button';
  node.addEventListener('click', () => run(node, action));
  return node;
}

function resetForm() {
  editing = null;
  $('movie-form').reset();
  $('movie-id').disabled = false;
  $('cancel-edit').hidden = true;
  $('form-heading').textContent = 'Add a movie';
}

async function editMovie(id) {
  const doc = await movies.get(id);
  if (doc._conflicts?.length) return showConflicts(id);
  editing = doc;
  $('movie-id').value = doc._id;
  $('movie-id').disabled = true;
  $('title').value = doc.title;
  $('year').value = doc.year;
  $('actors').value = doc.actors.join(', ');
  $('genres').value = doc.genres.join(', ');
  $('form-heading').textContent = 'Edit a movie';
  $('cancel-edit').hidden = false;
  $('title').focus();
}

async function render() {
  const current = ++renderNumber;
  const docs = await movies.list();
  if (current !== renderNumber) return;
  $('movies').replaceChildren();
  $('movie-count').textContent = `${docs.length} movie${docs.length === 1 ? '' : 's'}`;
  const query = $('search').value.trim().toLocaleLowerCase();
  const matching = docs.filter(doc => !query || doc.title.toLocaleLowerCase().includes(query)
    || doc._id.toLocaleLowerCase().includes(query));
  $('show-more').hidden = matching.length <= visibleCount;
  if (!matching.length) $('movies').append(element('p', docs.length ? 'No matching movies.' : 'No movies yet. Add your first movie.'));
  for (const doc of matching.slice(0, visibleCount)) {
    const article = element('article', undefined, 'movie');
    article.append(element('h3', `${doc.title} (${doc.year})`));
    article.append(element('p', `Actors: ${doc.actors.join(', ') || '—'}`));
    article.append(element('p', `Genres: ${doc.genres.join(', ') || '—'}`));
    article.append(element('code', `ID: ${doc._id} · Rev: ${doc._rev}`));
    const actions = element('div', undefined, 'actions');
    if (doc._conflicts?.length) {
      article.append(element('p', `${doc._conflicts.length} conflicting revision(s)`, 'conflict-tag'));
      actions.append(button('Resolve conflict', () => showConflicts(doc._id)));
    } else {
      actions.append(button('Edit', () => editMovie(doc._id)));
      actions.append(button('Delete', async () => {
        if (!window.confirm(`Delete “${doc.title}”? The deletion will synchronise to CouchDB.`)) return;
        const result = await movies.remove(doc);
        if (editing?._id === doc._id) resetForm();
        log(`Deleted locally: ${doc._id} · tombstone ${result.rev}`);
        notice('Deleted locally. Replication will send the deletion when connected.');
        await render();
      }, 'danger'));
    }
    article.append(actions);
    const details = element('details');
    details.append(element('summary', 'Document JSON'), element('pre', JSON.stringify(doc, null, 2)));
    article.append(details);
    $('movies').append(article);
  }
}

async function showConflicts(id) {
  const versions = await movies.versions(id);
  $('conflict-versions').replaceChildren();
  if (versions.length < 2) {
    $('conflict-panel').hidden = true;
    notice('This movie no longer has competing live revisions.');
    await render();
    return;
  }
  for (let index = 0; index < versions.length; index++) {
    const version = versions[index];
    const card = element('div', undefined, 'version');
    card.append(element('h3', index === 0 ? 'Current winner' : `Competing version ${index}`));
    const { _conflicts, ...display } = version;
    card.append(element('pre', JSON.stringify(display, null, 2)));
    card.append(button('Keep this version', async () => {
      const result = await movies.resolve(versions[0], version._rev);
      $('conflict-panel').hidden = true;
      if (editing?._id === id) resetForm();
      log(`Conflict resolved locally: ${id} · ${result.rev}`);
      notice('Conflict resolved locally. The chosen contents and branch deletions will synchronise automatically.');
      await render();
    }));
    $('conflict-versions').append(card);
  }
  $('conflict-panel').hidden = false;
  $('conflict-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('movie-form').addEventListener('submit', event => {
  event.preventDefault();
  run($('save-movie'), async () => {
    const input = {
      title: $('title').value, year: $('year').value,
      actors: $('actors').value, genres: $('genres').value
    };
    const updating = Boolean(editing);
    const result = updating ? await movies.update(editing, input)
      : await movies.create(input, $('movie-id').value.trim() || undefined);
    log(`${updating ? 'Updated' : 'Created'} locally: ${result.id} · ${result.rev}`);
    notice('Saved locally. Replication sends changes automatically when connected.');
    resetForm();
    await render();
  });
});

$('cancel-edit').addEventListener('click', resetForm);
$('search').addEventListener('input', () => { visibleCount = 50; run(null, render); });
$('show-more').addEventListener('click', () => { visibleCount += 50; run(null, render); });
$('close-conflicts').addEventListener('click', () => { $('conflict-panel').hidden = true; });
$('clear-log').addEventListener('click', () => $('activity').replaceChildren());

$('connection-form').addEventListener('submit', event => {
  event.preventDefault();
  run(event.submitter, async () => {
    const url = databaseURL($('remote-url').value);
    const username = $('username').value;
    // Remember the endpoint only; never save passwords in localStorage or documents.
    try { localStorage.setItem('movies-remote-url', url); } catch { /* Storage may be restricted. */ }
    const remote = new PouchDB(url, {
      skip_setup: true,
      ...(username ? { auth: { username, password: $('password').value } } : {})
    });
    sync.connect(remote);
  });
});

$('disconnect').addEventListener('click', () => sync.disconnect());
function updateNetwork() { sync.setOffline($('offline').checked || !navigator.onLine); }
$('offline').addEventListener('change', updateNetwork);
window.addEventListener('online', updateNetwork);
window.addEventListener('offline', updateNetwork);

try { $('remote-url').value = localStorage.getItem('movies-remote-url') || $('remote-url').value; }
catch { /* Defaults still work when localStorage is unavailable. */ }

async function cachePage() {
  if (!('serviceWorker' in navigator)) {
    $('offline-ready').textContent = 'Page caching needs localhost or HTTPS and a browser with service workers.';
    return;
  }
  try {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    $('offline-ready').textContent = 'Page cached · ready to reopen offline';
    log('App files cached for offline reload.');
  } catch {
    $('offline-ready').textContent = 'Page caching failed. Local CRUD still works while this page stays open.';
  }
}

async function init() {
  await db.info();
  db.changes({ since: 'now', live: true }).on('change', () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => run(null, render), 100);
  })
    .on('error', () => notice('The local change feed stopped. Reload to reopen it.', true));
  updateNetwork();
  await render();
  log('Local database ready: schema-a-movies (IndexedDB).');
  await cachePage();
}

init().catch(error => notice(`Cannot open the local database: ${error.message}`, true));
