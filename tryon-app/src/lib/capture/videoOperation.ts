/** One recording/upload attempt. Old callbacks cannot revive a cancelled attempt. */
export class VideoOperation {
  readonly id = crypto.randomUUID();
  readonly controller = new AbortController();
  private finished = false;
  get active() { return !this.finished && !this.controller.signal.aborted; }
  fetch(url: string, init: RequestInit = {}) {
    this.controller.signal.throwIfAborted();
    const headers = new Headers(init.headers);
    headers.set("x-video-operation", this.id);
    return fetch(url, { ...init, headers, signal: this.controller.signal });
  }
  finish() { this.finished = true; }
  cancel() {
    if (!this.active) return;
    this.controller.abort();
    // Explicit cancellation also covers a request whose response already reached the browser.
    void fetch(`/api/video-operations/${this.id}`, { method: "DELETE", keepalive: true }).catch(() => {});
  }
}
