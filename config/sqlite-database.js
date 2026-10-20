const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = path.resolve(process.env.WEBHOOK_DB_PATH || 'webhooks.sqlite');
const database = new DatabaseSync(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    endpoint_url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
    endpoint_url TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    first_attempt_at INTEGER,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    idempotency_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    delivered_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS events_due_idx
    ON events(status, next_attempt_at);

  CREATE TABLE IF NOT EXISTS delivery_attempts (
    id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    attempt_number INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    http_status INTEGER,
    error TEXT,
    retry_after_ms INTEGER,
    UNIQUE(event_id, attempt_number)
  );
`);

const eventColumns = new Set(database.prepare('PRAGMA table_info(events)').all().map((column) => column.name));
if (!eventColumns.has('first_attempt_at')) {
  database.exec('ALTER TABLE events ADD COLUMN first_attempt_at INTEGER');
}
if (!eventColumns.has('idempotency_key')) {
  database.exec('ALTER TABLE events ADD COLUMN idempotency_key TEXT');
}

database.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency_idx
    ON events(subscription_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
`);

database.prepare(`
  UPDATE delivery_attempts
  SET completed_at = ?, error = COALESCE(error, 'Process restarted before attempt completed')
  WHERE completed_at IS NULL
`).run(Date.now());

database.prepare(`
  UPDATE events SET status = 'pending', updated_at = ?
  WHERE status = 'delivering'
`).run(Date.now());

module.exports = { database, databasePath };
