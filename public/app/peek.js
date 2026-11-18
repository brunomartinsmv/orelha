// O livro sai da estante: sobe da prateleira, gira para mostrar a capa e abre ao lado as suas anotações.
import { html, useEffect, useLayoutEffect, useRef, useState } from '/vendor/htm-preact.js';
import { authorLine, coverUrl, formatDate, num, popOverlay, pushOverlay, ratingText, toneOf, onColor, useFetch } from './lib.js';
import { Cover, Icon, Stars } from './ui.js';

const PERSPECTIVE = 'perspective(1400px)';
// A página que abre é larga: com perspectiva curta, a ponta dela sairia da tela.
const PAGE_PERSPECTIVE = 'perspective(2600px)';
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const isWide = () => matchMedia('(min-width: 720px)').matches;

// De onde o livro saiu, já no tamanho final: quanto encolher, quanto deslocar e se mostra a lombada.
function originFrames(origin, kind, slot) {
  const o = origin.getBoundingClientRect();
  const s = slot.getBoundingClientRect();
  const scale = o.height / s.height;
  const dx = o.left + o.width / 2 - (s.left + s.width / 2);
  const dy = o.top + o.height / 2 - (s.top + s.height / 2);
  const turn = kind === 'spine' ? 90 : 0;
  const at = (x, y, k, deg) => `translate(${x}px, ${y}px) ${PERSPECTIVE} scale3d(${k}, ${k}, ${k}) rotateY(${deg}deg)`;
  const lift = Math.min(56, o.height * 0.3);
  return {
    // Lombada: profundidade do livro proporcional à largura dela na estante.
    depth: kind === 'spine' ? o.width / scale : s.height * 0.05,
    scale,
    // Sobe da prateleira, viaja girando e só no fim encara você de frente.
    frames: [
      { transform: at(dx, dy, scale, turn), offset: 0, easing: 'cubic-bezier(.2, .7, .3, 1)' },
      { transform: at(dx, dy - lift, scale * 1.04, turn), offset: 0.2, easing: 'cubic-bezier(.45, 0, .55, 1)' },
      { transform: at(dx * 0.35, dy * 0.35 - lift * 0.6, 0.35 * scale + 0.65, turn * 0.45), offset: 0.62, easing: 'cubic-bezier(.2, .6, .25, 1)' },
      { transform: at(0, 0, 1, 0), offset: 1 },
    ],
  };
}

const visible = (el) => {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
};

export function BookPeek({ book, origin, kind, onClosed }) {
  const { data, error } = useFetch(`/books/${encodeURIComponent(book.id)}`);
  const peekRef = useRef(null);
  const bookRef = useRef(null);
  const pageRef = useRef(null);
  const scrimRef = useRef(null);
  const closeRef = useRef(null);
  const motion = useRef({ frames: null, closing: false });
  // A lombada que sai da estante é a mesma que estava lá: mesma cor, título e enfeites.
  const [spine] = useState(() => (kind === 'spine' && origin ? { markup: origin.innerHTML, style: origin.getAttribute('style') || '' } : null));
  const tone = toneOf(book);

  // A página abre presa pela borda do lado do livro: à esquerda no computador, em cima no celular.
  const pageFrames = () => {
    const axis = isWide() ? 'rotateY' : 'rotateX';
    const sign = isWide() ? -1 : 1;
    return [
      { transform: `${PAGE_PERSPECTIVE} ${axis}(${sign * 90}deg)`, opacity: 0 },
      { transform: `${PAGE_PERSPECTIVE} ${axis}(${sign * 62}deg)`, opacity: 1, offset: 0.22 },
      { transform: `${PAGE_PERSPECTIVE} ${axis}(0deg)`, opacity: 1 },
    ];
  };

  useLayoutEffect(() => {
    document.body.classList.add('locked');
    closeRef.current?.focus({ preventScroll: true });
    pushOverlay(() => close(true));
    if (reducedMotion() || !origin?.isConnected) return;
    const { depth, scale, frames } = originFrames(origin, kind, bookRef.current);
    bookRef.current.style.setProperty('--d', `${depth}px`);
    bookRef.current.style.setProperty('--k', String(1 / scale));
    motion.current.frames = frames;
    origin.style.visibility = 'hidden';
    scrimRef.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
    bookRef.current.animate(frames, { duration: 980 });
    pageRef.current.animate(pageFrames(), { duration: 620, delay: 700, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'backwards' });
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('locked');
      if (origin) origin.style.visibility = '';
    };
  }, []);

  // Guarda o livro de volta no lugar dele (ou só some, se a estante saiu da tela).
  async function close(fromHistory = false) {
    if (motion.current.closing) return;
    motion.current.closing = true;
    if (!fromHistory) popOverlay();
    const back = motion.current.frames && visible(origin) && !reducedMotion();
    if (back) {
      [bookRef.current, pageRef.current].forEach((el) => el.getAnimations().forEach((a) => a.finish()));
      // A página está rolada no celular: o livro precisa sair de onde está agora, não de onde abriu.
      const fresh = originFrames(origin, kind, bookRef.current).frames;
      await pageRef.current.animate([...pageFrames()].reverse(), { duration: 220, easing: 'ease-in', fill: 'forwards' }).finished;
      scrimRef.current.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 480, easing: 'ease-in', fill: 'forwards' });
      await bookRef.current.animate([...fresh].reverse().map((f) => ({ ...f, offset: 1 - f.offset })), { duration: 560, easing: 'cubic-bezier(.5, 0, .3, 1)', fill: 'forwards' }).finished;
    } else if (!reducedMotion()) {
      await peekRef.current.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished;
    }
    if (origin) origin.style.visibility = '';
    origin?.focus?.({ preventScroll: true });
    onClosed();
  }

  const onBackdrop = (e) => { if (e.target === e.currentTarget || e.target === scrimRef.current) close(); };

  return html`<div class="peek" ref=${peekRef} role="dialog" aria-modal="true" aria-labelledby="peek-title" onClick=${onBackdrop}>
    <div class="peek-scrim" ref=${scrimRef}></div>
    <button class="icon-btn peek-close" ref=${closeRef} onClick=${() => close()} aria-label="Fechar"><${Icon.close} /></button>
    <div class="peek-stage" onClick=${onBackdrop}>
      <div class="peek-book" ref=${bookRef} style=${{ '--tone': tone, '--on': onColor(tone) }}>
        <div class="peek-front">
          <${Cover} book=${book} size="M" />
          <${HiResCover} book=${book} />
        </div>
        <div class="peek-spine" aria-hidden="true">
          ${spine
            ? html`<span class="spine" style=${`${spine.style};transform:scale(var(--k));transform-origin:top left;transition:none`} dangerouslySetInnerHTML=${{ __html: spine.markup }}></span>`
            : null}
        </div>
      </div>
      <article class="peek-page" ref=${pageRef}>
        <${PeekPage} book=${book} data=${data} error=${error} />
      </article>
    </div>
  </div>`;
}

