// Decide o que recomendar a partir do diário. Sem rede nem banco: library.js entrega os dados.
//
// Os assuntos da Open Library são sujos (Grande Sertão: Veredas é "Exhibitions"), então só contam os
// que caem nesta lista de gêneros. A ordem vai do mais específico ao mais amplo: é o gênero que define o livro.
// Os gêneros marcados como amplos vivem mal etiquetados (O Príncipe aparece como fantasia), então só valem
// para uma seleção quando duas etiquetas do livro concordam.
export const GENRES = [
  ['magic-realism', 'Realismo mágico', 'magic realism', /magic(al)? realism|realismo m[aá]gico/i],
  ['dystopia', 'Distopias', 'dystopias', /dystopi|distopi|totalitarian|thoughtcrime/i],
  ['brazilian', 'Literatura brasileira', 'Brazilian fiction', /brazil|brasil/i],
  ['latin-american', 'Literatura latino-americana', 'Latin American fiction', /latin ?american (fiction|literature)|literatura latino/i],
  ['portuguese', 'Ficção em português', 'Portuguese fiction', /portuguese (fiction|literature)|literatura portuguesa|fic[cç][aã]o em portugu[eê]s/i],
  ['russian', 'Literatura russa', 'Russian literature', /russian (fiction|literature)|literatura russa/i],
  ['horror', 'Terror', 'horror', /^horror|horror (fiction|stories)|terror/i, true],
  ['scifi', 'Ficção científica', 'science fiction', /science.?fiction|fic[cç][aã]o cient|ciencia.?ficci/i, true],
  ['fantasy', 'Fantasia', 'fantasy fiction', /^fantasy|fantasy fiction|^fantasia/i, true],
  ['mystery', 'Mistério', 'detective and mystery stories', /detective|mystery|^mist[eé]rio/i, true],
  ['historical', 'Ficção histórica', 'historical fiction', /historical fiction|fic[cç][aã]o hist/i],
  ['psychological', 'Ficção psicológica', 'psychological fiction', /psychological fiction|fic[cç][aã]o psicol[oó]gica/i],
  ['poetry', 'Poesia', 'poetry', /^poetry|^poesia/i],
  ['short-stories', 'Contos', 'short stories', /short stories|^contos/i],
  ['graphic', 'Quadrinhos', 'graphic novels', /graphic novel|comic books|quadrinhos/i],
  ['romance', 'Romance', 'love stories', /love stories|romance fiction|^romance$/i],
  ['philosophy', 'Filosofia', 'philosophy', /^philosophy|^filosofia/i],
  ['biography', 'Biografias', 'biography', /^biography|autobiography|^biografia/i],
  ['history', 'História', 'world history', /^history$|world history|^hist[oó]ria$/i],
  ['science', 'Divulgação científica', 'popular science', /popular science|^science$|divulga[cç][aã]o cient[ií]fica/i],
  ['young-adult', 'Jovem adulto', 'young adult fiction', /young adult|juvenile fiction|^jovem adulto$/i],
].map(([id, label, query, pattern, broad = false]) => ({ id, label, query, pattern, broad }));

const GENRE_BY_ID = new Map(GENRES.map((g) => [g.id, g]));
export const genre = (id) => GENRE_BY_ID.get(id);

export const genresOf = (subjects = []) =>
  GENRES.filter((g) => subjects.some((s) => g.pattern.test(s))).map((g) => g.id);

export const otherSubjectsOf = (subjects = []) =>
  subjects.filter((s) => !GENRES.some((g) => g.pattern.test(s)));

// O livro é mesmo desse gênero, e não só tem uma etiqueta perdida?
export function belongsTo(subjects = [], id) {
  const { pattern, broad } = genre(id);
  return subjects.filter((s) => pattern.test(s)).length >= (broad ? 2 : 1);
}

const norm = (text = '') => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const withoutArticle = (title) => title.replace(/^(the|a|an|o|os|as|um|uma) /, '');

