import { DatabaseSync } from 'node:sqlite';
import type { Track, PlaybackCheckpoint, Playlist } from '../shared/models.js';
export class Database {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL);`);
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  allTracks(): Track[] {
    return this.db
      .prepare('SELECT data FROM tracks ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  track(id: string): Track | undefined {
    return this.allTracks().find((t) => t.id === id);
  }
  putTrack(track: Track): void {
    this.db
      .prepare('INSERT OR REPLACE INTO tracks VALUES (?, ?)')
      .run(track.id, JSON.stringify(track));
  }
  removeTrack(id: string): void {
    this.removeTrackFromPlaylists(id);
    this.db.prepare('DELETE FROM tracks WHERE id=?').run(id);
  }
  playlists(): Playlist[] {
    return this.db
      .prepare('SELECT data FROM playlists ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  playlist(id: string): Playlist | undefined {
    const row = this.db.prepare('SELECT data FROM playlists WHERE id=?').get(id);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  putPlaylist(playlist: Playlist): void {
    this.db
      .prepare(
        'INSERT INTO playlists VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(playlist.id, JSON.stringify(playlist));
  }
  removeTrackFromPlaylists(id: string): void {
    for (const playlist of this.playlists()) {
      if (playlist.trackIds.includes(id))
        this.putPlaylist({
          ...playlist,
          trackIds: playlist.trackIds.filter((trackId) => trackId !== id),
        });
    }
  }
  setting(key: string): string | undefined {
    return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value as
      string | undefined;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, value);
  }
  checkpoint(): PlaybackCheckpoint | null {
    const s = this.setting('checkpoint');
    return s ? JSON.parse(s) : null;
  }
  saveCheckpoint(checkpoint: PlaybackCheckpoint): void {
    this.setSetting('checkpoint', JSON.stringify(checkpoint));
  }
  close(): void {
    this.db.close();
  }
}
