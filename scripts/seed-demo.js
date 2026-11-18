// Enche o app com livros reais e leituras de exemplo. Tudo fica marcado com demo = 1
// e o botão "Começar do zero" remove só isso. Uso: npm run demo
import { db, getSetting, setSetting, transaction } from '../server/db.js';
import { searchBooks } from '../server/openlibrary.js';
import { upsertFromOl, hasDemoData } from '../server/library.js';

if (hasDemoData()) {
  console.log('Os dados de exemplo já estão aqui.');
  process.exit(0);
}

// [busca, nota em meias estrelas, data, marcou?, resenha]
const YEAR = new Date().getFullYear();
const READ = [
  ['Torto Arado Itamar Vieira Junior', 10, `${YEAR}-10-19`, true, 'Bibiana e Belonísia carregam o livro nas costas, e a terra carrega todo o resto. Terminei e fiquei um tempo olhando para a parede.'],
  ['Grande Sertão: Veredas Guimarães Rosa', 10, `${YEAR}-09-28`, true, 'As primeiras cinquenta páginas pedem paciência. Depois a língua vira outra coisa e você não quer mais sair do sertão.'],
  ['Duna Frank Herbert', 9, `${YEAR}-08-30`, false, 'Política, ecologia e religião num deserto. Envelheceu melhor do que tinha direito.'],
  ['A Hora da Estrela Clarice Lispector', 9, `${YEAR}-08-03`, true, 'Tão curto e tão incômodo. Macabéa fica.'],
  ['Cem Anos de Solidão Gabriel García Márquez', 10, `${YEAR}-07-11`, true, 'Precisei de uma árvore genealógica e não me arrependo de nada.'],
  ['Vidas Secas Graciliano Ramos', 8, `${YEAR}-06-14`, false, 'Seco como o título promete. Baleia me destruiu.'],
  ['A Mão Esquerda da Escuridão Ursula K. Le Guin', 9, `${YEAR}-05-26`, false, null],
  ['Capitães da Areia Jorge Amado', 7, `${YEAR}-04-30`, false, null],
  ['Dom Casmurro Machado de Assis', 9, `${YEAR}-04-02`, false, 'Releitura. Agora tenho certeza. Na próxima, terei certeza do contrário.'],
  ['1984 George Orwell', 8, `${YEAR}-03-09`, false, null],
  ['O Conto da Aia Margaret Atwood', 8, `${YEAR}-02-11`, false, null],
  ['Ensaio sobre a Cegueira José Saramago', 9, `${YEAR}-01-18`, true, 'Sem travessão, sem vírgula sobrando, sem piedade.'],
  ['O Senhor dos Anéis Tolkien', 10, `${YEAR - 1}-12-20`, true, 'Todo fim de ano eu ameaço reler. Este ano cumpri.'],
  ['O Hobbit Tolkien', 8, `${YEAR - 1}-11-02`, false, null],
  ['Crime e Castigo Dostoiévski', 9, `${YEAR - 1}-09-15`, false, null],
  ['Memórias Póstumas de Brás Cubas Machado de Assis', 9, `${YEAR}-01-03`, false, null],
  ['Sapiens Yuval Noah Harari', 6, `${YEAR - 1}-05-04`, false, 'Divertido enquanto dura, frouxo quando se olha de perto.'],
  ['O Pequeno Príncipe Saint-Exupéry', 7, `${YEAR - 1}-02-14`, false, null],
];
const READING = [
  ['Os Sertões Euclides da Cunha', 212],
  ['Neuromancer William Gibson', 88],
];
const WANT = [
  'Sagarana Guimarães Rosa', 'O Avesso da Pele Jeferson Tenório', 'Quarto de Despejo Carolina Maria de Jesus',
  'Macunaíma Mário de Andrade', 'Solaris Stanisław Lem', 'Middlemarch George Eliot',
];
const QUOTES = [
  ['Grande Sertão: Veredas', 'Viver é muito perigoso.'],
  ['Grande Sertão: Veredas', 'O real não está na saída nem na chegada: ele se dispõe para a gente é no meio da travessia.'],
  ['A Hora da Estrela', 'Tudo no mundo começou com um sim.'],
  ['Duna', 'O medo é o assassino da mente.'],
  ['Dom Casmurro', 'Olhos de cigana oblíqua e dissimulada.'],
];
const FAVORITES = ['Grande Sertão: Veredas', 'Torto Arado', 'Cem Anos de Solidão', 'Ensaio sobre a Cegueira'];
const LISTS = [
  { title: 'Para entender o Brasil', description: 'Ficção que explica mais do que muito manual.', ranked: false, books: ['Grande Sertão: Veredas', 'Torto Arado', 'Vidas Secas', 'Dom Casmurro', 'Capitães da Areia', 'A Hora da Estrela'] },
  { title: 'Melhores futuros ruins', description: 'Ranking pessoal e indiscutível.', ranked: true, books: ['1984', 'O Conto da Aia', 'Ensaio sobre a Cegueira', 'Duna'] },
];

