/**
 * 节点名称与次数标签：少数几次实例化绘制代替逐节点的 Sprite、材质与画布纹理。
 */

import * as THREE from "three/webgpu";
import {
  cameraProjectionMatrix, cameraViewMatrix, instancedBufferAttribute, modelWorldMatrix, positionGeometry, texture, uv, vec4,
} from "three/tsl";
import { APP_CONFIG } from "../config.ts";

const CELL = 64;
const ATLAS_SIZE = 1024;
const FONT_SIZE = 32;
const DEFAULT_SCALE = APP_CONFIG.scene.display.labelScale;
const ATTRIBUTE_SIZES = { center: 3, offset: 2, size: 2, rect: 4, tint: 3 } as const;
type AttributeName = keyof typeof ATTRIBUTE_SIZES;

interface Glyph {
  advance: number;
  rect: [number, number, number, number];
}

/** 白色字形图集：改变数字只改实例的纹理坐标，不改纹理。 */
class GlyphAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  private readonly context: CanvasRenderingContext2D;
  private readonly glyphs = new Map<string, Glyph>();
  private dirty = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = ATLAS_SIZE;
    this.context = this.canvas.getContext("2d")!;
    this.context.font = `500 ${FONT_SIZE}px ${APP_CONFIG.scene.display.labelFont}`;
    this.context.textAlign = "center";
    this.context.textBaseline = "middle";
    this.context.fillStyle = "#ffffff";
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.generateMipmaps = false;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    // 普通节点名、状态标记与执行次数用到的字符预先放入图集。
    for (const c of Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).concat("次")) this.get(c);
  }

  get(character: string): Glyph {
    const known = this.glyphs.get(character);
    if (known) return known;
    if (this.glyphs.size >= (ATLAS_SIZE / CELL) ** 2) return this.glyphs.get("?")!;
    const index = this.glyphs.size;
    const x = (index % 16) * CELL;
    const y = Math.floor(index / 16) * CELL;
    this.context.fillText(character, x + CELL / 2, y + CELL / 2);
    const glyph: Glyph = {
      advance: this.context.measureText(character).width,
      rect: [x / ATLAS_SIZE, 1 - (y + CELL) / ATLAS_SIZE, CELL / ATLAS_SIZE, CELL / ATLAS_SIZE],
    };
    this.glyphs.set(character, glyph);
    this.dirty = true;
    return glyph;
  }

  flush(): void {
    if (this.dirty) {
      this.texture.needsUpdate = true;
      this.dirty = false;
    }
  }
}

interface Slot {
  page: LabelPage;
  start: number;
  length: number;
  visible: boolean;
}

class LabelPage {
  readonly capacity: number;
  used = 0;
  readonly mesh: THREE.Mesh;
  private dirty = false;
  private visibleSlots = 0;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly attributes = {} as Record<AttributeName, THREE.InstancedBufferAttribute>;

