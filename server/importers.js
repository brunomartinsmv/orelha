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
  if (quoted) throw new HttpError(400, 'CSV malformado: aspas sem fechamento.');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return [];
  return body
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

// Remove apenas diacríticos combinantes sobre letras latinas (para cabeçalhos, status e formatos).
const norm = (s) => String(s || '')
  .normalize('NFD')
  .replace(/(\p{Script=Latin})[\u0300-\u036f]+/gu, '$1')
  .normalize('NFC')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
  .trim();

// Chave de identidade para títulos/autores: unifica NFC/NFD/misto preservando acentos e marcas
// que distinguem palavras (ex.: Vovó vs Vovô, パン vs バン).
const titleKey = (s) => String(s || '')
  .normalize('NFC')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
  .trim();

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

function safeTimestamp(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(s)) return null;
  if (Number.isNaN(Date.parse(s.replace(' ', 'T')))) return null;
  return s;
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

function firstValidIsbn(row, ...names) {
  const byNorm = new Map(Object.entries(row).map(([k, v]) => [norm(k), v]));
  for (const name of names) {
    const isbn = cleanIsbn(byNorm.get(name));
    if (isbn) return isbn;
  }
  return null;
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
    isbn: firstValidIsbn(r, 'isbn13', 'isbn 13', 'isbn', 'isbn10', 'isbn 10'),
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

// Evita fundir volumes distintos como "Coleção: Volume I" e "Coleção: Volume II",
// mas casa "Duna" com "Duna: Livro 1" quando apenas um dos dois tem subtítulo.
function sameTitle(a, b) {
  const na = titleKey(a);
  const nb = titleKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const pa = titleKey(String(a).split(/[:(]/)[0]);
  const pb = titleKey(String(b).split(/[:(]/)[0]);
  if (!pa || pa !== pb) return false;
  return na === pa || nb === pb;
}

const titlePrefixKey = (title) => titleKey(String(title || '').split(/[:(]/)[0]) || titleKey(title);

function createBookIndex() {
  const byIsbn = new Map();
  const byPrefix = new Map();
  const add = (row) => {
    if (row.isbn && !byIsbn.has(row.isbn)) byIsbn.set(row.isbn, row);
    const key = titlePrefixKey(row.title);
    if (!key) return;
    const list = byPrefix.get(key) || [];
    list.push(row);
    byPrefix.set(key, list);
  };
  for (const row of db.prepare('SELECT id, title, authors, isbn FROM books').all()) add(row);
  const find = (item) => {
    if (item.isbn && byIsbn.has(item.isbn)) return byIsbn.get(item.isbn).id;
    const key = titlePrefixKey(item.title);
    if (!key) return null;
    const author = titleKey(item.authors?.[0] || '');
    const candidates = byPrefix.get(key) || [];
    return candidates.find((c) => {
      if (item.isbn && c.isbn && item.isbn !== c.isbn) return false;
      const firstAuthor = titleKey((Array.isArray(c.authors) ? c.authors : JSON.parse(c.authors || '[]'))[0] || '');
      return sameTitle(c.title, item.title) && firstAuthor === author;
    })?.id ?? null;
  };
  return { add, find };
}

function sameLogContent(existing, incoming) {
  return (existing.finished_on ?? null) === (incoming.finished_on ?? null)
    && (existing.started_on ?? null) === (incoming.started_on ?? null)
    && (existing.rating ?? null) === (incoming.rating ?? null)
    && (existing.review ?? null) === (incoming.review ?? null)
    && Boolean(existing.reread) === Boolean(incoming.reread)
    && (existing.format ?? null) === (incoming.format ?? null);
}

export function importCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new HttpError(400, 'O arquivo está vazio.');
  const { name, map } = detectFormat(rows);
  const result = { format: name, total: rows.length, books_added: 0, logs_added: 0, skipped: 0 };

  transaction(() => {
    const bookIndex = createBookIndex();
    // Snapshot dos logs anteriores à importação para fazer matching por import_key ou multiplicidade
    // (preserva edições locais em registros importados, releituras sem data e logs manuais).
    const preexistingLogsByBook = new Map();
    for (const row of db.prepare('SELECT id, book_id, finished_on, started_on, rating, review, reread, format, import_key FROM logs').all()) {
      const list = preexistingLogsByBook.get(row.book_id) || [];
      list.push(row);
      preexistingLogsByBook.set(row.book_id, list);
    }
    const usedLogIds = new Set();
    const keyOccurrences = new Map();

    for (const row of rows) {
      const item = map(row);
      const title = item.title?.trim().slice(0, 300);
      if (!title) { result.skipped++; continue; }
      const authors = (item.authors || []).map((a) => a.trim().slice(0, 120)).filter(Boolean);
      const review = item.review ? item.review.trim().slice(0, 20_000) : null;
      const finishedOn = item.finished_on;
      const startedOn = item.started_on && (!finishedOn || item.started_on <= finishedOn) ? item.started_on : null;
      const hasLog = Boolean(
        item.status === 'read' || finishedOn || item.rating || review
        || (name === 'Orelha (CSV)' && (item.reread || item.format)),
      );
      const effectiveStatus = item.status || (hasLog ? 'read' : null);

      let bookId = bookIndex.find({ title, authors, isbn: item.isbn });
      if (!bookId) {
        bookId = `b_${randomUUID().slice(0, 12)}`;
        db.prepare(`INSERT INTO books (id, title, authors, year, pages, isbn, cover_isbn, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'import')`)
          .run(bookId, title, JSON.stringify(authors), item.year, item.pages, item.isbn, item.isbn);
        bookIndex.add({ id: bookId, title, authors, isbn: item.isbn });
        result.books_added++;
      }
      db.prepare('INSERT INTO shelf (book_id) VALUES (?) ON CONFLICT(book_id) DO NOTHING').run(bookId);
      if (effectiveStatus || item.liked) {
        // Quando a linha tem um registro de diário, startedOn pertence a esse registro e não à leitura em andamento.
        const shelfStartedOn = effectiveStatus === 'reading'
          ? ((!hasLog && startedOn) || new Date().toLocaleDateString('en-CA'))
          : null;
        db.prepare(`UPDATE shelf SET
            status = COALESCE(status, ?),
            liked = MAX(liked, ?),
            started_on = CASE WHEN COALESCE(status, ?) = 'reading' THEN COALESCE(started_on, ?) ELSE started_on END
          WHERE book_id = ?`)
          .run(effectiveStatus, item.liked ? 1 : 0, effectiveStatus, shelfStartedOn, bookId);
        if (effectiveStatus === 'dropped') {
          const curStatus = db.prepare('SELECT status FROM shelf WHERE book_id = ?').get(bookId)?.status;
          if (curStatus === 'dropped' && !db.prepare('SELECT 1 FROM drops WHERE book_id = ? LIMIT 1').get(bookId)) {
            db.prepare('INSERT INTO drops (book_id, dropped_on) VALUES (?, NULL)').run(bookId);
          }
        }
      }
      if (hasLog) {
        const incoming = {
          finished_on: finishedOn,
          started_on: startedOn,
          rating: item.rating,
          review,
          reread: item.reread ? 1 : 0,
          format: item.format ?? null,
        };
        const legacyKey = createHash('sha1').update(`${norm(title)}|${norm(authors[0] || '')}|${finishedOn || ''}`).digest('hex');
        // Leituras sem data incluem traços que distinguem ocorrências vindas de arquivos diferentes
        // (sem incluir a nota, para preservar edições de estrelas feitas no Orelha).
        const baseKey = finishedOn
          ? legacyKey
          : createHash('sha1').update(`${legacyKey}|${startedOn || ''}|${incoming.reread}|${incoming.format || ''}|${norm(review || '')}`).digest('hex');
        // Conta ocorrências por livro para que a presença de outra edição no CSV não altere a chave.
        const occKey = `${bookId}|${baseKey}`;
        const occ = (keyOccurrences.get(occKey) || 0) + 1;
        keyOccurrences.set(occKey, occ);
        const importKey = occ === 1 ? baseKey : createHash('sha1').update(`${baseKey}#${occ}`).digest('hex');
        // Chave estável por edição: usada quando outra edição já ocupa importKey na tabela logs.
        const scopedKey = createHash('sha1').update(`${bookId}|${importKey}`).digest('hex');

        const candidates = preexistingLogsByBook.get(bookId) || [];
        const match = candidates.find((c) => !usedLogIds.has(c.id) && (c.import_key === importKey || c.import_key === scopedKey))
          || (occ === 1 && !finishedOn
            ? candidates.find((c) => !usedLogIds.has(c.id) && c.import_key === legacyKey && Boolean(c.reread) === Boolean(incoming.reread))
            : null)
          || candidates.find((c) => !usedLogIds.has(c.id) && sameLogContent(c, incoming));
        if (match) {
          usedLogIds.add(match.id);
        } else {
          const keyTaken = (k) => !!db.prepare('SELECT 1 FROM logs WHERE import_key = ?').get(k);
          const safeKey = !keyTaken(importKey) ? importKey : !keyTaken(scopedKey) ? scopedKey : null;
          db.prepare(`INSERT INTO logs (book_id, finished_on, started_on, rating, review, spoilers, reread, format, import_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(bookId, incoming.finished_on, incoming.started_on, incoming.rating, incoming.review, item.spoilers ? 1 : 0, incoming.reread, incoming.format, safeKey);
          result.logs_added++;
        }
      }
    }
  });
  enrichImported();
  return result;
}

const VALID_STATUS = new Set(['want', 'reading', 'read', 'dropped']);
const VALID_FORMAT = new Set(['paper', 'ebook', 'audio']);
const VALID_COVER_FILE = /^up-[0-9a-f-]+\.(jpg|png|webp)$/;
const VALID_BOOK_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

function parseJsonArray(v, { maxItem = 120, maxLen = Infinity } = {}) {
  const clean = (arr) => arr.map((x) => String(x ?? '').trim().slice(0, maxItem)).filter(Boolean).slice(0, maxLen);
  if (Array.isArray(v)) return clean(v);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return clean(parsed);
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

function safeBookId(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return VALID_BOOK_ID.test(s) ? s : null;
}

function listKey(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80);
  return null;
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
    // Snapshots do banco antes da importação: garante que registros distintos no mesmo backup
    // nunca colidam entre si, enquanto uma segunda importação do mesmo backup é 100% idempotente.
    const preexistingBooks = db.prepare('SELECT * FROM books').all();
    const preexistingBooksById = new Map(preexistingBooks.map((b) => [b.id, b]));
    const preexistingBooksByOl = new Map(preexistingBooks.filter((b) => b.ol_key).map((b) => [b.ol_key, b]));
    const preexistingBooksByIsbn = new Map(preexistingBooks.filter((b) => b.isbn).map((b) => [b.isbn, b]));
    const backupIds = new Set(data.books.map((b) => safeBookId(b?.id)).filter(Boolean));
    const backupOlKeys = new Set(
      data.books.map((b) => (typeof b?.ol_key === 'string' && b.ol_key.trim() ? b.ol_key.trim().slice(0, 40) : null)).filter(Boolean),
    );
    const usedTargetBookIds = new Set();
    const bookIdMap = new Map();

    const preexistingLogs = db.prepare('SELECT * FROM logs').all();
    const usedLogIds = new Set();
    const preexistingDrops = db.prepare('SELECT * FROM drops').all();
    const usedDropIds = new Set();
    const preexistingProgress = db.prepare('SELECT * FROM progress').all();
    const usedProgressIds = new Set();
    const preexistingQuotes = db.prepare('SELECT * FROM quotes').all();
    const usedQuoteIds = new Set();
    const preexistingLists = db.prepare('SELECT * FROM lists').all();
    const usedListIds = new Set();

    for (const raw of data.books) {
      if (!raw || typeof raw !== 'object' || !String(raw.title || '').trim()) {
        result.skipped++;
        continue;
      }
      const title = String(raw.title).trim().slice(0, 300);
      const authors = parseJsonArray(raw.authors, { maxItem: 120 });
      const subjects = parseJsonArray(raw.subjects, { maxItem: 60, maxLen: 24 });
      const isbn = cleanIsbn(raw.isbn);
      const olKey = typeof raw.ol_key === 'string' && raw.ol_key.trim() ? raw.ol_key.trim().slice(0, 40) : null;
      const oldId = safeBookId(raw.id);
      const subtitle = raw.subtitle ? String(raw.subtitle).trim().slice(0, 300) : null;
      const originalTitle = raw.original_title ? String(raw.original_title).trim().slice(0, 300) : null;
      const year = safeInt(raw.year);
      const pages = safeInt(raw.pages, { min: 1 });
      const coverId = safeInt(raw.cover_id, { min: 1 });
      const coverIsbn = cleanIsbn(raw.cover_isbn) || isbn;
      const coverFile = safeCoverFile(raw.cover_file);
      const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : null;
      const description = raw.description ? String(raw.description).trim().slice(0, 10_000) : null;
      const userEdited = raw.user_edited ? 1 : 0;
      const detailsAt = typeof raw.details_at === 'string' ? raw.details_at.trim().slice(0, 40) : null;
      const createdAt = safeTimestamp(raw.created_at);

      // Só casa contra livros preexistentes ainda não reivindicados e que não pertençam (por ID/ol_key) a outro item do backup.
      let existing = null;
      const takeIfFree = (row, { allowReservedId = false, allowReservedOl = false } = {}) => {
        if (!row || usedTargetBookIds.has(row.id)) return null;
        if (!allowReservedId && backupIds.has(row.id) && row.id !== oldId) return null;
        if (!allowReservedOl && row.ol_key && backupOlKeys.has(row.ol_key) && row.ol_key !== olKey) return null;
        return row;
      };
      if (oldId) existing = takeIfFree(preexistingBooksById.get(oldId), { allowReservedId: true, allowReservedOl: true });
      if (!existing && olKey) existing = takeIfFree(preexistingBooksByOl.get(olKey), { allowReservedOl: true });
      if (!existing && isbn) existing = takeIfFree(preexistingBooksByIsbn.get(isbn));
      if (!existing) {
        const firstAuthor = titleKey(authors[0] || '');
        existing = preexistingBooks.find((c) => {
          if (!takeIfFree(c)) return false;
          if (isbn && c.isbn && isbn !== c.isbn) return false;
          return sameTitle(c.title, title) && titleKey(JSON.parse(c.authors || '[]')[0] || '') === firstAuthor;
        }) || null;
      }

      if (existing) {
        usedTargetBookIds.add(existing.id);
        if (oldId) bookIdMap.set(oldId, existing.id);
        if (existing.user_edited) {
          // Preserva todas as edições locais (inclusive campos limpos de propósito).
          if (coverFile && !existing.cover_file) {
            db.prepare('UPDATE books SET cover_file = ? WHERE id = ?').run(coverFile, existing.id);
          }
        } else if (userEdited) {
          // O banco local tinha apenas cache do catálogo; aplica a edição real do backup.
          db.prepare(`UPDATE books SET
              title = ?, title_is_pt = ?, original_title = COALESCE(?, original_title), subtitle = ?,
              authors = ?, year = ?, pages = ?, isbn = ?,
              cover_id = COALESCE(cover_id, ?), cover_isbn = ?,
              cover_file = COALESCE(cover_file, ?), color = COALESCE(?, color),
              description = ?, subjects = ?, user_edited = 1, details_at = COALESCE(?, details_at)
            WHERE id = ?`)
            .run(
              title, raw.title_is_pt ? 1 : 0, originalTitle, subtitle,
              JSON.stringify(authors), year, pages, isbn,
              coverId, coverIsbn, coverFile, color,
              description, JSON.stringify(subjects), detailsAt,
              existing.id,
            );
        } else {
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
            .run(subtitle, year, pages, isbn, coverId, coverIsbn, coverFile, color, description, JSON.stringify(subjects), existing.id);
        }
        continue;
      }

      const idTaken = oldId && db.prepare('SELECT 1 FROM books WHERE id = ?').get(oldId);
      const newId = oldId && !idTaken ? oldId : `b_${randomUUID().slice(0, 12)}`;
      const safeOlKey = olKey && !db.prepare('SELECT 1 FROM books WHERE ol_key = ?').get(olKey) ? olKey : null;
      const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim().slice(0, 40) : 'import';
      db.prepare(`INSERT INTO books (
          id, ol_key, title, title_is_pt, original_title, subtitle, authors, year, pages,
          isbn, cover_id, cover_isbn, cover_file, color, description, subjects, source, user_edited, details_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`)
        .run(
          newId, safeOlKey, title, raw.title_is_pt ? 1 : 0, originalTitle, subtitle,
          JSON.stringify(authors), year, pages, isbn, coverId, coverIsbn, coverFile, color,
          description, JSON.stringify(subjects), source, userEdited, detailsAt, createdAt,
        );
      usedTargetBookIds.add(newId);
      if (oldId) bookIdMap.set(oldId, newId);
      result.books_added++;
      if (source === 'import' && !safeOlKey && !detailsAt && !userEdited) needsEnrich = true;
    }

    const hasDrops = Array.isArray(data.drops);
    const shelfFallbackDrops = [];
    for (const s of Array.isArray(data.shelf) ? data.shelf : []) {
      const bookId = bookIdMap.get(safeBookId(s?.book_id));
      if (!bookId) { result.skipped++; continue; }
      const status = VALID_STATUS.has(s.status) ? s.status : null;
      const liked = s.liked ? 1 : 0;
      const currentPage = safeInt(s.current_page);
      const startedOn = normalizeDate(s.started_on);
      const demo = s.demo ? 1 : 0;
      const updatedAt = safeTimestamp(s.updated_at);
      const cur = db.prepare('SELECT * FROM shelf WHERE book_id = ?').get(bookId);
      if (!cur) {
        const allowRunning = status === 'reading' || status === 'dropped';
        db.prepare(`INSERT INTO shelf (book_id, status, liked, current_page, started_on, demo, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`)
          .run(bookId, status, liked, allowRunning ? currentPage : null, allowRunning ? startedOn : null, demo, updatedAt);
      } else {
        const finalStatus = cur.status ?? status;
        const allowRunning = finalStatus === 'reading' || finalStatus === 'dropped';
        db.prepare(`UPDATE shelf SET
            status = ?,
            liked = MAX(liked, ?),
            current_page = CASE WHEN ? THEN COALESCE(current_page, ?) ELSE current_page END,
            started_on = CASE WHEN ? THEN COALESCE(started_on, ?) ELSE started_on END
          WHERE book_id = ?`)
          .run(finalStatus, liked, allowRunning ? 1 : 0, currentPage, allowRunning ? 1 : 0, startedOn, bookId);
      }
      // Backups sem a coleção `drops` (formato anterior com `shelf[].dropped_on` ou legados sem data).
      if (!hasDrops) {
        const shelfDroppedOn = normalizeDate(s.dropped_on);
        if (shelfDroppedOn) shelfFallbackDrops.push({ book_id: bookId, dropped_on: shelfDroppedOn, demo });
        else if (status === 'dropped') shelfFallbackDrops.push({ book_id: bookId, dropped_on: null, demo });
      }
    }

    for (const l of Array.isArray(data.logs) ? data.logs : []) {
      const bookId = bookIdMap.get(safeBookId(l?.book_id));
      if (!bookId) { result.skipped++; continue; }
      const finishedOn = normalizeDate(l.finished_on);
      const rawStarted = normalizeDate(l.started_on);
      const startedOn = rawStarted && (!finishedOn || rawStarted <= finishedOn) ? rawStarted : null;
      const rating = safeRating(l.rating);
      const review = l.review ? String(l.review).trim().slice(0, 20_000) : null;
      const spoilers = l.spoilers ? 1 : 0;
      const reread = l.reread ? 1 : 0;
      const format = VALID_FORMAT.has(l.format) ? l.format : null;
      const importKey = typeof l.import_key === 'string' && l.import_key.trim() ? l.import_key.trim().slice(0, 120) : null;
      const demo = l.demo ? 1 : 0;
      const createdAt = safeTimestamp(l.created_at);

      const match = preexistingLogs.find((c) => {
        if (usedLogIds.has(c.id) || c.book_id !== bookId) return false;
        if (importKey && c.import_key === importKey) return true;
        return (c.finished_on ?? null) === finishedOn
          && (c.started_on ?? null) === startedOn
          && (c.rating ?? null) === rating
          && (c.review ?? null) === review
          && Boolean(c.spoilers) === Boolean(spoilers)
          && Boolean(c.reread) === Boolean(reread)
          && (c.format ?? null) === format
          && (!createdAt || c.created_at === createdAt);
      });
      if (match) {
        usedLogIds.add(match.id);
        continue;
      }

      const safeKey = importKey && !db.prepare('SELECT 1 FROM logs WHERE import_key = ?').get(importKey) ? importKey : null;
      db.prepare(`INSERT INTO logs (book_id, finished_on, started_on, rating, review, spoilers, reread, format, import_key, demo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`)
        .run(bookId, finishedOn, startedOn, rating, review, spoilers, reread, format, safeKey, demo, createdAt);
      result.logs_added++;
    }

    const restoreDrop = (bookId, droppedOn, demo, createdAt) => {
      const match = preexistingDrops.find((c) => !usedDropIds.has(c.id)
        && c.book_id === bookId
        && (c.dropped_on ?? null) === droppedOn
        && (!createdAt || c.created_at === createdAt));
      if (match) {
        usedDropIds.add(match.id);
      } else {
        db.prepare(`INSERT INTO drops (book_id, dropped_on, demo, created_at)
          VALUES (?, ?, ?, COALESCE(?, datetime('now')))`).run(bookId, droppedOn, demo, createdAt);
      }
    };

    if (hasDrops) {
      for (const d of data.drops) {
        const bookId = bookIdMap.get(safeBookId(d?.book_id));
        const hasRawDate = d?.dropped_on !== null && d?.dropped_on !== undefined && String(d.dropped_on).trim() !== '';
        const droppedOn = hasRawDate ? normalizeDate(d.dropped_on) : null;
        if (!bookId || (hasRawDate && !droppedOn)) { result.skipped++; continue; }
        restoreDrop(bookId, droppedOn, d.demo ? 1 : 0, safeTimestamp(d.created_at));
      }
    } else {
      for (const d of shelfFallbackDrops) {
        restoreDrop(d.book_id, d.dropped_on, d.demo, null);
      }
    }

    for (const p of Array.isArray(data.progress) ? data.progress : []) {
      const bookId = bookIdMap.get(safeBookId(p?.book_id));
      const page = safeInt(p?.page);
      const onDay = normalizeDate(p?.on_day);
      if (!bookId || page === null || !onDay) { result.skipped++; continue; }
      const demo = p.demo ? 1 : 0;
      const match = preexistingProgress.find((c) => !usedProgressIds.has(c.id) && c.book_id === bookId && c.page === page && c.on_day === onDay);
      if (match) {
        usedProgressIds.add(match.id);
      } else {
        db.prepare('INSERT INTO progress (book_id, page, on_day, demo) VALUES (?, ?, ?, ?)').run(bookId, page, onDay, demo);
      }
    }

    for (const q of Array.isArray(data.quotes) ? data.quotes : []) {
      const bookId = bookIdMap.get(safeBookId(q?.book_id));
      const text = q?.text ? String(q.text).trim().slice(0, 5000) : '';
      const page = safeInt(q?.page);
      if (!bookId || !text) { result.skipped++; continue; }
      const demo = q.demo ? 1 : 0;
      const createdAt = safeTimestamp(q.created_at);
      const match = preexistingQuotes.find((c) => !usedQuoteIds.has(c.id) && c.book_id === bookId && c.text === text && (c.page ?? null) === page);
      if (match) {
        usedQuoteIds.add(match.id);
      } else {
        db.prepare(`INSERT INTO quotes (book_id, text, page, demo, created_at)
          VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`).run(bookId, text, page, demo, createdAt);
        result.quotes_added++;
      }
    }

    const listIdMap = new Map();
    const mergedListIds = new Set();
    const rawLists = Array.isArray(data.lists) ? data.lists : [];
    const preexistingListsById = new Map(preexistingLists.map((l) => [l.id, l]));
    const reservedListIds = new Set();
    const titleCounts = new Map();
    const sameListMeta = (a, b) => a.title.toLowerCase() === b.title.toLowerCase()
      && (a.description ?? null) === (b.description ?? null)
      && Boolean(a.ranked) === Boolean(b.ranked);

    for (const l of rawLists) {
      const t = l?.title ? String(l.title).trim().toLowerCase() : '';
      if (t) titleCounts.set(t, (titleCounts.get(t) || 0) + 1);
      const srcInt = safeInt(l?.id, { min: 1 });
      const surviving = srcInt ? preexistingListsById.get(srcInt) : null;
      if (surviving && t && sameListMeta(surviving, { title: t, description: l.description ? String(l.description).trim().slice(0, 1000) : null, ranked: l.ranked })) {
        reservedListIds.add(srcInt);
      }
    }

    for (const l of rawLists) {
      const title = l?.title ? String(l.title).trim().slice(0, 120) : '';
      if (!title) { result.skipped++; continue; }
      const desc = l.description ? String(l.description).trim().slice(0, 1000) : null;
      const ranked = l.ranked ? 1 : 0;
      const demo = l.demo ? 1 : 0;
      const createdAt = safeTimestamp(l.created_at);
      const srcKey = listKey(l.id);
      const srcInt = safeInt(l.id, { min: 1 });
      const meta = { title, description: desc, ranked };

      const takeListIfFree = (c, allowReserved = false) => {
        if (!c || usedListIds.has(c.id)) return null;
        if (!allowReserved && reservedListIds.has(c.id) && c.id !== srcInt) return null;
        return c;
      };

      let match = null;
      if (srcInt && reservedListIds.has(srcInt)) {
        match = takeListIfFree(preexistingListsById.get(srcInt), true);
      }
      if (!match) {
        match = preexistingLists.find((c) => takeListIfFree(c)
          && sameListMeta(c, meta)
          && (!createdAt || c.created_at === createdAt)) || null;
      }
      if (!match && (titleCounts.get(title.toLowerCase()) || 0) === 1) {
        match = preexistingLists.find((c) => takeListIfFree(c) && sameListMeta(c, meta)) || null;
      }

      if (match) {
        usedListIds.add(match.id);
        mergedListIds.add(match.id);
        if (srcKey !== null) listIdMap.set(srcKey, match.id);
      } else {
        const idFree = srcInt && !db.prepare('SELECT 1 FROM lists WHERE id = ?').get(srcInt);
        const { lastInsertRowid } = idFree
          ? db.prepare(`INSERT INTO lists (id, title, description, ranked, demo, created_at)
              VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`).run(srcInt, title, desc, ranked, demo, createdAt)
          : db.prepare(`INSERT INTO lists (title, description, ranked, demo, created_at)
              VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))`).run(title, desc, ranked, demo, createdAt);
        const newListId = Number(lastInsertRowid);
        usedListIds.add(newListId);
        if (srcKey !== null) listIdMap.set(srcKey, newListId);
        result.lists_added++;
      }
    }

    const nextPosByList = new Map();
    for (const listId of mergedListIds) {
      const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM list_items WHERE list_id = ?').get(listId).m;
      nextPosByList.set(listId, maxPos + 1);
    }

    const rawItems = Array.isArray(data.list_items) ? [...data.list_items] : [];
    rawItems.sort((a, b) => (safeInt(a?.position) ?? 0) - (safeInt(b?.position) ?? 0));
    for (const item of rawItems) {
      const srcList = listKey(item?.list_id);
      const listId = srcList !== null ? listIdMap.get(srcList) : null;
      const bookId = bookIdMap.get(safeBookId(item?.book_id));
      if (!listId || !bookId) { result.skipped++; continue; }
      let pos = safeInt(item.position) ?? 0;
      if (mergedListIds.has(listId)) {
        const exists = db.prepare('SELECT 1 FROM list_items WHERE list_id = ? AND book_id = ?').get(listId, bookId);
        if (exists) continue;
        pos = nextPosByList.get(listId);
        nextPosByList.set(listId, pos + 1);
      }
      db.prepare('INSERT INTO list_items (list_id, book_id, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
        .run(listId, bookId, pos);
    }

    for (const f of Array.isArray(data.favorites) ? data.favorites : []) {
      const slot = safeInt(f?.slot, { min: 1, max: 4 });
      const bookId = bookIdMap.get(safeBookId(f?.book_id));
      if (!slot || !bookId) { result.skipped++; continue; }
      const demo = f.demo ? 1 : 0;
      const slotTaken = db.prepare('SELECT 1 FROM favorites WHERE slot = ?').get(slot);
      const bookTaken = db.prepare('SELECT 1 FROM favorites WHERE book_id = ?').get(bookId);
      if (!slotTaken && !bookTaken) {
        db.prepare('INSERT INTO favorites (slot, book_id, demo) VALUES (?, ?, ?)').run(slot, bookId, demo);
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
        // Condiciona no SQL a user_edited = 0 para não sobrescrever edições feitas pelo leitor.
        db.prepare(`UPDATE books SET
            ol_key = ?,
            cover_id = COALESCE(cover_id, ?),
            pages = CASE WHEN user_edited = 0 THEN COALESCE(pages, ?) ELSE pages END,
            year = CASE WHEN user_edited = 0 THEN COALESCE(year, ?) ELSE year END,
            isbn = CASE WHEN user_edited = 0 THEN COALESCE(isbn, ?) ELSE isbn END,
            subjects = CASE WHEN user_edited = 0 AND subjects = '[]' THEN ? ELSE subjects END,
            details_at = ?
          WHERE id = ?`)
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
