import type {
  RoomState,
  TrackSummary,
  StorageUsage,
  Presence,
  Playlist,
} from '../shared/models.js';
export type RoomTab = 'playlist' | 'player';
export interface UploadTaskView {
  id: string;
  fileName: string;
  sentBytes: number;
  totalBytes: number;
  phase: 'queued' | 'uploading' | 'validating' | 'completed' | 'failed';
  errorMessage?: string;
}
export class ClientStore {
  room: RoomState | null = null;
  tracks: TrackSummary[] = [];
  playlists: Playlist[] = [];
  browsePlaylistId: string | null = null;
  selectedTracks = new Set<string>();
  bulkBusy = false;
  storage: StorageUsage | null = null;
  presence: Presence | null = null;
  uploads: UploadTaskView[] = [];
  tab: RoomTab = 'playlist';
  search = '';
  connected = false;
  joined = false;
  visibleTracks(): TrackSummary[] {
    const ids = this.browsePlaylistId
      ? new Set(this.playlists.find((p) => p.id === this.browsePlaylistId)?.trackIds ?? [])
      : null;
    return this.tracks.filter(
      (track) =>
        (!ids || ids.has(track.id)) &&
        `${track.title} ${track.artist}`.toLowerCase().includes(this.search.toLowerCase()),
    );
  }
}