// A Open Library tem alguns registros feios para clássicos brasileiros.
const CLEANUP = {
  'Grande Sertão: Veredas Guimarães Rosa': { title: 'Grande Sertão: Veredas', authors: ['João Guimarães Rosa'] },
  'Vidas Secas Graciliano Ramos': { title: 'Vidas Secas', authors: ['Graciliano Ramos'] },
  'Capitães da Areia Jorge Amado': { authors: ['Jorge Amado'] },
  'Os Sertões Euclides da Cunha': { title: 'Os Sertões', authors: ['Euclides da Cunha'] },
};

const cache = new Map();

async function resolve(query) {
  if (cache.has(query)) return cache.get(query);
  const docs = await searchBooks(query);
  const doc = docs.find((d) => d.cover_id && d.ol_key) || docs[0];
  if (!doc) throw new Error(`Sem resultado para: ${query}`);
  const id = upsertFromOl(doc);
  cache.set(query, id);
  const fix = CLEANUP[query];
  if (fix?.title) db.prepare('UPDATE books SET title = ?, user_edited = 1 WHERE id = ?').run(fix.title, id);
  if (fix?.authors) db.prepare('UPDATE books SET authors = ?, user_edited = 1 WHERE id = ?').run(JSON.stringify(fix.authors), id);
  const row = db.prepare('SELECT title, cover_id, pages FROM books WHERE id = ?').get(id);
  console.log(`  ${query} -> ${row.title} (${row.pages ?? '?'} p.)`);
  await new Promise((r) => setTimeout(r, 400));
  return id;
}

const short = new Map();
const remember = (query, id) => { short.set(query, id); };
const lookup = (titleStart) => {
  for (const [query, id] of short) if (query.startsWith(titleStart)) return id;
  throw new Error(`Livro não semeado: ${titleStart}`);
};

console.log('Buscando livros na Open Library...');
for (const [query] of [...READ, ...READING]) remember(query, await resolve(query));
const wantIds = [];
for (const query of WANT) wantIds.push(await resolve(query));

const daysBefore = (iso, n) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA');
};

transaction(() => {
  READ.forEach(([query, rating, date, liked, review], i) => {
    const id = lookup(query);
    db.prepare(`INSERT INTO shelf (book_id, status, liked, demo) VALUES (?, 'read', ?, 1)
      ON CONFLICT(book_id) DO UPDATE SET status = 'read', liked = excluded.liked, demo = 1`).run(id, liked ? 1 : 0);
    const pages = db.prepare('SELECT pages FROM books WHERE id = ?').get(id).pages || 280;
    db.prepare(`INSERT INTO logs (book_id, finished_on, started_on, rating, review, reread, format, demo) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(id, date, daysBefore(date, Math.round(pages / 22)), rating, review, query.startsWith('Dom Casmurro') ? 1 : 0, i % 3 === 2 ? 'ebook' : 'paper');
  });
  for (const [query, page] of READING) {
    const id = lookup(query);
    const today = new Date().toLocaleDateString('en-CA');
    db.prepare(`INSERT INTO shelf (book_id, status, current_page, started_on, demo) VALUES (?, 'reading', ?, ?, 1)
      ON CONFLICT(book_id) DO UPDATE SET status = 'reading', current_page = excluded.current_page, demo = 1`).run(id, page, daysBefore(today, 12));
    db.prepare('INSERT INTO progress (book_id, page, on_day, demo) VALUES (?, ?, ?, 1)').run(id, page, today);
  }
  for (const id of wantIds) {
    db.prepare(`INSERT INTO shelf (book_id, status, demo) VALUES (?, 'want', 1)
      ON CONFLICT(book_id) DO UPDATE SET status = 'want', demo = 1`).run(id);
  }
  for (const [title, text] of QUOTES) {
    db.prepare('INSERT INTO quotes (book_id, text, demo) VALUES (?, ?, 1)').run(lookup(title), text);
  }
  FAVORITES.forEach((title, i) => {
    db.prepare('INSERT OR REPLACE INTO favorites (slot, book_id, demo) VALUES (?, ?, 1)').run(i + 1, lookup(title));
  });
  for (const list of LISTS) {
    const { lastInsertRowid } = db.prepare('INSERT INTO lists (title, description, ranked, demo) VALUES (?, ?, ?, 1)').run(list.title, list.description, list.ranked ? 1 : 0);
    list.books.forEach((title, i) => {
      db.prepare('INSERT INTO list_items (list_id, book_id, position) VALUES (?, ?, ?)').run(lastInsertRowid, lookup(title), i);
    });
  }
  if (!getSetting('goal')) {
    setSetting('goal', 18);
    setSetting('goal_is_demo', 1);
  }
});

console.log('Pronto.');
