// Cópia consistente do banco e das capas enviadas, fora da pasta do projeto.
// Uso: node scripts/backup.js [pasta-de-destino]   (padrão: ORELHA_BACKUP_DIR ou a pasta de dados do usuário)
// Guarda as últimas ORELHA_BACKUP_MANTER cópias (padrão 30) e confere cada uma antes de apagar as antigas.
// Com "backupRemoto" no config.json (ou ORELHA_BACKUP_REMOTO), espelha a pasta num remoto do rclone, ex. "gdrive:Orelha/backups".
// ORELHA_BACKUP_REMOTO vazio pula o envio (o atualizar faz isso para não esperar a rede).
// ORELHA_RCLONE aponta o executável do rclone quando ele não está no PATH (os serviços instalados passam o caminho).
import { backup, DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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

// Um backup por vez na mesma pasta: sem isso, um segundo backup (manual, do atualizar ou do timer)
// apagaria o .parcial do primeiro achando que era sobra de um interrompido. A trava guarda o pid
// do dono e é tomada de volta se esse processo já morreu.
const trava = join(destino, '.trava');
const esperaMax = Date.now() + 30 * 60 * 1000;
const dorme = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const vivo = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
for (let avisado = false; ;) {
  try {
    writeFileSync(trava, String(process.pid), { flag: 'wx' });
    break;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  let dono = 0;
  try { dono = Number(readFileSync(trava, 'utf8')); } catch {}
  if (dono && !vivo(dono)) {
    rmSync(trava, { force: true });
    continue;
  }
  if (Date.now() > esperaMax) {
    console.error(`✗ Outro backup (pid ${dono}) segura ${trava} há mais de 30 minutos.`);
    process.exit(1);
  }
  if (!avisado) console.error(`! Outro backup está rodando (pid ${dono}); esperando ele terminar.`);
  avisado = true;
  dorme(1000);
}
process.on('exit', () => {
  try { if (readFileSync(trava, 'utf8') === String(process.pid)) unlinkSync(trava); } catch {}
});
const nomeAgora = () => join(destino, `orelha-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`);
let final = nomeAgora();
// Dois backups no mesmo segundo (o do atualizar e o do timer, por exemplo) teriam o mesmo nome.
while (existsSync(final)) {
  dorme(1000);
  final = nomeAgora();
}
const parcial = `${final}.parcial`;
// Com a trava, qualquer .parcial é sobra de um backup interrompido no meio.
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
  const r = spawnSync(process.env.ORELHA_RCLONE || 'rclone', ['sync', destino, remoto, '--exclude', '*.parcial/**', '--exclude', '.trava', '--max-delete', '5'], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error || r.status !== 0) {
    console.error(`✗ A cópia local está feita, mas o envio para ${remoto} falhou${r.error ? `: ${r.error.message}` : ` (rclone saiu com ${r.status})`}.`);
    process.exit(2);
  }
  console.log(`✓ Enviado para ${remoto}`);
}
