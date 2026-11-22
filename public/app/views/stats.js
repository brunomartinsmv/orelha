import { html, useEffect, useState } from '/vendor/htm-preact.js';
import { MONTHS_SHORT, monthName, num, onColor, plural, useBookTone, useFetch } from '../lib.js';
import { Cover, ErrorBox, PageHeader, Stars } from '../ui.js';
import { GoalLine } from '../sheets.js';

// Escala com marcas inteiras e redondas para o eixo Y (serve tanto para livros quanto para páginas).
function yScale(rawMax) {
  if (rawMax <= 0) return { max: 1, ticks: [1, 0] };
  if (rawMax <= 3) return { max: rawMax, ticks: Array.from({ length: rawMax + 1 }, (_, i) => rawMax - i) };
  const rough = rawMax / 3;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const factor = norm <= 1 ? 1 : norm <= 2 ? 2 : (mag >= 10 && norm <= 2.5) ? 2.5 : norm <= 5 ? 5 : 10;
  const step = factor * mag;
  const count = Math.ceil(rawMax / step);
  const ticks = [];
  for (let i = count; i >= 0; i--) ticks.push(Math.round(i * step));
  return { max: Math.round(step * count), ticks };
}

function summarizeTitles(books, limit = 4) {
  if (!books?.length) return '';
  const shown = books.slice(0, limit).map((b) => b.title);
  const rest = books.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} e mais ${rest}` : shown.join(', ');
}

// Barras de uma série só. Tocar ou passar o mouse mostra o valor na linha acima do gráfico.
function BarChart({ title, items, hint, right, yAxis = false }) {
  const [active, setActive] = useState(null);
  useEffect(() => setActive(null), [title, items.length]);
  const activeIndex = active !== null && active < items.length ? active : null;
  const rawMax = Math.max(0, ...items.map((i) => i.value));
  const scale = yAxis ? yScale(rawMax) : { max: Math.max(1, rawMax), ticks: [] };
  const activeItem = activeIndex !== null ? items[activeIndex] : null;
  const barsEl = html`<div class=${`bars ${activeIndex !== null ? 'has-active' : ''}`} role="list" onPointerLeave=${() => setActive(null)}>
    ${items.map((item, i) => {
      const aria = item.sub ? `${item.detail} — ${item.sub}` : item.detail;
      return html`<div key=${i} role="listitem" tabindex="0" class=${`bar-col ${activeIndex === i ? 'active' : ''} ${item.value === 0 ? 'zero' : ''}`} aria-label=${aria}
        onPointerEnter=${() => setActive(i)} onClick=${() => setActive(i)} onFocus=${() => setActive(i)} onBlur=${() => setActive(null)}>
        <i style=${{ height: item.value === 0 ? undefined : `${(item.value / scale.max) * 100}%` }}></i>
      </div>`;
    })}
  </div>`;
  const axisEl = html`<div class="bar-axis" aria-hidden="true">${items.map((item, i) => html`<span key=${i}>${item.label}</span>`)}</div>`;

  return html`<div>
    <div class="chart-head">
      <h2 class="chart-title">${title}</h2>
      ${right || null}
    </div>
    <p class="chart-readout" aria-live="polite">
      ${activeItem
        ? html`<span>${activeItem.detail}</span>${activeItem.sub && html` <span class="chart-readout-sub">· ${activeItem.sub}</span>`}`
        : hint}
    </p>
    ${yAxis
      ? html`<div class="chart-plot">
          <div class="bar-yaxis" aria-hidden="true">${scale.ticks.map((t) => html`<span key=${t}>${num(t)}</span>`)}</div>
          <div class="bars-wrap">
            <div class="bar-grid" aria-hidden="true">${scale.ticks.slice(0, -1).map((t) => html`<span key=${t} style=${{ top: `${(1 - t / scale.max) * 100}%` }}></span>`)}</div>
            ${barsEl}
          </div>
          <div></div>
          ${axisEl}
        </div>`
      : html`${barsEl}${axisEl}`}
  </div>`;
}

function PileBook({ book, maxPages }) {
  const tone = useBookTone(book);
  const thickness = Math.max(10, Math.round((book.pages / maxPages) * 34));
  const widthPct = 58 + ((book.title.length * 7) % 38);
  return html`<a href=${`/livro/${encodeURIComponent(book.id)}`} title=${`${book.title}, ${book.pages} páginas`} aria-label=${`${book.title}, ${book.pages} páginas`}
    style=${{ '--tone': tone, '--on': onColor(tone), height: `${thickness}px`, width: `${widthPct}%` }}>
    ${thickness >= 13 && html`<span>${book.title}</span>`}
  </a>`;
}

// Papel comum: cerca de 0,07 mm por página impressa.
const pileHeight = (pages) => {
  const cm = (pages * 0.07) / 10;
  return cm >= 100 ? `${(cm / 100).toFixed(2).replace('.', ',')} m` : `${Math.round(cm)} cm`;
};

function StatExtras({ rereads, dropped }) {
  if (!rereads && !dropped) return null;
  return html`<div class="stat-extras">
    ${rereads > 0 && html`<span><b>${num(rereads)}</b> ${rereads === 1 ? 'releitura' : 'releituras'}</span>`}
    ${dropped > 0 && html`<span><b>${num(dropped)}</b> ${dropped === 1 ? 'abandono' : 'abandonos'}</span>`}
  </div>`;
}

function GenreList({ genres, title = 'Gêneros mais lidos', limit = 8 }) {
  const [expanded, setExpanded] = useState(false);
  if (!genres?.length) return null;
  const max = Math.max(1, ...genres.map((g) => g.books));
  const visible = expanded ? genres : genres.slice(0, limit);
  return html`<div>
    <h2 class="chart-title">${title}</h2>
    <p class="chart-readout">Um mesmo livro pode entrar em mais de um gênero.</p>
    ${visible.map((g) => html`<div key=${g.id} class="author-row">
      <span class="name">${g.label}</span>
      <span class="val">${plural(g.books, 'livro', 'livros')}</span>
      <div class="track"><i style=${{ width: `${(g.books / max) * 100}%` }}></i></div>
    </div>`)}
    ${genres.length > limit && html`<button type="button" class="more-btn" onClick=${() => setExpanded(!expanded)}>
      ${expanded ? 'Mostrar menos' : `Mostrar todos (${genres.length})`}
    </button>`}
  </div>`;
}

function FormatBreakdown({ formats, totalBooks }) {
  if (!formats?.length) return null;
  const total = formats.reduce((sum, f) => sum + f.books, 0);
  const hint = total < totalBooks
    ? `${plural(total, 'registro', 'registros')} com formato informado.`
    : 'Distribuição entre papel, e-book e áudio.';
  const aria = formats.map((f) => `${f.label}: ${Math.round((f.books / total) * 100)}%`).join(', ');
  return html`<div>
    <h2 class="chart-title">Em que formato</h2>
    <p class="chart-readout">${hint}</p>
    <div class="format-bar" role="img" aria-label=${aria}>
      ${formats.map((f) => html`<i key=${f.id} class=${`fmt-${f.id}`} style=${{ width: `${(f.books / total) * 100}%` }}></i>`)}
    </div>
    <div class="format-list">
      ${formats.map((f) => {
        const pct = Math.round((f.books / total) * 100);
        return html`<div key=${f.id} class="format-row">
          <span class="format-name"><i class=${`format-dot fmt-${f.id}`} aria-hidden="true"></i>${f.label}</span>
          <span class="format-val">${plural(f.books, 'livro', 'livros')} · ${pct}%${f.pages > 0 ? html` <small>(${num(f.pages)} p.)</small>` : null}</span>
        </div>`;
      })}
    </div>
  </div>`;
}

function YearRecap({ data, onBack }) {
  const maxPages = Math.max(1, ...data.stack.map((b) => b.pages));
  const bestMonth = data.months.reduce((best, m, i) => {
    if (!m.books) return best;
    if (!best || m.books > best.books || (m.books === best.books && m.pages > best.pages)) {
      return { index: i, ...m };
    }
    return best;
  }, null);
  const topAuthor = data.authors[0]?.books >= 2 ? data.authors[0] : null;
  const totalFormatted = data.formats.reduce((sum, f) => sum + f.books, 0);
  const topFormat = data.formats[0] || null;
  const hasExtremes = data.longest && data.longest.id !== data.shortest?.id;

  const highlights = [];
  if (bestMonth) {
    const label = monthName(bestMonth.index);
    highlights.push({
      kicker: 'Mês mais intenso',
      title: label[0].toUpperCase() + label.slice(1),
      meta: `${plural(bestMonth.books, 'livro', 'livros')}${bestMonth.pages > 0 ? ` · ${num(bestMonth.pages)} páginas` : ''}`,
    });
  }
  if (topAuthor) {
    highlights.push({
      kicker: 'Quem você mais leu',
      title: topAuthor.name,
      meta: `${plural(topAuthor.books, 'livro', 'livros')}${topAuthor.pages > 0 ? ` · ${num(topAuthor.pages)} páginas` : ''}`,
    });
  }
  if (topFormat) {
    const pct = Math.round((topFormat.books / totalFormatted) * 100);
    const pctLabel = totalFormatted < data.books ? `${pct}% dos registros com formato` : `${pct}%`;
    highlights.push({
      kicker: 'Formato principal',
      title: topFormat.label,
      meta: `${plural(topFormat.books, 'livro', 'livros')} (${pctLabel})`,
    });
  }

  return html`<div class="recap">
    <section class=${`recap-hero ${data.stack.length > 0 ? 'with-pile' : ''}`}>
      <div>
        <p class="recap-kicker">Seu ano em livros</p>
        <h2 class="recap-title">${data.year}</h2>
        <p class="big-label">${plural(data.books, 'livro terminado', 'livros terminados')}</p>
        <div class="stat-ledger">
          <div><b>${num(data.pages)}</b><span>páginas</span></div>
          <div><b>${data.average_rating ? data.average_rating.toFixed(1).replace('.', ',') : '–'}</b><span>nota média</span></div>
          <div><b>${data.average_days ? Math.round(data.average_days) : '–'}</b><span>dias por livro</span></div>
        </div>
        <${StatExtras} rereads=${data.rereads} dropped=${data.dropped} />
      </div>

      ${data.stack.length > 0 && html`<div class="pile-stage">
        <div class="pile">${[...data.stack].reverse().map((b) => html`<${PileBook} key=${b.id} book=${b} maxPages=${maxPages} />`)}</div>
        <div class="pile-plank" aria-hidden="true"></div>
        <p class="pile-caption">Empilhado, dá cerca de ${pileHeight(data.pages)} de papel.</p>
      </div>`}
    </section>

    ${data.top.length > 0 && html`<section class="recap-section">
      <h2 class="chart-title">Favoritos de ${data.year}</h2>
      <p class="chart-readout">As maiores notas registradas no seu diário neste ano.</p>
      <div class="recap-top">
        ${data.top.map((b) => html`<a key=${b.id} class="cover-link recap-book" href=${`/livro/${encodeURIComponent(b.id)}`}>
          <${Cover} book=${b} />
          <div class="recap-book-meta">
            <${Stars} value=${b.rating} />
            <div class="t">${b.title}</div>
            ${b.authors?.[0] && html`<div class="a">${b.authors[0]}</div>`}
          </div>
        </a>`)}
      </div>
    </section>`}

    ${(highlights.length > 0 || hasExtremes) && html`<section class="recap-section">
      <h2 class="chart-title" style="margin-bottom:10px">Destaques do ano</h2>
      ${highlights.length > 0 && html`<div class="recap-highlights">
        ${highlights.map((h) => html`<div key=${h.kicker} class="recap-card">
          <small>${h.kicker}</small>
          <strong>${h.title}</strong>
          <span>${h.meta}</span>
        </div>`)}
      </div>`}
      ${hasExtremes && html`<div class="recap-extremes">
        ${[['O mais longo', data.longest], ['O mais curto', data.shortest]].map(([label, b]) => html`<a key=${label} class="extreme" href=${`/livro/${encodeURIComponent(b.id)}`}>
          <${Cover} book=${b} />
          <span><small>${label}, ${num(b.pages)} páginas</small>${b.title}</span>
        </a>`)}
      </div>`}
    </section>`}

    ${data.genres.length > 0 && html`<section class="recap-section">
      <${GenreList} key=${`recap-${data.year}`} genres=${data.genres} title="Os gêneros do seu ano" limit=${6} />
    </section>`}

    <div class="recap-foot">
      <button type="button" class="btn" onClick=${onBack}>Ver números completos de ${data.year}</button>
    </div>
  </div>`;
}

function statsUrl(year, recap) {
  const params = new URLSearchParams();
  if (String(year) !== String(new Date().getFullYear())) params.set('ano', String(year));
  if (recap && year !== 'all') params.set('modo', 'retrospectiva');
  const qs = params.toString();
  return qs ? `/numeros?${qs}` : '/numeros';
}

export function StatsView({ search }) {
  const [year, setYear] = useState(() => search.get('ano') || new Date().getFullYear());
  const [metric, setMetric] = useState('books');
  const [recap, setRecap] = useState(() => search.get('modo') === 'retrospectiva');
  const searchKey = search.toString();
  useEffect(() => {
    const nextYear = search.get('ano') || new Date().getFullYear();
    const nextRecap = nextYear !== 'all' && search.get('modo') === 'retrospectiva';
    setYear(nextYear);
    setRecap(nextRecap);
  }, [searchKey]);

  const { data, error } = useFetch(`/stats?year=${year}`);
  if (error && !data) return html`<main class="page"><${ErrorBox} error=${error} /></main>`;
  if (!data) return html`<main class="page"><div class="skel" style="height:200px;margin-top:40px"></div></main>`;

  const allTime = data.year === 'all';
  const canRecap = !allTime && data.books > 0;
  const inRecap = recap && canRecap;
  const updateView = (nextYear, nextRecap) => {
    const allowRecap = nextYear !== 'all' && !!nextRecap;
    setYear(nextYear);
    setRecap(allowRecap);
    history.replaceState(null, '', statsUrl(nextYear, allowRecap));
  };
  const selectYear = (next) => updateView(next, next === 'all' ? false : recap);

  const chips = [...new Set([new Date().getFullYear(), ...data.years])].sort((a, b) => b - a);
  const hasPages = data.pages > 0;
  const activeMetric = hasPages ? metric : 'books';
  const timeline = allTime
    ? data.by_year.map((y) => ({
      label: data.by_year.length <= 6 ? String(y.year) : String(y.year).slice(2),
      value: activeMetric === 'pages' ? y.pages : y.books,
      detail: activeMetric === 'pages'
        ? `${y.year}: ${plural(y.pages, 'página', 'páginas')}, ${plural(y.books, 'livro', 'livros')}`
        : `${y.year}: ${plural(y.books, 'livro', 'livros')}, ${num(y.pages)} páginas`,
    }))
    : data.months.map((m, i) => ({
      label: MONTHS_SHORT[i][0].toUpperCase(),
      value: activeMetric === 'pages' ? m.pages : m.books,
      detail: activeMetric === 'pages'
        ? `${monthName(i)}: ${plural(m.pages, 'página', 'páginas')}, ${plural(m.books, 'livro', 'livros')}`
        : `${monthName(i)}: ${plural(m.books, 'livro', 'livros')}, ${num(m.pages)} páginas`,
    }));
  const timelineTitle = activeMetric === 'pages'
    ? (allTime ? 'Páginas por ano' : 'Páginas por mês')
    : (allTime ? 'Livros por ano' : 'Livros por mês');
  const timelineToggle = hasPages && html`<div class="seg seg-compact" role="group" aria-label="Métrica da linha do tempo">
    <button type="button" class=${activeMetric === 'books' ? 'on' : ''} aria-pressed=${activeMetric === 'books'} onClick=${() => setMetric('books')}>Livros</button>
    <button type="button" class=${activeMetric === 'pages' ? 'on' : ''} aria-pressed=${activeMetric === 'pages'} onClick=${() => setMetric('pages')}>Páginas</button>
  </div>`;

  const hasRatings = data.ratings.some((n) => n > 0);
  const ratingItems = data.ratings.map((count, i) => ({
    label: i % 2 ? String((i + 1) / 2) : '',
    value: count,
    detail: `${String((i + 1) / 2).replace('.', ',')} estrelas: ${plural(count, 'livro', 'livros')}`,
  }));
  const maxAuthor = Math.max(1, ...data.authors.map((a) => a.books));
  const maxPages = Math.max(1, ...data.stack.map((b) => b.pages));

  return html`<main class="page">
    <${PageHeader} title="Números" back=${true} right=${canRecap && html`<button type="button" class=${`btn small ${inRecap ? '' : 'recap-btn'}`} onClick=${() => updateView(data.year, !inRecap)}>
      ${inRecap ? 'Ver números' : 'Retrospectiva'}
    </button>`} />
    <div class="chips" style="margin-top:12px" role="group" aria-label="Período">
      ${chips.map((y) => html`<button key=${y} class=${`chip ${data.year === y ? 'on' : ''}`} onClick=${() => selectYear(y)}>${y}</button>`)}
      <button class=${`chip ${allTime ? 'on' : ''}`} onClick=${() => selectYear('all')}>Sempre</button>
    </div>

    ${data.books === 0
      ? html`<div class="empty" style="margin-top:22px">
          <h3>Nenhum livro terminado ${allTime ? 'ainda' : `em ${data.year}`}</h3>
          <p>Os números aparecem assim que o diário tiver registros com data.</p>
          ${data.dropped > 0 && html`<p class="stats-empty-dropped"><b>${num(data.dropped)}</b> ${data.dropped === 1 ? 'livro abandonado' : 'livros abandonados'}${allTime ? '' : ` em ${data.year}`}.</p>`}
        </div>
        ${data.year === data.goal.year && html`<div style="margin-top:16px"><${GoalLine} goal=${data.goal} /></div>`}`
      : inRecap
        ? html`<${YearRecap} data=${data} onBack=${() => updateView(data.year, false)} />`
        : html`
          <section class=${`stats-hero ${data.stack.length > 0 ? 'with-pile' : ''}`}>
            <div>
              <div class="big-stat">${num(data.books)}</div>
              <p class="big-label">${data.books === 1 ? 'livro terminado' : 'livros terminados'}${allTime ? '' : ` em ${data.year}`}</p>
              <div class="stat-ledger">
                <div><b>${num(data.pages)}</b><span>páginas</span></div>
                <div><b>${data.average_rating ? data.average_rating.toFixed(1).replace('.', ',') : '–'}</b><span>nota média</span></div>
                <div><b>${data.average_days ? Math.round(data.average_days) : '–'}</b><span>dias por livro</span></div>
              </div>
              <${StatExtras} rereads=${data.rereads} dropped=${data.dropped} />
              ${data.year === data.goal.year && html`<div style="margin-top:16px"><${GoalLine} goal=${data.goal} /></div>`}
            </div>

            ${data.stack.length > 0 && html`<div class="pile-stage">
              <div class="pile">${[...data.stack].reverse().map((b) => html`<${PileBook} key=${b.id} book=${b} maxPages=${maxPages} />`)}</div>
              <div class="pile-plank" aria-hidden="true"></div>
              <p class="pile-caption">Empilhado, dá cerca de ${pileHeight(data.pages)} de papel.</p>
            </div>`}
          </section>

          <div class="stats-cols">
            <${BarChart} title=${timelineTitle} items=${timeline} hint="Toque numa barra para ver o valor." right=${timelineToggle} yAxis=${true} />
            ${hasRatings && html`<${BarChart} title="Como você dá nota" items=${ratingItems} hint="Da meia estrela às cinco." />`}

            ${data.genres.length > 0 && html`<${GenreList} key=${data.year} genres=${data.genres} />`}
            ${data.formats.length > 0 && html`<${FormatBreakdown} formats=${data.formats} totalBooks=${data.books} />`}

            ${maxAuthor >= 2 && html`<div>
              <h2 class="chart-title" style="margin-bottom:6px">Quem você mais leu</h2>
              ${data.authors.map((a) => html`<div key=${a.name} class="author-row">
                <span class="name">${a.name}</span>
                <span class="val">${plural(a.books, 'livro', 'livros')}</span>
                <div class="track"><i style=${{ width: `${(a.books / maxAuthor) * 100}%` }}></i></div>
              </div>`)}
            </div>`}

            ${data.decades.length > 1 && html`<${BarChart} title="De que décadas vêm" hint="Ano da primeira publicação."
              items=${data.decades.map((d, i) => ({
                label: data.decades.length <= 8 || i % 2 === 0 ? String(d.decade) : '',
                value: d.count,
                detail: `Anos ${d.decade}: ${plural(d.count, 'livro', 'livros')}`,
                sub: summarizeTitles(d.books),
              }))} />`}

            ${data.longest && data.longest.id !== data.shortest?.id && html`<div>
              <h2 class="chart-title" style="margin-bottom:4px">Os extremos</h2>
              ${[['O mais longo', data.longest], ['O mais curto', data.shortest]].map(([label, b]) => html`<a key=${label} class="extreme" href=${`/livro/${encodeURIComponent(b.id)}`}>
                <${Cover} book=${b} />
                <span><small>${label}, ${num(b.pages)} páginas</small>${b.title}</span>
              </a>`)}
            </div>`}
          </div>
        `}
  </main>`;
}
