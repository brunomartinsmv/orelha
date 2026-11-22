import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'orelha-test-'));
process.env.ORELHA_DATA_DIR = dataDir;
process.env.ORELHA_NO_ENRICH = '1'; // testes não falam com a Open Library
process.env.ORELHA_NO_QUOTES = '1';

const { createApp } = await import('../server/app.js');
const { db } = await import('../server/db.js');
const { parseCsv, normalizeDate, enrichImported } = await import('../server/importers.js');
const { upsertFromOl } = await import('../server/library.js');

const MAC = '100.64.0.10';
const IPHONE_V6 = 'fd7a:115c:a1e0::10';
const OTHER_DEVICE = '100.64.0.99';
const HOST = 'mac.example.ts.net';

let server, base, port;

before(async () => {
  // A porta precisa ser conhecida antes, porque entra na lista de hosts permitidos.
  port = 40000 + Math.floor(Math.random() * 20000);
  server = createApp({
    port,
    publicPort: 8443,
    tailnetHost: HOST,
    allowedDevices: { macbook: [MAC], iphone: [IPHONE_V6] },
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML */ }
  return { status: res.status, json, text };
}

const newBook = async (title = 'Livro', extra = {}) =>
  (await call('POST', '/books', { title, authors: 'Fulana de Tal', pages: 300, ...extra })).json;

// fetch não deixa trocar o header Host, então usamos http cru.
async function rawGet(path, headers) {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('aceita o Mac e o iPhone (IPv6) vindos da tailnet', async () => {
  const health = await call('GET', '/health', undefined, { 'X-Forwarded-For': MAC });
  assert.equal(health.status, 200);
  assert.equal(health.json.pid, process.pid);
  assert.equal((await call('GET', '/health', undefined, { 'X-Forwarded-For': IPHONE_V6 })).status, 200);
});

test('recusa outro aparelho da tailnet', async () => {
  assert.equal((await call('GET', '/health', undefined, { 'X-Forwarded-For': OTHER_DEVICE })).status, 403);
});

test('um X-Forwarded-For forjado não engana: só vale o último IP', async () => {
  const spoofed = `${MAC}, ${OTHER_DEVICE}`;
  assert.equal((await call('GET', '/health', undefined, { 'X-Forwarded-For': spoofed })).status, 403);
});

test('recusa Host desconhecido (DNS rebinding) e aceita o da tailnet', async () => {
  assert.equal(await rawGet('/api/health', { Host: 'evil.example.com' }), 403);
  assert.equal(await rawGet('/api/health', { Host: `${HOST}:8443`, 'X-Forwarded-For': MAC }), 200);
});

test('recusa escrita vinda de outra origem', async () => {
  const res = await call('POST', '/books', { title: 'x' }, { Origin: 'https://evil.example.com' });
  assert.equal(res.status, 403);
  const ok = await call('POST', '/books', { title: 'x' }, { Origin: `https://${HOST}:8443` });
  assert.equal(ok.status, 200);
});

test('não sai da pasta pública nem da pasta de capas', async () => {
  const host = { Host: `127.0.0.1:${port}` };
  assert.equal(await rawGet('/..%2f..%2fconfig.json', host), 404);
  assert.equal(await rawGet('/covers/file/..%2f..%2forelha.sqlite', host), 404);
  assert.equal(await rawGet('/covers/id/abc', host), 404);
});

test('registrar leitura põe no diário e marca como lido', async () => {
  const book = await newBook('Diário 1');
  await call('PUT', `/books/${book.id}/shelf`, { status: 'reading' });
  const log = await call('POST', `/books/${book.id}/logs`, { rating: 7, finished_on: '2026-03-05', review: ' bom ', liked: true });
  assert.equal(log.status, 200);
  assert.equal(log.json.review, 'bom');

  const page = (await call('GET', `/books/${book.id}`)).json;
  assert.equal(page.book.status, 'read');
  assert.equal(page.book.liked, true);
  assert.equal(page.book.rating, 7);
  assert.ok(page.logs[0].started_on, 'herda a data em que começou a ler');

  const diary = (await call('GET', '/diary?year=2026')).json;
  assert.ok(diary.entries.some((e) => e.book.id === book.id));
});

test('apagar o último registro tira o livro de Lidos; com outro registro, não', async () => {
  const book = await newBook('Diário 2');
  const a = (await call('POST', `/books/${book.id}/logs`, { finished_on: '2026-01-01' })).json;
  const b = (await call('POST', `/books/${book.id}/logs`, { finished_on: '2026-02-01', reread: true })).json;
  await call('DELETE', `/logs/${a.id}`);
  assert.equal((await call('GET', `/books/${book.id}`)).json.book.status, 'read');
  await call('DELETE', `/logs/${b.id}`);
  assert.equal((await call('GET', `/books/${book.id}`)).json.book.status, null);
});

test('valida nota, datas e intervalo', async () => {
  const book = await newBook('Validação');
  assert.equal((await call('POST', `/books/${book.id}/logs`, { rating: 11 })).status, 400);
  assert.equal((await call('POST', `/books/${book.id}/logs`, { rating: 2.5 })).status, 400);
  assert.equal((await call('POST', `/books/${book.id}/logs`, { finished_on: 'ontem' })).status, 400);
  assert.equal((await call('POST', `/books/${book.id}/logs`, { started_on: '2026-02-02', finished_on: '2026-02-01' })).status, 400);
  assert.equal((await call('POST', `/books/inexistente/logs`, {})).status, 404);
});

test('progresso não passa do total de páginas e põe o livro em Lendo', async () => {
  const book = await newBook('Progresso');
  assert.equal((await call('POST', `/books/${book.id}/progress`, { page: 301 })).status, 400);
  const ok = await call('POST', `/books/${book.id}/progress`, { page: 120, on_day: '2026-04-01' });
  assert.equal(ok.json.status, 'reading');
  assert.equal(ok.json.current_page, 120);
});

test('números do ano somam leituras, páginas e meias estrelas', async () => {
  const a = await newBook('Stats A', { pages: 100 });
  const b = await newBook('Stats B', { pages: 200 });
  await call('POST', `/books/${a.id}/logs`, { rating: 10, finished_on: '2019-03-10', started_on: '2019-03-01' });
  await call('POST', `/books/${b.id}/logs`, { rating: 5, finished_on: '2019-03-20' });
  const s = (await call('GET', '/stats?year=2019')).json;
  assert.equal(s.books, 2);
  assert.equal(s.pages, 300);
  assert.equal(s.average_rating, 3.75);
  assert.equal(s.months[2].books, 2);
  assert.equal(s.ratings[9], 1);
  assert.equal(s.average_days, 10);
  assert.equal(s.longest.id, b.id);
});

test('favoritos: um livro ocupa só um lugar', async () => {
  const book = await newBook('Favorito');
  await call('PUT', '/favorites/1', { book_id: book.id });
  const after = (await call('PUT', '/favorites/3', { book_id: book.id })).json;
  assert.equal(after[0], null);
  assert.equal(after[2].id, book.id);
  assert.equal((await call('PUT', '/favorites/9', { book_id: book.id })).status, 400);
  await call('PUT', '/favorites/3', { book_id: null });
});

test('listas: adiciona sem duplicar, reordena e remove', async () => {
  const list = (await call('POST', '/lists', { title: 'Praia', ranked: true })).json;
  const a = await newBook('Lista A');
  const b = await newBook('Lista B');
  await call('POST', `/lists/${list.id}/items`, { book_id: a.id });
  await call('POST', `/lists/${list.id}/items`, { book_id: b.id });
  const dup = (await call('POST', `/lists/${list.id}/items`, { book_id: a.id })).json;
  assert.equal(dup.books.length, 2);
  const reordered = (await call('PATCH', `/lists/${list.id}`, { order: [b.id, a.id] })).json;
  assert.deepEqual(reordered.books.map((x) => x.id), [b.id, a.id]);
  const removed = (await call('DELETE', `/lists/${list.id}/items/${a.id}`)).json;
  assert.equal(removed.books.length, 1);
});

test('parseCsv lida com aspas, vírgulas e quebras de linha', () => {
  const rows = parseCsv('﻿Title,Note\r\n"A, B","linha 1\nlinha ""2"""\r\nC,\r\n');
  assert.deepEqual(rows, [{ Title: 'A, B', Note: 'linha 1\nlinha "2"' }, { Title: 'C', Note: '' }]);
});

const GOODREADS = `Book Id,Title,Author,Additional Authors,ISBN,ISBN13,My Rating,Number of Pages,Year Published,Original Publication Year,Date Read,Bookshelves,Exclusive Shelf,My Review,Spoiler,Read Count
1,Importado Um,Ana Autora,,"=""123456789X""","=""9781234567897""",4,321,2001,1999,2024/02/15,,read,"Ótimo, recomendo",,1
2,Importado Dois,Bia Autora,,"=""""","=""""",0,,,,,,to-read,,,0
`;

test('importa Goodreads sem duplicar ao repetir', async () => {
  const first = (await call('POST', '/import', GOODREADS)).json;
  assert.equal(first.format, 'Goodreads');
  assert.equal(first.books_added, 2);
  assert.equal(first.logs_added, 1);

  const again = (await call('POST', '/import', GOODREADS)).json;
  assert.equal(again.books_added, 0);
  assert.equal(again.logs_added, 0);

  const read = (await call('GET', '/shelf?status=read&q=Importado')).json;
  assert.equal(read.length, 1);
  assert.equal(read[0].rating, 8);
  assert.equal(read[0].isbn, '9781234567897');
  assert.equal(read[0].last_finished, '2024-02-15');
  assert.equal((await call('GET', '/shelf?status=want&q=Importado')).json.length, 1);
});

test('importa StoryGraph, com quartos de estrela arredondados', async () => {
  const csv = `Title,Authors,ISBN/UID,Format,Read Status,Last Date Read,Dates Read,Read Count,Star Rating,Review
Grafo Um,"Cris Autora, Dani Autora",9780000000017,paperback,read,2025/06/01,2025/05/01-2025/06/01,1,3.75,Legal
`;
  const r = (await call('POST', '/import', csv)).json;
  assert.equal(r.format, 'StoryGraph');
  const [book] = (await call('GET', '/shelf?status=read&q=Grafo')).json;
  assert.equal(book.rating, 8);
  const page = (await call('GET', `/books/${book.id}`)).json;
  assert.equal(page.logs[0].started_on, '2025-05-01');
  assert.equal(page.logs[0].format, 'paper');
});

test('recusa CSV desconhecido', async () => {
  assert.equal((await call('POST', '/import', 'a,b\n1,2\n')).status, 400);
});

test('capa enviada precisa ser imagem de verdade', async () => {
  const book = await newBook('Capa');
  const bad = await fetch(`${base}/api/books/${book.id}/cover`, { method: 'POST', body: '<svg onload=alert(1)></svg>' });
  assert.equal(bad.status, 400);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const ok = await (await fetch(`${base}/api/books/${book.id}/cover`, { method: 'POST', body: png })).json();
  assert.match(ok.cover, /^\/covers\/file\/up-[0-9a-f-]+\.png$/);
  const served = await fetch(`${base}${ok.cover}`);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
});

test('exportação CSV neutraliza fórmulas de planilha', async () => {
  const book = await newBook('Planilha');
  await call('POST', `/books/${book.id}/logs`, { review: '=HYPERLINK("x")', finished_on: '2026-01-01' });
  const { text } = await call('GET', '/export.csv');
  assert.ok(text.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(!/,=HYPERLINK/.test(text));
});

test('"Começar do zero" remove a demonstração e preserva o que é seu', async () => {
  const demo = await newBook('Demo');
  const mine = await newBook('Meu');
  db.prepare(`INSERT INTO shelf (book_id, status, demo) VALUES (?, 'read', 1)`).run(demo.id);
  db.prepare(`INSERT INTO logs (book_id, finished_on, rating, demo) VALUES (?, '2026-01-01', 8, 1)`).run(demo.id);
  await call('POST', `/books/${mine.id}/logs`, { rating: 6, finished_on: '2026-01-02' });
  assert.equal((await call('GET', '/home')).json.demo, true);

  await call('POST', '/demo/clear', {});
  assert.equal((await call('GET', '/home')).json.demo, false);
  assert.equal((await call('GET', `/books/${demo.id}`)).json.book.status, null);
  assert.equal((await call('GET', `/books/${demo.id}`)).json.logs.length, 0);
  assert.equal((await call('GET', `/books/${mine.id}`)).json.logs.length, 1);
});

test('a meta muda sozinha, sem mexer no nome, e pode ser removida', async () => {
  await call('PUT', '/settings', { name: 'Leitora' });
  await call('PUT', '/settings', { goal: 24 });
  assert.equal((await call('GET', '/home')).json.goal.target, 24);
  assert.equal((await call('GET', '/profile')).json.name, 'Leitora');
  assert.equal((await call('PUT', '/settings', { goal: 0 })).status, 400);
  assert.equal((await call('PUT', '/settings', { goal: 2.5 })).status, 400);
  assert.equal((await call('GET', '/home')).json.goal.target, 24);

  await call('PUT', '/settings', { goal: null });
  assert.equal((await call('GET', '/home')).json.goal.target, null);
});

test('JSON malformado vira 400, não 500', async () => {
  assert.equal((await call('POST', '/books', '{quebrado')).status, 400);
});

test('na home, atualizar a página não troca os livros de lugar e a citação vem do Wikiquote', async () => {
  const first = await newBook('Começado antes');
  const second = await newBook('Começado depois');
  await call('POST', `/books/${first.id}/progress`, { page: 10, on_day: '2026-01-02' });
  await call('POST', `/books/${second.id}/progress`, { page: 10, on_day: '2026-02-02' });
  const order = async () => (await call('GET', '/home')).json.reading.map((b) => b.title).filter((t) => t.startsWith('Começado'));
  const before = await order();
  await call('POST', `/books/${before[1] === first.title ? first.id : second.id}/progress`, { page: 50, on_day: '2026-03-01' });
  assert.deepEqual(await order(), before);

  const done = await newBook('Já lido');
  await call('POST', `/books/${done.id}/quotes`, { text: 'Trecho de um livro fechado.' });
  await call('POST', `/books/${first.id}/quotes`, { text: 'Trecho do livro aberto.' });
  db.prepare('INSERT INTO api_cache (key, value, expires_at) VALUES (?, ?, ?)').run(
    `wikiquote:page:v1:${first.title}`,
    JSON.stringify({ title: first.title, text: `Livro de Fulana de Tal.\n* "Citação publicada na fonte do livro."` }),
    Date.now() + 86_400_000,
  );
  const { quote } = (await call('GET', '/home')).json;
  assert.equal(quote.book.id, first.id);
  assert.equal(quote.text, 'Citação publicada na fonte do livro.');
  assert.equal(quote.source.name, 'Wikiquote');
  assert.deepEqual((await call('GET', '/home')).json.quote, quote);
});

test('edição de ISBN, sinopse e gêneros atualiza estante e fica protegida da Open Library', async () => {
  const genresRes = await call('GET', '/genres');
  assert.equal(genresRes.status, 200);
  assert.ok(genresRes.json.some((g) => g.id === 'scifi' && g.label === 'Ficção científica'));

  assert.equal((await call('POST', '/books', { title: 'ISBN Ruim', isbn: '123' })).status, 400);

  const created = await newBook('Livro Editável', {
    isbn: '978-85-359-0277-8',
    description: 'Sinopse inicial.',
    subjects: ['Literatura brasileira', 'Sertão'],
  });
  assert.equal(created.isbn, '9788535902778');
  assert.equal(created.cover, '/covers/isbn/9788535902778');

  await call('PUT', `/books/${created.id}/shelf`, { status: 'read' });
  let page = (await call('GET', `/books/${created.id}`)).json;
  assert.equal(page.book.description, 'Sinopse inicial.');
  assert.deepEqual(page.book.genres, ['brazilian']);
  assert.deepEqual(page.book.other_subjects, ['Sertão']);

  assert.equal((await call('PATCH', `/books/${created.id}`, { isbn: 'invalido' })).status, 400);

  const updated = await call('PATCH', `/books/${created.id}`, {
    isbn: '85-359-0277-X',
    description: 'Sinopse revisada pelo leitor.',
    subjects: ['Ficção científica', 'Mistério', 'Memória'],
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.isbn, '853590277X');

  page = (await call('GET', `/books/${created.id}`)).json;
  assert.equal(page.book.description, 'Sinopse revisada pelo leitor.');
  assert.deepEqual(page.book.genres, ['scifi', 'mystery']);
  assert.deepEqual(page.book.other_subjects, ['Memória']);

  const [onShelf] = (await call('GET', '/shelf?status=read&q=Livro Editável')).json;
  assert.deepEqual(onShelf.genres, ['scifi', 'mystery']);

  // Livro vindo da Open Library editado pelo usuário não perde sinopse/gêneros ao buscar detalhes.
  upsertFromOl({
    ol_key: 'OL999999W',
    title: 'Obra OL',
    title_is_pt: 1,
    original_title: null,
    subtitle: null,
    authors: ['Autora OL'],
    year: 2020,
    pages: 200,
    isbn: null,
    cover_id: null,
    subjects: [],
  });
  await call('PATCH', '/books/OL999999W', { description: '', subjects: [] });
  for (const [key, val] of [
    ['https://openlibrary.org/works/OL999999W.json', { title: 'Obra OL', description: 'Texto da OL', subjects: ['Fantasy'], covers: [42] }],
    ['https://openlibrary.org/works/OL999999W/ratings.json', { summary: { average: null, count: 0 } }],
    ['https://openlibrary.org/works/OL999999W/bookshelves.json', { counts: {} }],
  ]) {
    db.prepare('INSERT INTO api_cache (key, value, expires_at) VALUES (?, ?, ?)').run(key, JSON.stringify(val), Date.now() + 86_400_000);
  }
  const olPage = (await call('GET', '/books/OL999999W')).json;
  assert.equal(olPage.book.description, null);
  assert.deepEqual(olPage.book.subjects, []);
  assert.equal(olPage.book.cover, '/covers/id/42');
});

test('parseCsv detecta ponto-e-vírgula automaticamente', () => {
  const rows = parseCsv('Título;Autor;Nota\r\n"A; B";Fulano;4,5\r\n');
  assert.deepEqual(rows, [{ Título: 'A; B', Autor: 'Fulano', Nota: '4,5' }]);
});

test('importa CSV do Skoob (formato Goodreads com Bookshelves e formato em português) sem duplicar', async () => {
  const skoobGr = `Title,Author,ISBN,ISBN13,My Rating,Number of Pages,Year Published,Date Read,Bookshelves,My Review
Skoob Um,Marina Autora,,9788500000101,"4,5",280,2021,15/08/2024,"lido, favoritos",Muito bom
Skoob Dois,Pedro Autor,,9788500000102,0,190,2022,,abandonei,
Skoob Tres,Lia Autora,,9788500000103,0,310,2023,,quero-ler,
`;
  const first = (await call('POST', '/import', skoobGr)).json;
  assert.equal(first.format, 'Skoob');
  assert.equal(first.books_added, 3);
  assert.equal(first.logs_added, 1);

  const again = (await call('POST', '/import', skoobGr)).json;
  assert.equal(again.books_added, 0);
  assert.equal(again.logs_added, 0);

  const [readBook] = (await call('GET', '/shelf?status=read&q=Skoob Um')).json;
  assert.equal(readBook.rating, 9);
  assert.equal(readBook.liked, true);
  assert.equal(readBook.last_finished, '2024-08-15');
  assert.equal((await call('GET', '/shelf?status=dropped&q=Skoob Dois')).json.length, 1);
  assert.equal((await call('GET', '/shelf?status=want&q=Skoob Tres')).json.length, 1);

  const skoobPt = `Título;Autor;ISBN;Páginas;Ano;Estante;Nota;Lido em;Resenha
Skoob Quatro;Clara Autora;9788500000104;215;2018;Lido;5;03/11/2025;Adorei
`;
  const ptRes = (await call('POST', '/import', skoobPt)).json;
  assert.equal(ptRes.format, 'Skoob');
  assert.equal(ptRes.books_added, 1);
  assert.equal(ptRes.logs_added, 1);
  const [ptBook] = (await call('GET', '/shelf?status=read&q=Skoob Quatro')).json;
  assert.equal(ptBook.rating, 10);
  assert.equal(ptBook.last_finished, '2025-11-03');
});

test('reimporta o próprio CSV do Orelha e restaura backup JSON completo de forma idempotente', async () => {
  const b1 = await newBook('Backup Um', {
    isbn: '9788500000201',
    description: 'Sinopse para backup.',
    subjects: ['Literatura brasileira', 'Sertão'],
    pages: 350,
    year: 2019,
  });
  const b2 = await newBook('Backup Dois', { pages: 180 });
  await call('POST', `/books/${b1.id}/logs`, {
    rating: 9,
    finished_on: '2025-07-10',
    started_on: '2025-07-01',
    review: 'Excelente leitura',
    spoilers: true,
    reread: true,
    format: 'paper',
    liked: true,
  });
  await call('POST', `/books/${b2.id}/progress`, { page: 45, on_day: '2025-07-12' });
  await call('POST', `/books/${b1.id}/quotes`, { text: 'Frase marcante do backup.', page: 123 });
  const list = (await call('POST', '/lists', { title: 'Lista do Backup', description: 'Top', ranked: true })).json;
  await call('POST', `/lists/${list.id}/items`, { book_id: b2.id });
  await call('POST', `/lists/${list.id}/items`, { book_id: b1.id });
  await call('PUT', '/favorites/2', { book_id: b1.id });

  const exportedJson = (await call('GET', '/export.json')).json;
  const exportedCsv = (await call('GET', '/export.csv')).text;

  // Limpa as tabelas para simular restauração num banco zerado.
  db.exec(`
    DELETE FROM favorites;
    DELETE FROM list_items;
    DELETE FROM lists;
    DELETE FROM quotes;
    DELETE FROM progress;
    DELETE FROM logs;
    DELETE FROM shelf;
    DELETE FROM books;
  `);

  const restored = (await call('POST', '/import', JSON.stringify(exportedJson))).json;
  assert.equal(restored.format, 'Orelha (JSON)');
  assert.ok(restored.books_added >= 2);
  assert.ok(restored.logs_added >= 1);
  assert.ok(restored.quotes_added >= 1);
  assert.ok(restored.lists_added >= 1);

  const page1 = (await call('GET', `/books/${b1.id}`)).json;
  assert.equal(page1.book.description, 'Sinopse para backup.');
  assert.deepEqual(page1.book.genres, ['brazilian']);
  assert.equal(page1.book.liked, true);
  assert.equal(page1.logs[0].rating, 9);
  assert.equal(page1.logs[0].spoilers, true);
  assert.equal(page1.logs[0].reread, true);
  assert.equal(page1.logs[0].format, 'paper');
  assert.equal(page1.quotes[0].text, 'Frase marcante do backup.');
  assert.equal(page1.quotes[0].page, 123);
  assert.equal(page1.favorite_slot, 2);

  const page2 = (await call('GET', `/books/${b2.id}`)).json;
  assert.equal(page2.book.status, 'reading');
  assert.equal(page2.book.current_page, 45);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress WHERE book_id = ?').get(b2.id).n, 1);

  const lists = (await call('GET', '/lists')).json;
  const restoredList = (await call('GET', `/lists/${lists.find((l) => l.title === 'Lista do Backup').id}`)).json;
  assert.equal(restoredList.ranked, true);
  assert.deepEqual(restoredList.books.map((b) => b.id), [b2.id, b1.id]);

  // Repetir a importação do mesmo JSON não duplica nada.
  const repeat = (await call('POST', '/import', JSON.stringify(exportedJson))).json;
  assert.equal(repeat.books_added, 0);
  assert.equal(repeat.logs_added, 0);
  assert.equal(repeat.quotes_added, 0);
  assert.equal(repeat.lists_added, 0);

  // Reimportar o próprio CSV exportado também é reconhecido e idempotente.
  db.exec(`DELETE FROM logs; DELETE FROM shelf; DELETE FROM books;`);
  const csvRestored = (await call('POST', '/import', exportedCsv)).json;
  assert.equal(csvRestored.format, 'Orelha (CSV)');
  assert.ok(csvRestored.books_added >= 2);
  assert.ok(csvRestored.logs_added >= 1);
  const csvRepeat = (await call('POST', '/import', exportedCsv)).json;
  assert.equal(csvRepeat.books_added, 0);
  assert.equal(csvRepeat.logs_added, 0);

  // Recusa JSON inválido ou de outro formato.
  assert.equal((await call('POST', '/import', '{quebrado')).status, 400);
  assert.equal((await call('POST', '/import', JSON.stringify({ app: 'outro', books: [] }))).status, 400);
});

test('PATCH com ISBN inválido é atômico e alterar capa por ISBN limpa a cor anterior', async () => {
  const book = await newBook('Título Original', { isbn: '9788500000301' });
  await call('PATCH', `/books/${book.id}`, { color: '#112233' });
  assert.equal((await call('GET', `/books/${book.id}`)).json.book.color, '#112233');

  const bad = await call('PATCH', `/books/${book.id}`, { title: 'Não Deve Salvar', isbn: '123' });
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', `/books/${book.id}`)).json.book.title, 'Título Original');

  const ok = await call('PATCH', `/books/${book.id}`, { isbn: '9788500000302' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.color, null);
});

test('CSV malformado rejeita aspas abertas; datas BR e reimportação de leituras manuais/sem data funcionam', async () => {
  assert.equal(normalizeDate('15/08/2024'), '2024-08-15');
  assert.equal(normalizeDate('31/02/2024'), null);
  assert.equal((await call('POST', '/import', 'Title,Author,Bookshelves\n"Aberto,Fulano,lido')).status, 400);

  // Duas leituras sem data de término no banco de origem -> export CSV -> reimportar no mesmo banco não duplica.
  const b = await newBook('Sem Data Duplo', { isbn: '9788500000401' });
  await call('POST', `/books/${b.id}/logs`, { rating: 6, review: 'Primeira vez' });
  await call('POST', `/books/${b.id}/logs`, { rating: 10, review: 'Segunda vez', reread: true });
  // Leitura concluída com started_on antigo não pode vazar para shelf.started_on ao importar.
  const bHist = await newBook('Histórico 2021', { isbn: '9788500000402' });
  await call('POST', `/books/${bHist.id}/logs`, { rating: 8, started_on: '2021-01-10', finished_on: '2021-02-01' });

  const csv = (await call('GET', '/export.csv')).text;
  const sameDb = (await call('POST', '/import', csv)).json;
  assert.equal(sameDb.logs_added, 0);
  assert.equal((await call('GET', `/books/${b.id}`)).json.logs.length, 2);

  // Em banco vazio, ambas as leituras sem data são preservadas e shelf.started_on fica nulo para livro lido.
  db.exec('DELETE FROM logs; DELETE FROM shelf; DELETE FROM books;');
  const fresh = (await call('POST', '/import', csv)).json;
  assert.ok(fresh.logs_added >= 3);
  const [restoredDouble] = (await call('GET', '/shelf?status=read&q=Sem Data Duplo')).json;
  assert.equal((await call('GET', `/books/${restoredDouble.id}`)).json.logs.length, 2);
  const [restoredHist] = (await call('GET', '/shelf?status=read&q=Histórico 2021')).json;
  assert.equal(restoredHist.started_on, null);

  // Repetir a importação no banco recém-restaurado também não duplica.
  assert.equal((await call('POST', '/import', csv)).json.logs_added, 0);

  // Fallback de ISBN em CSV em português quando ISBN13 é inválido.
  const ptFallback = `Título;Autor;ISBN13;ISBN10;Estante\nFallback BR;Autora;N/A;8535902775;quero-ler\n`;
  assert.equal((await call('POST', '/import', ptFallback)).json.books_added, 1);
  const [fb] = (await call('GET', '/shelf?status=want&q=Fallback BR')).json;
  assert.equal(fb.isbn, '8535902775');
});

test('restauração JSON preserva identidades distintas, favoritos sem estante, cronologia, demo e user_edited', async () => {
  db.exec(`
    DELETE FROM favorites; DELETE FROM list_items; DELETE FROM lists;
    DELETE FROM quotes; DELETE FROM progress; DELETE FROM logs; DELETE FROM shelf; DELETE FROM books;
  `);

  // Dois volumes com mesmo prefixo antes de ":", dois logs idênticos sem data, duas listas homônimas,
  // livro favoritado sem estante, cronologia de notas sem finished_on, e um livro demo.
  const vol1 = await newBook('Coleção: Volume I', { authors: 'Ana', isbn: '9788500000501' });
  const vol2 = await newBook('Coleção: Volume II', { authors: 'Ana', isbn: '9788500000502' });
  const favOnly = await newBook('Só Favorito');
  await call('PUT', '/favorites/1', { book_id: favOnly.id });

  await call('POST', `/books/${vol1.id}/logs`, { rating: 4 });
  await call('POST', `/books/${vol1.id}/logs`, { rating: 4 });
  // Leitura antiga (nota 4) vs mais recente (nota 10), ambas sem finished_on:
  db.prepare(`INSERT INTO logs (book_id, rating, created_at) VALUES (?, 4, '2024-01-01 10:00:00')`).run(vol2.id);
  db.prepare(`INSERT INTO logs (book_id, rating, created_at) VALUES (?, 10, '2025-06-01 10:00:00')`).run(vol2.id);
  await call('PUT', `/books/${vol2.id}/shelf`, { status: 'read' });

  const l1 = (await call('POST', '/lists', { title: 'Mesmo Nome', description: 'Primeira', ranked: true })).json;
  const l2 = (await call('POST', '/lists', { title: 'Mesmo Nome', description: 'Segunda', ranked: false })).json;
  await call('POST', `/lists/${l1.id}/items`, { book_id: vol1.id });
  await call('POST', `/lists/${l2.id}/items`, { book_id: vol2.id });

  const demoBook = await newBook('Livro Exemplo');
  db.prepare(`INSERT INTO shelf (book_id, status, demo) VALUES (?, 'want', 1)`).run(demoBook.id);

  // Livro vindo da OL editado pelo usuário no backup.
  upsertFromOl({
    ol_key: 'OL777777W', title: 'Original OL', title_is_pt: 0, original_title: null, subtitle: null,
    authors: ['Autor'], year: 2000, pages: 150, isbn: null, cover_id: 99, subjects: ['Fantasy'],
  });
  await call('PATCH', '/books/OL777777W', { title: 'Título Editado', subjects: ['Mistério'] });
  await call('PUT', '/books/OL777777W/shelf', { status: 'read' });

  const backup = (await call('GET', '/export.json')).json;
  assert.ok(backup.books.some((b) => b.id === favOnly.id), 'livro só em favorites entra no export');

  // Limpa banco e coloca apenas o cache não-editado da OL para OL777777W.
  db.exec(`
    DELETE FROM favorites; DELETE FROM list_items; DELETE FROM lists;
    DELETE FROM quotes; DELETE FROM progress; DELETE FROM logs; DELETE FROM shelf; DELETE FROM books;
  `);
  upsertFromOl({
    ol_key: 'OL777777W', title: 'Original OL', title_is_pt: 0, original_title: null, subtitle: null,
    authors: ['Autor'], year: 2000, pages: 150, isbn: null, cover_id: 99, subjects: ['Fantasy'],
  });

  const restored = (await call('POST', '/import', JSON.stringify(backup))).json;
  assert.equal(restored.skipped, 0);
  assert.equal((await call('GET', `/books/${vol1.id}`)).json.logs.length, 2);
  assert.equal((await call('GET', `/books/${vol2.id}`)).json.book.rating, 10);
  assert.equal((await call('GET', `/books/${favOnly.id}`)).json.favorite_slot, 1);
  assert.equal((await call('GET', '/lists')).json.filter((l) => l.title === 'Mesmo Nome').length, 2);
  assert.equal((await call('GET', '/home')).json.demo, true);

  // A edição do backup prevalece sobre o cache não editado da OL.
  const olRestored = (await call('GET', '/books/OL777777W')).json;
  assert.equal(olRestored.book.title, 'Título Editado');
  assert.deepEqual(olRestored.book.subjects, ['Mistério']);

  // Segunda importação do mesmo backup é idempotente.
  const second = (await call('POST', '/import', JSON.stringify(backup))).json;
  assert.equal(second.books_added, 0);
  assert.equal(second.logs_added, 0);
  assert.equal(second.lists_added, 0);

  // Se o leitor limpar sinopse/assuntos localmente (user_edited = 1), restaurar um backup antigo não repõe.
  await call('PATCH', `/books/${vol1.id}`, { description: '', subjects: [] });
  await call('POST', '/import', JSON.stringify({
    ...backup,
    books: backup.books.map((b) => (b.id === vol1.id ? { ...b, description: 'Voltou?', subjects: '["Fantasia"]' } : b)),
  }));
  const afterLocalClear = (await call('GET', `/books/${vol1.id}`)).json;
  assert.equal(afterLocalClear.book.description, null);
  assert.deepEqual(afterLocalClear.book.subjects, []);

  // Referências órfãs (ex.: favorito de backup antigo sem livro) são contabilizadas em skipped.
  const orphan = (await call('POST', '/import', JSON.stringify({
    app: 'orelha',
    books: [],
    favorites: [{ slot: 4, book_id: 'inexistente' }],
    lists: [{ title: 'Lista sem ID' }],
    list_items: [{ book_id: vol1.id, position: 0 }],
  }))).json;
  assert.equal(orphan.skipped, 2);

  // Enriquecimento em segundo plano respeita user_edited = 1 (não apaga subjects do leitor).
  const imp = await newBook('Importado Editado', { subjects: ['Terror'] });
  db.prepare(`UPDATE books SET source = 'import', details_at = NULL, ol_key = NULL WHERE id = ?`).run(imp.id);
  const fields = 'key,title,subtitle,author_name,first_publish_year,cover_i,number_of_pages_median,isbn,subject,editions,editions.title,editions.cover_i,editions.language,editions.isbn,ratings_average,ratings_count,readinglog_count,author_alternative_name';
  for (const [q, limit] of [['Importado Editado Fulana de Tal', '20'], ['Importado Editado Fulana de Tal language:por', '15']]) {
    const params = new URLSearchParams({ q, limit, fields, lang: 'por' });
    db.prepare('INSERT OR REPLACE INTO api_cache (key, value, expires_at) VALUES (?, ?, ?)').run(
      `https://openlibrary.org/search.json?${params}`,
      JSON.stringify({ docs: [{ key: '/works/OL888888W', title: 'Importado Editado', author_name: ['Fulana de Tal'], cover_i: 55, subject: ['Fantasy'] }] }),
      Date.now() + 86_400_000,
    );
  }
  delete process.env.ORELHA_NO_ENRICH;
  try {
    await enrichImported();
  } finally {
    process.env.ORELHA_NO_ENRICH = '1';
  }
  const enrichedRow = db.prepare('SELECT subjects, cover_id FROM books WHERE id = ?').get(imp.id);
  assert.deepEqual(JSON.parse(enrichedRow.subjects), ['Terror']);
  assert.equal(enrichedRow.cover_id, 55);
});

test('reserva IDs do backup no fallback por ISBN, preserva títulos não latinos, edições pós-CSV, releitura e 13+ autores', async () => {
  db.exec(`
    DELETE FROM favorites; DELETE FROM list_items; DELETE FROM lists;
    DELETE FROM quotes; DELETE FROM progress; DELETE FROM logs; DELETE FROM shelf; DELETE FROM books;
  `);

  // 1) Dois livros no backup com o mesmo ISBN, sendo que só o segundo (B) existe no destino.
  const bookA = await newBook('Edição A', { authors: 'Autora A', isbn: '9788500000601' });
  const bookB = await newBook('Edição B', { authors: 'Autora B', isbn: '9788500000601' });
  await call('POST', `/books/${bookA.id}/logs`, { rating: 6, review: 'Resenha de A', finished_on: '2025-01-01' });
  await call('POST', `/books/${bookB.id}/logs`, { rating: 10, review: 'Resenha de B', finished_on: '2025-02-01' });

  // 2) Coletânea com 13 autores preservada no round-trip JSON e CSV.
  const manyAuthors = Array.from({ length: 13 }, (_, i) => `Autora ${i + 1}`).join(', ');
  const anthology = await newBook('Coletânea 13', { authors: manyAuthors });
  await call('PUT', `/books/${anthology.id}/shelf`, { status: 'want' });

  const backup = (await call('GET', '/export.json')).json;
  // Remove A e coletânea, deixando apenas B no destino.
  db.prepare('DELETE FROM books WHERE id IN (?, ?)').run(bookA.id, anthology.id);

  const res = (await call('POST', '/import', JSON.stringify(backup))).json;
  assert.equal(res.books_added, 2);
  assert.equal((await call('GET', `/books/${bookA.id}`)).json.logs[0].review, 'Resenha de A');
  assert.equal((await call('GET', `/books/${bookB.id}`)).json.logs.length, 1);
  assert.equal((await call('GET', `/books/${bookB.id}`)).json.logs[0].review, 'Resenha de B');
  assert.equal((await call('GET', `/books/${anthology.id}`)).json.book.authors.length, 13);
  assert.equal((await call('POST', '/import', JSON.stringify(backup))).json.logs_added, 0);

  // 3) Reimportar CSV do Goodreads após editar a nota localmente não duplica nem reverte a nota.
  const gr = `Book Id,Title,Author,Additional Authors,ISBN,ISBN13,My Rating,Number of Pages,Year Published,Original Publication Year,Date Read,Bookshelves,Exclusive Shelf,My Review,Spoiler,Read Count
9,Editado Local,Autora GR,,,,4,200,2020,2020,2025/03/01,,read,,,1
`;
  assert.equal((await call('POST', '/import', gr)).json.logs_added, 1);
  const [grBook] = (await call('GET', '/shelf?status=read&q=Editado Local')).json;
  const grPage = (await call('GET', `/books/${grBook.id}`)).json;
  await call('PATCH', `/logs/${grPage.logs[0].id}`, { rating: 10, finished_on: '2025-03-01' });
  assert.equal((await call('POST', '/import', gr)).json.logs_added, 0);
  assert.equal((await call('GET', `/books/${grBook.id}`)).json.book.rating, 10);

  // 4) Título em escrita não latina (japonês) sem ISBN não duplica ao reimportar.
  const jp = `Title,Author,Bookshelves,Date Read\n新雪,藤沢周平,read,2025-04-01\n`;
  assert.equal((await call('POST', '/import', jp)).json.books_added, 1);
  const jpAgain = (await call('POST', '/import', jp)).json;
  assert.equal(jpAgain.books_added, 0);
  assert.equal(jpAgain.logs_added, 0);

  // 5) Livro lido em 2021 e relido em 2026: CSV do Orelha não copia 2021 para shelf.started_on.
  const rereadBook = await newBook('Releitura 2026', { isbn: '9788500000602' });
  await call('POST', `/books/${rereadBook.id}/logs`, { rating: 8, started_on: '2021-01-05', finished_on: '2021-01-20' });
  await call('PUT', `/books/${rereadBook.id}/shelf`, { status: 'reading', started_on: '2026-11-21' });
  const rereadCsv = (await call('GET', '/export.csv')).text;
  db.exec('DELETE FROM logs; DELETE FROM shelf; DELETE FROM books;');
  await call('POST', '/import', rereadCsv);
  const [restoredReread] = (await call('GET', '/shelf?status=reading&q=Releitura 2026')).json;
  assert.notEqual(restoredReread.started_on, '2021-01-05');
  assert.equal((await call('GET', `/books/${restoredReread.id}`)).json.logs[0].started_on, '2021-01-05');
});
