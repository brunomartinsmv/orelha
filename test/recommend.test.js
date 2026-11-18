import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorRail, belongsTo, genresOf, isWorthShowing, lovedAuthors, pickSeeds, rankRail, shelfIndex, tasteProfile } from '../server/recommend.js';

const lotr = { id: 'OL1', ol_key: 'OL1', title: 'O Senhor dos Anéis', original_title: 'The Lord of the Rings', authors: ['J.R.R. Tolkien'], subjects: ['Fantasy fiction'], rating: 10, liked: 1, status: 'read' };
const hobbit = { id: 'OL2', ol_key: 'OL2', title: 'O Hobbit', original_title: 'The Hobbit', authors: ['J.R.R. Tolkien'], subjects: ['Fantasy'], rating: 8, status: 'read' };
const dune = { id: 'OL3', ol_key: 'OL3', title: 'Duna', original_title: 'Dune', authors: ['Frank Herbert'], subjects: ['Science fiction'], rating: 9, status: 'read' };
const library = [lotr, hobbit, dune];
const shelf = shelfIndex(library);

const candidate = (title, author, extra = {}) => ({
  ol_key: `K${title}`, title, title_is_pt: 1, authors: [author], cover_id: 1,
  signals: { avg: 4.2, count: 50, log: 500, subjects: ['Science fiction'] }, ...extra,
});

test('derivados e outros volumes do que você já tem ficam de fora', () => {
  const rejected = [
    candidate('Lord of the Rings: Official Game Secrets', 'Steven A. Schwartz'),
    candidate("Exploring J.R.R. Tolkien's The Hobbit", 'Corey Olsen'),
    candidate('Meditations on Middle Earth', 'Karen Haber'),
    candidate('O Senhor dos Anéis: A Sociedade do Anel', 'J.R.R. Tolkien'),
    candidate('O Senhor dos Anéis', 'J.R.R. Tolkien', { ol_key: 'OUTRA-EDICAO' }),
    candidate('The Fellowship of the Ring', 'J.R.R. Tolkien', { signals: { avg: 4.3, count: 400, log: 2500, subjects: ['The Lord of the Rings'] } }),
    candidate('Duna', 'Frank Herbert', { ol_key: 'OL3' }),
  ];
  for (const doc of rejected) assert.equal(isWorthShowing(doc, shelf), false, doc.title);
});

test('livro de verdade do mesmo autor ou universo continua valendo', () => {
  assert.equal(isWorthShowing(candidate('O Silmarillion', 'J.R.R. Tolkien'), shelf), true);
  assert.equal(isWorthShowing(candidate('Messias de Duna', 'Frank Herbert'), shelf), true);
  assert.equal(isWorthShowing(candidate('O Guia do Mochileiro das Galáxias', 'Douglas Adams'), shelf), true);
});

test('corta sem capa, mal avaliado e infantojuvenil, mas não pune quem tem poucas notas', () => {
  assert.equal(isWorthShowing(candidate('Sem capa', 'A', { cover_id: null }), shelf), false);
  assert.equal(isWorthShowing(candidate('Brida', 'B', { signals: { avg: 3.0, count: 8, log: 236, subjects: [] } }), shelf), false);
  assert.equal(isWorthShowing(candidate('Pedra', 'C', { signals: { avg: 4.2, count: 900, log: 9000, subjects: ['Juvenile fiction'] } }), shelf), false);
  assert.equal(isWorthShowing(candidate('Pssica', 'D', { signals: { avg: 0, count: 0, log: 9, subjects: [] } }), shelf), true);
});

test('assunto sujo não vira gênero', () => {
  assert.deepEqual(genresOf(['Exhibitions', 'Accidents', 'Families']), []);
  assert.deepEqual(genresOf(['Hugo Award Winner', 'Science fiction']), ['scifi']);
  assert.deepEqual(genresOf(['magic realism', 'Latin American fiction']), ['magic-realism', 'latin-american']);
});

test('o gosto sobe com nota alta e desce com nota baixa e abandono', () => {
  const taste = tasteProfile([
    dune,
    { title: 'Ruim', subjects: ['Horror fiction'], rating: 2 },
    { title: 'Larguei', subjects: ['Love stories'], status: 'dropped' },
  ]);
  assert.ok(taste.get('scifi') > 0);
  assert.ok(taste.get('horror') < 0);
  assert.ok(taste.get('romance') < 0);
});

test('as sementes são livros amados, de gêneros diferentes, e mudam com o dia', () => {
  const books = [
    ...library,
    { id: 'x', title: 'Mal avaliado', subjects: ['Poetry'], rating: 4 },
    { id: 'y', title: 'Sem gênero', subjects: ['Exhibitions'], rating: 10 },
    { id: 'z', title: 'Outro', subjects: ['Magic realism'], rating: 9 },
  ];
  const seeds = pickSeeds(books, { day: 0 });
  const titles = seeds.map((s) => s.title);
  assert.ok(!titles.includes('Mal avaliado') && !titles.includes('Sem gênero'));
  assert.equal(new Set(seeds.map((s) => s.genres[0])).size, seeds.length);
  assert.notDeepEqual(titles, pickSeeds(books, { day: 1 }).map((s) => s.title));
  assert.deepEqual(pickSeeds([], { day: 3 }), []);
});

