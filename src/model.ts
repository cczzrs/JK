/**
 * JKRD7 规则模型：加载 JKM、解析引用、静态检查（JKRD7 §2、§3、§5、§6.4、§8），
 * 以及运行脚本（§9.4）与快照（§9.5）的检查。执行见 cpu.ts 与 gpu/。
 *
 * 只依赖语言本身，命令行（Node）与浏览器共用。
 */

export const VERSION = "7.0.0";

const Q_ID = /^Q[1-9][0-9]*$/;
const G_ID = /^G[1-9][0-9]*$/;
const JKI_FIELDS = ["id", "q", "trigger", "sources", "publish", "pro", "runtime"];
/** §2 第 3 条的书写顺序；pro、runtime 可省略（§5.1）。 */
const JKS_FIELDS = ["id", "thread", "trigger", "pro", "runtime", "members"];
const JKS_REQUIRED = ["id", "thread", "trigger", "members"];
const JKM_FIELDS = ["jkm", "version", "threads", "roots"];

/** §4.4：七种 publish 模式及其固定集合。顺序即编译后的模式编号。 */
export const PUBLISH = {
  always: [0, 1],
  zero: [0],
  one: [1],
  never: [],
  always_changed: [0, 1],
  zero_changed: [0],
  one_changed: [1],
} as const satisfies Record<string, readonly number[]>;
export type PublishMode = keyof typeof PUBLISH;
export const PUBLISH_MODES = Object.keys(PUBLISH) as PublishMode[];

/** §5.2：已定义整合方式的登记类型。 */
export const REGISTRATION_TYPES = [
  "any", "all", "transaction", "transaction_any", "ack", "pre", "post", "comp", "frame",
] as const;
export type RegistrationType = (typeof REGISTRATION_TYPES)[number];
export const GATED_TYPES: ReadonlySet<string> = new Set(["all", "transaction", "transaction_any"]);
export const TX_TYPES: ReadonlySet<string> = new Set(["transaction", "transaction_any"]);

// ---------------------------------------------------------------------------
// JSON 结构
// ---------------------------------------------------------------------------

export type Bit = 0 | 1;
export type Trigger = { any: string[] } | { all: string[] };

export interface Jki {
  id: string;
  q: Bit;
  trigger: Trigger;
  sources?: { s?: string[]; ex?: ("J" | "K")[]; seed?: Bit };
  publish?: Partial<Record<PublishMode, number[]>>;
  pro?: { jksid?: string; tag?: string[] };
  runtime?: { trigger_all?: (Bit | null)[] };
}

export interface Jks {
  id: string;
  thread: string;
  trigger: Partial<Record<RegistrationType, string[]>>;
  pro?: { tag?: string[] };
  runtime?: Record<string, never>;
  members: (Jki | Jks)[];
}

export interface Jkm {
  jkm: string;
  version: string;
  threads: string[];
  roots: Jks[];
}

/** §9.4 运行脚本。 */
export interface RunScript {
  run: string;
  model: string;
  observe: { watch: string[]; read: string[] };
  batches: string[][];
}

/** §9.5 快照中的事件项与任务项。 */
export type SnapshotEvent = { source: string };
export type SnapshotTask = { node: string } | { tx: string; prereqs: string[] };

export interface Snapshot {
  snapshot: string;
  jkm: string | null;
  version: string;
  q: Record<string, Bit>;
  trigger_all: Record<string, (Bit | null)[]>;
  rounds: Record<string, Partial<Record<"all" | "transaction", string[]>>>;
  threads: Record<string, { events: SnapshotEvent[]; tasks: SnapshotTask[] }>;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBit(value: unknown): value is Bit {
  return value === 0 || value === 1;
}

function isJksObj(value: unknown): value is Obj {
  return isObj(value) && "members" in value;
}

export function hasEx(node: Jki): boolean {
  return (node.sources?.ex?.length ?? 0) > 0;
}

/** 写入错误信息时显示一个值。 */
function show(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function strList(value: unknown, allowEmpty = true): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0)
    && value.every((item) => typeof item === "string" && item !== "");
}

function keysOf(value: Obj): string[] {
  return Object.keys(value).sort();
}

function extraKeys(value: Obj, allowed: readonly string[]): string[] {
  return keysOf(value).filter((k) => !allowed.includes(k));
}

function onlyKey(value: Obj): [string, unknown] {
  const [key] = Object.keys(value);
  return [key, value[key]];
}

