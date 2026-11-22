// Folhas de ação compartilhadas: registrar leitura, página atual, trecho, lista, seletor de livro.
import { html, useEffect, useState } from '/vendor/htm-preact.js';
import {
  act,
  api,
  authorLine,
  discardSyncItem,
  localDate,
  num,
  plural,
  queueProgress,
  queueQuote,
  retrySyncItem,
  STATUS,
  syncNow,
  toast,
  useFetch,
  useSyncState,
} from './lib.js';
import { Cover, Icon, Sheet, StarInput, Toggle } from './ui.js';

const FORMATS = [['paper', 'Papel'], ['ebook', 'E-book'], ['audio', 'Áudio']];

export function LogSheet({ book, log, onClose, onSaved }) {
  const editing = !!log;
  const [rating, setRating] = useState(log?.rating ?? null);
  const [finished, setFinished] = useState(editing ? log.finished_on : localDate());
  const [started, setStarted] = useState(log?.started_on ?? book.started_on ?? null);
  const [review, setReview] = useState(log?.review ?? '');
  const [spoilers, setSpoilers] = useState(!!log?.spoilers);
  const [reread, setReread] = useState(log ? !!log.reread : book.status === 'read');
  const [format, setFormat] = useState(log?.format ?? null);
  const [saving, setSaving] = useState(false);

  const today = localDate();
  const yesterday = localDate(-1);
  const mode = !finished ? 'none' : finished === today ? 'today' : finished === yesterday ? 'yesterday' : 'other';

  const save = async (e) => {
    e.preventDefault();
    if (started && finished && started > finished) {
      toast('O início não pode ser depois do fim.', 'err');
      return;
    }
    setSaving(true);
    const body = { rating, finished_on: finished, started_on: started, review, spoilers, reread, format };
    const result = await act(
      () => (editing
        ? api(`/logs/${log.id}`, { method: 'PATCH', body })
        : api(`/books/${encodeURIComponent(book.id)}/logs`, { method: 'POST', body })),
      editing ? 'Registro atualizado.' : 'Está no seu diário.',
    );
    setSaving(false);
    if (result) { onClose(); onSaved?.(); }
  };

  const remove = async () => {
    if (!confirm('Apagar este registro do diário?')) return;
    const ok = await act(() => api(`/logs/${log.id}`, { method: 'DELETE' }), 'Registro apagado.');
    if (ok) onClose();
  };

  return html`<${Sheet} title=${editing ? 'Editar registro' : 'Registrar leitura'} onClose=${onClose}>
    <form onSubmit=${save}>
      <div class="sheet-log-book">
        <${Cover} book=${book} />
        <div><div class="t">${book.title}</div><div class="muted" style="font-size:14px">${authorLine(book)}</div></div>
      </div>
      <div class="sheet-rate"><${StarInput} value=${rating} onChange=${setRating} /></div>

      <div class="field">
        <span class="field-label">Terminei</span>
        <div class="seg">
          <button type="button" class=${mode === 'today' ? 'on' : ''} onClick=${() => setFinished(today)}>Hoje</button>
          <button type="button" class=${mode === 'yesterday' ? 'on' : ''} onClick=${() => setFinished(yesterday)}>Ontem</button>
          <button type="button" class=${mode === 'other' ? 'on' : ''} onClick=${() => { if (mode !== 'other') setFinished(localDate(-2)); }}>Outro dia</button>
          <button type="button" class=${mode === 'none' ? 'on' : ''} onClick=${() => setFinished(null)}>Não sei</button>
        </div>
        ${mode === 'other' && html`<input class="input" style="margin-top:8px" type="date" aria-label="Data em que terminou" max=${today} value=${finished} onInput=${(e) => setFinished(e.target.value || null)} />`}
      </div>

      <label class="field">
        <span>O que ficou? (opcional)</span>
        <textarea class="input" rows="4" placeholder="Escreva como quem conversa com um amigo." value=${review} onInput=${(e) => setReview(e.target.value)}></textarea>
      </label>

      <div style="margin-top:8px">
        <${Toggle} label="É uma releitura" checked=${reread} onChange=${setReread} />
        ${review.trim() && html`<${Toggle} label="Tem spoiler" checked=${spoilers} onChange=${setSpoilers} />`}
      </div>

      <div class="field">
        <span class="field-label">Formato</span>
        <div class="seg">
          ${FORMATS.map(([id, label]) => html`<button key=${id} type="button" class=${format === id ? 'on' : ''} onClick=${() => setFormat(format === id ? null : id)}>${label}</button>`)}
        </div>
      </div>

      <label class="field">
        <span>Comecei em (opcional)</span>
        <input class="input" type="date" max=${finished || today} value=${started || ''} onInput=${(e) => setStarted(e.target.value || null)} />
      </label>

      ${editing && html`<button type="button" class="btn danger block" style="margin-top:18px" onClick=${remove}><${Icon.trash} /> Apagar registro</button>`}
      <div class="sticky-save">
        <button class="btn primary block" disabled=${saving}>${saving ? 'Salvando…' : editing ? 'Salvar alterações' : 'Salvar no diário'}</button>
      </div>
    </form>
  <//>`;
}

