/** 可设种子的伪随机数（sfc32，种子经 splitmix32 展开），用于可重复的随机测试。 */
export class Random {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const next = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.random();
  }

  /** [0, 1) 的浮点数。 */
  random(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t / 4294967296;
  }

  /** [0, n) 的整数。 */
  randrange(n: number): number {
    return Math.floor(this.random() * n);
  }

  /** [lo, hi] 的整数。 */
  randint(lo: number, hi: number): number {
    return lo + this.randrange(hi - lo + 1);
  }

  choice<T>(items: readonly T[]): T {
    return items[this.randrange(items.length)];
  }

  /** 不重复地取 k 个，保持抽取顺序。 */
  sample<T>(items: readonly T[], k: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    for (let i = 0; i < k; i++) out.push(pool.splice(this.randrange(pool.length), 1)[0]);
    return out;
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.randrange(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}
