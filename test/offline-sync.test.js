import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'orelha-sync-test-'));
process.env.ORELHA_DATA_DIR = dataDir;
process.env.ORELHA_NO_ENRICH = '1';
process.env.ORELHA_NO_QUOTES = '1';

const { createApp } = await import('../server/app.js');
const { db } = await import('../server/db.js');
const {
  applyPendingToPath,
  classifyHttpResponse,
  createMemoryStore,
  createSyncEngine,
  patchDataWithConfirmed,
} = await import('../public/app/sync.js');

let server, base, port;

before(async () => {
  port = 40000 + Math.floor(Math.random() * 20000);
  server = createApp({
    port,
    publicPort: 8443,
    tailnetHost: 'mac.example.ts.net',
    allowedDevices: {},
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function apiJson(method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function createBook(title, extra = {}) {
  return (await apiJson('POST', '/books', { title, authors: 'Autora Teste', pages: 320, ...extra })).json;
}

function makeLiveTransport() {
  return async ({ method, path, body }) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    return classifyHttpResponse(res, data);
  };
}

test('persiste offline, projeta UI em todas as telas e sobrevive a recarregamento antes de drenar', async () => {
  const book = await createBook('Grande Sertão Offline', { pages: 500 });
  const initialHome = (await apiJson('GET', '/home')).json;
  const initialBook = (await apiJson('GET', `/books/${book.id}`)).json;
  const initialShelfAll = (await apiJson('GET', '/shelf?status=all')).json;
  const initialShelfWant = (await apiJson('GET', '/shelf?status=want')).json;
  const initialQuotes = (await apiJson('GET', '/quotes')).json;
  const initialProfile = (await apiJson('GET', '/profile')).json;

  const store = createMemoryStore();
  let offlineFlag = null;

  // Simula rede offline desde o início.
  const engine1 = createSyncEngine({
    store,
    transport: async () => { throw new TypeError('Failed to fetch'); },
    onStatusChange: ({ offline }) => { offlineFlag = offline; },
  });
  await engine1.init();

  const r1 = await engine1.enqueue({
    kind: 'shelf',
    book,
    payload: { status: 'want' },
    expected: { status: null, current_page: null },
    waitMs: 0,
  });
  assert.equal(r1.status, 'queued');

  const bookAfterWant = applyPendingToPath(`/books/${book.id}`, initialBook, engine1.getState().items).book;
  assert.equal(bookAfterWant.status, 'want');

  await engine1.enqueue({
    kind: 'progress',
    book: bookAfterWant,
    payload: { page: 42, on_day: '2026-11-22' },
    expected: { status: 'want', current_page: null },
    waitMs: 0,
  });

  const bookAfterProg = applyPendingToPath(`/books/${book.id}`, initialBook, engine1.getState().items).book;
  await engine1.enqueue({
    kind: 'quote',
    book: bookAfterProg,
    payload: { text: 'Viver é muito perigoso.', page: 42 },
    expected: null,
    waitMs: 0,
  });

  // Simula recarregamento ainda offline criando um novo motor sobre o mesmo armazenamento.
  const engineReloaded = createSyncEngine({
    store,
    transport: async () => { throw new TypeError('Failed to fetch'); },
    onStatusChange: ({ offline }) => { offlineFlag = offline; },
  });
  const stateReloaded = await engineReloaded.init();
  assert.equal(stateReloaded.pendingCount, 3);

  const items = stateReloaded.items;
  const home = applyPendingToPath('/home', initialHome, items);
  assert.equal(home.has_books, true);
  assert.equal(home.reading.find((b) => b.id === book.id)?.current_page, 42);

  const bookView = applyPendingToPath(`/books/${book.id}`, initialBook, items);
  assert.equal(bookView.book.status, 'reading');
  assert.equal(bookView.book.current_page, 42);
  assert.equal(bookView.quotes.length, 1);
  assert.equal(bookView.quotes[0].pending, true);
  assert.equal(bookView.quotes[0].text, 'Viver é muito perigoso.');

  const shelfAll = applyPendingToPath('/shelf?status=all', initialShelfAll, items);
  assert.equal(shelfAll.find((b) => b.id === book.id)?.status, 'reading');

  // Como avançou para leitura, não deve permanecer na aba Quero ler.
  const shelfWant = applyPendingToPath('/shelf?status=want', initialShelfWant, items);
  assert.equal(shelfWant.some((b) => b.id === book.id), false);

  const quotesView = applyPendingToPath('/quotes', initialQuotes, items);
  assert.equal(quotesView[0].text, 'Viver é muito perigoso.');
  assert.equal(quotesView[0].pending, true);

  const profileView = applyPendingToPath('/profile', initialProfile, items);
  assert.equal(profileView.counts.reading, initialProfile.counts.reading + 1);
  assert.equal(profileView.counts.want, initialProfile.counts.want);
  assert.equal(profileView.counts.quotes, initialProfile.counts.quotes + 1);

  // Agora o servidor volta a responder: novo motor com transporte real drena em ordem.
  const engineOnline = createSyncEngine({
    store,
    transport: makeLiveTransport(),
    onStatusChange: ({ offline }) => { offlineFlag = offline; },
  });
  await engineOnline.init();
  const drained = await engineOnline.flush({ reason: 'online' });
  assert.equal(drained.pendingCount, 0);
  assert.equal(offlineFlag, false);

  const liveBook = (await apiJson('GET', `/books/${book.id}`)).json;
  assert.equal(liveBook.book.status, 'reading');
  assert.equal(liveBook.book.current_page, 42);
  assert.equal(liveBook.book.started_on, '2026-11-22');
  assert.equal(liveBook.quotes.length, 1);
  assert.equal(liveBook.quotes[0].text, 'Viver é muito perigoso.');
});

test('sequência não comutativa de status e páginas drena na ordem exata', async () => {
  const book = await createBook('Dom Casmurro Sequência', { pages: 250 });
  const store = createMemoryStore();
  let allowNetwork = false;
  const live = makeLiveTransport();

  const engine = createSyncEngine({
    store,
    transport: async (req) => {
      if (!allowNetwork) throw new Error('offline');
      return live(req);
    },
  });
  await engine.init();

  const steps = [
    { kind: 'shelf', payload: { status: 'want' }, expected: { status: null, current_page: null } },
    { kind: 'shelf', payload: { status: 'reading', on_day: '2026-11-20' }, expected: { status: 'want', current_page: null } },
    { kind: 'progress', payload: { page: 40, on_day: '2026-11-20' }, expected: { status: 'reading', current_page: null } },
    { kind: 'progress', payload: { page: 90, on_day: '2026-11-21' }, expected: { status: 'reading', current_page: 40 } },
    { kind: 'shelf', payload: { status: 'dropped' }, expected: { status: 'reading', current_page: 90 } },
    { kind: 'shelf', payload: { status: 'want' }, expected: { status: 'dropped', current_page: 90 } },
  ];

  for (const step of steps) {
    await engine.enqueue({ kind: step.kind, book, payload: step.payload, expected: step.expected, waitMs: 0 });
  }
  assert.equal(engine.getState().pendingCount, 6);

  allowNetwork = true;
  await engine.flush({ reason: 'online' });
  assert.equal(engine.getState().pendingCount, 0);

  const serverPage = (await apiJson('GET', `/books/${book.id}`)).json;
  assert.equal(serverPage.book.status, 'want');
  assert.equal(serverPage.book.current_page, null);
  assert.equal(serverPage.book.started_on, null);
});

test('mantém a fila em 502/HTML e timeout com rede ativa e drena quando o servidor acorda', async () => {
  const book = await createBook('Servidor Dormindo');
  const store = createMemoryStore();
  let mode = '502';
  const live = makeLiveTransport();

  const engine = createSyncEngine({
    store,
    transport: async (req) => {
      if (mode === '502') {
        const res = new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        });
        return classifyHttpResponse(res, null);
      }
      if (mode === 'timeout') {
        throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
      }
      return live(req);
    },
  });
  await engine.init();

  const res502 = await engine.enqueue({
    kind: 'progress',
    book,
    payload: { page: 18, on_day: '2026-11-22' },
    expected: { status: null, current_page: null },
    waitMs: 500,
  });
  assert.equal(res502.status, 'queued');
  assert.equal(engine.getState().pendingCount, 1);

  mode = 'timeout';
  await engine.flush({ reason: 'timer' });
  assert.equal(engine.getState().pendingCount, 1);
  assert.equal(engine.getState().blockedItem, null);

  mode = 'live';
  await engine.flush({ reason: 'timer' });
  assert.equal(engine.getState().pendingCount, 0);
  const page = (await apiJson('GET', `/books/${book.id}`)).json;
  assert.equal(page.book.current_page, 18);
});

test('resposta perdida após gravação reenvia com o mesmo op_id sem duplicar nem gerar conflito', async () => {
  const book = await createBook('Resposta Perdida', { pages: 200 });
  const store = createMemoryStore();
  const live = makeLiveTransport();
  let dropOnce = true;

  const engine = createSyncEngine({
    store,
    transport: async (req) => {
      const result = await live(req);
      if (dropOnce) {
        dropOnce = false;
        throw new Error('Conexão caiu depois do commit');
      }
      return result;
    },
  });
  await engine.init();

  const r1 = await engine.enqueue({
    kind: 'quote',
    book,
    payload: { text: 'Trecho salvo antes de cair.', page: 12 },
    expected: null,
    waitMs: 500,
  });
  assert.equal(r1.status, 'queued');
  assert.equal(engine.getState().pendingCount, 1);

  // Mesmo com a 1ª resposta perdida, servidor já gravou. Reenviar com o mesmo op_id não duplica.
  await engine.flush({ reason: 'retry' });
  assert.equal(engine.getState().pendingCount, 0);

  dropOnce = true;
  const r2 = await engine.enqueue({
    kind: 'progress',
    book,
    payload: { page: 25, on_day: '2026-11-22' },
    expected: { status: null, current_page: null },
    waitMs: 500,
  });
  assert.equal(r2.status, 'queued');
  assert.equal(engine.getState().pendingCount, 1);

  await engine.flush({ reason: 'retry' });
  assert.equal(engine.getState().pendingCount, 0);

  const page = (await apiJson('GET', `/books/${book.id}`)).json;
  assert.equal(page.quotes.length, 1);
  assert.equal(page.book.current_page, 25);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress WHERE book_id = ?').get(book.id).n, 1);
});

test('conflito 409 pausa no item com estado atual e permite aplicar mesmo assim ou descartar', async () => {
  const book = await createBook('Livro Dois Aparelhos', { pages: 400 });
  await apiJson('PUT', `/books/${book.id}/shelf`, { status: 'reading', on_day: '2026-11-20' });
  await apiJson('POST', `/books/${book.id}/progress`, { page: 30, on_day: '2026-11-20' });
  const staleBook = (await apiJson('GET', `/books/${book.id}`)).json.book;

  // Outro aparelho avança o livro para a página 70 no servidor.
  await apiJson('POST', `/books/${book.id}/progress`, { page: 70, on_day: '2026-11-21' });

  const store = createMemoryStore();
  const engine = createSyncEngine({ store, transport: makeLiveTransport() });
  await engine.init();

  // Enfileira progresso desatualizado + um trecho logo depois.
  const conflictRes = await engine.enqueue({
    kind: 'progress',
    book: staleBook,
    payload: { page: 45, on_day: '2026-11-22' },
    expected: { status: 'reading', current_page: 30 },
    waitMs: 500,
  });
  assert.equal(conflictRes.status, 'conflict');
  assert.equal(conflictRes.error.current.current_page, 70);

  const quoteRes = await engine.enqueue({
    kind: 'quote',
    book: { ...staleBook, current_page: 45 },
    payload: { text: 'Trecho atrás do conflito.', page: 45 },
    expected: null,
    waitMs: 500,
  });
  assert.equal(quoteRes.status, 'queued');
  assert.equal(engine.getState().pendingCount, 2);
  assert.equal(engine.getState().blockedItem.kind, 'progress');

  // Caso A: descartar o item em conflito destrava o trecho seguinte e preserva a página 70 no servidor.
  await engine.discardItem(engine.getState().blockedItem.seq);
  assert.equal(engine.getState().pendingCount, 0);
  let serverBook = (await apiJson('GET', `/books/${book.id}`)).json;
  assert.equal(serverBook.book.current_page, 70);
  assert.equal(serverBook.quotes.length, 1);

  // Caso B: novo conflito resolvido com force = true ("Aplicar mesmo assim").
  await engine.enqueue({
    kind: 'progress',
    book: staleBook,
    payload: { page: 85, on_day: '2026-11-22' },
    expected: { status: 'reading', current_page: 30 },
    waitMs: 500,
  });
  assert.equal(engine.getState().blockedItem.state, 'conflict');

  await engine.retryItem(engine.getState().blockedItem.seq, { force: true });
  assert.equal(engine.getState().pendingCount, 0);
  serverBook = (await apiJson('GET', `/books/${book.id}`)).json;
  assert.equal(serverBook.book.current_page, 85);
});

test('erro permanente 400/404 pausa na fila até ser descartado e destrava os próximos itens', async () => {
  const book = await createBook('Livro Curto', { pages: 100 });
  const store = createMemoryStore();
  const engine = createSyncEngine({ store, transport: makeLiveTransport() });
  await engine.init();

  const bad = await engine.enqueue({
    kind: 'progress',
    book,
    payload: { page: 150, on_day: '2026-11-22' },
    expected: { status: null, current_page: null },
    waitMs: 500,
  });
  assert.equal(bad.status, 'error');
  assert.equal(engine.getState().blockedItem.state, 'error');

  await engine.enqueue({
    kind: 'quote',
    book,
    payload: { text: 'Trecho válido depois do erro.', page: 10 },
    expected: null,
    waitMs: 500,
  });
  assert.equal(engine.getState().pendingCount, 2);

  await engine.discardItem(engine.getState().blockedItem.seq);
  assert.equal(engine.getState().pendingCount, 0);

  const page = (await apiJson('GET', `/books/${book.id}`)).json;
  assert.equal(page.quotes.length, 1);
  assert.equal(page.quotes[0].text, 'Trecho válido depois do erro.');
});

test('trava entre abas impede envios simultâneos da mesma fila', async () => {
  const book = await createBook('Livro Duas Abas');
  const store = createMemoryStore();
  let lockChain = Promise.resolve();
  const sharedLock = (fn) => {
    const run = lockChain.then(fn, fn);
    lockChain = run.catch(() => {});
    return run;
  };

  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const live = makeLiveTransport();
  const serializedTransport = async (req) => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 40));
    try {
      return await live(req);
    } finally {
      inFlight -= 1;
    }
  };

  const tabA = createSyncEngine({ store, transport: serializedTransport, lock: sharedLock });
  const tabB = createSyncEngine({ store, transport: serializedTransport, lock: sharedLock });
  await tabA.init();
  await tabB.init();

  await store.add({
    op_id: 'tab-shared-op',
    kind: 'quote',
    book_id: book.id,
    book_title: book.title,
    book_snapshot: book,
    method: 'POST',
    path: `/books/${encodeURIComponent(book.id)}/quotes`,
    payload: { text: 'Sem duplicar entre abas.', page: 5 },
    expected: null,
    created_at: '2026-11-22T12:00:00Z',
    state: 'pending',
    error: null,
    force: false,
  });

  await Promise.all([tabA.flush({ reason: 'tabA' }), tabB.flush({ reason: 'tabB' })]);
  assert.equal(maxInFlight, 1);
  assert.equal(calls, 1);
  assert.equal((await apiJson('GET', `/books/${book.id}`)).json.quotes.length, 1);
});