// Quanto cada livro diz sobre o seu gosto: quem manda é a nota. 5 estrelas puxa para cima,
// 1 estrela e abandono para baixo; "quero ler" só dá um empurrãozinho.
function signal(book) {
  if (book.status === 'dropped') return -1;
  if (book.rating) return (book.rating - 6) / 4;
  return book.status === 'want' ? 0.3 : 0;
}

export function tasteProfile(books) {
  const totals = new Map();
  for (const book of books) {
    for (const id of genresOf(book.subjects)) totals.set(id, (totals.get(id) || 0) + signal(book));
  }
  const max = Math.max(1, ...[...totals.values()].map(Math.abs));
  return new Map([...totals].map(([id, value]) => [id, value / max]));
}

const isLoved = (book) => (book.rating || 0) >= 8;

// Livros que puxam uma seleção: os mais amados, com gêneros diferentes entre si. Muda a cada dia.
export function pickSeeds(books, { day = 0, count = 3 } = {}) {
  const loved = books
    .map((book) => ({ ...book, genres: genresOf(book.subjects) }))
    .filter((book) => isLoved(book) && book.genres.length)
    .sort((a, b) => (b.rating || 0) - (a.rating || 0) || a.title.localeCompare(b.title))
    .slice(0, 9);
  if (!loved.length) return [];
  const rotated = loved.map((_, i) => loved[(i + day) % loved.length]);
  const used = new Set();
  const seeds = [];
  for (const book of rotated) {
    if (used.has(book.genres[0])) continue;
    used.add(book.genres[0]);
    seeds.push(book);
    if (seeds.length === count) break;
  }
  return seeds;
}

export function lovedAuthors(books, { day = 0, count = 5 } = {}) {
  const scores = new Map();
  for (const book of books) {
    const author = book.authors?.[0];
    if (author && isLoved(book)) scores.set(author, (scores.get(author) || 0) + signal(book));
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([author]) => author);
  return ranked.slice(0, count * 2).map((_, i, all) => all[(i + day) % all.length]).slice(0, count);
}

// O que nunca deve aparecer: guias, resumos, caixas e afins.
const NOT_A_BOOK = /study guide|sparknotes|cliffs ?notes|game secrets|companion to|^exploring |^meditations on |box(ed)? set|cole[cç][aã]o|collection|omnibus|trilog|summary of|resumo d|the complete |obras completas/i;
const FOR_KIDS = /juvenile|young adult|children|infantil|infanto/i;
const LOOKS_ENGLISH = /\b(the|of|and|with)\b/i;
// Catalogação de livraria: "AVENTURA (A) DE MIGUEL LITTÍN -(EURO 9.88)".
const DIRTY_TITLE = { test: (title) => /\beuro\b|\((a|o|as|os)\)/i.test(title) || /^[^a-zà-ú]{14,}$/.test(title) };

export function shelfIndex(books) {
  const titles = new Set();
  const stems = new Set();
  for (const book of books) {
    for (const title of [book.title, book.original_title]) {
      if (!title) continue;
      titles.add(norm(title));
      stems.add(withoutArticle(norm(title)));
    }
  }
  return {
    ids: new Set(books.flatMap((b) => [b.id, b.ol_key]).filter(Boolean)),
    titles,
    stems,
    authors: new Set(books.flatMap((b) => b.authors || []).map(norm)),
  };
}

// Já lido com outra capa, volume da mesma série ou livro sobre um livro que você já tem.
function isOnShelfOrDerived(doc, shelf) {
  if (shelf.ids.has(doc.ol_key)) return true;
  const names = [doc.title, doc.original_title].filter(Boolean).map(norm);
  const sameAuthor = (doc.authors || []).some((a) => shelf.authors.has(norm(a)));
  return names.some((name) => {
    if (shelf.titles.has(name) || shelf.stems.has(withoutArticle(name))) return true;
    for (const stem of shelf.stems) {
      if (stem.length >= 6 && withoutArticle(name).startsWith(`${stem} `)) return true;
      if (!sameAuthor && stem.length >= 8 && ` ${name} `.includes(` ${stem} `)) return true;
    }
    return false;
  }) || (sameAuthor && (doc.signals?.subjects || []).some((s) => shelf.stems.has(withoutArticle(norm(s)))));
}

