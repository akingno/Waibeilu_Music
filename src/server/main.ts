import { createServer as createHttpServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from './config.js';
import { Database } from './persistence.js';
import { AuthService } from './auth.js';
import { SeatRegistry } from './seats.js';
import { RoomService } from './playback.js';
import { MusicApplication } from './application.js';
import { MusicStorage } from './storage.js';
import { RoomGateway } from './realtime.js';
import { createHandler } from './http.js';
export async function createServer(config: AppConfig) {
  await mkdir(config.dataDirectory, { recursive: true });
  const database = new Database(join(config.dataDirectory, 'music.sqlite'));
  const auth = new AuthService(config, database),
    seats = new SeatRegistry();
  const server = createHttpServer();
  const gateway = new RoomGateway(server, auth, seats);
  const storage = new MusicStorage(database, config, () => gateway.notify('storageChanged'));
  await storage.initialize();
  const room = new RoomService(database),
    app = new MusicApplication(database, room, seats, () => gateway.broadcast());
  gateway.bind(app);
  server.on('request', createHandler(config, auth, app, storage, gateway));
  server.requestTimeout = 190000;
  server.headersTimeout = 15000;
  const timers: NodeJS.Timeout[] = [];
  return {
    server,
    app,
    storage,
    database,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      timers.push(
        setInterval(() => {
          void app.tick().catch(console.error);
        }, 1000),
      );
      timers.push(setInterval(() => gateway.heartbeat(), 10000));
      timers.push(
        setInterval(() => {
          try {
            room.save();
            auth.cleanup();
          } catch (e) {
            console.error(e);
          }
        }, 10000),
      );
      timers.push(
        setInterval(() => {
          void storage.cleanup().catch(console.error);
        }, 30000),
      );
      console.log(`同听房已启动：${config.origin}`);
    },
    async stop() {
      timers.forEach(clearInterval);
      gateway.close();
      room.save();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      database.close();
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = await createServer(loadConfig());
  await runtime.start();
  let stopping = false;
  const stop = () => {
    if (!stopping) {
      stopping = true;
      void runtime.stop().then(() => process.exit(0));
    }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
