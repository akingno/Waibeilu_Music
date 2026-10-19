import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RoomState, Track, PlaybackMode, Session } from '../shared/models.js';
import { AppError, positionAt, type Command } from '../shared/protocol.js';
import { Database } from './persistence.js';
export class SerialCommandQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
}
type PlaybackRecordOptions = { history?: boolean; shuffle?: boolean };

export class PlaybackOrder {
  private history: string[] = [];
  private recent: string[] = [];
  private shuffleCounts = new Map<string, number>();
  constructor(private random = Math.random) {}
  resetShuffle(): void {
    this.shuffleCounts.clear();
  }
  record(id: string, { history = true, shuffle = false }: PlaybackRecordOptions = {}): void {
    if (history) {
      this.history.push(id);
      if (this.history.length > 100) this.history.shift();
    }
    // 独立保存最近播放，回退历史不会让刚听过的歌曲重新进入随机候选。
    this.recent = this.recent.filter((trackId) => trackId !== id);
    this.recent.push(id);
    if (this.recent.length > 3) this.recent.shift();
    if (shuffle) this.shuffleCounts.set(id, (this.shuffleCounts.get(id) ?? 0) + 1);
  }
  choose(
    mode: PlaybackMode,
    current: string | null,
    tracks: Track[],
    reason: 'ended' | 'next' | 'previous',
  ): string | null {
    if (!tracks.length) return null;
    if (mode === 'repeat-one') {
      if (reason === 'ended' && tracks.some((t) => t.id === current)) return current;
      const i = tracks.findIndex((t) => t.id === current);
      return tracks[(i + (reason === 'previous' ? -1 : 1) + tracks.length) % tracks.length].id;
    }
    if (reason === 'previous') {
      if (this.history.at(-1) === current) this.history.pop();
      while (this.history.length && !tracks.some((t) => t.id === this.history.at(-1)))
        this.history.pop();
      return this.history.at(-1) || tracks.find((t) => t.id === current)?.id || tracks[0].id;
    }
    const available = new Set(tracks.map((t) => t.id));
    for (const id of this.shuffleCounts.keys())
      if (!available.has(id)) this.shuffleCounts.delete(id);
    // 新歌从当前最低次数开始，避免为了追平历史次数而长时间反复播放新歌。
    let baseline = Infinity;
    for (const count of this.shuffleCounts.values()) baseline = Math.min(baseline, count);
    if (baseline === Infinity) baseline = 0;
    for (const id of available)
      if (!this.shuffleCounts.has(id)) this.shuffleCounts.set(id, baseline);

    const excluded = new Set<string>();
    const recentLimit = Math.min(3, tracks.length - 1);
    if (recentLimit && current && available.has(current)) excluded.add(current);
    for (const id of this.recent.toReversed()) {
      if (excluded.size >= recentLimit) break;
      if (available.has(id)) excluded.add(id);
    }
    const eligible = tracks.filter((t) => !excluded.has(t.id));
    let minimum = Infinity;
    for (const track of eligible) minimum = Math.min(minimum, this.shuffleCounts.get(track.id)!);
    const choices = eligible.filter((t) => this.shuffleCounts.get(t.id) === minimum);
    return choices[Math.floor(this.random() * choices.length)].id;
  }
}
export class RoomService {
  private state: RoomState;
  readonly order = new PlaybackOrder();
  private seen = new Map<string, { revision: number; time: number }>();
  constructor(
    private database: Database,
    private now = () => performance.now(),
  ) {
    const c = database.checkpoint(),
      track = c?.trackId ? database.track(c.trackId) : undefined;
    this.state = {
      epoch: randomUUID(),
      revision: 0,
      trackId: track?.status === 'ready' ? track.id : null,
      status: 'paused',
      playbackMode: c?.playbackMode || 'repeat-one',
      playlistId: c?.playlistId && database.playlist(c.playlistId) ? c.playlistId : null,
      nextTrackId: null,
      anchorPositionSeconds: Math.min(c?.positionSeconds || 0, track?.durationSeconds || 0),
      anchorTimeMs: now(),
      durationSeconds: track?.durationSeconds || 0,
      updatedBy: null,
    };
    if (c?.nextTrackId && this.playableTracks().some((t) => t.id === c.nextTrackId))
      this.state.nextTrackId = c.nextTrackId;
    if (this.state.trackId) this.order.record(this.state.trackId);
  }
  getState(): RoomState {
    return { ...this.state };
  }
  position(): number {
    return positionAt(this.state, this.now());
  }
  private update(patch: Partial<RoomState>): RoomState {
    const previous = this.state;
    this.state = {
      ...this.state,
      anchorPositionSeconds: this.position(),
      anchorTimeMs: this.now(),
      ...patch,
      revision: previous.revision + 1,
    };
    try {
      this.save();
    } catch (error) {
      this.state = previous;
      throw error;
    }
    return this.getState();
  }
  private select(
    id: string | null,
    options: PlaybackRecordOptions = {},
    patch: Partial<RoomState> = {},
  ): RoomState {
    const track = id ? this.database.track(id) : undefined;
    if (id && (!track || track.status !== 'ready'))
      throw new AppError('TRACK_NOT_FOUND', '歌曲已不存在', 404);
    const state = this.update({
      trackId: track?.id || null,
      durationSeconds: track?.durationSeconds || 0,
      anchorPositionSeconds: 0,
      status: track ? 'playing' : 'stopped',
      ...patch,
    });
    if (track) this.order.record(track.id, options);
    return state;
  }
  private playableTracks(playlistId = this.state.playlistId): Track[] {
    const ids = playlistId ? new Set(this.database.playlist(playlistId)?.trackIds ?? []) : null;
    return this.database
      .allTracks()
      .filter((track) => track.status === 'ready' && (!ids || ids.has(track.id)));
  }
  private validatePlaylist(id: string | null): void {
    if (id && !this.database.playlist(id))
      throw new AppError('PLAYLIST_NOT_FOUND', '歌单已不存在', 404);
  }
  private advance(reason: 'next' | 'ended'): void {
    const tracks = this.playableTracks();
    const queued = tracks.find((t) => t.id === this.state.nextTrackId);
    const id =
      queued?.id ?? this.order.choose(this.state.playbackMode, this.state.trackId, tracks, reason);
    this.select(
      id,
      { shuffle: !queued && this.state.playbackMode === 'shuffle' },
      { nextTrackId: null },
    );
  }
  playlistChanged(): void {
    if (
      this.state.nextTrackId &&
      !this.playableTracks().some((t) => t.id === this.state.nextTrackId)
    )
      this.update({ nextTrackId: null });
  }
  apply(command: Command, actor: Session): RoomState {
    if (command.epoch !== this.state.epoch)
      throw new AppError('STALE_EPOCH', '服务已重启，请等待重新同步', 409);
    const key = actor.id + ':' + command.commandId;
    if (this.seen.has(key)) return this.getState();
    const tracks = this.playableTracks();
    switch (command.action) {
      case 'selectTrack': {
        const playlistId =
          command.playlistId === undefined ? this.state.playlistId : command.playlistId;
        this.validatePlaylist(playlistId);
        const candidates = this.playableTracks(playlistId);
        if (!candidates.some((t) => t.id === command.trackId))
          throw new AppError('TRACK_NOT_FOUND', '这首歌不在当前播放歌单中', 404);
        const nextTrackId =
          this.state.nextTrackId !== command.trackId &&
          candidates.some((t) => t.id === this.state.nextTrackId)
            ? this.state.nextTrackId
            : null;
        const changed = playlistId !== this.state.playlistId;
        this.select(command.trackId, {}, { playlistId, nextTrackId });
        if (changed) this.order.resetShuffle();
        break;
      }
      case 'setNextTrack':
        if (command.trackId && !tracks.some((t) => t.id === command.trackId))
          throw new AppError('TRACK_NOT_FOUND', '请从当前播放歌单中选择下一首', 404);
        this.update({ nextTrackId: command.trackId });
        break;
      case 'setPlaylist': {
        this.validatePlaylist(command.playlistId);
        const nextTrackId = this.playableTracks(command.playlistId).some(
          (t) => t.id === this.state.nextTrackId,
        )
          ? this.state.nextTrackId
          : null;
        const changed = command.playlistId !== this.state.playlistId;
        this.update({ playlistId: command.playlistId, nextTrackId });
        if (changed) this.order.resetShuffle();
        break;
      }
      case 'setPlaybackMode':
        this.update({ playbackMode: command.playbackMode });
        break;
      case 'next':
        this.advance('next');
        break;
      case 'previous':
        this.select(
          this.order.choose(this.state.playbackMode, this.state.trackId, tracks, command.action),
          {
            history: false,
          },
        );
        break;
      case 'play':
        if (!this.state.trackId) this.advance('next');
        else
          this.update({
            status: 'playing',
            anchorPositionSeconds:
              this.position() >= this.state.durationSeconds ? 0 : this.position(),
          });
        break;
      case 'pause':
        this.update({ status: this.state.trackId ? 'paused' : 'stopped' });
        break;
      case 'seek':
        if (command.trackId !== this.state.trackId)
          throw new AppError('TRACK_NOT_FOUND', '歌曲已切换，已刷新播放状态', 409);
        this.update({
          anchorPositionSeconds: Math.min(command.positionSeconds, this.state.durationSeconds),
        });
        break;
    }
    this.state.updatedBy = actor.nickname;
    this.seen.set(key, { revision: this.state.revision, time: Date.now() });
    for (const [k, v] of this.seen)
      if (v.time < Date.now() - 300000 || this.seen.size > 2000) this.seen.delete(k);
    return this.getState();
  }
  ended(): boolean {
    if (this.state.status !== 'playing' || this.position() < this.state.durationSeconds)
      return false;
    this.advance('ended');
    return true;
  }
  deleted(id: string): void {
    if (this.state.trackId === id)
      this.select(
        null,
        {},
        { nextTrackId: this.state.nextTrackId === id ? null : this.state.nextTrackId },
      );
    else if (this.state.nextTrackId === id) this.update({ nextTrackId: null });
  }
  pauseWhenEmpty(): boolean {
    if (this.state.status !== 'playing') return false;
    this.update({ status: 'paused' });
    return true;
  }
  save(): void {
    this.database.saveCheckpoint({
      trackId: this.state.trackId,
      positionSeconds: this.position(),
      playbackMode: this.state.playbackMode,
      playlistId: this.state.playlistId,
      nextTrackId: this.state.nextTrackId,
      savedAt: new Date().toISOString(),
    });
  }
}
