import type { TrackSummary, StorageUsage, Playlist } from '../shared/models.js';
export class RequestError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}
export class ApiClient {
  csrf = '';
  async request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const response = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const value = await response.json();
    if (!response.ok) throw new RequestError(value.message || '请求失败', value.code);
    return value;
  }
  async session(): Promise<void> {
    const v = await this.request<{ csrfToken: string }>('/session');
    this.csrf = v.csrfToken;
  }
  async login(password: string): Promise<void> {
    const v = await this.request<{ csrfToken: string }>('/login', 'POST', { password });
    this.csrf = v.csrfToken;
  }
  async tracks(): Promise<TrackSummary[]> {
    return (await this.request<{ tracks: TrackSummary[] }>('/tracks')).tracks;
  }
  async playlists(): Promise<Playlist[]> {
    return (await this.request<{ playlists: Playlist[] }>('/playlists')).playlists;
  }
  storage(): Promise<StorageUsage> {
    return this.request('/storage');
  }
  upload(file: File, progress: (bytes: number, validating: boolean) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/tracks');
      xhr.setRequestHeader('X-CSRF-Token', this.csrf);
      xhr.setRequestHeader('X-File-Size', String(file.size));
      xhr.timeout = 190000;
      xhr.upload.onprogress = (event) =>
        progress(
          Math.min(file.size, Math.round((event.loaded / (event.total || file.size)) * file.size)),
          false,
        );
      xhr.upload.onload = () => progress(file.size, true);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          let message = '上传失败';
          try {
            message = JSON.parse(xhr.responseText).message;
          } catch {}
          reject(new Error(message));
        }
      };
      xhr.onerror = () => reject(new Error('网络中断，上传失败'));
      xhr.ontimeout = () => reject(new Error('上传超时，请重试'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      const form = new FormData();
      form.append('file', file, file.name);
      xhr.send(form);
    });
  }
}
let sequence = 0;
export function requestId(): string {
  return `${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2)}`;
}
export class RoomConnection {
  private socket?: WebSocket;
  private stopped = true;
  private retry = 0;
  private timer?: number;
  constructor(
    private onMessage: (message: any) => void,
    private onStatus: (connected: boolean) => void,
  ) {}
  connect(): void {
    this.stopped = false;
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
    );
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.retry = 0;
      this.onStatus(true);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        this.onMessage(JSON.parse(event.data));
      } catch (e) {
        console.error(e);
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.onStatus(false);
      if (event.code === 4001 || event.code === 4003) {
        this.stopped = true;
        this.onMessage({ type: 'sessionClosed', code: event.code });
      }
      if (!this.stopped)
        this.timer = window.setTimeout(
          () => this.connect(),
          Math.min(15000, 1000 * 2 ** this.retry++) + Math.random() * 500,
        );
    };
    socket.onerror = () => socket.close();
  }
  send(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('连接中断，请等待重连');
    this.socket.send(JSON.stringify(message));
  }
  disconnect(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.onStatus(false);
  }
}
