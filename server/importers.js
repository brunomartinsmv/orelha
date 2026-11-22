// Importação de CSV (Skoob, Goodreads, StoryGraph, Orelha) e restauração de backup JSON do Orelha.
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { COVERS_DIR, db, transaction } from './db.js';
import { HttpError } from './library.js';
import * as ol from './openlibrary.js';

function detectDelimiter(input) {
  let commas = 0, semis = 0, quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') commas++;
    else if (c === ';') semis++;
    else if (c === '\n' || c === '\r') break;
  }
  return semis > commas ? ';' : ',';
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  const sep = detectDelimiter(input);
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
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

const norm = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Goodreads exporta ISBN como ="9781234567890".
const cleanIsbn = (v) => {
  const s = String(v || '').replace(/[^\dXx]/g, '').toUpperCase();
  return /^(97[89]\d{10}|\d{9}[\dX])$/.test(s) ? s : null;
};

function validIsoDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function normalizeDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) return validIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return validIsoDate(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

// O StoryGraph põe só o intervalo em "Dates Read": "2024/01/02-2024/01/30".
function dateRange(v) {
  const [start, end] = (v || '').split('-').length > 1 && /\//.test(v) ? v.split('-') : [null, v];
  return { start: normalizeDate(start), end: normalizeDate(end) };
}

function parseRating(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 5) return null;
  return Math.max(1, Math.min(10, Math.round(n * 2)));
}

const STATUS_MAP = {
  read: 'read',
  lido: 'read',
  lidos: 'read',
  'currently reading': 'reading',
  reading: 'reading',
  lendo: 'reading',
  relendo: 'reading',
  'em leitura': 'reading',
  'to read': 'want',
  want: 'want',
  'quero ler': 'want',
  'vou ler': 'want',
  desejado: 'want',
  desejados: 'want',
  'did not finish': 'dropped',
  dnf: 'dropped',
  abandoned: 'dropped',
  dropped: 'dropped',
  abandonei: 'dropped',
  abandonado: 'dropped',
  abandonados: 'dropped',
};

function parseShelfInfo(primary, secondary) {
  let status = null;
  let reread = 0;
  let liked = 0;
  const sources = [primary, secondary].filter(Boolean);
  for (const raw of sources) {
    const tokens = String(raw).split(/[,;|]/).map(norm).filter(Boolean);
    for (const token of tokens) {
      if (!status && STATUS_MAP[token]) status = STATUS_MAP[token];
      if (token === 'relendo' || token === 'releitura' || token === 'reread') reread = 1;
      if (token === 'favorito' || token === 'favoritos' || token === 'marcou') liked = 1;
    }
  }
  return { status, reread, liked };
}

const FORMAT_MAP = {
  paper: 'paper',
  papel: 'paper',
  paperback: 'paper',
  hardcover: 'paper',
  print: 'paper',
  fisico: 'paper',
  'capa comum': 'paper',
  'capa dura': 'paper',
  brochura: 'paper',
  ebook: 'ebook',
  'e book': 'ebook',
  digital: 'ebook',
  kindle: 'ebook',
  audio: 'audio',
  audiobook: 'audio',
  audiolivro: 'audio',
};

