// Regras de domínio: livros, estante, diário, trechos, listas e números.
import { randomUUID } from 'node:crypto';
import { db, getSetting, setSetting, transaction } from './db.js';
import * as ol from './openlibrary.js';
import * as rec from './recommend.js';
import { dailyQuote } from './quotations.js';

export class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Data local do Mac (en-CA formata como AAAA-MM-DD), não UTC: à noite no Brasil o UTC já é amanhã.
const today = () => new Date().toLocaleDateString('en-CA');

export function presentBook(row) {
  if (!row) return null;
  const { cover_file, cover_id, cover_isbn } = row;
  let cover = null;
  if (cover_file) cover = `/covers/file/${cover_file}`;
  else if (cover_id) cover = `/covers/id/${cover_id}`;
  else if (cover_isbn || row.isbn) cover = `/covers/isbn/${cover_isbn || row.isbn}`;
  return {
    id: row.id,
    ol_key: row.ol_key,
    title: row.title,
    original_title: row.original_title,
    subtitle: row.subtitle,
    authors: JSON.parse(row.authors || '[]'),
    year: row.year,
    pages: row.pages,
    isbn: row.isbn,
    color: row.color,
    cover,
    source: row.source,
    ...(row.status !== undefined ? {
      status: row.status,
      liked: !!row.liked,
      current_page: row.current_page,
      started_on: row.started_on,
    } : {}),
    ...(row.my_rating !== undefined ? { rating: row.my_rating } : {}),
    ...(row.last_finished !== undefined ? { last_finished: row.last_finished } : {}),
  };
}

// Colunas extras usadas em toda listagem: estado da estante + última nota.
const BOOK_SELECT = `
  SELECT b.*, s.status, s.liked, s.current_page, s.started_on,
    (SELECT rating FROM logs l WHERE l.book_id = b.id AND l.rating IS NOT NULL
      ORDER BY COALESCE(l.finished_on, l.created_at) DESC, l.id DESC LIMIT 1) AS my_rating,
    (SELECT MAX(finished_on) FROM logs l WHERE l.book_id = b.id) AS last_finished
  FROM books b LEFT JOIN shelf s ON s.book_id = b.id`;

export function getBookRow(id) {
  return db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(id);
}

function requireBook(id) {
  const row = getBookRow(id);
  if (!row) throw new HttpError(404, 'Livro não encontrado.');
  return row;
}

