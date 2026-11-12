/**
 * 展示页的默认配置（只读的树形结构）。运行状态、浏览器缓存和 JKM 定义不写入此树。
 *
 * - desktop：窗口布局与外观（通用值 + 各窗口覆盖）；
 * - model：示例与各示例的加载预设（路径、输入、观察）；
 * - engine：页面调度预算（每帧单元数与时间），不属于 JKRD7 规则；
 * - playback：动画；scene：相机、鼠标操作、网络样式和渲染；view：面板显示；image：图片转输入。
 *
 * 共享模型池与快照窗口延后，不在本页。
 */

export type Zone = "scene" | "tools";

export interface Limit {
  min: number;
  max: number;
  step: number;
}

export interface Ranged extends Limit {
  value: number;
}

export interface WindowAppearance {
  background: string;
  foreground: string;
  opacity: number;
  radius: number;
  fontScale: number;
}

export interface RailPanelAppearance {
  background: string;
  opacity: number;
  radius: number;
  iconColor: string;
  iconSize: number;
  iconOpacity: number;
  foreground: string;
  fontSize: number;
  fontOpacity: number;
}

export interface WindowSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  collapsed: boolean;
  fill?: boolean;
  minWidth?: number;
  minHeight?: number;
  zone?: Zone;
  appearance?: Partial<WindowAppearance>;
  appearanceLimits?: Partial<Record<string, Limit>>;
}

export interface ModeSpec {
  label: string;
  hints: { windowMove: string; sceneMove: string; windowResize: string; sceneResize: string };
  windows: Partial<Record<string, Partial<WindowSpec>>>;
  order?: string[];
}

export interface DesktopConfig {
  storage: { key: string; version: number };
  display: { mode: "dual" | "single"; modes: { dual: ModeSpec; single: ModeSpec } };
  theme: {
    background: string; accent: string; hover: string; focus: string; border: string;
    selectionBackground: string; selectionForeground: string; foreground: string;
    glass: { enabled: boolean; blur: number; limits: Limit };
  };
  split: Ranged;
  rail: {
    width: Ranged;
    menuRatio: Ranged;
    geometry: { splitterSize: number; itemMinWidth: number; minWorkspaceWidth: number };
    appearance: {
      menu: RailPanelAppearance;
      dock: RailPanelAppearance;
      limits: Record<"opacity" | "radius" | "iconSize" | "iconOpacity" | "fontSize" | "fontOpacity", Limit>;
    };
  };
  geometry: {
    padding: number; titleHeight: number; dragThreshold: number; keyboardStep: number; maxCanvasHeight: number;
    minWidth: number; minHeight: number; defaultZone: Zone;
  };
  appearance: WindowAppearance & {
    target: string;
    panels: Record<string, string>;
    limits: Record<"opacity" | "radius" | "fontScale", Limit>;
  };
  windows: Record<string, WindowSpec>;
}

export interface EdgeTypeStyle {
  label: string;
  color: string;
  opacity: number;
  length: number;
  visible: boolean;
}

export interface NodeTypeStyle {
  label: string;
  color: string;
  size: number;
  visible: boolean;
  labels: boolean;
}

export interface MarkerStyle {
  visible: boolean;
  color: string;
  size: number;
}

export interface StylesConfig {
  storage: { key: string; version: number };
  edges: { defaultType: string; types: Record<string, EdgeTypeStyle>; limits: { opacity: Limit; length: Limit } };
  nodes: {
    defaultType: string;
    types: Record<"input" | "node" | "observe", NodeTypeStyle>;
    computationTypes: { ex: { label: string; overrides: Record<string, never>; marker: MarkerStyle }; q: { label: string; overrides: Record<string, never> } };
    limits: { size: Limit };
  };
  layout: { iterations: number; relaxation: number };
}

