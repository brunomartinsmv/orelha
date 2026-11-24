// Fila local em IndexedDB e projeção otimista para ações essenciais offline
// (progresso de página, trechos guardados e alteração de status na estante).

const TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504]);

export function bookSnapshot(book) {
  if (!book) return null;
  return {
    id: book.id,
    ol_key: book.ol_key ?? null,
    title: book.title ?? '',
    original_title: book.original_title ?? null,
    subtitle: book.subtitle ?? null,
    authors: Array.isArray(book.authors) ? [...book.authors] : [],
    year: book.year ?? null,
    pages: book.pages ?? null,
    isbn: book.isbn ?? null,
    color: book.color ?? null,
    cover: book.cover ?? null,
    source: book.source ?? null,
    status: book.status ?? null,
    liked: !!book.liked,
    current_page: book.current_page ?? null,
    started_on: book.started_on ?? null,
    rating: book.rating ?? null,
    last_finished: book.last_finished ?? null,
    ...(Array.isArray(book.genres) ? { genres: [...book.genres] } : {}),
  };
}

function readingChanged(previous, next) {
  return previous.status !== next.status || previous.started_on !== next.started_on;
}

function withoutStaleEstimate(previous, next, kind) {
  if (next.reading_estimate && (kind === 'progress' || readingChanged(previous, next) || previous.current_page !== next.current_page)) {
    return { ...next, reading_estimate: null };
  }
  return next;
}

export function applyBookOp(book, op) {
  if (!book || !op || op.book_id !== book.id) return book;
  if (op.kind === 'progress') {
    return withoutStaleEstimate(book, {
      ...book,
      status: 'reading',
      current_page: op.payload.page,
      started_on: (book.status === 'read' ? null : book.started_on) || op.payload.on_day || null,
    }, op.kind);
  }
  if (op.kind === 'shelf') {
    const next = { ...book };
    if (op.payload.status !== undefined) {
      const status = op.payload.status;
      next.status = status;
      if (status === 'reading') {
        next.started_on = (book.status === 'read' ? null : book.started_on) || op.payload.on_day || null;
      } else if (status === 'want' || status === null) {
        next.started_on = null;
      }
      if (status !== 'reading' && status !== 'dropped') {
        next.current_page = null;
      }
    }
    if (op.payload.liked !== undefined) next.liked = !!op.payload.liked;
    if (op.payload.started_on !== undefined) next.started_on = op.payload.started_on;
    return withoutStaleEstimate(book, next, op.kind);
  }
  return book;
}

function parseApiPath(path) {
  if (!path) return null;
  const qIndex = path.indexOf('?');
  const pathname = qIndex === -1 ? path : path.slice(0, qIndex);
  const search = qIndex === -1 ? '' : path.slice(qIndex + 1);
  if (pathname === '/home') return { route: 'home' };
  if (pathname === '/diary/calendar') return { route: 'calendar', month: new URLSearchParams(search).get('month') };
  if (pathname === '/quotes') return { route: 'quotes' };
  if (pathname === '/profile') return { route: 'profile' };
  if (pathname === '/shelf') {
    const params = new URLSearchParams(search);
    return { route: 'shelf', status: params.get('status') || 'all', q: params.get('q') || '' };
  }
  const bookMatch = pathname.match(/^\/books\/([^/]+)$/);
  if (bookMatch) return { route: 'book', bookId: decodeURIComponent(bookMatch[1]) };
  return null;
}

function sortReading(books) {
  return [...books].sort((a, b) => {
    const aNull = !a.started_on;
    const bNull = !b.started_on;
    if (aNull !== bNull) return aNull ? 1 : -1;
    if (a.started_on !== b.started_on) return (b.started_on || '').localeCompare(a.started_on || '');
    return (a.title || '').localeCompare(b.title || '');
  });
}

function sortQuotes(quotes) {
  return [...quotes].sort((a, b) => {
    const ap = a.page ?? 999999;
    const bp = b.page ?? 999999;
    if (ap !== bp) return ap - bp;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  });
}

function mergeConfirmedBook(existing, serverResult, kind) {
  if (!existing) return serverResult;
  return withoutStaleEstimate(existing, {
    ...existing,
    ...serverResult,
    genres: serverResult.genres ?? existing.genres,
  }, kind);
}

