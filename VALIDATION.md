# Verified results — 16 October 2026

The application was checked with Node.js 24.18.0, PouchDB 9.0.0, an installed headless Chromium browser through Playwright, and the existing CouchDB 3.5.2 server at `http://localhost:5984/schema_a_movies`.

## Local database tests

`npm test` passed all **9 tests**. These cover offline creation, update, deletion/tombstones, automatic reconnect, keeping either conflict version, stale writes, validation, and error status when only one replication direction is retrying. The tests use real temporary PouchDB databases, cleaned up after each test.

## Browser checks

`npm run test:browser` checks actual browser IndexedDB and service workers in an isolated context. It verifies offline create/update/delete, offline reload and persistence, conflict selection and replication, collection search, automatic retry against an unavailable HTTP endpoint, a 390px mobile layout without horizontal overflow, and no uncaught JavaScript errors.

The generated browser report and screenshot are in `test-results/browser-check.txt` and `test-results/desktop.png`.

## Real CouchDB integration

All of these checks passed against `schema_a_movies` with the provided credentials:

| Scenario | Observed result |
| --- | --- |
| Create while offline | New movie existed locally; CouchDB returned 404 for its ID before reconnect. |
| Update while offline | Local title changed; CouchDB retained the baseline title before reconnect. |
| Delete while offline | Local reads returned 404; CouchDB still held the baseline document. |
| Reconnect | Starting live replication automatically transferred the create, update and deletion to CouchDB. |
| Conflict update | Independent edits replicated through CouchDB, exposing two branches. Choosing a version propagated its contents and removed live `_conflicts` at the server. |
| Authenticated browser sync | A browser-created movie reached CouchDB. Updating it through CouchDB then automatically updated the browser's movie list. |

The integration check used unique `offline-demo-check-…` IDs. Those records were deleted afterward, leaving replication tombstones. Existing movie documents were preserved. The real-server report is in `test-results/couchdb-check.txt`.

## Local configuration

The Fauxton URL supplied in the conversation identifies the `schema_a_movies` database; `/_utils/#database/...` is a management page rather than a replication endpoint. The app now defaults to the correct database URL and username `admin`. No password was written to project files.

CouchDB originally had no configured CORS settings. CORS was enabled for `http://localhost:8000` and `http://127.0.0.1:8000`, with credentials and the methods/headers needed by PouchDB. No remote database was created.

## Evaluation

The checks demonstrate local availability during outages and eventual convergence after reconnect. Conflicting revisions require an explicit application/user decision; successful replication alone does not merge them. The UI presents both versions, and the chosen whole-document version becomes a new revision while the other live branches are tombstoned.

Replication runs while the page is open and connected. Credentials must be re-entered after reload. Offline reload depends on an initial successful service-worker cache, and clearing browser site data removes local unsynchronised edits. These limits and the repeatable five-scenario walkthrough are documented in [DEMONSTRATION.md](DEMONSTRATION.md).
