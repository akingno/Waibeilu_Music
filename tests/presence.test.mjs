import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createServer } from '../dist/server/main.js';

test('在线名单：关页释放席位、接管隔离、重连及失联心跳清理', { timeout: 35000 }, async () => {
  await mkdir('test-results', { recursive: true });
  const directory = await mkdtemp(resolve('test-results/presence-'));
  const config = {
    port: 0,
    host: '127.0.0.1',
    origin: 'http://127.0.0.1',
    password: 'presence-test-1234',
    secure: false,
    dataDirectory: directory,
    publicDirectory: resolve('dist/public'),
    limitBytes: 1000000000,
    maxFileBytes: 50000000,
  };
  const runtime = await createServer(config);
  const sockets = [];
  try {
    await runtime.start();
    config.origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const login = async (nickname) => {
      const response = await fetch(config.origin + '/api/login', {
        method: 'POST',
        headers: { Origin: config.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: config.password }),
      });
      assert.equal(response.status, 200);
      const data = await response.json();
      const cookie = response.headers.get('set-cookie').split(';')[0];
      const renamed = await fetch(config.origin + '/api/session', {
        method: 'PATCH',
        headers: {
          Origin: config.origin,
          Cookie: cookie,
          'Content-Type': 'application/json',
          'X-CSRF-Token': data.csrfToken,
        },
        body: JSON.stringify({ nickname }),
      });
      assert.equal(renamed.status, 200);
      return cookie;
    };
    const connect = async (cookie, autoPong = true) => {
      const socket = new WebSocket(config.origin.replace('http:', 'ws:') + '/ws', {
        autoPong,
        headers: { Cookie: cookie, Origin: config.origin },
      });
      sockets.push(socket);
      const messages = [];
      socket.on('message', (data) => messages.push(JSON.parse(data)));
      const wait = async (predicate, timeout = 2000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const index = messages.findIndex(predicate);
          if (index >= 0) return messages.splice(index, 1)[0];
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('Expected WebSocket event not received');
      };
      await wait((m) => m.type === 'hello');
      return {
        socket,
        wait,
        messages,
        send: (m) => socket.send(JSON.stringify(m)),
        async join(takeover = false) {
          socket.send(JSON.stringify({ type: 'join', requestId: 'join', takeover }));
          return wait((m) => m.type === 'joined' || m.type === 'error');
        },
      };
    };
    const close = async (client) => {
      const closed = new Promise((r) => client.socket.once('close', r));
      client.socket.close();
      await closed;
    };
    const observer = await connect(await login('观察者'));
    assert.equal((await observer.join()).type, 'joined');
    const cookie = await login('关页的朋友');
    let member = await connect(cookie);
    assert.equal((await member.join()).type, 'joined');
    await observer.wait((m) => m.presence?.activeCount === 2);
    observer.messages.length = 0;
    await close(member);
    const gone = await observer.wait((m) => m.presence?.activeCount === 1);
    assert.deepEqual(gone.presence.nicknames, ['观察者']);

    member = await connect(cookie);
    assert.equal((await member.join()).type, 'joined');
    const inactiveTab = await connect(cookie);
    assert.equal((await inactiveTab.join()).code, 'TAKEOVER_REQUIRED');
    await close(inactiveTab);
    assert.equal(runtime.app.seats.presence().activeCount, 2);
    const replacement = await connect(cookie);
    const oldClosed = new Promise((r) => member.socket.once('close', r));
    assert.equal((await replacement.join(true)).type, 'joined');
    await oldClosed;
    assert.equal(runtime.app.seats.presence().activeCount, 2);

    // A full room must admit a new person immediately after a tab closes.
    const third = await connect(await login('朋友三'));
    const fourth = await connect(await login('朋友四'));
    const fifth = await connect(await login('朋友五'));
    for (const client of [third, fourth, fifth]) assert.equal((await client.join()).type, 'joined');
    const sixth = await connect(await login('候补朋友'));
    assert.equal((await sixth.join()).code, 'ROOM_FULL');
    observer.messages.length = 0;
    await close(fifth);
    await observer.wait(
      (m) => m.presence?.activeCount === 4 && !m.presence.nicknames.includes('朋友五'),
    );
    assert.equal((await sixth.join()).type, 'joined');
    for (const client of [replacement, third, fourth, sixth]) await close(client);

    // Simulate a half-open connection: the socket stays open but ignores server pings.
    const silent = await connect(await login('失联朋友'), false);
    assert.equal((await silent.join()).type, 'joined');
    let pings = 0;
    silent.socket.on('ping', () => pings++);
    const started = Date.now();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Heartbeat failed to remove silent client')),
        23000,
      );
      silent.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    assert.ok(pings > 0);
    assert.ok(Date.now() - started < 23000);
    assert.equal(observer.socket.readyState, WebSocket.OPEN);
    const deadline = Date.now() + 2000;
    while (runtime.app.seats.presence().activeCount !== 1 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(runtime.app.seats.presence().nicknames, ['观察者']);
    await close(observer);
    const emptyDeadline = Date.now() + 2000;
    while (runtime.app.seats.presence().activeCount && Date.now() < emptyDeadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(runtime.app.seats.presence().activeCount, 0);
  } finally {
    for (const socket of sockets) socket.terminate();
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
