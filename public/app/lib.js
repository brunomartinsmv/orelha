import { useEffect, useMemo, useState } from '/vendor/htm-preact.js';
import {
  affectedPathsForOp,
  applyPendingToPath,
  classifyHttpResponse,
  createIndexedDbStore,
  createMemoryStore,
  createSyncEngine,
  patchDataWithConfirmed,
} from './sync.js';

// ---------- API ----------

const listeners = { invalidate: new Set(), patch: new Set(), route: new Set(), toast: new Set(), offline: new Set(), theme: new Set() };
const emit = (name, value) => listeners[name].forEach((fn) => fn(value));
const subscribe = (name, fn) => { listeners[name].add(fn); return () => listeners[name].delete(fn); };

export let isOffline = false;
function setOffline(value) {
  if (value !== isOffline) { isOffline = value; emit('offline', value); }
}

async function apiDetailed(path, { method = 'GET', body, raw, signal } = {}) {
  let res;
  // Com o servidor fora do ar o Tailscale não recusa a conexão, ela só fica pendurada: precisa de prazo.
  const deadline = AbortSignal.timeout(raw ? 120_000 : 25_000);
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    setOffline(true);
    throw new Error('Sem conexão com o servidor. Ele está ligado e o Tailscale conectado?');
  }
  const fromCache = res.headers.get('X-Orelha-Offline') === '1';
  setOffline(fromCache);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || 'Algo deu errado.');
  return { data, fromCache };
}

export async function api(path, opts) {
  const { data } = await apiDetailed(path, opts);
  return data;
}

export const onOffline = (fn) => subscribe('offline', fn);
export const invalidate = () => emit('invalidate');

// Mostra a última resposta na hora e revalida ao montar ou após qualquer mudança.
const memory = new Map();

// ---------- Fila de sincronização offline ----------

const tabId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const LOCK_KEY = 'orelha.sync.lock';
const PING_KEY = 'orelha.sync.ping';
const BACKOFF_MS = [5_000, 10_000, 20_000, 30_000, 60_000];
let backoffStep = 0;
let retryTimer = null;
let syncChannel = null;
let syncInitialized = false;

function makeStore() {
  if (typeof indexedDB !== 'undefined') return createIndexedDbStore('orelha-offline');
  return createMemoryStore();
}