function patchBookPage(data, book, entry) {
  const progress = readingChanged(data.book, book) ? [] : (data.progress || []);
  if (!entry || progress.some((row) => row.id === entry.id || (entry.pending && row.confirmed_op_id === entry.op_id))) {
    return { ...data, book, progress };
  }
  const index = progress.findIndex((row) => row.on_day < entry.on_day ||
    (row.on_day === entry.on_day && (entry.pending || (!row.pending && row.id < entry.id))));
  const next = [...progress];
  next.splice(index < 0 ? next.length : index, 0, entry);
  return { ...data, book, progress: next };
}

function applyBookToHome(data, bookId, updateFn) {
  if (!data || !Array.isArray(data.reading)) return data;
  const current = data.reading.find((b) => b.id === bookId) || null;
  const updated = updateFn(current);
  if (!updated) return data;

  const rest = data.reading.filter((b) => b.id !== bookId);
  const nextReading = updated.status === 'reading' ? sortReading([...rest, updated]) : rest;
  const hasBooks = data.has_books || (updated.status !== null && updated.status !== undefined);
  return { ...data, reading: nextReading, has_books: hasBooks };
}

function matchesShelfQuery(book, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const title = (book.title || '').toLowerCase();
  const authors = (book.authors || []).join(' ').toLowerCase();
  return title.includes(needle) || authors.includes(needle);
}

function shouldAppearOnShelf(book, statusFilter) {
  if (statusFilter && statusFilter !== 'all') return book.status === statusFilter;
  if (book.status !== null && book.status !== undefined) return true;
  return book.rating != null || book.last_finished != null;
}

function applyBookToShelf(list, bookId, statusFilter, q, updateFn) {
  if (!Array.isArray(list)) return list;
  const idx = list.findIndex((b) => b.id === bookId);
  const base = idx >= 0 ? list[idx] : null;
  const updated = updateFn(base);
  if (!updated) return list;

  const keep = shouldAppearOnShelf(updated, statusFilter) && matchesShelfQuery(updated, q);
  if (!keep) {
    return idx >= 0 ? list.filter((_, i) => i !== idx) : list;
  }
  if (idx >= 0) {
    const next = [...list];
    next[idx] = updated;
    return next;
  }
  return [updated, ...list];
}

function pendingQuoteRow(op) {
  return {
    id: `pending:${op.op_id}`,
    book_id: op.book_id,
    text: String(op.payload.text || '').trim(),
    page: op.payload.page ?? null,
    created_at: op.created_at,
    pending: true,
  };
}

function prependQuote(quotes, quote) {
  if (!Array.isArray(quotes)) return quotes;
  if (quotes.some((q) => q.id === quote.id)) return quotes;
  return [quote, ...quotes];
}

function appendSortedQuote(quotes, quote) {
  if (!Array.isArray(quotes)) return quotes;
  if (quotes.some((q) => q.id === quote.id)) return quotes;
  return sortQuotes([...quotes, quote]);
}

function statusDelta(prevStatus, nextStatus) {
  const delta = { want: 0, reading: 0 };
  if (prevStatus === nextStatus) return delta;
  if (prevStatus === 'want') delta.want -= 1;
  if (prevStatus === 'reading') delta.reading -= 1;
  if (nextStatus === 'want') delta.want += 1;
  if (nextStatus === 'reading') delta.reading += 1;
  return delta;
}

