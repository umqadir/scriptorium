/**
 * Session timing. The timer starts on the first keystroke (not on mount),
 * pauses automatically after a few seconds of inactivity so a tab left open
 * overnight doesn't tank the WPM, and resumes cleanly on the next keystroke.
 */

export type SessionClockOptions = {
  /** Idle timeout before the clock auto-pauses. Default 5000ms. */
  idleTimeoutMs?: number;
  /** Injectable clock for deterministic tests. Default Date.now. */
  now?: () => number;
};

export class SessionClock {
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;

  private startedAt: number | null = null;
  private segmentStart: number | null = null;
  private accumulatedMs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyPaused = false;

  constructor(opts: SessionClockOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Has the timer ever been started (i.e. has a keystroke ever happened)? */
  hasStarted(): boolean {
    return this.startedAt !== null;
  }

  /** Is a running segment currently accumulating elapsed time? */
  isRunning(): boolean {
    return this.segmentStart !== null;
  }

  /** Call on every accepted keystroke. Starts the timer on the first call,
   * resumes from idle/pause-adjacent state, and resets the idle timeout. */
  recordActivity(): void {
    if (this.explicitlyPaused) return;
    const t = this.now();
    if (this.startedAt === null) this.startedAt = t;
    if (this.segmentStart === null) this.segmentStart = t;
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.goIdle(), this.idleTimeoutMs);
  }

  private goIdle(): void {
    this.idleTimer = null;
    if (this.segmentStart === null) return;
    this.accumulatedMs += this.now() - this.segmentStart;
    this.segmentStart = null;
  }

  /** Explicit pause (distinct from idle auto-pause): freezes elapsed time
   * immediately and ignores recordActivity() until resume() is called. */
  pause(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.segmentStart !== null) {
      this.accumulatedMs += this.now() - this.segmentStart;
      this.segmentStart = null;
    }
    this.explicitlyPaused = true;
  }

  /** Lift an explicit pause. Does not itself resume the running segment -
   * that happens on the next recordActivity() call, so idle time between
   * resume() and the next keystroke still isn't counted. */
  resume(): void {
    this.explicitlyPaused = false;
  }

  /** Total elapsed "active" time in ms, excluding idle/paused gaps. */
  elapsedMs(): number {
    if (this.segmentStart !== null) {
      return this.accumulatedMs + (this.now() - this.segmentStart);
    }
    return this.accumulatedMs;
  }

  destroy(): void {
    // Finalize a live segment as well as clearing the timer. Otherwise a
    // caller retaining the clock long enough to read final stats would see
    // elapsed time continue increasing after teardown.
    this.pause();
  }
}