async function browserTransport({ method, path, body }) {
  const res = await fetch(`/api${path}`, {
    method,
    signal: AbortSignal.timeout(8_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return classifyHttpResponse(res, data);
}

async function browserLock(fn) {
  if (navigator?.locks?.request) {
    return navigator.locks.request('orelha-sync', fn);
  }
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (raw) {
      const held = JSON.parse(raw);
      if (held && held.owner !== tabId && held.expiresAt > Date.now()) return undefined;
    }
    localStorage.setItem(LOCK_KEY, JSON.stringify({ owner: tabId, expiresAt: Date.now() + 20_000 }));
  } catch { /* modo privado */ }
  try {
    return await fn();
  } finally {
    try {
      const raw = localStorage.getItem(LOCK_KEY);
      const held = raw ? JSON.parse(raw) : null;
      if (held?.owner === tabId) localStorage.removeItem(LOCK_KEY);
    } catch { /* modo privado */ }
  }
}

function broadcastSync() {
  if (syncChannel) {
    try { syncChannel.postMessage({ source: tabId, at: Date.now() }); } catch { /* canal fechado */ }
    return;
  }
  try { localStorage.setItem(PING_KEY, `${tabId}:${Date.now()}`); } catch { /* modo privado */ }
}

async function revalidateAffectedCaches(confirmedOps) {
  if (!confirmedOps?.length || typeof caches === 'undefined') return;
  try {
    const dataKeys = (await caches.keys()).filter((k) => k.endsWith('-data'));
    if (!dataKeys.length) return;
    const opened = await Promise.all(dataKeys.map((k) => caches.open(k)));
    const paths = new Set(confirmedOps.flatMap(affectedPathsForOp));
    await Promise.all([...paths].map(async (path) => {
      const reqUrl = `/api${path}`;
      const matched = await Promise.all(opened.map((cache) => cache.match(reqUrl)));
      if (matched.some(Boolean)) {
        await fetch(reqUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
      }
    }));
  } catch { /* revalidação em segundo plano */ }
}

const sync = createSyncEngine({
  store: makeStore(),
  transport: browserTransport,
  lock: browserLock,
  broadcast: broadcastSync,
  onStatusChange: ({ offline }) => {
    if (typeof offline === 'boolean') setOffline(offline);
  },
  onItemConfirmed: (item, serverResult) => {
    setOffline(false);
    for (const [path, entry] of memory.entries()) {
      const patched = patchDataWithConfirmed(path, entry.data, item, serverResult);
      if (patched !== entry.data) memory.set(path, { data: patched, fromCache: false });
    }
    emit('patch');
  },
  onDrained: (confirmedOps) => {
    invalidate();
    revalidateAffectedCaches(confirmedOps);
  },
});

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry(state = sync.getState()) {
  clearRetryTimer();
  if (!state.pendingCount || state.blockedItem || state.syncing) return;
  if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
  const delay = BACKOFF_MS[Math.min(backoffStep, BACKOFF_MS.length - 1)];
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const current = sync.getState();
    if (!current.pendingCount || current.blockedItem || document.visibilityState !== 'visible') return;
    backoffStep = Math.min(backoffStep + 1, BACKOFF_MS.length - 1);
    sync.flush({ reason: 'timer' }).catch(() => {});
  }, delay);
}

// Outra aba mexeu na fila: recarrega os itens e os dados, para que uma confirmação feita lá
// não faça esta aba voltar a mostrar a versão antiga (e gerar conflito falso na próxima edição).
function refreshFromOtherTab() {
  sync.reloadFromStore().catch(() => {}).finally(() => invalidate());
}

export async function initSync() {
  if (syncInitialized) return sync.getState();
  syncInitialized = true;

  if (typeof BroadcastChannel !== 'undefined') {
    try {
      syncChannel = new BroadcastChannel('orelha-sync');
      syncChannel.addEventListener('message', (event) => {
        if (event.data?.source !== tabId) refreshFromOtherTab();
      });
    } catch { syncChannel = null; }
  }
  window.addEventListener('storage', (event) => {
    if (event.key === PING_KEY) refreshFromOtherTab();
  });

  sync.subscribe((state) => {
    if (!state.pendingCount || state.blockedItem) {
      backoffStep = 0;
      clearRetryTimer();
      return;
    }
    if (!state.syncing) scheduleRetry(state);
  });

  const resume = (reason) => {
    backoffStep = 0;
    clearRetryTimer();
    const state = sync.getState();
    if (state.pendingCount > 0 && !state.blockedItem) {
      sync.flush({ reason }).catch(() => {});
    } else if (reason === 'online' || (reason === 'focus' && isOffline)) {
      invalidate();
    }
  };

  window.addEventListener('online', () => resume('online'));
  window.addEventListener('focus', () => resume('focus'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume('visible');
    else clearRetryTimer();
  });

  let state;
  try {
    state = await sync.init();
  } catch {
    return sync.getState();
  }
  if (state.pendingCount > 0 && !state.blockedItem) {
    sync.flush({ reason: 'startup' }).catch(() => {});
  }
  return state;
}

export function useSyncState() {
  const [state, setState] = useState(() => sync.getState());
  useEffect(() => {
    setState(sync.getState());
    return sync.subscribe(setState);
  }, []);
  return state;
}

const fastWait = () => (navigator.onLine === false || isOffline ? 0 : 1200);

export function queueProgress(book, { page, on_day }) {
  backoffStep = 0;
  return sync.enqueue({
    kind: 'progress',
    book,
    payload: { page, on_day },
    expected: { status: book.status ?? null, current_page: book.current_page ?? null },
    waitMs: fastWait(),
  });
}

export function queueQuote(book, { text, page }) {
  backoffStep = 0;
  return sync.enqueue({
    kind: 'quote',
    book,
    payload: { text, page },
    expected: null,
    waitMs: fastWait(),
  });
}

export function queueShelfStatus(book, status) {
  backoffStep = 0;
  return sync.enqueue({
    kind: 'shelf',
    book,
    payload: { status, on_day: localDate() },
    expected: { status: book.status ?? null, current_page: book.current_page ?? null },
    waitMs: fastWait(),
  });
}

export function syncNow() {
  backoffStep = 0;
  clearRetryTimer();
  return sync.flush({ reason: 'manual' });
}

export function retrySyncItem(seq, opts) {
  backoffStep = 0;
  clearRetryTimer();
  return sync.retryItem(seq, opts);
}

export function discardSyncItem(seq) {
  backoffStep = 0;
  clearRetryTimer();
  return sync.discardItem(seq);
}

export function useFetch(path) {
  const syncState = useSyncState();
  const [state, setState] = useState(() => ({
    raw: path ? memory.get(path)?.data : undefined,
    error: null,
    loading: !!path,
  }));
  const [version, setVersion] = useState(0);

  useEffect(() => subscribe('invalidate', () => setVersion((v) => v + 1)), []);
  useEffect(() => subscribe('patch', () => {
    if (!path) return;
    const entry = memory.get(path);
    if (entry) setState((s) => (s.raw === entry.data ? s : { ...s, raw: entry.data }));
  }), [path]);

  useEffect(() => {
    if (!path) { setState({ raw: undefined, error: null, loading: false }); return undefined; }
    const controller = new AbortController();
    const cached = memory.get(path)?.data;
    setState((s) => ({ raw: cached ?? (version ? s.raw : undefined), error: null, loading: true }));
    apiDetailed(path, { signal: controller.signal })
      .then(({ data, fromCache }) => {
        const prev = memory.get(path);
        if (fromCache && prev && !prev.fromCache) {
          setState({ raw: prev.data, error: null, loading: false });
          return;
        }
        memory.set(path, { data, fromCache });
        setState({ raw: data, error: null, loading: false });
      })
      .catch((error) => { if (error.name !== 'AbortError') setState((s) => ({ ...s, error, loading: false })); });
    return () => controller.abort();
  }, [path, version]);

  const data = useMemo(
    () => (state.raw ? applyPendingToPath(path, state.raw, syncState.items) : state.raw),
    [path, state.raw, syncState.items],
  );

  return { data, error: state.error, loading: state.loading };
}

// ---------- Rotas ----------

const scrollByPath = new Map();

// Uma camada por cima da página (o livro aberto da estante) ganha uma entrada no histórico:
// o gesto de voltar fecha a camada em vez de sair da página.
let closeOverlay = null;
let ownPop = false;

export function pushOverlay(onBack) {
  closeOverlay = onBack;
  history.pushState({ overlay: true }, '', location.href);
}

// Fechou pela interface: tira a entrada que a camada pôs no histórico.
export function popOverlay() {
  if (!closeOverlay) return;
  closeOverlay = null;
  ownPop = true;
  history.back();
}

export function navigate(path, { replace = false } = {}) {
  // Saindo da camada para outra página: a nova página toma o lugar da entrada da camada.
  if (closeOverlay) { closeOverlay = null; replace = true; }
  scrollByPath.set(location.pathname + location.search, window.scrollY);
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  emit('route');
  window.scrollTo(0, 0);
}

export function initRouter() {
  history.scrollRestoration = 'manual';
  window.addEventListener('popstate', () => {
    if (ownPop) { ownPop = false; return; }
    if (closeOverlay) { const close = closeOverlay; closeOverlay = null; close(); return; }
    emit('route');
    const y = scrollByPath.get(location.pathname + location.search) || 0;
    // Espera a tela voltar a ser desenhada antes de restaurar a posição.
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)));
  });
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    const href = link.getAttribute('href');
    if (!href.startsWith('/') || href.startsWith('/api/')) return;
    event.preventDefault();
    navigate(href);
  });
}

