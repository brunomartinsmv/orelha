import { html, useEffect, useRef, useState } from '/vendor/htm-preact.js';
import { act, api, onTheme, plural, savedTheme, setTheme, toast, useFetch } from '../lib.js';
import { ErrorBox, PageHeader } from '../ui.js';

export function SettingsView() {
  const { data, error } = useFetch('/profile');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);
  const [theme, setThemeState] = useState(savedTheme);
  useEffect(() => onTheme(setThemeState), []);

  useEffect(() => {
    if (data) { setName(data.name); setGoal(data.goal.target ?? ''); }
  }, [data?.name, data?.goal?.target]);

  if (error && !data) return html`<main class="page"><${ErrorBox} error=${error} /></main>`;

  const save = (e) => {
    e.preventDefault();
    act(() => api('/settings', { method: 'PUT', body: { name, goal: goal === '' ? null : Number(goal) } }), 'Salvo.');
  };

  const importFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    let result = null;
    try {
      // Lê os bytes antes de limpar o campo: no WebKit, um File de campo limpo falha ao enviar.
      const bytes = await file.arrayBuffer();
      e.target.value = '';
      result = await act(() => api('/import', { method: 'POST', raw: bytes }));
    } catch {
      e.target.value = '';
      toast('Não consegui ler o arquivo selecionado.', 'err');
    } finally {
      setImporting(false);
    }
    if (result) {
      const parts = [
        plural(result.books_added, 'livro novo', 'livros novos'),
        plural(result.logs_added, 'registro', 'registros'),
        ...(result.quotes_added ? [plural(result.quotes_added, 'trecho', 'trechos')] : []),
        ...(result.lists_added ? [plural(result.lists_added, 'lista', 'listas')] : []),
        ...(result.skipped ? [plural(result.skipped, 'ignorado', 'ignorados')] : []),
      ];
      const suffix = result.books_added > 0 && !result.format.includes('JSON') ? ' As capas chegam aos poucos.' : '';
      toast(`${result.format}: ${parts.join(', ')}.${suffix}`);
    }
  };

  return html`<main class="page">
    <${PageHeader} title="Ajustes" back=${true} />

    <div class="settings-list">
      <form class="setting-block" onSubmit=${save}>
        <h2>Você</h2>
        <label class="field"><span>Nome</span><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
        <label class="field"><span>Meta de livros em ${new Date().getFullYear()}</span>
          <input class="input" type="number" inputmode="numeric" min="1" max="1000" placeholder="Sem meta" value=${goal} onInput=${(e) => setGoal(e.target.value)} />
        </label>
        <button class="btn primary" style="margin-top:14px">Salvar</button>
      </form>

      <div class="setting-block">
        <h2>Aparência</h2>
        <div class="seg" role="group" aria-label="Tema">
          ${[[null, 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']].map(([id, label]) => html`<button key=${label} type="button" class=${theme === id ? 'on' : ''} aria-pressed=${theme === id} onClick=${() => setTheme(id)}>${label}</button>`)}
        </div>
      </div>

      <div class="setting-block">
        <h2>Importar leituras</h2>
        <p>Traga seu histórico em CSV do Skoob, Goodreads ou StoryGraph, ou restaure um backup do Orelha (JSON ou CSV).</p>
        <button class="btn" disabled=${importing} onClick=${() => fileRef.current.click()}>${importing ? 'Importando…' : 'Escolher arquivo'}</button>
        <input ref=${fileRef} type="file" accept=".csv,.json,text/csv,application/json" hidden onChange=${importFile} />
        <p class="muted" style="font-size:13px;margin:10px 0 0">No Skoob, exporte sua estante em CSV por uma extensão de navegador (como Skoob para Goodreads) e envie o arquivo aqui.</p>
      </div>

      <div class="setting-block">
        <h2>Seus dados</h2>
        <p>Guarde uma cópia completa da estante e do diário.</p>
        <div class="btn-row">
          <a class="btn small" href="/api/export.csv" download>Baixar CSV</a>
          <a class="btn small" href="/api/export.json" download>Baixar JSON</a>
        </div>
      </div>
    </div>

    <p class="muted" style="font-size:13px;margin-top:24px;max-width:540px">Dados de livros e capas: <a href="https://openlibrary.org" style="text-decoration:underline" target="_blank" rel="noreferrer">Open Library</a> e BrasilAPI.</p>
  </main>`;
}
