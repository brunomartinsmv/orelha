# <img src="public/icons/icon.svg" width="32" height="32" alt="" align="top"> Orelha

Diário de leitura pessoal e estante virtual auto-hospedada. Roda localmente no seu computador (com zero dependências externas e sem etapa de build) e pode ser acessado com segurança pelos seus aparelhos na sua rede privada [Tailscale](https://tailscale.com), inclusive em modo offline somente leitura quando o computador está dormindo.

![Estante de lombadas do Orelha](docs/estante.png)

| Início (leitura atual e epígrafe) | Números da leitura e A pilha |
| :---: | :---: |
| ![Tela inicial com livro 3D e citação](docs/inicio.png) | ![Estatísticas e pilha física de livros no modo escuro](docs/numeros.png) |

| Página do livro (modo escuro) | Celular / PWA (iOS e Android) |
| :---: | :---: |
| ![Página de Torto Arado no modo escuro](docs/livro.png) | <img src="docs/mobile-estante.png" width="48%" alt="Estante no celular"> <img src="docs/mobile-voce.png" width="48%" alt="Perfil e 4 favoritos no celular"> |

---

## Funcionalidades

- **Estante física de lombadas:** gera lombadas proporcionais ao número de páginas, extrai automaticamente a cor dominante da capa, escolhe a tipografia pelo gênero literário e abre o livro com animação 3D ao retirá-lo da prateleira.
- **Diário de leitura completo:** notas de meia em meia estrela (½ a 5), datas de início e término, formato (`papel`, `e-book`, `áudio`), marcação de releitura e resenhas com ocultação opcional de spoilers.
- **Acompanhamento e metas:** barra de progresso por página nos livros em leitura, meta anual editável e fila de *Quero ler* sugerida direto na tela inicial quando nenhum livro está aberto.
- **Coleções e sublinhados:** seleção dos seus **4 livros favoritos**, listas personalizadas (comuns ou ranqueadas) e caderno de trechos guardados com número de página.
- **Números da leitura:** estatísticas por ano ou de todo o histórico, distribuição de notas, autores mais lidos, décadas de publicação, extremos de tamanho e **A pilha** (altura física equivalente em papel).
- **Descoberta e epígrafes:** recomendações em português baseadas no seu perfil de leitura via [Open Library](https://openlibrary.org) (com fallback na [BrasilAPI](https://brasilapi.com.br) para ISBNs brasileiros) e citações diárias vindas do [Wikiquote em português](https://pt.wikiquote.org).
- **Portabilidade total:** importação idempotente de históricos em CSV do **Goodreads** e do **StoryGraph** (com busca gradual de capas em segundo plano) e exportação completa em CSV ou JSON.
- **PWA e modo offline:** instalável na Tela de Início do iOS/Android, com tema claro/escuro automático ou manual e cache via Service Worker para consulta mesmo com o servidor desligado.

---

## Requisitos

- **Node.js 24 ou superior** (utiliza o módulo nativo `node:sqlite` — não há `node_modules` nem `npm install`).
- *(Opcional)* **Tailscale** no Mac e no celular para acesso remoto via HTTPS restrito à sua tailnet.

---

## Primeiros passos

Clone o repositório e inicie o servidor local:

```sh
git clone https://github.com/brunomartinsmv/orelha.git
cd orelha

npm start        # abre em http://localhost:4173
```

Comandos úteis durante o uso ou desenvolvimento:

```sh
npm run dev      # inicia com recarregamento automático (node --watch)
npm run demo     # popula a estante com livros e leituras de exemplo (reversível pelo botão "Começar do zero")
npm test         # executa a suíte de testes automatizados
```

---

## Acesso pela Tailnet (Mac + iPhone)

O servidor HTTP escuta **exclusivamente em `127.0.0.1`**. Para acessá-lo do celular sem expor nada à internet pública, o projeto usa o `tailscale serve` com HTTPS aliado a uma lista explícita de dispositivos permitidos.

1. Crie seu arquivo de configuração a partir do modelo:

   ```sh
   cp config.example.json config.json
   ```

2. Edite o `config.json` com o domínio da sua máquina na tailnet e os IPs Tailscale (IPv4 e/ou IPv6) de cada aparelho autorizado. Você pode consultá-los rodando `tailscale status --json`:

   ```json
   {
     "port": 4173,
     "publicPort": 8443,
     "tailnetHost": "seu-mac.tailnet-exemplo.ts.net",
     "allowedDevices": {
       "mac": ["100.64.0.10", "fd7a:115c:a1e0::10"],
       "iphone": ["100.64.0.11", "fd7a:115c:a1e0::11"]
     }
   }
   ```

3. No macOS, instale o serviço em segundo plano (`LaunchAgent` + publicação no `tailscale serve`). Faça isso a partir de um clone fixo (por exemplo `~/orelha`), não de um worktree: os dados ficam em `data/` dentro dele.

   ```sh
   scripts/servico.sh verificar  # confere Node 24+, Tailscale, config.json e testes, sem mudar nada
   scripts/servico.sh instalar   # verifica, registra o LaunchAgent, espera o servidor responder e ativa HTTPS na porta publicPort
   scripts/servico.sh status     # estado do processo, versão no ar e tailscale serve
   scripts/servico.sh logs       # acompanha data/orelha.log
   scripts/servico.sh remover    # desativa o serviço (seus dados em data/ são preservados)
   ```

4. Abra `https://<tailnetHost>:<publicPort>` no Safari do iPhone e use **Compartilhar → Adicionar à Tela de Início** para usá-lo como aplicativo nativo.

### Atualizando e lançando versões

Para levar uma nova versão ao Mac que serve o Orelha:

```sh
scripts/servico.sh atualizar  # git pull --ff-only, verificações, reinício e conferência da versão no ar
```

Para lançar uma versão:

1. Mova as entradas de **[Não publicado]** no [CHANGELOG.md](CHANGELOG.md) para uma nova seção com número e data.
2. Atualize `version` no `package.json`; é a única fonte da versão (o `User-Agent` e o `/api/health` a leem dali).
3. Se a lista de arquivos do app mudou, ajuste `SHELL_FILES` e suba `VERSION` em `public/sw.js`.
4. Faça o commit, crie a tag (`git tag v1.2.3`) e envie com `git push --follow-tags`.

### Modelo de segurança e funcionamento offline

- **Validação de origem e dispositivo:** requisições vindas do `tailscale serve` recebem o IP real do cliente no final de `X-Forwarded-For`; aparelhos fora de `allowedDevices`, `Host` desconhecidos (proteção contra *DNS rebinding*) ou escritas de outras origens recebem `403 Forbidden`.
- **Leitura com o computador dormindo:** o Service Worker mantém a interface e a última cópia das respostas da API e capas em cache. Se o computador estiver em repouso, o app abre normalmente no celular em modo somente leitura.

---

## Privacidade e fontes externas

- Todos os seus dados ficam localmente em `data/orelha.sqlite` e as capas baixadas ou enviadas ficam em `data/covers/` (ambos ignorados pelo Git).
- Metadados de busca e capas são consultados na **Open Library** e, para ISBNs nacionais ausentes lá, na **BrasilAPI**, sendo cacheados localmente.
- A epígrafe exibida na página inicial consulta apenas títulos e nomes de autores dos livros lidos/em leitura no **Wikiquote em português** (com cache de 30 dias). Suas resenhas, notas, datas e trechos pessoais nunca saem do seu computador.

---

## Estrutura do projeto

```text
├── CHANGELOG.md             # Histórico de versões (Keep a Changelog)
├── config.example.json      # Modelo de configuração de portas e IPs da tailnet
├── server/
│   ├── index.js             # Ponto de entrada (escuta apenas em 127.0.0.1)
│   ├── version.js           # Versão lida do package.json (User-Agent e /api/health)
│   ├── app.js               # Roteador HTTP, controle de acesso, upload e cache de capas
│   ├── db.js                # Esquema SQLite nativo (node:sqlite) e transações
│   ├── library.js           # Regras de domínio: estante, diário, listas, metas e estatísticas
│   ├── openlibrary.js       # Busca e normalização de catálogo (Open Library + BrasilAPI)
│   ├── recommend.js         # Motor local de recomendações por perfil de gosto
│   ├── quotations.js        # Extração e cache diário de citações do Wikiquote
│   └── importers.js         # Parser CSV (Goodreads/StoryGraph) e enriquecimento gradual
├── public/
│   ├── index.html           # Shell da aplicação PWA
│   ├── styles.css           # Sistema visual, temas claro/escuro, livros 3D e estante
│   ├── sw.js                # Service Worker para funcionamento offline
│   └── app/                 # Interface em Preact + htm (ES Modules nativos, sem bundler)
├── scripts/
│   ├── seed-demo.js         # Popula dados de demonstração
│   ├── import-home-catalogue.js # Utilitário de importação de catálogo JSON em lote
│   └── servico.sh           # Implantação no macOS: LaunchAgent, tailscale serve, atualização
└── test/                    # Testes automatizados com node:test
```
