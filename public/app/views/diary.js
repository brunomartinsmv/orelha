import { html, useEffect, useMemo, useRef, useState } from '/vendor/htm-preact.js';
import { invalidate, localDate, monthName, parseDate, plural, useFetch } from '../lib.js';
import { Cover, ErrorBox, Icon, Stars } from '../ui.js';

const WEEKDAYS = [
  ['dom', 'domingo'], ['seg', 'segunda-feira'], ['ter', 'terça-feira'], ['qua', 'quarta-feira'],
  ['qui', 'quinta-feira'], ['sex', 'sexta-feira'], ['sáb', 'sábado'],
];

function monthStart(month) {
  return new Date(`${month}-01T00:00:00Z`);
}

function shiftMonth(month, offset) {
  const date = monthStart(month);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

function CalendarGrid({ month, open }) {
  const { data, error } = useFetch(`/diary/calendar?month=${month}`);
  if (!data) return error
    ? html`<${ErrorBox} error=${error} onRetry=${invalidate} />`
    : html`<p class="calendar-status muted" role="status">Carregando calendário…</p>`;

  const first = monthStart(month);
  const start = first.getUTCDay();
  first.setUTCMonth(first.getUTCMonth() + 1, 0);
  const days = first.getUTCDate();
  const weeks = Math.ceil((start + days) / 7);
  const today = localDate();
  const progress = new Set(data.progress_days);
  const finishes = new Map();
  for (const entry of data.finishes) {
    if (!finishes.has(entry.finished_on)) finishes.set(entry.finished_on, []);
    finishes.get(entry.finished_on).push(entry);
  }

  return html`<table class="diary-calendar" aria-labelledby="diary-calendar-month">
    <thead><tr>${WEEKDAYS.map(([short, full]) => html`<th key=${short} scope="col" aria-label=${full}>${short}</th>`)}</tr></thead>
    <tbody>
      ${Array.from({ length: weeks }, (_, week) => html`<tr key=${week}>
        ${WEEKDAYS.map(([weekday], column) => {
          const day = week * 7 + column - start + 1;
          if (day < 1 || day > days) return html`<td key=${weekday} class="calendar-blank"></td>`;
          const date = `${month}-${String(day).padStart(2, '0')}`;
          return html`<td key=${weekday}>
            <div class="calendar-day">
              <time datetime=${date} aria-current=${date === today ? 'date' : undefined}>${day}</time>
              ${progress.has(date) && html`<span class="calendar-dot" role="img" aria-label="Progresso registrado" title="Progresso registrado"></span>`}
            </div>
            ${(finishes.get(date) || []).map(({ id, book }) => html`<a key=${id} class="calendar-cover" href=${`/livro/${encodeURIComponent(book.id)}`}
                onClick=${open(book)} aria-label=${`Livro terminado: ${book.title}`} title=${book.title}>
              <${Cover} book=${book} />
            </a>`)}
          </td>`;
        })}
      </tr>`)}
    </tbody>
  </table>`;
}

function DiaryCalendar({ month, setMonth, open }) {
  const date = monthStart(month);
  return html`<div class="calendar">
    <div class="calendar-nav">
      <button class="icon-btn" aria-label="Mês anterior" disabled=${month === '0001-01'} onClick=${() => setMonth(shiftMonth(month, -1))}><${Icon.back} /></button>
      <h3 id="diary-calendar-month" aria-live="polite">${monthName(date.getUTCMonth())} de ${date.getUTCFullYear()}</h3>
      <button class="icon-btn" aria-label="Próximo mês" disabled=${month === '9999-12'} onClick=${() => setMonth(shiftMonth(month, 1))}><${Icon.chevron} /></button>
    </div>
    <${CalendarGrid} key=${month} month=${month} open=${open} />
    <p class="calendar-legend"><span class="calendar-dot" aria-hidden="true"></span> Progresso registrado</p>
  </div>`;
}

// O diário mora embaixo da estante: a estante mostra os melhores, o diário mostra os mais recentes.
export function DiarySection({ onOpen, focus }) {
  const [year, setYear] = useState(null);
  const [{ calendar, month }, setDiary] = useState(() => history.state?.diary ?? {
    calendar: false, month: localDate().slice(0, 7),
  });
  const { data, error } = useFetch(calendar ? null : `/diary${year ? `?year=${year}` : ''}`);
  const ref = useRef(null);
  const focused = useRef(false);
  const ready = calendar || Boolean(data || error);

  const updateDiary = (next) => {
    history.replaceState({ ...history.state, diary: next }, '');
    setDiary(next);
  };

  // Quem chega por /diario cai direto aqui.
  useEffect(() => {
    if (!focus || !ready || focused.current) return;
    focused.current = true;
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'start' }));
  }, [focus, ready]);

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
      ${!calendar && data?.entries?.length > 0 && html`<span class="muted" style="font-size:14px">${plural(data.entries.length, 'leitura', 'leituras')}</span>`}
    </div>
    <div class="chips diary-views" role="group" aria-label="Visualização do diário">
      <button class=${`chip ${calendar ? '' : 'on'}`} aria-pressed=${!calendar} onClick=${() => updateDiary({ calendar: false, month })}>Lista</button>
      <button class=${`chip ${calendar ? 'on' : ''}`} aria-pressed=${calendar} onClick=${() => updateDiary({ calendar: true, month })}>Calendário</button>
    </div>
    ${calendar ? html`<${DiaryCalendar} month=${month} setMonth=${(next) => updateDiary({ calendar: true, month: next })} open=${open} />` : html`
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
    `}
  </section>`;
}
