import type { Playlist } from '../shared/models.js';
import type { Action } from '../shared/protocol.js';
import { AUDIO_FILE_ACCEPT, isSupportedAudioName, MAX_AUDIO_FILE_BYTES } from '../shared/limits.js';
import { ApiClient, RoomConnection, requestId, RequestError } from './transport.js';
import { AudioPlayer, ClockEstimator, SyncController, MediaSessionBridge } from './audio.js';
import { ClientStore } from './state.js';
import { AppShell, element } from './shell.js';
import { PlaylistView, PlayerView, DeleteDialog, time } from './views.js';
export class ClientApplication {
  readonly api = new ApiClient();
  readonly store = new ClientStore();
  readonly shell = new AppShell();
  readonly audio = new AudioPlayer(element<HTMLAudioElement>('audio'));
  readonly clock = new ClockEstimator();
  readonly sync = new SyncController(this.audio, this.clock);
  readonly media = new MediaSessionBridge();
  readonly connection = new RoomConnection(
    (m) => this.message(m),
    (connected) => this.connectionStatus(connected),
  );
  readonly playlist = new PlaylistView(
    (id) =>
      this.control({ action: 'selectTrack', trackId: id, playlistId: this.store.browsePlaylistId }),
    (track) => this.dialog.open(track),
    (id) => this.control({ action: 'setNextTrack', trackId: id }),
    (id, selected) => {
      if (selected) this.store.selectedTracks.add(id);
      else this.store.selectedTracks.delete(id);
      this.playlist.render(this.store);
    },
  );
  readonly player = new PlayerView();
  readonly dialog = new DeleteDialog();
  private wanted = true;
  private wasJoined = false;
  private disposed = false;
  private uploading = false;
  private refreshRunning = false;
  private refreshAgain = false;
  private probes = new Map<string, number>();
  private intervals: number[] = [];
  private editingPlaylistId: string | null = null;
  async mount(): Promise<void> {
    window.addEventListener('pagehide', () => this.connection.disconnect());
    window.addEventListener('pageshow', (event) => {
      if (event.persisted && !this.disposed && element('login-screen').hidden)
        this.connection.connect();
    });
    element<HTMLInputElement>('upload-input').accept = AUDIO_FILE_ACCEPT;
    this.shell.tab('playlist');
    element<HTMLFormElement>('login-form').onsubmit = (e) => {
      e.preventDefault();
      void this.enter();
    };
    element('show-password').onclick = () => {
      const input = element<HTMLInputElement>('password');
      input.type = input.type === 'password' ? 'text' : 'password';
      element('show-password').textContent = input.type === 'password' ? '显示' : '隐藏';
    };
    element('logout').onclick = () => void this.logout();
    element('tab-playlist').onclick = () => this.shell.tab('playlist');
    element('tab-player').onclick = () => this.shell.tab('player');
    element('toggle-play').onclick = () =>
      this.control({ action: this.store.room?.status === 'playing' ? 'pause' : 'play' });
    element('previous').onclick = () => this.control({ action: 'previous' });
    element('next').onclick = () => this.control({ action: 'next' });
    element('clear-next').onclick = () => this.control({ action: 'setNextTrack', trackId: null });
    element<HTMLSelectElement>('browse-playlist').onchange = (e) => {
      this.store.browsePlaylistId = (e.target as HTMLSelectElement).value || null;
      this.store.selectedTracks.clear();
      this.playlist.render(this.store);
    };
    element('activate-playlist').onclick = () =>
      this.control({ action: 'setPlaylist', playlistId: this.store.browsePlaylistId });
    element('create-playlist').onclick = () => this.openPlaylistDialog();
    element('rename-playlist').onclick = () => this.openPlaylistDialog(true);
    element<HTMLFormElement>('playlist-form').onsubmit = (e) => {
      e.preventDefault();
      void this.savePlaylist();
    };
    element('playlist-cancel').onclick = () =>
      element<HTMLDialogElement>('playlist-dialog').close();
    element<HTMLInputElement>('select-visible').onchange = (e) => {
      for (const track of this.store.visibleTracks()) {
        if ((e.target as HTMLInputElement).checked) this.store.selectedTracks.add(track.id);
        else this.store.selectedTracks.delete(track.id);
      }
      this.playlist.render(this.store);
    };
    element('add-selected').onclick = () => void this.changePlaylistTracks('add');
    element('remove-selected').onclick = () => void this.changePlaylistTracks('remove');
    element('repeat-mode').onclick = () =>
      this.control({ action: 'setPlaybackMode', playbackMode: 'repeat-one' });
    element('shuffle-mode').onclick = () =>
      this.control({ action: 'setPlaybackMode', playbackMode: 'shuffle' });
    const seek = element<HTMLInputElement>('seek');
    seek.oninput = () => {
      this.player.dragging = true;
      element('position').textContent = time(Number(seek.value));
    };
    seek.onchange = () => {
      this.player.dragging = false;
      if (this.store.room?.trackId)
        this.control({
          action: 'seek',
          trackId: this.store.room.trackId,
          positionSeconds: Number(seek.value),
        });
    };
    seek.onpointercancel = () => {
      this.player.dragging = false;
    };
    seek.onblur = () => {
      this.player.dragging = false;
    };
    element<HTMLInputElement>('volume').oninput = (e) => {
      const volume = Number((e.target as HTMLInputElement).value);
      this.audio.element.volume = volume;
      element('volume-label').textContent = `${Math.round(volume * 100)}%`;
    };
    element<HTMLInputElement>('search').oninput = (e) => {
      this.store.search = (e.target as HTMLInputElement).value;
      this.playlist.render(this.store);
    };
    element<HTMLInputElement>('upload-input').onchange = (e) => {
      const input = e.target as HTMLInputElement;
      void this.upload([...(input.files || [])]);
      input.value = '';
    };
    element('delete-confirm').onclick = () => void this.confirmDelete();
    this.dialog.dialog.addEventListener('close', () => {
      this.dialog.track = null;
    });
    element('notice-action').onclick = () => void this.resume();
    for (const event of ['loadedmetadata', 'canplay', 'playing', 'waiting'])
      this.audio.element.addEventListener(event, () => {
        void this.sync.reconcile(true).then(() => this.render());
      });
    // The server owns looping. Replaying a finished element here can emit ended again
    // before the server advances, flooding getState requests on short Ogg clips.
    this.audio.element.addEventListener('ended', () => {
      this.send({ type: 'getState', requestId: requestId() });
    });
    this.audio.element.addEventListener('error', () => {
      if (this.audio.trackId) {
        this.sync.status = '音频加载失败';
        this.shell.notice('音频加载失败，请检查网络或点击重试', '重试收听');
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.store.connected) {
        this.probe();
        void this.refresh();
        void this.sync.reconcile(true);
      }
    });
    window.addEventListener('online', () => {
      if (this.store.connected) {
        this.probe();
        void this.refresh();
      }
    });
    this.media.attach({
      play: () => this.control({ action: 'play' }),
      pause: () => this.control({ action: 'pause' }),
      next: () => this.control({ action: 'next' }),
      previous: () => this.control({ action: 'previous' }),
      seek: (seconds) => {
        if (this.store.room?.trackId)
          this.control({
            action: 'seek',
            trackId: this.store.room.trackId,
            positionSeconds: seconds,
          });
      },
    });
    this.intervals.push(
      window.setInterval(() => {
        void this.sync.reconcile().then(() => this.render());
      }, 1000),
    );
    this.intervals.push(
      window.setInterval(() => {
        if (this.store.connected) this.probe();
      }, 30000),
    );
    this.intervals.push(
      window.setInterval(() => {
        if (this.store.connected) void this.refresh();
      }, 15000),
    );
    try {
      await this.api.session();
      this.openRoom();
    } catch (e) {
      if (!(e instanceof RequestError && e.code === 'UNAUTHENTICATED'))
        this.shell.toast('暂时无法连接服务器，请稍后重试');
    }
  }
  private async enter(): Promise<void> {
    const button = element<HTMLButtonElement>('enter-button');
    button.disabled = true;
    element('login-error').textContent = '';
    const unlocked = this.audio.unlock().catch(() => {});
    try {
      await this.api.login(element<HTMLInputElement>('password').value);
      await this.api.request('/session', 'PATCH', {
        nickname: element<HTMLInputElement>('nickname').value,
      });
      await unlocked;
      element<HTMLInputElement>('password').value = '';
      this.openRoom();
    } catch (e) {
      element('login-error').textContent = (e as Error).message;
    } finally {
      button.disabled = false;
    }
  }
  private openRoom(): void {
    this.disposed = false;
    this.wanted = true;
    this.shell.room();
    this.connection.connect();
    void this.refresh();
  }
  private connectionStatus(connected: boolean): void {
    this.store.connected = connected;
    this.sync.connected = connected;
    if (!connected) {
      this.store.joined = false;
      this.sync.active = false;
      this.sync.disconnect();
      if (!this.disposed) this.shell.notice('连接中断，正在重连…');
    }
    this.render();
    this.playlist.render(this.store);
  }
  private message(m: any): void {
    switch (m.type) {
      case 'hello':
        this.clock.reset();
        this.probeBurst();
        this.store.presence = m.presence;
        if (this.wanted)
          this.send({ type: 'join', requestId: requestId(), takeover: this.wasJoined });
        this.sync.accept(m.state);
        break;
      case 'joined':
        this.store.joined = true;
        this.wasJoined = true;
        this.sync.active = true;
        this.sync.accept(m.state);
        this.shell.notice('');
        this.playlist.render(this.store);
        break;
      case 'state':
        this.store.presence = m.presence || this.store.presence;
        if (
          this.store.room &&
          this.store.room.epoch === m.state.epoch &&
          this.store.room.revision > m.state.revision
        )
          return;
        {
          const changed =
            this.store.room?.trackId !== m.state.trackId ||
            this.store.room?.nextTrackId !== m.state.nextTrackId ||
            this.store.room?.playlistId !== m.state.playlistId;
          this.store.room = m.state;
          this.sync.accept(m.state);
          if (changed) this.playlist.render(this.store);
        }
        break;
      case 'timeReply': {
        const sent = this.probes.get(m.requestId);
        if (sent === undefined) break;
        this.probes.delete(m.requestId);
        this.clock.addSample({
          clientSentMs: sent,
          serverReceivedMs: m.serverReceivedMs,
          serverSentMs: m.serverSentMs,
          clientReceivedMs: performance.now(),
        });
        void this.sync.reconcile(true);
        break;
      }
      case 'libraryChanged':
      case 'storageChanged':
        void this.refresh();
        break;
      case 'takenOver':
        this.wanted = false;
        this.sync.active = false;
        this.audio.element.pause();
        this.shell.notice('此房间已由另一个标签页接管', '重新加入');
        break;
      case 'sessionClosed':
        this.store.joined = false;
        this.sync.active = false;
        this.audio.stop();
        if (m.code === 4001) {
          this.disposed = true;
          this.shell.login();
          this.shell.toast('已退出或登录过期');
        }
        break;
      case 'error':
        if (m.state) {
          this.store.room = m.state;
          this.sync.accept(m.state);
        }
        if (m.code === 'ROOM_FULL') {
          this.sync.active = false;
          this.shell.notice(m.message, '重试加入');
        } else if (m.code === 'TAKEOVER_REQUIRED') {
          this.wanted = false;
          this.shell.notice(m.message, '接管收听');
        } else if (m.code === 'LEASE_EXPIRED') {
          this.store.joined = false;
          this.sync.active = false;
          this.shell.notice('请重新加入收听', '加入收听');
        } else this.shell.toast(m.message);
        break;
    }
    this.store.room = this.sync.state;
    this.render();
  }
  private send(message: Record<string, unknown>): void {
    try {
      this.connection.send(message);
    } catch (e) {
      if (!this.disposed) this.shell.toast((e as Error).message);
    }
  }
  private probe(): void {
    const id = requestId(),
      now = performance.now();
    if (this.probes.size > 30) this.probes.clear();
    this.probes.set(id, now);
    this.send({ type: 'timeProbe', requestId: id, clientSentMs: now });
  }
  private probeBurst(): void {
    for (let i = 0; i < 5; i++)
      window.setTimeout(() => {
        if (this.store.connected) this.probe();
      }, i * 150);
  }
  control(action: Action): void {
    if (!this.store.joined || !this.store.connected || !this.store.room) {
      this.shell.toast('请先加入收听');
      return;
    }
    this.send({ type: 'control', ...action, epoch: this.store.room.epoch, commandId: requestId() });
  }
  private async resume(): Promise<void> {
    try {
      await this.audio.unlock();
    } catch {}
    this.wanted = true;
    if (!this.store.connected) {
      this.connection.disconnect();
      this.connection.connect();
      return;
    }
    if (!this.store.joined) this.send({ type: 'join', requestId: requestId(), takeover: true });
    else {
      this.sync.active = true;
      void this.sync.reconcile(true);
      this.shell.notice('');
    }
  }
  private async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshRunning) {
      this.refreshAgain = true;
      return;
    }
    this.refreshRunning = true;
    try {
      do {
        this.refreshAgain = false;
        const [tracks, storage, playlists] = await Promise.all([
          this.api.tracks(),
          this.api.storage(),
          this.api.playlists(),
        ]);
        if (this.disposed) return;
        this.store.tracks = tracks;
        this.store.storage = storage;
        this.store.playlists = playlists;
        const ready = new Set(tracks.map((track) => track.id));
        const members = this.store.browsePlaylistId
          ? new Set(playlists.find((p) => p.id === this.store.browsePlaylistId)?.trackIds ?? [])
          : null;
        for (const id of this.store.selectedTracks)
          if (!ready.has(id) || (members && !members.has(id))) this.store.selectedTracks.delete(id);
        this.playlist.render(this.store);
        this.playlist.storage(storage);
        if (this.dialog.track && !tracks.some((t) => t.id === this.dialog.track?.id)) {
          this.dialog.close();
          this.shell.toast('这首歌已被移除');
        }
        this.render();
      } while (this.refreshAgain);
    } catch (e) {
      if (e instanceof RequestError && e.code === 'UNAUTHENTICATED') {
        this.connection.disconnect();
        this.audio.stop();
        this.shell.login();
        this.disposed = true;
      } else this.shell.toast((e as Error).message);
    } finally {
      this.refreshRunning = false;
    }
  }
  private openPlaylistDialog(rename = false): void {
    const playlist = this.store.playlists.find((p) => p.id === this.store.browsePlaylistId);
    if (rename && !playlist) return;
    this.editingPlaylistId = rename ? playlist!.id : null;
    element('playlist-dialog-title').textContent = rename ? '修改歌单名称' : '创建歌单';
    element<HTMLInputElement>('playlist-name').value = rename ? playlist!.name : '';
    element('playlist-error').textContent = '';
    element<HTMLDialogElement>('playlist-dialog').showModal();
  }
  private async savePlaylist(): Promise<void> {
    const button = element<HTMLButtonElement>('playlist-save');
    button.disabled = true;
    const editingId = this.editingPlaylistId;
    try {
      const { playlist } = await this.api.request<{ playlist: Playlist }>(
        editingId ? `/playlists/${editingId}` : '/playlists',
        editingId ? 'PATCH' : 'POST',
        { name: element<HTMLInputElement>('playlist-name').value },
      );
      this.store.browsePlaylistId = playlist.id;
      this.store.selectedTracks.clear();
      element<HTMLDialogElement>('playlist-dialog').close();
      await this.refresh();
      this.shell.toast(editingId ? '歌单名称已更新' : '歌单已创建，可从全部歌曲中批量加入音乐');
    } catch (e) {
      element('playlist-error').textContent = (e as Error).message;
    } finally {
      button.disabled = false;
    }
  }
  private async changePlaylistTracks(operation: 'add' | 'remove'): Promise<void> {
    if (this.store.bulkBusy) return;
    const id =
      operation === 'add'
        ? element<HTMLSelectElement>('target-playlist').value
        : this.store.browsePlaylistId;
    if (!id || !this.store.selectedTracks.size) return;
    if (this.store.selectedTracks.size > 1000) {
      this.shell.toast('每次最多管理 1000 首歌曲，请减少勾选数量');
      return;
    }
    this.store.bulkBusy = true;
    this.playlist.render(this.store);
    try {
      await this.api.request(`/playlists/${id}/tracks`, 'POST', {
        operation,
        trackIds: [...this.store.selectedTracks],
      });
      this.store.selectedTracks.clear();
      await this.refresh();
      this.shell.toast(operation === 'add' ? '已加入歌单' : '已从歌单移出，音乐文件仍保留');
    } catch (e) {
      this.shell.toast((e as Error).message);
    } finally {
      this.store.bulkBusy = false;
      this.playlist.render(this.store);
    }
  }
  private async confirmDelete(): Promise<void> {
    const track = this.dialog.track;
    if (!track) return;
    const button = element<HTMLButtonElement>('delete-confirm');
    button.disabled = true;
    try {
      await this.api.request(`/tracks/${track.id}`, 'DELETE');
      this.dialog.close();
      await this.refresh();
    } catch (e) {
      element('delete-error').textContent = (e as Error).message;
    } finally {
      button.disabled = false;
    }
  }
  private async upload(files: File[]): Promise<void> {
    if (this.uploading) {
      this.shell.toast('请等待当前上传队列完成');
      return;
    }
    this.uploading = true;
    const tasks = files.map((file) => ({
      id: requestId(),
      fileName: file.name,
      sentBytes: 0,
      totalBytes: file.size,
      phase: 'queued' as const,
    }));
    this.store.uploads.push(...tasks);
    for (let i = 0; i < files.length; i++) {
      const task = this.store.uploads.find((t) => t.id === tasks[i].id)!;
      try {
        if (!isSupportedAudioName(files[i].name) || files[i].size > MAX_AUDIO_FILE_BYTES)
          throw new Error('仅支持不超过 50 MB 的 MP3 或 Ogg');
        task.phase = 'uploading';
        this.playlist.uploads(this.store.uploads);
        await this.api.upload(files[i], (bytes, validating) => {
          task.sentBytes = bytes;
          task.phase = validating ? 'validating' : 'uploading';
          this.playlist.uploads(this.store.uploads);
        });
        task.phase = 'completed';
      } catch (e) {
        task.phase = 'failed';
        task.errorMessage = (e as Error).message;
      }
      this.playlist.uploads(this.store.uploads);
      await this.refresh();
    }
    if (this.store.uploads.length > 20) this.store.uploads = this.store.uploads.slice(-20);
    this.uploading = false;
  }
  private render(): void {
    if (this.disposed) return;
    const status = this.store.connected ? this.sync.status : '正在重连';
    this.player.render(this.store, status, this.audio.element.currentTime || 0);
    const track = this.store.tracks.find((t) => t.id === this.store.room?.trackId);
    this.media.update(track, this.store.room, this.audio.element.currentTime || 0);
    if (status === '需要点击继续收听')
      this.shell.notice('浏览器需要你点一下才能继续播放', '继续收听');
  }
  private async logout(): Promise<void> {
    this.disposed = true;
    this.wanted = false;
    this.wasJoined = false;
    this.sync.active = false;
    this.audio.stop();
    this.connection.disconnect();
    try {
      await this.api.request('/logout', 'POST');
    } catch (e) {
      this.shell.toast((e as Error).message);
    }
    this.store.joined = false;
    this.store.room = null;
    this.shell.login();
  }
}
void new ClientApplication().mount();
