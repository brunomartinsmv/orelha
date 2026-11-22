import { html, useEffect, useRef, useState } from '/vendor/htm-preact.js';
import { act, api, authorLine, navigate, STATUS, useFetch } from '../lib.js';
import { Cover, ErrorBox, Icon, Sheet, Stars } from '../ui.js';
import { GenrePicker } from '../sheets.js';

function ManualSheet({ initialTitle, onClose }) {
  const { data: allGenres } = useFetch('/genres');
  const [form, setForm] = useState({ title: initialTitle, authors: '', year: '', pages: '', isbn: '', description: '' });
  const [genres, setGenres] = useState([]);
  const [otherSubjects, setOtherSubjects] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const toggleGenre = (id) => setGenres((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const save = async (e) => {
    e.preventDefault();
    const labelById = new Map((allGenres || []).map((g) => [g.id, g.label]));
    const subjects = [
      ...genres.map((id) => labelById.get(id)).filter(Boolean),
      ...otherSubjects.split(/[,;]/).map((s) => s.trim()).filter(Boolean),
    ];
    setSaving(true);
    const book = await act(() => api('/books', { method: 'POST', body: { ...form, subjects } }), 'Livro criado.');
    setSaving(false);
    if (book) { onClose(); navigate(`/livro/${encodeURIComponent(book.id)}`); }
  };
  return html`<${Sheet} title="Adicionar à mão" onClose=${onClose}>
    <form onSubmit=${save}>
      <label class="field"><span>Título</span><input class="input" required value=${form.title} onInput=${set('title')} /></label>
      <label class="field"><span>Autoria (separe por vírgula)</span><input class="input" value=${form.authors} onInput=${set('authors')} /></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Páginas</span><input class="input" type="number" inputmode="numeric" min="1" value=${form.pages} onInput=${set('pages')} /></label>
        <label class="field"><span>Ano</span><input class="input" type="number" inputmode="numeric" min="0" value=${form.year} onInput=${set('year')} /></label>
      </div>
      <label class="field"><span>ISBN (opcional)</span><input class="input" placeholder="10 ou 13 dígitos" value=${form.isbn} onInput=${set('isbn')} /></label>
      <label class="field"><span>Sinopse (opcional)</span><textarea class="input" rows="3" value=${form.description} onInput=${set('description')}></textarea></label>
      <${GenrePicker} selected=${genres} onToggle=${toggleGenre} other=${otherSubjects} onOther=${setOtherSubjects} />
      <p class="muted" style="font-size:13px;margin-top:12px;text-align:center">A capa você pode fotografar depois, na página do livro.</p>
      <div class="sticky-save">
        <button class="btn primary block" disabled=${saving}>${saving ? 'Criando…' : 'Criar livro'}</button>
      </div>
    </form>
  <//>`;
}

function Result({ book }) {
  const [saved, setSaved] = useState(book.status);
  const href = `/livro/${encodeURIComponent(book.id)}`;
  const want = async () => {
    const ok = await act(() => api(`/books/${encodeURIComponent(book.id)}/shelf`, { method: 'PUT', body: { status: 'want' } }), 'Guardado em Quero ler.');
    if (ok) setSaved('want');
  };
  return html`<div class="result">
    <a href=${href} aria-hidden="true" tabindex="-1"><${Cover} book=${book} /></a>
    <a href=${href} style="min-width:0">
      <div class="result-title">${book.title}</div>
      <div class="result-meta">${authorLine(book)}${book.year ? ` · ${book.year}` : ''}</div>
      ${book.original_title && html`<div class="result-orig">${book.original_title}</div>`}
      ${saved && html`<div class="status-tag"><${Icon.check} /> ${STATUS[saved]}${book.rating ? html` · <${Stars} value=${book.rating} size=${11} />` : ''}</div>`}
    </a>
    ${!saved && html`<button class="icon-btn" onClick=${want} aria-label=${`Quero ler ${book.title}`} title="Quero ler"><${Icon.bookmark} /></button>`}
  </div>`;
}

export function SearchView({ search }) {
  const [q, setQ] = useState(search.get('q') || '');
  const [state, setState] = useState({ results: null, loading: false, error: null, query: '' });
  const [manual, setManual] = useState(false);
  const input = useRef(null);

  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    const query = q.trim();
    history.replaceState(null, '', query ? `/buscar?q=${encodeURIComponent(query)}` : '/buscar');
    if (query.length < 2) { setState({ results: null, loading: false, error: null, query: '' }); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const results = await api(`/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        setState({ results, loading: false, error: null, query });
      } catch (error) {
        if (error.name !== 'AbortError') setState({ results: null, loading: false, error, query });
      }
    }, 320);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q]);

  return html`<main class="page flush-top">
    <div class="search-box">
      <div class="search-input-wrap">
        <${Icon.search} />
        <input ref=${input} class="input" type="search" enterkeyhint="search" placeholder="Título, autor ou ISBN" aria-label="Buscar livro"
          autocapitalize="off" autocomplete="off" value=${q} onInput=${(e) => setQ(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} />
      </div>
    </div>

    ${state.error && html`<${ErrorBox} error=${state.error} />`}
    ${state.loading && !state.results && html`<p class="muted" style="padding:16px 0">Procurando nas estantes…</p>`}
    ${!q.trim() && html`<div class="empty" style="margin-top:12px;border:0;padding-top:40px">
      <h3>Qual é o livro?</h3>
      <p>Títulos em português aparecem com a edição brasileira quando existe. Procure também pelo ISBN do verso.</p>
    </div>`}

    ${state.results && state.results.map((book) => html`<${Result} key=${book.id} book=${book} />`)}

    ${state.results && !state.loading && html`<div class=${state.results.length ? '' : 'empty'} style=${state.results.length ? 'padding:20px 0;text-align:center' : 'margin-top:12px'}>
      ${!state.results.length && html`<h3>Não achei “${state.query}”</h3><p>A Open Library não conhece todo livro brasileiro. Você pode cadastrar este.</p>`}
      <button class="btn" onClick=${() => setManual(true)}><${Icon.plus} /> Adicionar à mão</button>
    </div>`}

    ${manual && html`<${ManualSheet} initialTitle=${state.query} onClose=${() => setManual(false)} />`}
  </main>`;
}
