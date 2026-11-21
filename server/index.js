import { createApp } from './app.js';
import { createSessionStore } from './sessions.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const host = process.env.HOST || '127.0.0.1';
const store = createSessionStore();
const server = createApp({ store }).listen(port, host, () => {
  console.log(`Folion is running at http://${host}:${port}`);
  if (!process.env.GEMINI_API_KEY?.trim()) console.warn('GEMINI_API_KEY is missing. Add it to .env and restart to enable the assistant.');
});
const cleanup = setInterval(() => store.prune(), 60_000);
cleanup.unref();
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Choose another PORT in .env.` : 'Folion could not start its HTTP server.');
  process.exitCode = 1;
  clearInterval(cleanup);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(cleanup);
  server.close();
});
