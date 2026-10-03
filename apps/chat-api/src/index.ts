import { loadChatConfig } from './config.js';
import { createChatServer, shutdownChatServer } from './app.js';

async function main(): Promise<void> {
  const config = await loadChatConfig();
  const server = createChatServer(config);
  const listening = Promise.withResolvers<void>();
  const bindFailure = () => listening.reject(new Error('Listener unavailable'));
  server.once('error', bindFailure);
  server.listen(config.port, '127.0.0.1', listening.resolve);
  await listening.promise;
  server.off('error', bindFailure);
  server.on('error', () => { console.error('Chat API listener failed.'); void stop(); });
  console.info('Chat API ready on loopback.');
  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    const forced = setTimeout(() => process.exit(1), 5000);
    forced.unref();
    await shutdownChatServer(server);
    console.info('Chat API stopped.');
    // Keep the unref'ed deadline: an OS DNS lookup can outlive socket shutdown.
  }
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}

void main().catch(() => {
  console.error('Chat API startup failed; check private configuration and listener availability.');
  process.exitCode = 1;
});
