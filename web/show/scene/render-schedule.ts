/** 限制向 GPU 提交绘制的频率，与 FIFO 执行和界面更新相互独立。 */

export interface ScheduleSettings {
  idleFps?: number;
  activeFps?: number;
  interactionTailMs?: number;
  maxDeltaMs?: number;
}

export class RenderSchedule {
  private readonly idleInterval: number;
  private readonly activeInterval: number;
  private readonly interactionTailMs: number;
  private readonly maxDeltaMs: number;
  private interactionUntil = -Infinity;
  private dirty = true;
  private lastSample: number | null = null;
  private lastDraw: number | null = null;
  private nextDraw: number | null = null;
  private interval: number | null = null;
  private elapsed = 0;

  constructor({ idleFps = 30, activeFps = 60, interactionTailMs = 180, maxDeltaMs = 100 }: ScheduleSettings = {}) {
    if (![idleFps, activeFps, maxDeltaMs].every((value) => Number.isFinite(value) && value > 0)
      || !Number.isFinite(interactionTailMs) || interactionTailMs < 0) throw new RangeError("绘制频率设置无效");
    this.idleInterval = 1000 / idleFps;
    this.activeInterval = 1000 / activeFps;
    this.interactionTailMs = interactionTailMs;
    this.maxDeltaMs = maxDeltaMs;
  }

  invalidate(): void {
    this.dirty = true;
  }

  interact(now: number): void {
    this.interactionUntil = now + this.interactionTailMs;
    this.invalidate();
  }

  /** 页面可见性变化时调用（浏览器可能在隐藏前就暂停了动画帧）。 */
  resetClock(): void {
    this.lastSample = null;
    this.lastDraw = null;
    this.nextDraw = null;
    this.elapsed = 0;
    this.invalidate();
  }

  sample(now: number, { animate = true, active = false, hidden = false } = {}): { deltaSeconds: number } | null {
    if (hidden) {
      this.resetClock();
      return null;
    }
    if (this.lastSample !== null && now < this.lastSample) this.resetClock();
    const delta = this.lastSample === null ? 0 : Math.min(now - this.lastSample, this.maxDeltaMs);
    this.lastSample = now;
    this.elapsed = animate ? this.elapsed + delta : 0;
    const interacting = active || now < this.interactionUntil;
    if (!this.dirty && !animate && !interacting) return null;
    const interval = interacting || !animate ? this.activeInterval : this.idleInterval;
    if (this.interval !== interval) {
      this.interval = interval;
      this.nextDraw = this.lastDraw === null ? null : this.lastDraw + interval;
    }
    if (this.nextDraw !== null && now + 1e-6 < this.nextDraw) return null;
    const result = { deltaSeconds: this.elapsed / 1000 };
    this.elapsed = 0;
    this.dirty = false;
    this.lastDraw = now;
    // 120／144 Hz 下保留小数截止时间，但不补画落下的帧。
    this.nextDraw = this.nextDraw === null ? now + interval
      : this.nextDraw + (Math.floor(Math.max(0, now + 1e-6 - this.nextDraw) / interval) + 1) * interval;
    return result;
  }
}
