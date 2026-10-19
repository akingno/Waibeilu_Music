import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createServer } from '../dist/server/main.js';

test('歌单接口：鉴权、创建者、批量增删、并发合并、广播、重启恢复', { timeout: 30000 }, async () => {
  await mkdir('test-results', { recursive: true });
  const directory = await mkdtemp(resolve('test-results/playlists-'));
  const config = {
    port: 0,
    host: '127.0.0.1',
    origin: 'http://127.0.0.1',
    password: 'playlist-test-12345',
    secure: false,
    dataDirectory: directory,
    publicDirectory: resolve('dist/public'),
    limitBytes: 1000000000,
    maxFileBytes: 50000000,
  };
  let runtime = await createServer(config);
  let socket;
  try {
    await runtime.start();
    config.origin = `http://127.0.0.1:${runtime.server.address().port}`;
    let cookie = '',
      csrf = '';
    const request = async (path, method = 'GET', data, headers = {}) => {
      const response = await fetch(config.origin + '/api' + path, {
        method,
        headers: {
          Origin: config.origin,
          Cookie: cookie,
          'X-CSRF-Token': csrf,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return { status: response.status, data: await response.json(), response };
    };
    assert.equal((await request('/playlists')).status, 401);
    const login = await request('/login', 'POST', { password: config.password });
    cookie = login.response.headers.get('set-cookie').split(';')[0];
    csrf = login.data.csrfToken;
    await request('/session', 'PATCH', { nickname: '歌单创建者' });
    assert.equal(
      (await request('/playlists', 'POST', { name: '无效' }, { 'X-CSRF-Token': 'bad' })).status,
      403,
    );
    for (const name of ['', '   ', 'a'.repeat(61), 123])
      assert.equal((await request('/playlists', 'POST', { name })).status, 400);
    const messages = [];
    const wait = async (predicate) => {
      for (let i = 0; i < 200; i++) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('WebSocket 响应超时');
    };
    socket = new WebSocket(config.origin.replace('http:', 'ws:') + '/ws', {
      headers: { Cookie: cookie, Origin: config.origin },
    });
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    const hello = await wait((m) => m.type === 'hello');
    socket.send(JSON.stringify({ type: 'join', requestId: 'join-playlists' }));
    await wait((m) => m.type === 'joined');
    const created = await request('/playlists', 'POST', {
      name: '  周末一起听  ',
      creator: '伪造创建者',
    });
    assert.equal(created.status, 201);
    const playlist = created.data.playlist;
    assert.equal(playlist.name, '周末一起听');
    assert.equal(playlist.creator, '歌单创建者');
    await wait((m) => m.type === 'libraryChanged');
    const ids = [1, 2, 3].map((i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    for (const id of ids) {
      await copyFile('yumetohazakura.mp3', runtime.storage.path(`${id}.mp3`));
      runtime.database.putTrack({
        id,
        title: id,
        artist: '测试',
        storageKey: `${id}.mp3`,
        sizeBytes: 100,
        durationSeconds: 60,
        sha256: id,
        status: 'ready',
        createdAt: new Date().toISOString(),
      });
    }
    const membership = `/playlists/${playlist.id}/tracks`;
    const added = await Promise.all(
      ids
        .slice(0, 2)
        .map((id) => request(membership, 'POST', { operation: 'add', trackIds: [id, id] })),
    );
    assert.ok(added.every((r) => r.status === 200));
    assert.deepEqual(
      runtime.database.playlist(playlist.id).trackIds.sort(),
      ids.slice(0, 2).sort(),
    );
    assert.equal(
      (await request(membership, 'POST', { operation: 'add', trackIds: [ids[2], 'missing'] }))
        .status,
      404,
    );
    assert.equal(
      runtime.database.playlist(playlist.id).trackIds.includes(ids[2]),
      false,
      '失败批次不能部分写入',
    );
    for (const data of [
      { operation: 'bad', trackIds: ids },
      { operation: 'add', trackIds: [] },
      { operation: 'add', trackIds: [42] },
      { operation: 'add', trackIds: Array(1001).fill(ids[0]) },
    ])
      assert.equal((await request(membership, 'POST', data)).status, 400);
    assert.equal(
      (await request(`/playlists/${playlist.id}`, 'PATCH', { name: '改名后的歌单' })).status,
      200,
    );
    const control = async (commandId, action) => {
      socket.send(
        JSON.stringify({ type: 'control', commandId, epoch: hello.state.epoch, ...action }),
      );
      const reply = await wait((m) => m.commandId === commandId || m.requestId === commandId);
      assert.equal(reply.type, 'ack', JSON.stringify(reply));
    };
    await control('scope', { action: 'setPlaylist', playlistId: playlist.id });
    await control('select-with-scope', {
      action: 'selectTrack',
      trackId: ids[0],
      playlistId: playlist.id,
    });
    await control('queued', { action: 'setNextTrack', trackId: ids[1] });
    await wait(
      (m) =>
        m.type === 'state' && m.state.nextTrackId === ids[1] && m.state.playlistId === playlist.id,
    );
    await control('consume-queued', { action: 'next' });
    assert.equal(runtime.app.room.getState().trackId, ids[1]);
    assert.equal(runtime.app.room.getState().nextTrackId, null);
    await control('queued', { action: 'setNextTrack', trackId: ids[1] });
    assert.equal(runtime.app.room.getState().nextTrackId, null, '重放旧指令不能重新插入下一首');
    await control('queued-for-removal', { action: 'setNextTrack', trackId: ids[1] });
    const removed = await request(membership, 'POST', { operation: 'remove', trackIds: [ids[1]] });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.data.playlist.trackIds, [ids[0]]);
    assert.equal(runtime.app.room.getState().nextTrackId, null);
    assert.equal(runtime.database.track(ids[1]).status, 'ready', '移出歌单不删除音乐');
    await request(membership, 'POST', { operation: 'add', trackIds: [ids[1]] });
    await control('queued-again', { action: 'setNextTrack', trackId: ids[1] });
    await runtime.app.deleteTrack(ids[1]);
    assert.equal(runtime.app.room.getState().nextTrackId, null);
    assert.deepEqual(runtime.database.playlist(playlist.id).trackIds, [ids[0]]);
    await control('queued-final', { action: 'setNextTrack', trackId: ids[0] });
    socket.terminate();
    await runtime.stop();
    runtime = await createServer(config);
    assert.equal(runtime.database.playlist(playlist.id).name, '改名后的歌单');
    assert.equal(runtime.database.playlist(playlist.id).creator, '歌单创建者');
    assert.deepEqual(runtime.database.playlist(playlist.id).trackIds, [ids[0]]);
    assert.equal(runtime.app.room.getState().playlistId, playlist.id);
    assert.equal(runtime.app.room.getState().nextTrackId, ids[0]);
  } finally {
    socket?.terminate();
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