const parseFormat = (v) => FORMAT_MAP[norm(v)] || null;
const parseBool = (v) => ['1', 'true', 'sim', 'yes', 's'].includes(norm(v)) ? 1 : 0;
const parsePositiveInt = (v) => {
  const n = Number(String(v ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Remove apóstrofo inserido pelo próprio Orelha para neutralizar fórmulas em planilhas.
const unescapeCsvCell = (v) => {
  const s = String(v ?? '').trim();
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
};

function rowLookup(row) {
  const byNorm = new Map(Object.entries(row).map(([k, v]) => [norm(k), v]));
  return (...names) => {
    for (const name of names) {
      const val = byNorm.get(name);
      if (val !== undefined && String(val).trim() !== '') return val;
    }
    return '';
  };
}

function fromGoodreadsOrSkoob(r) {
  const shelf = parseShelfInfo(r['Exclusive Shelf'], r.Bookshelves);
  const review = unescapeCsvCell(r['My Review']);
  const readCount = Number(r['Read Count']) || 0;
  return {
    title: unescapeCsvCell(r.Title),
    authors: [r.Author, ...(r['Additional Authors'] || '').split(',')].map((a) => unescapeCsvCell(a)).filter(Boolean),
    isbn: cleanIsbn(r.ISBN13) || cleanIsbn(r.ISBN),
    pages: parsePositiveInt(r['Number of Pages']),
    year: parsePositiveInt(r['Original Publication Year']) || parsePositiveInt(r['Year Published']),
    status: shelf.status,
    rating: parseRating(r['My Rating']),
    finished_on: normalizeDate(r['Date Read']),
    started_on: null,
    review: review || null,
    spoilers: parseBool(r.Spoiler),
    reread: shelf.reread || (readCount > 1 ? 1 : 0),
    liked: shelf.liked,
    format: parseFormat(r.Binding),
  };
}

function fromStoryGraph(r) {
  const shelf = parseShelfInfo(r['Read Status']);
  const dates = dateRange(r['Dates Read']);
  const review = unescapeCsvCell(r.Review);
  const readCount = Number(r['Read Count']) || 0;
  return {
    title: unescapeCsvCell(r.Title),
    authors: (r.Authors || '').split(',').map((a) => unescapeCsvCell(a)).filter(Boolean),
    isbn: cleanIsbn(r['ISBN/UID']),
    pages: null,
    year: null,
    status: shelf.status,
    // O StoryGraph aceita quartos de estrela; arredonda para a meia estrela mais próxima.
    rating: parseRating(r['Star Rating']),
    finished_on: normalizeDate(r['Last Date Read']) || dates.end,
    started_on: dates.start,
    review: review || null,
    spoilers: 0,
    reread: readCount > 1 ? 1 : 0,
    liked: 0,
    format: parseFormat(r.Format),
  };
}

function fromPortugueseCsv(r) {
  const get = rowLookup(r);
  const shelf = parseShelfInfo(get('status', 'estante', 'prateleira', 'situacao'));
  const review = unescapeCsvCell(get('resenha', 'comentario', 'avaliacao texto', 'review'));
  const rawAuthors = get('autores', 'autor', 'autoria');
  const authorSep = rawAuthors.includes(';') ? ';' : ',';
  return {
    title: unescapeCsvCell(get('titulo', 'livro', 'nome')),
    authors: rawAuthors.split(authorSep).map((a) => unescapeCsvCell(a)).filter(Boolean),
    isbn: cleanIsbn(get('isbn13', 'isbn 13', 'isbn', 'isbn10', 'isbn 10')),
    pages: parsePositiveInt(get('paginas', 'numero de paginas', 'num paginas')),
    year: parsePositiveInt(get('ano', 'ano publicacao', 'ano de publicacao')),
    status: shelf.status,
    rating: parseRating(get('nota', 'avaliacao', 'estrelas', 'minha nota')),
    finished_on: normalizeDate(get('terminado em', 'lido em', 'data de leitura', 'data leitura', 'data fim')),
    started_on: normalizeDate(get('comecado em', 'iniciado em', 'data inicio', 'data de inicio')),
    review: review || null,
    spoilers: parseBool(get('spoiler', 'spoilers')),
    reread: parseBool(get('releitura')) || shelf.reread,
    liked: parseBool(get('marcou', 'favorito', 'curtiu')) || shelf.liked,
    format: parseFormat(get('formato', 'tipo', 'midia')),
  };
}

function detectFormat(rows) {
  const keys = Object.keys(rows[0] || {});
  const normKeys = new Set(keys.map(norm));
  if (keys.includes('Exclusive Shelf')) return { name: 'Goodreads', map: fromGoodreadsOrSkoob };
  if (keys.includes('Read Status')) return { name: 'StoryGraph', map: fromStoryGraph };
  if (normKeys.has('titulo') && normKeys.has('autores') && (normKeys.has('terminado em') || normKeys.has('marcou'))) {
    return { name: 'Orelha (CSV)', map: fromPortugueseCsv };
  }
  if (keys.includes('Title') && (keys.includes('Bookshelves') || (keys.includes('Author') && (keys.includes('My Rating') || keys.includes('ISBN') || keys.includes('ISBN13'))))) {
    return { name: 'Skoob', map: fromGoodreadsOrSkoob };
  }
  if (normKeys.has('titulo') && (normKeys.has('autor') || normKeys.has('autores'))) {
    return { name: 'Skoob', map: fromPortugueseCsv };
  }
  throw new HttpError(400, 'Não reconheci este arquivo. Use JSON/CSV do Orelha ou CSV do Skoob, Goodreads ou StoryGraph.');
}

function findBook(item) {
  if (item.isbn) {
    const byIsbn = db.prepare('SELECT id FROM books WHERE isbn = ?').get(item.isbn);
    if (byIsbn) return byIsbn.id;
  }
  if (!item.title) return null;
  const prefix = item.title.split(/[:(]/)[0].trim();
  const candidates = db.prepare('SELECT id, title, authors FROM books WHERE title LIKE ?').all(`${prefix}%`);
  const target = norm(prefix);
  const author = norm(item.authors?.[0] || '');
  return candidates.find((c) => norm(c.title.split(/[:(]/)[0]) === target && norm(JSON.parse(c.authors || '[]')[0] || '') === author)?.id ?? null;
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
      if (item.status || item.liked) {
        db.prepare(`UPDATE shelf SET
            status = COALESCE(?, status),
            liked = MAX(liked, ?),
            started_on = COALESCE(started_on, ?)
          WHERE book_id = ?`)
          .run(item.status, item.liked ? 1 : 0, item.started_on || (item.status === 'reading' ? new Date().toLocaleDateString('en-CA') : null), bookId);
      }
      if (item.status === 'read' || item.finished_on || item.rating || item.review) {
        // A chave torna a importação idempotente: reimportar não duplica o diário.
        const key = createHash('sha1').update(`${norm(item.title)}|${norm(item.authors[0] || '')}|${item.finished_on || ''}`).digest('hex');
        const { changes } = db.prepare(`INSERT INTO logs (book_id, finished_on, started_on, rating, review, spoilers, reread, format, import_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(import_key) DO NOTHING`)
          .run(bookId, item.finished_on, item.started_on, item.rating, item.review, item.spoilers ? 1 : 0, item.reread ? 1 : 0, item.format ?? null, key);
        result.logs_added += Number(changes);
      }
    }
  });
  enrichImported();
  return result;
}

const VALID_STATUS = new Set(['want', 'reading', 'read', 'dropped']);
const VALID_FORMAT = new Set(['paper', 'ebook', 'audio']);
const VALID_COVER_FILE = /^up-[0-9a-f-]+\.(jpg|png|webp)$/;

function parseJsonArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch { /* ignora */ }
  }
  return [];
}

