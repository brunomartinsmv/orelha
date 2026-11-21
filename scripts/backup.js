// Cópia consistente do banco e das capas enviadas, fora da pasta do projeto.
// Uso: node scripts/backup.js [pasta-de-destino]   (padrão: ORELHA_BACKUP_DIR ou a pasta de dados do usuário)
// Guarda as últimas ORELHA_BACKUP_MANTER cópias (padrão 30) e confere cada uma antes de apagar as antigas.
// Com "backupRemoto" no config.json (ou ORELHA_BACKUP_REMOTO), espelha a pasta num remoto do rclone, ex. "gdrive:Orelha/backups".
import { backup, DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = process.env.ORELHA_DATA_DIR || join(import.meta.dirname, '..', 'data');
const padrao = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'Orelha', 'backups')
  : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'orelha', 'backups');
const destino = process.argv[2] || process.env.ORELHA_BACKUP_DIR || padrao;
const manter = Number(process.env.ORELHA_BACKUP_MANTER) || 30;

const banco = join(DATA_DIR, 'orelha.sqlite');
if (!existsSync(banco)) {
  console.error(`✗ Banco não encontrado em ${banco}.`);
  process.exit(1);
}

process.umask(0o077);
mkdirSync(destino, { recursive: true, mode: 0o700 });
const nomeAgora = () => join(destino, `orelha-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`);
let final = nomeAgora();
// Dois backups no mesmo segundo (o do atualizar e o do timer, por exemplo) teriam o mesmo nome.
while (existsSync(final)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  final = nomeAgora();
}
const parcial = `${final}.parcial`;
// Sobras de um backup interrompido no meio.
for (const nome of readdirSync(destino)) {
  if (nome.endsWith('.parcial')) rmSync(join(destino, nome), { recursive: true, force: true });
}
mkdirSync(join(parcial, 'covers'), { recursive: true });

// A API de backup do SQLite copia com o servidor rodando, sem pegar o banco no meio de uma escrita.
const origem = new DatabaseSync(banco, { readOnly: true });
await backup(origem, join(parcial, 'orelha.sqlite'));
origem.close();

const copia = new DatabaseSync(join(parcial, 'orelha.sqlite'), { readOnly: true });
const integridade = copia.prepare('PRAGMA integrity_check').get();
const livros = copia.prepare('SELECT count(*) AS n FROM books').get().n;
copia.close();
if (Object.values(integridade)[0] !== 'ok') {
  console.error(`✗ A cópia saiu corrompida; nada foi apagado. Veja ${parcial}.`);
  process.exit(1);
}

// Capas baixadas da Open Library voltam sozinhas; as enviadas pelo usuário (up-*) não.
const capas = join(DATA_DIR, 'covers');
let enviadas = 0;
if (existsSync(capas)) {
  for (const nome of readdirSync(capas)) {
    if (!nome.startsWith('up-')) continue;
    copyFileSync(join(capas, nome), join(parcial, 'covers', nome));
    enviadas += 1;
  }
}
renameSync(parcial, final);

const antigas = readdirSync(destino).filter((n) => /^orelha-\d{8}-\d{6}$/.test(n)).sort().slice(0, -manter);
for (const nome of antigas) rmSync(join(destino, nome), { recursive: true, force: true });

console.log(`✓ Backup em ${final} (${livros} livros no banco, ${enviadas} capas enviadas)`);

const configPath = process.env.ORELHA_CONFIG || join(import.meta.dirname, '..', 'config.json');
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const remoto = process.env.ORELHA_BACKUP_REMOTO ?? config.backupRemoto;
if (remoto) {
  // sync replica a rotação local no remoto; --max-delete evita apagar tudo lá se a pasta local vier quase vazia por engano.
  const r = spawnSync('rclone', ['sync', destino, remoto, '--exclude', '*.parcial/**', '--max-delete', '5'], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error || r.status !== 0) {
    console.error(`✗ A cópia local está feita, mas o envio para ${remoto} falhou${r.error ? `: ${r.error.message}` : ` (rclone saiu com ${r.status})`}.`);
    process.exit(2);
  }
  console.log(`✓ Enviado para ${remoto}`);
}