// A capa média costuma já estar no cache; a grande entra por cima quando chegar.
function HiResCover({ book }) {
  const ref = useRef(null);
  const [state, setState] = useState('loading');
  const url = coverUrl(book, 'L');
  // Já no cache (a estante baixa antes): aparece de cara, sem esmaecer.
  useLayoutEffect(() => { if (ref.current?.complete && ref.current.naturalWidth) setState('cached'); }, []);
  if (!url || url === coverUrl(book, 'M')) return null;
  return html`<img ref=${ref} class=${`peek-hires ${state}`} src=${url} alt="" aria-hidden="true" decoding="async"
    onLoad=${() => setState((s) => (s === 'cached' ? s : 'ready'))} />`;
}

const LOG_FORMAT = { paper: 'papel', ebook: 'e-book', audio: 'áudio' };

function statusLine(book) {
  if (book.status === 'want') return 'Está na sua fila de quero ler.';
  if (book.status === 'reading') return book.current_page ? `Você está lendo, na página ${num(book.current_page)}.` : 'Você está lendo agora.';
  if (book.status === 'dropped') return 'Você abandonou este livro.';
  return 'Ainda sem registro no diário.';
}

function PeekPage({ book, data, error }) {
  const b = data?.book || book;
  const logs = data?.logs || [];
  const quotes = data?.quotes || [];
  const meta = [b.year, b.pages ? `${num(b.pages)} páginas` : null].filter(Boolean).join(' · ');
  return html`
    <h2 class="peek-title" id="peek-title">${b.title}</h2>
    <p class="peek-author">${authorLine(b)}</p>
    ${meta && html`<p class="peek-meta">${meta}</p>`}
    ${b.rating && html`<div class="peek-rating">
      <${Stars} value=${b.rating} size=${18} />
      <span>${ratingText(b.rating)}, sua nota</span>
    </div>`}

    ${!data && !error && html`<div aria-hidden="true" style="margin-top:18px;display:grid;gap:8px">
      <div class="skel" style="height:14px"></div><div class="skel" style="height:14px"></div><div class="skel" style="height:14px;width:62%"></div>
    </div>`}
    ${error && !data && html`<p class="muted" style="margin-top:16px;font-size:14px">Não deu para carregar as anotações agora.</p>`}

    ${data && html`
      ${b.description && html`<p class="prose peek-desc">${b.description}</p>`}

      <h3 class="peek-h">No seu diário</h3>
      ${logs.length === 0 && html`<p class="muted peek-empty">${statusLine(b)}</p>`}
      ${logs.map((log) => html`<div key=${log.id} class="peek-log">
        <div class="peek-log-top">
          <span>${log.reread ? 'Releu' : 'Leu'} em ${formatDate(log.finished_on)}${log.format ? ` · ${LOG_FORMAT[log.format]}` : ''}</span>
          <${Stars} value=${log.rating} size=${13} />
        </div>
        ${log.review && (log.spoilers
          ? html`<p class="muted peek-empty">Resenha com spoiler: está na página do livro.</p>`
          : html`<p class="peek-review">${log.review}</p>`)}
      </div>`)}

      ${quotes.length > 0 && html`
        <h3 class="peek-h">Trechos que você guardou</h3>
        ${quotes.slice(0, 3).map((q) => html`<blockquote key=${q.id} class="peek-quote">${q.text}${q.page ? html`<cite>p. ${q.page}</cite>` : null}</blockquote>`)}
        ${quotes.length > 3 && html`<p class="muted peek-empty">e mais ${quotes.length - 3} na página do livro.</p>`}
      `}
    `}

    <a class="btn primary block peek-go" href=${`/livro/${encodeURIComponent(book.id)}`}>Ir para a página do livro <${Icon.chevron} /></a>
  `;
}
