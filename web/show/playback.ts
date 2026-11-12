/**
 * 播放与时间轴：按帧调度处理单元，运行脚本在静止时注入下一批（§9.4）。
 *
 * 时间轴：后退或跳转时，从初值重新执行到目标处理单元。执行是确定的，输入按记录的位置
 * （注入时已完成的处理单元数）重新注入，所以不需要快照；继续前进时，记录的输入照原位置重放。
 * 手动发送新的输入会让时间轴从当前位置分叉，之后记录的输入不再重放。
 * 页面调度预算（每帧单元数与时间）不是规则。
 */

import { APP_CONFIG } from "./config.ts";
import { type Injection, Session, type Unit } from "./session.ts";
import { current, state } from "./state.ts";
import { errorMessage } from "./ui/dom.ts";

export interface PlaybackHooks {
  /** 立即刷新全部显示。 */
  render(): void;
  /** 在下一帧刷新（播放中合并多次刷新）。 */
  requestRender(): void;
  /** 播放一个单元的动画，返回动画时长（毫秒）。single 为单步。 */
  animate(unit: Unit | null, single: boolean): number;
  message(text: string, error?: boolean): void;
  skip(): boolean;
  speed(): number;
  /** 运行控制的“批执行”（§7.5）。 */
  batch(): boolean;
}

