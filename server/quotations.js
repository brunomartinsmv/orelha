import { db } from './db.js';
import { USER_AGENT } from './version.js';

const API = 'https://pt.wikiquote.org/w/api.php';
const DAY = 86_400_000;
const key = (title) => `wikiquote:page:v1:${title}`;
const normalize = (text) => text.normalize('NFD').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
const pending = new Map();
let retryAfter = 0;

function plain(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>|<ref\b[^>]*\/>/gi, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/'{2,5}/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '')
    .replace(/\s+/g, ' ').trim();
}

function bookTitles(book) {
  return [...new Set([book.title, book.original_title].filter(Boolean))];
}

// Só aceita a página da obra com autor identificado, ou trechos vinculados à obra na página do autor.
export function extractQuotes(page, book) {
  if (!page?.text) return [];
  const titles = bookTitles(book).map(normalize);
  const authors = book.authors.map(normalize);
  const lead = normalize(plain(page.text.split(/^==/m)[0]));
  const workPage = titles.includes(normalize(page.title)) && authors.some((a) => a && lead.includes(a));
  const authorPage = authors.includes(normalize(page.title));
  if (!workPage && !authorPage) return [];

  const matchesTitle = (text) => titles.includes(normalize(plain(text).replace(/\s*\(\d{4}\)\s*$/, '')));
  const headings = [];
  const out = [];
  let current = null;
  function flush() {
    if (!current || current.blocked) return;
    const linkedSource = [...current.source.matchAll(/\[\[(?:s:)?([^\]|#]+)(?:[^\]]*)\]\]/g)]
      .some((m) => matchesTitle(m[1].split('/')[0]));
    const sourceNamesBook = bookTitles(book).some((title) => {
      const escaped = plain(title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=\\s*(?:$|["”»,.;:(]))`, 'iu').test(plain(current.source));
    });
    if (!workPage && !current.inWork && !linkedSource && !sourceNamesBook) return;
    let text = plain(current.text);
    if (/^["“«]/.test(text)) {
      const quoted = text.match(/^["“«]([\s\S]+)["”»](?:[.,;]?\s*(?:[-–—].*)?)?$/);
      if (!quoted) return;
      text = quoted[1].trim();
    }
    if (text.length < 12 || text.length > 320 || /[{}<>]|https?:\/\//.test(text)) return;
    out.push({ text, source: { name: 'Wikiquote', url: `https://pt.wikiquote.org/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}` } });
  }
  for (const line of page.text.split('\n')) {
    const heading = line.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
    if (heading) {
      flush(); current = null;
      const level = heading[1].length;
      while (headings.length && headings.at(-1).level >= level) headings.pop();
      const label = plain(heading[2]);
      const labelKey = normalize(label);
      headings.push({ level, inWork: matchesTitle(label), blocked: /atribuid|semfont|apocrif|duvid|^sobre|naoverific|disputad|incorret|vertambem|vejatambem|ligac|referenc|bibliograf|^notas$/.test(labelKey) });
    } else if (/^\*[^*]/.test(line)) {
      flush();
      current = { text: line.replace(/^\*\s*/, ''), source: '', inWork: headings.some((h) => h.inWork), blocked: headings.some((h) => h.blocked) };
    } else if (current && /^(?:\*\*|:)/.test(line)) {
      current.source += ` ${line}`;
    } else if (current && line.trim() && !/^\[\[|^\{\{|^----/.test(line)) {
      current.text += ` ${line}`;
    }
  }
  flush();
  return [...new Map(out.map((q) => [q.text, q])).values()];
}

async function loadPages(titles, { now, fetchImpl }) {
  const pages = new Map();
  const missing = [];
  for (const title of titles) {
    const row = db.prepare('SELECT value, expires_at FROM api_cache WHERE key = ?').get(key(title));
    if (row) pages.set(title, JSON.parse(row.value));
    if (!row || row.expires_at <= now) missing.push(title);
  }
  if (!missing.length || process.env.ORELHA_NO_QUOTES || now < retryAfter) return pages;
  const batchKey = JSON.stringify(missing);
  if (!pending.has(batchKey)) {
    pending.set(batchKey, (async () => {
      const url = new URL(API);
      url.search = new URLSearchParams({ action: 'query', titles: missing.join('|'), prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: '1', format: 'json', formatversion: '2' });
      const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(4500) });
      if (!res.ok) throw new Error(`Wikiquote: HTTP ${res.status}`);
      const data = await res.json();
      if (!data.query?.pages) throw new Error('Wikiquote: resposta sem páginas');
      const aliases = new Map([...(data.query.normalized || []), ...(data.query.redirects || [])].map((r) => [r.from, r.to]));
      const fetched = new Map();
      for (const title of missing) {
        let canonical = title;
        const seen = new Set();
        while (aliases.has(canonical) && !seen.has(canonical)) { seen.add(canonical); canonical = aliases.get(canonical); }
        const p = data.query.pages.find((p) => p.title === canonical);
        const content = p?.revisions?.[0]?.slots?.main?.content;
        const page = content ? { title: p.title, text: content } : null;
        fetched.set(title, page);
        db.prepare(`INSERT INTO api_cache (key, value, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`)
          .run(key(title), JSON.stringify(page), now + (page ? 30 : 7) * DAY);
      }
      return fetched;
    })());
  }
  try {
    for (const [title, page] of await pending.get(batchKey)) pages.set(title, page);
  } catch (err) {
    retryAfter = now + 60_000;
    console.warn('Não foi possível atualizar citações do Wikiquote:', err.message);
  } finally {
    pending.delete(batchKey);
  }
  return pages;
}

export async function dailyQuote(books, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!books.length) return null;
  const day = Math.floor(now / DAY);
  const reading = books.filter((b) => b.status === 'reading');
  const read = books.filter((b) => b.status !== 'reading');
  const rotate = (items) => items.length ? [...items.slice(day % items.length), ...items.slice(0, day % items.length)] : [];
  const candidates = [...rotate(reading).slice(0, 8), ...rotate(read).slice(0, 8)];
  const titles = [...new Set(candidates.flatMap((b) => [...bookTitles(b), ...b.authors.slice(0, 1)]))];
  const pages = await loadPages(titles, { now, fetchImpl });
  const pool = (items) => items.flatMap((book) => {
    const sources = new Map([...bookTitles(book), ...book.authors.slice(0, 1)].map((t) => {
      const p = pages.get(t); return [p?.title, p];
    }));
    const quotes = [...sources.values()].flatMap((p) => extractQuotes(p, book));
    return [...new Map(quotes.map((q) => [q.text, { ...q, book }])).values()];
  });
  const active = pool(candidates.filter((b) => b.status === 'reading'));
  const quotes = active.length ? active : pool(candidates.filter((b) => b.status !== 'reading'));
  return quotes.length ? quotes[day % quotes.length] : null;
}