export interface Preset {
  /** 运行脚本 model 字段使用的 JKM 文件路径（相对仓库根目录）。 */
  path?: string;
  input?: string[];
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

const desktop: DesktopConfig = {
  storage: { key: "jk.show.desktop", version: 1 },
  display: {
    mode: "single",
    modes: {
      dual: {
        label: "双板",
        hints: {
          windowMove: "拖动移动或跨区 · 方向键移动 · Ctrl + 左右键切换区域",
          sceneMove: "拖动移动 · 方向键移动",
          windowResize: "拖动调整大小 · 方向键调整",
          sceneResize: "拖动调整大小 · 方向键调整",
        },
        windows: {},
      },
      single: {
        label: "单板",
        hints: {
          windowMove: "拖动移动 · 方向键移动",
          sceneMove: "单板场景固定铺满背景",
          windowResize: "拖动调整大小 · 方向键调整",
          sceneResize: "单板场景随工作区自动铺满",
        },
        windows: {
          scene: { x: 12, y: 12, width: 1310, height: 796, visible: true, collapsed: false, fill: true },
          controls: { x: 12, y: 12, width: 238.5, height: 530, visible: true, collapsed: true },
          status: { x: 440, y: 24, width: 360, height: 420, visible: false, collapsed: false },
          overview: { x: 12, y: 68, width: 220, height: 285, visible: false, collapsed: true },
          input: { x: 12, y: 125, width: 391, height: 366, visible: false, collapsed: true },
          output: { x: 1102, y: 766, width: 220, height: 610, visible: false, collapsed: true },
          inspector: { x: 488, y: 12, width: 368, height: 382, visible: false, collapsed: true },
          events: { x: 322, y: 101, width: 289, height: 315, visible: false, collapsed: true },
          tasks: { x: 629, y: 101, width: 283, height: 297, visible: false, collapsed: true },
          history: { x: 434, y: 766, width: 416, height: 250, visible: false, collapsed: true },
          unit: { x: 860, y: 12, width: 450, height: 560, visible: false, collapsed: true },
          playback: { x: 1011, y: 79, width: 311, height: 275, visible: false, collapsed: true },
          models: { x: 334, y: 12, width: 594, height: 700, visible: false, collapsed: true },
          script: { x: 400, y: 12, width: 477, height: 551, visible: false, collapsed: true },
          render: { x: 340, y: 12, width: 514, height: 509, visible: false, collapsed: true },
          observe: { x: 393, y: 12, width: 435, height: 507, visible: false, collapsed: true },
          image: { x: 307, y: 12, width: 667, height: 510, visible: false, collapsed: true },
          appearance: { x: 988, y: 12, width: 334, height: 565, visible: true, collapsed: true },
        },
        order: ["status", "controls", "image", "input", "overview", "output", "inspector", "events", "tasks", "history",
          "playback", "unit", "models", "script", "render", "observe", "appearance", "scene"],
      },
    },
  },
  theme: {
    background: "#000000", accent: "#00ffff", hover: "#e5edf6", focus: "#ffffff",
    border: "#ffffff", selectionBackground: "#595959", selectionForeground: "#ffffff",
    foreground: "#ffffff",
    glass: { enabled: true, blur: 14, limits: { min: 0, max: 40, step: 1 } },
  },
  split: { value: 0.737, min: 0.2, max: 0.82, step: 0.02 },
  rail: {
    width: { value: 80, min: 80, max: 360, step: 16 },
    menuRatio: { value: 0.354, min: 0.18, max: 0.78, step: 0.02 },
    geometry: { splitterSize: 12, itemMinWidth: 52, minWorkspaceWidth: 280 },
    appearance: {
      menu: {
        background: "#000000", opacity: 1, radius: 18,
        iconColor: "#e5edf6", iconSize: 30, iconOpacity: 1,
        foreground: "#e5edf6", fontSize: 15, fontOpacity: 1,
      },
      dock: {
        background: "#000000", opacity: 1, radius: 18,
        iconColor: "#e5edf6", iconSize: 30, iconOpacity: 1,
        foreground: "#e5edf6", fontSize: 15, fontOpacity: 1,
      },
      limits: {
        opacity: { min: 0, max: 1, step: 0.01 },
        radius: { min: 0, max: 32, step: 1 },
        iconSize: { min: 14, max: 40, step: 1 },
        iconOpacity: { min: 0, max: 1, step: 0.01 },
        fontSize: { min: 10, max: 20, step: 0.1 },
        fontOpacity: { min: 0, max: 1, step: 0.01 },
      },
    },
  },
  geometry: {
    padding: 12, titleHeight: 42, dragThreshold: 4, keyboardStep: 16, maxCanvasHeight: 6000,
    minWidth: 220, minHeight: 120, defaultZone: "tools",
  },
  appearance: {
    target: "appearance",
    panels: { "network-edges": "network-edge-settings", "network-nodes": "network-node-settings" },
    background: "#172432", foreground: "#e5edf6", opacity: 0.84, radius: 14, fontScale: 1,
    limits: {
      opacity: { min: 0.15, max: 1, step: 0.01 },
      radius: { min: 0, max: 32, step: 1 },
      fontScale: { min: 0.75, max: 2, step: 0.05 },
    },
  },
  windows: {
    scene: {
      x: 0, y: 0, width: 720, height: 720, visible: true, collapsed: false, fill: true, minWidth: 180,
      appearance: { background: "#122630", foreground: "#ffffff", opacity: 1, radius: 0, fontScale: 1.1 },
      appearanceLimits: { opacity: { min: 0, max: 1, step: 0.01 } },
    },
    controls: {
      x: 24, y: 174, width: 380, height: 430, visible: false, collapsed: false, zone: "scene",
      appearance: { background: "#000000", foreground: "#ffffff", opacity: 0.15, radius: 18, fontScale: 1.1 },
    },
    status: { x: 24, y: 24, width: 360, height: 420, visible: false, collapsed: false },
    overview: {
      x: 12, y: 12, width: 416, height: 186, visible: false, collapsed: false,
      appearance: { background: "#000000", opacity: 0.15, radius: 18 },
    },
    input: { x: 12, y: 12, width: 416, height: 360, visible: true, collapsed: false },
    playback: { x: 24, y: 568, width: 340, height: 260, visible: true, collapsed: false, zone: "scene" },
    inspector: {
      x: 12, y: 384, width: 416, height: 440, visible: true, collapsed: false,
      appearance: { background: "#000000", foreground: "#ffffff", opacity: 0.15, radius: 18, fontScale: 1.1 },
    },
    events: { x: 12, y: 836, width: 416, height: 210, visible: true, collapsed: false },
    tasks: { x: 12, y: 1058, width: 416, height: 176, visible: true, collapsed: false },
    output: { x: 12, y: 1246, width: 416, height: 270, visible: false, collapsed: false },
    history: { x: 12, y: 1528, width: 416, height: 250, visible: false, collapsed: false },
    unit: { x: 12, y: 1790, width: 416, height: 520, visible: false, collapsed: false },
    models: { x: 24, y: 24, width: 580, height: 640, visible: false, collapsed: false },
    script: { x: 24, y: 24, width: 560, height: 550, visible: false, collapsed: false },
    render: { x: 24, y: 24, width: 500, height: 400, visible: false, collapsed: false },
    observe: { x: 24, y: 24, width: 500, height: 500, visible: false, collapsed: false },
    image: { x: 24, y: 24, width: 600, height: 580, visible: false, collapsed: false },
    appearance: {
      x: 24, y: 24, width: 380, height: 640, visible: false, collapsed: false,
      appearance: { background: "#000000", foreground: "#ffffff", opacity: 0.15, radius: 18, fontScale: 1.1 },
    },
  },
};

const styles: StylesConfig = {
  storage: { key: "jk.show.network-styles", version: 1 },
  edges: {
    defaultType: "J",
    types: {
      J: { label: "J 运算线", color: "#e898c0", opacity: 0.4, length: 1, visible: true },
      K: { label: "K 运算线", color: "#689ef3", opacity: 0.4, length: 1, visible: true },
      trigger: { label: "触发通知线", color: "#ffffff", opacity: 0.1, length: 1, visible: true },
      source: { label: "来源定义线", color: "#fa3e00", opacity: 1, length: 1, visible: true },
      observe: { label: "输出观察线", color: "#79dfae", opacity: 0.4, length: 1, visible: true },
    },
    limits: { opacity: { min: 0, max: 1, step: 0.01 }, length: { min: 0.25, max: 3, step: 0.05 } },
  },
  nodes: {
    defaultType: "node",
    types: {
      input: { label: "输入入口", color: "#73aaff", size: 1, visible: true, labels: true },
      node: { label: "普通 JKI", color: "#f1f6ff", size: 1, visible: true, labels: true },
      observe: { label: "输出观察", color: "#79dfae", size: 1, visible: true, labels: true },
    },
    // 空覆盖继承各节点原有的输入入口／普通 JKI 外观；x 标记的显隐与颜色独立设置。
    computationTypes: {
      ex: { label: "ex计算节点", overrides: {}, marker: { visible: true, color: "#ffffff", size: 30 } },
      q: { label: "无计算q节点", overrides: {} },
    },
    limits: { size: { min: 0.25, max: 4, step: 0.05 } },
  },
  layout: { iterations: 48, relaxation: 0.7 },
};

export const APP_CONFIG = freezeTree({
  desktop,
  model: {
    example: "ASCII_DIGITS",
    runName: "show-run",
    /** 内置示例文件：名称 → JKM，按显示顺序（node tools/examples.ts 生成，静态检查核对与来源一致）。 */
    examples: "/web/show/examples.json",
    defaults: { input: { startIndex: 0, count: 1 } },
    // 路径和默认输入属于各自的模型；输出观察取自 JKM 的 output（§8.1），不在这里配置。
    presets: {
      ASCII_DIGITS: {
        path: "assets/ascii-bit-design/digits.jkm.json",
        input: ["G1.Q1", "G1.Q2", "G1.Q10"],
      },
    } as Record<string, Preset>,
  },
  engine: {
    /** 一段连续处理（从开始处理到静止）最多处理的单元数；到达后暂停，现场完整保留。属于页面调度，不是规则。 */
    playUnits: 100000,
    /** 跳过动画时，每帧最多处理的单元数与时间预算。 */
    frameUnits: 128,
    frameBudgetMs: 4,
  },
  /** GPU 后端对拍：同一运行脚本的实例数。 */
  gpu: { instances: { value: 1, min: 1, max: 65536, step: 1 } },
  playback: {
    speed: { value: 1, min: 0.25, max: 4, step: 0.25 }, skip: true,
    /** 运行控制的“按输出格式”：输出节点的动画按“输出数据格式及列表”当前的行取舍。 */
    byOutputFormat: true,
    /** 运行控制的“批执行”（§7.5 可并行批，用户 2026-11-11）：默认不勾选。 */
    batch: false,
    /** 运行控制的“切片记录”：勾选时每条输出读取全部 output 成员；不勾选时动画和记录都与真实运行一样（只有到达的成员）。 */
    slice: true,
    duration: 0.85, maxVisuals: 400,
    /** 事务等多步单元：步数不超过 max 时逐步播放，每步 duration 秒；否则整个单元一起显示。 */
    steps: { max: 60, duration: 0.45 },
  },
  scene: {
    camera: {
      projection: { fov: 42, near: 0.1, far: 500 },
      initial: { position: { x: 12, y: 8, z: 18 }, target: { x: 0, y: 0, z: 0 } },
      fit: {
        direction: { x: 0.18, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 }, minDistance: 4,
        padding: { min: { x: 0.6, y: 0.9, z: 0.4 }, max: { x: 0.6, y: 0.6, z: 0.4 } },
        occupancy: { horizontal: 0.82, vertical: 0.72 }, farMultiplier: 5, maxDistanceMultiplier: 4,
      },
    },
    controls: {
      staticMoving: true, rotateSpeed: 2, panSpeed: 0.8, minDistance: 0.2, maxDistance: 200,
      wheel: { linePixels: 16, sensitivity: 0.0015, minExponent: -0.5, maxExponent: 0.5 },
    },
    styles,
    appearance: { backgroundEdge: "#08121f" },
    /** q=0 的节点按此比例变暗（q=1 保持原色）。 */
    qDisplay: { zeroBrightness: 0.38 },
    /**
     * 两条渲染路径（WebGPU 与 Canvas 2D）共用的显示常量：连线的默认透明度（网络样式到达前）；
     * 立方体六个面（+x、−x、+y、−y、+z、−z）的明暗；选中时箭头与节点的放大倍数；标签字体与标签的世界尺寸。
     */
    display: {
      edgeOpacity: 0.4,
      faceShades: [0.8, 0.65, 1, 0.55, 0.92, 0.72],
      activeScale: 1.35,
      labelFont: "ui-monospace, SFMono-Regular, monospace",
      labelScale: [1.35, 0.3375, 1] as [number, number, number],
    },
    /** 执行次数超过 count 的节点与它相连的连线变红，标签的次数也变红（用户 2026-11-11 决定保留）。 */
    hot: { count: 1000, color: "#ff596e", label: "#ff697e" },
    /**
     * §6.4 的环与退出节点（用户 2026-11-11）：退出节点一直带 marker 标记；“显示环”开启时全部环上的触发线用 color；
     * 选中环上的节点时高亮它所在的环。shown 是“显示环”的默认状态。
     */
    loops: { color: "#ffb347", marker: "出", shown: false },
    /** JKS 边界框：颜色按登记类型（含事务登记、含 all、其他），选中时高亮。 */
    jks: { visible: false, any: 0x50657a, all: 0x8fb3d9, transaction: 0xf0a35e, selected: 0x85efd0 },
    /** 动画标记的颜色：通知、EX 读取、输出读取的箭头，以及 q 写入、发布的文字。 */
    signals: { trigger: 0xffe08a, source: 0xb4ffdf, observe: 0x79dfae, write: "#ffe08a", publish: "#ff9e7a" },
    layout: "5D" as const,
    nodeLabelsHidden: false,
    blackBackground: false,
    renderer: {
      mode: "auto" as "auto" | "canvas",
      initTimeoutMs: 5000,
      gpu: { maxPixelRatio: 2, idleFps: 30, activeFps: 60 },
      software: {
        pixelRatio: 1,
        idleFps: 15,
        activeFps: 30,
        curveSegments: 16,
        minNodePixels: 2,
        minFontPixels: 8,
        maxFontPixels: 28,
        lineWidth: 1,
        activeLineWidth: 2,
        arrowPixels: 4,
        nodeSize: 0.1,
        signalTextColor: "#eefcf8",
      },
    },
  },
  view: {
    disclosures: { jkm: { metadata: false } },
    inspector: {
      tree: { expandedDepth: 1 },
      sections: { state: true, calculation: false, events: false, definition: false } as Record<string, boolean>,
    },
    queues: { rows: 200, events: { records: { expanded: false } } },
    traceRows: 120,
    /** 本单元窗口最多列出的步数与每步的行数。 */
    unit: { steps: 200, lines: 60 },
    outputRows: 100,
    /** “输出数据格式及列表”最多显示的行数（最近的行）；复制与输出渲染仍用全部行。 */
    outputListRows: 500,
    /**
     * “输出数据格式及列表”与“输出渲染”的选择：默认值；最新选择保存在浏览器本地。
     * mode：all 每条输出 / trigger 指定触发组；group：触发组，空串为模型的第一个 output 组；
     * when：arrive / q0 / q1；content：all / marked；format：bin / dec / hex；render：rgb / ascii。
     * 运行控制三个勾选框的默认值在 playback 中（skip、slice、byOutputFormat），场景控制“隐藏名称和次数”按钮的默认值是
     * scene.nodeLabelsHidden，也一起保存。
     */
    outputChoices: {
      /** retired：改名前的键，打开页面时删除（用户 2026-11-11）。 */
      storage: { key: "jk.show.choices", version: 1, retired: ["jk.show.output-choices"] },
      defaults: { mode: "all", group: "", when: "arrive", content: "all", format: "bin", render: "rgb" },
    },
    board: { width: 256, height: 128, cellSize: 24, zero: "#263b4d", one: "#81e7bf" },
    fileBytes: 32 * 1024 * 1024,
  },
  image: {
    maxPixels: 64, threshold: 128, background: "#ffffff",
    inputMapping: { zeroIndex: 0, oneIndex: 1 },
    preview: { width: 256, height: 160 },
    limits: { decodedPixels: 16000000, pixels: { min: 1, max: 4096, step: 1 }, threshold: { min: 0, max: 255, step: 1 } },
  },
});