export function useRoute() {
  const read = () => ({ path: location.pathname, search: new URLSearchParams(location.search) });
  const [route, setRoute] = useState(read);
  useEffect(() => subscribe('route', () => setRoute(read())), []);
  return route;
}

// ---------- Toast ----------

export const onToast = (fn) => subscribe('toast', fn);
export const toast = (message, kind = 'ok') => emit('toast', { message, kind, id: Date.now() });

// Envolve uma mutação: revalida as telas ou mostra o erro ao usuário.
export async function act(fn, success) {
  try {
    const result = await fn();
    invalidate();
    if (success) toast(success);
    return result ?? true;
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

// ---------- Formatação ----------

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export const monthName = (i) => MONTHS[i];
export const num = (n) => Number(n || 0).toLocaleString('pt-BR');
export const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

export function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Datas são strings AAAA-MM-DD; nada de new Date(str), que deslocaria um dia no fuso do Brasil.
export function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m: m - 1, d, weekday: WEEKDAYS[new Date(y, m - 1, d).getDay()] };
}

export function formatDate(iso) {
  if (!iso) return 'sem data';
  const { y, m, d } = parseDate(iso);
  return `${d} de ${MONTHS_SHORT[m]}. de ${y}`;
}

export const authorLine = (book) => (book.authors || []).join(', ') || 'Autoria desconhecida';
export const coverUrl = (book, size = 'M') => (book.cover ? `${book.cover}${size === 'L' && !book.cover.startsWith('/covers/file') ? '?s=L' : ''}` : null);
export const ratingText = (r) => (r ? `${String(r / 2).replace('.', ',')}` : '');

export const STATUS = {
  want: 'Quero ler',
  reading: 'Lendo',
  read: 'Lido',
  dropped: 'Abandonei',
};

// ---------- Cor ----------

