# Offline Movies

A small college demonstration using plain JavaScript, PouchDB 9 and CouchDB replication. There is no frontend framework, build step, API backend or CDN dependency. Node serves the application files; all movie CRUD happens in the browser's local PouchDB database (IndexedDB).

## Run

Install Node.js 20 or later, then run these commands in this folder:

```powershell
npm ci
npm start
```

Open **http://localhost:8000**. You can create, read, edit and delete movies immediately, without CouchDB. Keep using the same origin and browser profile to access the same local data.

Use **Find a movie** to filter by title or ID. The list displays 50 matches at a time, with **Show 50 more** for larger collections.

Wait for **Page cached · ready to reopen offline** before testing offline reload. The service worker caches the application and the installed PouchDB browser bundle. The first installation and first page load require access to their servers; later local movie operations and page reloads can work offline. Use localhost or HTTPS, rather than opening `index.html` as a file.

If port 8000 is occupied, set `PORT` before starting, and allow that origin in CouchDB's CORS settings too.

## Connect your CouchDB movies database

1. Start your existing CouchDB server and make sure its `schema_a_movies` database exists. The application does not create remote databases or change server settings.
2. In Fauxton (usually `http://localhost:5984/_utils/`), enable CORS for **http://localhost:8000** and enable credentials. For CouchDB 3.2+, the equivalent `local.ini` configuration is below. Restart CouchDB if you change the file directly.
3. The app defaults to `http://localhost:5984/schema_a_movies` and username `admin`. Enter your password and click Connect. No password is saved in the project. The user must have read/write access to the database.
4. Replication runs in both directions with `{ live: true, retry: true }`. Changes from CouchDB appear locally, and local changes are sent automatically.

```ini
[chttpd]
enable_cors = true

[cors]
origins = http://localhost:8000
credentials = true
methods = GET, PUT, POST, HEAD, DELETE, OPTIONS
headers = accept, authorization, content-type, origin, referer
```

These settings follow the [CouchDB CORS documentation](https://docs.couchdb.org/en/stable/config/http.html#cross-origin-resource-sharing). Earlier CouchDB versions use `[httpd]` for `enable_cors`. If you open the app at `http://127.0.0.1:8000`, allow that exact origin as well. An HTTPS app needs an HTTPS remote database.

The endpoint is remembered, but credentials are kept only in memory. **After a page reload, re-enter credentials and click Connect.** After that initial connection, network reconnects and disabling the offline toggle resume replication automatically while the page is open. Closing the page stops replication until it is reopened and connected. Disconnect stops replication without clearing local data.

Use a dedicated demonstration database or copies of your project data. Replication copies the full database, and edits/deletions propagate to the remote database. The UI displays Schema A movies only; other document shapes still replicate. A single local collection is used, so changing the remote endpoint will sync that collection with the new endpoint.

## Schema A

Movie bodies contain these fields:

```json
{
  "_id": "1",
  "title": "Star Wars",
  "actors": ["Carrie Fisher", "Harrison Ford", "Mark Hamill", "Peter Cushing"],
  "genres": ["Animation", "History", "Sport"],
  "year": 1977
}
```

PouchDB generates `_rev`; never type or hard-code the example revision from the assignment. Actors and genres are stored as arrays, and the year as an integer. IDs can be supplied for the demonstration or generated automatically with `crypto.randomUUID()`. Editing preserves an existing document's additional fields. **Document JSON** shows the stored fields and current revision.

## How it works

- Create uses `db.put()`. Read uses `db.allDocs({ include_docs: true, conflicts: true })` and `db.get()`.
- Updates use the revision originally opened in the form. Stale writes return a conflict instead of silently overwriting another change.
- Delete uses `db.remove()` to create a `_deleted` tombstone, which can replicate. It does not purge history.
- `db.changes({ live: true, since: 'now' })` refreshes the UI after local or replicated changes.
- Live bidirectional replication uses PouchDB's revision trees and checkpoints, including network retries. The browser's online/offline events restart or pause it; the offline toggle does the same without changing your device connection.
- Conflicting live revisions appear in `_conflicts`. The UI fetches each branch, displays the contents, and lets you choose a complete version. It writes those contents over the current winner and tombstones the losing branches. It checks for changed revisions and examines each `bulkDocs` result. Concurrent edits may require reopening the conflict view.

The underlying behavior is described in the official [PouchDB replication guide](https://pouchdb.com/guides/replication.html) and [conflict guide](https://pouchdb.com/guides/conflicts.html).

## Demonstrate and evaluate

See **[DEMONSTRATION.md](DEMONSTRATION.md)** for all five required scenarios, expected observations, evidence to collect, and evaluation. The conflict scenario uses two isolated browser profiles editing the same baseline movie.

Run the repeatable checks with:

```powershell
npm test
npm run test:browser
```

The nine database tests use actual temporary PouchDB databases and real replication. The browser check uses an isolated browser context, actual IndexedDB and service workers, and an unavailable HTTP endpoint to test retry status. It uses installed Edge/Chrome or Playwright Chromium. If none is available, install a test browser with `npx playwright install chromium`.

The browser check saves a report and screenshot in the ignored `test-results/` folder. Neither of those two test commands modifies your actual CouchDB database. A separate `npm run test:couchdb` integration check uses uniquely named temporary records in the real database, deletes them afterward, and leaves replication tombstones. It reads credentials from a JSON line on hidden standard input, never from source files or command arguments. See [VALIDATION.md](VALIDATION.md) for the checks performed with your database.

To rerun that integration check, enter one JSON object when prompted, with `url`, `username` and `password`. Set `browser` to `true` to also check authenticated browser replication (requires port 8000 to be free). The optional `configureCors: true` enables CORS for the two local origins above; the check otherwise leaves server configuration unchanged.

## Files

| File | Purpose |
| --- | --- |
| `public/index.html`, `public/styles.css` | Rudimentary responsive UI |
| `public/app.js` | Form handling, list, activity and conflict view |
| `public/movies.js` | Local CRUD and conflict resolution |
| `public/sync.js` | Replication lifecycle and status |
| `public/sw.js` | Offline application-file cache |
| `server.js` | Static server on localhost |
| `test/scenarios.test.js` | Offline/replication scenario checks |
| `scripts/browser-check.js` | Browser behavior checks |
| `scripts/couchdb-check.js` | Optional real CouchDB and authenticated browser checks |

Browser storage belongs to the browser profile and origin. Clearing site data removes the local database; private browsing may remove it when the session closes. This is a demonstration with eventual consistency and manual conflict resolution, rather than a production authentication or backup system.
