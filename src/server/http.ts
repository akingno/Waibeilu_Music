import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Busboy from 'busboy';
import type { AppConfig } from './config.js';
import { AuthService } from './auth.js';
import { MusicApplication } from './application.js';
import { MusicStorage } from './storage.js';
import { RoomGateway } from './realtime.js';
import { AppError } from '../shared/protocol.js';
import { audioContentType } from './media.js';
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) throw new AppError('RANGE', 'Range not satisfiable', 416);
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] ? (m[2] ? Math.min(Number(m[2]), size - 1) : size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    start > end ||
    start < 0
  )
    throw new AppError('RANGE', 'Range not satisfiable', 416);
  return { start, end };
}
async function body(req: IncomingMessage, limit = 8192): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > limit) throw new AppError('TOO_LARGE', '请求内容过大', 413);
  }
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new AppError('INVALID_INPUT', '请求格式无效');
  }
}
export function createHandler(
  config: AppConfig,
  auth: AuthService,
  app: MusicApplication,
  storage: MusicStorage,
  gateway: RoomGateway,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(data));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url || '/', config.origin),
        path = url.pathname,
        method = req.method || 'GET';
      if (method === 'GET' && path === '/healthz') {
        json({ ok: true });
        return;
      }
      if (path === '/api/login' && method === 'POST') {
        auth.validateOrigin(req.headers.origin);
        const b = await body(req);
        if (typeof b.password !== 'string' || b.password.length > 200)
          throw new AppError('INVALID_INPUT', '密码格式无效');
        // Nginx overwrites X-Real-IP; the application only listens on loopback by default.
        const ip =
          req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1'
            ? String(req.headers['x-real-ip'] || req.socket.remoteAddress)
            : req.socket.remoteAddress || 'unknown';
        const result = auth.login(b.password, ip);
        res.setHeader('Set-Cookie', result.cookie);
        json({ session: result.session, csrfToken: result.session.csrf });
        return;
      }
      if (path.startsWith('/api/')) {
        const session = auth.authenticate(req.headers.cookie);
        if (!['GET', 'HEAD'].includes(method)) {
          auth.validateOrigin(req.headers.origin);
          auth.validateCsrf(session, req.headers['x-csrf-token'] as string);
        }
        if (path === '/api/session' && method === 'GET') {
          json({ session, csrfToken: session.csrf });
          return;
        }
        if (path === '/api/session' && method === 'PATCH') {
          const b = await body(req);
          if (typeof b.nickname !== 'string') throw new AppError('INVALID_INPUT', '昵称无效');
          const updated = auth.updateNickname(session, b.nickname);
          app.seats.rename(session.id, updated.nickname);
          gateway.broadcast();
          json({ session: updated });
          return;
        }
        if (path === '/api/logout' && method === 'POST') {
          auth.logout(session.id);
          app.seats.release(session.id);
          gateway.closeSession(session.id);
          await app.tick();
          res.setHeader('Set-Cookie', auth.cookie('', true));
          json({ ok: true });
          return;
        }
        if (path === '/api/tracks' && method === 'GET') {
          json({ tracks: app.tracks() });
          return;
        }
        if (path === '/api/playlists' && method === 'GET') {
          json({ playlists: app.database.playlists() });
          return;
        }
        if (path === '/api/playlists' && method === 'POST') {
          const b = await body(req);
          const playlist = await app.createPlaylist(b.name, session);
          gateway.notify('libraryChanged');
          json({ playlist }, 201);
          return;
        }
        const playlistMatch = /^\/api\/playlists\/([a-f0-9-]+)(\/tracks)?$/.exec(path);
        if (playlistMatch && method === 'PATCH' && !playlistMatch[2]) {
          const b = await body(req);
          const playlist = await app.renamePlaylist(playlistMatch[1], b.name);
          gateway.notify('libraryChanged');
          json({ playlist });
          return;
        }
        if (playlistMatch && method === 'POST' && playlistMatch[2]) {
          const b = await body(req, 128 * 1024);
          const playlist = await app.changePlaylistTracks(
            playlistMatch[1],
            b.operation,
            b.trackIds,
          );
          gateway.notify('libraryChanged');
          json({ playlist });
          return;
        }
        if (path === '/api/storage' && method === 'GET') {
          json(storage.usage());
          return;
        }
        if (path === '/api/room' && method === 'GET') {
          json({ state: app.room.getState(), presence: app.seats.presence() });
          return;
        }
        if (path === '/api/tracks' && method === 'POST') {
          const declared = Number(req.headers['x-file-size']);
          if (!Number.isSafeInteger(declared) || declared < 1 || declared > config.maxFileBytes)
            throw new AppError('FILE_TOO_LARGE', '单首音乐最多 50 MB', 413);
          const track = await new Promise<Awaited<ReturnType<MusicStorage['upload']>>>(
            (resolve, reject) => {
              let upload: Promise<Awaited<ReturnType<MusicStorage['upload']>>> | undefined,
                invalid = false;
              const bb = Busboy({
                headers: req.headers,
                defParamCharset: 'utf8',
                limits: { files: 1, fields: 0, fileSize: config.maxFileBytes + 1, parts: 1 },
              });
              const fail = (e: Error) => {
                invalid = true;
                reject(e);
              };
              bb.on('file', (_field, stream, info) => {
                stream.on('limit', () => {
                  invalid = true;
                });
                upload = storage.upload(stream, info.filename || '', declared);
                // Attach rejection immediately while multipart parser is still receiving bytes.
                upload.catch((error) => {
                  stream.resume();
                  fail(error);
                });
              });
              bb.on('filesLimit', () =>
                fail(new AppError('INVALID_INPUT', '每次只能上传一首音乐')),
              );
              bb.on('fieldsLimit', () => fail(new AppError('INVALID_INPUT', '不接受额外表单字段')));
              bb.on('error', fail);
              req.on('aborted', () => bb.destroy(new Error('Upload disconnected')));
              bb.on('close', () => {
                if (!upload) reject(new AppError('INVALID_INPUT', '请选择 MP3 或 Ogg 文件'));
                else
                  upload.then(
                    (track) =>
                      invalid
                        ? reject(new AppError('INCOMPLETE_UPLOAD', '上传未完成'))
                        : resolve(track),
                    reject,
                  );
              });
              req.pipe(bb);
            },
          );
          gateway.notify('libraryChanged');
          json(
            {
              track: {
                id: track.id,
                title: track.title,
                artist: track.artist,
                durationSeconds: track.durationSeconds,
              },
            },
            201,
          );
          return;
        }
        const audio = /^\/api\/tracks\/([a-f0-9-]+)\/audio$/.exec(path);
        if (audio && ['GET', 'HEAD'].includes(method)) {
          app.seats.requireLease(session.id);
          const track = app.database.track(audio[1]);
          if (!track || track.status !== 'ready')
            throw new AppError('TRACK_NOT_FOUND', '歌曲已删除', 404);
          const file = storage.path(track.storageKey),
            size = (await stat(file)).size;
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Cache-Control', 'private, no-store');
          let range;
          try {
            range = parseRange(req.headers.range, size);
          } catch (e) {
            res.setHeader('Content-Range', `bytes */${size}`);
            throw e;
          }
          res.statusCode = range ? 206 : 200;
          res.setHeader('Content-Type', audioContentType(track.storageKey));
          res.setHeader('Content-Length', range ? range.end - range.start + 1 : size);
          if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
          if (method === 'HEAD') {
            res.end();
            return;
          }
          const stream = createReadStream(file, range || {});
          stream.on('error', () => res.destroy());
          res.on('close', () => stream.destroy());
          stream.pipe(res);
          return;
        }
        const trackMatch = /^\/api\/tracks\/([a-f0-9-]+)$/.exec(path);
        if (trackMatch && method === 'DELETE') {
          await app.deleteTrack(trackMatch[1]);
          gateway.notify('libraryChanged');
          void storage.cleanup().catch(console.error);
          json({ ok: true });
          return;
        }
        throw new AppError('NOT_FOUND', '接口不存在', 404);
      }
      const allowed: Record<string, string> = {
        '/': 'index.html',
        '/app.js': 'app.js',
        '/theme.js': 'theme.js',
        '/styles/tokens.css': 'styles/tokens.css',
        '/styles/layout.css': 'styles/layout.css',
        '/styles/components.css': 'styles/components.css',
        '/styles/themes.css': 'styles/themes.css',
      };
      if (!['GET', 'HEAD'].includes(method) || !allowed[path])
        throw new AppError('NOT_FOUND', '页面不存在', 404);
      const file = join(config.publicDirectory, allowed[path]),
        size = (await stat(file)).size;
      res.setHeader(
        'Content-Type',
        path.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : path.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : 'text/html; charset=utf-8',
      );
      res.setHeader('Content-Length', size);
      res.setHeader('Cache-Control', 'no-cache');
      if (method === 'HEAD') res.end();
      else {
        const stream = createReadStream(file);
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      }
    } catch (e) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      const error =
        e instanceof AppError
          ? e
          : new AppError('INTERNAL_ERROR', '服务器暂时无法处理，请重试', 500);
      if (!(e instanceof AppError)) console.error('HTTP error', e);
      json({ code: error.code, message: error.message }, error.status);
    }
  };
}
