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
- `/api/health` passa a informar a versão e o pid em execução.
- `scripts/backup.js` e o comando `backup` dos dois scripts: copiam o banco (pela API de backup do SQLite, com o servidor rodando) e as capas enviadas para fora da pasta do projeto, conferem a integridade da cópia e guardam as últimas 30. `instalar` liga um backup diário (timer do systemd no Linux, LaunchAgent às 4h no macOS).

### Modificado

- `scripts/servico.sh instalar` roda as verificações antes de instalar, valida o plist gerado e só publica no `tailscale serve` depois que o servidor responde com a versão do disco.
- O script encontra a CLI do Tailscale dentro do app da Mac App Store quando ela não está no `PATH`.
- A instalação a partir de um worktree do Git é bloqueada, pois `data/` sumiria junto com o worktree (`ORELHA_PERMITIR_WORKTREE=1` libera).
- O LaunchAgent espera 10 s entre reinícios após falha e roda com prioridade de segundo plano.
- `atualizar` testa a versão nova num worktree temporário antes de mexer no checkout em uso, faz backup do banco e, se a versão nova não subir, volta para a anterior.
- `instalar` gera e valida a unit ou o plist numa pasta à parte antes de trocar os atuais, e volta os anteriores se o serviço novo não subir. Caminhos com `&`, `<` ou `>` não quebram mais o plist.
- O teste de saúde confere pelo pid que quem responde é o processo do serviço. `instalar` recusa seguir se outro processo ocupa a porta, ou se o serviço atual roda de outra pasta que tem o banco e este clone não tem (`ORELHA_BANCO_NOVO=1` libera).
- O serviço roda com `UMask=0077` e, no Linux, com `NoNewPrivileges`, filtro de chamadas de sistema e famílias de socket restritas. `instalar` deixa `data/` em `700` e o banco em `600`.
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
