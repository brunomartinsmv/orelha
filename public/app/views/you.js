import { html, useState } from '/vendor/htm-preact.js';
import { act, api, num, useFetch } from '../lib.js';
import { Cover, ErrorBox, Icon, PageHeader, ThemeToggle } from '../ui.js';
import { BookPickerSheet } from '../sheets.js';
import { DemoNotice } from './home.js';

function Favorites({ slots }) {
  const [picking, setPicking] = useState(null);
  const pick = async (book) => {
    const slot = picking;
    setPicking(null);
    await act(() => api(`/favorites/${slot}`, { method: 'PUT', body: { book_id: book.id } }), 'Agora está nos seus 4 favoritos.');
  };
  return html`<section class="section">
    <div class="section-head"><h2 class="section-title">Meus 4 favoritos</h2></div>
    <div class="fav-grid">
      ${slots.map((book, i) => (book
        ? html`<a key=${i} class="cover-link" href=${`/livro/${encodeURIComponent(book.id)}`}><${Cover} book=${book} /></a>`
        : html`<button key=${i} class="fav-empty" onClick=${() => setPicking(i + 1)} aria-label=${`Escolher livro ${i + 1}`}><${Icon.plus} /></button>`))}
    </div>
    ${picking && html`<${BookPickerSheet} title="Escolha um livro" onPick=${pick} onClose=${() => setPicking(null)} />`}
  </section>`;
}

export function YouView() {
  const { data, error } = useFetch('/profile');
  if (error && !data) return html`<main class="page"><${ErrorBox} error=${error} /></main>`;
  if (!data) return html`<main class="page"><div class="skel" style="height:60px;margin-top:20px"></div></main>`;
  const { counts } = data;
  const year = new Date().getFullYear();
  return html`<main class="page">
    ${data.demo && html`<${DemoNotice} />`}
    <div class="topbar" style="margin-bottom:0;align-items:flex-start">
      <h1 class="you-name">${data.name}</h1>
      <div class="topbar-actions">
        <${ThemeToggle} className="mobile-only" />
        <a class="icon-btn" href="/ajustes" aria-label="Ajustes" title="Ajustes"><${Icon.gear} /></a>
      </div>
    </div>
    <div class="you-counts">
      <a href="/estante"><b>${num(counts.books)}</b>livros lidos</a>
      <a href="/numeros"><b>${num(counts.pages)}</b>páginas</a>
      <a href="/numeros"><b>${num(data.goal.done)}</b>em ${year}</a>
    </div>

    <${Favorites} slots=${data.favorites} />

    <section class="section">
      <div class="menu">
        <a href="/numeros"><${Icon.chart} /> Números da leitura <span class="count"><${Icon.chevron} /></span></a>
        <a href="/listas"><${Icon.list} /> Listas <span class="count">${counts.lists}<${Icon.chevron} /></span></a>
        <a href="/trechos"><${Icon.quote} /> Trechos <span class="count">${counts.quotes}<${Icon.chevron} /></span></a>
      </div>
    </section>
  </main>`;
}

export function QuotesView() {
  const { data, error } = useFetch('/quotes');
  return html`<main class="page">
    <${PageHeader} title="Trechos" back=${true} />
    ${error && !data && html`<${ErrorBox} error=${error} />`}
    ${data && !data.length && html`<div class="empty" style="margin-top:18px">
      <h3>Nada sublinhado ainda</h3>
      <p>Na página de qualquer livro, toque em “Guardar trecho”.</p>
    </div>`}
    <div style="margin-top:10px">
      ${(data || []).map((q) => html`<div key=${q.id} class=${`quote-item ${q.pending ? 'pending' : ''}`}>
        <blockquote>${q.text}</blockquote>
        <div class="quote-foot">
          <a href=${`/livro/${encodeURIComponent(q.book.id)}`}>${q.book.title}${q.page ? `, p. ${q.page}` : ''}</a>
          ${q.pending && html`<span>aguardando sincronização</span>`}
        </div>
      </div>`)}
    </div>
  </main>`;
}
