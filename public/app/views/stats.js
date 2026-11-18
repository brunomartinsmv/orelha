import { html, useState } from '/vendor/htm-preact.js';
import { MONTHS_SHORT, monthName, num, onColor, plural, useBookTone, useFetch } from '../lib.js';
import { Cover, ErrorBox, PageHeader } from '../ui.js';
import { GoalLine } from '../sheets.js';

// Barras de uma série só. Tocar ou passar o mouse mostra o valor na linha acima do gráfico.
function BarChart({ title, items, hint }) {
  const [active, setActive] = useState(null);
  const max = Math.max(1, ...items.map((i) => i.value));
  const readout = active !== null ? items[active].detail : hint;
  return html`<div>
    <h2 class="chart-title">${title}</h2>
    <p class="chart-readout" aria-live="polite">${readout}</p>
    <div class=${`bars ${active !== null ? 'has-active' : ''}`} role="list" onPointerLeave=${() => setActive(null)}>
      ${items.map((item, i) => html`<div key=${i} role="listitem" tabindex="0" class=${`bar-col ${active === i ? 'active' : ''} ${item.value === 0 ? 'zero' : ''}`} aria-label=${item.detail}
        onPointerEnter=${() => setActive(i)} onClick=${() => setActive(i)} onFocus=${() => setActive(i)} onBlur=${() => setActive(null)}>
        <i style=${{ height: item.value === 0 ? undefined : `${(item.value / max) * 100}%` }}></i>
      </div>`)}
    </div>
    <div class="bar-axis" aria-hidden="true">${items.map((item, i) => html`<span key=${i}>${item.label}</span>`)}</div>
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

export function StatsView({ search }) {
  const [year, setYear] = useState(() => search.get('ano') || new Date().getFullYear());
  const { data, error } = useFetch(`/stats?year=${year}`);
  if (error && !data) return html`<main class="page"><${ErrorBox} error=${error} /></main>`;
  if (!data) return html`<main class="page"><div class="skel" style="height:200px;margin-top:40px"></div></main>`;

  const allTime = data.year === 'all';
  const chips = [...new Set([new Date().getFullYear(), ...data.years])].sort((a, b) => b - a);
  const timeline = allTime
    ? data.by_year.map((y) => ({ label: data.by_year.length <= 6 ? String(y.year) : String(y.year).slice(2), value: y.books, detail: `${y.year}: ${plural(y.books, 'livro', 'livros')}, ${num(y.pages)} páginas` }))
    : data.months.map((m, i) => ({ label: MONTHS_SHORT[i][0].toUpperCase(), value: m.books, detail: `${monthName(i)}: ${plural(m.books, 'livro', 'livros')}, ${num(m.pages)} páginas` }));
  const ratingItems = data.ratings.map((count, i) => ({
    label: i % 2 ? String((i + 1) / 2) : '',
    value: count,
    detail: `${String((i + 1) / 2).replace('.', ',')} estrelas: ${plural(count, 'livro', 'livros')}`,
  }));
  const maxAuthor = Math.max(1, ...data.authors.map((a) => a.books));
  const maxPages = Math.max(1, ...data.stack.map((b) => b.pages));

  return html`<main class="page">
    <${PageHeader} title="Números" back=${true} />
    <div class="chips" style="margin-top:12px" role="group" aria-label="Período">
      ${chips.map((y) => html`<button key=${y} class=${`chip ${data.year === y ? 'on' : ''}`} onClick=${() => setYear(y)}>${y}</button>`)}
      <button class=${`chip ${allTime ? 'on' : ''}`} onClick=${() => setYear('all')}>Sempre</button>
    </div>

    ${data.books === 0
      ? html`<div class="empty" style="margin-top:22px"><h3>Nenhum livro terminado ${allTime ? 'ainda' : `em ${data.year}`}</h3><p>Os números aparecem assim que o diário tiver registros com data.</p></div>
        ${data.year === data.goal.year && html`<div style="margin-top:16px"><${GoalLine} goal=${data.goal} /></div>`}`
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
            ${data.year === data.goal.year && html`<div style="margin-top:16px"><${GoalLine} goal=${data.goal} /></div>`}
          </div>

          ${data.stack.length > 0 && html`<div class="pile-stage">
            <div class="pile">${[...data.stack].reverse().map((b) => html`<${PileBook} key=${b.id} book=${b} maxPages=${maxPages} />`)}</div>
            <div class="pile-plank" aria-hidden="true"></div>
            <p class="pile-caption">Empilhado, dá cerca de ${pileHeight(data.pages)} de papel.</p>
          </div>`}
        </section>

        <div class="stats-cols">
          <${BarChart} title=${allTime ? 'Livros por ano' : 'Livros por mês'} items=${timeline} hint="Toque numa barra para ver o valor." />
          <${BarChart} title="Como você dá nota" items=${ratingItems} hint="Da meia estrela às cinco." />

          ${maxAuthor >= 2 && html`<div>
            <h2 class="chart-title" style="margin-bottom:6px">Quem você mais leu</h2>
            ${data.authors.map((a) => html`<div key=${a.name} class="author-row">
              <span class="name">${a.name}</span>
              <span class="val">${plural(a.books, 'livro', 'livros')}</span>
              <div class="track"><i style=${{ width: `${(a.books / maxAuthor) * 100}%` }}></i></div>
            </div>`)}
          </div>`}

          ${data.decades.length > 1 && html`<${BarChart} title="De que décadas vêm" hint="Ano da primeira publicação."
            items=${data.decades.map((d, i) => ({ label: data.decades.length <= 8 || i % 2 === 0 ? String(d.decade) : '', value: d.count, detail: `Anos ${d.decade}: ${plural(d.count, 'livro', 'livros')}` }))} />`}

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

