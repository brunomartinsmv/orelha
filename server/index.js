import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { enrichImported } from './importers.js';

const configPath = process.env.ORELHA_CONFIG || join(import.meta.dirname, '..', 'config.json');
const config = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, 'utf8'))
  : { port: 4173, publicPort: 8443, tailnetHost: '', allowedDevices: {} };
config.port = Number(process.env.PORT) || config.port || 4173;

// Somente loopback: a única porta de entrada externa é o `tailscale serve`.
createApp(config).listen(config.port, '127.0.0.1', () => {
  console.log(`Orelha em http://localhost:${config.port}`);
  if (config.tailnetHost) console.log(`Na tailnet: https://${config.tailnetHost}:${config.publicPort}`);
  enrichImported();
});