  constructor(atlas: GlyphAtlas, capacity: number, renderOrder: number) {
    this.capacity = capacity;
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setIndex(plane.index!.clone());
    for (const name of ["position", "normal", "uv"]) this.geometry.setAttribute(name, (plane.getAttribute(name) as THREE.BufferAttribute).clone());
    plane.dispose();
    this.geometry.instanceCount = 0;
    for (const [name, size] of Object.entries(ATTRIBUTE_SIZES) as [AttributeName, number][]) {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage);
      this.attributes[name] = attribute;
      this.geometry.setAttribute(`label_${name}`, attribute);
    }
    const node = (name: AttributeName) => instancedBufferAttribute(this.attributes[name]);
    const center = cameraViewMatrix.mul(modelWorldMatrix).mul(vec4(node("center"), 1));
    const aligned = positionGeometry.xy.mul(node("size")).add(node("offset"));
    const rect = node("rect");
    const sample = texture(atlas.texture, uv().mul(rect.zw).add(rect.xy));
    this.material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
    // 裁剪空间的顶点节点：任意视角下每个实例都朝向相机。
    this.material.vertexNode = cameraProjectionMatrix.mul(vec4(center.xy.add(aligned), center.zw));
    this.material.colorNode = sample.rgb.mul(node("tint"));
    this.material.opacityNode = sample.a;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    this.mesh.name = "Batched node labels";
  }

  reserve(length: number): Slot {
    const slot: Slot = { page: this, start: this.used, length, visible: false };
    this.used += length;
    this.geometry.instanceCount = this.used;
    return slot;
  }

  hide(slot: Slot): void {
    if (slot.visible) {
      slot.visible = false;
      this.visibleSlots--;
      this.mesh.visible = this.visibleSlots > 0;
    }
    (this.attributes.size.array as Float32Array).fill(0, slot.start * 2, (slot.start + slot.length) * 2);
    this.dirty = true;
  }

  write(slot: Slot, label: LabelHandle, glyphs: Glyph[]): void {
    if (!slot.visible) {
      slot.visible = true;
      this.visibleSlots++;
      this.mesh.visible = true;
    }
    const ratio = label.fontSize / FONT_SIZE;
    const width = glyphs.reduce((sum, glyph) => sum + glyph.advance, 0);
    let advance = -width / 2;
    const r = label.textColor.r * label.color.r;
    const g = label.textColor.g * label.color.g;
    const b = label.textColor.b * label.color.b;
    const a = this.attributes;
    const center = a.center.array as Float32Array;
    const offset = a.offset.array as Float32Array;
    const size = a.size.array as Float32Array;
    const rect = a.rect.array as Float32Array;
    const tint = a.tint.array as Float32Array;
    for (let i = 0; i < slot.length; i++) {
      const index = slot.start + i;
      const glyph = glyphs[i];
      if (!glyph) {
        size.fill(0, index * 2, index * 2 + 2);
        continue;
      }
      center[index * 3] = label.position.x;
      center[index * 3 + 1] = label.position.y;
      center[index * 3 + 2] = label.position.z;
      offset.set([(advance + glyph.advance / 2) * ratio / 256 * label.scale.x, 0], index * 2);
      size.set([CELL * ratio / 256 * label.scale.x, CELL * ratio / 64 * label.scale.y], index * 2);
      rect.set(glyph.rect, index * 4);
      tint[index * 3] = r;
      tint[index * 3 + 1] = g;
      tint[index * 3 + 2] = b;
      advance += glyph.advance;
    }
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    for (const attribute of Object.values(this.attributes)) attribute.needsUpdate = true;
    this.dirty = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export interface LabelOptions {
  color?: string;
  size?: number;
  scale?: [number, number, number];
  renderOrder?: number;
}

export class LabelHandle {
  text: string;
  readonly textColor: THREE.Color;
  fontSize: number;
  readonly position = new THREE.Vector3();
  readonly scale: THREE.Vector3;
  readonly color = new THREE.Color(0xffffff);
  visible = true;
  renderOrder: number;
  slot: Slot | null = null;
  dirty = true;
  wasVisible = false;
  private readonly snapshot = new Float64Array(14).fill(NaN);

  constructor(text: unknown, { color = "#a5bcd3", size = 22, scale = DEFAULT_SCALE, renderOrder = 4 }: LabelOptions = {}) {
    this.text = String(text);
    this.textColor = new THREE.Color(color);
    this.fontSize = size;
    this.scale = new THREE.Vector3().fromArray(scale);
    this.renderOrder = renderOrder;
  }

  setText(text: unknown, color?: THREE.ColorRepresentation, size = this.fontSize): this {
    const value = String(text);
    if (value !== this.text || size !== this.fontSize) {
      this.text = value;
      this.fontSize = size;
      this.dirty = true;
    }
    if (color !== undefined) this.textColor.set(color);
    return this;
  }

  changed(): boolean {
    const p = this.position;
    const s = this.scale;
    const c = this.color;
    const t = this.textColor;
    const old = this.snapshot;
    const changed = this.dirty || p.x !== old[0] || p.y !== old[1] || p.z !== old[2] || s.x !== old[3] || s.y !== old[4] || s.z !== old[5]
      || c.r !== old[6] || c.g !== old[7] || c.b !== old[8] || t.r !== old[9] || t.g !== old[10] || t.b !== old[11]
      || this.fontSize !== old[12] || this.renderOrder !== old[13];
    if (changed) {
      old.set([p.x, p.y, p.z, s.x, s.y, s.z, c.r, c.g, c.b, t.r, t.g, t.b, this.fontSize, this.renderOrder]);
    }
    return changed;
  }
}

/**
 * 标签组：group 加入场景一次；句柄提供 position／scale／color／visible 与 setText()。
 * 绘制前调用 flush()；没有变化的标签不重画图集，也不写缓冲区。clear() 在更换模型时释放页面资源，保留字形图集。
 */
/** 每页标签实例的最少容量。 */
const PAGE_CAPACITY = 8192;

export class NodeLabels {
  readonly group = new THREE.Group();
  private readonly labels = new Set<LabelHandle>();
  private pages: LabelPage[] = [];
  private atlas: GlyphAtlas | null = null;

  constructor() {
    this.group.name = "Node labels";
  }

  add(text: unknown, options?: LabelOptions): LabelHandle {
    const label = new LabelHandle(text, options);
    this.labels.add(label);
    return label;
  }

  private reserve(label: LabelHandle, length: number): Slot {
    // 次数位数增加时不必每次换位置。
    const capacity = Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, length))));
    let page = this.pages.find((item) => item.mesh.renderOrder === label.renderOrder && item.capacity - item.used >= capacity);
    if (!page) {
      this.atlas ??= new GlyphAtlas();
      page = new LabelPage(this.atlas, Math.max(PAGE_CAPACITY, capacity), label.renderOrder);
      this.pages.push(page);
      this.group.add(page.mesh);
    }
    return page.reserve(capacity);
  }

  flush(): void {
    for (const label of this.labels) {
      if (!label.visible || !label.text) {
        if (label.wasVisible && label.slot) label.slot.page.hide(label.slot);
        label.wasVisible = false;
        continue;
      }
      if (!label.changed() && label.wasVisible) continue;
      this.atlas ??= new GlyphAtlas();
      const atlas = this.atlas;
      const glyphs = Array.from(label.text, (character) => atlas.get(character));
      if (!label.slot || label.slot.length < glyphs.length || label.slot.page.mesh.renderOrder !== label.renderOrder) {
        if (label.slot) label.slot.page.hide(label.slot);
        label.slot = this.reserve(label, glyphs.length);
      }
      label.slot.page.write(label.slot, label, glyphs);
      label.dirty = false;
      label.wasVisible = true;
    }
    this.atlas?.flush();
    for (const page of this.pages) page.flush();
  }

  clear(): void {
    for (const page of this.pages) page.dispose();
    this.group.clear();
    this.pages = [];
    this.labels.clear();
  }

  dispose(): void {
    this.clear();
    this.atlas?.texture.dispose();
    this.atlas = null;
  }
}
