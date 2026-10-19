import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioPlayer, ClockEstimator, SyncController } from '../src/client/audio.js';
import type { RoomState } from '../src/shared/models.js';
import { ClientStore } from '../src/client/state.js';

function media() {
  return {
    currentTime: 0,
    readyState: 4,
    paused: true,
    volume: 1,
    playbackRate: 1,
    loop: false,
    src: '',
    load() {},
    removeAttribute() {},
    pause() {
      this.paused = true;
    },
    async play() {
      this.paused = false;
    },
  };
}

test('浏览歌单与房间播放范围独立，搜索只匹配浏览歌单成员', () => {
  const store = new ClientStore();
  store.tracks = [
    { id: 't1', title: '夜晚', artist: 'Alice', durationSeconds: 60 },
    { id: 't2', title: '清晨', artist: 'Bob', durationSeconds: 60 },
    { id: 't3', title: '午后', artist: 'Alice', durationSeconds: 60 },
  ];
  store.playlists = [
    { id: 'p1', name: '一起听', creator: '朋友', createdAt: '2026-10-19', trackIds: ['t1', 't2'] },
  ];
  assert.equal(store.visibleTracks().length, 3);
  store.browsePlaylistId = 'p1';
  assert.deepEqual(
    store.visibleTracks().map((track) => track.id),
    ['t1', 't2'],
  );
  store.search = 'ALICE';
  assert.deepEqual(
    store.visibleTracks().map((track) => track.id),
    ['t1'],
  );
  assert.equal(store.room, null, '浏览及搜索不能改变房间播放状态');
  store.browsePlaylistId = 'missing';
  assert.deepEqual(store.visibleTracks(), []);
});

test('五端模拟：加入和缓冲恢复用最新目标跳转，固定正常倍速', async () => {
  const now = performance.now();
  const state: RoomState = {
    epoch: 'one',
    revision: 1,
    trackId: 'track',
    status: 'playing',
    playbackMode: 'repeat-one',
    playlistId: null,
    nextTrackId: null,
    anchorPositionSeconds: 40,
    anchorTimeMs: now + 500,
    durationSeconds: 200,
    updatedBy: null,
  };
  const devices = [0, -8, 5, 17, -20].map((drift) => {
    const el = media();
    el.currentTime = 40 + drift;
    const clock = new ClockEstimator();
    // Symmetric 200 ms roundtrip and an arbitrary server clock offset.
    clock.addSample({
      clientSentMs: now - 100,
      clientReceivedMs: now + 100,
      serverReceivedMs: now + 500,
      serverSentMs: now + 500,
    });
    const sync = new SyncController(new AudioPlayer(el as unknown as HTMLAudioElement), clock);
    sync.active = sync.connected = true;
    return { el, sync };
  });
  for (const d of devices) {
    d.sync.accept(state);
    await d.sync.reconcile(true);
  }
  const positions = devices.map((d) => d.el.currentTime);
  assert.ok(Math.max(...positions) - Math.min(...positions) < 1);
  for (const d of devices) {
    assert.equal(d.el.playbackRate, 1);
    assert.equal(d.el.loop, false);
    assert.equal(d.el.paused, false);
  }
  const device = devices[0];
  device.el.readyState = 0;
  device.el.currentTime = 10;
  device.sync.accept({ ...state, revision: 2, anchorPositionSeconds: 80 });
  assert.equal(device.el.currentTime, 10);
  device.el.readyState = 4;
  await device.sync.reconcile(true);
  assert.ok(device.el.currentTime >= 80);
  device.sync.accept({ ...state, revision: 1, anchorPositionSeconds: 5 });
  assert.equal(device.sync.state?.revision, 2);
  device.sync.disconnect();
  assert.equal(device.el.paused, true);
});

test('暂停快照和自动播放拒绝不会向房间发送副作用', async () => {
  const el = media();
  const clock = new ClockEstimator();
  const now = performance.now();
  clock.addSample({
    clientSentMs: now,
    clientReceivedMs: now,
    serverReceivedMs: now,
    serverSentMs: now,
  });
  const sync = new SyncController(new AudioPlayer(el as unknown as HTMLAudioElement), clock);
  sync.active = sync.connected = true;
  const state: RoomState = {
    epoch: 'one',
    revision: 1,
    trackId: 'track',
    status: 'paused',
    playbackMode: 'shuffle',
    playlistId: null,
    nextTrackId: null,
    anchorPositionSeconds: 25,
    anchorTimeMs: now,
    durationSeconds: 100,
    updatedBy: null,
  };
  sync.accept(state);
  await sync.reconcile(true);
  assert.equal(el.currentTime, 25);
  assert.equal(el.paused, true);
  el.play = async () => {
    throw new DOMException('Gesture required', 'NotAllowedError');
  };
  sync.accept({ ...state, revision: 2, status: 'playing' });
  await sync.reconcile(true);
  assert.equal(sync.status, '需要点击继续收听');
  assert.equal(sync.state?.status, 'playing');
});