// Guarda metadados vindos de fora sem pisar em edições do usuário.
export function upsertFromOl(doc) {
  if (!doc.ol_key) {
    const existing = doc.isbn && db.prepare('SELECT id FROM books WHERE isbn = ?').get(doc.isbn);
    if (existing) return existing.id;
    const id = `b_${randomUUID().slice(0, 12)}`;
    db.prepare(`INSERT INTO books (id, title, title_is_pt, subtitle, authors, year, pages, isbn, cover_isbn, description, subjects, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, doc.title, doc.title_is_pt || 0, doc.subtitle ?? null, JSON.stringify(doc.authors || []), doc.year ?? null,
        doc.pages ?? null, doc.isbn ?? null, doc.cover_isbn ?? null, doc.description ?? null,
        JSON.stringify(doc.subjects || []), doc.source || 'brasilapi');
    return id;
  }
  const existing = db.prepare('SELECT * FROM books WHERE ol_key = ?').get(doc.ol_key);
  if (!existing) {
    db.prepare(`INSERT INTO books (id, ol_key, title, title_is_pt, original_title, subtitle, authors, year, pages, isbn, cover_id, subjects)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(doc.ol_key, doc.ol_key, doc.title, doc.title_is_pt, doc.original_title, doc.subtitle,
        JSON.stringify(doc.authors), doc.year, doc.pages, doc.isbn, doc.cover_id, JSON.stringify(doc.subjects));
    return doc.ol_key;
  }
  if (!existing.user_edited) {
    // Título só muda se o novo é em português; um resultado sem edição pt não desfaz uma tradução.
    const usePt = doc.title_is_pt && !existing.title_is_pt;
    db.prepare(`UPDATE books SET
        title = ?, title_is_pt = ?, original_title = ?,
        pages = COALESCE(pages, ?), year = COALESCE(year, ?), isbn = COALESCE(isbn, ?),
        cover_id = CASE WHEN ? THEN COALESCE(?, cover_id) ELSE COALESCE(cover_id, ?) END
      WHERE id = ?`)
      .run(usePt ? doc.title : existing.title, usePt ? 1 : existing.title_is_pt,
        usePt ? doc.original_title : existing.original_title,
        doc.pages, doc.year, doc.isbn, usePt ? 1 : 0, doc.cover_id, doc.cover_id, existing.id);
  }
  return existing.id;
}

function presentDocs(docs, { excludeId } = {}) {
  const out = [];
  for (const doc of docs) {
    const id = upsertFromOl(doc);
    if (id === excludeId) continue;
    const row = getBookRow(id);
    out.push(presentBook(row));
  }
  return out;
}

export async function search(q) {
  if (!q?.trim()) return [];
  const docs = await ol.searchBooks(q);
  const results = transaction(() => presentDocs(docs));
  // O que já está na sua estante também aparece mesmo sem cadastro na Open Library.
  const local = db.prepare(`${BOOK_SELECT} WHERE b.source != 'openlibrary' AND b.title LIKE ? LIMIT 5`).all(`%${q.trim()}%`);
  const seen = new Set(results.map((b) => b.id));
  return [...local.filter((r) => !seen.has(r.id)).map(presentBook), ...results];
}

// ---- Página do livro ----

async function ensureDetails(id) {
  let row = getBookRow(id);
  if (!row && /^OL\d+W$/.test(id)) {
    const doc = await ol.fetchWorkDoc(id);
    if (!doc) throw new HttpError(404, 'Livro não encontrado.');
    upsertFromOl(doc);
    row = getBookRow(id);
  }
  if (!row) throw new HttpError(404, 'Livro não encontrado.');
  if (row.ol_key && !row.details_at) {
    const details = await ol.workDetails(row.ol_key).catch(() => null);
    if (details) {
      // Condiciona no SQL ao valor atual de user_edited: evita race se o leitor editou durante o fetch.
      db.prepare(`UPDATE books SET
          description = CASE WHEN user_edited = 0 THEN COALESCE(description, ?) ELSE description END,
          subjects = CASE WHEN user_edited = 0 AND subjects = '[]' THEN ? ELSE subjects END,
          cover_id = COALESCE(cover_id, ?),
          details_at = datetime('now')
        WHERE id = ?`)
        .run(details.description, JSON.stringify(details.subjects), details.cover_id, id);
      row = getBookRow(id);
    }
  }
  return row;
}

export async function bookPage(id) {
  const row = await ensureDetails(id);
  const community = row.ol_key ? await ol.communityData(row.ol_key).catch(() => null) : null;
  const subjects = JSON.parse(row.subjects || '[]');
  return {
    book: {
      ...presentBook(row),
      description: row.description,
      subjects,
      genres: rec.genresOf(subjects),
      subject_genres: subjects.map((s) => rec.genresOf([s])),
      other_subjects: rec.otherSubjectsOf(subjects),
    },
    community,
    logs: db.prepare('SELECT * FROM logs WHERE book_id = ? ORDER BY COALESCE(finished_on, created_at) DESC, id DESC').all(id).map(presentLog),
    quotes: db.prepare('SELECT * FROM quotes WHERE book_id = ? ORDER BY COALESCE(page, 999999), id').all(id),
    lists: db.prepare('SELECT l.id, l.title FROM lists l JOIN list_items i ON i.list_id = l.id WHERE i.book_id = ?').all(id),
    favorite_slot: db.prepare('SELECT slot FROM favorites WHERE book_id = ?').get(id)?.slot ?? null,
  };
}

export async function relatedRails(id) {
  const row = requireBook(id);
  const book = { title: row.title, original_title: row.original_title };
  const author = JSON.parse(row.authors || '[]')[0];
  const genres = rec.genresOf(JSON.parse(row.subjects || '[]')).slice(0, 3);
  const quoted = (text) => `"${text.replace(/"/g, '')}"`;
  const [authorPt, ...genrePools] = await Promise.allSettled([
    author ? ol.popularInPortuguese(`author:${quoted(author)}`, 40) : [],
    ...genres.map((g) => ol.popularInPortuguese(`subject:${quoted(rec.genre(g).query)}`)),
  ]);
  const value = (result) => (result.status === 'fulfilled' ? result.value : []);

  let authorDocs = author ? rec.authorRail(value(authorPt), { author, book }) : [];
  if (author && authorDocs.length < 3) {
    // Autor sem tradução: melhor mostrar a obra no original do que nada.
    const any = await ol.byAuthor(author).catch(() => []);
    authorDocs = rec.authorRail(any, { author, book, ptOnly: false });
  }

  const books = shelfBooks();
  // O autor já tem a seleção dele: as de gênero mostram outras pessoas.
  const ctx = { shelf: rec.shelfIndex(books), taste: rec.tasteProfile(books), seen: new Set(authorDocs.map((d) => d.ol_key)) };
  const others = (docs) => docs.filter((d) => !rec.sameAuthor(d.authors?.[0], author));
  // Os parecidos escolhem primeiro: precisam bater em dois gêneros do livro, então são os mais próximos.
  const similar = genres.length >= 2
    ? rec.rankRail(others(genrePools.flatMap(value)), { ...ctx, seedGenres: genres, minSeedMatch: 2, minLog: 10 })
    : [];
  const sameGenre = genres.length
    ? rec.rankRail(others(value(genrePools[0])), { ...ctx, seedGenres: [genres[0]], perAuthor: 2, requireSeedGenre: true })
    : [];

  return transaction(() => {
    const rails = [];
    const add = (title, docs) => {
      const presented = presentDocs(docs, { excludeId: id });
      if (presented.length >= 3) rails.push({ title, books: presented });
    };
    if (author) add(`Mais de ${author}`, authorDocs);
    if (genres.length) add(`Prateleira de ${rec.genre(genres[0]).label.toLowerCase()}`, sameGenre);
    add('Parecidos com este livro', similar);
    return rails;
  });
}

const clampText = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const asInt = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
};
const asDate = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, 'Data inválida.');
  return v;
};
const asIsbn = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const compact = String(v).replace(/[-\s]/g, '').toUpperCase();
  if (!/^(97[89]\d{10}|\d{9}[\dX])$/.test(compact)) throw new HttpError(400, 'ISBN inválido. Informe 10 ou 13 dígitos.');
  return compact;
};
const asSubjects = (v) => {
  if (v === undefined || v === null) return [];
  const raw = Array.isArray(v) ? v : String(v).split(/[,;]/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const text = String(item ?? '').trim().slice(0, 60);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === 24) break;
  }
  return out;
};

export function listGenres() {
  return rec.GENRES.map(({ id, label }) => ({ id, label }));
}

export function createManualBook(body) {
  const title = clampText(body.title, 300);
  if (!title) throw new HttpError(400, 'O título é obrigatório.');
  const id = `m_${randomUUID().slice(0, 12)}`;
  const authors = String(body.authors || '').split(/[,;]/).map((a) => a.trim()).filter(Boolean);
  const isbn = asIsbn(body.isbn);
  const description = clampText(body.description, 10_000);
  const subjects = asSubjects(body.subjects);
  db.prepare(`INSERT INTO books (id, title, title_is_pt, authors, year, pages, isbn, cover_isbn, description, subjects, source, user_edited)
              VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'manual', 1)`)
    .run(id, title, JSON.stringify(authors), asInt(body.year), asInt(body.pages), isbn, isbn, description, JSON.stringify(subjects));
  return presentBook(getBookRow(id));
}

