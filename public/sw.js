// Mantém o app abrindo e mostrando a última cópia dos dados quando o servidor está fora do ar.
const VERSION = 'orelha-v10';
const SHELL = `${VERSION}-shell`;
// O shell novo continua lendo os dados guardados antes da atualização.
const DATA = 'orelha-v9-data';
const COVERS = 'orelha-covers-v1';

const SHELL_FILES = [
  '/', '/styles.css', '/manifest.webmanifest', '/vendor/htm-preact.js',
  '/app/main.js', '/app/lib.js', '/app/sync.js', '/app/ui.js', '/app/sheets.js', '/app/peek.js', '/app/spine.js',
  '/app/views/home.js', '/app/views/search.js', '/app/views/book.js', '/app/views/shelf.js',
  '/app/views/diary.js', '/app/views/discover.js', '/app/views/you.js', '/app/views/stats.js', '/app/views/lists.js',
  '/app/views/settings.js',
  '/fonts/young-serif.woff2', '/fonts/literata.woff2', '/fonts/literata-italic.woff2', '/fonts/instrument-sans.woff2',
  '/fonts/bebas-neue.woff2', '/fonts/syncopate-bold.woff2', '/fonts/cinzel.woff', '/fonts/abril-fatface.woff2', '/fonts/playfair-italic.woff',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, DATA, COVERS]);
    await Promise.all((await caches.keys()).filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Rede primeiro, com prazo: sem o servidor, o Tailscale deixa a requisição pendurada em vez de falhar.
async function networkFirst(request, cacheName, timeoutMs, cacheKey = request) {
  const cache = await caches.open(cacheName);
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put(cacheKey, res.clone());
    return res;
  });
  const cached = await cache.match(cacheKey);
  if (!cached) return network;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  // Servidor fora do ar responde 502 pelo Tailscale: isso também conta como "sem servidor".
  const usable = network.then((res) => (res.status >= 500 ? null : res)).catch(() => null);
  const winner = await Promise.race([usable, timeout]);
  if (winner) return winner;
  const headers = new Headers(cached.headers);
  headers.set('X-Orelha-Offline', '1');
  return new Response(cached.body, { status: cached.status, headers });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.startsWith('/covers/')) {
    event.respondWith(caches.open(COVERS).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok) cache.put(request, res.clone());
      return res;
    }));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.startsWith('/api/export') || url.pathname === '/api/search') return;
    event.respondWith(networkFirst(request, DATA, 3500));
    return;
  }
  // Qualquer rota do app abre o mesmo index.html.
  const isPage = request.mode === 'navigate';
  event.respondWith(networkFirst(request, SHELL, 2500, isPage ? '/' : request));
});
