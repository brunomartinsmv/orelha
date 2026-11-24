import { html, useEffect, useRef, useState } from '/vendor/htm-preact.js';
import { authorLine, coverUrl, effectiveTheme, fallbackTone, onColor, onTheme, onToast, plural, ratingText, setTheme } from './lib.js';

// ---------- Ícones ----------

const svg = (paths, extra = '') => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class=${extra}>${paths}</svg>`;

export const Icon = {
  home: () => svg(html`<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/>`),
  shelf: () => svg(html`<path d="M3 21h18"/><path d="M5 21V6h4v15"/><path d="M9 21V3h4v18"/><path d="M14.2 7l3.8-1 3 14-3.8 1z"/>`),
  plus: () => svg(html`<path d="M12 5v14M5 12h14"/>`),
  diary: () => svg(html`<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>`),
  compass: () => svg(html`<circle cx="12" cy="12" r="9"/><path d="M15.500 8.500l-2 5-5 2 2-5z"/>`),
  you: () => svg(html`<circle cx="12" cy="8" r="4"/><path d="M4.5 21c1-4 4-6 7.5-6s6.500 2 7.500 6"/>`),
  search: () => svg(html`<circle cx="11" cy="11" r="7"/><path d="M20.500 20.500L16 16"/>`),
  back: () => svg(html`<path d="M15 5l-7 7 7 7"/>`),
  close: () => svg(html`<path d="M6 6l12 12M18 6L6 18"/>`),
  chevron: () => svg(html`<path d="M9 5l7 7-7 7"/>`),
  up: () => svg(html`<path d="M6 15l6-6 6 6"/>`),
  down: () => svg(html`<path d="M6 9l6 6 6-6"/>`),
  check: () => svg(html`<path d="M5 12.500l4.500 4.500L19 7"/>`),
  bookmark: () => svg(html`<path d="M7 3h10v18l-5-4-5 4z"/>`),
  open: () => svg(html`<path d="M12 6c-2-1.500-5-2-8-2v15c3 0 6 .5 8 2 2-1.500 5-2 8-2V4c-3 0-6 .5-8 2z"/><path d="M12 6v15"/>`),
  drop: () => svg(html`<circle cx="12" cy="12" r="9"/><path d="M8.500 12h7"/>`),
  list: () => svg(html`<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.5M4 12h.5M4 18h.5" stroke-width="2.6"/>`),
  quote: () => svg(html`<path d="M10 7H5v6h4c0 2-1 3-3 4M19 7h-5v6h4c0 2-1 3-3 4"/>`),
  chart: () => svg(html`<path d="M5 20V12M12 20V5M19 20v-5"/>`),
  gear: () => svg(html`<path d="M12.220 2h-.440a2 2 0 0 0-2 2v.180a2 2 0 0 1-1 1.730l-.430.250a2 2 0 0 1-2 0l-.150-.080a2 2 0 0 0-2.730.730l-.220.380a2 2 0 0 0 .730 2.730l.150.100a2 2 0 0 1 1 1.720v.510a2 2 0 0 1-1 1.740l-.150.090a2 2 0 0 0-.730 2.730l.220.380a2 2 0 0 0 2.730.730l.150-.080a2 2 0 0 1 2 0l.430.250a2 2 0 0 1 1 1.730V20a2 2 0 0 0 2 2h.440a2 2 0 0 0 2-2v-.180a2 2 0 0 1 1-1.730l.430-.250a2 2 0 0 1 2 0l.150.080a2 2 0 0 0 2.730-.730l.220-.390a2 2 0 0 0-.730-2.730l-.150-.080a2 2 0 0 1-1-1.740v-.500a2 2 0 0 1 1-1.740l.150-.090a2 2 0 0 0 .730-2.730l-.220-.380a2 2 0 0 0-2.730-.730l-.150.080a2 2 0 0 1-2 0l-.430-.250a2 2 0 0 1-1-1.730V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`),
  sun: () => svg(html`<circle cx="12" cy="12" r="4"/><path d="M12 2.500v2M12 19.500v2M2.500 12h2M19.500 12h2M5.300 5.300l1.400 1.400M17.300 17.300l1.400 1.400M18.700 5.300l-1.400 1.400M6.700 17.300l-1.400 1.400"/>`),
  moon: () => svg(html`<path d="M20 14.500A8 8 0 0 1 9.500 4a8 8 0 1 0 10.500 10.500z"/>`),
  reread: () => svg(html`<path d="M4 11a8 8 0 0 1 14-4l2 2"/><path d="M20 4v5h-5"/><path d="M20 13a8 8 0 0 1-14 4l-2-2"/><path d="M4 20v-5h5"/>`),
  note: () => svg(html`<path d="M5 5h14v10H10l-5 4z"/>`),
  grid: () => svg(html`<rect x="4" y="4" width="6.500" height="9" rx="1"/><rect x="13.500" y="4" width="6.500" height="9" rx="1"/><rect x="4" y="15" width="6.500" height="5" rx="1"/><rect x="13.500" y="15" width="6.500" height="5" rx="1"/>`),
  trash: () => svg(html`<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>`),
  camera: () => svg(html`<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.500"/>`),
  edit: () => svg(html`<path d="M4 20l1-4L16 5l3 3L8 19z"/>`),
  logo: () => html`<svg viewBox="0 0 28 24" fill="none" aria-hidden="true">
    <path d="M3.4 4.2C6.7 3.5 10.3 4 12.9 5.8v14.6c-2.6-1.5-6.2-2-9.5-1.4a1.2 1.2 0 0 1-1.4-1.2V5.4c0-.6.5-1.1 1.4-1.2Z" fill="currentColor" opacity=".82"/>
    <path d="M15.1 5.8c1.3-.9 2.8-1.5 4.4-1.7v4.3c0 1.2 1 2.2 2.2 2.2h4.3v7.2c0 .7-.6 1.3-1.4 1.2-3.3-.6-6.9-.1-9.5 1.4V5.8Z" fill="currentColor"/>
    <path d="M21.2 4.3c0-.2.3-.3.5-.2l4.1 4.1c.1.2 0 .5-.2.5h-3.2c-.7 0-1.2-.5-1.2-1.2V4.3Z" fill="var(--logo-ear, var(--brass))"/>
  </svg>`,
};