export function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const FALLBACK_TONES = ['#28433b', '#4a2f3d', '#2d3c5b', '#5b4a22', '#5a2f26', '#254a55', '#3f3a5f', '#44512a'];
export const fallbackTone = (book) => FALLBACK_TONES[hash(book.id || book.title) % FALLBACK_TONES.length];

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export const onColor = (hex) => (luminance(hex) > 0.28 ? '#16120c' : '#f6f1e3');

export function hexToHsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// Cor dominante da capa: agrupa pixels e favorece os saturados, ignorando quase-branco e quase-preto.
function dominantColor(img) {
  const canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 36;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 24, 36);
  const { data } = ctx.getImageData(0, 0, 24, 36);
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max ? (max - min) / max : 0;
    if (max > 240 && sat < 0.12) continue;
    if (max < 24) continue;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, w: 0 };
    bucket.r += r; bucket.g += g; bucket.b += b; bucket.n += 1; bucket.w += 1 + sat * 3;
    buckets.set(key, bucket);
  }
  let best = null;
  for (const bucket of buckets.values()) if (!best || bucket.w > best.w) best = bucket;
  return best ? toHex(best.r / best.n, best.g / best.n, best.b / best.n) : null;
}

const colorMemo = new Map();
const colorSubs = new Set();
const queue = [];
let running = 0;

function pump() {
  while (running < 3 && queue.length) {
    const book = queue.shift();
    running++;
    const img = new Image();
    const done = () => { running--; pump(); };
    img.onload = () => {
      try {
        const color = dominantColor(img);
        if (color) {
          colorMemo.set(book.id, color);
          colorSubs.forEach((fn) => fn(book.id));
          fetch(`/api/books/${encodeURIComponent(book.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ color }),
          }).catch(() => {});
        }
      } catch { /* canvas indisponível: fica a cor de reserva */ }
      done();
    };
    img.onerror = done;
    img.src = book.cover;
  }
}

// Cor de um livro: a salva, a recém-extraída ou uma reserva estável enquanto a capa carrega.
export function useBookTone(book) {
  const [, tick] = useState(0);
  const known = book.color || colorMemo.get(book.id);
  useEffect(() => {
    if (known || !book.cover) return undefined;
    const sub = (id) => { if (id === book.id) tick((n) => n + 1); };
    colorSubs.add(sub);
    if (!queue.some((b) => b.id === book.id)) { queue.push(book); pump(); }
    return () => colorSubs.delete(sub);
  }, [book.id, known]);
  return known || fallbackTone(book);
}

export const toneOf = (book) => book.color || colorMemo.get(book.id) || fallbackTone(book);

// ---------- Capas antecipadas ----------

// Baixa a capa grande antes de o livro ser aberto. O servidor guarda em disco; o navegador e o
// service worker guardam para sempre (a URL nunca muda de conteúdo).
const prefetched = new Set();
export function prefetchCover(book) {
  const url = coverUrl(book, 'L');
  if (!url || prefetched.has(url)) return Promise.resolve();
  prefetched.add(url);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = img.onerror = () => resolve();
    img.src = url;
  });
}

// Em fila, duas por vez, só quando o navegador estiver à toa. Devolve como cancelar.
export function prefetchCovers(books, { limit = 80 } = {}) {
  const queue = books.filter((b) => b.cover).slice(0, limit);
  let stopped = false;
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 200));
  const worker = () => {
    if (stopped || !queue.length) return;
    idle(() => { if (!stopped && queue.length) prefetchCover(queue.shift()).then(worker); });
  };
  worker(); worker();
  return () => { stopped = true; };
}

// ---------- Tema ----------

// 'light', 'dark' ou null (segue o sistema). O index.html aplica a escolha antes de desenhar.
const THEME_COLORS = { light: '#f2efe3', dark: '#0e1714' };
export const savedTheme = () => document.documentElement.dataset.theme || null;
export const effectiveTheme = () => savedTheme() || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
export const onTheme = (fn) => subscribe('theme', fn);

export function setTheme(theme) {
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme; else delete root.dataset.theme;
  try { if (theme) localStorage.setItem('orelha.theme', theme); else localStorage.removeItem('orelha.theme'); } catch { /* modo privado */ }
  // A barra do navegador e a do iPhone acompanham.
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    const media = meta.dataset.media || meta.getAttribute('media');
    meta.dataset.media = media;
    if (theme) { meta.removeAttribute('media'); meta.content = THEME_COLORS[theme]; }
    else { meta.setAttribute('media', media); meta.content = THEME_COLORS[media.includes('light') ? 'light' : 'dark']; }
  });
  emit('theme', theme);
}
