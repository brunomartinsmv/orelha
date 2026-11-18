// Lombadas: cada livro ganha uma tipografia com cara de capa e o título sempre cabe inteiro.
import { useEffect, useState } from '/vendor/htm-preact.js';
import { hash } from './lib.js';

// family, peso, estilo, caixa alta, espaçamento (em), maior corpo aceito.
const STYLES = {
  serif: { ff: 'Young Serif', fw: 400, fst: 'normal', upper: false, ls: 0, max: 19 },
  playfair: { ff: 'Playfair Display', fw: 500, fst: 'italic', upper: false, ls: 0, max: 20 },
  fatface: { ff: 'Abril Fatface', fw: 400, fst: 'normal', upper: false, ls: 0.01, max: 20 },
  literata: { ff: 'Literata', fw: 600, fst: 'italic', upper: false, ls: 0, max: 19 },
  condensed: { ff: 'Bebas Neue', fw: 400, fst: 'normal', upper: true, ls: 0.04, max: 26 },
  wide: { ff: 'Syncopate', fw: 700, fst: 'normal', upper: true, ls: 0.16, max: 15 },
  classical: { ff: 'Cinzel', fw: 600, fst: 'normal', upper: true, ls: 0.05, max: 18 },
  grotesk: { ff: 'Instrument Sans', fw: 700, fst: 'normal', upper: true, ls: 0.05, max: 17 },
};
const LITERARY = ['serif', 'playfair', 'fatface', 'literata'];

// O primeiro gênero da lista que o livro tem decide. Sem gênero, uma serifa literária fixa por livro.
const BY_GENRE = [
  [['dystopia', 'horror', 'graphic'], 'condensed'],
  [['scifi'], 'wide'],
  [['fantasy'], 'classical'],
  [['magic-realism'], 'fatface'],
  [['poetry', 'romance'], 'playfair'],
  [['psychological'], 'literata'],
  [['brazilian', 'portuguese', 'latin-american', 'russian', 'historical'], null],
  [['mystery'], 'condensed'],
  [['history', 'science', 'biography', 'philosophy'], 'grotesk'],
];

export function spineStyle(book) {
  const genres = book.genres || [];
  for (const [ids, style] of BY_GENRE) {
    if (ids.some((id) => genres.includes(id))) return STYLES[style || LITERARY[hash(book.id) % LITERARY.length]];
  }
  return STYLES[LITERARY[hash(book.id) % LITERARY.length]];
}

// ---------- Medida ----------

const canvas = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
const cache = new Map();
// Largura do texto em px com corpo 1px, incluindo o espaçamento entre letras.
function unitWidth(text, style) {
  const key = `${style.ff}|${style.fw}|${style.fst}|${text}`;
  if (!cache.has(key)) {
    canvas.font = `${style.fst} ${style.fw} 100px "${style.ff}"`;
    cache.set(key, canvas.measureText(text).width / 100 + style.ls * text.length);
  }
  return cache.get(key);
}
const AUTHOR = { ff: 'Instrument Sans', fw: 500, fst: 'normal', ls: 0.03 };

// Melhor forma de quebrar as palavras em n linhas: a que deixa a linha mais longa a mais curta possível.
function bestSplit(words, n, style) {
  if (n === 1) return { lines: [words.join(' ')], longest: unitWidth(words.join(' '), style) };
  let best = null;
  const walk = (start, left, acc) => {
    if (left === 1) {
      const lines = [...acc, words.slice(start).join(' ')];
      const longest = Math.max(...lines.map((l) => unitWidth(l, style)));
      if (!best || longest < best.longest) best = { lines, longest };
      return;
    }
    for (let end = start + 1; end <= words.length - left + 1; end++) walk(end, left - 1, [...acc, words.slice(start, end).join(' ')]);
  };
  walk(0, n, []);
  return best;
}

const LINE = 1.06;
const PAD = 34; // respiro em cima e embaixo da lombada
const MIN_SIZE = 10;

function fit(words, style, width, height, reserve) {
  const thick = width - 8;
  const room = height - PAD - reserve;
  let best = null;
  for (let n = 1; n <= Math.min(3, words.length); n++) {
    const split = bestSplit(words, n, style);
    const size = Math.min(style.max - (n > 1 ? 2 : 0), thick / (n * LINE), room / split.longest);
    // Mais uma linha só se valer a pena: corpo bem maior.
    if (!best || size > best.size + 1) best = { ...split, size };
  }
  return best;
}

// Tamanho da lombada (largura pelas páginas) e o título já quebrado em linhas.
export function spineLayout(book) {
  const style = spineStyle(book);
  const h = hash(book.id);
  const raw = book.title.split(':')[0].trim();
  const title = style.upper ? raw.toLocaleUpperCase('pt-BR') : raw;
  const words = title.split(/\s+/).filter(Boolean);
  const author = surname(book);
  const authorLen = author ? unitWidth(author, AUTHOR) * 10 + 10 : 0;
  const baseW = Math.max(22, Math.min(62, Math.round(18 + (book.pages || 240) / 16)));
  const baseH = 158 + (h % 42);
  // Se o título não cabe, a lombada engorda (e cresce um pouco) até caber.
  for (let step = 0; step < 16; step++) {
    const width = baseW + step * 4;
    const height = Math.min(226, baseH + step * 5);
    const withAuthor = author ? fit(words, style, width, height, authorLen) : null;
    if (withAuthor && withAuthor.size >= 12) return { style, width, height, ...withAuthor, author };
    const alone = fit(words, style, width, height, 0);
    if (alone.size >= MIN_SIZE || step === 15) return { style, width, height, ...alone, author: null };
  }
  return null;
}

const PARTICLE = /^(le|la|de|da|do|dos|das|del|di|du|van|von)$/i;
const SUFFIX = /^(junior|júnior|jr\.?|filho|neto|sobrinho)$/i;

// "Itamar Vieira Junior" -> "Vieira Junior"; "Ursula K. Le Guin" -> "Le Guin".
export function surname(book) {
  const parts = (book.authors?.[0] || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  let start = parts.length - 1;
  if (start > 0 && SUFFIX.test(parts[start])) start--;
  if (start > 0 && PARTICLE.test(parts[start - 1])) start--;
  return parts.slice(start).join(' ');
}

// As medidas só valem com a fonte certa carregada: redesenha quando chegam.
export function useSpineFonts(books) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!document.fonts || !books.length) return;
    const styles = new Set(books.map(spineStyle));
    const loads = [...styles, AUTHOR].map((s) => document.fonts.load(`${s.fst} ${s.fw} 16px "${s.ff}"`, 'AÉ'));
    let alive = true;
    Promise.allSettled(loads).then(() => { if (alive) { cache.clear(); setVersion((v) => v + 1); } });
    return () => { alive = false; };
  }, [books]);
  return version;
}