function applyOpsToProfile(data, ops, confirmedMap = null) {
  if (!data || !data.counts || !ops.length) return data;
  let wantDelta = 0;
  let readingDelta = 0;
  let quotesDelta = 0;
  const statusByBook = new Map();
  let favorites = Array.isArray(data.favorites) ? [...data.favorites] : data.favorites;

  for (const op of ops) {
    if (op.kind === 'quote') {
      quotesDelta += 1;
      continue;
    }
    if (op.kind !== 'progress' && op.kind !== 'shelf') continue;

    const favBook = Array.isArray(favorites) ? favorites.find((f) => f && f.id === op.book_id) : null;
    const prevStatus = statusByBook.has(op.book_id)
      ? statusByBook.get(op.book_id)
      : (op.expected?.status !== undefined
        ? (op.expected.status ?? null)
        : (favBook?.status ?? op.book_snapshot?.status ?? null));

    const confirmed = confirmedMap?.get(op.op_id);
    const nextBook = confirmed
      ? mergeConfirmedBook(favBook || op.book_snapshot || { id: op.book_id }, confirmed)
      : applyBookOp({ ...(favBook || op.book_snapshot || { id: op.book_id }), status: prevStatus }, op);
    const nextStatus = nextBook.status ?? null;

    const d = statusDelta(prevStatus, nextStatus);
    wantDelta += d.want;
    readingDelta += d.reading;
    statusByBook.set(op.book_id, nextStatus);

    if (Array.isArray(favorites)) {
      favorites = favorites.map((f) => (f && f.id === op.book_id
        ? (confirmed ? mergeConfirmedBook(f, confirmed) : applyBookOp(f, op))
        : f));
    }
  }

  return {
    ...data,
    counts: {
      ...data.counts,
      want: Math.max(0, (data.counts.want || 0) + wantDelta),
      reading: Math.max(0, (data.counts.reading || 0) + readingDelta),
      quotes: Math.max(0, (data.counts.quotes || 0) + quotesDelta),
    },
    favorites,
  };
}

export function applyPendingToPath(path, data, items) {
  if (!data || !items?.length) return data;
  const parsed = parseApiPath(path);
  if (!parsed) return data;

  if (parsed.route === 'profile') {
    return applyOpsToProfile(data, items);
  }

  let next = data;
  for (const op of items) {
    if (parsed.route === 'home') {
      if (op.kind === 'progress' || op.kind === 'shelf') {
        next = applyBookToHome(next, op.book_id, (cur) => {
          const base = cur || op.book_snapshot;
          return base ? applyBookOp(base, op) : null;
        });
      }
    } else if (parsed.route === 'book') {
      if (op.book_id !== parsed.bookId) continue;
      if ((op.kind === 'progress' || op.kind === 'shelf') && next.book) {
        const book = applyBookOp(next.book, op);
        const day = op.payload.on_day;
        const entry = op.kind === 'progress' && day && day >= (book.started_on || '') && day > (book.last_finished || '') ? {
          id: `pending:${op.op_id}`, op_id: op.op_id, page: op.payload.page, on_day: day, pending: true,
        } : null;
        next = patchBookPage(next, book, entry);
      } else if (op.kind === 'quote' && Array.isArray(next.quotes)) {
        next = { ...next, quotes: appendSortedQuote(next.quotes, pendingQuoteRow(op)) };
      }
    } else if (parsed.route === 'shelf') {
      if (op.kind === 'progress' || op.kind === 'shelf') {
        next = applyBookToShelf(next, op.book_id, parsed.status, parsed.q, (cur) => {
          const base = cur || op.book_snapshot;
          return base ? applyBookOp(base, op) : null;
        });
      }
    } else if (parsed.route === 'quotes') {
      if (op.kind === 'quote') {
        next = prependQuote(next, { ...pendingQuoteRow(op), book: op.book_snapshot });
      }
    }
  }
  return next;
}

export function patchDataWithConfirmed(path, data, op, serverResult) {
  if (!data || !op || !serverResult) return data;
  const parsed = parseApiPath(path);
  if (!parsed) return data;
  const { progress_entry: progressEntry, ...result } = serverResult;

  if (parsed.route === 'home' && (op.kind === 'progress' || op.kind === 'shelf')) {
    return applyBookToHome(data, op.book_id, (cur) => mergeConfirmedBook(cur || op.book_snapshot, result, op.kind));
  }
  if (parsed.route === 'calendar' && op.kind === 'progress') {
    const day = op.payload.on_day;
    if (day?.slice(0, 7) === parsed.month && Array.isArray(data.progress_days) && !data.progress_days.includes(day)) {
      return { ...data, progress_days: [...data.progress_days, day].sort() };
    }
  }
  if (parsed.route === 'book' && op.book_id === parsed.bookId) {
    if ((op.kind === 'progress' || op.kind === 'shelf') && data.book) {
      const entry = progressEntry ? { ...progressEntry, confirmed_op_id: op.op_id } : null;
      return patchBookPage(data, mergeConfirmedBook(data.book, result, op.kind), entry);
    }
    if (op.kind === 'quote' && Array.isArray(data.quotes)) {
      return { ...data, quotes: appendSortedQuote(data.quotes, serverResult) };
    }
  }
  if (parsed.route === 'shelf' && (op.kind === 'progress' || op.kind === 'shelf')) {
    return applyBookToShelf(data, op.book_id, parsed.status, parsed.q, (cur) => mergeConfirmedBook(cur || op.book_snapshot, result));
  }
  if (parsed.route === 'quotes' && op.kind === 'quote') {
    return prependQuote(data, { ...serverResult, book: op.book_snapshot || serverResult.book });
  }
  if (parsed.route === 'profile') {
    const confirmedMap = new Map([[op.op_id, result]]);
    return applyOpsToProfile(data, [op], confirmedMap);
  }
  return data;
}