export function updateBook(id, body) {
  const existing = requireBook(id);
  const color = body.color !== undefined ? body.color : undefined;
  if (color !== undefined && !/^#[0-9a-f]{6}$/i.test(color)) throw new HttpError(400, 'Cor inválida.');
  const title = body.title !== undefined ? clampText(body.title, 300) : undefined;
  if (body.title !== undefined && !title) throw new HttpError(400, 'O título é obrigatório.');
  const authors = body.authors !== undefined
    ? (Array.isArray(body.authors)
      ? body.authors.map((a) => String(a).trim()).filter(Boolean)
      : String(body.authors).split(/[,;]/).map((a) => a.trim()).filter(Boolean))
    : undefined;
  const pages = body.pages !== undefined ? asInt(body.pages) : undefined;
  const year = body.year !== undefined ? asInt(body.year) : undefined;
  const isbn = body.isbn !== undefined ? asIsbn(body.isbn) : undefined;
  const description = body.description !== undefined ? clampText(body.description, 10_000) : undefined;
  const subjects = body.subjects !== undefined ? asSubjects(body.subjects) : undefined;

  return transaction(() => {
    if (color !== undefined) db.prepare('UPDATE books SET color = ? WHERE id = ?').run(color, id);
    if (title !== undefined) db.prepare('UPDATE books SET title = ?, user_edited = 1 WHERE id = ?').run(title, id);
    if (authors !== undefined) db.prepare('UPDATE books SET authors = ?, user_edited = 1 WHERE id = ?').run(JSON.stringify(authors), id);
    if (pages !== undefined) db.prepare('UPDATE books SET pages = ?, user_edited = 1 WHERE id = ?').run(pages, id);
    if (year !== undefined) db.prepare('UPDATE books SET year = ?, user_edited = 1 WHERE id = ?').run(year, id);
    if (isbn !== undefined) {
      const resetColor = !existing.cover_id && !existing.cover_file && existing.cover_isbn !== isbn;
      db.prepare(`UPDATE books SET isbn = ?,
        cover_isbn = CASE WHEN cover_id IS NULL AND cover_file IS NULL THEN ? ELSE cover_isbn END,
        color = CASE WHEN ? THEN NULL ELSE color END,
        user_edited = 1 WHERE id = ?`).run(isbn, isbn, resetColor ? 1 : 0, id);
    }
    if (description !== undefined) db.prepare('UPDATE books SET description = ?, user_edited = 1 WHERE id = ?').run(description, id);
    if (subjects !== undefined) db.prepare('UPDATE books SET subjects = ?, user_edited = 1 WHERE id = ?').run(JSON.stringify(subjects), id);
    return presentBook(getBookRow(id));
  });
}

// ---- Estante ----

function ensureShelf(bookId) {
  db.prepare('INSERT INTO shelf (book_id) VALUES (?) ON CONFLICT(book_id) DO NOTHING').run(bookId);
}

// Preserva um abandono legado (status = 'dropped' sem linha em `drops`) antes de alterar o status na estante.
function preserveLegacyDrop(bookId, prevStatus) {
  if (prevStatus !== 'dropped') return;
  const hasDrop = db.prepare('SELECT 1 FROM drops WHERE book_id = ? LIMIT 1').get(bookId);
  if (!hasDrop) db.prepare('INSERT INTO drops (book_id, dropped_on, created_at) VALUES (?, NULL, NULL)').run(bookId);
}

function parseOpId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 128) {
    throw new HttpError(400, 'Identificador de sincronização inválido.');
  }
  return raw.trim();
}

function findSyncOp(opId, kind, bookId) {
  if (!opId) return null;
  const row = db.prepare('SELECT kind, book_id, response_json FROM sync_ops WHERE op_id = ?').get(opId);
  if (!row) return null;
  if (row.kind !== kind || row.book_id !== bookId) {
    throw new HttpError(409, 'Esta operação já foi usada para outro livro ou ação.', { code: 'op_mismatch' });
  }
  return JSON.parse(row.response_json);
}

// Uma resposta perdida é reenviada pela fila em minutos ou dias; 30 dias cobrem isso com folga
// sem deixar `sync_ops` crescer para sempre.
const SYNC_OPS_TTL_DAYS = 30;
const SYNC_OPS_PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastSyncOpsPrune = 0;

export function pruneSyncOps(days = SYNC_OPS_TTL_DAYS) {
  lastSyncOpsPrune = Date.now();
  return db.prepare(`DELETE FROM sync_ops WHERE created_at < datetime('now', ?)`).run(`-${days} days`).changes;
}

function saveSyncOp(opId, kind, bookId, response) {
  if (!opId) return;
  if (Date.now() - lastSyncOpsPrune > SYNC_OPS_PRUNE_EVERY_MS) pruneSyncOps();
  db.prepare('INSERT INTO sync_ops (op_id, kind, book_id, response_json) VALUES (?, ?, ?, ?)')
    .run(opId, kind, bookId, JSON.stringify(response));
}

function checkShelfConflict(bookRow, expected) {
  if (!expected || typeof expected !== 'object') return;
  const actualStatus = bookRow.status ?? null;
  const expStatus = expected.status === undefined ? actualStatus : (expected.status ?? null);
  const actualPage = bookRow.current_page ?? null;
  const expPage = expected.current_page === undefined ? actualPage : (expected.current_page ?? null);
  if (actualStatus !== expStatus || actualPage !== expPage) {
    throw new HttpError(409, 'Este livro foi alterado em outro aparelho antes da sincronização.', {
      code: 'conflict',
      current: presentBook(bookRow),
    });
  }
}

