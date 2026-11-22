import { html, useRef, useState } from '/vendor/htm-preact.js';
import { act, api, authorLine, formatDate, navigate, num, ratingText, useBookTone, useFetch } from '../lib.js';
import { Cover, ErrorBox, Icon, Rail, Sheet, Stars } from '../ui.js';
import { ListPickerSheet, LogSheet, ProgressSheet, QuoteSheet, GenrePicker } from '../sheets.js';

const FORMAT_LABEL = { paper: 'papel', ebook: 'e-book', audio: 'áudio' };

function Community({ data }) {
  if (!data || (!data.count && !data.read && !data.want)) return null;
  const max = Math.max(1, ...Object.values(data.counts || {}));
  return html`<section class="community" aria-label="Comunidade Open Library">
    <div class="community-top">
      <span class="muted" style="font-size:13px">Leitores da Open Library</span>
      ${data.average != null && html`<span class="community-avg">${data.average.toFixed(1).replace('.', ',')}</span>`}
    </div>
    ${data.counts && data.count > 0 && html`<div class="bars5">
      ${[1, 2, 3, 4, 5].map((n) => html`<i key=${n} title=${`${n} estrela${n > 1 ? 's' : ''}: ${num(data.counts[n])}`} style=${{ height: `${((data.counts[n] || 0) / max) * 100}%` }}></i>`)}
    </div>
    <div class="bars5-axis" aria-hidden="true">${[1, 2, 3, 4, 5].map((n) => html`<span key=${n}>${n}</span>`)}</div>`}
    <div class="community-foot">
      <div><b>${num(data.read)}</b>leram</div>
      <div><b>${num(data.reading)}</b>lendo</div>
      <div><b>${num(data.want)}</b>querem</div>
    </div>
  </section>`;
}

function Review({ log }) {
  const [shown, setShown] = useState(false);
  if (!log.review) return null;
  const hidden = log.spoilers && !shown;
  return html`<div class="entry-review">
    ${log.spoilers && !shown && html`<p class="muted" style="font-size:13px;margin-bottom:4px">Tem spoiler. Toque para revelar.</p>`}
    <p class=${`prose ${hidden ? 'spoiler' : ''}`} onClick=${() => setShown(true)}>${log.review}</p>
  </div>`;
}

function About({ book }) {
  const [open, setOpen] = useState(false);
  if (!book.description && !book.subjects?.length) return null;
  const isLong = (book.description || '').length > 340;
  return html`<section class="section">
    <h2 class="section-title" style="margin-bottom:8px">Sobre o livro</h2>
    ${book.description && html`<p class=${`prose ${isLong && !open ? 'clamped' : ''}`}>${book.description}</p>`}
    ${isLong && html`<button class="more-btn" onClick=${() => setOpen(!open)}>${open ? 'Mostrar menos' : 'Continuar lendo'}</button>`}
    ${book.subjects?.length > 0 && html`<div class="tags">${book.subjects.slice(0, 8).map((s) => html`<span key=${s} class="tag">${s}</span>`)}</div>`}
  </section>`;
}

