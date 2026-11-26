/**
 * Single-flight poller.
 *  - Never runs two ticks at once; a manual `now()` during a tick is coalesced.
 *  - The task returns the delay before the next tick, or null to stop.
 *  - Pauses while the tab is hidden and refreshes as soon as it is visible.
 *  - Backs off exponentially on errors, up to 60 seconds.
 */
export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private queued = false;
  private failures = 0;
  private stopped = false;
  private paused = false;

  constructor(
    private readonly task: () => Promise<number | null>,
    private readonly options: { fatal?: (error: unknown) => boolean; onError?: (error: unknown) => void } = {},
  ) {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private onVisibility = () => {
    if (document.hidden) {
      this.paused = true;
      this.clear();
    } else if (this.paused) {
      this.paused = false;
      if (!this.stopped) void this.now();
    }
  };

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Run a tick immediately (or right after the current one). */
  async now(): Promise<void> {
    this.stopped = false;
    if (this.running) {
      this.queued = true;
      return;
    }
    this.clear();
    this.running = true;
    let next: number | null = null;
    try {
      next = await this.task();
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      this.options.onError?.(error);
      if (this.options.fatal?.(error)) {
        this.stopped = true;
        next = null;
      } else {
        next = Math.min(60_000, 5_000 * 2 ** (this.failures - 1));
      }
    } finally {
      this.running = false;
    }
    if (this.queued) {
      this.queued = false;
      return this.now();
    }
    if (next !== null && !this.stopped && !this.paused && !document.hidden) {
      this.timer = setTimeout(() => void this.now(), next);
    }
  }

  get isScheduled(): boolean {
    return this.timer !== null;
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  destroy(): void {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
