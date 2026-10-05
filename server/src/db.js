import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    species TEXT NOT NULL DEFAULT 'Unknown',
    location TEXT NOT NULL DEFAULT '',
    auto_water INTEGER NOT NULL DEFAULT 1,
    water_below REAL NOT NULL DEFAULT 40,
    tank_percent REAL NOT NULL DEFAULT 100,
    pending_ml INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    pairing_code TEXT UNIQUE,
    pairing_expires TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    plant_id INTEGER REFERENCES plants(id) ON DELETE SET NULL,
    last_seen TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    moisture REAL NOT NULL, temperature REAL NOT NULL, ph REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_readings ON readings(plant_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS watering_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('auto','manual')),
    amount_ml INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plant_id INTEGER REFERENCES plants(id) ON DELETE SET NULL,
    diagnosis TEXT NOT NULL, confidence REAL, advice TEXT, severity TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

function toObj(columns, row) {
  const o = {};
  columns.forEach((c, i) => { o[c] = row[i]; });
  return o;
}

function normArgs(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) return args[0];
  return args;
}

export async function openDb(file) {
  let client;
  if (file) {
    // explicit file (used by tests, e.g. ':memory:') -> local SQLite, never Turso
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    client = createClient({ url: file === ':memory:' ? ':memory:' : `file:${file}` });
    await client.execute('PRAGMA foreign_keys = ON');
  } else if (process.env.TURSO_DATABASE_URL) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
    console.log('Aurevia DB: using Turso');
  } else {
    const f = process.env.DB_FILE || './data/aurevia.db';
    fs.mkdirSync(path.dirname(f), { recursive: true });
    client = createClient({ url: `file:${f}` });
    await client.execute('PRAGMA foreign_keys = ON');
    console.log('Aurevia DB: using local file', f);
  }

  await client.batch(SCHEMA, 'write');

  return {
    client,
    prepare(sql) {
      return {
        async get(...args) {
          const r = await client.execute({ sql, args: normArgs(args) });
          return r.rows[0] ? toObj(r.columns, r.rows[0]) : undefined;
        },
        async all(...args) {
          const r = await client.execute({ sql, args: normArgs(args) });
          return r.rows.map((row) => toObj(r.columns, row));
        },
        async run(...args) {
          const r = await client.execute({ sql, args: normArgs(args) });
          return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
        },
      };
    },
    async exec(sql) { await client.executeMultiple(sql); },
  };
}
