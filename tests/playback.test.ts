import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackOrder, RoomService } from '../src/server/playback.js';
import { Database } from '../src/server/persistence.js';
import type { Track } from '../src/shared/models.js';
import type { Action } from '../src/shared/protocol.js';

function tracks(size: number): Track[] {
  return Array.from({ length: size }, (_, i) => ({
    id: `t${i}`,
    title: `Track ${i}`,
    artist: 'Artist',
    storageKey: `${i}.mp3`,
    sizeBytes: 100,
    durationSeconds: 60,
    sha256: `hash${i}`,
    createdAt: '2026-10-19T00:00:00.000Z',
    status: 'ready',
  }));
}

function seededRandom(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function simulate(library: Track[], random: () => number, draws = 100) {
  const order = new PlaybackOrder(random);
  const counts = new Map(library.map((track) => [track.id, 0]));
  let current: string | null = library[0]?.id ?? null;
  const recent = current ? [current] : [];
  if (current) order.record(current);
  for (let i = 0; i < draws; i++) {
    const id = order.choose('shuffle', current, library, i % 2 ? 'ended' : 'next');
    assert.ok(id && counts.has(id), '只能选择歌单内歌曲');
    const window = Math.min(3, library.length - 1);
    assert.ok(window === 0 || !recent.slice(-window).includes(id));
    counts.set(id, counts.get(id)! + 1);
    order.record(id, { shuffle: true });
    recent.push(id);
    current = id;
  }
  return counts;
}

test('连续随机 100 次：10 首歌各命中 10 次，始终避开最近 3 首', (t) => {
  const counts = simulate(tracks(10), seededRandom(42));
  assert.deepEqual([...counts.values()], Array(10).fill(10));
  t.diagnostic(JSON.stringify(Object.fromEntries(counts)));
});

test('不同歌单规模和随机种子：100 次随机的命中次数差不超过 1', () => {
  for (const size of [2, 3, 4, 5, 7, 10, 17, 37, 101, 150]) {
    for (let seed = 1; seed <= 100; seed++) {
      const values = [...simulate(tracks(size), seededRandom(seed)).values()];
      assert.ok(
        Math.max(...values) - Math.min(...values) <= 1,
        `歌单 ${size} 首，种子 ${seed}: ${values.join(',')}`,
      );
    }
  }
});

test('空歌单、单首歌、两首歌和随机数边界均可正常选择', () => {
  for (const random of [() => 0, () => 1 - Number.EPSILON]) {
    const order = new PlaybackOrder(random);
    assert.equal(order.choose('shuffle', null, [], 'next'), null);
    assert.equal(order.choose('shuffle', 't0', tracks(1), 'ended'), 't0');
    assert.deepEqual([...simulate(tracks(2), random).values()], [50, 50]);
    assert.deepEqual([...simulate(tracks(10), random).values()], Array(10).fill(10));
  }
});

test('回退后继续随机，仍排除刚听过的歌曲，且不破坏多次回退', () => {
  const library = tracks(5);
  const order = new PlaybackOrder(() => 0);
  for (const id of ['t0', 't1', 't2']) order.record(id);
  const previous = order.choose('shuffle', 't2', library, 'previous');
  assert.equal(previous, 't1');
  order.record(previous!, { history: false });
  const next = order.choose('shuffle', previous, library, 'next');
  assert.ok(next === 't3' || next === 't4');
  assert.equal(order.choose('shuffle', previous, library, 'previous'), 't0');
});

test('歌单增删：忽略已删除歌曲，新歌不需要追平全部历史次数', () => {
  const order = new PlaybackOrder(() => 0);
  const library = tracks(8);
  let current: string | null = null;
  for (let i = 0; i < 800; i++) {
    current = order.choose('shuffle', current, library.slice(0, 7), 'next');
    order.record(current!, { shuffle: true });
  }
  const updated = library.slice(2);
  const counts = new Map(updated.map((track) => [track.id, 0]));
  for (let i = 0; i < 100; i++) {
    current = order.choose('shuffle', current, updated, 'next');
    assert.ok(current && counts.has(current));
    counts.set(current, counts.get(current)! + 1);
    order.record(current, { shuffle: true });
  }
  const values = [...counts.values()];
  assert.ok(counts.get('t7')! > 0);
  assert.ok(Math.max(...values) - Math.min(...values) <= 2, values.join(','));
});

test('房间真实命令：下一首与自然结束共用均衡随机，重复指令不重复计数', () => {
  const database = new Database(':memory:');
  try {
    for (const track of tracks(10)) database.putTrack(track);
    let now = 0;
    const room = new RoomService(database, () => now);
    const actor = { id: 'tester', nickname: '测试', expiresAt: '2099-01-01T00:00:00.000Z' };
    let commandId = 0;
    const control = (action: 'next' | 'previous') => {
      const command = { action, commandId: String(commandId++), epoch: room.getState().epoch };
      room.apply(command, actor);
      const revision = room.getState().revision;
      room.apply(command, actor);
      assert.equal(room.getState().revision, revision);
    };
    room.apply(
      {
        action: 'setPlaybackMode',
        playbackMode: 'shuffle',
        commandId: 'mode',
        epoch: room.getState().epoch,
      },
      actor,
    );
    const counts = new Map(tracks(10).map((track) => [track.id, 0]));
    const recent: string[] = [];
    for (let i = 0; i < 100; i++) {
      if (i % 2) {
        now += 60000;
        assert.equal(room.ended(), true);
      } else control('next');
      const id = room.getState().trackId!;
      assert.ok(!recent.slice(-3).includes(id));
      counts.set(id, counts.get(id)! + 1);
      recent.push(id);
    }
    assert.deepEqual([...counts.values()], Array(10).fill(10));
    control('previous');
    assert.equal(room.getState().trackId, recent.at(-2));
  } finally {
    database.close();
  }
});

function playlistRoom() {
  const database = new Database(':memory:');
  for (const track of tracks(10)) database.putTrack(track);
  database.putPlaylist({
    id: 'p1',
    name: '一起听',
    creator: '创建者',
    createdAt: '2026-10-19',
    trackIds: ['t0', 't1', 't2', 't3', 't4'],
  });
  database.putPlaylist({
    id: 'empty',
    name: '空歌单',
    creator: '创建者',
    createdAt: '2026-10-19',
    trackIds: [],
  });
  let now = 0;
  const room = new RoomService(database, () => now);
  const actor = { id: 'tester', nickname: '测试', expiresAt: '2099-01-01T00:00:00.000Z' };
  let commandId = 0;
  const control = (action: Action) =>
    room.apply({ ...action, commandId: String(commandId++), epoch: room.getState().epoch }, actor);
  const end = () => {
    now += 60000;
    return room.ended();
  };
  return { database, room, control, end };
}

test('歌单内随机 100 次：只选择成员，每首 20 次；上一首不能回到歌单外', () => {
  const { database, room, control, end } = playlistRoom();
  try {
    control({ action: 'selectTrack', trackId: 't9' });
    control({ action: 'setPlaylist', playlistId: 'p1' });
    control({ action: 'setPlaybackMode', playbackMode: 'shuffle' });
    const counts = new Map(['t0', 't1', 't2', 't3', 't4'].map((id) => [id, 0]));
    const recent: string[] = [];
    for (let i = 0; i < 100; i++) {
      if (i % 2) assert.equal(end(), true);
      else control({ action: 'next' });
      const id = room.getState().trackId!;
      assert.ok(counts.has(id));
      assert.ok(!recent.slice(-3).includes(id));
      counts.set(id, counts.get(id)! + 1);
      recent.push(id);
    }
    assert.deepEqual([...counts.values()], [20, 20, 20, 20, 20]);
    for (let i = 0; i < 110; i++) {
      control({ action: 'previous' });
      assert.ok(counts.has(room.getState().trackId!));
    }
    assert.throws(() => control({ action: 'selectTrack', trackId: 't9' }), /当前播放歌单/);
    assert.throws(() => control({ action: 'setNextTrack', trackId: 't9' }), /当前播放歌单/);
    assert.throws(() => control({ action: 'setPlaylist', playlistId: 'missing' }), /歌单已不存在/);
  } finally {
    database.close();
  }
});

test('设为下一首：替换、取消、手动切歌和自然结束，优先于单曲循环', () => {
  const { database, room, control, end } = playlistRoom();
  try {
    control({ action: 'selectTrack', trackId: 't0', playlistId: 'p1' });
    control({ action: 'setNextTrack', trackId: 't1' });
    const before = room.getState();
    control({ action: 'setNextTrack', trackId: 't2' });
    assert.equal(room.getState().trackId, before.trackId);
    assert.equal(room.getState().status, before.status);
    assert.equal(room.getState().anchorPositionSeconds, before.anchorPositionSeconds);
    control({ action: 'next' });
    assert.equal(room.getState().trackId, 't2');
    assert.equal(room.getState().nextTrackId, null);
    control({ action: 'setNextTrack', trackId: 't4' });
    assert.equal(end(), true);
    assert.equal(room.getState().trackId, 't4');
    assert.equal(end(), true);
    assert.equal(room.getState().trackId, 't4');
    control({ action: 'setNextTrack', trackId: 't3' });
    control({ action: 'setNextTrack', trackId: null });
    control({ action: 'next' });
    assert.equal(room.getState().trackId, 't0');
    control({ action: 'setNextTrack', trackId: 't2' });
    control({ action: 'selectTrack', trackId: 't2' });
    assert.equal(room.getState().nextTrackId, null);
    control({ action: 'setNextTrack', trackId: 't1' });
    const saveCheckpoint = database.saveCheckpoint.bind(database);
    database.saveCheckpoint = () => {
      throw new Error('模拟保存失败');
    };
    assert.throws(() => control({ action: 'next' }), /模拟保存失败/);
    assert.equal(room.getState().nextTrackId, 't1', '切歌失败不能消耗待播歌曲');
    database.saveCheckpoint = saveCheckpoint;
    const restored = new RoomService(database);
    assert.equal(restored.getState().playlistId, 'p1');
    assert.equal(restored.getState().nextTrackId, 't1');
    assert.equal(restored.getState().status, 'paused');
  } finally {
    database.close();
  }
});

test('歌单移除、切换、删除待播和空歌单均不会播放无效候选', () => {
  const { database, room, control, end } = playlistRoom();
  try {
    control({ action: 'selectTrack', trackId: 't0', playlistId: 'p1' });
    control({ action: 'setNextTrack', trackId: 't1' });
    database.putPlaylist({ ...database.playlist('p1')!, trackIds: ['t0'] });
    room.playlistChanged();
    assert.equal(room.getState().nextTrackId, null);
    control({ action: 'setPlaybackMode', playbackMode: 'shuffle' });
    for (let i = 0; i < 5; i++) {
      control({ action: 'next' });
      assert.equal(room.getState().trackId, 't0');
    }
    control({ action: 'setNextTrack', trackId: 't0' });
    room.deleted('t0');
    assert.equal(room.getState().nextTrackId, null);
    assert.equal(room.getState().trackId, null);
    control({ action: 'setPlaylist', playlistId: 'empty' });
    control({ action: 'play' });
    assert.equal(room.getState().status, 'stopped');
    assert.equal(room.getState().trackId, null);
    control({ action: 'selectTrack', trackId: 't9', playlistId: null });
    control({ action: 'setNextTrack', trackId: 't8' });
    control({ action: 'setPlaylist', playlistId: 'empty' });
    assert.equal(room.getState().nextTrackId, null);
    assert.equal(end(), true);
    assert.equal(room.getState().trackId, null);
  } finally {
    database.close();
  }
});