// ---------- Capa ----------

function GeneratedCover({ book, tone }) {
  return html`<span class="gen-cover" style=${{ '--tone': tone, '--on': onColor(tone) }}>
    <span class="rule"></span>
    <span class="gt">${book.title}</span>
    <span class="ga">${authorLine(book)}</span>
  </span>`;
}

export function Cover({ book, size = 'M' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [book.cover]);
  const url = coverUrl(book, size);
  return html`<span class="cover-frame" style="display:block"><span class="cover">
    ${url && !failed
      ? html`<img src=${url} alt=${`Capa de ${book.title}`} loading="lazy" decoding="async" onError=${() => setFailed(true)} />`
      : html`<${GeneratedCover} book=${book} tone=${book.color || fallbackTone(book)} />`}
  </span></span>`;
}

export function ReadingEstimate({ estimate }) {
  if (!estimate) return null;
  const { pages_per_day, days_left } = estimate;
  const rate = pages_per_day < 0.1 ? '<0,1' : pages_per_day.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  return html`<p class="reading-estimate">${rate} pág./dia · cerca de ${plural(days_left, 'dia', 'dias')} para terminar</p>`;
}

export function BookCard({ book, showRating = false }) {
  return html`<a class="rail-item cover-link" href=${`/livro/${encodeURIComponent(book.id)}`}>
    <${Cover} book=${book} />
    <div class="rail-caption">
      ${showRating
        ? html`<${Stars} value=${book.rating} />`
        : html`<div class="t">${book.title}</div><div class="a">${book.authors?.[0] || ''}</div>`}
    </div>
  </a>`;
}

export function Rail({ title, books, href, showRating }) {
  if (!books?.length) return null;
  return html`<section class="section">
    <div class="section-head">
      <h2 class="section-title">${title}</h2>
      ${href && html`<a class="section-link" href=${href}>Ver tudo</a>`}
    </div>
    <div class="rail">${books.map((b) => html`<${BookCard} key=${b.id} book=${b} showRating=${showRating} />`)}</div>
  </section>`;
}

export function RailSkeleton({ title }) {
  return html`<section class="section" aria-hidden="true">
    <div class="section-head"><h2 class="section-title">${title}</h2></div>
    <div class="rail">${[0, 1, 2, 3, 4].map((i) => html`<div key=${i} class="rail-item"><div class="skel" style="aspect-ratio:2/3"></div></div>`)}</div>
  </section>`;
}

// ---------- Estrelas ----------

const STAR = 'M12 2.300l2.900 6.300 6.900.800-5.100 4.700 1.400 6.800L12 17.500l-6.100 3.400 1.400-6.800-5.100-4.700 6.900-.800z';
const starRow = () => [0, 1, 2, 3, 4].map((i) => html`<svg key=${i} viewBox="0 0 24 24" aria-hidden="true"><path d=${STAR} /></svg>`);

export function Stars({ value, size }) {
  if (!value) return null;
  const pct = (value / 10) * 100;
  const label = `${ratingText(value)} de 5 estrelas`;
  return html`<span class="stars" role="img" aria-label=${label} title=${label} style=${size ? { '--s': `${size}px` } : null}>
    <span class="row">${starRow()}</span>
    <span class="fill row" style=${{ width: `${pct}%` }}>${starRow()}</span>
  </span>`;
}

