/**
 * 信号动画层：一个单元（或一步）中沿连线移动的标记、读到的值，以及节点上方短暂的“旧值→新值”“发布”。
 * 只负责建立、移动与释放这些对象；标签的外观（颜色、缩放）由场景视图按窗口外观设置。
 */

import * as THREE from "three/webgpu";
import { APP_CONFIG } from "../config.ts";
import type { Pulse, Transfer } from "../session.ts";
import { disposeGroup } from "./resources.ts";

/** 精灵标签的原文：外观改变时按它重画。 */
export interface SpriteLabel {
  text: string;
  color: string;
  size: number;
}

/** 信号经过的连线（场景视图的 DrawEdge 满足这个形状）。 */
export interface SignalEdge {
  source: string;
  target: string;
  relation: string;
  index: number;
  visible?: boolean;
  styleOpacity?: number;
  curve: THREE.Curve<THREE.Vector3>;
  endT: number;
}

export interface Signal<E extends SignalEdge = SignalEdge> {
  edge: E;
  text: THREE.Sprite;
  tip: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  value: string;
}

export interface PulseSprite {
  sprite: THREE.Sprite;
  text: string;
  color: string;
}

export function paintLabel(canvas: HTMLCanvasElement, text: string, color: string, size: number): void {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `500 ${size}px ${APP_CONFIG.scene.display.labelFont}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 32);
}

/** 动画中随信号移动的数值标签（离屏画布纹理，不是页面 HTML）。 */
export function spriteLabel(text: string, color = "#a5bcd3", size = 22): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  paintLabel(canvas, text, color, size);
  const map = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
  sprite.scale.set(...APP_CONFIG.scene.display.labelScale);
  sprite.renderOrder = 4;
  sprite.userData.label = { text, color, size } satisfies SpriteLabel;
  return sprite;
}

export class SignalLayer<E extends SignalEdge> {
  readonly group = new THREE.Group();
  signals: Signal<E>[] = [];
  pulses: PulseSprite[] = [];
  /** 当前一段动画的进度，0—1。 */
  progress = 0;

  clear(): void {
    disposeGroup(this.group);
    this.signals = [];
    this.pulses = [];
  }

  /**
   * 换成一段新的动画：每条可见连线上匹配的传递一个标记，每个节点标记一个精灵。
   * position 给出节点的位置（节点不可见时为 null）；fontScale 是窗口外观的字号倍数。
   */
  show(transfers: readonly Transfer[], pulses: readonly Pulse[], edges: readonly E[],
    position: (path: string) => THREE.Vector3 | null, fontScale: number): void {
    this.clear();
    const colors = APP_CONFIG.scene.signals;
    for (const edge of edges) {
      if (edge.visible === false) continue;
      const transfer = transfers.find((t) => t.source === edge.source && t.target === edge.target
        && t.relation === edge.relation && (t.index === undefined || t.index === edge.index));
      if (!transfer) continue;
      const text = spriteLabel(transfer.value, "#eefcf8", 34);
      text.scale.set(1.5, 0.375, 1);
      this.group.add(text);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.11, 8).translate(0, -0.055, 0), new THREE.MeshBasicMaterial({ color: colors[transfer.relation] }));
      this.group.add(tip);
      this.signals.push({ edge, text, tip, value: transfer.value });
    }
    for (const pulse of pulses) {
      const at = position(pulse.path);
      if (!at) continue;
      const color = pulse.kind === "write" ? colors.write : colors.publish;
      const sprite = spriteLabel(pulse.text, color, 30);
      sprite.scale.set(1.2, 0.3, 1).multiplyScalar(fontScale);
      sprite.position.copy(at).add(new THREE.Vector3(0, pulse.kind === "write" ? 0.3 : 0.48, 0));
      this.group.add(sprite);
      this.pulses.push({ sprite, text: pulse.text, color });
    }
  }

  /** 按连线的显隐与透明度设置标记（edgeOpacity 是连线的默认透明度；styled 为 false 时不跟随连线透明度）。 */
  syncStyles(styled: boolean, edgeOpacity: number): void {
    for (const signal of this.signals) {
      const visible = signal.edge.visible !== false;
      const opacity = styled ? Math.min(1, (signal.edge.styleOpacity ?? edgeOpacity) / edgeOpacity) : 1;
      signal.text.visible = signal.tip.visible = visible;
      signal.text.material.opacity = opacity;
      signal.tip.material.transparent = opacity < 1;
      signal.tip.material.opacity = opacity;
    }
  }

  /** 把标记移到连线上的 t 处（0 为起点，1 为箭头处）。 */
  setProgress(t: number): void {
    this.progress = t;
    for (const { edge, text, tip } of this.signals) {
      const at = t * edge.endT;
      tip.position.copy(edge.curve.getPoint(at));
      tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), edge.curve.getTangent(at).normalize());
      text.position.copy(edge.curve.getPoint(Math.max(0, at - 0.09))).add(new THREE.Vector3(0, 0.23, 0));
    }
  }
}