test('patchDataWithConfirmed atualiza cache em memória sem perder a mudança confirmada', async () => {
  const book = await createBook('Livro Cache Confirmado', { pages: 200 });
  const cachedHome = (await apiJson('GET', '/home')).json;
  const cachedBook = (await apiJson('GET', `/books/${book.id}`)).json;
  const cachedShelfAll = (await apiJson('GET', '/shelf?status=all')).json;
  const cachedQuotes = (await apiJson('GET', '/quotes')).json;
  const cachedProfile = (await apiJson('GET', '/profile')).json;

  const memory = new Map([
    ['/home', { data: cachedHome, fromCache: true }],
    [`/books/${book.id}`, { data: cachedBook, fromCache: true }],
    ['/shelf?status=all', { data: cachedShelfAll, fromCache: true }],
    ['/quotes', { data: cachedQuotes, fromCache: true }],
    ['/profile', { data: cachedProfile, fromCache: true }],
  ]);

  const store = createMemoryStore();
  const engine = createSyncEngine({
    store,
    transport: makeLiveTransport(),
    onItemConfirmed: (item, serverResult) => {
      for (const [path, entry] of memory.entries()) {
        const patched = patchDataWithConfirmed(path, entry.data, item, serverResult);
        if (patched !== entry.data) memory.set(path, { data: patched, fromCache: false });
      }
    },
  });
  await engine.init();

  await engine.enqueue({
    kind: 'progress',
    book,
    payload: { page: 55, on_day: '2026-11-22' },
    expected: { status: null, current_page: null },
  });
  await engine.enqueue({
    kind: 'quote',
    book: memory.get(`/books/${book.id}`).data.book,
    payload: { text: 'Confirmado na memória.', page: 55 },
    expected: null,
  });

  assert.equal(memory.get('/home').fromCache, false);
  assert.equal(memory.get('/home').data.reading.find((b) => b.id === book.id)?.current_page, 55);
  assert.equal(memory.get(`/books/${book.id}`).data.book.current_page, 55);
  assert.equal(memory.get(`/books/${book.id}`).data.quotes.length, 1);
  assert.equal(memory.get('/shelf?status=all').data.find((b) => b.id === book.id)?.status, 'reading');
  assert.equal(memory.get('/quotes').data[0].text, 'Confirmado na memória.');
  assert.equal(memory.get('/profile').data.counts.quotes, cachedProfile.counts.quotes + 1);
  assert.equal(memory.get('/profile').data.counts.reading, cachedProfile.counts.reading + 1);
});
