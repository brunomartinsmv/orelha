// Servidor HTTP: controle de acesso, API JSON, capas em cache e arquivos estáticos.
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { COVERS_DIR, db, setSetting } from './db.js';
import * as lib from './library.js';
import { HttpError } from './library.js';
import { importData } from './importers.js';
import { USER_AGENT, VERSION } from './version.js';

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');
const MAX_JSON = 1 * 1024 * 1024;
const MAX_UPLOAD = 12 * 1024 * 1024;
const MAX_CSV = 30 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

const normalizeIp = (ip) => ip.trim().toLowerCase().replace(/^::ffff:/, '');

export function createApp(config) {
  const allowedIps = new Set(Object.values(config.allowedDevices || {}).flat().map(normalizeIp));
  const port = config.port;
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (config.tailnetHost) {
    allowedHosts.add(config.tailnetHost);
    allowedHosts.add(`${config.tailnetHost}:${config.publicPort}`);
  }

  // O servidor só escuta em 127.0.0.1. Quem vem da tailnet passa pelo `tailscale serve`,
  // que acrescenta o IP real do cliente ao fim do X-Forwarded-For. Só esse último vale:
  // os anteriores podem ter sido forjados pelo cliente.
  function accessError(req) {
    if (!allowedHosts.has(req.headers.host)) return 'host';
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const client = normalizeIp(String(forwarded).split(',').pop());
      if (!allowedIps.has(client)) return 'device';
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
      let originHost = null;
      try { originHost = new URL(req.headers.origin).host; } catch { /* inválido */ }
      if (!allowedHosts.has(originHost)) return 'origin';
    }
    return null;
  }

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const names = [];
    const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
    routes.push({ method, regex, names, handler, opts });
  };
  const id = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new HttpError(400, 'ID inválido.');
    return n;
  };

  // O pid deixa os scripts de serviço confirmarem que quem responde é o processo que acabaram de subir.
  route('GET', '/api/health', () => ({ ok: true, version: VERSION, pid: process.pid }));
  route('GET', '/api/genres', () => lib.listGenres());
  route('GET', '/api/search', ({ query }) => lib.search(query.get('q')));
  route('GET', '/api/home', () => lib.home());
  route('GET', '/api/discover', () => lib.discover());
  route('GET', '/api/profile', () => lib.profile());
  route('GET', '/api/shelf', ({ query }) => lib.shelfList({ status: query.get('status'), q: query.get('q') }));
  route('GET', '/api/diary', ({ query }) => lib.diary({ year: query.get('year') }));
  route('GET', '/api/diary/calendar', ({ query }) => lib.diaryCalendar(query.get('month')));
  route('GET', '/api/stats', ({ query }) => lib.stats({ year: query.get('year') }));
  route('GET', '/api/quotes', () => lib.allQuotes());

  route('POST', '/api/books', ({ body }) => lib.createManualBook(body));
  route('GET', '/api/books/:id', ({ params }) => lib.bookPage(params.id));
  route('GET', '/api/books/:id/related', ({ params }) => lib.relatedRails(params.id));
  route('PATCH', '/api/books/:id', ({ params, body }) => lib.updateBook(params.id, body));
  route('PUT', '/api/books/:id/shelf', ({ params, body }) => lib.updateShelf(params.id, body));
  route('POST', '/api/books/:id/progress', ({ params, body }) => lib.addProgress(params.id, body));
  route('POST', '/api/books/:id/logs', ({ params, body }) => lib.createLog(params.id, body));
  route('POST', '/api/books/:id/quotes', ({ params, body }) => lib.addQuote(params.id, body));
  route('POST', '/api/books/:id/cover', ({ params, raw }) => uploadCover(params.id, raw), { raw: MAX_UPLOAD });
  route('PATCH', '/api/logs/:id', ({ params, body }) => lib.updateLog(id(params.id), body));
  route('DELETE', '/api/logs/:id', ({ params }) => lib.deleteLog(id(params.id)));
  route('DELETE', '/api/quotes/:id', ({ params }) => lib.deleteQuote(id(params.id)));

  route('GET', '/api/lists', () => lib.allLists());
  route('POST', '/api/lists', ({ body }) => lib.createList(body));
  route('GET', '/api/lists/:id', ({ params }) => lib.getList(id(params.id)));
  route('PATCH', '/api/lists/:id', ({ params, body }) => lib.updateList(id(params.id), body));
  route('DELETE', '/api/lists/:id', ({ params }) => lib.deleteList(id(params.id)));
  route('POST', '/api/lists/:id/items', ({ params, body }) => lib.addListItem(id(params.id), String(body.book_id)));
  route('DELETE', '/api/lists/:id/items/:bookId', ({ params }) => lib.removeListItem(id(params.id), params.bookId));

  route('PUT', '/api/favorites/:slot', ({ params, body }) => lib.setFavorite(id(params.slot), body.book_id ?? null));
  route('PUT', '/api/settings', ({ body }) => {
    if (body.name !== undefined) setSetting('name', String(body.name).trim().slice(0, 60) || null);
    if (body.goal !== undefined) {
      const goal = Number(body.goal);
      if (body.goal !== null && (!Number.isInteger(goal) || goal < 1 || goal > 1000)) throw new HttpError(400, 'Meta inválida.');
      setSetting('goal', body.goal === null ? null : goal);
      setSetting('goal_is_demo', null);
    }
    return lib.profile();
  });
  route('POST', '/api/import', ({ raw }) => importData(raw.toString('utf8')), { raw: MAX_CSV });
  route('POST', '/api/demo/clear', () => { lib.clearDemoData(); return { ok: true }; });

  route('GET', '/api/export.json', ({ res }) => {
    res.setHeader('Content-Disposition', `attachment; filename="orelha-${new Date().toISOString().slice(0, 10)}.json"`);
    return lib.exportAll();
  });
  route('GET', '/api/export.csv', ({ res }) => {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="orelha-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    res.end(`﻿${lib.exportCsv()}`);
    return undefined;
  });

  function uploadCover(bookId, raw) {
    if (!lib.getBookRow(bookId)) throw new HttpError(404, 'Livro não encontrado.');
    const ext = sniffImage(raw);
    if (!ext) throw new HttpError(400, 'Use uma imagem JPEG, PNG ou WebP.');
    const name = `up-${randomUUID()}.${ext}`;
    writeFileSync(join(COVERS_DIR, name), raw);
    db.prepare('UPDATE books SET cover_file = ?, color = NULL WHERE id = ?').run(name, bookId);
    return lib.presentBook(lib.getBookRow(bookId));
  }

  async function handleApi(req, res, url) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = url.pathname.match(r.regex);
      if (!match) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(match[i + 1])]));
      const ctx = { params, query: url.searchParams, res };
      if (r.opts.raw) ctx.raw = await readBody(req, r.opts.raw);
      else if (['POST', 'PUT', 'PATCH'].includes(req.method)) ctx.body = parseJson(await readBody(req, MAX_JSON));
      const result = await r.handler(ctx);
      if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
      return;
    }
    throw new HttpError(404, 'Rota não encontrada.');
  }

  const server = createServer(async (req, res) => {
    const denied = accessError(req);
    if (denied) return sendDenied(res, denied);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    let url;
    try {
      url = new URL(req.url, 'http://orelha.local');
    } catch {
      return sendJson(res, 400, { error: 'URL inválida.' });
    }
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname.startsWith('/covers/')) return await serveCover(req, res, url);
      return serveStatic(req, res, url);
    } catch (err) {
      const status = err.status || (err.upstream ? 502 : 500);
      if (status >= 500) console.error(`${req.method} ${url.pathname}:`, err);
      if (res.headersSent) return res.end();
      const message = status === 502
        ? 'Não consegui falar com a Open Library agora. Tente de novo em instantes.'
        : err.status ? err.message : 'Algo deu errado aqui no servidor.';
      sendJson(res, status, { error: message, ...(err.extra || {}) });
    }
  });
  return server;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sendDenied(res, reason) {
  const detail = reason === 'device'
    ? 'Este aparelho não está na lista de <code>allowedDevices</code> do <code>config.json</code>.'
    : 'Origem da requisição não reconhecida.';
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Orelha</title><body style="font:16px system-ui;padding:2rem"><h1>Sem acesso</h1><p>${detail}</p>`);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Arquivo grande demais.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(buffer) {
  if (!buffer.length) return {};
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// ---- Capas: baixa da Open Library uma vez e serve do disco para sempre ----

const inFlight = new Map();
const misses = new Map();
const MISS_TTL = 6 * 3600_000;

function sendImage(res, path, status = 200) {
  const ext = extname(path);
  res.writeHead(status, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': statSync(path).size,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  createReadStream(path).pipe(res);
}

async function downloadCover(kind, value, size, target) {
  const url = `https://covers.openlibrary.org/b/${kind}/${value}-${size}.jpg?default=false`;
  const upstream = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!upstream.ok) return false;
  const buf = Buffer.from(await upstream.arrayBuffer());
  if (!sniffImage(buf) || buf.length < 1000) return false; // a OL às vezes devolve um pixel
  const tmp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, target);
  return true;
}

