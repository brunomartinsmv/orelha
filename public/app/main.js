import { html, render, useEffect, useState } from '/vendor/htm-preact.js';
import { initRouter, initSync, onOffline, plural, syncNow, useRoute, useSyncState } from './lib.js';
import { SyncSheet } from './sheets.js';
import { Icon, ThemeToggle, Toaster } from './ui.js';
import { HomeView } from './views/home.js';
import { SearchView } from './views/search.js';
import { BookView } from './views/book.js';
import { ShelfView } from './views/shelf.js';
import { DiscoverView } from './views/discover.js';
import { YouView, QuotesView } from './views/you.js';
import { StatsView } from './views/stats.js';
import { ListsView, ListView } from './views/lists.js';
import { SettingsView } from './views/settings.js';

function match(path) {
  const m = (re) => path.match(re);
  let r;
  if (path === '/') return { view: HomeView, tab: 'home' };
  if (path === '/buscar') return { view: SearchView, tab: 'search' };
  if ((r = m(/^\/livro\/([^/]+)$/))) return { view: BookView, props: { id: decodeURIComponent(r[1]) }, key: r[1] };
  if (path === '/estante') return { view: ShelfView, tab: 'shelf' };
  if (path === '/diario') return { view: ShelfView, props: { focus: 'diary' }, tab: 'shelf' };
  if (path === '/descobrir') return { view: DiscoverView, tab: 'discover' };
  if (path === '/voce') return { view: YouView, tab: 'you' };
  if (path === '/numeros') return { view: StatsView, tab: 'you' };
  if (path === '/trechos') return { view: QuotesView, tab: 'you' };
  if (path === '/listas') return { view: ListsView, tab: 'you' };
  if ((r = m(/^\/listas\/(\d+)$/))) return { view: ListView, props: { id: r[1] }, tab: 'you', key: r[1] };
  if (path === '/ajustes') return { view: SettingsView, tab: 'you' };
  return { view: NotFound };
}

function NotFound() {
  return html`<main class="page"><div class="empty" style="margin-top:40px"><h3>Esta página caiu atrás da estante</h3><a class="btn" href="/">Voltar ao início</a></div></main>`;
}

function TabBar({ tab }) {
  const item = (id, href, label, icon) => html`<a class=${`tab ${tab === id ? 'active' : ''}`} href=${href} aria-current=${tab === id ? 'page' : undefined}>${icon}<span>${label}</span></a>`;
  const isSearch = tab === 'search';
  return html`<nav class="tabbar" aria-label="Principal">
    <a class="logo desktop-logo" href="/"><${Icon.logo} /> orelha</a>
    ${item('home', '/', 'Início', html`<${Icon.home} />`)}
    ${item('shelf', '/estante', 'Livros', html`<${Icon.shelf} />`)}
    <a class=${`tab-add ${isSearch ? 'active' : ''}`} href="/buscar" aria-label="Buscar e registrar um livro" aria-current=${isSearch ? 'page' : undefined}><${Icon.plus} /><span>Registrar</span></a>
    ${item('discover', '/descobrir', 'Descobrir', html`<${Icon.compass} />`)}
    ${item('you', '/voce', 'Você', html`<${Icon.you} />`)}
    <${ThemeToggle} className="desktop-only" />
  </nav>`;
}

// No iPhone (PWA standalone com viewport-fit=cover), o WebKit na abertura às vezes posiciona
// elementos fixed/bottom:0 descontando a barra de status até o primeiro scrollTo(0, 0).
function settleViewport() {
  if (window.innerWidth >= 820 || window.scrollY !== 0) return;
  if (document.body.classList.contains('locked')) return;
  if (document.activeElement?.matches?.('input, textarea, select')) return;
  window.scrollTo(0, 0);
  const bar = document.querySelector('.tabbar');
  if (bar) {
    bar.style.bottom = '-0.5px';
    requestAnimationFrame(() => { bar.style.bottom = ''; });
  }
}

function SyncStatusPill({ offline, onOpen }) {
  const { syncing, blockedItem, pendingCount } = useSyncState();
  if (!offline && !pendingCount) return null;

  const hasError = !!blockedItem;
  const cls = `offline-pill sync-pill ${hasError ? 'has-error' : pendingCount ? 'has-pending' : ''}`;

  let label;
  if (blockedItem?.state === 'conflict') {
    label = 'Conflito na sincronização · revisar';
  } else if (blockedItem?.state === 'error') {
    label = 'Falha ao sincronizar · revisar';
  } else if (syncing) {
    label = 'Sincronizando…';
  } else if (pendingCount > 0) {
    label = offline
      ? `Sem conexão · ${plural(pendingCount, 'pendente', 'pendentes')}`
      : `${plural(pendingCount, 'alteração aguardando', 'alterações aguardando')} sincronização`;
  } else {
    label = 'Sem conexão · página, trechos e status ficam na fila';
  }

  if (!pendingCount) {
    return html`<div class=${cls} role="status">${label}</div>`;
  }

  return html`<div class=${cls} role="status">
    <button type="button" class="sync-pill-main" onClick=${onOpen}>
      <span class="sync-dot" aria-hidden="true"></span>
      <span>${label}</span>
    </button>
    ${!hasError && !syncing && html`<button type="button" class="sync-pill-btn" onClick=${() => syncNow()}>Sincronizar</button>`}
  </div>`;
}

function App() {
  const { path, search } = useRoute();
  const [offline, setOffline] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  useEffect(() => onOffline(setOffline), []);
  useEffect(() => {
    const kick = () => requestAnimationFrame(settleViewport);
    kick();
    const t1 = setTimeout(settleViewport, 100);
    const t2 = setTimeout(settleViewport, 360);
    document.fonts?.ready?.then(settleViewport);
    window.addEventListener('pageshow', kick);
    document.addEventListener('visibilitychange', kick);
    window.visualViewport?.addEventListener('resize', kick);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener('pageshow', kick);
      document.removeEventListener('visibilitychange', kick);
      window.visualViewport?.removeEventListener('resize', kick);
    };
  }, []);
  const { view: View, props, tab, key } = match(path);
  return html`<div class="app">
    <${SyncStatusPill} offline=${offline} onOpen=${() => setSyncOpen(true)} />
    <${View} key=${key || path} search=${search} ...${props} />
    <${TabBar} tab=${tab} />
    ${syncOpen && html`<${SyncSheet} onClose=${() => setSyncOpen(false)} />`}
    <${Toaster} />
  </div>`;
}

initRouter();
initSync().catch(() => {}).finally(() => {
  render(html`<${App} />`, document.getElementById('root'));
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* só disponível em HTTPS ou localhost */ });
}
