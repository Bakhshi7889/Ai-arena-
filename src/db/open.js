import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/**
 * Opens a SQLite handle. Prefers `better-sqlite3` when it is installed and
 * built (faster, no experimental warning); otherwise falls back to the
 * built-in `node:sqlite` module (Node >= 22.5). Both expose the same
 * prepare/run/get/all/exec surface used by the repository layer.
 */
export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

  const better = tryRequire('better-sqlite3');
  if (better) {
    const db = new better(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.__driver = 'better-sqlite3';
    return db;
  }

  const sqlite = tryRequire('node:sqlite');
  if (!sqlite?.DatabaseSync) {
    throw new Error(
      'No SQLite driver available: install better-sqlite3 or run on Node >= 22.5 (node:sqlite).',
    );
  }
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.__driver = 'node:sqlite';
  return db;
}

function tryRequire(name) {
  try {
    return nodeRequire(name);
  } catch {
    return null;
  }
}
