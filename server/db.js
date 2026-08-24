/* SQLite storage for signed-in users: their trip documents and their photo
   blobs. Uses node:sqlite, which ships with Node — the server keeps the same
   zero-dependency rule as the app itself. */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hash = s => createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

export function openDB(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      provider     TEXT NOT NULL,
      provider_id  TEXT NOT NULL,
      email        TEXT,
      name         TEXT,
      avatar       TEXT,
      created_at   INTEGER NOT NULL,
      seen_at      INTEGER NOT NULL,
      UNIQUE (provider, provider_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

    -- one row per trip per user; the app edits one at a time but a second
    -- device that started its own trip must not silently overwrite the first
    CREATE TABLE IF NOT EXISTS trips (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      trip_id    TEXT NOT NULL,
      doc        TEXT NOT NULL,
      rev        INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, trip_id)
    );

    CREATE TABLE IF NOT EXISTS blobs (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id         TEXT NOT NULL,
      type       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      bytes      BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
  `);
  return wrap(db);
}

function wrap(db) {
  const q = sql => db.prepare(sql);

  const insertUser = q(`INSERT INTO users (id, provider, provider_id, email, name, avatar, created_at, seen_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const findUser = q('SELECT * FROM users WHERE provider = ? AND provider_id = ?');
  const touchUser = q('UPDATE users SET email = ?, name = ?, avatar = ?, seen_at = ? WHERE id = ?');

  const addSession = q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
  const getSession = q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                        WHERE s.token_hash = ? AND s.expires_at > ?`);
  const dropSession = q('DELETE FROM sessions WHERE token_hash = ?');
  const sweepSessions = q('DELETE FROM sessions WHERE expires_at <= ?');

  const getTrip = q('SELECT * FROM trips WHERE user_id = ? AND trip_id = ?');
  const newestTrip = q('SELECT * FROM trips WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1');
  const listTrips = q(`SELECT trip_id, rev, updated_at, json_extract(doc, '$.title') AS title,
                              json_extract(doc, '$.startDate') AS start_date,
                              json_extract(doc, '$.endDate') AS end_date
                       FROM trips WHERE user_id = ? ORDER BY updated_at DESC`);
  const upsertTrip = q(`INSERT INTO trips (user_id, trip_id, doc, rev, updated_at) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT (user_id, trip_id) DO UPDATE SET doc = excluded.doc,
                        rev = excluded.rev, updated_at = excluded.updated_at`);
  const deleteTrip = q('DELETE FROM trips WHERE user_id = ? AND trip_id = ?');

  const putBlob = q(`INSERT INTO blobs (user_id, id, type, size, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT (user_id, id) DO NOTHING`);
  const getBlob = q('SELECT type, bytes FROM blobs WHERE user_id = ? AND id = ?');
  const hasBlob = q('SELECT 1 FROM blobs WHERE user_id = ? AND id = ?');
  const usage = q('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM blobs WHERE user_id = ?');
  const blobIds = q('SELECT id FROM blobs WHERE user_id = ?');
  const dropBlob = q('DELETE FROM blobs WHERE user_id = ? AND id = ?');

  return {
    raw: db,

    upsertUser({ provider, providerId, email, name, avatar }) {
      const found = findUser.get(provider, providerId);
      if (found) {
        touchUser.run(email ?? found.email, name ?? found.name, avatar ?? found.avatar, now(), found.id);
        return { ...found, email: email ?? found.email, name: name ?? found.name, avatar: avatar ?? found.avatar };
      }
      const id = token(16);
      insertUser.run(id, provider, providerId, email || null, name || null, avatar || null, now(), now());
      return findUser.get(provider, providerId);
    },

    startSession(userId, ttlMs) {
      const t = token();
      addSession.run(hash(t), userId, now(), now() + ttlMs);
      sweepSessions.run(now());
      return t;
    },
    userForToken: t => (t ? getSession.get(hash(t), now()) || null : null),
    endSession: t => { if (t) dropSession.run(hash(t)); },

    getTrip: (userId, tripId) => getTrip.get(userId, tripId) || null,
    newestTrip: userId => newestTrip.get(userId) || null,
    listTrips: userId => listTrips.all(userId),
    saveTrip(userId, tripId, doc, rev) {
      const at = now();
      upsertTrip.run(userId, tripId, doc, rev, at);
      return { rev, updatedAt: at };
    },
    deleteTrip: (userId, tripId) => deleteTrip.run(userId, tripId),

    putBlob: (userId, id, type, bytes) =>
      putBlob.run(userId, id, type, bytes.length, bytes, now()),
    getBlob: (userId, id) => getBlob.get(userId, id) || null,
    hasBlob: (userId, id) => !!hasBlob.get(userId, id),
    usage: userId => usage.get(userId),
    blobIds: userId => blobIds.all(userId).map(r => r.id),
    dropBlob: (userId, id) => dropBlob.run(userId, id),

    /* Blobs are uploaded before the document that references them, and a photo
       can be deleted on one device while another still points at it. So the
       sweep runs on save: anything no longer named by any of this user's trips
       goes. */
    sweepBlobs(userId) {
      const keep = new Set();
      for (const row of db.prepare('SELECT doc FROM trips WHERE user_id = ?').all(userId)) {
        try { collectIds(JSON.parse(row.doc), keep); } catch { /* skip unreadable */ }
      }
      let freed = 0;
      for (const id of this.blobIds(userId)) if (!keep.has(id)) { this.dropBlob(userId, id); freed++; }
      return freed;
    },
  };
}

/* Every blob id a trip document points at: photos and per-item attachments. */
export function collectIds(trip, into = new Set()) {
  for (const list of Object.values(trip?.photos || {})) for (const p of list || []) into.add(p.id);
  for (const o of [...Object.values(trip?.items || {}), ...Object.values(trip?.stays || {})])
    for (const f of o?.files || []) into.add(f.id);
  return into;
}