export function affectedPathsForOp(op) {
  const paths = [
    '/home',
    '/shelf?status=all',
    '/shelf?status=want',
    '/profile',
    `/books/${encodeURIComponent(op.book_id)}`,
  ];
  if (op.kind === 'quote') paths.push('/quotes');
  if (op.kind === 'progress' && op.payload.on_day) {
    paths.push(`/diary/calendar?month=${op.payload.on_day.slice(0, 7)}`);
  }
  return paths;
}

export function classifyHttpResponse(res, data) {
  if (res.headers?.get?.('X-Orelha-Offline') === '1') {
    return { ok: false, kind: 'transient', status: 503, message: 'Resposta vinda do cache offline.' };
  }
  const contentType = res.headers?.get?.('content-type') || '';
  if (res.ok) {
    if (!contentType.includes('application/json') || data === null) {
      return { ok: false, kind: 'transient', status: res.status, message: 'Resposta inesperada do servidor.' };
    }
    return { ok: true, data };
  }
  if (TRANSIENT_STATUSES.has(res.status)) {
    return { ok: false, kind: 'transient', status: res.status, message: data?.error || 'Servidor indisponível agora.' };
  }
  if (res.status === 409 && data?.code === 'conflict') {
    return {
      ok: false,
      kind: 'conflict',
      status: 409,
      code: 'conflict',
      message: data.error || 'Este livro foi alterado em outro aparelho antes da sincronização.',
      current: data.current ?? null,
    };
  }
  return {
    ok: false,
    kind: 'error',
    status: res.status,
    code: data?.code || null,
    message: data?.error || 'Não foi possível concluir a alteração.',
  };
}

// ---------- Armazenamento ----------

export function createMemoryStore(initial = []) {
  let nextSeq = initial.reduce((max, item) => Math.max(max, item.seq || 0), 0) + 1;
  const rows = initial.map((item) => ({ ...item }));

  return {
    async getAll() {
      return rows.map((item) => ({ ...item })).sort((a, b) => a.seq - b.seq);
    },
    async add(item) {
      const seq = item.seq ?? nextSeq++;
      nextSeq = Math.max(nextSeq, seq + 1);
      rows.push({ ...item, seq });
      return seq;
    },
    async put(item) {
      const idx = rows.findIndex((r) => r.seq === item.seq);
      if (idx >= 0) rows[idx] = { ...item };
      else rows.push({ ...item });
    },
    async delete(seq) {
      const idx = rows.findIndex((r) => r.seq === seq);
      if (idx >= 0) rows.splice(idx, 1);
    },
  };
}

function reqPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Erro no IndexedDB.'));
  });
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Erro na transação do IndexedDB.'));
    tx.onabort = () => reject(tx.error || new Error('Transação abortada no IndexedDB.'));
  });
}

export function createIndexedDbStore(dbName = 'orelha-offline') {
  const STORE = 'queue';
  let opening = null;

  function openDb() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB indisponível.'));
        return;
      }
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      req.onerror = () => {
        opening = null;
        reject(req.error || new Error('Não foi possível abrir o IndexedDB.'));
      };
    });
    return opening;
  }

  return {
    async getAll() {
      const db = await openDb();
      const tx = db.transaction(STORE, 'readonly');
      const items = await reqPromise(tx.objectStore(STORE).getAll());
      await txPromise(tx);
      return items.sort((a, b) => a.seq - b.seq);
    },
    async add(item) {
      const db = await openDb();
      const tx = db.transaction(STORE, 'readwrite');
      const seq = await reqPromise(tx.objectStore(STORE).add(item));
      await txPromise(tx);
      return seq;
    },
    async put(item) {
      const db = await openDb();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(item);
      await txPromise(tx);
    },
    async delete(seq) {
      const db = await openDb();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(seq);
      await txPromise(tx);
    },
  };
}