async function serveCover(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // covers, kind, value
  const [, kind, value] = parts;
  if (parts.length !== 3) throw new HttpError(404, 'Capa não encontrada.');

  if (kind === 'file') {
    if (!/^up-[0-9a-f-]+\.(jpg|png|webp)$/.test(value)) throw new HttpError(404, 'Capa não encontrada.');
    const path = join(COVERS_DIR, value);
    if (!existsSync(path)) throw new HttpError(404, 'Capa não encontrada.');
    return sendImage(res, path);
  }

  const size = url.searchParams.get('s') === 'L' ? 'L' : 'M';
  const valid = (kind === 'id' && /^\d{1,12}$/.test(value)) || (kind === 'isbn' && /^[\dXx]{10,13}$/.test(value));
  if (!valid) throw new HttpError(404, 'Capa não encontrada.');

  const key = `${kind}-${value}-${size}`;
  const target = join(COVERS_DIR, `${key}.jpg`);
  if (existsSync(target)) return sendImage(res, target);

  if (misses.get(key) > Date.now()) throw new HttpError(404, 'Sem capa.');
  if (!inFlight.has(key)) {
    inFlight.set(key, downloadCover(kind, value, size, target).finally(() => inFlight.delete(key)));
  }
  const ok = await inFlight.get(key);
  if (!ok) {
    misses.set(key, Date.now() + MISS_TTL);
    throw new HttpError(404, 'Sem capa.');
  }
  return sendImage(res, target);
}

// ---- Estáticos, com fallback para o index.html (rotas do app) ----

function serveStatic(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Método não permitido.');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'URL inválida.');
  }
  const candidate = normalize(join(PUBLIC_DIR, pathname));
  const isInside = candidate === PUBLIC_DIR || candidate.startsWith(PUBLIC_DIR + sep);
  let path = isInside && existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
  if (!path) {
    if (extname(pathname)) throw new HttpError(404, 'Arquivo não encontrado.');
    path = join(PUBLIC_DIR, 'index.html');
  }
  const ext = extname(path);
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  // Fontes e ícones não mudam; o resto revalida (o service worker cuida do uso offline).
  headers['Cache-Control'] = ['.woff2', '.woff', '.png'].includes(ext) ? 'public, max-age=2592000' : 'no-cache';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  res.end(readFileSync(path));
}

