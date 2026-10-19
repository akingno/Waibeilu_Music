/** 共享领域类型；只描述数据，不包含执行逻辑。 */
export type PlaybackMode = 'repeat-one' | 'shuffle';
export type PlaybackStatus = 'playing' | 'paused' | 'stopped';
export interface Track {
  id: string;
  title: string;
  artist: string;
  storageKey: string;
  sizeBytes: number;
  durationSeconds: number;
  sha256: string;
  createdAt: string;
  status: 'ready' | 'pending-delete';
}
/** 曲库接口不暴露磁盘路径。 */
export type TrackSummary = Pick<Track, 'id' | 'title' | 'artist' | 'durationSeconds'>;
export interface Playlist {
  id: string;
  name: string;
  creator: string;
  createdAt: string;
  trackIds: string[];
}
export interface StorageUsage {
  /** 服务端提供的总容量，按字节计。 */
  limitBytes: number;
  /** 已提交及待删除文件，不含已计入预留的暂存文件。 */
  occupiedBytes: number;
  /** occupiedBytes 的子集，仅用于分段展示，不再从 remainingBytes 重复扣减。 */
  pendingDeleteBytes: number;
  reservedBytes: number;
  /** limitBytes - occupiedBytes - reservedBytes。 */
  remainingBytes: number;
}
export interface RoomState {
  epoch: string;
  revision: number;
  trackId: string | null;
  status: PlaybackStatus;
  playbackMode: PlaybackMode;
  playlistId: string | null;
  nextTrackId: string | null;
  anchorPositionSeconds: number;
  anchorTimeMs: number;
  durationSeconds: number;
  updatedBy: string | null;
}
export interface Session {
  id: string;
  nickname: string;
  expiresAt: string;
}
export interface ListenerLease {
  id: string;
  sessionId: string;
  connectionId: string;
  expiresAtMs: number;
}
export interface PlaybackCheckpoint {
  trackId: string | null;
  positionSeconds: number;
  playbackMode: PlaybackMode;
  playlistId?: string | null;
  nextTrackId?: string | null;
  savedAt: string;
}
export interface Presence {
  activeCount: number;
  maxListeners: 5;
  nicknames: readonly string[];
}
export interface ClockSample {
  clientSentMs: number;
  serverReceivedMs: number;
  serverSentMs: number;
  clientReceivedMs: number;
}
export type Unsubscribe = () => void;
