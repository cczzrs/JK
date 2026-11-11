/**
 * 网络的持久缓冲区：节点、连线与箭头各用少数几次实例化绘制。节点和箭头的代理对象可以留在场景外用于拾取。
 */

import * as THREE from "three/webgpu";
import { instancedBufferAttribute } from "three/tsl";
import { disposeGroup, mergePendingRange } from "./resources.ts";

type Instanced = THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>;

export class NetworkBatches {
  readonly group = new THREE.Group();
  private readonly nodeCount: number;
  private readonly edgeCount: number;
  private readonly segments: number;
  private readonly dirty = new Map<THREE.BufferAttribute, [number, number]>();
  private readonly active: Uint8Array;
  private activeCount = 0;
  private readonly edgeColors: Float64Array;
  private readonly arrowMatrices: Float32Array;
  private readonly edgeOpacities: Float64Array;
  private readonly edgeVisibility: Uint8Array;
  private readonly point = new THREE.Vector3();
  private readonly previous = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private readonly nodes: Instanced;
  private readonly lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly arrows: Instanced;
  private readonly selectedArrows: Instanced;
  private arrowOpacity: THREE.InstancedBufferAttribute | null = null;
  private selectedArrowOpacity: THREE.InstancedBufferAttribute | null = null;
  private disposed = false;

