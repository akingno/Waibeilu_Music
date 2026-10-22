import type { TrackSummary, StorageUsage } from '../shared/models.js';
import type { ClientStore, UploadTaskView } from './state.js';
import { element } from './shell.js';
export function time(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
export function storageCapacity(bytes: number): string {
  return bytes >= 1e9
    ? `${Number((bytes / 1e9).toFixed(2))} GB`
    : `${Number((bytes / 1e6).toFixed(1))} MB`;
}
export class PlaylistView {
  constructor(
    private play: (id: string) => void,
    private remove: (track: TrackSummary) => void,
    private next: (id: string) => void,
    private toggle: (id: string, selected: boolean) => void,
  ) {}
  render(store: ClientStore): void {
    const root = element('playlist');
    root.replaceChildren();
    const playlist = store.playlists.find((p) => p.id === store.browsePlaylistId);
    const active = store.playlists.find((p) => p.id === store.room?.playlistId);
    const activeIds = active ? new Set(active.trackIds) : null;
    const filtered = store.visibleTracks();
    element('track-count').textContent = `${filtered.length} 首`;
    element('playlist-creator').textContent = playlist
      ? `创建者：${playlist.creator}`
      : '全部已上传歌曲';
    element('active-playlist-label').textContent = `播放范围：${active?.name ?? '全部歌曲'}`;
    const options = [{ id: '', name: '全部歌曲' }, ...store.playlists];
    for (const id of ['browse-playlist', 'target-playlist']) {
      const select = element<HTMLSelectElement>(id);
      const items = id === 'browse-playlist' ? options : store.playlists;
      const key = JSON.stringify(items.map((p) => [p.id, p.name]));
      if (select.dataset.options !== key) {
        const previous = select.value;
        select.replaceChildren(...items.map((p) => new Option(p.name, p.id)));
        if (items.some((p) => p.id === previous)) select.value = previous;
        select.dataset.options = key;
      }
      if (id === 'browse-playlist') select.value = store.browsePlaylistId ?? '';
      select.disabled = store.bulkBusy || (id === 'target-playlist' && !store.playlists.length);
    }
    element<HTMLButtonElement>('rename-playlist').disabled = !playlist || store.bulkBusy;
    element<HTMLButtonElement>('activate-playlist').disabled =
      !store.joined || !store.connected || store.room?.playlistId === store.browsePlaylistId;
    element('selection-count').textContent = `已选 ${store.selectedTracks.size} 首`;
    element<HTMLButtonElement>('add-selected').disabled =
      store.bulkBusy || !store.selectedTracks.size || !store.playlists.length;
    element<HTMLButtonElement>('remove-selected').disabled =
      store.bulkBusy || !store.selectedTracks.size || !playlist;
    const selectAll = element<HTMLInputElement>('select-visible');
    selectAll.checked = !!filtered.length && filtered.every((t) => store.selectedTracks.has(t.id));
    selectAll.indeterminate =
      !selectAll.checked && filtered.some((t) => store.selectedTracks.has(t.id));
    selectAll.disabled = store.bulkBusy || !filtered.length;
    for (const track of filtered) {
      const row = document.createElement('div');
      row.className = `track-row${store.room?.trackId === track.id ? ' current' : ''}`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'track-select';
      checkbox.checked = store.selectedTracks.has(track.id);
      checkbox.disabled = store.bulkBusy;
      checkbox.setAttribute('aria-label', `选择 ${track.title}`);
      checkbox.onchange = () => this.toggle(track.id, checkbox.checked);
      const play = document.createElement('button');
      play.className = 'icon-button';
      play.textContent = '▶';
      play.setAttribute('aria-label', `播放 ${track.title}`);
      play.disabled = !store.joined || !store.connected;
      play.onclick = () => this.play(track.id);
      const info = document.createElement('div');
      info.className = 'song-info';
      const title = document.createElement('p');
      title.className = 'song-title';
      title.textContent = track.title;
      title.title = track.title;
      const artist = document.createElement('p');
      artist.className = 'song-artist';
      artist.textContent = track.artist;
      info.append(title, artist);
      const next = document.createElement('button');
      next.className = 'next-track-button';
      next.textContent = store.room?.nextTrackId === track.id ? '已设下一首' : '下一首';
      next.setAttribute('aria-label', `将 ${track.title} 设为下一首`);
      next.setAttribute('aria-pressed', String(store.room?.nextTrackId === track.id));
      next.disabled =
        !store.joined || !store.connected || (!!activeIds && !activeIds.has(track.id));
      next.title =
        activeIds && !activeIds.has(track.id) ? '请先将此歌单设为播放范围' : '下次切歌优先播放';
      next.onclick = () => this.next(track.id);
      const remove = document.createElement('button');
      remove.className = 'icon-button delete-button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `删除 ${track.title}`);
      remove.onclick = () => this.remove(track);
      row.append(checkbox, play, info, next, remove);
      root.append(row);
    }
    if (!filtered.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = store.search
        ? '没有匹配的歌曲'
        : playlist
          ? '歌单还空着，从全部歌曲中勾选并批量加入吧'
          : '曲库还空着，上传第一首音乐吧';
      root.append(p);
    }
  }
  storage(s: StorageUsage): void {
    element('storage-remaining').textContent =
      `剩余 ${(s.remainingBytes / 1e6).toFixed(1)} MB / 共 ${storageCapacity(s.limitBytes)}`;
    element('storage-used').style.width =
      `${((s.occupiedBytes - s.pendingDeleteBytes) / s.limitBytes) * 100}%`;
    element('storage-pending').style.width = `${(s.pendingDeleteBytes / s.limitBytes) * 100}%`;
    element('storage-reserved').style.width = `${(s.reservedBytes / s.limitBytes) * 100}%`;
    element('storage-detail').textContent =
      `已用 ${(s.occupiedBytes / 1e6).toFixed(1)} MB · 待清理 ${(s.pendingDeleteBytes / 1e6).toFixed(1)} · 预留 ${(s.reservedBytes / 1e6).toFixed(1)}`;
  }
  uploads(tasks: UploadTaskView[]): void {
    const root = element('uploads');
    root.replaceChildren();
    for (const task of tasks.slice(-5)) {
      const row = document.createElement('div');
      row.className = 'upload-task';
      const name = document.createElement('span');
      name.textContent = task.fileName;
      const status = document.createElement('span');
      status.textContent =
        task.phase === 'uploading'
          ? `${Math.round((task.sentBytes / task.totalBytes) * 100)}%`
          : task.phase === 'validating'
            ? '校验中…'
            : task.phase === 'completed'
              ? '已加入歌单'
              : task.phase === 'queued'
                ? '排队中'
                : task.errorMessage || '上传失败';
      row.append(name, status);
      root.append(row);
    }
  }
}
export class PlayerView {
  dragging = false;
  render(store: ClientStore, status: string, position: number): void {
    const s = store.room,
      track = store.tracks.find((t) => t.id === s?.trackId);
    element('current-title').textContent =
      track?.title || (store.tracks.length ? '选择一首开始播放' : '上传第一首音乐');
    element('current-artist').textContent = track?.artist || '与朋友分享此刻';
    const nextTrack = store.tracks.find((t) => t.id === s?.nextTrackId);
    element('next-track-name').textContent = nextTrack
      ? `下一首：${nextTrack.title}`
      : '尚未指定下一首';
    element<HTMLButtonElement>('clear-next').hidden = !s?.nextTrackId;
    element<HTMLButtonElement>('clear-next').disabled = !store.joined || !store.connected;
    element('player-playlist-name').textContent =
      `播放歌单：${store.playlists.find((p) => p.id === s?.playlistId)?.name ?? '全部歌曲'}`;
    element('play-status').textContent =
      s?.status === 'playing' ? 'NOW PLAYING' : s?.trackId ? 'PAUSED' : 'READY TO LISTEN';
    element('sync-status').textContent = status;
    element('toggle-play').textContent = s?.status === 'playing' ? 'Ⅱ' : '▶';
    element('toggle-play').setAttribute('aria-label', s?.status === 'playing' ? '暂停' : '播放');
    document
      .querySelector('.record-art')
      ?.classList.toggle('playing', s?.status === 'playing' && store.joined);
    const seek = element<HTMLInputElement>('seek');
    seek.max = String(s?.durationSeconds || 1);
    if (!this.dragging) {
      seek.value = String(position);
      element('position').textContent = time(position);
    }
    element('duration').textContent = time(s?.durationSeconds || 0);
    for (const id of ['previous', 'next', 'toggle-play', 'repeat-mode', 'shuffle-mode', 'seek'])
      element<HTMLButtonElement>(id).disabled =
        !store.connected || !store.joined || (id === 'seek' && !s?.trackId);
    element('repeat-mode').setAttribute('aria-pressed', String(s?.playbackMode === 'repeat-one'));
    element('shuffle-mode').setAttribute('aria-pressed', String(s?.playbackMode === 'shuffle'));
    const presence = element('presence');
    const names = store.presence?.nicknames || [];
    const key = JSON.stringify(names);
    if (presence.dataset.members !== key) {
      presence.dataset.members = key;
      presence.replaceChildren();
      for (const name of names) {
        const member = document.createElement('li');
        member.className = 'member-chip';
        member.textContent = name;
        presence.append(member);
      }
      if (!names.length) {
        const empty = document.createElement('li');
        empty.className = 'members-empty';
        empty.textContent = '暂无成员';
        presence.append(empty);
      }
    }
  }
}
export class DeleteDialog {
  track: TrackSummary | null = null;
  readonly dialog = element<HTMLDialogElement>('delete-dialog');
  open(track: TrackSummary): void {
    this.track = track;
    element('delete-title').textContent = track.title;
    element('delete-error').textContent = '';
    element<HTMLButtonElement>('delete-confirm').disabled = false;
    this.dialog.showModal();
  }
  close(): void {
    this.track = null;
    this.dialog.close();
  }
}
