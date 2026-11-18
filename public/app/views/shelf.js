import { html, useEffect, useMemo, useRef, useState } from '/vendor/htm-preact.js';
import { authorLine, hash, hexToHsl, num, onColor, plural, prefetchCover, prefetchCovers, toneOf, useBookTone, useFetch } from '../lib.js';
import { spineLayout, surname, useSpineFonts } from '../spine.js';
import { Cover, ErrorBox, Icon, PageHeader, Stars } from '../ui.js';
import { BookPeek } from '../peek.js';
import { DiarySection } from './diary.js';

// O que está sendo lido mora no Início; Abandonei aparece quando houver livros nessa gaveta.
const BASE_FILTERS = [['read', 'Lidos'], ['want', 'Quero ler']];
const VALID_FILTERS = new Set(['read', 'want', 'dropped']);
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const SORTS = {
  // Quem chega na estante vê primeiro os livros que você acha melhores.
  rating: { label: 'Nota', fn: (a, b) => (b.rating || 0) - (a.rating || 0) },
  recent: { label: 'Recentes', fn: null },
  color: {
    label: 'Por cor',
    // Tons quase sem saturação (preto, branco, cinza) vão para o fim, do claro ao escuro.
    fn: (a, b) => {
      const ha = hexToHsl(toneOf(a)), hb = hexToHsl(toneOf(b));
      const ga = ha.s < 0.14, gb = hb.s < 0.14;
      if (ga !== gb) return ga ? 1 : -1;
      return ga ? hb.l - ha.l : ha.h - hb.h;
    },
  },
  author: { label: 'Autor', fn: (a, b) => (surname(a)).localeCompare(surname(b), 'pt') },
  title: { label: 'Título', fn: (a, b) => a.title.localeCompare(b.title, 'pt') },
  pages: { label: 'Páginas', fn: (a, b) => (b.pages || 0) - (a.pages || 0) },
};

const LEAN_ROOM = 16;

// Clique simples abre o livro por cima da estante; com Cmd/Ctrl continua sendo um link.
const opener = (book, onOpen, kind) => (e) => {
  if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault();
  const el = kind === 'spine' ? e.currentTarget : e.currentTarget.querySelector('.cover');
  onOpen(book, el, kind);
};

function Spine({ book, layout, lean, onOpen }) {
  const tone = useBookTone(book);
  const deco = hash(book.id) % 5;
  const label = [book.title, book.authors?.[0], book.rating ? `${book.rating / 2} estrelas` : null].filter(Boolean).join(', ');
  const { style, width, height, size, lines, author } = layout;
  return html`<a class=${`spine ${lean ? 'lean' : ''}`} href=${`/livro/${encodeURIComponent(book.id)}`} aria-label=${label} title=${label}
    onClick=${opener(book, onOpen, 'spine')} onPointerEnter=${() => prefetchCover(book)}
    style=${{
      '--tone': tone, '--on': onColor(tone), '--w': `${width}px`, '--h': `${height}px`, '--fs': `${size.toFixed(2)}px`,
      '--ff': `"${style.ff}"`, '--fw': style.fw, '--fst': style.fst, '--ls': `${style.ls}em`,
    }}>
    ${deco === 0 && html`<span class="band" style="top:6px"></span><span class="band" style="top:11px"></span>`}
    ${deco === 1 && html`<span class="band" style="top:8px"></span><span class="band" style="bottom:8px"></span>`}
    ${deco === 2 && html`<span class="block"></span>`}
    ${deco === 3 && html`<span class="band" style="bottom:6px"></span><span class="band" style="bottom:11px"></span>`}
    <span class="st">${lines.map((line, i) => html`${i > 0 && html`<br />`}${line}`)}</span>
    ${author && html`<span class="sa">${author}</span>`}
  </a>`;
}