export function ProgressSheet({ book, onClose, onFinish }) {
  const [page, setPage] = useState(book.current_page ?? '');
  const [saving, setSaving] = useState(false);
  const pct = book.pages && page ? Math.min(100, Math.round((Number(page) / book.pages) * 100)) : null;

  const save = async (e) => {
    e.preventDefault();
    if (page === '' || saving) return;
    const numPage = Number(page);
    if (!Number.isInteger(numPage) || numPage < 0) {
      toast('Página inválida.', 'err');
      return;
    }
    if (book.pages && numPage >= book.pages) {
      if (onFinish) { onClose(); onFinish(); return; }
      if (numPage > book.pages) { toast(`Este livro tem ${book.pages} páginas.`, 'err'); return; }
    }
    setSaving(true);
    const res = await queueProgress(book, { page: numPage, on_day: localDate() });
    setSaving(false);
    if (res.status === 'synced') {
      toast('Página atualizada.');
      onClose();
    } else if (res.status === 'queued') {
      toast('Página salva na fila de sincronização.');
      onClose();
    } else {
      toast(res.error?.message || 'Não foi possível atualizar a página.', 'err');
      if (res.status === 'conflict') onClose();
    }
  };

  return html`<${Sheet} title="Em que página você está?" onClose=${onClose}>
    <form onSubmit=${save}>
      <p class="muted" style="font-size:14px">${book.title}${book.pages ? ` · ${book.pages} páginas` : ''}</p>
      <label class="field"><span>Página atual</span>
        <input class="input" type="number" inputmode="numeric" min="0" max=${book.pages || undefined} autofocus value=${page} onInput=${(e) => setPage(e.target.value)} />
      </label>
      ${book.pages && html`<div class="progress"><i style=${{ width: `${pct || 0}%` }}></i></div>
        <p class="muted" style="font-size:13px">${pct ?? 0}% do livro</p>`}
      <button class="btn primary block" style="margin-top:16px" disabled=${saving || page === ''}>Salvar</button>
      ${onFinish && html`<button type="button" class="btn block" style="margin-top:8px" onClick=${() => { onClose(); onFinish(); }}><${Icon.check} /> Terminei este livro</button>`}
    </form>
  <//>`;
}

function GoalSheet({ goal, onClose }) {
  const [target, setTarget] = useState(goal.target ?? '');
  const [saving, setSaving] = useState(false);
  const write = async (value) => {
    setSaving(true);
    const ok = await act(() => api('/settings', { method: 'PUT', body: { goal: value } }), value ? 'Meta salva.' : 'Meta removida.');
    setSaving(false);
    if (ok) onClose();
  };
  return html`<${Sheet} title=${`Meta de ${goal.year}`} onClose=${onClose}>
    <form onSubmit=${(e) => { e.preventDefault(); write(Number(target)); }}>
      <p class="muted" style="font-size:14px">Até agora, ${plural(goal.done, 'livro terminado', 'livros terminados')} em ${goal.year}.</p>
      <label class="field"><span>Quantos livros quer terminar?</span>
        <input class="input" type="number" inputmode="numeric" min="1" max="1000" step="1" required autofocus value=${target} onInput=${(e) => setTarget(e.target.value)} />
      </label>
      <button class="btn primary block" style="margin-top:16px" disabled=${saving || target === ''}>Salvar</button>
      ${goal.target && html`<button type="button" class="btn danger block" style="margin-top:8px" disabled=${saving} onClick=${() => write(null)}>Remover meta</button>`}
    </form>
  <//>`;
}

// A meta do ano, editável onde ela aparece. Sem meta, vira um convite para criar uma.
// Meta como rodapé: o número leva aos Números da leitura (onde pedir), o lápis muda a meta.
export function GoalLine({ goal, statsLink = false }) {
  const [open, setOpen] = useState(false);
  const pct = goal.target ? Math.min(100, (goal.done / goal.target) * 100) : 0;
  const edit = () => setOpen(true);
  const label = html`<span>Meta de ${goal.year}</span><span class="goal-count"><b>${goal.done}</b> de ${goal.target} livros</span>`;
  return html`<div class=${`goal ${goal.target ? 'has-target' : 'no-target'}`}>
    ${goal.target
      ? html`<div class="goal-line">
          ${statsLink
            ? html`<a class="goal-label" href="/numeros" aria-label=${`Meta de ${goal.year}: ${goal.done} de ${goal.target} livros. Ver números da leitura`}>${label}</a>`
            : html`<span class="goal-label">${label}</span>`}
          <button class="goal-edit" onClick=${edit} aria-label="Alterar meta" title="Alterar meta"><${Icon.edit} /></button>
        </div>
        <span class="progress goal-bar"><i style=${{ width: `${pct}%` }}></i></span>`
      : html`<button class="goal-set" onClick=${edit}><${Icon.edit} /><span>Definir meta de livros para ${goal.year}</span></button>`}
    ${open && html`<${GoalSheet} goal=${goal} onClose=${() => setOpen(false)} />`}
  </div>`;
}