function EditSheet({ book, onClose }) {
  const { data: allGenres } = useFetch('/genres');
  const [form, setForm] = useState({
    title: book.title,
    authors: book.authors.join(', '),
    pages: book.pages ?? '',
    year: book.year ?? '',
    isbn: book.isbn ?? '',
    description: book.description ?? '',
  });
  const [genres, setGenres] = useState(() => book.genres || []);
  const [otherSubjects, setOtherSubjects] = useState(() => (book.other_subjects || []).join(', '));
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const toggleGenre = (id) => setGenres((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const fileRef = useRef(null);
  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const bytes = await file.arrayBuffer();
    const ok = await act(() => api(`/books/${encodeURIComponent(book.id)}/cover`, { method: 'POST', raw: bytes }), 'Capa trocada.');
    if (ok) onClose();
  };
  const save = async (e) => {
    e.preventDefault();
    const labelById = new Map((allGenres || []).map((g) => [g.id, g.label]));
    const genreLabels = genres.map((id) => labelById.get(id)).filter(Boolean);
    const extras = otherSubjects.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    const subjects = allGenres ? [...genreLabels, ...extras] : undefined;
    setSaving(true);
    const ok = await act(
      () => api(`/books/${encodeURIComponent(book.id)}`, { method: 'PATCH', body: { ...form, ...(subjects !== undefined ? { subjects } : {}) } }),
      'Livro atualizado.',
    );
    setSaving(false);
    if (ok) onClose();
  };
  return html`<${Sheet} title="Ajustar livro" onClose=${onClose}>
    <button class="btn block" onClick=${() => fileRef.current.click()}><${Icon.camera} /> Usar foto da minha edição</button>
    <input ref=${fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange=${upload} />
    <form onSubmit=${save}>
      <label class="field"><span>Título</span><input class="input" required value=${form.title} onInput=${set('title')} /></label>
      <label class="field"><span>Autoria (separe por vírgula)</span><input class="input" value=${form.authors} onInput=${set('authors')} /></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Páginas</span><input class="input" type="number" inputmode="numeric" min="1" value=${form.pages} onInput=${set('pages')} /></label>
        <label class="field"><span>Ano</span><input class="input" type="number" inputmode="numeric" min="0" value=${form.year} onInput=${set('year')} /></label>
      </div>
      <label class="field"><span>ISBN</span><input class="input" placeholder="10 ou 13 dígitos" value=${form.isbn} onInput=${set('isbn')} /></label>
      <label class="field"><span>Sinopse</span><textarea class="input" rows="4" value=${form.description} onInput=${set('description')}></textarea></label>
      <${GenrePicker} selected=${genres} onToggle=${toggleGenre} other=${otherSubjects} onOther=${setOtherSubjects} />
      <div class="sticky-save">
        <button class="btn primary block" disabled=${saving}>${saving ? 'Salvando…' : 'Salvar'}</button>
      </div>
    </form>
  <//>`;
}

function FavoritePicker({ book, onClose }) {
  const { data } = useFetch('/profile');
  const slots = data?.favorites || [null, null, null, null];
  const pick = async (i) => {
    const ok = await act(() => api(`/favorites/${i + 1}`, { method: 'PUT', body: { book_id: book.id } }), 'Agora está nos seus 4 favoritos.');
    if (ok) onClose();
  };
  return html`<${Sheet} title="Qual dos 4 favoritos ele substitui?" onClose=${onClose}>
    <div class="fav-grid" style="grid-template-columns:repeat(4,1fr)">
      ${slots.map((b, i) => html`<button key=${i} onClick=${() => pick(i)} aria-label=${b ? `Substituir ${b.title}` : `Lugar ${i + 1}`}>
        ${b ? html`<${Cover} book=${b} />` : html`<span class="fav-empty"><${Icon.plus} /></span>`}
      </button>`)}
    </div>
  <//>`;
}

function Related({ id }) {
  const { data } = useFetch(`/books/${encodeURIComponent(id)}/related`);
  return (data || []).map((rail) => html`<${Rail} key=${rail.title} title=${rail.title} books=${rail.books} />`);
}

function BookNav({ onEdit }) {
  return html`<div class="book-nav">
    <button class="icon-btn" onClick=${() => { if (history.length > 1) history.back(); else navigate('/'); }} aria-label="Voltar"><${Icon.back} /></button>
    ${onEdit && html`<button class="icon-btn" onClick=${onEdit} aria-label="Ajustar livro"><${Icon.edit} /></button>`}
  </div>`;
}

const STATUS_BUTTONS = [
  ['want', 'Quero ler', Icon.bookmark],
  ['reading', 'Lendo', Icon.open],
  ['read', 'Lido', Icon.check],
  ['dropped', 'Abandonei', Icon.drop],
];

export function BookView({ id }) {
  const { data, error } = useFetch(`/books/${encodeURIComponent(id)}`);
  const [sheet, setSheet] = useState(null);

  if (error && !data) {
    return html`<main class="page flush-top"><${BookNav} /><${ErrorBox} error=${error} onRetry=${() => location.reload()} /></main>`;
  }
  if (!data) {
    return html`<main class="page flush-top">
      <${BookNav} />
      <div class="book-head"><div class="skel book-cover" style="aspect-ratio:2/3"></div><div class="skel" style="height:34px;width:70%;margin-top:20px"></div></div>
    </main>`;
  }
  return html`<${BookLoaded} data=${data} sheet=${sheet} setSheet=${setSheet} />`;
}

function BookLoaded({ data, sheet, setSheet }) {
  const { book, community, logs, quotes, lists, favorite_slot: favoriteSlot } = data;
  const tone = useBookTone(book);
  const [editLog, setEditLog] = useState(null);
  const bookId = encodeURIComponent(book.id);

  const setStatus = async (status) => {
    if (status === 'read') { setSheet('log'); return; }
    await act(() => api(`/books/${bookId}/shelf`, { method: 'PUT', body: { status: book.status === status ? null : status } }));
  };
  const removeFavorite = () => act(() => api(`/favorites/${favoriteSlot}`, { method: 'PUT', body: { book_id: null } }), 'Saiu dos 4 favoritos.');
  const removeQuote = (q) => confirm('Apagar este trecho?') && act(() => api(`/quotes/${q.id}`, { method: 'DELETE' }));

  const pct = book.pages && book.current_page ? Math.round((book.current_page / book.pages) * 100) : 0;

  return html`<main class="page flush-top" style=${{ '--tone': tone }}>
    <div class="book-hero">
      <${BookNav} onEdit=${() => setSheet('edit')} />
      <div class="book-head">
        <div class="book-cover"><${Cover} book=${book} size="L" /></div>
        <div class="book-summary">
          <h1 class="book-title">${book.title}</h1>
          ${book.subtitle && html`<p class="book-sub">${book.subtitle}</p>`}
          ${book.original_title && html`<p class="book-sub">${book.original_title}</p>`}
          <p class="book-author">${authorLine(book)}</p>
          <p class="book-meta">${[book.year, book.pages ? `${num(book.pages)} páginas` : null, book.isbn ? `ISBN ${book.isbn}` : null].filter(Boolean).join(' · ')}</p>
          ${book.rating && html`<div class="my-rating"><${Stars} value=${book.rating} size=${20} /><span class="muted" style="font-size:14px">${ratingText(book.rating)}, sua nota</span></div>`}

          <div class="book-actions">
            <div class="action-row">
              <button class="btn primary" onClick=${() => setSheet('log')}>${logs.length ? 'Registrar releitura' : 'Registrar leitura'}</button>
              <button class="ear-btn" onClick=${() => setSheet('list')} aria-label="Adicionar à lista" title="Adicionar à lista"><${Icon.list} /></button>
            </div>
            <div class="status-row" role="group" aria-label="Status">
              ${STATUS_BUTTONS.map(([id, label, I]) => html`<button key=${id} class=${`status-btn ${book.status === id ? 'on' : ''}`} aria-pressed=${book.status === id} onClick=${() => setStatus(id)}><${I} />${label}</button>`)}
            </div>
            ${book.status === 'reading' && html`<div>
              <div class="progress"><i style=${{ width: `${pct}%` }}></i></div>
              <div class="progress-row">
                <span>${book.current_page ? `pág. ${num(book.current_page)}${book.pages ? ` de ${num(book.pages)} · ${pct}%` : ''}` : 'Ainda no começo'}</span>
                <button class="btn small" onClick=${() => setSheet('progress')}>Atualizar página</button>
              </div>
            </div>`}
          </div>
        </div>
      </div>
    </div>

    <div class="book-columns">
      <div style="min-width:0">
        <${About} book=${book} />

        ${logs.length > 0 && html`<section class="section">
          <h2 class="section-title">Seu diário</h2>
          ${logs.map((log) => html`<article key=${log.id} class="entry">
            <div class="entry-top">
              <span>${log.reread ? 'Releu' : 'Leu'} em ${formatDate(log.finished_on)}${log.format ? ` · ${FORMAT_LABEL[log.format]}` : ''}</span>
              <span style="display:flex;align-items:center;gap:6px">
                <${Stars} value=${log.rating} />
                <button class="link-btn" onClick=${() => setEditLog(log)}>Editar</button>
              </span>
            </div>
            <${Review} log=${log} />
          </article>`)}
        </section>`}

        <section class="section">
          <div class="section-head">
            <h2 class="section-title">Trechos</h2>
            <button class="section-link" onClick=${() => setSheet('quote')}>+ Guardar trecho</button>
          </div>
          ${quotes.length === 0 && html`<p class="muted" style="font-size:14px">Aquela frase que você sublinhou mora aqui.</p>`}
          ${quotes.map((q) => html`<div key=${q.id} class="quote-item">
            <blockquote>${q.text}</blockquote>
            <div class="quote-foot"><span>${q.page ? `p. ${q.page}` : ''}</span><button class="link-btn" onClick=${() => removeQuote(q)}>Apagar</button></div>
          </div>`)}
        </section>
      </div>

      <aside style="min-width:0">
        ${community && html`<div class="section"><${Community} data=${community} /></div>`}
        <div class="section" style="display:grid;gap:8px">
          ${favoriteSlot
            ? html`<button class="btn" onClick=${removeFavorite}>Tirar dos 4 favoritos</button>`
            : html`<button class="btn" onClick=${() => setSheet('favorite')}>Adicionar aos 4 favoritos</button>`}
          ${lists.length > 0 && html`<p class="muted" style="font-size:13px;text-align:center">Nas listas: ${lists.map((l, i) => html`${i ? ', ' : ''}<a href=${`/listas/${l.id}`} style="text-decoration:underline">${l.title}</a>`)}</p>`}
        </div>
      </aside>
    </div>

    <${Related} id=${book.id} />

    ${sheet === 'log' && html`<${LogSheet} book=${book} onClose=${() => setSheet(null)} />`}
    ${editLog && html`<${LogSheet} book=${book} log=${editLog} onClose=${() => setEditLog(null)} />`}
    ${sheet === 'progress' && html`<${ProgressSheet} book=${book} onClose=${() => setSheet(null)} onFinish=${() => setSheet('log')} />`}
    ${sheet === 'quote' && html`<${QuoteSheet} book=${book} onClose=${() => setSheet(null)} />`}
    ${sheet === 'list' && html`<${ListPickerSheet} book=${book} memberOf=${lists} onClose=${() => setSheet(null)} />`}
    ${sheet === 'edit' && html`<${EditSheet} book=${book} onClose=${() => setSheet(null)} />`}
    ${sheet === 'favorite' && html`<${FavoritePicker} book=${book} onClose=${() => setSheet(null)} />`}
  </main>`;
}

