/** 场景的鼠标操作：TrackballControls，滚轮围绕光标位置缩放。 */

import * as THREE from "three/webgpu";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import { APP_CONFIG } from "../config.ts";

type ControlsSettings = typeof APP_CONFIG.scene.controls;

/** 以光标处的世界锚点缩放相机与旋转中心，锚点在屏幕上的位置不变。 */
export function zoomAtCursor(camera: THREE.PerspectiveCamera, target: THREE.Vector3, ndc: THREE.Vector2, factor: number,
  minDistance: number, maxDistance: number, hitPoint: THREE.Vector3 | null = null): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  camera.updateMatrixWorld();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const normal = camera.getWorldDirection(new THREE.Vector3());
  const anchor = hitPoint?.clone() ?? ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, target), new THREE.Vector3());
  if (!anchor) return;
  const distance = camera.position.distanceTo(target);
  if (distance < 1e-9) return;
  const depth = anchor.clone().sub(camera.position).dot(normal);
  const minFactor = Math.max(minDistance / distance, depth > 0 ? camera.near * 2 / depth : 0);
  const scale = Math.max(minFactor, Math.min(maxDistance / distance, factor));
  camera.position.sub(anchor).multiplyScalar(scale).add(anchor);
  target.sub(anchor).multiplyScalar(scale).add(anchor);
  camera.updateMatrixWorld();
}

export class EditorControls extends TrackballControls {
  private readonly prepareDrag: (event: PointerEvent) => void;
  private readonly cursorWheel: (event: WheelEvent) => void;
  private readonly element: HTMLElement;

  constructor(camera: THREE.PerspectiveCamera, element: HTMLElement, pick: (ndc: THREE.Vector2) => THREE.Vector3 | null = () => null,
    settings: ControlsSettings = APP_CONFIG.scene.controls) {
    super(camera, element);
    this.element = element;
    this.staticMoving = settings.staticMoving;
    this.rotateSpeed = settings.rotateSpeed;
    this.panSpeed = settings.panSpeed;
    this.noZoom = true;
    this.keys = ["", "", ""];
    this.minDistance = settings.minDistance;
    this.maxDistance = settings.maxDistance;
    this.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.prepareDrag = (event) => {
      this.handleResize();
      this.mouseButtons.LEFT = event.shiftKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    };
    this.cursorWheel = (event) => {
      if (!this.enabled) return;
      event.preventDefault();
      this.update();
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const ndc = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
      const wheel = settings.wheel;
      const pixels = event.deltaY * (event.deltaMode === 1 ? wheel.linePixels : event.deltaMode === 2 ? rect.height : 1);
      const factor = Math.exp(THREE.MathUtils.clamp(pixels * wheel.sensitivity, wheel.minExponent, wheel.maxExponent));
      zoomAtCursor(camera, this.target, ndc, factor, this.minDistance, this.maxDistance, pick(ndc));
      this.update();
    };
    element.addEventListener("pointerdown", this.prepareDrag, true);
    element.addEventListener("wheel", this.cursorWheel, { passive: false });
  }

  override dispose(): void {
    this.element.removeEventListener("pointerdown", this.prepareDrag, true);
    this.element.removeEventListener("wheel", this.cursorWheel);
    super.dispose();
  }
}
