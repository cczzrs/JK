/** 只释放本组拥有的资源，不释放 Three.js 全局共享的 Sprite 几何体。 */

import * as THREE from "three/webgpu";

export function disposeGroup(group: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  group.traverse((obj) => {
    const item = obj as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[]; isSprite?: boolean };
    // 全部 THREE.Sprite 共用一个几何体。
    if (item.geometry && !item.isSprite) geometries.add(item.geometry);
    for (const material of Array.isArray(item.material) ? item.material : [item.material]) {
      if (!material) continue;
      materials.add(material);
      const map = (material as THREE.Material & { map?: THREE.Texture | null }).map;
      if (map) textures.add(map);
    }
  });
  group.clear();
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

/** 合并待上传的范围：对象被剔除或渲染暂停时，待上传数据仍有界。 */
export function mergePendingRange(attribute: THREE.BufferAttribute, start: number, count: number): void {
  let end = start + count;
  for (const range of attribute.updateRanges) {
    start = Math.min(start, range.start);
    end = Math.max(end, range.start + range.count);
  }
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(start, end - start);
  attribute.needsUpdate = true;
}