function Bookcase({ books, onOpen }) {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    // No próximo quadro, para não redesenhar de dentro do próprio observer.
    const observer = new ResizeObserver(([entry]) => requestAnimationFrame(() => setWidth(entry.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const fonts = useSpineFonts(books);
  const layouts = useMemo(() => new Map(books.map((b) => [b.id, spineLayout(b)])), [books, fonts]);

  const rows = useMemo(() => {
    const available = width - 12;
    if (available <= 0) return [];
    const out = [];
    let row = [], used = 0;
    for (const book of books) {
      const w = layouts.get(book.id).width + 2;
      if (used + w > available && row.length) {
        out.push({ books: row, room: available - used });
        row = []; used = 0;
      }
      row.push(book);
      used += w;
    }
    if (row.length) out.push({ books: row, room: available - used });
    return out;
  }, [books, width, layouts]);

  return html`<div class="bookcase" ref=${ref}>
    ${rows.map((row, r) => html`<div key=${r}>
      <div class="bookrow">
        ${row.books.map((b, i) => html`<${Spine} key=${b.id} book=${b} layout=${layouts.get(b.id)} onOpen=${onOpen} lean=${i === row.books.length - 1 && i > 1 && row.room >= LEAN_ROOM} />`)}
      </div>
      <div class="plank"></div>
    </div>`)}
  </div>`;
}

function CoverGrid({ books, onOpen }) {
  return html`<div class="grid" style="margin-top:20px">
    ${books.map((b) => html`<a key=${b.id} class="cover-link" href=${`/livro/${encodeURIComponent(b.id)}`}
      title=${`${b.title} — ${authorLine(b)}`} aria-label=${`${b.title}, ${authorLine(b)}`} onClick=${opener(b, onOpen, 'cover')}>
      <${Cover} book=${b} />
      ${b.rating && html`<div style="margin-top:6px"><${Stars} value=${b.rating} size=${13} /></div>`}
    </a>`)}
  </div>`;
}

const readPref = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const writePref = (key, value) => { try { localStorage.setItem(key, value); } catch { /* modo privado */ } };

export function ShelfView({ search, focus }) {
  const [filter, setFilter] = useState(() => {
    const f = search.get('f');
    return VALID_FILTERS.has(f) ? f : 'read';
  });
  const [query, setQuery] = useState('');
  // "Quero ler" é uma fila, não uma estante: abre em capas, das mais recentes, e sem diário.
  const isQueue = filter === 'want';
  const prefKey = (name) => `orelha.${name}${filter === 'read' ? '' : `.${filter}`}`;
  const [prefs, setPrefs] = useState(0);
  const sort = readPref(prefKey('shelfSort'), filter === 'read' ? 'rating' : 'recent');
  const view = readPref(prefKey('view'), isQueue ? 'covers' : 'spines');
  const [peek, setPeek] = useState(null);
  const { data: allBooks, error } = useFetch('/shelf?status=all');

  const counts = useMemo(() => {
    const c = { read: 0, want: 0, dropped: 0 };
    for (const b of allBooks || []) if (c[b.status] !== undefined) c[b.status]++;
    return c;
  }, [allBooks]);

  const filters = useMemo(
    () => (counts.dropped > 0 || filter === 'dropped' ? [...BASE_FILTERS, ['dropped', 'Abandonei']] : BASE_FILTERS),
    [counts.dropped, filter],
  );

  const tabBooks = useMemo(
    () => (allBooks ? allBooks.filter((b) => b.status === filter) : []),
    [allBooks, filter],
  );

  // Capas grandes já no cache quando o livro for aberto.
  useEffect(() => { if (tabBooks.length) return prefetchCovers(tabBooks); }, [tabBooks]);

  const books = useMemo(() => {
    const needle = fold(query.trim());
    const filtered = needle
      ? tabBooks.filter((b) => fold(b.title).includes(needle) || fold((b.authors || []).join(' ')).includes(needle))
      : tabBooks;
    const fn = SORTS[sort]?.fn;
    return fn ? [...filtered].sort(fn) : filtered;
  }, [tabBooks, query, sort]);

  const pickFilter = (id) => {
    setFilter(id);
    history.replaceState(null, '', id === 'read' ? '/estante' : `/estante?f=${id}`);
  };
  const pickSort = (e) => { writePref(prefKey('shelfSort'), e.target.value); setPrefs(prefs + 1); };
  const pickView = (v) => { writePref(prefKey('view'), v); setPrefs(prefs + 1); };
  const openBook = (book, origin, kind) => { if (!peek) setPeek({ book, origin, kind }); };
  const hasQuery = !!query.trim();

  return html`<main class="page">
    <${PageHeader} title="Estante" sub=${allBooks ? plural(hasQuery ? books.length : tabBooks.length, 'livro', 'livros') : '\u00a0'} />
    <div class="shelf-controls">
      <div class="chips" role="group" aria-label="Filtrar estante">
        ${filters.map(([id, label]) => html`<button key=${id} class=${`chip ${filter === id ? 'on' : ''}`} aria-pressed=${filter === id} onClick=${() => pickFilter(id)}>
          <span>${label}</span>
          ${allBooks && html`<span class="chip-count">${num(counts[id])}</span>`}
        </button>`)}
      </div>
      <div class="shelf-tools">
        ${tabBooks.length > 0 && html`<div class="shelf-filter">
          <${Icon.search} />
          <input class="shelf-filter-input" type="search" placeholder="Filtrar título ou autor…" aria-label="Filtrar na estante"
            value=${query} onInput=${(e) => setQuery(e.target.value)} />
          ${query && html`<button type="button" class="shelf-filter-clear" onClick=${() => setQuery('')} aria-label="Limpar filtro"><${Icon.close} /></button>`}
        </div>`}
        <div class="shelf-tools-right">
          <select class="sort-select" aria-label="Ordenar" value=${sort} onChange=${pickSort}>
            ${Object.entries(SORTS).filter(([id]) => !(isQueue && id === 'rating')).map(([id, s]) => html`<option key=${id} value=${id}>${s.label}</option>`)}
          </select>
          <div class="view-toggle" role="group" aria-label="Visualização">
            <button class=${view === 'spines' ? 'on' : ''} aria-pressed=${view === 'spines'} aria-label="Lombadas" onClick=${() => pickView('spines')}><${Icon.shelf} /></button>
            <button class=${view === 'covers' ? 'on' : ''} aria-pressed=${view === 'covers'} aria-label="Capas" onClick=${() => pickView('covers')}><${Icon.grid} /></button>
          </div>
        </div>
      </div>
    </div>

    ${error && !allBooks && html`<div style="margin-top:20px"><${ErrorBox} error=${error} /></div>`}
    ${allBooks && !tabBooks.length && html`<div class="empty" style="margin-top:22px">
      <h3>${filter === 'want' ? 'Nada na fila' : filter === 'dropped' ? 'Nenhum livro abandonado' : 'Prateleira vazia'}</h3>
      <p>${filter === 'want'
        ? 'Marque "Quero ler" na página de um livro e ele espera aqui.'
        : filter === 'dropped'
          ? 'Livros que você deixou pelo caminho aparecem aqui.'
          : 'Procure um livro e diga em que pé você está com ele.'}</p>
      ${filter !== 'dropped' && html`<a class="btn primary" href="/buscar"><${Icon.search} /> Buscar um livro</a>`}
    </div>`}
    ${allBooks && tabBooks.length > 0 && !books.length && html`<div class="empty" style="margin-top:22px">
      <h3>Nada com “${query.trim()}”</h3>
      <p>Nenhum livro desta prateleira bateu com o filtro.</p>
      <button class="btn" onClick=${() => setQuery('')}>Limpar filtro</button>
    </div>`}
    ${books.length > 0 && (view === 'spines'
      ? html`<${Bookcase} books=${books} onOpen=${openBook} />`
      : html`<${CoverGrid} books=${books} onOpen=${openBook} />`)}

    ${filter === 'read' && !hasQuery && html`<${DiarySection} onOpen=${openBook} focus=${focus === 'diary'} />`}

    ${peek && html`<${BookPeek} key=${peek.book.id} ...${peek} onClosed=${() => setPeek(null)} />`}
  </main>`;
}
