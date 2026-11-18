// Importação de CSV do Goodreads e do StoryGraph, com enriquecimento em segundo plano.
import { randomUUID, createHash } from 'node:crypto';
import { db, transaction } from './db.js';
import { HttpError } from './library.js';
import * as ol from './openlibrary.js';

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return [];
  return body
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

// Goodreads exporta ISBN como ="9781234567890".
const cleanIsbn = (v) => (v || '').replace(/[^\dXx]/g, '') || null;

function normalizeDate(v) {
  const m = (v || '').trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

// O StoryGraph põe só o intervalo em "Dates Read": "2024/01/02-2024/01/30".
function dateRange(v) {
  const [start, end] = (v || '').split('-').length > 1 && /\//.test(v) ? v.split('-') : [null, v];
  return { start: normalizeDate(start), end: normalizeDate(end) };
}

function fromGoodreads(r) {
  const status = { read: 'read', 'currently-reading': 'reading', 'to-read': 'want' }[r['Exclusive Shelf']] ?? null;
  const rating = Number(r['My Rating']);
  return {
    title: r.Title,
    authors: [r.Author, ...(r['Additional Authors'] || '').split(',')].map((a) => (a || '').trim()).filter(Boolean),
    isbn: cleanIsbn(r.ISBN13) || cleanIsbn(r.ISBN),
    pages: Number(r['Number of Pages']) || null,
    year: Number(r['Original Publication Year']) || Number(r['Year Published']) || null,
    status,
    rating: rating > 0 ? rating * 2 : null,
    finished_on: normalizeDate(r['Date Read']),
    started_on: null,
    review: r['My Review']?.trim() || null,
    spoilers: r.Spoiler === 'true' ? 1 : 0,
    rereads: Math.max(0, (Number(r['Read Count']) || 1) - 1),
  };
}

function fromStoryGraph(r) {
  const status = { read: 'read', 'currently-reading': 'reading', 'to-read': 'want', 'did-not-finish': 'dropped' }[r['Read Status']] ?? null;
  const rating = Number(r['Star Rating']);
  const dates = dateRange(r['Dates Read']);
  const format = { digital: 'ebook', audio: 'audio', paperback: 'paper', hardcover: 'paper', print: 'paper' }[(r.Format || '').toLowerCase()] || null;
  return {
    title: r.Title,
    authors: (r.Authors || '').split(',').map((a) => a.trim()).filter(Boolean),
    isbn: cleanIsbn(r['ISBN/UID']),
    pages: null,
    year: null,
    status,
    // O StoryGraph aceita quartos de estrela; arredonda para a meia estrela mais próxima.
    rating: rating > 0 ? Math.max(1, Math.round(rating * 2)) : null,
    finished_on: normalizeDate(r['Last Date Read']) || dates.end,
    started_on: dates.start,
    review: r.Review?.trim() || null,
    spoilers: 0,
    rereads: Math.max(0, (Number(r['Read Count']) || 1) - 1),
    format,
  };
}

function detectFormat(rows) {
  const keys = Object.keys(rows[0] || {});
  if (keys.includes('Exclusive Shelf')) return { name: 'Goodreads', map: fromGoodreads };
  if (keys.includes('Read Status')) return { name: 'StoryGraph', map: fromStoryGraph };
  throw new HttpError(400, 'Não reconheci este CSV. Use a exportação do Goodreads ou do StoryGraph.');
}

const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function findBook(item) {
  if (item.isbn) {
    const byIsbn = db.prepare('SELECT id FROM books WHERE isbn = ?').get(item.isbn);
    if (byIsbn) return byIsbn.id;
  }
  const candidates = db.prepare('SELECT id, title, authors FROM books WHERE title LIKE ?').all(`${item.title.split(/[:(]/)[0].trim()}%`);
  const target = norm(item.title.split(/[:(]/)[0]);
  const author = norm(item.authors[0] || '');
  return candidates.find((c) => norm(c.title.split(/[:(]/)[0]) === target && norm(JSON.parse(c.authors)[0] || '') === author)?.id ?? null;
}

export function importCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new HttpError(400, 'O arquivo está vazio.');
  const { name, map } = detectFormat(rows);
  const result = { format: name, total: rows.length, books_added: 0, logs_added: 0, skipped: 0 };

  transaction(() => {
    for (const row of rows) {
      const item = map(row);
      if (!item.title?.trim()) { result.skipped++; continue; }
      let bookId = findBook(item);
      if (!bookId) {
        bookId = `b_${randomUUID().slice(0, 12)}`;
        db.prepare(`INSERT INTO books (id, title, authors, year, pages, isbn, cover_isbn, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'import')`)
          .run(bookId, item.title.trim(), JSON.stringify(item.authors), item.year, item.pages, item.isbn, item.isbn);
        result.books_added++;
      }
      db.prepare('INSERT INTO shelf (book_id) VALUES (?) ON CONFLICT(book_id) DO NOTHING').run(bookId);
      if (item.status) {
        db.prepare(`UPDATE shelf SET status = ?, started_on = COALESCE(started_on, ?) WHERE book_id = ?`)
          .run(item.status, item.status === 'reading' ? new Date().toLocaleDateString('en-CA') : null, bookId);
      }
      if (item.status === 'read' || item.finished_on || item.rating || item.review) {
        // A chave torna a importação idempotente: reimportar não duplica o diário.
        const key = createHash('sha1').update(`${norm(item.title)}|${norm(item.authors[0] || '')}|${item.finished_on || ''}`).digest('hex');
        const { changes } = db.prepare(`INSERT INTO logs (book_id, finished_on, started_on, rating, review, spoilers, format, import_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(import_key) DO NOTHING`)
          .run(bookId, item.finished_on, item.started_on, item.rating, item.review, item.spoilers, item.format ?? null, key);
        result.logs_added += Number(changes);
      }
    }
  });
  enrichImported();
  return result;
}

// Busca capa, ano e páginas na Open Library aos poucos, para não martelar a API.
let enriching = false;

export function catalogueCover(book, docs) {
  const title = norm(book.title);
  const authors = JSON.parse(book.authors).map((a) => norm(a).split(' ').at(-1));
  return docs.find((d) => d.cover_id && norm(d.title) === title &&
    d.authors.some((a) => authors.some((surname) => surname.length >= 4 && norm(a).split(' ').includes(surname))));
}

export async function enrichImported() {
  if (enriching || process.env.ORELHA_NO_ENRICH) return;
  enriching = true;
  try {
    for (;;) {
      const book = db.prepare(`SELECT * FROM books WHERE details_at IS NULL AND (
        (source = 'import' AND ol_key IS NULL) OR
        (source = 'catalogue' AND cover_id IS NULL AND cover_file IS NULL AND cover_isbn IS NULL)
      ) LIMIT 1`).get();
      if (!book) break;
      const authors = JSON.parse(book.authors);
      const query = book.isbn || `${book.title.split(/[:(]/)[0]} ${authors[0] || ''}`;
      try {
        const docs = await ol.searchBooks(query);
        if (book.source === 'catalogue') {
          const doc = catalogueCover(book, docs);
          db.prepare(`UPDATE books SET cover_id = ?, details_at = datetime('now') WHERE id = ?
            AND cover_file IS NULL AND cover_id IS NULL`).run(doc?.cover_id ?? null, book.id);
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        // Só o melhor resultado: se outra linha já é dona dessa obra, não vale pegar o 2º, que seria outro livro.
        const best = docs.find((d) => d.ol_key);
        const doc = best && !db.prepare('SELECT 1 FROM books WHERE ol_key = ?').get(best.ol_key) ? best : null;
        db.prepare(`UPDATE books SET ol_key = ?, cover_id = COALESCE(cover_id, ?), pages = COALESCE(pages, ?), year = COALESCE(year, ?),
                    isbn = COALESCE(isbn, ?), subjects = ?, details_at = ? WHERE id = ?`)
          .run(doc?.ol_key ?? null, doc?.cover_id ?? null, doc?.pages ?? null, doc?.year ?? null, doc?.isbn ?? null,
            JSON.stringify(doc?.subjects ?? []), doc ? null : new Date().toISOString(), book.id);
      } catch (err) {
        // Sem rede: tenta de novo na próxima importação ou reinício.
        console.warn(`Enriquecimento pausado: ${err.message}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  } finally {
    enriching = false;
  }
}