export function QuoteSheet({ book, onClose }) {
  const [text, setText] = useState('');
  const [page, setPage] = useState(book.current_page ?? '');
  const [saving, setSaving] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    if (!text.trim() || saving) return;
    setSaving(true);
    const res = await queueQuote(book, { text, page: page === '' ? null : Number(page) });
    setSaving(false);
    if (res.status === 'synced') {
      toast('Trecho guardado.');
      onClose();
    } else if (res.status === 'queued') {
      toast('Trecho salvo na fila de sincronização.');
      onClose();
    } else {
      toast(res.error?.message || 'Não foi possível guardar o trecho.', 'err');
    }
  };
  return html`<${Sheet} title="Guardar um trecho" onClose=${onClose}>
    <form onSubmit=${save}>
      <label class="field"><span>Trecho de ${book.title}</span>
        <textarea class="input" rows="5" autofocus required value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
      </label>
      <label class="field"><span>Página (opcional)</span>
        <input class="input" type="number" inputmode="numeric" min="0" value=${page} onInput=${(e) => setPage(e.target.value)} />
      </label>
      <button class="btn primary block" style="margin-top:16px" disabled=${saving || !text.trim()}>${saving ? 'Guardando…' : 'Guardar'}</button>
    </form>
  <//>`;
}

function describeOp(item) {
  if (item.kind === 'progress') return `Página ${num(item.payload.page)}`;
  if (item.kind === 'quote') {
    const clean = String(item.payload.text || '').trim();
    const preview = clean.length > 80 ? `${clean.slice(0, 77)}…` : clean;
    const prefix = item.payload.page != null ? `Trecho (p. ${num(item.payload.page)}): ` : 'Trecho: ';
    return `${prefix}“${preview}”`;
  }
  return item.payload.status
    ? `Status: ${STATUS[item.payload.status] || item.payload.status}`
    : 'Remover status da estante';
}

function describeServerState(current) {
  if (!current) return 'Alterado em outro aparelho';
  const parts = [current.status ? (STATUS[current.status] || current.status) : 'Sem status na estante'];
  if (current.current_page != null) parts.push(`pág. ${num(current.current_page)}`);
  return parts.join(' · ');
}

function stateBadge(item, isHead, syncing) {
  if (item.state === 'conflict') return 'Conflito';
  if (item.state === 'error') return 'Falhou';
  if (syncing && isHead) return 'Sincronizando…';
  return 'Aguardando';
}

export function SyncSheet({ onClose }) {
  const { items, syncing, blockedItem } = useSyncState();

  return html`<${Sheet} title="Fila de sincronização" onClose=${onClose}>
    ${items.length === 0
      ? html`<p class="muted" style="padding:12px 0">Nenhuma alteração aguardando sincronização.</p>`
      : html`
        <div class="sync-summary">
          <p class="muted" style="font-size:14px">${plural(items.length, 'alteração pendente', 'alterações pendentes')}. Elas são enviadas em ordem assim que o servidor responder.</p>
          ${!blockedItem && html`<button type="button" class="btn small primary" disabled=${syncing} onClick=${() => syncNow()}>
            ${syncing ? 'Sincronizando…' : 'Sincronizar agora'}
          </button>`}
        </div>
        <div class="sync-list">
          ${items.map((item, idx) => html`<article key=${item.seq} class=${`sync-item ${item.state}`}>
            <div class="sync-item-head">
              <strong class="sync-item-title">${item.book_title}</strong>
              <span class=${`sync-badge ${item.state}`}>${stateBadge(item, idx === 0, syncing)}</span>
            </div>
            <p class="sync-item-meta">${describeOp(item)}</p>
            ${item.state === 'conflict' && html`<div class="sync-item-error">
              <p>${item.error?.message || 'Este livro foi alterado em outro aparelho antes da sincronização.'}</p>
              <p class="muted" style="margin-top:4px">No servidor agora: ${describeServerState(item.error?.current)}</p>
            </div>`}
            ${item.state === 'error' && html`<div class="sync-item-error">
              <p>${item.error?.message || 'Não foi possível concluir a alteração.'}</p>
            </div>`}
            <div class="sync-item-actions">
              ${item.state === 'conflict' && html`<button type="button" class="btn small primary" disabled=${syncing} onClick=${() => retrySyncItem(item.seq, { force: true })}>Aplicar mesmo assim</button>`}
              ${item.state === 'error' && html`<button type="button" class="btn small primary" disabled=${syncing} onClick=${() => retrySyncItem(item.seq)}>Tentar de novo</button>`}
              <button type="button" class="btn small danger" disabled=${syncing && idx === 0 && item.state === 'pending'} onClick=${() => discardSyncItem(item.seq)}>Descartar</button>
            </div>
          </article>`)}
        </div>
      `}
  <//>`;
}

