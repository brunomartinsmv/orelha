import { html, useEffect, useRef, useState } from '/vendor/htm-preact.js';
import { act, api, authorLine, num, useBookTone, useFetch } from '../lib.js';
import { Cover, ErrorBox, Icon, ReadingEstimate, ThemeToggle } from '../ui.js';
import { GoalLine, LogSheet, ProgressSheet } from '../sheets.js';

export function DemoNotice() {
  const clear = async () => {
    if (!confirm('Apagar todos os dados de exemplo? O que você registrou continua aqui.')) return;
    await act(() => api('/demo/clear', { method: 'POST' }), 'Estante pronta para os seus livros.');
  };
  return html`<div class="notice">
    <span>Estes são dados de <b>exemplo</b>.</span>
    <button class="btn small" onClick=${clear} style="flex:none">Começar do zero</button>
  </div>`;
}

// O livro em cima da mesa: capa com espessura, a lombada aparecendo de leve, como na estante.
function BookObject({ book }) {
  const tone = useBookTone(book);
  const depth = Math.max(10, Math.min(26, Math.round(8 + (book.pages || 240) / 30)));
  return html`<span class="book3d" style=${{ '--tone': tone, '--d': `${depth}px` }}>
    <span class="book3d-front"><${Cover} book=${book} /></span>
    <span class="book3d-spine" aria-hidden="true"></span>
  </span>`;
}

export function ReadingCard({ book, single = false }) {
  const [sheet, setSheet] = useState(null);
  const pct = book.pages && book.current_page ? Math.min(100, Math.round((book.current_page / book.pages) * 100)) : 0;
  const where = book.current_page ? `pág. ${num(book.current_page)}${book.pages ? ` de ${num(book.pages)}` : ''}` : 'Ainda no começo';
  const update = () => setSheet('progress');
  return html`<article class="reading-card">
    <button class="reading-cover" onClick=${update} aria-label=${`Atualizar página de ${book.title}`}><${BookObject} book=${book} /></button>
    <div class="reading-info">
      ${single && html`<span class="reading-state">Lendo agora</span>`}
      <a href=${`/livro/${encodeURIComponent(book.id)}`}>
        <h3 class="reading-title">${book.title}</h3>
        <p class="reading-author">${authorLine(book)}</p>
      </a>
      <button class="reading-progress" onClick=${update} aria-label=${`Atualizar página: ${where}`}>
        <span class="progress" role="progressbar" aria-valuenow=${pct} aria-valuemin="0" aria-valuemax="100"><i style=${{ width: `${pct}%` }}></i></span>
        <span class="progress-row">
          <span>${where}</span>
          <span class="progress-edit">${book.pages && book.current_page ? `${pct}%` : ''}<${Icon.edit} /></span>
        </span>
      </button>
      <${ReadingEstimate} estimate=${book.reading_estimate} />
    </div>
    ${sheet === 'progress' && html`<${ProgressSheet} book=${book} onClose=${() => setSheet(null)} onFinish=${() => setSheet('log')} />`}
    ${sheet === 'log' && html`<${LogSheet} book=${book} onClose=${() => setSheet(null)} />`}
  </article>`;
}

