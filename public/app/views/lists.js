import { html, useState } from '/vendor/htm-preact.js';
import { act, api, authorLine, navigate, plural, useFetch } from '../lib.js';
import { Cover, ErrorBox, Icon, PageHeader, Sheet, Toggle } from '../ui.js';
import { BookPickerSheet } from '../sheets.js';

function NewListSheet({ onClose }) {
  const [form, setForm] = useState({ title: '', description: '', ranked: false });
  const save = async (e) => {
    e.preventDefault();
    const list = await act(() => api('/lists', { method: 'POST', body: form }));
    if (list) { onClose(); navigate(`/listas/${list.id}`); }
  };
  return html`<${Sheet} title="Nova lista" onClose=${onClose}>
    <form onSubmit=${save}>
      <label class="field"><span>Nome</span><input class="input" required autofocus placeholder="Livros para ler na praia" value=${form.title} onInput=${(e) => setForm({ ...form, title: e.target.value })} /></label>
      <label class="field"><span>Descrição (opcional)</span><textarea class="input" rows="2" style="min-height:70px" value=${form.description} onInput=${(e) => setForm({ ...form, description: e.target.value })}></textarea></label>
      <div style="margin-top:8px"><${Toggle} label="Numerada, como um ranking" checked=${form.ranked} onChange=${(ranked) => setForm({ ...form, ranked })} /></div>
      <button class="btn primary block" style="margin-top:14px" disabled=${!form.title.trim()}>Criar lista</button>
    </form>
  <//>`;
}

export function ListsView() {
  const { data, error } = useFetch('/lists');
  const [creating, setCreating] = useState(false);
  return html`<main class="page">
    <${PageHeader} title="Listas" back=${true} right=${html`<button class="btn small" onClick=${() => setCreating(true)}><${Icon.plus} /> Nova</button>`} />
    ${error && !data && html`<${ErrorBox} error=${error} />`}
    ${data && !data.length && html`<div class="empty" style="margin-top:18px">
      <h3>Toda boa estante tem suas obsessões</h3>
      <p>Faça uma lista: os melhores do ano, para dar de presente, para reler na velhice.</p>
      <button class="btn primary" onClick=${() => setCreating(true)}>Criar minha primeira lista</button>
    </div>`}
    <div style="margin-top:6px">
      ${(data || []).map((list) => html`<a key=${list.id} class="list-card" href=${`/listas/${list.id}`}>
        ${list.preview.length > 0 && html`<div class="fan">${list.preview.map((b, i) => html`<span key=${b.id} class="cover-frame" style=${{ '--i': i, position: 'relative' }}><${Cover} book=${b} /></span>`)}</div>`}
        <div class="list-title">${list.title}</div>
        <div class="list-desc">${plural(list.count, 'livro', 'livros')}${list.description ? ` · ${list.description}` : ''}</div>
      </a>`)}
    </div>
    ${creating && html`<${NewListSheet} onClose=${() => setCreating(false)} />`}
  </main>`;
}

export function ListView({ id }) {
  const { data: list, error } = useFetch(`/lists/${id}`);
  const [adding, setAdding] = useState(false);
  if (error && !list) return html`<main class="page"><${ErrorBox} error=${error} /></main>`;
  if (!list) return html`<main class="page"><div class="skel" style="height:60px;margin-top:20px"></div></main>`;

  const add = async (book) => {
    setAdding(false);
    await act(() => api(`/lists/${id}/items`, { method: 'POST', body: { book_id: book.id } }), 'Adicionado.');
  };
  const remove = (book) => act(() => api(`/lists/${id}/items/${encodeURIComponent(book.id)}`, { method: 'DELETE' }));
  const move = (index, delta) => {
    const order = list.books.map((b) => b.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    act(() => api(`/lists/${id}`, { method: 'PATCH', body: { order } }));
  };
  const destroy = async () => {
    if (!confirm(`Apagar a lista "${list.title}"? Os livros continuam na estante.`)) return;
    const ok = await act(() => api(`/lists/${id}`, { method: 'DELETE' }), 'Lista apagada.');
    if (ok) navigate('/listas', { replace: true });
  };

  return html`<main class="page">
    <${PageHeader} title=${list.title} sub=${list.description} back=${true}
      right=${html`<button class="icon-btn" onClick=${destroy} aria-label="Apagar lista"><${Icon.trash} /></button>`} />
    <button class="btn block" style="margin:14px 0 6px" onClick=${() => setAdding(true)}><${Icon.plus} /> Adicionar livro</button>
    ${!list.books.length && html`<div class="empty" style="margin-top:12px"><h3>Lista vazia</h3><p>Que livro abre esta lista?</p></div>`}
    ${list.books.map((book, i) => html`<div key=${book.id} class=${`list-row ${list.ranked ? '' : 'unranked'}`}>
      ${list.ranked && html`<div class="rank">${i + 1}</div>`}
      <a href=${`/livro/${encodeURIComponent(book.id)}`} aria-hidden="true" tabindex="-1"><${Cover} book=${book} /></a>
      <a href=${`/livro/${encodeURIComponent(book.id)}`} style="min-width:0">
        <div class="diary-title">${book.title}</div>
        <div class="result-meta">${authorLine(book)}</div>
      </a>
      <div class="row-actions">
        ${list.ranked && html`<button class="icon-btn" disabled=${i === 0} onClick=${() => move(i, -1)} aria-label=${`Subir ${book.title}`}><${Icon.up} /></button>
        <button class="icon-btn" disabled=${i === list.books.length - 1} onClick=${() => move(i, 1)} aria-label=${`Descer ${book.title}`}><${Icon.down} /></button>`}
        <button class="icon-btn" onClick=${() => remove(book)} aria-label=${`Tirar ${book.title} da lista`}><${Icon.close} /></button>
      </div>
    </div>`)}
    ${adding && html`<${BookPickerSheet} title="Adicionar à lista" onPick=${add} onClose=${() => setAdding(false)} />`}
  </main>`;
}
