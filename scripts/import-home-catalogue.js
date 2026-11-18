import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { db, transaction } from '../server/db.js';
import { clearDemoData } from '../server/library.js';
import { enrichImported } from '../server/importers.js';

const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function importHomeCatalogue(catalogue) {
  if (!Array.isArray(catalogue.books) || !catalogue.books.length) throw new Error('Catálogo vazio.');
  const seen = new Set();
  for (const book of catalogue.books) {
    if (!book.title?.trim() || !book.authors?.length || !book.authors.every((a) => typeof a === 'string' && a.trim()) ||
        !book.genre?.trim() || typeof book.read !== 'boolean' || typeof book.filed !== 'boolean') throw new Error(`Registro inválido na linha ${book.row}.`);
    const identity = `${norm(book.title)}|${book.authors.map(norm).join('|')}`;
    if (seen.has(identity)) throw new Error(`Livro repetido: ${book.title}`);
    seen.add(identity);
  }
  const result = transaction(() => {
    const existing = db.prepare('SELECT id, title, authors FROM books').all();
    const createList = (title, description) => {
      const found = db.prepare('SELECT id FROM lists WHERE title = ? AND description = ? AND demo = 0').get(title, description);
      return found?.id ?? Number(db.prepare('INSERT INTO lists (title, description) VALUES (?, ?)').run(title, description).lastInsertRowid);
    };
    const atHome = createList('Em casa', 'Coleção física importada da planilha.');
    const filed = createList('Fichados', 'Livros marcados como fichados na planilha.');
    const imported = [];
    for (const [position, item] of catalogue.books.entries()) {
      const found = existing.find((b) => norm(b.title) === norm(item.title) && norm(JSON.parse(b.authors)[0] || '') === norm(item.authors[0]));
      const id = found?.id || `c_${createHash('sha256').update(`${norm(item.title)}|${item.authors.map(norm).join('|')}`).digest('hex').slice(0, 16)}`;
      const shelf = db.prepare('SELECT * FROM shelf WHERE book_id = ?').get(id);
      const personal = shelf && !shelf.demo;
      db.prepare(`INSERT INTO books (id, title, title_is_pt, authors, subjects, source, user_edited)
        VALUES (?, ?, 1, ?, ?, 'catalogue', 1)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, authors = excluded.authors,
          subjects = excluded.subjects, title_is_pt = 1, source = 'catalogue', user_edited = 1`)
        .run(id, item.title, JSON.stringify(item.authors), JSON.stringify([item.genre]));
      if (!personal) {
        db.prepare(`INSERT INTO shelf (book_id, status, demo) VALUES (?, ?, 0)
          ON CONFLICT(book_id) DO UPDATE SET status = excluded.status, demo = 0,
            liked = 0, current_page = NULL, started_on = NULL`).run(id, item.read ? 'read' : 'want');
      }
      db.prepare('INSERT INTO list_items (list_id, book_id, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(atHome, id, position);
      if (item.filed) db.prepare('INSERT INTO list_items (list_id, book_id, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(filed, id, position);
      imported.push({ ...item, book_id: id });
    }
    return { total: imported.length, read: imported.filter((b) => b.read).length, unread: imported.filter((b) => !b.read).length,
      filed: imported.filter((b) => b.filed).length, lists: { atHome, filed }, books: imported };
  });
  clearDemoData();
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2];
  if (!input) throw new Error('Uso: node scripts/import-home-catalogue.js catalogo.json');
  const catalogue = JSON.parse(readFileSync(input, 'utf8'));
  const backup = join(dirname(resolve(input)), `before-import-${Date.now()}.sqlite`);
  db.prepare('VACUUM INTO ?').run(backup);
  const result = importHomeCatalogue(catalogue);
  writeFileSync(join(dirname(resolve(input)), 'import-result.json'), JSON.stringify({ backup, ...result }, null, 2) + '\n');
  console.log(JSON.stringify({ backup, total: result.total, read: result.read, unread: result.unread, filed: result.filed, lists: result.lists }, null, 2));
  await enrichImported();
}
