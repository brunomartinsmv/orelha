import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = process.env.ORELHA_DATA_DIR || join(import.meta.dirname, '..', 'data');
export const COVERS_DIR = join(DATA_DIR, 'covers');
mkdirSync(COVERS_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'orelha.sqlite'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Metadados de livro. Resultados de busca também ficam aqui, como cache:
-- um livro só "é seu" quando tem linha em shelf ou logs.
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  ol_key TEXT UNIQUE,
  title TEXT NOT NULL,
  title_is_pt INTEGER NOT NULL DEFAULT 0,
  original_title TEXT,
  subtitle TEXT,
  authors TEXT NOT NULL DEFAULT '[]',
  year INTEGER,
  pages INTEGER,
  isbn TEXT,
  cover_id INTEGER,
  cover_isbn TEXT,
  cover_file TEXT,
  color TEXT,
  description TEXT,
  subjects TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'openlibrary',
  user_edited INTEGER NOT NULL DEFAULT 0,
  details_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS books_isbn ON books(isbn);

CREATE TABLE IF NOT EXISTS shelf (
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  status TEXT CHECK (status IN ('want','reading','read','dropped')),
  liked INTEGER NOT NULL DEFAULT 0,
  current_page INTEGER,
  started_on TEXT,
  dropped_on TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  finished_on TEXT,
  started_on TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 10), -- meias estrelas: 1 = ½, 10 = 5
  review TEXT,
  spoilers INTEGER NOT NULL DEFAULT 0,
  reread INTEGER NOT NULL DEFAULT 0,
  format TEXT CHECK (format IN ('paper','ebook','audio')),
  import_key TEXT UNIQUE,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS logs_book ON logs(book_id);
CREATE INDEX IF NOT EXISTS logs_finished ON logs(finished_on);

CREATE TABLE IF NOT EXISTS progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  on_day TEXT NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS progress_day ON progress(on_day);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  page INTEGER,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  ranked INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS list_items (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (list_id, book_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 4),
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  demo INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS api_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

// Migração leve para bancos criados antes de `dropped_on`: preserva abandonos antigos sem inventar data.
const shelfColumns = db.prepare('PRAGMA table_info(shelf)').all().map((c) => c.name);
if (!shelfColumns.includes('dropped_on')) {
  db.exec('ALTER TABLE shelf ADD COLUMN dropped_on TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS shelf_dropped ON shelf(dropped_on)');

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }
}

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
