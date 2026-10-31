// Process entrypoint for `npm start`. Configuration comes only from the environment.
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const cfg = loadConfig(process.env);
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const app = createApp({
  assetRoot: cfg.assetRoot,
  host: cfg.host,
  port: cfg.port,
  publicOrigin: cfg.publicOrigin,
  allowedOrigins: cfg.allowedOrigins,
  charactersFile: cfg.charactersFile || null,
  trustProxy: process.env.TRUST_PROXY === '1',
  online: cfg.online === true,
  onlineClientRoot: cfg.onlineClientRoot,
  onlineRuntimeRoot: cfg.onlineRuntimeRoot,
  onlineUpstream: cfg.onlineUpstream,
  log,
});
const { port, host } = await app.listen();
log(`grand-v web-host listening on http://${host}:${port} (assets: ${cfg.assetRoot})`);

const stop = () => {
  app.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