export function ListPickerSheet({ book, memberOf = [], onClose }) {
  const { data: lists } = useFetch('/lists');
  const [title, setTitle] = useState('');
  const member = new Set(memberOf.map((l) => l.id));

  const toggle = async (list) => {
    const has = member.has(list.id);
    await act(() => (has
      ? api(`/lists/${list.id}/items/${encodeURIComponent(book.id)}`, { method: 'DELETE' })
      : api(`/lists/${list.id}/items`, { method: 'POST', body: { book_id: book.id } })),
    has ? 'Removido da lista.' : `Adicionado a ${list.title}.`);
    onClose();
  };
  const create = async (e) => {
    e.preventDefault();
    const list = await act(() => api('/lists', { method: 'POST', body: { title } }));
    if (list) {
      await act(() => api(`/lists/${list.id}/items`, { method: 'POST', body: { book_id: book.id } }), `Adicionado a ${list.title}.`);
      onClose();
    }
  };

  return html`<${Sheet} title="Adicionar à lista" onClose=${onClose}>
    ${(lists || []).map((list) => html`<button key=${list.id} class="picker-row" style="grid-template-columns:1fr auto;min-height:50px" onClick=${() => toggle(list)}>
      <span>${list.title} <span class="muted" style="font-size:13px"> · ${plural(list.count, 'livro', 'livros')}</span></span>
      ${member.has(list.id) ? html`<span style="width:20px;color:var(--brass)"><${Icon.check} /></span>` : null}
    </button>`)}
    <form onSubmit=${create} style="display:flex;gap:8px;margin-top:14px">
      <input class="input" placeholder="Nova lista" aria-label="Nome da nova lista" value=${title} onInput=${(e) => setTitle(e.target.value)} />
      <button class="btn" disabled=${!title.trim()}>Criar</button>
    </form>
  <//>`;
}

export function GenrePicker({ genres, selected, onToggle, other, onOther }) {
  const set = new Set(selected);
  return html`
    ${genres?.length > 0 && html`<div class="field">
      <span class="field-label">Gêneros</span>
      <div class="genre-picker" role="group" aria-label="Gêneros">
        ${genres.map((g) => {
          const on = set.has(g.id);
          return html`<button key=${g.id} type="button" class=${`chip ${on ? 'on' : ''}`} aria-pressed=${on} onClick=${() => onToggle(g.id)}>${g.label}</button>`;
        })}
      </div>
    </div>`}
    <label class="field">
      <span>Outros assuntos (separe por vírgula)</span>
      <input class="input" placeholder="Ex.: Sertão, Memória, Viagem" value=${other} onInput=${(e) => onOther(e.target.value)} />
    </label>
  `;
}

// Escolhe um livro: primeiro os seus; ao digitar, busca no catálogo também.
export function BookPickerSheet({ title, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);
  const { data: mine } = useFetch(`/shelf?status=all${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`);
  const { data: remote, loading } = useFetch(debounced.length >= 2 ? `/search?q=${encodeURIComponent(debounced)}` : null);
  const mineIds = new Set((mine || []).map((b) => b.id));
  const rows = [...(mine || []).slice(0, 30), ...(remote || []).filter((b) => !mineIds.has(b.id))];

  return html`<${Sheet} title=${title} onClose=${onClose}>
    <input class="input" type="search" placeholder="Título, autor ou ISBN" aria-label="Buscar livro" autofocus value=${q} onInput=${(e) => setQ(e.target.value)} style="margin-bottom:8px" />
    ${rows.map((b) => html`<button key=${b.id} class="picker-row" onClick=${() => onPick(b)}>
      <${Cover} book=${b} />
      <span style="min-width:0">
        <span class="result-title" style="font-size:15px">${b.title}</span>
        <span class="result-meta" style="display:block">${authorLine(b)}</span>
      </span>
    </button>`)}
    ${loading && debounced.length >= 2 && html`<p class="muted" style="padding:12px 0;font-size:14px">Procurando no catálogo…</p>`}
    ${!loading && !rows.length && html`<p class="muted" style="padding:12px 0;font-size:14px">${debounced ? 'Nada encontrado.' : 'Digite para buscar.'}</p>`}
  <//>`;
}
