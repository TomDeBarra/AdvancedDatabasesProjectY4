// PouchDB is injected so the same code runs with IndexedDB in the browser
// and with actual PouchDB databases in the scenario tests.
export function isMovie(doc) {
  return typeof doc?.title === 'string' && Array.isArray(doc.actors)
    && doc.actors.every(actor => typeof actor === 'string')
    && Array.isArray(doc.genres) && doc.genres.every(genre => typeof genre === 'string')
    && Number.isInteger(doc.year);
}

function fields(input) {
  const title = String(input.title ?? '').trim();
  const year = Number(input.year);
  if (!title) throw new Error('Enter a movie title.');
  if (input.year === '' || !Number.isInteger(year) || year < 1888 || year > 2200) {
    throw new Error('Enter a whole year between 1888 and 2200.');
  }
  const list = value => (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map(item => String(item).trim()).filter(Boolean);
  return { title, actors: list(input.actors), genres: list(input.genres), year };
}

function withoutConflicts(doc) {
  const { _conflicts, ...rest } = doc;
  return rest;
}

function changed() {
  const error = new Error('This movie changed since you opened it. Reopen it and review the latest version. Your form has been kept.');
  error.status = 409;
  return error;
}

export class MovieStore {
  constructor(db) { this.db = db; }

  async list() {
    const result = await this.db.allDocs({ include_docs: true, conflicts: true });
    return result.rows.map(row => row.doc).filter(isMovie)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  get(id) { return this.db.get(id, { conflicts: true }); }

  create(input, id = globalThis.crypto.randomUUID()) {
    if (!id.trim() || id.startsWith('_')) throw new Error('Use a nonempty ID that does not start with an underscore.');
    return this.db.put({ _id: id.trim(), ...fields(input) });
  }

  async update(snapshot, input) {
    const latest = await this.get(snapshot._id);
    if (latest._rev !== snapshot._rev) throw changed();
    if (latest._conflicts?.length) throw new Error('Resolve this movie’s conflicting revisions before editing it.');
    // Use the revision the user actually edited; never silently overwrite a stale edit.
    return this.db.put({ ...withoutConflicts(snapshot), ...fields(input) });
  }

  async remove(snapshot) {
    const latest = await this.get(snapshot._id);
    if (latest._rev !== snapshot._rev) throw changed();
    if (latest._conflicts?.length) throw new Error('Resolve this movie’s conflicting revisions before deleting it.');
    return this.db.remove(snapshot); // A replicating _deleted tombstone, not a purge.
  }

  async versions(id) {
    const winner = await this.get(id);
    const losing = await Promise.all((winner._conflicts || []).map(rev => this.db.get(id, { rev })));
    return [winner, ...losing];
  }

  async resolve(snapshot, selectedRev) {
    const latest = await this.get(snapshot._id);
    const revisions = doc => [doc._rev, ...(doc._conflicts || [])].sort().join('|');
    if (revisions(latest) !== revisions(snapshot)) throw changed();
    if (![latest._rev, ...(latest._conflicts || [])].includes(selectedRev)) throw changed();
    const selected = await this.db.get(latest._id, { rev: selectedRev });
    // Extend the winner with the chosen contents, then tombstone the other live branches.
    const saved = await this.db.put({ ...withoutConflicts(selected), _rev: latest._rev });
    const results = await this.db.bulkDocs((latest._conflicts || []).map(_rev => ({
      _id: latest._id, _rev, _deleted: true
    })));
    if (results.some(result => result.error)) {
      throw new Error('The chosen version was saved, but a competing revision changed. Reopen conflicts and review again.');
    }
    return saved;
  }
}