/** trigger 的唯一键与引用列表。 */
export function triggerOf(node: Jki): ["any" | "all", string[]] {
  return "all" in node.trigger ? ["all", node.trigger.all] : ["any", node.trigger.any];
}

/** publish 模式；省略或 {} 等价于 always（§4.4）。 */
export function publishMode(node: Jki): PublishMode {
  const keys = Object.keys(node.publish ?? {});
  return (keys[0] as PublishMode | undefined) ?? "always";
}

/** §4.4：value 是否发布。qBefore 为 null 表示空 EX 的触发。 */
export function publishes(mode: PublishMode, qBefore: Bit | null, value: Bit): boolean {
  if (!(PUBLISH[mode] as readonly number[]).includes(value)) return false;
  if (mode.endsWith("_changed")) return qBefore !== null && value !== qBefore;
  return true;
}

// ---------------------------------------------------------------------------
// 路径（§7.3、§8）
// ---------------------------------------------------------------------------

export function segments(path: string): string[] {
  return path.split(".");
}

export function depth(path: string): number {
  return segments(path).length;
}

/** §7.3 的路径顺序：逐层比较，同层 JKI（Q）在 JKS（G）之前，再按编号。 */
export function comparePaths(a: string, b: string): number {
  const x = segments(a);
  const y = segments(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const tx = x[i][0] === "Q" ? 0 : 1;
    const ty = y[i][0] === "Q" ? 0 : 1;
    if (tx !== ty) return tx - ty;
    const nx = Number(x[i].slice(1));
    const ny = Number(y[i].slice(1));
    if (nx !== ny) return nx - ny;
  }
  return x.length - y.length;
}

export function sortPaths(paths: Iterable<string>): string[] {
  return [...paths].sort(comparePaths);
}

function isUnder(path: string, prefix: string): boolean {
  return path.startsWith(prefix + ".");
}

// ---------------------------------------------------------------------------
// JKI 字段检查（§2、§3、§4.4）
// ---------------------------------------------------------------------------

