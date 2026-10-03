import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file = process.env.DB_FILE || './data/aurevia.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plants (
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
    );
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      pairing_code TEXT UNIQUE,
      pairing_expires TEXT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      plant_id INTEGER REFERENCES plants(id) ON DELETE SET NULL,
      last_seen TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
      moisture REAL NOT NULL, temperature REAL NOT NULL, ph REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_readings ON readings(plant_id, id DESC);
    CREATE TABLE IF NOT EXISTS watering_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('auto','manual')),
      amount_ml INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plant_id INTEGER REFERENCES plants(id) ON DELETE SET NULL,
      diagnosis TEXT NOT NULL, confidence REAL, advice TEXT, severity TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}