export function updateShelf(bookId, body) {
  const opId = parseOpId(body.op_id);
  const onDay = asDate(body.on_day);
  const VALID = ['want', 'reading', 'read', 'dropped', null];
  if (body.status !== undefined && !VALID.includes(body.status)) throw new HttpError(400, 'Status inválido.');
  const explicitStartedOn = body.started_on !== undefined ? asDate(body.started_on) : undefined;
  const explicitDroppedOn = body.dropped_on !== undefined ? asDate(body.dropped_on) : undefined;
  return transaction(() => {
    const replayed = findSyncOp(opId, 'shelf', bookId);
    if (replayed) return replayed;
    const existing = requireBook(bookId);
    checkShelfConflict(existing, body.expected);
    ensureShelf(bookId);
    const prev = db.prepare('SELECT status FROM shelf WHERE book_id = ?').get(bookId);
    if (body.status !== undefined) {
      if (body.status !== 'dropped') preserveLegacyDrop(bookId, prev.status);
      db.prepare(`UPDATE shelf SET status = ?, updated_at = datetime('now'),
        started_on = CASE WHEN ? = 'reading' THEN COALESCE(started_on, ?) WHEN ? IN ('want') OR ? IS NULL THEN NULL ELSE started_on END,
        current_page = CASE WHEN ? IN ('reading','dropped') THEN current_page ELSE NULL END
        WHERE book_id = ?`).run(body.status, body.status, onDay || today(), body.status, body.status, body.status, bookId);
      // Registra o evento apenas ao entrar em `dropped`; repetir o mesmo status não duplica nem data legados.
      if (body.status === 'dropped' && prev.status !== 'dropped') {
        db.prepare(`INSERT INTO drops (book_id, dropped_on, created_at) VALUES (?, ?, datetime('now'))`).run(bookId, explicitDroppedOn || onDay || today());
      }
    }
    if (body.liked !== undefined) {
      db.prepare(`UPDATE shelf SET liked = ?, updated_at = datetime('now') WHERE book_id = ?`).run(body.liked ? 1 : 0, bookId);
    }
    if (explicitStartedOn !== undefined) {
      db.prepare('UPDATE shelf SET started_on = ? WHERE book_id = ?').run(explicitStartedOn, bookId);
    }
    const result = presentBook(getBookRow(bookId));
    saveSyncOp(opId, 'shelf', bookId, result);
    return result;
  });
}

export function addProgress(bookId, body) {
  const opId = parseOpId(body.op_id);
  const page = asInt(body.page);
  if (page === null) throw new HttpError(400, 'Página inválida.');
  const day = asDate(body.on_day) || today();
  return transaction(() => {
    const replayed = findSyncOp(opId, 'progress', bookId);
    if (replayed) return replayed;
    const book = requireBook(bookId);
    if (book.pages && page > book.pages) throw new HttpError(400, `Este livro tem ${book.pages} páginas.`);
    checkShelfConflict(book, body.expected);
    ensureShelf(bookId);
    const prev = db.prepare('SELECT status FROM shelf WHERE book_id = ?').get(bookId);
    preserveLegacyDrop(bookId, prev?.status);
    db.prepare(`UPDATE shelf SET status = 'reading', current_page = ?, started_on = COALESCE(started_on, ?), updated_at = datetime('now') WHERE book_id = ?`)
      .run(page, day, bookId);
    db.prepare('INSERT INTO progress (book_id, page, on_day) VALUES (?, ?, ?)').run(bookId, page, day);
    const result = presentBook(getBookRow(bookId));
    saveSyncOp(opId, 'progress', bookId, result);
    return result;
  });
}

export function shelfList({ status, q }) {
  const where = ['(s.status IS NOT NULL OR EXISTS (SELECT 1 FROM logs l WHERE l.book_id = b.id))'];
  const args = [];
  if (status && status !== 'all') { where.push('s.status = ?'); args.push(status); }
  if (q) { where.push('(b.title LIKE ? OR b.authors LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  return db.prepare(`${BOOK_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY COALESCE((SELECT MAX(finished_on) FROM logs l WHERE l.book_id = b.id), s.updated_at, b.created_at) DESC`)
    // Os gêneros escolhem a tipografia da lombada.
    .all(...args).map((row) => ({ ...presentBook(row), genres: rec.genresOf(JSON.parse(row.subjects || '[]')) }));
}

// ---- Diário ----

function presentLog(row) {
  return {
    id: row.id, book_id: row.book_id, finished_on: row.finished_on, started_on: row.started_on,
    rating: row.rating, review: row.review, spoilers: !!row.spoilers, reread: !!row.reread,
    format: row.format, created_at: row.created_at,
  };
}

function logFields(body) {
  const rating = body.rating === null || body.rating === undefined || body.rating === '' ? null : Number(body.rating);
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 10)) throw new HttpError(400, 'Nota inválida.');
  const format = body.format || null;
  if (format && !['paper', 'ebook', 'audio'].includes(format)) throw new HttpError(400, 'Formato inválido.');
  const finished_on = asDate(body.finished_on);
  const started_on = asDate(body.started_on);
  if (started_on && finished_on && started_on > finished_on) throw new HttpError(400, 'O início não pode ser depois do fim.');
  return {
    finished_on, started_on, rating, format,
    review: clampText(body.review, 20_000),
    spoilers: body.spoilers ? 1 : 0,
    reread: body.reread ? 1 : 0,
  };
}

