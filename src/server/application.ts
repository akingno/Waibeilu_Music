import { randomUUID } from 'node:crypto';
import type { Session, TrackSummary, Playlist } from '../shared/models.js';
import { AppError, requireString, type Command } from '../shared/protocol.js';
import { Database } from './persistence.js';
import { RoomService, SerialCommandQueue } from './playback.js';
import { SeatRegistry } from './seats.js';
export class MusicApplication {
  readonly queue = new SerialCommandQueue();
  constructor(
    readonly database: Database,
    readonly room: RoomService,
    readonly seats: SeatRegistry,
    readonly broadcast: () => void,
  ) {}
  tracks(): TrackSummary[] {
    return this.database
      .allTracks()
      .filter((t) => t.status === 'ready')
      .map(({ id, title, artist, durationSeconds }) => ({ id, title, artist, durationSeconds }));
  }
  control(session: Session, connectionId: string, command: Command): Promise<void> {
    return this.queue.run(() => {
      this.seats.touch(session.id, connectionId);
      this.room.apply(command, session);
      this.broadcast();
    });
  }
  createPlaylist(name: unknown, session: Session): Promise<Playlist> {
    return this.queue.run(() => {
      const playlist: Playlist = {
        id: randomUUID(),
        name: this.playlistName(name),
        creator: session.nickname,
        createdAt: new Date().toISOString(),
        trackIds: [],
      };
      this.database.putPlaylist(playlist);
      return playlist;
    });
  }
  renamePlaylist(id: string, name: unknown): Promise<Playlist> {
    return this.queue.run(() => {
      const playlist = this.requirePlaylist(id);
      playlist.name = this.playlistName(name);
      this.database.putPlaylist(playlist);
      return playlist;
    });
  }
  changePlaylistTracks(id: string, operation: unknown, input: unknown): Promise<Playlist> {
    return this.queue.run(() => {
      const playlist = this.requirePlaylist(id);
      if (
        (operation !== 'add' && operation !== 'remove') ||
        !Array.isArray(input) ||
        !input.length ||
        input.length > 1000
      )
        throw new AppError('INVALID_INPUT', '请选择 1 到 1000 首歌曲');
      const ids = new Set(input.map((value: unknown) => requireString(value, 100)));
      const ready = new Set(this.tracks().map((track) => track.id));
      if (operation === 'add' && [...ids].some((trackId) => !ready.has(trackId)))
        throw new AppError('TRACK_NOT_FOUND', '部分歌曲已不存在，请刷新后重试', 404);
      playlist.trackIds =
        operation === 'add'
          ? [...new Set([...playlist.trackIds, ...ids])]
          : playlist.trackIds.filter((trackId) => !ids.has(trackId));
      this.database.transaction(() => {
        this.database.putPlaylist(playlist);
        this.room.playlistChanged();
      });
      this.broadcast();
      return playlist;
    });
  }
  private playlistName(input: unknown): string {
    return requireString(typeof input === 'string' ? input.trim() : input, 60);
  }
  private requirePlaylist(id: string): Playlist {
    const playlist = this.database.playlist(id);
    if (!playlist) throw new AppError('PLAYLIST_NOT_FOUND', '歌单已不存在', 404);
    return playlist;
  }
  deleteTrack(id: string): Promise<void> {
    return this.queue.run(() => {
      const track = this.database.track(id);
      if (!track) return;
      this.room.deleted(id);
      this.database.putTrack({ ...track, status: 'pending-delete' });
      this.database.removeTrackFromPlaylists(id);
      this.broadcast();
    });
  }
  tick(): Promise<void> {
    return this.queue.run(() => {
      this.seats.expire();
      if (!this.seats.presence().activeCount) this.room.pauseWhenEmpty();
      else this.room.ended();
      this.broadcast();
    });
  }
}