// ---------- Trava entre abas sem Web Locks ----------

// `localStorage` não tem escrita condicional, então a trava é tomada em duas etapas: grava o dono,
// espera `settleMs` e relê. Se duas abas gravarem quase juntas, a última escrita vence e só ela
// se confirma na releitura. Enquanto a fila drena, o prazo é renovado para não expirar no meio.
// Sem acesso ao armazenamento (modo privado) segue sem trava; o `op_id` no servidor evita duplicatas.
export function createStorageLock({
  storage,
  ownerId,
  key = 'orelha.sync.lock',
  ttlMs = 20_000,
  settleMs = 50,
  renewMs = 5_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onBusy = () => {},
}) {
  const read = () => {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  };
  const heldByOther = (held) => !!held && held.owner !== ownerId && held.expiresAt > now();
  const write = () => storage.setItem(key, JSON.stringify({ owner: ownerId, expiresAt: now() + ttlMs }));

  async function acquire() {
    try {
      if (heldByOther(read())) return false;
      write();
    } catch {
      return true;
    }
    await sleep(settleMs);
    try {
      return read()?.owner === ownerId;
    } catch {
      return true;
    }
  }

  function release() {
    try {
      if (read()?.owner === ownerId) storage.removeItem(key);
    } catch { /* modo privado */ }
  }

  return async function storageLock(fn) {
    if (!(await acquire())) {
      onBusy();
      return undefined;
    }
    const renew = setInterval(() => {
      try { if (read()?.owner === ownerId) write(); } catch { /* modo privado */ }
    }, renewMs);
    try {
      return await fn();
    } finally {
      clearInterval(renew);
      release();
    }
  };
}

// ---------- Motor de sincronização ----------

const defaultRandomId = () => (
  globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
);