export class Playback {
  running = false;
  scriptBatches: string[][] | null = null;
  nextBatch = 0;
  /** 本时间轴到达过的最远处理单元。 */
  furthest = 0;
  /** 后退之后，记录中还没有重新注入的输入。 */
  private future: Injection[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private version = 0;
  private runStart = 0;
  private nextDelay = 0;
  /** 播放中已静止（已提示过，等待新的输入）。 */
  private quiet = false;
  private readonly hooks: PlaybackHooks;

  constructor(hooks: PlaybackHooks) {
    this.hooks = hooks;
  }

  /** 换成新的会话（新模型、重载、运行脚本）：时间轴重新开始。 */
  begin(session: Session, script: string[][] | null = null): void {
    this.pause();
    session.ex.batch = this.hooks.batch();
    state.session = session;
    state.unit = null;
    state.unitStep = -1;
    this.scriptBatches = script;
    this.nextBatch = 0;
    this.future = [];
    this.furthest = 0;
  }

  /** 手动发送一批输入（§9.1）：时间轴从当前位置分叉，运行脚本也就此结束。播放中发送时不暂停，输入接着被处理。 */
  inject(paths: unknown): number {
    const { session } = current();
    const count = session.injectBatch(paths);
    this.future = [];
    this.scriptBatches = null;
    this.wake();
    return count;
  }

  /** 播放中已处理到静止：播放循环注入完待注入的输入后确认静止，并且之后没有新的输入。 */
  get settled(): boolean {
    return this.running && this.quiet && Boolean(state.session?.idle);
  }

  timeline(): string {
    const units = state.session?.units ?? 0;
    return `第 ${units} 个处理单元 · 已到第 ${Math.max(this.furthest, units)} 个`;
  }

  /** 处理单元之间的输入：先按记录的位置重新注入，再按运行脚本在静止时注入下一批。 */
  private feed(session: Session): void {
    while (this.future.length && this.future[0].at === session.units) {
      const entry = this.future.shift()!;
      session.injectBatch(entry.paths, entry.script);
      if (entry.script) this.nextBatch++;
    }
    if (this.future.length && session.idle && this.future[0].at > session.units) this.future = []; // 记录与现场不再对应
    if (!this.future.length && session.idle && this.scriptBatches && this.nextBatch < this.scriptBatches.length) {
      session.injectBatch(this.scriptBatches[this.nextBatch++], true);
    }
  }

  private advance(session: Session, detail: boolean): Unit | null {
    this.feed(session);
    const unit = session.step(detail);
    this.furthest = Math.max(this.furthest, session.units);
    if (unit) {
      state.unit = unit;
      state.unitStep = -1;
    }
    return unit;
  }

  /** 单步：处理一个单元并播放它的动画。 */
  step(): Unit | null {
    this.pause();
    const { session } = current();
    try {
      const unit = this.advance(session, true);
      this.hooks.animate(unit, true);
      return unit;
    } finally {
      this.hooks.render();
    }
  }

  /** 后退一个处理单元。 */
  back(): void {
    const { session } = current();
    if (session.units === 0) throw new Error("已经在初值，不能再后退");
    this.jumpTo(session.units - 1);
  }

  /** 跳到第 target 个处理单元：向前时从初值重新执行，向后时继续执行（都按记录的位置注入输入）。 */
  jumpTo(target: number): void {
    this.pause();
    const { loaded, session } = current();
    if (!Number.isInteger(target) || target < 0) throw new Error("处理单元编号必须是非负整数");
    let next = session;
    if (target < session.units || session.stopped) {
      const history = [...session.journal, ...this.future];
      next = new Session(loaded.model, APP_CONFIG.view.traceRows);
      this.future = history;
      this.nextBatch = 0;
      state.session = next;
    }
    state.unit = null;
    state.unitStep = -1;
    next.ex.batch = false; // 跳转要停在指定的处理单元上：逐个执行，结束后恢复
    try {
      while (next.units < target) {
        this.feed(next);
        if (next.idle) break;
        next.step(false);
      }
    } finally {
      next.ex.batch = this.hooks.batch();
      this.furthest = Math.max(this.furthest, next.units);
      this.hooks.render();
    }
  }

  /** 播放按钮：在播放中与暂停中之间切换。 */
  play(): void {
    if (this.running) {
      this.pause();
      this.hooks.render();
      return;
    }
    this.start();
  }

  /** 进入播放中（已在播放时不变）。刚打开、换模型、重载、执行运行脚本之后调用。 */
  start(): void {
    if (this.running) return;
    const { session } = current();
    if (session.stopped) throw new Error("执行已停止，请重载或后退后再运行");
    this.running = true;
    this.quiet = false;
    this.version++;
    this.runStart = session.units;
    this.nextDelay = 0;
    this.hooks.render();
    this.schedule();
  }

  pause(): void {
    this.running = false;
    this.quiet = false;
    this.version++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private interval(): number {
    return APP_CONFIG.playback.duration * 1000 / this.hooks.speed();
  }

  private tick(generation: number): void {
    if (!this.running || generation !== this.version) return;
    try {
      const { session } = current();
      const skip = this.hooks.skip();
      const started = performance.now();
      let count = 0;
      let delay = 0;
      do {
        this.feed(session);
        if (session.idle) { // 播放到静止不停下：保持播放中，等待新的输入
          if (!this.quiet) {
            this.quiet = true;
            this.hooks.message(this.scriptBatches ? `运行脚本完成 · ${this.nextBatch} 批 · ${session.ex.outputs.length} 条输出；播放中，等待新的输入。` : "两个 FIFO 都已为空（静止）；播放中，等待新的输入。");
            count++;
          }
          break;
        }
        if (this.quiet) {
          this.quiet = false;
          this.runStart = session.units; // 单元预算按每段连续处理计
        }
        const unit = this.advance(session, !skip);
        count++;
        if (!skip) delay = this.hooks.animate(unit, false);
        if (session.units - this.runStart >= APP_CONFIG.engine.playUnits) {
          this.pause();
          this.hooks.message("已达到本次播放的处理单元预算，FIFO 完整保留；可继续播放。");
          break;
        }
      } while (this.running && generation === this.version && skip && count < APP_CONFIG.engine.frameUnits
        && performance.now() - started < APP_CONFIG.engine.frameBudgetMs * this.hooks.speed());
      // 没有画面的单元（动画时长为 0）不等单元间隔，接着处理下一个单元。
      this.nextDelay = skip || delay === 0 ? 0 : Math.max(delay, this.interval());
      if (!count) return; // 静止中没有变化，不刷新
      if (this.running && !this.quiet) this.hooks.requestRender();
      else this.hooks.render();
    } catch (error) {
      this.pause();
      this.hooks.message(errorMessage(error), true);
      this.hooks.render();
    }
  }

  /** 播放中已静止时，新输入到达就重新开始处理（静止时不轮询，只靠这里唤醒）。 */
  private wake(): void {
    if (!this.running || !this.quiet) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.nextDelay = 0;
    this.schedule();
  }

  private schedule(): void {
    if (!this.running || this.timer !== null) return;
    const generation = this.version;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running || generation !== this.version) return;
      this.tick(generation);
      if (this.running && !this.quiet) this.schedule(); // 静止后停止调度，等 wake()
    }, this.nextDelay);
  }
}
