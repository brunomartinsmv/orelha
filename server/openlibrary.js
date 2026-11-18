// Acesso à Open Library (e BrasilAPI para ISBNs brasileiros), com cache em SQLite.
import { db } from './db.js';

const UA = 'Orelha/1.0 (personal reading diary)';
const HOUR = 3600_000;
const DOC_FIELDS = [
  'key', 'title', 'subtitle', 'author_name', 'first_publish_year', 'cover_i',
  'number_of_pages_median', 'isbn', 'subject', 'editions', 'editions.title',
  'editions.cover_i', 'editions.language', 'editions.isbn',
  'ratings_average', 'ratings_count', 'readinglog_count', 'author_alternative_name',
].join(',');

const NOISE_SUBJECT = /^(fiction|ficção|novel|novels|literature|general|large type|accessible|protected|in library|overdrive|open_syllabus|nyt:|new york times|reading level|internet archive|lending library|spanish language|translations|english |american |long now|ficción|roman|fiction,? general|award|staff picks|thesis|textbooks)/i;

async function fetchJson(url, ttlMs) {
  const cached = db.prepare('SELECT value, expires_at FROM api_cache WHERE key = ?').get(url);
  if (cached && cached.expires_at > Date.now()) return JSON.parse(cached.value);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} em ${new URL(url).pathname}`);
    const data = await res.json();
    db.prepare(`INSERT INTO api_cache (key, value, expires_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`)
      .run(url, JSON.stringify(data), Date.now() + ttlMs);
    return data;
  } catch (err) {
    if (cached) return JSON.parse(cached.value); // antes velho do que nada
    err.upstream = true;
    throw err;
  }
}

export function cleanSubjects(subjects = []) {
  const seen = new Set();
  const out = [];
  for (const raw of subjects) {
    const s = String(raw).trim();
    const k = s.toLowerCase();
    if (!s || s.length > 40 || NOISE_SUBJECT.test(s) || /[=:(]|\d{4}/.test(s) || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length === 10) break;
  }
  return out;
}

function cleanDescription(desc) {
  const text = typeof desc === 'string' ? desc : desc?.value;
  if (!text) return null;
  return text
    .split(/\n-{3,}\n|\n\*\*Also in|\nContains:|\n\(source:/i)[0]
    .replace(/\[([^\]]+)\]\[?\d*\]?(\([^)]*\))?/g, '$1')
    .replace(/^\s*\[\d+\]:.*$/gm, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim() || null;
}

const isLatin = (name) => /^[\p{Script=Latin}\s.,'’-]+$/u.test(name);

// Mostra "Haruki Murakami", não 村上春樹, quando o catálogo conhece a grafia latina.
function readableAuthors(doc) {
  // Marcadores de catalogação como "[author not identified]" não são autores.
  const names = (doc.author_name || []).filter((a) => !/^\[.*\]$/.test(a.trim()));
  const aliases = (doc.author_alternative_name || []).filter((a) => isLatin(a) && a !== a.toUpperCase());
  // A mais curta: as longas costumam ser instituições ("Murakami Haruki Kenkyūkai").
  const latinAlias = names.length === 1 && !isLatin(names[0]) && aliases.sort((a, b) => a.length - b.length)[0];
  if (latinAlias) return [latinAlias];
  // A OL repete a mesma pessoa com grafias diferentes ("Vieira Junior", "Vieira Júnior").
  return [...new Map(names.map((a) => [skeleton(a), a])).values()].slice(0, 4);
}

const skeleton = (text) => text.normalize('NFD').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

// Normaliza um doc da busca. Se houver edição em português, usa título/capa dela.
export function normalizeDoc(doc) {
  const edition = doc.editions?.docs?.[0];
  const editionIsPt = !!edition?.language?.includes('por');
  let ptTitle = editionIsPt && edition?.title;
  // Catálogos antigos trazem coisas como "Capita es da areia". Se só o acento ou o espaço
  // diferem do título da obra, o da obra é o confiável e continua sendo o título em português.
  if (ptTitle && skeleton(ptTitle) === skeleton(doc.title)) ptTitle = doc.title;
  const key = doc.key?.replace('/works/', '');
  if (!key || !doc.title) return null;
  const isbns = doc.isbn || edition?.isbn || [];
  return {
    ol_key: key,
    title: ptTitle || doc.title,
    title_is_pt: ptTitle ? 1 : 0,
    original_title: ptTitle && ptTitle !== doc.title ? doc.title : null,
    subtitle: ptTitle ? null : doc.subtitle || null,
    authors: readableAuthors(doc),
    year: doc.first_publish_year || null,
    pages: doc.number_of_pages_median || null,
    isbn: isbns.find((i) => i.length === 13) || isbns[0] || null,
    cover_id: (editionIsPt && edition?.cover_i) || doc.cover_i || null,
    subjects: cleanSubjects(doc.subject),
    // Só para ranquear recomendações; não vai para o banco.
    signals: {
      avg: doc.ratings_average || 0,
      count: doc.ratings_count || 0,
      log: doc.readinglog_count || 0,
      subjects: doc.subject || [],
    },
  };
}

async function searchDocs(query, { limit = 20, sort, ttl = 24 * HOUR } = {}) {
  const params = new URLSearchParams({ q: query, limit: String(limit), fields: DOC_FIELDS, lang: 'por' });
  if (sort) params.set('sort', sort);
  const data = await fetchJson(`https://openlibrary.org/search.json?${params}`, ttl);
  return (data?.docs || []).map(normalizeDoc).filter(Boolean);
}

