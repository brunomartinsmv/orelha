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
const { parseCsv } = await import('../server/importers.js');

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