/** 一个 JKI 的字段级检查；不解析引用。 */
export function checkJki(node: unknown, where: string, errors: string[]): void {
  const err = (message: string) => errors.push(`${where}: ${message}`);
  if (!isObj(node)) {
    err("JKI 必须是对象");
    return;
  }
  const extra = extraKeys(node, JKI_FIELDS);
  if (extra.length) err(`未批准的 JKI 字段 ${show(extra)}（§2 第 5 条）`);
  for (const field of ["id", "q", "trigger"]) {
    if (!(field in node)) err(`缺少必填字段 ${field}（§3）`);
  }
  if ("id" in node && !(typeof node.id === "string" && Q_ID.test(node.id))) err("id 必须是 Q＋不带前导零的正整数（§3）");
  if ("q" in node && !isBit(node.q)) err("q 必须是整数 0 或 1（§2 第 2 条）");

  let mode: string | null = null;
  let refs: string[] | null = null;
  if ("trigger" in node) {
    const trigger = node.trigger;
    if (!(isObj(trigger) && Object.keys(trigger).length === 1 && ["any", "all"].includes(Object.keys(trigger)[0]))) {
      err("trigger 必须恰好有 any 或 all 一个键（§3）");
    } else {
      const [key, value] = onlyKey(trigger);
      mode = key;
      if (!strList(value)) {
        err(`trigger.${mode} 必须是非空字符串组成的数组`);
      } else {
        refs = value;
        if (new Set(value).size !== value.length) err(`trigger.${mode} 不得重复（§3.1）`);
        else if (mode === "all" && value.length === 0) err("trigger.all 不得为空（§3.2）");
      }
    }
  }

  if ("sources" in node) {
    const sources = node.sources;
    if (!isObj(sources)) {
      err("sources 必须是对象");
    } else {
      const extraS = extraKeys(sources, ["s", "ex", "seed"]);
      if (extraS.length) err(`sources 含未批准字段 ${show(extraS)}`);
      const sList = "s" in sources ? sources.s : [];
      const exList = "ex" in sources ? sources.ex : [];
      if (!strList(sList)) err("sources.s 必须是非空字符串组成的数组");
      if (!(Array.isArray(exList) && exList.every((op) => op === "J" || op === "K"))) {
        err('sources.ex 只能由 "J"、"K" 组成');
      } else if (exList.length && (!Array.isArray(sList) || exList.length !== sList.length)) {
        err("sources.ex 非空时必须与 s 等长（§3）");
      }
      if ("seed" in sources && !isBit(sources.seed)) err("sources.seed 只能是 0 或 1，null 非法（§3.3）");
    }
  }

  if ("publish" in node) {
    const publish = node.publish;
    if (!isObj(publish)) {
      err("publish 必须是对象");
    } else if (Object.keys(publish).length) {
      if (Object.keys(publish).length !== 1) {
        err("publish 必须恰好一个模式键（§4.4）");
      } else {
        const [key, value] = onlyKey(publish);
        const fixed = Object.hasOwn(PUBLISH, key) ? (PUBLISH as Record<string, readonly number[]>)[key] : undefined;
        const ok = fixed !== undefined && Array.isArray(value)
          && value.every((v) => Number.isInteger(v))
          && value.length === fixed.length && value.every((v, i) => v === fixed[i]);
        if (!ok) err(`publish 必须是七种模式之一并使用固定集合（§4.4），得到 ${show(publish)}`);
      }
    }
  }

  if ("pro" in node) {
    const pro = node.pro;
    if (!isObj(pro)) {
      err("pro 必须是对象");
    } else {
      const extraP = extraKeys(pro, ["jksid", "tag"]);
      if (extraP.length) err(`pro 含未批准字段 ${show(extraP)}（§3）`);
      if ("jksid" in pro && !(typeof pro.jksid === "string" && pro.jksid !== "")) err("pro.jksid 必须是非空字符串");
      if ("tag" in pro && !strList(pro.tag)) err("pro.tag 必须是非空字符串组成的数组");
    }
  }

  let runtime: Obj | null = null;
  if ("runtime" in node) {
    if (!isObj(node.runtime)) {
      err("runtime 必须是对象");
    } else {
      runtime = node.runtime;
      const extraR = extraKeys(runtime, ["trigger_all"]);
      if (extraR.length) err(`runtime 含未批准字段 ${show(extraR)}`);
    }
  }
  if (mode === "all" && refs !== null) {
    const record = runtime?.trigger_all;
    if (!(Array.isArray(record) && record.length === refs.length)) {
      err("all 节点必须保留与 trigger.all 等长的 runtime.trigger_all（§3）");
    } else if (!record.every((v) => v === null)) {
      err("定义中的 runtime.trigger_all 必须全为 null；运行中的到达记录只保存在快照中（§3、§9.5）");
    }
  } else if (mode === "any" && runtime && Object.keys(runtime).length && "trigger_all" in runtime) {
    err("any 节点不保存 trigger_all（§3）");
  }
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/** 一个已加载的 JKM。`errors` 列出全部违规；派生索引只在没有错误时有效。 */
export class Model {
  readonly source: string;
  readonly name: string | null;
  readonly errors: string[] = [];
  /** 绝对路径 → JKI（按书写顺序登记）。 */
  readonly jki = new Map<string, Jki>();
  /** 绝对路径 → JKS（按书写顺序登记）。 */
  readonly jks = new Map<string, Jks>();
  threads: string[] = [];

  /** JKS → 全部后代 JKI。 */
  readonly members = new Map<string, Set<string>>();
  /** JKI → trigger 引用解析出的绝对路径（按书写顺序）。 */
  readonly triggerRefs = new Map<string, string[]>();
  /** JKI → sources.s 解析出的绝对路径。 */
  readonly sourceRefs = new Map<string, string[]>();
  /** JKS → 登记类型 → 前置 JKI。 */
  readonly regTypes = new Map<string, Map<string, string[]>>();
  /** JKS → 前置 JKI 集合。 */
  readonly prereqs = new Map<string, Set<string>>();
  /** 前置 JKI → [登记它的 JKS, 登记类型]。 */
  readonly regOf = new Map<string, [string, string]>();
  /** 带 transaction 或 transaction_any 登记的 JKS（第 6 节）。 */
  readonly txGroups = new Set<string>();
  /** JKI → 订阅者，按 §7.3 路径顺序。 */
  readonly subscribers = new Map<string, string[]>();

  constructor(data: unknown, source = "model") {
    this.source = source;
    this.name = isObj(data) && typeof data.jkm === "string" ? data.jkm : null;
    this.load(data);
    if (!this.errors.length) this.derive();
  }

  private err(message: string): void {
    this.errors.push(`${this.source}: ${message}`);
  }

  /** 是否为模型中的某个绝对路径（JKI 或 JKS）。 */
  has(path: unknown): path is string {
    return typeof path === "string" && (this.jki.has(path) || this.jks.has(path));
  }

  isJkiPath(path: unknown): path is string {
    return typeof path === "string" && this.jki.has(path);
  }

  /** 全部 JKS 共用的 thread；多个 thread 时返回 null。 */
  singleThread(): string | null | undefined {
    const threads = new Set([...this.jks.values()].map((g) => g.thread));
    if (threads.size > 1) return null;
    return [...threads][0];
  }

  // -- 加载 --------------------------------------------------------------

  private load(data: unknown): void {
    if (!isObj(data)) {
      this.err("JKM 必须是对象（§8.1）");
      return;
    }
    const keys = keysOf(data);
    if (keys.length !== JKM_FIELDS.length || !JKM_FIELDS.every((f) => f in data)) {
      this.err(`JKM 字段必须恰好是 ${show(JKM_FIELDS)}（§8.1），得到 ${show(keys)}`);
    }
    if (!(typeof data.jkm === "string" && data.jkm !== "")) this.err("jkm 必须是非空字符串");
    if (data.version !== VERSION) this.err(`version 必须是 "${VERSION}"`);
    const threads = data.threads;
    if (!(strList(threads, false) && new Set(threads).size === threads.length)) {
      this.err("threads 必须是非空、无重复的数组，元素为非空字符串（§8.1、§2 第 6 条）");
    } else {
      this.threads = [...threads];
    }
    const roots = data.roots;
    if (!(Array.isArray(roots) && roots.length)) {
      this.err("roots 必须是非空数组（§8.1）");
      return;
    }
    const seen = new Set<unknown>();
    roots.forEach((root, i) => {
      if (!isJksObj(root)) {
        this.err(`roots[${i}] 必须是 JKS 对象`);
        return;
      }
      if (seen.has(root.id)) this.err(`根 id 重复：${String(root.id)}`);
      seen.add(root.id);
      this.walk(root, "", `roots[${i}]`);
    });
  }

  private walk(obj: Obj, prefix: string, where: string): void {
    const extra = extraKeys(obj, JKS_FIELDS);
    const missing = JKS_REQUIRED.filter((f) => !(f in obj));
    if (extra.length) this.err(`${where}: JKS 含未批准字段 ${show(extra)}（§2 第 5 条、§5.1）`);
    if (missing.length) this.err(`${where}: JKS 缺少必填字段 ${show(missing)}（§5.1）`);
    const id = obj.id;
    if (!(typeof id === "string" && G_ID.test(id))) {
      this.err(`${where}: JKS id 必须是 G＋不带前导零的正整数（§5.1），得到 ${show(id)}`);
      return;
    }
    const path = prefix ? `${prefix}.${id}` : id;
    where = path;
    this.register(path, obj as unknown as Jks, this.jks);
    if (!isObj(obj.trigger)) this.err(`${where}: trigger 必须是对象`);
    else if (Object.keys(obj.trigger).length === 0) this.err(`${where}: JKS.trigger 至少要有一个登记（§5.1、§5.2）`);
    if (this.threads.length && !this.threads.includes(obj.thread as string)) {
      this.err(`${where}: thread 必须是 JKM.threads 中声明的名称（§8.1），得到 ${show(obj.thread)}`);
    }
    const pro = "pro" in obj ? obj.pro : {};
    if (!isObj(pro)) {
      this.err(`${where}: JKS.pro 必须是对象（§5.1）`);
    } else {
      const extraP = extraKeys(pro, ["tag"]);
      if (extraP.length) this.err(`${where}: JKS.pro 含未批准字段 ${show(extraP)}，已批准的只有 tag（§5.1）`);
      if ("tag" in pro && !strList(pro.tag)) this.err(`${where}: JKS.pro.tag 必须是非空字符串组成的数组（§5.1）`);
    }
    if ("runtime" in obj && !(isObj(obj.runtime) && Object.keys(obj.runtime).length === 0)) {
      this.err(`${where}: JKS.runtime 内部格式未定义，只能省略或写 {}（§5.1）`);
    }
    const members = obj.members;
    if (!(Array.isArray(members) && members.length)) {
      this.err(`${where}: members 必须是非空数组（§5.1）`);
      return;
    }
    const ids = new Set<unknown>();
    members.forEach((member, i) => {
      if (!isObj(member)) {
        this.err(`${where}.members[${i}]: 成员必须是完整对象（§5.1）`);
        return;
      }
      const memberId = member.id;
      if (ids.has(memberId)) this.err(`${where}: 同层成员 id 重复：${String(memberId)}`);
      ids.add(memberId);
      if (isJksObj(member)) {
        this.walk(member, path, `${where}.members[${i}]`);
      } else {
        const before = this.errors.length;
        checkJki(member, `${this.source}: ${where}.${String(memberId)}`, this.errors);
        if (this.errors.length === before) this.register(`${path}.${memberId as string}`, member as unknown as Jki, this.jki);
      }
    });
  }

  private register<T>(path: string, obj: T, table: Map<string, T>): void {
    if (this.has(path)) {
      this.err(`绝对路径冲突：${path}（§8.2）`);
      return;
    }
    table.set(path, obj);
  }

  // -- 引用解析（§8.2） ----------------------------------------------------

  /** 解析写在 JKS `layer` 内的引用。返回 [路径, null] 或 [null, 问题]。 */
  resolve(ref: unknown, layer: string): [string, null] | [null, string] {
    if (typeof ref !== "string" || ref === "") return [null, "引用必须是非空字符串"];
    if (!ref.includes(".")) {
      const path = `${layer}.${ref}`;
      if (this.jki.has(path)) return [path, null];
      if (this.jks.has(path)) return [null, `${ref} 落到 JKS，引用必须落到 JKI`];
      return [null, `短 ID ${ref} 不是 ${layer} 的直接成员 JKI（短 ID 只在本层解析）`];
    }
    if (!this.has(ref)) return [null, `绝对路径 ${ref} 不存在`];
    if (this.jks.has(ref)) return [null, `${ref} 落到 JKS，引用必须落到 JKI`];
    return [ref, null];
  }

  /** §5.3：subscriber 是否受 JKS g 的登记整合。 */
  gated(g: string, subscriber: string): boolean {
    return this.members.get(g)!.has(subscriber) && !this.prereqs.get(g)!.has(subscriber);
  }

  // -- 派生索引与模型级检查 --------------------------------------------------

  private derive(): void {
    for (const g of this.jks.keys()) {
      this.members.set(g, new Set([...this.jki.keys()].filter((p) => isUnder(p, g))));
    }
    for (const [path, node] of this.jki) {
      const layer = path.slice(0, path.lastIndexOf("."));
      const [, refs] = triggerOf(node);
      const trig = this.resolveAll(refs, layer, `${path}.trigger`);
      this.triggerRefs.set(path, trig);
      this.sourceRefs.set(path, this.resolveAll(node.sources?.s ?? [], layer, `${path}.sources.s`));
      if (new Set(trig).size !== trig.length) {
        this.err(`${path}.trigger：短 ID 与绝对路径指向同一 JKI，属于重复（§3.1）`);
      }
    }

    for (const [g, obj] of this.jks) {
      const kinds = new Map<string, string[]>();
      const prereqs = new Set<string>();
      this.regTypes.set(g, kinds);
      this.prereqs.set(g, prereqs);
      for (const [kind, refs] of Object.entries(obj.trigger as Obj)) {
        const where = `${g}.trigger.${kind}`;
        if (!(REGISTRATION_TYPES as readonly string[]).includes(kind)) {
          this.err(`${where}：未定义的登记类型，新增类型须先在 JKRD7 §5.2 定义（§5.2）`);
          continue;
        }
        if (!strList(refs, false)) {
          this.err(`${where}：必须是非空的前置 ID 数组（§5.2）`);
          continue;
        }
        const nested = refs.filter((ref) => ref.includes("."));
        for (const ref of nested) {
          this.err(`${where}：${ref} 不是短 ID；登记只能写本层直接成员的短 ID，不能登记嵌套成员（§5.2）`);
        }
        const paths = this.resolveAll(refs.filter((ref) => !ref.includes(".")), g, where);
        for (const p of paths) {
          if (prereqs.has(p)) {
            this.err(`${where}：${p} 在同一 JKS.trigger 中重复登记（§5.2）`);
          } else {
            prereqs.add(p);
            this.regOf.set(p, [g, kind]);
          }
        }
        kinds.set(kind, paths);
        if (TX_TYPES.has(kind)) this.txGroups.add(g);
      }
    }

    for (const [path, node] of this.jki) {
      if ("any" in node.trigger && node.trigger.any.length === 0) {
        if (path.split(".").length !== 2) {
          this.err(`${path}：trigger.any=[] 只允许用于根 JKS 的直接成员；子 JKS 的入口必须写明上游（§3.2）`);
        } else if (!this.regOf.has(path)) {
          this.err(`${path}：trigger.any=[] 只允许用于已登记的输入入口（§3.2）`);
        }
      }
      const jksid = node.pro?.jksid;
      if (jksid !== undefined && !this.jks.has(jksid)) {
        this.err(`${path}：pro.jksid 必须是实际 JKS 的绝对路径（§3），得到 ${show(jksid)}`);
      }
    }

    for (const [s, refs] of this.triggerRefs) {
      for (const x of refs) {
        if (!this.subscribers.has(x)) this.subscribers.set(x, []);
        this.subscribers.get(x)!.push(s);
      }
    }
    for (const list of this.subscribers.values()) list.sort(comparePaths);

    // §6.4：从事务（事务登记的前置的受整合订阅者）沿订阅关系可达的环，必须有退出结构
    const reach = new Set<string>();
    for (const g of this.txGroups) {
      for (const [kind, prereqs] of this.regTypes.get(g)!) {
        if (!TX_TYPES.has(kind)) continue;
        for (const p of prereqs) {
          for (const s of this.subscribers.get(p) ?? []) if (this.gated(g, s)) reach.add(s);
        }
      }
    }
    const stack = [...reach];
    while (stack.length) {
      for (const s of this.subscribers.get(stack.pop()!) ?? []) {
        if (!reach.has(s)) {
          reach.add(s);
          stack.push(s);
        }
      }
    }
    // “环外”＝不与该节点经触发连接互相到达（不在同一个强连通分量中），或从事务不可达
    const comp = components(reach,
      (x) => (this.subscribers.get(x) ?? []).filter((y) => reach.has(y)),
      (x) => this.triggerRefs.get(x)!.filter((y) => reach.has(y)));
    const outside = (y: string, x: string) => !comp.has(y) || comp.get(y) !== comp.get(x);
    const exitNode = (x: string) => {
      const node = this.jki.get(x)!;
      const mode = publishMode(node);
      if (hasEx(node) ? mode !== "always" : !publishes(mode, null, node.q)) return true; // 发布取决于结果，或从不发布
      return "all" in node.trigger && this.triggerRefs.get(x)!.some((y) => outside(y, x)); // 要等环外的来源
    };
    const exitEdge = (x: string, s: string) => { // 经 all／transaction 整合，且该登记有环外的前置
      const reg = this.regOf.get(x);
      if (!reg || (reg[1] !== "all" && reg[1] !== "transaction") || !this.gated(reg[0], s)) return false;
      return this.regTypes.get(reg[0])!.get(reg[1])!.some((p) => outside(p, x));
    };
    const txEdges = new Map<string, string[]>();
    for (const s of reach) {
      if (exitNode(s)) continue;
      txEdges.set(s, this.triggerRefs.get(s)!.filter((x) => reach.has(x) && !exitNode(x) && !exitEdge(x, s)));
    }
    const txCycle = findCycle(txEdges);
    if (txCycle) this.err(`从事务可达的环 ${txCycle.join(" → ")} 上没有退出结构：事务将永不结束（§6.4）`);

    // §6.4：纯通知环（any、空 EX、在不变的 q 上发布、连接不受整合）
    const loud = (node: Jki) => {
      const mode = publishMode(node);
      return "any" in node.trigger && !hasEx(node)
        && (mode === "always" || mode === "zero" || mode === "one")
        && (PUBLISH[mode] as readonly number[]).includes(node.q);
    };
    const ungated = (x: string, s: string) => {
      const reg = this.regOf.get(x);
      return !(reg && GATED_TYPES.has(reg[1]) && this.gated(reg[0], s));
    };
    const quiet = new Set([...this.jki].filter(([, node]) => loud(node)).map(([p]) => p));
    const edges = new Map<string, string[]>();
    for (const s of quiet) {
      edges.set(s, this.triggerRefs.get(s)!.filter((x) => quiet.has(x) && ungated(x, s)));
    }
    const cycle = findCycle(edges);
    if (cycle) this.err(`纯通知环 ${cycle.join(" → ")}：永不终止，并使全部任务得不到执行（§6.4）`);
  }

  private resolveAll(refs: unknown[], layer: string, where: string): string[] {
    const paths: string[] = [];
    for (const ref of refs) {
      const [path, problem] = this.resolve(ref, layer);
      if (problem !== null) this.err(`${where}：${problem}`);
      else paths.push(path);
    }
    return paths;
  }
}

/** 强连通分量（Kosaraju，迭代实现）：节点 → 分量编号。next 为出边，prev 为入边，都限于 nodes 内。 */
function components(nodes: Set<string>, next: (x: string) => string[], prev: (x: string) => string[]): Map<string, number> {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const start of sortPaths(nodes)) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack: [string, string[], number][] = [[start, next(start), 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top[2] < top[1].length) {
        const y = top[1][top[2]++];
        if (!seen.has(y)) {
          seen.add(y);
          stack.push([y, next(y), 0]);
        }
      } else {
        order.push(top[0]);
        stack.pop();
      }
    }
  }
  const comp = new Map<string, number>();
  let count = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    if (comp.has(order[i])) continue;
    const stack = [order[i]];
    comp.set(order[i], count);
    while (stack.length) {
      for (const y of prev(stack.pop()!)) {
        if (!comp.has(y)) {
          comp.set(y, count);
          stack.push(y);
        }
      }
    }
    count++;
  }
  return comp;
}