  constructor(nodeCount: number, edgeCount: number, { nodeSize = 0.1, segments = 36 } = {}) {
    if (!Number.isSafeInteger(nodeCount) || nodeCount < 0 || !Number.isSafeInteger(edgeCount) || edgeCount < 0
      || !Number.isSafeInteger(segments) || segments < 1) throw new RangeError("网络缓冲区大小无效");
    this.nodeCount = nodeCount;
    this.edgeCount = edgeCount;
    this.segments = segments;
    this.active = new Uint8Array(edgeCount);
    this.edgeColors = new Float64Array(edgeCount).fill(-1);
    this.arrowMatrices = new Float32Array(edgeCount * 16);
    this.edgeOpacities = new Float64Array(edgeCount).fill(NaN);
    this.edgeVisibility = new Uint8Array(edgeCount).fill(1);
    const cube = new THREE.BoxGeometry(nodeSize, nodeSize, nodeSize);
    const shades: number[] = [];
    for (const shade of [0.8, 0.65, 1, 0.55, 0.92, 0.72]) for (let i = 0; i < 4; i++) shades.push(shade, shade, shade);
    cube.setAttribute("color", new THREE.Float32BufferAttribute(shades, 3));
    this.nodes = this.instances(cube, new THREE.MeshBasicMaterial({ vertexColors: true }), nodeCount);
    const geometry = new THREE.BufferGeometry();
    const vertices = edgeCount * segments * 2;
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertices * 4), 4).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.lines.visible = edgeCount > 0;
    this.group.add(this.lines);
    const cone = new THREE.ConeGeometry(0.035, 0.1, 8).translate(0, -0.05, 0);
    this.arrows = this.instances(cone, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8 }), edgeCount);
    this.selectedArrows = this.instances(cone, new THREE.MeshBasicMaterial({ transparent: true, opacity: 1 }), edgeCount);
    this.selectedArrows.visible = false;
  }

  private instances(geometry: THREE.BufferGeometry, material: THREE.Material, count: number): Instanced {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
    // 隐藏的实例也保持有限值（含齐次分量）。
    const array = mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < count; i++) {
      array.fill(0, i * 16, i * 16 + 16);
      array[i * 16 + 15] = 1;
    }
    mesh.visible = count > 0;
    this.group.add(mesh);
    return mesh;
  }

  private mark(attribute: THREE.BufferAttribute, start: number, count: number): void {
    const range = this.dirty.get(attribute);
    if (range) {
      range[0] = Math.min(range[0], start);
      range[1] = Math.max(range[1], start + count);
    } else {
      this.dirty.set(attribute, [start, start + count]);
    }
  }

  private write(attribute: THREE.BufferAttribute, start: number, values: ArrayLike<number>): boolean {
    const array = attribute.array as Float32Array;
    let changed = false;
    for (let i = 0; i < values.length; i++) {
      const value = Math.fround(values[i]);
      if (array[start + i] !== value) {
        array[start + i] = value;
        changed = true;
      }
    }
    if (changed) this.mark(attribute, start, values.length);
    return changed;
  }

  private check(index: number, count: number): void {
    if (this.disposed) throw new Error("网络缓冲区已释放");
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError("网络缓冲区下标越界");
  }

  /** 复制代理网格的变换与颜色；没有变化时不上传。 */
  setNode(index: number, proxy: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>): void {
    this.check(index, this.nodeCount);
    proxy.updateMatrix();
    this.write(this.nodes.instanceMatrix, index * 16, proxy.visible === false ? this.matrix.makeScale(0, 0, 0).elements : proxy.matrix.elements);
    const color = proxy.material.color;
    this.write(this.nodes.instanceColor!, index * 3, [color.r, color.g, color.b]);
  }

  /** 更新一条连线自己的那段顶点；箭头代理的缩放由选中状态控制。 */
  setEdge(index: number, curve: THREE.Curve<THREE.Vector3>, endT: number, arrow?: THREE.Object3D): void {
    this.check(index, this.edgeCount);
    const attribute = this.lines.geometry.attributes.position as THREE.BufferAttribute;
    const start = index * this.segments * 6;
    const array = attribute.array as Float32Array;
    curve.getPoint(0, this.previous);
    let at = start;
    for (let i = 1; i <= this.segments; i++) {
      curve.getPoint(i / this.segments, this.point);
      array[at++] = this.previous.x; array[at++] = this.previous.y; array[at++] = this.previous.z;
      array[at++] = this.point.x; array[at++] = this.point.y; array[at++] = this.point.z;
      this.previous.copy(this.point);
    }
    this.mark(attribute, start, this.segments * 6);
    if (arrow) {
      this.matrix.compose(arrow.position, arrow.quaternion, this.scale);
    } else {
      curve.getPoint(endT, this.point);
      curve.getTangent(endT, this.direction).normalize();
      this.rotation.setFromUnitVectors(this.up, this.direction);
      this.matrix.compose(this.point, this.rotation, this.scale);
    }
    this.arrowMatrices.set(this.matrix.elements, index * 16);
    this.updateArrow(index);
  }

  private updateArrow(index: number): void {
    this.matrix.fromArray(this.arrowMatrices, index * 16);
    const selected = Boolean(this.active[index]);
    if (!this.edgeVisibility[index]) this.matrix.makeScale(0, 0, 0);
    else if (selected) this.matrix.scale(this.point.setScalar(1.35));
    this.write((selected ? this.selectedArrows : this.arrows).instanceMatrix, index * 16, this.matrix.elements);
    this.matrix.makeScale(0, 0, 0);
    this.write((selected ? this.arrows : this.selectedArrows).instanceMatrix, index * 16, this.matrix.elements);
  }

  /** 连线保留各自的透明度；选中的箭头用单独的不透明实例。 */
  setEdgeStyle(index: number, color: number, selected = false, style: { opacity: number; visible: boolean } | null = null): void {
    this.check(index, this.edgeCount);
    const opacity = style?.opacity ?? 0.4;
    const visible = style?.visible !== false && opacity > 0 ? 1 : 0;
    const active = selected && visible ? 1 : 0;
    if (this.edgeColors[index] === color && this.active[index] === active && this.edgeOpacities[index] === opacity
      && this.edgeVisibility[index] === visible) return;
    if (this.active[index] !== active) {
      this.activeCount += active ? 1 : -1;
      this.active[index] = active;
    }
    this.edgeVisibility[index] = visible;
    this.edgeOpacities[index] = opacity;
    this.updateArrow(index);
    this.edgeColors[index] = color;
    this.color.setHex(color);
    const { r, g, b } = this.color;
    const attribute = this.lines.geometry.attributes.color as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    const start = index * this.segments * 8;
    const alpha = visible ? (active ? Math.min(1, opacity / 0.4) : opacity) : 0;
    for (let offset = start; offset < start + this.segments * 8; offset += 4) {
      array[offset] = r; array[offset + 1] = g; array[offset + 2] = b; array[offset + 3] = alpha;
    }
    this.mark(attribute, start, this.segments * 8);
    this.write(this.arrows.instanceColor!, index * 3, [r, g, b]);
    this.write(this.selectedArrows.instanceColor!, index * 3, [r, g, b]);
    // 只有设置了非默认透明度的网络才启用逐实例的箭头透明度。
    if (style && opacity !== 0.4 && !this.arrowOpacity) this.enableArrowOpacity();
    if (this.arrowOpacity && this.selectedArrowOpacity) {
      this.write(this.arrowOpacity, index, [Math.min(1, opacity * 2)]);
      this.write(this.selectedArrowOpacity, index, [Math.min(1, opacity / 0.4)]);
    }
    this.arrows.visible = this.activeCount < this.edgeCount;
    this.selectedArrows.visible = this.activeCount > 0;
  }

  private enableArrowOpacity(): void {
    const make = (mesh: Instanced, factor: number): THREE.InstancedBufferAttribute => {
      const values = Float32Array.from(this.edgeOpacities, (opacity) => Math.min(1, (Number.isFinite(opacity) ? opacity : 0.4) * factor));
      const attribute = new THREE.InstancedBufferAttribute(values, 1).setUsage(THREE.DynamicDrawUsage);
      const material = new THREE.MeshBasicNodeMaterial({ transparent: true });
      material.opacityNode = instancedBufferAttribute(attribute);
      mesh.material.dispose();
      mesh.material = material;
      return attribute;
    };
    this.arrowOpacity = make(this.arrows, 2);
    this.selectedArrowOpacity = make(this.selectedArrows, 2.5);
  }

  /** 连线当前的颜色（Canvas 降级渲染使用）。 */
  edgeColor(index: number): number {
    return this.edgeColors[index];
  }

  /** 一组修改之后、绘制之前调用一次；包围球每批只重算一次。 */
  commit(): void {
    if (this.disposed) return;
    if (this.dirty.has(this.lines.geometry.attributes.position as THREE.BufferAttribute)) this.lines.geometry.computeBoundingSphere();
    for (const mesh of [this.nodes, this.arrows, this.selectedArrows]) {
      if (mesh.count && this.dirty.has(mesh.instanceMatrix)) mesh.computeBoundingSphere();
    }
    for (const [attribute, [start, end]] of this.dirty) mergePendingRange(attribute, start, end - start);
    this.dirty.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.nodes.dispose();
    this.arrows.dispose();
    this.selectedArrows.dispose();
    disposeGroup(this.group);
    this.dirty.clear();
  }
}
