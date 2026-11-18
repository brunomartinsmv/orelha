import { html } from '/vendor/htm-preact.js';
import { useFetch } from '../lib.js';
import { PageHeader, Rail, RailSkeleton } from '../ui.js';

export function DiscoverView() {
  const { data, error, loading } = useFetch('/discover');
  const rails = data?.rails || [];
  return html`<main class="page">
    <${PageHeader} title="Descobrir" sub="O que combina com o que você leu, e o que anda circulando." />
    ${!data && loading && html`<${RailSkeleton} title="Prosa brasileira" /><${RailSkeleton} title="Em alta no mundo" />`}
    ${rails.map((rail) => html`<${Rail} key=${rail.title} title=${rail.title} books=${rail.books} />`)}
    ${(error || (data && !rails.length)) && !rails.length && html`<p class="muted" style="margin-top:30px;font-size:14px">As sugestões voltam quando a Open Library responder. O seu diário funciona normalmente.</p>`}
  </main>`;
}
