import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createEngine } from './engine.js';

/**
 * Process entry point.
 *
 * Boots the engine before the HTTP listener so a store that cannot open
 * causes a hard, immediate failure rather than a server that accepts traffic
 * and then 500s on every request.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const engine = await createEngine(config);
  const app = await buildApp(engine, config);

  let maintenanceTimer: NodeJS.Timeout | undefined;
  if (config.maintenanceIntervalMs > 0) {
    maintenanceTimer = setInterval(() => {
      void (async () => {
        try {
          for (const namespace of await engine.namespaces()) {
            await engine.consolidate(namespace);
            await engine.maintain(namespace);
          }
        } catch (error) {
          app.log.error({ err: error }, 'Scheduled maintenance failed');
        }
      })();
    }, config.maintenanceIntervalMs);
    maintenanceTimer.unref();
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    try {
      // Close the listener first so no request is cut off mid-flight, then
      // flush the store.
      await app.close();
      await engine.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { store: config.store, embedder: engine.embedder.id },
    `Mnemos listening on http://${config.host}:${config.port}`,
  );
}

main().catch((error) => {
  console.error('Failed to start Mnemos:', error);
  process.exit(1);
});
