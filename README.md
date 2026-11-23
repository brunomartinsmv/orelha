# <img src="public/icons/icon.svg" width="32" height="32" alt="" align="top"> Orelha

**Um lugar quieto para os seus livros.**

O Orelha é um diário de leitura pessoal e uma estante virtual auto-hospedada — sem rede social, sem anúncios e sem depender de nuvem de terceiros. Roda no seu próprio computador com **Node.js 24+**, **zero dependências externas** e **nenhuma etapa de build**, e acompanha você no celular pela sua rede privada [Tailscale](https://tailscale.com), funcionando como PWA mesmo quando o computador está dormindo.

![Demonstração do Orelha: leitura atual na tela inicial, estante de lombadas 3D, abertura do livro, ordenação por cor, modo escuro e retrospectiva](docs/demo.webp)


| Página do livro (modo escuro) | No celular (PWA para iOS e Android) |
| :---: | :---: |
| ![Página de Torto Arado no modo escuro](docs/livro.png) | <img src="docs/mobile-estante.png" width="48%" alt="Estante de lombadas no celular"> <img src="docs/mobile-voce.png" width="48%" alt="Perfil e 4 livros favoritos no celular"> |

---

## Por que o Orelha?

A maioria dos apps de leitura disputa sua atenção com feed, ranking social e anúncios — e guarda anos da sua história literária num banco que não é seu. O Orelha vai na direção oposta: trata seus livros como objetos físicos numa estante particular, com banco SQLite local, interface silenciosa e portabilidade completa.

### Estante e diário

- **Estante física de lombadas:** cada livro ganha uma lombada proporcional ao número de páginas, cor extraída automaticamente da capa e tipografia escolhida pelo gênero literário. Ordene por nota, recentes, autor, título, páginas ou **por cor** — e clique na lombada para puxar o livro da prateleira em 3D e abrir suas anotações ao lado.
- **Diário completo, do seu jeito:** notas de meia em meia estrela (½ a 5), datas de início e término, formato (`papel`, `e-book`, `áudio`), marcação de releituras e abandonos, resenhas com ocultação opcional de spoilers e edição livre de ISBN, sinopse e gêneros (preservada contra sobrescritas externas).
- **Coleções e sublinhados:** destaque seus **4 livros favoritos**, organize listas comuns ou ranqueadas e mantenha um caderno de trechos com o número da página.

### Leitura viva, números e descoberta

- **Uma tela inicial que respira:** o livro em leitura aparece em 3D com barra de progresso por página, acompanhado da sua meta anual e de uma epígrafe diária garimpada no [Wikiquote em português](https://pt.wikiquote.org). Sem nenhum livro aberto, sua fila de *Quero ler* assume o lugar.
- **Números da leitura e Retrospectiva:** acompanhe livros e páginas por mês ou por ano, distribuição de notas, gêneros, formatos, décadas de publicação, autores mais lidos, extremos de tamanho e **A pilha** (a altura física equivalente em papel). Para qualquer ano fechado ou em curso, abra o modo **Retrospectiva** (*"Seu ano em livros"*).
- **Recomendações locais:** descoberta em português baseada no seu histórico via [Open Library](https://openlibrary.org), com fallback na [BrasilAPI](https://brasilapi.com.br) para ISBNs brasileiros.

### Seu, portátil e pronto para ficar offline

- **Traga sua estante de onde estiver:** importação idempotente de CSV do **Skoob**, **Goodreads**, **StoryGraph** e do próprio Orelha (com busca gradual de capas em segundo plano), além de exportação completa em CSV ou JSON e restauração de backups JSON pela interface.
- **PWA com fila offline real:** instalável na Tela de Início do iOS e Android, com tema claro/escuro automático ou manual, cache via Service Worker e fila local em IndexedDB. Atualize a página atual, guarde um trecho ou mude o status de um livro mesmo com o servidor desligado — tudo sincroniza em ordem quando ele voltar.

---

## Requisitos

- **Node.js 24 ou superior** — usa o módulo nativo `node:sqlite`. Não há `node_modules` nem `npm install`.
- *(Opcional)* **Tailscale** no computador servidor (macOS ou Linux) e nos aparelhos clientes, para acesso remoto em HTTPS restrito à sua tailnet.

---

## Primeiros passos

Clone o repositório e suba o servidor local:

```sh
git clone https://github.com/brunomartinsmv/orelha.git
cd orelha

npm start        # abre em http://localhost:4173
```

Quer testar a estante cheia antes de cadastrar seus livros?

```sh
npm run demo     # popula a estante com livros, resenhas e trechos de exemplo
```

Os dados de exemplo são marcados separadamente e podem ser limpos em um clique pelo botão **"Começar do zero"**, sem tocar no que você registrou.

Outros comandos úteis:

```sh
npm run dev      # inicia com recarregamento automático (node --watch)
npm test         # executa a suíte de testes automatizados (node:test)
```

---

## Acesso pela Tailnet

O servidor HTTP escuta **exclusivamente em `127.0.0.1`**. Para abrir o Orelha do celular sem expor nada à internet pública, o projeto usa o `tailscale serve` com HTTPS somado a uma lista explícita de aparelhos autorizados.

O Orelha roda em **um único computador** (o servidor), que guarda o único banco de dados. Os outros aparelhos (celular, tablet, outro notebook) são apenas clientes: acessam o endereço da tailnet no navegador ou como PWA, sem instalar nada. Subir o servidor em duas máquinas criaria dois bancos separados, sem sincronização entre eles.

> **Já tem o Orelha rodando nesse computador?** Não clone de novo: seus dados ficam em `data/` dentro da instalação atual, e um clone novo começa vazio. Entre na pasta existente e rode `scripts/servico-linux.sh atualizar` (ou `scripts/servico.sh atualizar` no macOS). O comando `instalar` recusa continuar quando detecta esse caso.

1. No computador que vai servir, faça um clone fixo (por exemplo `~/orelha` — evite worktrees, pois `data/` fica dentro da pasta) e crie a configuração a partir do modelo:

   ```sh
   cp config.example.json config.json
   ```

2. Edite o `config.json` com o domínio da máquina servidora na tailnet e os IPs Tailscale (IPv4 e/ou IPv6) de cada aparelho autorizado, incluindo outros computadores que vão abrir o Orelha. Você pode consultá-los com `tailscale status --json`:

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

3. Instale o serviço em segundo plano. Os scripts de macOS e Linux oferecem exatamente os mesmos comandos:

   | Comando | O que faz |
   | --- | --- |
   | `verificar` | confere Node 24+, Tailscale, `config.json` e testes, sem alterar nada |
   | `instalar` | verifica, registra o serviço, espera o servidor responder e ativa HTTPS na `publicPort` |
   | `atualizar` | testa a versão nova numa cópia isolada, faz backup, avança o branch e reinicia; se não subir, volta para a anterior |
   | `backup` | copia o banco e as capas enviadas para fora do projeto (o `instalar` já ativa um backup diário) |
   | `reiniciar` | reinicia e confere se o servidor voltou a responder |
   | `status` | mostra estado do processo, versão no ar e configuração do `tailscale serve` |
   | `logs` | acompanha o log do servidor |
   | `remover` | desativa o serviço preservando todos os dados em `data/` |

   **macOS** (LaunchAgent, log em `data/orelha.log`):

   ```sh
   scripts/servico.sh instalar
   ```

   **Linux** (serviço de usuário do systemd, log no `journalctl`):

   ```sh
   sudo tailscale set --operator=$USER   # uma vez: permite configurar o tailscale serve sem sudo
   scripts/servico-linux.sh instalar     # também ativa o linger, para o Orelha subir no boot sem login
   ```

   Num notebook servindo o Orelha, impeça que ele suspenda ao fechar a tampa: em `/etc/systemd/logind.conf`, defina `HandleLidSwitch=ignore` e `HandleLidSwitchExternalPower=ignore`, e depois rode `sudo systemctl restart systemd-logind`.

4. Abra `https://<tailnetHost>:<publicPort>` no Safari do iPhone (ou Chrome no Android) e use **Compartilhar → Adicionar à Tela de Início** para usá-lo como aplicativo nativo.

### Atualizando e lançando versões

Para levar uma versão nova ao computador que serve o Orelha:

```sh
scripts/servico.sh atualizar        # macOS
scripts/servico-linux.sh atualizar  # Linux
```

Para lançar uma versão:

1. Mova as entradas de **[Não publicado]** no [CHANGELOG.md](CHANGELOG.md) para uma nova seção com número e data.
2. Atualize `version` no `package.json` — é a única fonte da versão (o `User-Agent` e o `/api/health` a leem dali).
3. Se a lista de arquivos do app mudou, ajuste `SHELL_FILES` e suba `VERSION` em `public/sw.js`.
4. Faça o commit, crie a tag anotada (`git tag -a v1.2.3 -m v1.2.3`) e envie com `git push --follow-tags` (tags leves, sem `-a`, não acompanham).

---

## Segurança, backups e privacidade

- **Acesso restrito por aparelho:** requisições vindas do `tailscale serve` trazem o IP real do cliente no final de `X-Forwarded-For`; dispositivos fora de `allowedDevices`, `Host` desconhecidos (proteção contra *DNS rebinding*) ou escritas de outras origens recebem `403 Forbidden`.
- **Backups automáticos (e espelho na nuvem, se quiser):** ficam em `~/.local/share/orelha/backups` no Linux e em `~/Library/Application Support/Orelha/backups` no macOS (ou em `ORELHA_BACKUP_DIR`). Para manter uma cópia fora do computador, configure um remoto no [rclone](https://rclone.org) (ex.: Google Drive com `scope = drive.file`) e adicione `"backupRemoto": "gdrive:Orelha/backups"` no `config.json`: cada backup diário espelha a pasta lá.
- **Seus dados ficam com você:** o banco reside em `data/orelha.sqlite` e as capas em `data/covers/` (ambos ignorados pelo Git).
- **Consultas externas mínimas:** metadados e capas vêm da **Open Library** (e da **BrasilAPI** para ISBNs nacionais ausentes lá), sempre cacheados localmente. A epígrafe da página inicial consulta apenas títulos e nomes de autores no **Wikiquote em português** (cache de 30 dias). Suas notas, resenhas, datas e trechos pessoais nunca saem da sua máquina.

---

## Estrutura do projeto

```text
├── CHANGELOG.md                 # Histórico de versões (Keep a Changelog)
├── config.example.json          # Modelo de configuração de portas e IPs da tailnet
├── server/
│   ├── index.js                 # Ponto de entrada (escuta apenas em 127.0.0.1)
│   ├── version.js               # Versão lida do package.json (User-Agent e /api/health)
│   ├── app.js                   # Roteador HTTP, controle de acesso, upload e cache de capas
│   ├── db.js                    # Esquema SQLite nativo (node:sqlite) e transações
│   ├── library.js               # Regras de domínio: estante, diário, listas, metas e estatísticas
│   ├── openlibrary.js           # Busca e normalização de catálogo (Open Library + BrasilAPI)
│   ├── recommend.js             # Motor local de recomendações por perfil de leitura
│   ├── quotations.js            # Extração e cache diário de citações do Wikiquote
│   └── importers.js             # Importação (Skoob, Goodreads, StoryGraph, Orelha CSV/JSON) e enriquecimento
├── public/
│   ├── index.html               # Shell da aplicação PWA
│   ├── styles.css               # Sistema visual, temas claro/escuro, livros 3D e estante
│   ├── sw.js                    # Service Worker para cache e uso offline
│   └── app/                     # Interface em Preact + htm (ES Modules nativos, sem bundler)
│       └── sync.js              # Fila local em IndexedDB e sincronização offline idempotente
├── scripts/
│   ├── seed-demo.js             # Popula dados de demonstração
│   ├── backup.js                # Backup íntegro do SQLite + capas e espelhamento via rclone
│   ├── import-home-catalogue.js # Utilitário de importação de catálogo JSON em lote
│   ├── servico.sh               # Implantação no macOS: LaunchAgent, tailscale serve, atualização
│   └── servico-linux.sh         # Implantação no Linux: systemd de usuário, tailscale serve, atualização
├── site/                        # Landing page estática publicada no GitHub Pages
└── test/                        # Testes automatizados com node:test
```
