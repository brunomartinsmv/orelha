import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'orelha-catalogue-'));
process.env.ORELHA_DATA_DIR = dir;
process.env.ORELHA_NO_QUOTES = '1';
const { db } = await import('../server/db.js');
const { importHomeCatalogue } = await import('../scripts/import-home-catalogue.js');
const { home, profile, exportAll } = await import('../server/library.js');
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test('substitui demonstração, preserva dados pessoais e importa sem inventar histórico', async () => {
  db.exec(`INSERT INTO books (id, title, authors, cover_id) VALUES
    ('demo', 'Livro Físico', '["Uma Autora"]', 123),
    ('other-demo', 'Outro Exemplo', '["Outro Autor"]', NULL),
    ('personal', 'Meu Registro', '["Eu"]', NULL);
    INSERT INTO shelf (book_id, status, demo) VALUES ('demo','reading',1), ('other-demo','read',1), ('personal','read',0);
    INSERT INTO logs (book_id, rating, review, demo) VALUES ('demo',10,'Resenha fictícia',1), ('personal',8,'Minha resenha',0);
    INSERT INTO quotes (book_id, text, demo) VALUES ('demo','Exemplo',1), ('personal','Trecho pessoal',0);
    INSERT INTO favorites (slot,book_id,demo) VALUES (1,'demo',1), (2,'personal',0);`);
  const source = { books: [
    { row: 2, title: 'Livro Físico', authors: ['Uma Autora'], genre: 'Clássico', read: true, filed: true },
    { row: 3, title: 'Outro Livro', authors: ['Outra Autora'], genre: 'Fisica', read: false, filed: false },
  ] };
  const result = importHomeCatalogue(source);
  assert.equal(result.total, 2);
  assert.equal(result.books[0].book_id, 'demo');
  assert.equal(db.prepare("SELECT cover_id FROM books WHERE id = 'demo'").get().cover_id, 123);
  assert.equal(db.prepare("SELECT status FROM shelf WHERE book_id = 'demo'").get().status, 'read');
  assert.deepEqual({ ...db.prepare("SELECT rating, review FROM logs WHERE book_id = 'personal'").get() }, { rating: 8, review: 'Minha resenha' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM logs WHERE book_id = 'demo'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quotes').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM favorites').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shelf').get().n, 3);
  const overview = await home();
  assert.equal(overview.has_books, true);
  assert.equal(overview.demo, false);
  assert.deepEqual(overview.reading, []);
  assert.deepEqual(overview.recent, []);
  assert.equal(profile().counts.books, 2);
  const exported = exportAll();
  assert.ok(exported.books.some((b) => b.title === 'Outro Livro' && b.subjects === '["Fisica"]'));
  assert.equal(exported.list_items.filter((i) => i.list_id === result.lists.atHome).length, 2);
  assert.equal(exported.list_items.filter((i) => i.list_id === result.lists.filed).length, 1);

  const before = exportAll();
  const again = importHomeCatalogue(source);
  assert.deepEqual(again, result);
  const afterImport = exportAll();
  delete before.exported_at; delete afterImport.exported_at;
  assert.deepEqual(afterImport, before);
});

test('catálogo inválido falha antes de alterar dados', () => {
  const before = exportAll();
  assert.throws(() => importHomeCatalogue({ books: [{ title: 'Incompleto' }] }), /inválido/);
  const afterImport = exportAll();
  delete before.exported_at; delete afterImport.exported_at;
  assert.deepEqual(afterImport, before);
});