export function isWorthShowing(doc, shelf, taste = new Map()) {
  if (!doc.cover_id || NOT_A_BOOK.test(doc.title) || isOnShelfOrDerived(doc, shelf)) return false;
  const { avg = 0, count = 0, subjects = [] } = doc.signals || {};
  if (count >= 5 && avg < 3.6) return false;
  const readsForKids = (taste.get('young-adult') || 0) > 0;
  return readsForKids || !subjects.some((s) => FOR_KIDS.test(s));
}

function score(doc, taste, seedGenres = []) {
  const { avg = 0, count = 0, log = 0, subjects = [] } = doc.signals || {};
  const genres = genresOf(subjects);
  const seedMatch = genres.filter((id) => seedGenres.includes(id)).length;
  const tasteMatch = genres.reduce((sum, id) => sum + (taste.get(id) || 0), 0);
  const quality = count >= 10 ? (avg - 3.8) * 2 : 0;
  return seedMatch * 2 + tasteMatch + quality + Math.log10(log + 1) * 0.5 + (doc.title_is_pt ? 1 : 0);
}

// Melhores primeiro, no máximo `perAuthor` por autor, sem repetir o que outra seleção já mostrou.
export function rankRail(docs, {
  shelf, taste, seedGenres = [], seen = new Set(), perAuthor = 1, limit = 14,
  ptOnly = true, minLog = 0, requireSeedGenre = false, minSeedMatch = 0, excludeKnownAuthors = false, onlyKnownAuthors = false,
}) {
  const authorCount = new Map();
  const titles = new Set();
  const out = [];
  const ranked = docs
    .filter((doc) => isWorthShowing(doc, shelf, taste))
    .filter((doc) => !ptOnly || (doc.title_is_pt && !LOOKS_ENGLISH.test(doc.title)))
    .filter((doc) => (doc.signals?.log || 0) >= minLog)
    .filter((doc) => !requireSeedGenre || seedGenres.some((id) => belongsTo(doc.signals?.subjects, id)))
    .filter((doc) => seedGenres.filter((id) => belongsTo(doc.signals?.subjects, id)).length >= minSeedMatch)
    .map((doc) => ({ doc, value: score(doc, taste, seedGenres) }))
    .sort((a, b) => b.value - a.value);
  for (const { doc } of ranked) {
    const author = norm(doc.authors?.[0]);
    const title = norm(doc.title);
    if (seen.has(doc.ol_key) || titles.has(title)) continue;
    if (excludeKnownAuthors && shelf.authors.has(author)) continue;
    if (onlyKnownAuthors && !shelf.authors.has(author)) continue;
    if ((authorCount.get(author) || 0) >= perAuthor || title === author) continue;
    authorCount.set(author, (authorCount.get(author) || 0) + 1);
    titles.add(title);
    seen.add(doc.ol_key);
    out.push(doc);
    if (out.length === limit) break;
  }
  return out;
}

// "Mais de Fulano": o que o autor tem em português, do mais lido ao menos lido, sem o próprio livro.
// Aqui o que você já leu continua: é a obra da pessoa, não uma sugestão.
export const sameAuthor = (a, b) => !!a && !!b && norm(a) === norm(b);

export function authorRail(docs, { author, book, ptOnly = true, limit = 14 }) {
  // "Ano da Morte de Ricardo Reis, O" e "O ano da morte de Ricardo Reis" são o mesmo livro.
  const key = (title) => withoutArticle(norm(title.replace(/,\s*(o|a|os|as|the)$/i, '')));
  const seen = new Set([author, book?.title, book?.original_title].filter(Boolean).map(key));
  const out = [];
  for (const doc of docs) {
    const keys = [doc.title, doc.original_title].filter(Boolean).map(key);
    if (!doc.cover_id || NOT_A_BOOK.test(doc.title) || DIRTY_TITLE.test(doc.title) || keys.some((k) => seen.has(k))) continue;
    if (ptOnly && (!doc.title_is_pt || LOOKS_ENGLISH.test(doc.title))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(doc);
    if (out.length === limit) break;
  }
  return out;
}
