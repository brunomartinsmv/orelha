import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'orelha-quotes-'));
process.env.ORELHA_DATA_DIR = dir;
const { db } = await import('../server/db.js');
const { extractQuotes, dailyQuote } = await import('../server/quotations.js');
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const book = { id: 'one', title: 'O Livro', authors: ['Maria Autora'], status: 'reading' };
const page = (title, text) => ({ title, text });

test('página da obra exige autor e preserva texto e fonte', () => {
  const source = page('O Livro', 'Um romance de [[Maria Autora]].\n* “Uma [[vida]] entre páginas.”\n:- Capítulo II\n== Ver também ==\n* [[Mitologia grega]]');
  const quotes = extractQuotes(source, book);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].text, 'Uma vida entre páginas.');
  assert.equal(quotes[0].source.url, 'https://pt.wikiquote.org/wiki/O_Livro');
  assert.deepEqual(extractQuotes(page('O Livro', 'De Outra Autora.\n* "Uma frase do livro errado."'), book), []);
});

test('página do autor exige seção ou referência explícita à obra, sem confundir títulos parciais', () => {
  const source = page('Maria Autora', `Biografia.
* "Uma frase solta sem obra."
* "Uma frase com referência."
::- ''O Livro'', p. 10
* "Uma frase de outra obra."
::- O Livro Perdido, p. 12
== O Livro (2001) ==
* "Uma frase da seção correta."
=== Capítulo I ===
* "Uma frase na subseção correta."
== Outro Livro ==
* "Uma frase da seção errada."`);
  assert.deepEqual(extractQuotes(source, book).map((q) => q.text), [
    'Uma frase com referência.', 'Uma frase da seção correta.', 'Uma frase na subseção correta.',
  ]);
});

test('exclui frases atribuídas, comentários sobre a obra e sintaxe não resolvida', () => {
  const source = page('Maria Autora', `== Atribuídas ==
=== O Livro ===
* "Uma citação sem confirmação."
== Sobre O Livro ==
* "Uma resenha sobre o livro."
== O Livro ==
* "Uma {{predefinição}} pendente."
* "Uma frase muito longa ${'palavra '.repeat(60)}."
* "Uma frase aceitável." - O Livro, p. 30
* "Uma frase aceitável."
== Ver também ==
* [[Mitologia grega]]`);
  assert.deepEqual(extractQuotes(source, book).map((q) => q.text), ['Uma frase aceitável.']);
});

function wikiFetch(pages, requests) {
  return async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ query: { pages: url.searchParams.get('titles').split('|').map((title) => {
      const text = pages[title];
      return text ? { title, revisions: [{ slots: { main: { content: text } } }] } : { title, missing: true };
    }) } }) };
  };
}

const now = Date.UTC(2026, 10, 8);
test('busca em lote, prioriza leitura atual e mantém o dia com cache sem rede', async () => {
  const requests = [];
  const other = { ...book, id: 'two', title: 'Livro Concluído', status: 'read' };
  const fetchImpl = wikiFetch({
    'O Livro': 'Um livro de Maria Autora.\n* "Uma citação da leitura atual."\n* "Outra citação da leitura atual."',
    'Livro Concluído': 'Um livro de Maria Autora.\n* "Uma citação da leitura concluída."',
  }, requests);
  const quote = await dailyQuote([book, other], { now, fetchImpl });
  assert.equal(quote.book.id, book.id);
  assert.equal(requests.length, 1);
  const again = await dailyQuote([book, other], { now, fetchImpl: () => assert.fail('não deve acessar a rede') });
  assert.deepEqual(again, quote);
  const tomorrow = await dailyQuote([book, other], { now: now + 86_400_000, fetchImpl });
  assert.notEqual(tomorrow.text, quote.text);
  assert.equal(requests.length, 1);
});

test('sem citação atual usa livro lido, não reutiliza trechos manuais nem inventa frase', async () => {
  const requests = [];
  const unknown = { ...book, title: 'Livro Sem Página', authors: ['Autora Sem Página'] };
  const read = { ...book, title: 'Livro Concluído', status: 'read' };
  const fetchImpl = wikiFetch({}, requests);
  assert.equal((await dailyQuote([unknown, read], { now, fetchImpl })).book.title, read.title);
  assert.equal(await dailyQuote([unknown], { now, fetchImpl }), null);
  assert.equal(await dailyQuote([], { now, fetchImpl }), null);
  assert.equal(requests.length, 1);
});

test('resolve redirects e mantém cache vencido se a fonte falhar', async () => {
  const redirected = { ...book, title: 'A Obra', authors: ['Outra Autora'] };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ query: {
    redirects: [{ from: 'A Obra', to: 'A obra' }],
    pages: [{ title: 'A obra', revisions: [{ slots: { main: { content: 'De Outra Autora.\n* "Uma frase da página canônica."' } } }] }, { title: 'Outra Autora', missing: true }],
  } }) });
  const quote = await dailyQuote([redirected], { now, fetchImpl });
  assert.ok(quote.source.url.endsWith('A_obra'));
  const stale = await dailyQuote([redirected], { now: now + 31 * 86_400_000, fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(stale, quote);
});