const ISBN_RE = /^(97[89])?\d{9}[\dXx]$/;

// Duas consultas em paralelo: a geral e a restrita a edições em português.
// Obras com edição em pt sobem para o topo e aparecem com o título brasileiro.
export async function searchBooks(rawQuery) {
  const query = rawQuery.trim();
  const compact = query.replace(/[-\s]/g, '');
  if (ISBN_RE.test(compact)) return searchIsbn(compact);

  const [general, pt] = await Promise.allSettled([
    searchDocs(query, { limit: 20 }),
    searchDocs(`${query} language:por`, { limit: 15 }),
  ]);
  if (general.status === 'rejected' && pt.status === 'rejected') throw general.reason;

  const generalDocs = general.status === 'fulfilled' ? general.value : [];
  const ptDocs = pt.status === 'fulfilled' ? pt.value : [];
  const ptByKey = new Map(ptDocs.map((d) => [d.ol_key, d]));
  const generalKeys = new Set(generalDocs.map((d) => d.ol_key));
  const merged = generalDocs.map((d) => {
    const ptDoc = ptByKey.get(d.ol_key);
    return ptDoc?.title_is_pt ? { ...d, ...ptDoc, pages: d.pages || ptDoc.pages } : d;
  });
  const extra = ptDocs.filter((d) => !generalKeys.has(d.ol_key));
  // Mantém a relevância da busca geral, mas com as obras exclusivas em pt logo depois do 1º resultado.
  return [...merged.slice(0, 1), ...extra.slice(0, 5), ...merged.slice(1)].slice(0, 24);
}

async function searchIsbn(isbn) {
  const docs = await searchDocs(`isbn:${isbn}`, { limit: 5 }).catch(() => []);
  if (docs.length) return docs.map((d) => ({ ...d, isbn }));
  const br = await fetchJson(`https://brasilapi.com.br/api/isbn/v1/${isbn}`, 7 * 24 * HOUR).catch(() => null);
  if (!br?.title) return [];
  return [{
    ol_key: null,
    title: br.title,
    title_is_pt: 1,
    original_title: null,
    subtitle: br.subtitle || null,
    authors: br.authors || [],
    year: br.year || null,
    pages: br.page_count || null,
    isbn,
    cover_id: null,
    cover_isbn: isbn,
    subjects: br.subjects || [],
    description: br.synopsis || null,
    source: 'brasilapi',
  }];
}

export async function workDetails(olKey) {
  const work = await fetchJson(`https://openlibrary.org/works/${olKey}.json`, 7 * 24 * HOUR);
  if (!work) return null;
  const firstCover = (work.covers || []).find((c) => c > 0) || null;
  return {
    title: work.title,
    description: cleanDescription(work.description),
    subjects: cleanSubjects(work.subjects),
    cover_id: firstCover,
  };
}

// Quando a obra é aberta direto pelo ID (sem passar pela busca).
export async function fetchWorkDoc(olKey) {
  const [general, pt] = await Promise.allSettled([
    searchDocs(`key:/works/${olKey}`, { limit: 1, ttl: 7 * 24 * HOUR }),
    searchDocs(`key:/works/${olKey} language:por`, { limit: 1, ttl: 7 * 24 * HOUR }),
  ]);
  const ptDoc = pt.status === 'fulfilled' && pt.value[0]?.title_is_pt ? pt.value[0] : null;
  return ptDoc || (general.status === 'fulfilled' ? general.value[0] : null) || null;
}

export async function communityData(olKey) {
  const [ratings, shelves] = await Promise.allSettled([
    fetchJson(`https://openlibrary.org/works/${olKey}/ratings.json`, 24 * HOUR),
    fetchJson(`https://openlibrary.org/works/${olKey}/bookshelves.json`, 24 * HOUR),
  ]);
  const r = ratings.status === 'fulfilled' ? ratings.value : null;
  const s = shelves.status === 'fulfilled' ? shelves.value?.counts : null;
  return {
    average: r?.summary?.average ?? null,
    count: r?.summary?.count ?? 0,
    counts: r?.counts ?? null,
    want: s?.want_to_read ?? 0,
    reading: s?.currently_reading ?? 0,
    read: s?.already_read ?? 0,
  };
}

export async function trending() {
  const data = await fetchJson('https://openlibrary.org/trending/weekly.json?limit=40', 6 * HOUR);
  return (data?.works || []).map(normalizeDoc).filter((d) => d && d.cover_id).slice(0, 18);
}

// O que muita gente lê e tem edição em português: separa livro de verdade de catalogação perdida.
export const popularInPortuguese = (query, limit = 60) =>
  searchDocs(`${query} language:por`, { limit, sort: 'readinglog', ttl: 7 * 24 * HOUR });

export const byAuthor = (author, limit = 14) =>
  searchDocs(`author:"${author.replace(/"/g, '')}"`, { limit, ttl: 7 * 24 * HOUR })
    .then((docs) => docs.filter((d) => d.cover_id));
