export function databaseURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname === '/') {
    throw new Error('Enter an HTTP(S) database URL, such as http://localhost:5984/movies. Put credentials in the separate fields.');
  }
  return url.href.replace(/\/+$/, '');
}

export class SyncController {
  constructor(local, notify) {
    this.local = local;
    this.notify = notify;
    this.remote = null;
    this.replication = null;
    this.offline = false;
  }

  connect(remote) {
    this.stop();
    this.remote = remote;
    this.start();
  }

  stop() {
    const old = this.replication;
    this.replication = null; // Ignore late events from a cancelled replication.
    old?.cancel();
  }

  setOffline(offline) {
    this.offline = offline;
    if (offline) {
      this.stop();
      this.notify('offline', 'Offline: changes are saved locally.');
    } else this.start();
  }

  disconnect() {
    this.stop();
    this.remote = null;
    this.notify('local', 'Local only: connect to CouchDB to start replication.');
  }

  start() {
    this.stop();
    if (this.offline) {
      this.notify('offline', 'Offline: changes are saved locally.');
      return;
    }
    if (!this.remote) {
      this.notify('local', 'Local only: connect to CouchDB to start replication.');
      return;
    }
    this.notify('connecting', 'Connecting to CouchDB…');
    const sync = this.local.sync(this.remote, { live: true, retry: true });
    this.replication = sync;
    const on = (event, callback) => sync.on(event, (...args) => {
      if (this.replication === sync) callback(...args);
    });
    // The combined sync object's paused event does not reliably carry each
    // direction's error. Track push and pull separately to avoid reporting
    // "idle" when one direction is disconnected and backing off.
    const directions = { push: 'connecting', pull: 'connecting' };
    const status = () => {
      if (Object.values(directions).includes('retrying')) {
        this.notify('retrying', 'CouchDB unreachable. Retrying automatically; local CRUD is available.');
      } else if (Object.values(directions).includes('active')) {
        this.notify('syncing', 'Replication active…');
      } else if (Object.values(directions).every(state => state === 'idle')) {
        this.notify('idle', 'Replication idle; watching for changes.');
      }
    };
    for (const direction of ['push', 'pull']) {
      sync[direction].on('active', () => {
        if (this.replication !== sync) return;
        directions[direction] = 'active';
        status();
      }).on('paused', error => {
        if (this.replication !== sync) return;
        directions[direction] = error ? 'retrying' : 'idle';
        status();
      });
    }
    on('change', change => this.notify('change', `${change.direction === 'push' ? 'Sent' : 'Received'} ${change.change.docs.length} document revision(s).`));
    on('denied', () => this.notify('error', 'CouchDB denied a document. Check database permissions or validation rules.'));
    on('error', error => {
      this.replication = null;
      this.notify('error', error.status === 401 || error.status === 403
        ? 'Authentication or permission failed. Check credentials and connect again.'
        : 'Replication stopped. Check the URL, CORS and CouchDB, then connect again.');
    });
  }
}