function safeInt(v, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function safeRating(v) {
  return safeInt(v, { min: 1, max: 10 });
}

function safeCoverFile(v) {
  if (typeof v !== 'string' || !VALID_COVER_FILE.test(v)) return null;
  return existsSync(join(COVERS_DIR, v)) ? v : null;
}

export function importOrelhaJson(data) {
  if (!data || typeof data !== 'object' || data.app !== 'orelha' || !Array.isArray(data.books)) {
    throw new HttpError(400, 'Este JSON não parece ser um backup do Orelha.');
  }
  const result = {
    format: 'Orelha (JSON)',
    total: data.books.length,
    books_added: 0,
    logs_added: 0,
    quotes_added: 0,
    lists_added: 0,
    skipped: 0,
  };
  let needsEnrich = false;

  transaction(() => {
    const bookIdMap = new Map();

    for (const raw of data.books) {
      if (!raw || typeof raw !== 'object' || !String(raw.title || '').trim()) {
        result.skipped++;
        continue;
      }
      const title = String(raw.title).trim().slice(0, 300);
      const authors = parseJsonArray(raw.authors);
      const subjects = parseJsonArray(raw.subjects).slice(0, 16);
      const isbn = cleanIsbn(raw.isbn);
      const olKey = typeof raw.ol_key === 'string' && raw.ol_key.trim() ? raw.ol_key.trim() : null;
      const oldId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;

      let existing = (oldId && db.prepare('SELECT * FROM books WHERE id = ?').get(oldId))
        || (olKey && db.prepare('SELECT * FROM books WHERE ol_key = ?').get(olKey))
        || null;
      if (!existing) {
        const matchedId = findBook({ title, authors, isbn });
        if (matchedId) existing = db.prepare('SELECT * FROM books WHERE id = ?').get(matchedId);
      }

      if (existing) {
        if (oldId) bookIdMap.set(oldId, existing.id);
        // Completa campos que estejam vazios no banco atual sem pisar em edições locais.
        const coverFile = safeCoverFile(raw.cover_file);
        db.prepare(`UPDATE books SET
            subtitle = COALESCE(subtitle, ?),
            year = COALESCE(year, ?),
            pages = COALESCE(pages, ?),
            isbn = COALESCE(isbn, ?),
            cover_id = COALESCE(cover_id, ?),
            cover_isbn = COALESCE(cover_isbn, ?),
            cover_file = COALESCE(cover_file, ?),
            color = COALESCE(color, ?),
            description = COALESCE(description, ?),
            subjects = CASE WHEN subjects = '[]' THEN ? ELSE subjects END
          WHERE id = ?`)
          .run(
            raw.subtitle ? String(raw.subtitle).trim().slice(0, 300) : null,
            safeInt(raw.year),
            safeInt(raw.pages, { min: 1 }),
            isbn,
            safeInt(raw.cover_id, { min: 1 }),
            cleanIsbn(raw.cover_isbn) || isbn,
            coverFile,
            typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : null,
            raw.description ? String(raw.description).trim().slice(0, 10_000) : null,
            JSON.stringify(subjects),
            existing.id,
          );
        continue;
      }

      const newId = oldId || `b_${randomUUID().slice(0, 12)}`;
      const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim().slice(0, 40) : 'import';
      const coverFile = safeCoverFile(raw.cover_file);
      const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : null;
      db.prepare(`INSERT INTO books (
          id, ol_key, title, title_is_pt, original_title, subtitle, authors, year, pages,
          isbn, cover_id, cover_isbn, cover_file, color, description, subjects, source, user_edited, details_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          newId,
          olKey,
          title,
          raw.title_is_pt ? 1 : 0,
          raw.original_title ? String(raw.original_title).trim().slice(0, 300) : null,
          raw.subtitle ? String(raw.subtitle).trim().slice(0, 300) : null,
          JSON.stringify(authors),
          safeInt(raw.year),
          safeInt(raw.pages, { min: 1 }),
          isbn,
          safeInt(raw.cover_id, { min: 1 }),
          cleanIsbn(raw.cover_isbn) || isbn,
          coverFile,
          color,
          raw.description ? String(raw.description).trim().slice(0, 10_000) : null,
          JSON.stringify(subjects),
          source,
          raw.user_edited ? 1 : 0,
          typeof raw.details_at === 'string' ? raw.details_at : null,
        );
      if (oldId) bookIdMap.set(oldId, newId);
      result.books_added++;
      if (source === 'import' && !olKey && !raw.details_at) needsEnrich = true;
    }

    for (const s of Array.isArray(data.shelf) ? data.shelf : []) {
      const bookId = bookIdMap.get(s?.book_id);
      if (!bookId) continue;
      const status = VALID_STATUS.has(s.status) ? s.status : null;
      const liked = s.liked ? 1 : 0;
      const currentPage = safeInt(s.current_page);
      const startedOn = normalizeDate(s.started_on);
      db.prepare(`INSERT INTO shelf (book_id, status, liked, current_page, started_on, demo)
        VALUES (?, ?, ?, ?, ?, 0)
        ON CONFLICT(book_id) DO UPDATE SET
          status = COALESCE(shelf.status, excluded.status),
          liked = MAX(shelf.liked, excluded.liked),
          current_page = COALESCE(shelf.current_page, excluded.current_page),
          started_on = COALESCE(shelf.started_on, excluded.started_on)`)
        .run(bookId, status, liked, currentPage, startedOn);
    }

    for (const l of Array.isArray(data.logs) ? data.logs : []) {
      const bookId = bookIdMap.get(l?.book_id);
      if (!bookId) continue;
      const finishedOn = normalizeDate(l.finished_on);
      const startedOn = normalizeDate(l.started_on);
      const rating = safeRating(l.rating);
      const review = l.review ? String(l.review).trim().slice(0, 20_000) : null;
      const spoilers = l.spoilers ? 1 : 0;
      const reread = l.reread ? 1 : 0;
      const format = VALID_FORMAT.has(l.format) ? l.format : null;
      const importKey = typeof l.import_key === 'string' && l.import_key.trim() ? l.import_key.trim() : null;

      if (importKey && db.prepare('SELECT 1 FROM logs WHERE import_key = ?').get(importKey)) continue;
      const dup = db.prepare(`SELECT 1 FROM logs WHERE book_id = ?
        AND finished_on IS ? AND started_on IS ? AND rating IS ? AND review IS ? AND reread = ? AND format IS ? LIMIT 1`)
        .get(bookId, finishedOn, startedOn, rating, review, reread, format);
      if (dup) continue;

      db.prepare(`INSERT INTO logs (book_id, finished_on, started_on, rating, review, spoilers, reread, format, import_key, demo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
        .run(bookId, finishedOn, startedOn, rating, review, spoilers, reread, format, importKey);
      result.logs_added++;
    }

    for (const p of Array.isArray(data.progress) ? data.progress : []) {
      const bookId = bookIdMap.get(p?.book_id);
      const page = safeInt(p?.page);
      const onDay = normalizeDate(p?.on_day);
      if (!bookId || page === null || !onDay) continue;
      const dup = db.prepare('SELECT 1 FROM progress WHERE book_id = ? AND page = ? AND on_day = ? LIMIT 1').get(bookId, page, onDay);
      if (!dup) db.prepare('INSERT INTO progress (book_id, page, on_day, demo) VALUES (?, ?, ?, 0)').run(bookId, page, onDay);
    }

    for (const q of Array.isArray(data.quotes) ? data.quotes : []) {
      const bookId = bookIdMap.get(q?.book_id);
      const text = q?.text ? String(q.text).trim().slice(0, 5000) : '';
      const page = safeInt(q?.page);
      if (!bookId || !text) continue;
      const dup = db.prepare('SELECT 1 FROM quotes WHERE book_id = ? AND text = ? AND page IS ? LIMIT 1').get(bookId, text, page);
      if (!dup) {
        db.prepare('INSERT INTO quotes (book_id, text, page, demo) VALUES (?, ?, ?, 0)').run(bookId, text, page);
        result.quotes_added++;
      }
    }

    const listIdMap = new Map();
    for (const l of Array.isArray(data.lists) ? data.lists : []) {
      const title = l?.title ? String(l.title).trim().slice(0, 120) : '';
      if (!title) continue;
      const existing = db.prepare('SELECT id FROM lists WHERE lower(title) = lower(?) LIMIT 1').get(title);
      if (existing) {
        listIdMap.set(l.id, existing.id);
      } else {
        const desc = l.description ? String(l.description).trim().slice(0, 1000) : null;
        const { lastInsertRowid } = db.prepare('INSERT INTO lists (title, description, ranked, demo) VALUES (?, ?, ?, 0)')
          .run(title, desc, l.ranked ? 1 : 0);
        listIdMap.set(l.id, Number(lastInsertRowid));
        result.lists_added++;
      }
    }

    for (const item of Array.isArray(data.list_items) ? data.list_items : []) {
      const listId = listIdMap.get(item?.list_id);
      const bookId = bookIdMap.get(item?.book_id);
      if (!listId || !bookId) continue;
      const pos = safeInt(item.position) ?? 0;
      db.prepare('INSERT INTO list_items (list_id, book_id, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
        .run(listId, bookId, pos);
    }

    for (const f of Array.isArray(data.favorites) ? data.favorites : []) {
      const slot = safeInt(f?.slot, { min: 1, max: 4 });
      const bookId = bookIdMap.get(f?.book_id);
      if (!slot || !bookId) continue;
      const slotTaken = db.prepare('SELECT 1 FROM favorites WHERE slot = ?').get(slot);
      const bookTaken = db.prepare('SELECT 1 FROM favorites WHERE book_id = ?').get(bookId);
      if (!slotTaken && !bookTaken) {
        db.prepare('INSERT INTO favorites (slot, book_id, demo) VALUES (?, ?, 0)').run(slot, bookId);
      }
    }
  });

  if (needsEnrich) enrichImported();
  return result;
}

export function importData(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '');
  if (!clean.trim()) throw new HttpError(400, 'O arquivo está vazio.');
  if (clean.trimStart().startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      throw new HttpError(400, 'Arquivo JSON inválido.');
    }
    return importOrelhaJson(parsed);
  }
  return importCsv(clean);
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
