// Versão única do Orelha, lida do package.json: um lançamento só precisa mudar esse arquivo.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const VERSION = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;
export const USER_AGENT = `Orelha/${VERSION} (personal reading diary)`;
