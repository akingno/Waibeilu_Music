import type { PlaybackMode, RoomState } from './models.js';
export type Action =
  | { action: 'selectTrack'; trackId: string; playlistId?: string | null }
  | { action: 'setNextTrack'; trackId: string | null }
  | { action: 'setPlaylist'; playlistId: string | null }
  | { action: 'play' | 'pause' | 'next' | 'previous' }
  | { action: 'seek'; trackId: string; positionSeconds: number }
  | { action: 'setPlaybackMode'; playbackMode: PlaybackMode };
export type Command = Action & { commandId: string; epoch: string };
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function requireString(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.length || value.length > max)
    throw new AppError('INVALID_INPUT', '输入内容无效');
  return value;
}
export function parseCommand(input: unknown): Command {
  if (!input || typeof input !== 'object') throw new AppError('INVALID_COMMAND', '指令格式错误');
  const v = input as Record<string, unknown>;
  const base = { commandId: requireString(v.commandId, 100), epoch: requireString(v.epoch, 100) };
  switch (v.action) {
    case 'selectTrack':
      return {
        ...base,
        action: v.action,
        trackId: requireString(v.trackId, 100),
        ...(v.playlistId === undefined
          ? {}
          : { playlistId: v.playlistId === null ? null : requireString(v.playlistId, 100) }),
      };
    case 'setNextTrack':
      return {
        ...base,
        action: v.action,
        trackId: v.trackId === null ? null : requireString(v.trackId, 100),
      };
    case 'setPlaylist':
      return {
        ...base,
        action: v.action,
        playlistId: v.playlistId === null ? null : requireString(v.playlistId, 100),
      };
    case 'play':
    case 'pause':
    case 'next':
    case 'previous':
      return { ...base, action: v.action };
    case 'seek':
      if (
        typeof v.positionSeconds !== 'number' ||
        !Number.isFinite(v.positionSeconds) ||
        v.positionSeconds < 0
      )
        break;
      return {
        ...base,
        action: v.action,
        trackId: requireString(v.trackId, 100),
        positionSeconds: v.positionSeconds,
      };
    case 'setPlaybackMode':
      if (v.playbackMode === 'repeat-one' || v.playbackMode === 'shuffle')
        return { ...base, action: v.action, playbackMode: v.playbackMode };
  }
  throw new AppError('INVALID_COMMAND', '不支持的播放操作');
}
export function positionAt(state: RoomState, nowMs: number): number {
  const p =
    state.anchorPositionSeconds +
    (state.status === 'playing' ? Math.max(0, nowMs - state.anchorTimeMs) / 1000 : 0);
  return Math.min(state.durationSeconds, Math.max(0, p));
}