test('a seleção escolhe um livro por autor, foge de autor conhecido e não repete entre seleções', () => {
  const docs = [
    candidate('Fundação', 'Isaac Asimov'),
    candidate('Eu, Robô', 'Isaac Asimov'),
    candidate('O Silmarillion', 'J.R.R. Tolkien'),
    candidate('Devoradores de Estrelas', 'Andy Weir'),
  ];
  const seen = new Set();
  const taste = tasteProfile(library);
  const first = rankRail(docs, { shelf, taste, seedGenres: ['scifi'], seen, excludeKnownAuthors: true });
  assert.equal(first.filter((d) => d.authors[0] === 'Isaac Asimov').length, 1);
  assert.ok(!first.some((d) => d.authors[0] === 'J.R.R. Tolkien'));
  const second = rankRail(docs, { shelf, taste, seen, perAuthor: 2 });
  assert.ok(second.every((d) => !first.includes(d)));
});

test('melhor nota e gênero amado vêm primeiro', () => {
  const taste = tasteProfile(library);
  const docs = [
    candidate('Popular fraco', 'A', { signals: { avg: 3.7, count: 100, log: 900, subjects: ['Love stories'] } }),
    candidate('Ficção científica ótima', 'B', { signals: { avg: 4.5, count: 100, log: 900, subjects: ['Science fiction'] } }),
  ];
  const [top] = rankRail(docs, { shelf, taste, seedGenres: ['scifi'] });
  assert.equal(top.title, 'Ficção científica ótima');
});

test('gênero amplo precisa de duas etiquetas; o específico basta uma', () => {
  assert.equal(belongsTo(['Fantasy', 'Political science'], 'fantasy'), false);
  assert.equal(belongsTo(['Fantasy', 'Fantasy fiction'], 'fantasy'), true);
  assert.equal(belongsTo(['Magic realism'], 'magic-realism'), true);
});

test('seleção em português ignora título em inglês e, se pedir, só autor conhecido e livro conhecido', () => {
  const taste = tasteProfile(library);
  const docs = [
    candidate('The third bank of the river', 'João Guimarães Rosa'),
    candidate('Sem edição brasileira', 'E', { title_is_pt: 0 }),
    candidate('Obscuro', 'F', { signals: { avg: 0, count: 0, log: 2, subjects: ['Science fiction'] } }),
    candidate('Helena', 'Studio Seasons'),
    candidate('O Silmarillion', 'J.R.R. Tolkien'),
  ];
  const titles = (options) => rankRail(docs, { shelf, taste, ...options }).map((d) => d.title);
  assert.deepEqual(titles({ minLog: 10 }).sort(), ['Helena', 'O Silmarillion']);
  assert.deepEqual(titles({ onlyKnownAuthors: true }), ['O Silmarillion']);
  assert.ok(titles({ ptOnly: false }).includes('The third bank of the river'));
});

test('o gosto vem só da nota: a antiga orelha dobrada não pesa mais', () => {
  const rated = { title: 'Nota 6', subjects: ['Horror fiction'], rating: 6 };
  assert.equal(tasteProfile([rated]).get('horror'), tasteProfile([{ ...rated, liked: 1 }]).get('horror'));
  const unrated = { id: 'u', title: 'Sem nota', subjects: ['Poetry'], liked: 1 };
  assert.deepEqual(pickSeeds([unrated], { day: 0 }), []);
});

test('autores amados vêm das melhores notas', () => {
  const authors = lovedAuthors(library, { day: 0 });
  assert.ok(authors.includes('J.R.R. Tolkien') && authors.includes('Frank Herbert'));
  assert.ok(!lovedAuthors([{ title: 'x', authors: ['Ninguém'], rating: 4 }]).length);
});

test('"Mais de" mostra a obra em português, sem repetir o livro aberto nem a mesma obra com outra grafia', () => {
  const docs = [
    candidate('Memorias Posthumas de Braz Cubas', 'Machado de Assis', { original_title: 'Memórias póstumas de Brás Cubas' }),
    candidate('Memórias Póstumas de Brás Cubas', 'Machado de Assis', { ol_key: 'OUTRA' }),
    candidate('Dom Casmurro', 'Machado de Assis'),
    candidate('Machado de Assis', 'Machado de Assis'),
    candidate('The Alienist', 'Machado de Assis'),
    candidate('Ano da Morte de Ricardo Reis, O', 'José Saramago'),
    candidate('O ano da morte de Ricardo Reis', 'José Saramago'),
    candidate('Quincas Borba', 'Machado de Assis', { cover_id: null }),
    candidate('AVENTURA (A) DE MIGUEL LITTÍN -(EURO 9.88)', 'Machado de Assis'),
  ];
  const titles = authorRail(docs, { author: 'Machado de Assis', book: { title: 'Dom Casmurro' } }).map((d) => d.title);
  assert.deepEqual(titles, ['Memorias Posthumas de Braz Cubas', 'Ano da Morte de Ricardo Reis, O']);
  assert.ok(authorRail(docs, { author: 'X', ptOnly: false }).some((d) => d.title === 'The Alienist'));
});

test('parecidos precisam bater em dois gêneros do livro; sem gênero pedido, nada quebra', () => {
  const both = candidate('Brasileiro e histórico', 'A', { signals: { avg: 4, count: 20, log: 300, subjects: ['Brazilian fiction', 'Historical fiction'] } });
  const one = candidate('Só brasileiro', 'B', { signals: { avg: 4.5, count: 20, log: 900, subjects: ['Brazilian fiction'] } });
  const taste = tasteProfile(library);
  const similar = rankRail([one, both], { shelf, taste, seedGenres: ['brazilian', 'historical'], minSeedMatch: 2 });
  assert.deepEqual(similar.map((d) => d.title), ['Brasileiro e histórico']);
  assert.equal(rankRail([one, both], { shelf, taste }).length, 2);
});