/** edges：节点 → 触发它的节点。返回一个环，没有环时返回 null。 */
function findCycle(edges: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const visit = (node: string, stack: string[]): string[] | null => {
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node)!) {
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next, stack);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const start of sortPaths(edges.keys())) {
    if (!state.has(start)) {
      const found = visit(start, []);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 运行脚本（§9.4）与快照（§9.5）
// ---------------------------------------------------------------------------

const RUN_FIELDS = ["run", "model", "observe", "batches"];
const SNAPSHOT_FIELDS = ["snapshot", "jkm", "version", "q", "trigger_all", "rounds", "threads"];

function exactKeys(value: unknown, fields: readonly string[]): value is Obj {
  return isObj(value) && Object.keys(value).length === fields.length && fields.every((f) => f in value);
}

/** §3.2：输入入口是 trigger.any=[] 且已被根 JKS 登记的直接成员（静态检查保证只出现在根 JKS 中）。 */
export function isInputEntry(model: Model, path: unknown): boolean {
  if (!model.isJkiPath(path)) return false;
  const node = model.jki.get(path)!;
  return "any" in node.trigger && node.trigger.any.length === 0 && model.regOf.has(path);
}

/** §9.4。`model` 是脚本 model 字段所指的已加载模型。 */
export function checkRunScript(script: unknown, model: Model): string[] {
  if (!exactKeys(script, RUN_FIELDS)) return [`运行脚本字段必须恰好是 ${show(RUN_FIELDS)}（§9.4）`];
  const errors: string[] = [];
  if (!(typeof script.run === "string" && script.run !== "")) errors.push("run 必须是非空字符串");
  const observe = script.observe;
  if (!(exactKeys(observe, ["watch", "read"]) && strList(observe.watch) && strList(observe.read))) {
    errors.push("observe 必须是 {watch, read}，两者都是路径数组（§9.4）");
  } else {
    for (const ref of [...observe.watch, ...observe.read]) {
      if (!model.isJkiPath(ref)) errors.push(`observe 中的 ${ref} 不是 JKI 绝对路径`);
    }
  }
  const batches = script.batches;
  if (!(Array.isArray(batches) && batches.every((b) => strList(b, false)))) {
    errors.push("batches 必须是非空路径数组组成的数组（§9.4）");
  } else {
    for (const batch of batches as string[][]) {
      for (const ref of batch) {
        if (!isInputEntry(model, ref)) errors.push(`batches 中的 ${ref} 不是输入入口（§3.2）`);
      }
    }
  }
  return errors;
}

/** §9.5：快照的结构及其与模型的一致性。 */
export function checkSnapshot(snap: unknown, model: Model): string[] {
  if (!exactKeys(snap, SNAPSHOT_FIELDS)) return [`快照字段必须恰好是 ${show(SNAPSHOT_FIELDS)}（§9.5）`];
  const errors: string[] = [];
  if (snap.version !== VERSION) errors.push(`version 必须是 "${VERSION}"`);
  const q = snap.q;
  const all = [...model.jki.keys()];
  if (!(isObj(q) && Object.keys(q).length === all.length && all.every((p) => p in q)
    && Object.values(q).every(isBit))) {
    errors.push("q 必须给出全部 JKI 的 0／1 值（§9.5）");
  }
  for (const [ref, record] of Object.entries(isObj(snap.trigger_all) ? snap.trigger_all : {})) {
    const node = model.jki.get(ref);
    const refs = node && "all" in node.trigger ? node.trigger.all : null;
    const ok = refs !== null && Array.isArray(record) && record.length === refs.length
      && record.every((v) => v === null || isBit(v)) && record.some((v) => v !== null) && record.some((v) => v === null);
    if (!ok) errors.push(`trigger_all 中 ${ref} 的记录不合法（§9.5）`);
  }
  for (const [ref, kinds] of Object.entries(isObj(snap.rounds) ? snap.rounds : {})) {
    if (!model.jks.has(ref) || !isObj(kinds)) {
      errors.push(`rounds 的键 ${ref} 不是 JKS 绝对路径`);
      continue;
    }
    for (const [kind, prereqs] of Object.entries(kinds)) {
      const registered = model.regTypes.get(ref)!.get(kind) ?? [];
      const ok = (kind === "all" || kind === "transaction") && strList(prereqs, false)
        && new Set(prereqs).size === prereqs.length
        && prereqs.every((p) => registered.includes(p)) && prereqs.length < registered.length;
      if (!ok) errors.push(`rounds 中 ${ref}.${kind} 的记录不合法：只能列出未到齐的本轮前置（§9.5）`);
    }
  }
  const threads = snap.threads;
  if (!(isObj(threads) && Object.keys(threads).every((k) => model.threads.includes(k)))) {
    return [...errors, "threads 的键必须是 JKM.threads 中声明的名称"];
  }
  for (const [name, fifo] of Object.entries(threads)) {
    if (!exactKeys(fifo, ["events", "tasks"]) || !Array.isArray(fifo.events) || !Array.isArray(fifo.tasks)) {
      errors.push(`threads.${name} 必须是 {events, tasks}`);
      continue;
    }
    for (const item of fifo.events as unknown[]) {
      const ok = exactKeys(item, ["source"]) && model.isJkiPath(item.source);
      if (!ok) errors.push(`threads.${name}.events 中的事件项不合法：${show(item)}`);
    }
    for (const item of fifo.tasks as unknown[]) {
      let ok = false;
      if (exactKeys(item, ["node"])) {
        ok = model.isJkiPath(item.node) && hasEx(model.jki.get(item.node)!);
      } else if (exactKeys(item, ["tx", "prereqs"])) {
        const g = item.tx;
        ok = typeof g === "string" && model.txGroups.has(g) && strList(item.prereqs, false)
          && item.prereqs.every((r) => model.prereqs.get(g)!.has(r));
      }
      if (!ok) errors.push(`threads.${name}.tasks 中的任务项不合法：${show(item)}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 文档中的 JSON 块
// ---------------------------------------------------------------------------

/** Markdown 中全部 ```json 代码块的原文。 */
export function jsonBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** JKRD7 正文中按 jkm 名称索引的模型。 */
export function docModels(markdown: string): Map<string, Jkm> {
  const models = new Map<string, Jkm>();
  for (const block of jsonBlocks(markdown)) {
    const data = JSON.parse(block) as unknown;
    if (isObj(data) && typeof data.jkm === "string" && "roots" in data) models.set(data.jkm, data as unknown as Jkm);
  }
  return models;
}

/** JKRD7 正文中第一个含有键 key 的 JSON 块（深拷贝）。 */
export function docBlock<T>(markdown: string, key: string): T {
  for (const block of jsonBlocks(markdown)) {
    const data = JSON.parse(block) as unknown;
    if (isObj(data) && key in data) return data as T;
  }
  throw new Error(`JKRD7 中没有含 ${key} 的 JSON 块`);
}

/** JKRD7 正文中 id 为 jkiId 的 JKI 片段（深拷贝）。 */
export function docFragment(markdown: string, jkiId: string): Jki {
  for (const block of jsonBlocks(markdown)) {
    const data = JSON.parse(block) as unknown;
    if (isObj(data) && data.id === jkiId && !("members" in data)) return data as unknown as Jki;
  }
  throw new Error(`JKRD7 中没有 JKI 片段 ${jkiId}`);
}