export function createLog(bookId, body) {
  const book = requireBook(bookId);
  const f = logFields(body);
  return transaction(() => {
    ensureShelf(bookId);
    const prev = db.prepare('SELECT status FROM shelf WHERE book_id = ?').get(bookId);
    preserveLegacyDrop(bookId, prev?.status);
    const started = f.started_on || book.started_on || null;
    const { lastInsertRowid } = db.prepare(`INSERT INTO logs (book_id, finished_on, started_on, rating, review, spoilers, reread, format)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(bookId, f.finished_on, started, f.rating, f.review, f.spoilers, f.reread, f.format);
    db.prepare(`UPDATE shelf SET status = 'read', current_page = NULL, started_on = NULL, liked = COALESCE(?, liked), updated_at = datetime('now') WHERE book_id = ?`)
      .run(body.liked === undefined ? null : (body.liked ? 1 : 0), bookId);
    return presentLog(db.prepare('SELECT * FROM logs WHERE id = ?').get(lastInsertRowid));
  });
}

export function updateLog(id, body) {
  const existing = db.prepare('SELECT * FROM logs WHERE id = ?').get(id);
  if (!existing) throw new HttpError(404, 'Registro não encontrado.');
  const f = logFields(body);
  return transaction(() => {
    db.prepare(`UPDATE logs SET finished_on = ?, started_on = ?, rating = ?, review = ?, spoilers = ?, reread = ?, format = ? WHERE id = ?`)
      .run(f.finished_on, f.started_on, f.rating, f.review, f.spoilers, f.reread, f.format, id);
    if (body.liked !== undefined) {
      ensureShelf(existing.book_id);
      db.prepare('UPDATE shelf SET liked = ? WHERE book_id = ?').run(body.liked ? 1 : 0, existing.book_id);
    }
    return presentLog(db.prepare('SELECT * FROM logs WHERE id = ?').get(id));
  });
}

export function deleteLog(id) {
  const existing = db.prepare('SELECT * FROM logs WHERE id = ?').get(id);
  if (!existing) throw new HttpError(404, 'Registro não encontrado.');
  transaction(() => {
    db.prepare('DELETE FROM logs WHERE id = ?').run(id);
    const left = db.prepare('SELECT COUNT(*) AS n FROM logs WHERE book_id = ?').get(existing.book_id).n;
    if (!left) db.prepare(`UPDATE shelf SET status = NULL WHERE book_id = ? AND status = 'read'`).run(existing.book_id);
  });
}

export function diary({ year }) {
  const rows = db.prepare(`SELECT l.*, l.id AS log_id FROM logs l
    WHERE l.finished_on IS NOT NULL ${year ? 'AND substr(l.finished_on, 1, 4) = ?' : ''}
    ORDER BY l.finished_on DESC, l.id DESC`).all(...(year ? [String(year)] : []));
  return {
    years: db.prepare(`SELECT DISTINCT substr(finished_on, 1, 4) AS y FROM logs WHERE finished_on IS NOT NULL ORDER BY y DESC`).all().map((r) => Number(r.y)),
    entries: rows.map((r) => ({ ...presentLog(r), book: presentBook(getBookRow(r.book_id)) })),
  };
}

// ---- Trechos ----

export function addQuote(bookId, body) {
  const opId = parseOpId(body.op_id);
  const text = clampText(body.text, 5000);
  if (!text) throw new HttpError(400, 'Escreva o trecho.');
  const page = asInt(body.page);
  return transaction(() => {
    const replayed = findSyncOp(opId, 'quote', bookId);
    if (replayed) return replayed;
    requireBook(bookId);
    const { lastInsertRowid } = db.prepare('INSERT INTO quotes (book_id, text, page) VALUES (?, ?, ?)').run(bookId, text, page);
    const result = db.prepare('SELECT * FROM quotes WHERE id = ?').get(lastInsertRowid);
    saveSyncOp(opId, 'quote', bookId, result);
    return result;
  });
}

export function deleteQuote(id) {
  db.prepare('DELETE FROM quotes WHERE id = ?').run(id);
}

export function allQuotes() {
  return db.prepare('SELECT * FROM quotes ORDER BY id DESC').all()
    .map((q) => ({ ...q, book: presentBook(getBookRow(q.book_id)) }));
}

// ---- Listas ----

export function allLists() {
  return db.prepare('SELECT l.*, (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS count FROM lists l ORDER BY l.id DESC').all()
    .map((l) => ({
      ...l,
      ranked: !!l.ranked,
      preview: db.prepare(`${BOOK_SELECT} JOIN list_items i ON i.book_id = b.id WHERE i.list_id = ? ORDER BY i.position LIMIT 5`).all(l.id).map(presentBook),
    }));
}

export function createList(body) {
  const title = clampText(body.title, 120);
  if (!title) throw new HttpError(400, 'Dê um nome à lista.');
  const { lastInsertRowid } = db.prepare('INSERT INTO lists (title, description, ranked) VALUES (?, ?, ?)')
    .run(title, clampText(body.description, 1000), body.ranked ? 1 : 0);
  return getList(lastInsertRowid);
}

export function getList(id) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
  if (!list) throw new HttpError(404, 'Lista não encontrada.');
  return {
    ...list,
    ranked: !!list.ranked,
    books: db.prepare(`${BOOK_SELECT} JOIN list_items i ON i.book_id = b.id WHERE i.list_id = ? ORDER BY i.position`).all(id).map(presentBook),
  };
}

export function updateList(id, body) {
  getList(id);
  if (body.title !== undefined) {
    const title = clampText(body.title, 120);
    if (!title) throw new HttpError(400, 'Dê um nome à lista.');
    db.prepare('UPDATE lists SET title = ? WHERE id = ?').run(title, id);
  }
  if (body.description !== undefined) db.prepare('UPDATE lists SET description = ? WHERE id = ?').run(clampText(body.description, 1000), id);
  if (body.ranked !== undefined) db.prepare('UPDATE lists SET ranked = ? WHERE id = ?').run(body.ranked ? 1 : 0, id);
  if (Array.isArray(body.order)) {
    transaction(() => body.order.forEach((bookId, i) =>
      db.prepare('UPDATE list_items SET position = ? WHERE list_id = ? AND book_id = ?').run(i, id, String(bookId))));
  }
  return getList(id);
}

export function deleteList(id) {
  db.prepare('DELETE FROM lists WHERE id = ?').run(id);
}

export function addListItem(listId, bookId) {
  getList(listId);
  requireBook(bookId);
  const next = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM list_items WHERE list_id = ?').get(listId).n;
  db.prepare('INSERT INTO list_items (list_id, book_id, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(listId, bookId, next);
  return getList(listId);
}

export function removeListItem(listId, bookId) {
  db.prepare('DELETE FROM list_items WHERE list_id = ? AND book_id = ?').run(listId, bookId);
  return getList(listId);
}

// ---- Perfil, início, descoberta ----

export function setFavorite(slot, bookId) {
  if (![1, 2, 3, 4].includes(slot)) throw new HttpError(400, 'Espaço inválido.');
  transaction(() => {
    if (bookId) {
      requireBook(bookId);
      db.prepare('DELETE FROM favorites WHERE book_id = ?').run(bookId);
      db.prepare('INSERT INTO favorites (slot, book_id) VALUES (?, ?) ON CONFLICT(slot) DO UPDATE SET book_id = excluded.book_id, demo = 0').run(slot, bookId);
    } else {
      db.prepare('DELETE FROM favorites WHERE slot = ?').run(slot);
    }
  });
  return favorites();
}

function favorites() {
  const slots = [null, null, null, null];
  for (const f of db.prepare('SELECT * FROM favorites').all()) slots[f.slot - 1] = presentBook(getBookRow(f.book_id));
  return slots;
}

function goal() {
  const year = new Date().getFullYear();
  const target = Number(getSetting('goal', 0)) || null;
  const done = db.prepare(`SELECT COUNT(*) AS n FROM logs WHERE substr(finished_on, 1, 4) = ?`).get(String(year)).n;
  return { year, target, done };
}

export function profile() {
  const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM (SELECT book_id FROM logs UNION SELECT book_id FROM shelf WHERE status = 'read')) AS books,
      (SELECT COUNT(*) FROM shelf WHERE status = 'want') AS want,
      (SELECT COUNT(*) FROM shelf WHERE status = 'reading') AS reading,
      (SELECT COUNT(*) FROM lists) AS lists,
      (SELECT COUNT(*) FROM quotes) AS quotes,
      (SELECT COALESCE(SUM(b.pages), 0) FROM logs l JOIN books b ON b.id = l.book_id) AS pages`).get();
  return { name: getSetting('name', 'Leitor'), counts, favorites: favorites(), goal: goal(), demo: hasDemoData() };
}

export async function home() {
  // Ordem de quando começou a ler: atualizar a página não tira o livro do lugar.
  const reading = db.prepare(`${BOOK_SELECT} WHERE s.status = 'reading'
    ORDER BY s.started_on IS NULL, s.started_on DESC, b.title`).all().map(presentBook);
  const recent = db.prepare(`SELECT * FROM logs WHERE finished_on IS NOT NULL ORDER BY finished_on DESC, id DESC LIMIT 10`).all()
    .map((l) => ({ ...presentLog(l), book: presentBook(getBookRow(l.book_id)) }));
  const books = db.prepare(`${BOOK_SELECT} WHERE s.status IN ('reading', 'read')
    OR EXISTS (SELECT 1 FROM logs l WHERE l.book_id = b.id AND l.finished_on IS NOT NULL)
    ORDER BY b.id`).all().map(presentBook);
  const quote = await dailyQuote(books);
  const hasBooks = !!db.prepare(`SELECT 1 FROM shelf WHERE status IS NOT NULL UNION SELECT 1 FROM logs LIMIT 1`).get();
  return { name: getSetting('name', 'Leitor'), reading, recent, quote, has_books: hasBooks, goal: goal(), demo: hasDemoData() };
}

function shelfBooks() {
  return db.prepare(`${BOOK_SELECT} WHERE s.book_id IS NOT NULL`).all().map((row) => ({
    id: row.id,
    ol_key: row.ol_key,
    title: row.title,
    original_title: row.original_title,
    authors: JSON.parse(row.authors || '[]'),
    subjects: JSON.parse(row.subjects || '[]'),
    status: row.status,
    rating: row.my_rating,
  }));
}

export async function discover() {
  const books = shelfBooks();
  const day = Math.floor(Date.now() / 86_400_000);
  const seeds = rec.pickSeeds(books, { day });
  const authors = rec.lovedAuthors(books, { day });

  // A Open Library pede poucas requisições por segundo: o cache cobre as próximas visitas.
  const inPortuguese = (query) => ol.popularInPortuguese(query);
  const seedPools = allSettledInBatches(seeds.map((seed) => async () => {
    const pools = await Promise.all(seed.genres.slice(0, 2).map((id) => inPortuguese(`subject:"${rec.genre(id).query}"`)));
    return pools.flat();
  }));
  const authorPools = allSettledInBatches(authors.map((author) => () => inPortuguese(`author:"${author.replace(/"/g, '')}"`)));
  const [seedResults, authorResults, brazilian, trending] = await Promise.all([
    seedPools,
    authorPools,
    inPortuguese('subject:"Brazilian fiction"').catch(() => []),
    ol.trending().catch(() => []),
  ]);
  const fulfilled = (results) => results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);

  const shelf = rec.shelfIndex(books);
  const taste = rec.tasteProfile(books);
  const seen = new Set();
  const rails = [];
  const addRail = (title, docs) => { if (docs.length >= 3) rails.push({ title, docs }); };

  seeds.forEach((seed, i) => {
    const pool = seedResults[i].status === 'fulfilled' ? seedResults[i].value : [];
    addRail(`Porque você amou ${seed.title}`, rec.rankRail(pool, { shelf, taste, seen, seedGenres: seed.genres, excludeKnownAuthors: true, requireSeedGenre: true, minLog: 10 }));
  });
  addRail('De quem você já gosta', rec.rankRail(fulfilled(authorResults), { shelf, taste, seen, onlyKnownAuthors: true }));
  addRail('Prosa brasileira', rec.rankRail(brazilian, { shelf, taste, seen, perAuthor: 2 }));
  addRail('Em alta no mundo', rec.rankRail(trending, { shelf, taste, seen, perAuthor: 2, ptOnly: false }));

  return transaction(() => ({ rails: rails.map(({ title, docs }) => ({ title, books: presentDocs(docs) })) }));
}

// Três consultas por vez, mantendo a ordem de entrada. Falha em uma não derruba as outras.
async function allSettledInBatches(tasks, size = 3) {
  const results = [];
  for (let i = 0; i < tasks.length; i += size) {
    results.push(...await Promise.allSettled(tasks.slice(i, i + size).map((task) => task())));
  }
  return results;
}

// ---- Números ----

const FORMAT_LABELS = { paper: 'Papel', ebook: 'E-book', audio: 'Áudio' };
const FORMAT_ORDER = ['paper', 'ebook', 'audio'];

export function stats({ year }) {
  const allTime = !year || year === 'all';
  const yearStr = allTime ? null : String(year);
  const rows = db.prepare(`SELECT l.*, b.title, b.pages, b.authors, b.year AS pub_year, b.subjects FROM logs l JOIN books b ON b.id = l.book_id
    WHERE l.finished_on IS NOT NULL ${allTime ? '' : 'AND substr(l.finished_on, 1, 4) = ?'}
    ORDER BY l.finished_on, l.id`).all(...(allTime ? [] : [yearStr]));

  const years = db.prepare(`SELECT DISTINCT y FROM (
      SELECT substr(finished_on, 1, 4) AS y FROM logs WHERE finished_on IS NOT NULL
      UNION
      SELECT substr(dropped_on, 1, 4) AS y FROM drops WHERE dropped_on IS NOT NULL
    ) ORDER BY y DESC`).all().map((r) => Number(r.y));

  // Em "Sempre", soma todos os eventos em `drops` (datados e sem data) mais eventuais legados ainda não materializados.
  const dropped = allTime
    ? db.prepare(`SELECT
        (SELECT COUNT(*) FROM drops) +
        (SELECT COUNT(*) FROM shelf s WHERE s.status = 'dropped' AND NOT EXISTS (SELECT 1 FROM drops d WHERE d.book_id = s.book_id))
      AS n`).get().n
    : db.prepare(`SELECT COUNT(*) AS n FROM drops WHERE dropped_on IS NOT NULL AND substr(dropped_on, 1, 4) = ?`).get(yearStr).n;

  const ratings = Array(10).fill(0);
  const months = Array.from({ length: 12 }, () => ({ books: 0, pages: 0 }));
  const byYear = new Map(years.map((y) => [y, { year: y, books: 0, pages: 0 }]));
  const authors = new Map();
  const decades = new Map();
  const genres = new Map();
  const formats = new Map();
  const periodRatings = new Map();
  let pages = 0, ratingSum = 0, rated = 0, rereads = 0, daysSum = 0, daysCount = 0;

  for (const r of rows) {
    const p = r.pages || 0;
    pages += p;
    if (r.rating) {
      ratings[r.rating - 1]++;
      ratingSum += r.rating;
      rated++;
      const prev = periodRatings.get(r.book_id);
      if (!prev || r.rating > prev.rating || (r.rating === prev.rating && r.finished_on >= prev.finished_on)) {
        periodRatings.set(r.book_id, { rating: r.rating, finished_on: r.finished_on });
      }
    }
    if (r.reread) rereads++;
    const m = months[Number(r.finished_on.slice(5, 7)) - 1];
    m.books++; m.pages += p;
    const y = byYear.get(Number(r.finished_on.slice(0, 4)));
    if (y) { y.books++; y.pages += p; }
    for (const a of JSON.parse(r.authors || '[]').slice(0, 1)) {
      const entry = authors.get(a) || { name: a, books: 0, pages: 0 };
      entry.books++; entry.pages += p;
      authors.set(a, entry);
    }
    for (const gid of rec.genresOf(JSON.parse(r.subjects || '[]'))) {
      const entry = genres.get(gid) || { id: gid, label: rec.genre(gid).label, books: 0, pages: 0 };
      entry.books++; entry.pages += p;
      genres.set(gid, entry);
    }
    if (r.format && FORMAT_LABELS[r.format]) {
      const entry = formats.get(r.format) || { id: r.format, label: FORMAT_LABELS[r.format], books: 0, pages: 0 };
      entry.books++; entry.pages += p;
      formats.set(r.format, entry);
    }
    if (r.pub_year) {
      const d = Math.floor(r.pub_year / 10) * 10;
      const entry = decades.get(d) || { decade: d, count: 0, books: new Map() };
      entry.count++;
      if (!entry.books.has(r.book_id)) entry.books.set(r.book_id, { id: r.book_id, title: r.title, year: r.pub_year });
      decades.set(d, entry);
    }
    if (r.started_on) {
      const days = (Date.parse(r.finished_on) - Date.parse(r.started_on)) / 86_400_000;
      if (days >= 0) { daysSum += days + 1; daysCount++; }
    }
  }

  const ids = [...new Set(rows.map((r) => r.book_id))];
  const books = ids.map((id) => presentBook(getBookRow(id)));
  const withPages = books.filter((b) => b.pages);
  const sortedByPages = [...withPages].sort((a, b) => b.pages - a.pages);
  // Favoritos do período usam a nota registrada dentro do próprio período, não a última nota global do livro.
  const top = books
    .filter((b) => periodRatings.has(b.id))
    .map((b) => {
      const pr = periodRatings.get(b.id);
      return { ...b, rating: pr.rating, last_finished: pr.finished_on };
    })
    .sort((a, b) => b.rating - a.rating || (b.last_finished || '').localeCompare(a.last_finished || ''))
    .slice(0, 5);

  return {
    year: allTime ? 'all' : Number(year),
    years,
    books: rows.length,
    unique_books: ids.length,
    pages,
    average_rating: rated ? ratingSum / rated / 2 : null,
    rereads,
    dropped,
    average_days: daysCount ? daysSum / daysCount : null,
    ratings,
    months,
    by_year: [...byYear.values()].sort((a, b) => a.year - b.year),
    genres: [...genres.values()].sort((a, b) => b.books - a.books || b.pages - a.pages || a.label.localeCompare(b.label, 'pt-BR')),
    formats: [...formats.values()].sort((a, b) => b.books - a.books || b.pages - a.pages || FORMAT_ORDER.indexOf(a.id) - FORMAT_ORDER.indexOf(b.id)),
    authors: [...authors.values()].sort((a, b) => b.books - a.books || b.pages - a.pages).slice(0, 6),
    decades: [...decades.values()]
      .map(({ decade, count, books: list }) => ({
        decade,
        count,
        books: [...list.values()].sort((a, b) => a.year - b.year || a.title.localeCompare(b.title, 'pt-BR')),
      }))
      .sort((a, b) => a.decade - b.decade),
    longest: sortedByPages[0] || null,
    shortest: sortedByPages[sortedByPages.length - 1] || null,
    top,
    stack: withPages.slice(-60),
    goal: goal(),
  };
}

// ---- Exportação ----

export function exportAll() {
  const q = (sql) => db.prepare(sql).all();
  return {
    exported_at: new Date().toISOString(),
    app: 'orelha',
    books: q(`SELECT b.* FROM books b WHERE
      EXISTS (SELECT 1 FROM shelf s WHERE s.book_id = b.id) OR EXISTS (SELECT 1 FROM logs l WHERE l.book_id = b.id)
      OR EXISTS (SELECT 1 FROM list_items i WHERE i.book_id = b.id) OR EXISTS (SELECT 1 FROM quotes c WHERE c.book_id = b.id)
      OR EXISTS (SELECT 1 FROM favorites f WHERE f.book_id = b.id) OR EXISTS (SELECT 1 FROM progress p WHERE p.book_id = b.id)
      OR EXISTS (SELECT 1 FROM drops d WHERE d.book_id = b.id)`),
    shelf: q('SELECT * FROM shelf'),
    logs: q('SELECT * FROM logs'),
    drops: q('SELECT * FROM drops'),
    progress: q('SELECT * FROM progress'),
    quotes: q('SELECT * FROM quotes'),
    lists: q('SELECT * FROM lists'),
    list_items: q('SELECT * FROM list_items'),
    favorites: q('SELECT * FROM favorites'),
  };
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Evita que planilhas interpretem o texto de uma resenha como fórmula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportCsv() {
  const rows = db.prepare(`SELECT b.title, b.authors, b.isbn, b.pages, b.year, l.rating, l.finished_on, l.started_on, l.reread, l.format, l.review, s.status, s.liked
    FROM logs l JOIN books b ON b.id = l.book_id LEFT JOIN shelf s ON s.book_id = b.id
    UNION ALL
    SELECT b.title, b.authors, b.isbn, b.pages, b.year, NULL, NULL, s.started_on, 0, NULL, NULL, s.status, s.liked
    FROM shelf s JOIN books b ON b.id = s.book_id
    WHERE s.status IS NOT NULL AND NOT EXISTS (SELECT 1 FROM logs l WHERE l.book_id = s.book_id)`).all();
  const header = ['Título', 'Autores', 'ISBN', 'Páginas', 'Ano', 'Nota', 'Terminado em', 'Começado em', 'Releitura', 'Formato', 'Resenha', 'Status', 'Marcou'];
  const lines = rows.map((r) => [
    r.title, JSON.parse(r.authors || '[]').join('; '), r.isbn, r.pages, r.year,
    r.rating ? r.rating / 2 : '', r.finished_on, r.started_on, r.reread ? 'sim' : '', r.format, r.review, r.status, r.liked ? 'sim' : '',
  ].map(csvCell).join(','));
  return [header.join(','), ...lines].join('\n');
}

// ---- Dados de exemplo ----

export function hasDemoData() {
  return !!db.prepare(`SELECT 1 FROM logs WHERE demo = 1 UNION SELECT 1 FROM shelf WHERE demo = 1 UNION SELECT 1 FROM lists WHERE demo = 1 LIMIT 1`).get();
}

// Remove só o que foi semeado; o que o usuário registrou continua lá.
export function clearDemoData() {
  transaction(() => {
    db.exec(`
      DELETE FROM favorites WHERE demo = 1;
      DELETE FROM lists WHERE demo = 1;
      DELETE FROM quotes WHERE demo = 1;
      DELETE FROM progress WHERE demo = 1;
      DELETE FROM drops WHERE demo = 1;
      DELETE FROM logs WHERE demo = 1;
      DELETE FROM shelf WHERE demo = 1 AND NOT EXISTS (SELECT 1 FROM logs l WHERE l.book_id = shelf.book_id);
      UPDATE shelf SET demo = 0;
    `);
    // A meta só é apagada se ainda for a da demonstração, não uma que o usuário definiu.
    if (getSetting('goal_is_demo')) {
      setSetting('goal', null);
      setSetting('goal_is_demo', null);
    }
  });
}