export function createSyncEngine({
  store,
  transport,
  lock = (fn) => fn(),
  broadcast = () => {},
  onStatusChange,
  onItemConfirmed,
  onDrained,
  now = () => new Date().toISOString(),
  randomId = defaultRandomId,
} = {}) {
  let items = [];
  let syncing = false;
  let activeFlush = null;
  let rerunRequested = false;
  const subs = new Set();
  const waiters = new Map();

  function getState() {
    const blockedItem = items.find((i) => i.state === 'conflict' || i.state === 'error') || null;
    return {
      items: items.map((i) => ({ ...i })),
      syncing,
      blockedItem,
      pendingCount: items.length,
    };
  }

  function notify() {
    const snapshot = getState();
    subs.forEach((fn) => fn(snapshot));
  }

  function settleWaiter(opId, outcome) {
    const entry = waiters.get(opId);
    if (!entry) return;
    waiters.delete(opId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(outcome);
  }

  function settlePendingWaiters() {
    for (const opId of [...waiters.keys()]) {
      const item = items.find((i) => i.op_id === opId);
      settleWaiter(opId, { status: 'queued', item: item || null });
    }
  }

  function buildPath(kind, bookId) {
    const encoded = encodeURIComponent(bookId);
    if (kind === 'progress') return `/books/${encoded}/progress`;
    if (kind === 'quote') return `/books/${encoded}/quotes`;
    return `/books/${encoded}/shelf`;
  }

  async function init() {
    items = await store.getAll();
    notify();
    return getState();
  }

  async function reloadFromStore() {
    items = await store.getAll();
    notify();
    return getState();
  }

  async function sendItem(head) {
    const body = {
      ...head.payload,
      op_id: head.op_id,
      ...(!head.force && head.expected ? { expected: head.expected } : {}),
    };
    try {
      return await transport({
        method: head.method,
        path: head.path,
        body,
        item: head,
      });
    } catch (err) {
      return { ok: false, kind: 'transient', message: err?.message || 'Sem conexão com o servidor.' };
    }
  }

  async function drainOnce() {
    items = await store.getAll();
    if (!items.length) {
      notify();
      settlePendingWaiters();
      return;
    }

    syncing = true;
    notify();
    const confirmedOps = [];

    try {
      while (true) {
        items = await store.getAll();
        const head = items[0];
        if (!head) break;

        if (head.state !== 'pending') {
          settleWaiter(head.op_id, { status: head.state, item: head, error: head.error });
          break;
        }

        const res = await sendItem(head);

        if (res.ok) {
          await onItemConfirmed?.(head, res.data);
          await store.delete(head.seq);
          items = items.filter((i) => i.seq !== head.seq);
          confirmedOps.push(head);
          settleWaiter(head.op_id, { status: 'synced', item: head, result: res.data });
          notify();
          broadcast({ type: 'updated' });
          continue;
        }

        if (res.kind === 'transient') {
          onStatusChange?.({ offline: true });
          break;
        }

        const nextState = res.kind === 'conflict' ? 'conflict' : 'error';
        const errorInfo = {
          status: res.status || (nextState === 'conflict' ? 409 : 400),
          code: res.code || (nextState === 'conflict' ? 'conflict' : null),
          message: res.message || 'Não foi possível concluir a alteração.',
          ...(res.current !== undefined ? { current: res.current } : {}),
        };
        const updated = { ...head, state: nextState, error: errorInfo };
        await store.put(updated);
        items = items.map((i) => (i.seq === head.seq ? updated : i));
        settleWaiter(head.op_id, { status: nextState, item: updated, error: errorInfo });
        onStatusChange?.({ offline: false });
        notify();
        broadcast({ type: 'updated' });
        break;
      }
    } finally {
      syncing = false;
      items = await store.getAll();
      if (confirmedOps.length > 0) {
        onStatusChange?.({ offline: false });
        await onDrained?.(confirmedOps);
      }
      notify();
    }
  }

  async function flush({ reason = 'manual' } = {}) {
    if (activeFlush) {
      rerunRequested = true;
      return activeFlush;
    }
    activeFlush = (async () => {
      try {
        do {
          rerunRequested = false;
          await lock(() => drainOnce(reason));
        } while (rerunRequested);
      } finally {
        activeFlush = null;
        settlePendingWaiters();
      }
      return getState();
    })();
    return activeFlush;
  }

  async function enqueue({ kind, book, payload, expected = null, waitMs = 1200 }) {
    const opId = randomId();
    const record = {
      op_id: opId,
      kind,
      book_id: book.id,
      book_title: book.title || 'Livro',
      book_snapshot: bookSnapshot(book),
      method: kind === 'shelf' ? 'PUT' : 'POST',
      path: buildPath(kind, book.id),
      payload,
      expected,
      created_at: now(),
      state: 'pending',
      error: null,
      force: false,
    };
    const seq = await store.add(record);
    const saved = { ...record, seq };
    items = [...items, saved].sort((a, b) => a.seq - b.seq);
    notify();
    broadcast({ type: 'updated' });

    if (waitMs <= 0) {
      flush({ reason: 'enqueue' }).catch(() => {});
      return { status: 'queued', item: saved };
    }

    const waitPromise = new Promise((resolve) => {
      const timer = setTimeout(() => settleWaiter(opId, { status: 'queued', item: saved }), waitMs);
      waiters.set(opId, { resolve, timer });
    });

    flush({ reason: 'enqueue' }).catch(() => {
      settleWaiter(opId, { status: 'queued', item: saved });
    });

    return waitPromise;
  }

  async function retryItem(seq, { force = false } = {}) {
    const current = items.find((i) => i.seq === seq) || (await store.getAll()).find((i) => i.seq === seq);
    if (!current) return getState();
    const updated = { ...current, state: 'pending', error: null, force: force || current.force };
    await store.put(updated);
    items = items.map((i) => (i.seq === seq ? updated : i));
    notify();
    broadcast({ type: 'updated' });
    return flush({ reason: 'retry' });
  }

  async function discardItem(seq) {
    await store.delete(seq);
    items = items.filter((i) => i.seq !== seq);
    notify();
    broadcast({ type: 'updated' });
    await onDrained?.([]);
    if (items[0]?.state === 'pending') {
      return flush({ reason: 'discard' });
    }
    return getState();
  }

  return {
    init,
    getState,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    enqueue,
    flush,
    retryItem,
    discardItem,
    reloadFromStore,
  };
}