// Arraste o dedo pelas estrelas: cada metade de estrela é um passo. Tocar na mesma nota limpa.
export function StarInput({ value, onChange }) {
  const ref = useRef(null);
  const [preview, setPreview] = useState(null);
  const shown = preview ?? value ?? 0;

  const valueAt = (clientX) => {
    const rect = ref.current.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return Math.min(10, Math.max(1, Math.ceil(ratio * 10)));
  };
  const onPointerDown = (e) => {
    e.preventDefault();
    ref.current.setPointerCapture?.(e.pointerId);
    setPreview(valueAt(e.clientX));
    ref.current.dataset.moved = '';
  };
  const onPointerMove = (e) => {
    if (preview === null) return;
    const v = valueAt(e.clientX);
    if (v !== preview) { ref.current.dataset.moved = '1'; setPreview(v); }
  };
  const onPointerUp = (e) => {
    if (preview === null) return;
    const v = valueAt(e.clientX);
    const tappedSame = !ref.current.dataset.moved && v === value;
    setPreview(null);
    onChange(tappedSame ? null : v);
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange(Math.min(10, (value || 0) + 1)); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange(value > 1 ? value - 1 : null); }
  };

  return html`<div class="stars-input">
    <span ref=${ref} class="stars" role="slider" tabindex="0" aria-label="Nota" aria-valuemin="0" aria-valuemax="5"
      aria-valuenow=${(value || 0) / 2} aria-valuetext=${value ? `${ratingText(value)} estrelas` : 'sem nota'}
      onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onPointerCancel=${() => setPreview(null)} onKeyDown=${onKeyDown}>
      <span class="row">${starRow()}</span>
      <span class="fill row" style=${{ width: `${(shown / 10) * 100}%`, top: '4px' }}>${starRow()}</span>
    </span>
    <span class="stars-hint">${shown ? `${ratingText(shown)} estrelas` : 'Arraste para dar nota'}</span>
  </div>`;
}

// ---------- Folha, toast, estados ----------

export function Sheet({ title, onClose, children }) {
  const body = useRef(null);
  useEffect(() => {
    document.body.classList.add('locked');
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const opener = document.activeElement;
    body.current?.closest('.sheet')?.focus();
    return () => {
      document.body.classList.remove('locked');
      window.removeEventListener('keydown', onKey);
      opener?.focus?.({ preventScroll: true });
    };
  }, []);
  return html`<div class="sheet-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label=${title} tabindex="-1">
      <div class="sheet-head">
        <h2>${title}</h2>
        <button class="icon-btn" onClick=${onClose} aria-label="Fechar"><${Icon.close} /></button>
      </div>
      <div class="sheet-body" ref=${body}>${children}</div>
    </div>
  </div>`;
}

export function Toaster() {
  const [t, setT] = useState(null);
  useEffect(() => onToast(setT), []);
  useEffect(() => {
    if (!t) return undefined;
    const timer = setTimeout(() => setT(null), t.kind === 'err' ? 4500 : 2400);
    return () => clearTimeout(timer);
  }, [t]);
  if (!t) return null;
  return html`<div class=${`toast ${t.kind === 'err' ? 'err' : ''}`} role="status">${t.message}</div>`;
}

export function ErrorBox({ error, onRetry }) {
  return html`<div class="err-box" role="alert">
    <p>${error.message}</p>
    ${onRetry && html`<button class="btn small" style="margin-top:10px" onClick=${onRetry}>Tentar de novo</button>`}
  </div>`;
}

export function Toggle({ checked, onChange, label }) {
  return html`<div class="toggle-row">
    <span>${label}</span>
    <button type="button" class="toggle" role="switch" aria-checked=${String(!!checked)} aria-label=${label} onClick=${() => onChange(!checked)}></button>
  </div>`;
}

export function PageHeader({ title, sub, back, right }) {
  return html`<div>
    ${back && html`<div class="topbar" style="margin-bottom:6px">
      <button class="icon-btn back-btn" onClick=${() => history.back()} aria-label="Voltar"><${Icon.back} /></button>
      ${right || null}
    </div>`}
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div style="min-width:0">
        <h1 class="page-title">${title}</h1>
        ${sub && html`<p class="page-sub">${sub}</p>`}
      </div>
      ${!back && right}
    </div>
  </div>`;
}

// Sol no escuro (vai para o claro), lua no claro (vai para o escuro).
export function ThemeToggle({ className = '' }) {
  const [theme, setLocal] = useState(effectiveTheme);
  useEffect(() => onTheme(() => setLocal(effectiveTheme())), []);
  const dark = theme === 'dark';
  const label = dark ? 'Mudar para o modo claro' : 'Mudar para o modo escuro';
  return html`<button class=${`icon-btn theme-btn ${className}`} onClick=${() => setTheme(dark ? 'light' : 'dark')} aria-label=${label} title=${label}>
    ${dark ? html`<${Icon.sun} />` : html`<${Icon.moon} />`}
  </button>`;
}
