import { html, useEffect, useMemo, useRef, useState } from '/vendor/htm-preact.js';
import { monthName, parseDate, plural, useFetch } from '../lib.js';
import { Cover, ErrorBox, Icon, Stars } from '../ui.js';

// O diário mora embaixo da estante: a estante mostra os melhores, o diário mostra os mais recentes.
export function DiarySection({ onOpen, focus }) {
  const [year, setYear] = useState(null);
  const { data, error } = useFetch(`/diary${year ? `?year=${year}` : ''}`);
  const ref = useRef(null);

  // Quem chega por /diario cai direto aqui.
  useEffect(() => {
    if (focus && data) requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'start' }));
  }, [focus, !!data]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const entry of data?.entries || []) {
      const { y, m } = parseDate(entry.finished_on);
      const key = `${y}-${m}`;
      if (!map.has(key)) map.set(key, { key, y, m, entries: [] });
      map.get(key).entries.push(entry);
    }
    return [...map.values()];
  }, [data]);

  const open = (book) => (e) => {
    if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    onOpen(book, e.currentTarget.querySelector('.cover'), 'cover');
  };

  return html`<section class="section diary-section" id="diario" ref=${ref} aria-labelledby="diario-title">
    <div class="section-head">
      <h2 class="section-title" id="diario-title">Diário</h2>
      ${data?.entries?.length > 0 && html`<span class="muted" style="font-size:14px">${plural(data.entries.length, 'leitura', 'leituras')}</span>`}
    </div>
    ${data?.years?.length > 1 && html`<div class="chips" role="group" aria-label="Ano">
      <button class=${`chip ${!year ? 'on' : ''}`} aria-pressed=${!year} onClick=${() => setYear(null)}>Tudo</button>
      ${data.years.map((y) => html`<button key=${y} class=${`chip ${year === y ? 'on' : ''}`} aria-pressed=${year === y} onClick=${() => setYear(y)}>${y}</button>`)}
    </div>`}

    ${error && !data && html`<${ErrorBox} error=${error} />`}
    ${data && !data.entries.length && html`<p class="muted" style="font-size:14px">Cada livro terminado vira uma linha aqui, com data e nota.</p>`}

    <div>
      ${groups.map((g) => html`<section key=${g.key}>
        <h3 class="month-head">${monthName(g.m)} ${g.y} <small>${plural(g.entries.length, 'livro', 'livros')}</small></h3>
        ${g.entries.map((entry) => {
          const { d, weekday } = parseDate(entry.finished_on);
          return html`<a key=${entry.id} class="diary-row" href=${`/livro/${encodeURIComponent(entry.book.id)}`} onClick=${open(entry.book)}>
            <div class="diary-day">${d}<small>${weekday}</small></div>
            <${Cover} book=${entry.book} />
            <div style="min-width:0">
              <div class="diary-title">${entry.book.title}</div>
              <${Stars} value=${entry.rating} size=${13} />
            </div>
            <div class="diary-marks">
              ${entry.reread && html`<span title="Releitura" aria-label="Releitura"><${Icon.reread} /></span>`}
              ${entry.review && html`<span title="Com resenha" aria-label="Com resenha"><${Icon.note} /></span>`}
            </div>
          </a>`;
        })}
      </section>`)}
    </div>
  </section>`;
}
