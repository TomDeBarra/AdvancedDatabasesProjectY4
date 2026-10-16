# Demonstration and evaluation

Use `npm start`, open http://localhost:8000 and connect to your CouchDB `schema_a_movies` database as described in README.md. Keep Fauxton open alongside the app so you can compare the server documents with the local JSON. Refresh Fauxton when checking results.

Use new demonstration IDs to avoid changing existing coursework records. For the sample movie, enter Star Wars, 1977, the four actors in the assignment, and Animation, History, Sport. The unusual genres are retained to match the supplied example.

Your database already has thousands of movies. Use **Find a movie** to search for each demonstration ID. The list initially renders 50 matches; **Show 50 more** displays additional results.

The **Simulate offline** checkbox cancels replication while leaving local CRUD available. A brief in-flight request may have reached CouchDB before cancellation; wait for Offline status before making demonstration edits. This checkbox demonstrates disconnection from the replica. Disabling Wi-Fi or using browser DevTools' network Offline mode additionally demonstrates an actual network outage. If CouchDB runs on your own machine, disabling Wi-Fi alone may leave localhost reachable.

## 1. Create while offline

1. Wait for the page cache ready message, then select **Simulate offline**.
2. Add the sample movie with ID `demo-created`. Click **Save locally**.
3. Expand **Document JSON**. Record the movie's ID and generated `1-…` revision.
4. Reload the page while actually offline if desired. Confirm the movie is still present. A checkbox is reset by reload, so actual browser Offline mode is needed for this reload test.
5. Check Fauxton. `demo-created` should not exist on the server before reconnection.

**Evaluation:** creation needs only local IndexedDB, so it succeeds without a server and survives reload. The remote database remains unchanged until replication resumes. The page itself requires an initial successful cache installation to reload offline.

## 2. Update while offline

1. While online, create ID `demo-updated` with title `Star Wars` and connect replication. Wait until Fauxton shows the document.
2. Select **Simulate offline**. Click **Edit**, change the title to `Star Wars — offline edit`, and save.
3. Record the new local title and revision from Document JSON. Fauxton should still show the original title and its previous revision.

**Evaluation:** an update extends the local revision tree and is immediately visible in the UI. The databases temporarily disagree. The app submits the revision opened by the user, so a newer concurrent local revision causes a `409` conflict message and preserves the form for review.

## 3. Delete while offline

1. While online, create ID `demo-deleted` and wait until it exists in Fauxton.
2. Select **Simulate offline**, click **Delete**, and confirm.
3. Confirm the movie disappears locally. The activity log records the deletion and tombstone revision. Fauxton should still show the live server document.

**Evaluation:** deletion creates a `_deleted: true` revision; ordinary reads exclude it. Keeping a tombstone allows replication to inform the server of the deletion. Purging would remove that evidence and is deliberately not used. Creating and deleting an entirely new document offline may leave only its tombstone to replicate, so an already synchronised baseline makes the demonstration clearer.

## 4. Synchronising after reconnecting

1. Prepare the create, update and delete above while replication is stopped. Keep the page open.
2. Optionally add a separate Schema A movie in Fauxton to demonstrate the pull direction.
3. Restore the browser's network connection, then clear **Simulate offline** if selected. If you reloaded, re-enter credentials and click Connect first.
4. Observe Connecting/Syncing/Watching for changes and the activity entries for sent and received document revisions.
5. Confirm in Fauxton that `demo-created` exists, `demo-updated` has the edited title, and `demo-deleted` is deleted. Confirm the Fauxton-created movie appears locally.

**Evaluation:** bidirectional replication transfers the offline revisions and server changes. An ordinary outage is retried automatically while the page remains open. Checkpoints allow subsequent replication to resume from previous progress. The status "Watching for changes" describes idle replication; verify the documents themselves as evidence of convergence. Authentication/permission failures need corrected credentials or server configuration, and rejected documents are reported rather than treated as successful saves to CouchDB.

## 5. Conflict update

Use **two isolated browser profiles**, such as a regular window (A) and an InPrivate/Incognito window (B), both at http://localhost:8000. Two normal tabs share IndexedDB and do not simulate independent replicas.

1. Connect both clients to the same CouchDB `schema_a_movies` database.
2. In A, create ID `demo-conflict` with title `Star Wars`. Wait until B and Fauxton show this same movie and revision. This establishes a common ancestor.
3. In A, select **Simulate offline**. Edit that movie's title to `Star Wars — client A` and save.
4. In B, while still connected, edit the same movie to `Star Wars — client B` and save. Wait until Fauxton shows B's edit.
5. In A, clear the offline toggle. After replication, both clients should show a conflict indicator. Open **Resolve conflict**.
6. Record the JSON for the current winner and competing version. Both have the same document ID, but distinct revision IDs and titles.
7. Click **Keep this version** on the preferred version. After replication, confirm both browsers show the selected title with no conflict indicator.
8. In Fauxton, inspect the document's revision/conflict information. If using its JSON/API view, request `GET /schema_a_movies/demo-conflict?conflicts=true`: after resolution the response should have no `_conflicts` field. Do not mistake deleted historical branches for unresolved live conflicts.

**Evaluation:** each isolated client can legally save an edit based on the common ancestor while disconnected. Replication preserves both branches and deterministically chooses a visible winner; this is not a timestamp-based "latest edit wins" policy. Automatic replication does not decide which title the user intended. Manual resolution makes that decision explicit, saves the chosen body over the winner, and marks the other live branches deleted. The resolution itself replicates, allowing both clients to converge. This app chooses a whole version rather than merging individual fields. Simultaneous edits during resolution can introduce further conflicts and require another review.

The official [PouchDB conflict guide](https://pouchdb.com/guides/conflicts.html) explains immediate `409` errors and competing replicated revisions. These are distinct cases: the procedure above demonstrates the latter.

## Evidence and test coverage

| Required scenario | Evidence to capture with your CouchDB | Automated check |
| --- | --- | --- |
| Create offline | Offline badge, local JSON, absent remote ID | Local creation; browser creation during actual network Offline mode |
| Update offline | Changed local title/revision; unchanged remote | Local/peer revision comparison; browser form update offline |
| Delete offline | Local removal and log; remote still present | Tombstone assertion and peer deletion after replication; offline browser delete |
| Reconnect | Sent/received events and matching local/server contents | Live controller resumes and transfers create/update/delete plus a peer addition |
| Conflict update | Two branch bodies, selected body, no remaining live conflict | Real competing branches; both resolution choices; browser conflict UI |

Run `npm test` and `npm run test:browser` for repeatable client checks. Their automated peers are PouchDB databases. The browser check also verifies offline reload, retry status against an unavailable server, responsive layout and uncaught browser errors. Its report is written to `test-results/browser-check.txt`. The separate `npm run test:couchdb` check exercises the five scenarios against real CouchDB with temporary records. [VALIDATION.md](VALIDATION.md) records the verified results and configuration changes.

## Overall assessment

The application meets the offline-first pattern: reads and writes use the local database, and replication provides eventual consistency with CouchDB. CRUD remains usable when the server is down. The tradeoff is temporary divergence between replicas, plus the need to detect and resolve conflicting edits. Browser storage can be cleared or evicted, and unsynchronised edits have no server copy. Credentials must be re-entered after a page reload; replication is active only while the page is open and connected. These limits are acceptable for a small demonstration, but should be stated in the project evaluation.