// Mostra poucas linhas; se o trecho foi cortado, convida a abrir inteiro.
function HomeQuote({ quote }) {
  const [full, setFull] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef(null);
  const author = quote.book.authors?.[0];

  useEffect(() => {
    setFull(false);
  }, [quote.text]);

  useEffect(() => {
    const el = ref.current;
    if (!el || full) return undefined;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [quote.text, full]);

  const interactive = clamped || full;
  return html`<figure class=${`home-quote ${full ? 'full' : ''} ${interactive ? 'expandable' : ''}`}>
    <blockquote ref=${ref}
      role=${interactive ? 'button' : undefined}
      tabindex=${interactive ? 0 : undefined}
      aria-expanded=${interactive ? full : undefined}
      onClick=${interactive ? () => setFull(!full) : undefined}
      onKeyDown=${interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFull(!full); } } : undefined}>${quote.text}</blockquote>
    ${interactive && html`<button type="button" class="quote-toggle" onClick=${() => setFull(!full)}>${full ? 'Recolher trecho' : 'Ler trecho completo'}</button>`}
    <figcaption><a class="quote-book" href=${`/livro/${encodeURIComponent(quote.book.id)}`}>— ${quote.book.title}${author ? `, ${author}` : ''}</a>
      ${quote.source && html`<a class="quote-source" href=${quote.source.url} target="_blank" rel="noopener noreferrer">${quote.source.name}</a>`}
    </figcaption>
  </figure>`;
}

function NextReadCard() {
  const { data: want } = useFetch('/shelf?status=want');
  const picks = (want || []).slice(0, 4);
  return html`<div class=${`home-next ${picks.length ? 'with-picks' : ''}`}>
    <div class="home-next-copy">
      <h1 class="section-title">Nenhum livro aberto agora</h1>
      <p class="home-next-sub">${picks.length
        ? 'Escolha um da sua fila de quero ler ou busque outro título.'
        : 'Registre o que está na cabeceira ou procure a próxima leitura.'}</p>
      <div class="btn-row">
        <a class="btn primary" href="/buscar"><${Icon.search} /> ${picks.length ? 'Buscar outro' : 'Escolher o próximo'}</a>
        ${want?.length > 0 && html`<a class="btn" href="/estante?f=want">Ver fila (${num(want.length)})</a>`}
      </div>
    </div>
    ${picks.length > 0 && html`<div class="home-next-picks" aria-label="Na sua fila para começar">
      ${picks.map((b) => html`<a key=${b.id} class="cover-link" href=${`/livro/${encodeURIComponent(b.id)}`} title=${`${b.title} — ${authorLine(b)}`} aria-label=${`${b.title}, ${authorLine(b)}`}>
        <${Cover} book=${b} />
      </a>`)}
    </div>`}
  </div>`;
}

// A página inicial cabe em uma tela: o livro aberto, um trecho e a meta. O resto mora nas abas.
export function HomeView() {
  const { data, error } = useFetch('/home');
  if (error && !data) return html`<main class="page"><${ErrorBox} error=${error} onRetry=${() => location.reload()} /></main>`;
  if (!data) return html`<main class="page"><div class="skel" style="height:140px;margin-top:40px"></div></main>`;
  const isEmpty = !data.has_books && !data.reading.length && !data.recent.length;

  return html`<main class="page home">
    <div class="topbar mobile-only">
      <a class="logo" href="/"><${Icon.logo} /> orelha</a>
      <div class="topbar-actions">
        <${ThemeToggle} />
        <a class="icon-btn" href="/buscar" aria-label="Buscar"><${Icon.search} /></a>
      </div>
    </div>
    ${data.demo && html`<${DemoNotice} />`}

    ${isEmpty && html`<div class="empty-hero">
      <h1>O que você leu por último?</h1>
      <p>Comece pelo livro que ainda está na sua cabeça. Dá nota, escreve duas linhas. A estante cresce a partir daí.</p>
      <div class="btn-row">
        <a class="btn primary" href="/buscar"><${Icon.search} /> Buscar um livro</a>
        <a class="btn" href="/ajustes">Importar leituras</a>
      </div>
    </div>`}

    ${data.reading.length > 0 && html`<section>
      ${data.reading.length > 1 && html`<div class="section-head"><h2 class="section-title">Lendo agora</h2></div>`}
      <div class=${`reading-list ${data.reading.length > 1 ? 'many' : ''}`}>${data.reading.map((b) => html`<${ReadingCard} key=${b.id} book=${b} single=${data.reading.length === 1} />`)}</div>
    </section>`}

    ${!isEmpty && !data.reading.length && html`<${NextReadCard} />`}

    ${data.quote && html`<${HomeQuote} quote=${data.quote} />`}

    <div class="home-goal"><${GoalLine} goal=${data.goal} statsLink=${true} /></div>
  </main>`;
}
