# Changelog

Todas as mudanças relevantes deste projeto são registradas neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e o projeto adota o [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não publicado]

### Adicionado

- Este changelog.
- `scripts/servico.sh verificar`: confere Node 24+, Tailscale conectado, `config.json` preenchido e testes passando, sem mudar nada.
- `scripts/servico.sh atualizar`: puxa o branch atual (`git pull --ff-only`), roda as verificações e reinicia o serviço; recusa seguir com alterações não commitadas.
- `scripts/servico.sh reiniciar` e `scripts/servico.sh logs`.
- `scripts/servico-linux.sh`, com os mesmos comandos, para servir pelo Linux com um serviço de usuário do systemd: liga o linger para subir no boot sem login e exige que o usuário seja operador do Tailscale.
- `/api/health` passa a informar a versão em execução.

### Modificado

- `scripts/servico.sh instalar` roda as verificações antes de instalar, valida o plist gerado e só publica no `tailscale serve` depois que o servidor responde com a versão do disco.
- O script encontra a CLI do Tailscale dentro do app da Mac App Store quando ela não está no `PATH`.
- A instalação a partir de um worktree do Git é bloqueada, pois `data/` sumiria junto com o worktree (`ORELHA_PERMITIR_WORKTREE=1` libera).
- O LaunchAgent espera 10 s entre reinícios após falha e roda com prioridade de segundo plano.
- A versão do app vem só do `package.json`; o `User-Agent` enviado à Open Library, à BrasilAPI e ao Wikiquote acompanha.

## [1.0.0] - 2026-11-18

### Adicionado

- Estante de lombadas proporcionais ao número de páginas, com cor extraída da capa, tipografia por gênero e abertura do livro em 3D.
- Diário de leitura com notas de ½ a 5 estrelas, datas de início e término, formato (papel, e-book, áudio), releituras e resenhas com spoilers ocultáveis.
- Progresso por página, meta anual e fila de *Quero ler* na tela inicial.
- 4 livros favoritos, listas comuns e ranqueadas e caderno de trechos com número de página.
- Números da leitura por ano ou de todo o histórico, incluindo **A pilha**.
- Recomendações locais por perfil de leitura via Open Library, com BrasilAPI para ISBNs brasileiros.
- Epígrafe diária do Wikiquote em português, com cache de 30 dias.
- Importação idempotente de CSV do Goodreads e do StoryGraph e exportação em CSV ou JSON.
- PWA instalável com tema claro/escuro e leitura offline pelo Service Worker.
- Acesso pela tailnet com `tailscale serve`, lista de aparelhos permitidos e proteção contra DNS rebinding.
- Serviço em segundo plano no macOS via LaunchAgent (`scripts/servico.sh`).

[Não publicado]: https://github.com/brunomartinsmv/orelha/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/brunomartinsmv/orelha/releases/tag/v1.0.0
