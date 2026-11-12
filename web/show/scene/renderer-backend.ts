/**
 * 选择渲染器：WebGPU（与 GPU 后端共用同一个设备），不可用时用 Canvas 2D 软件渲染。
 * 设备由页面统一取得，渲染器不销毁它。
 */

import * as THREE from "three/webgpu";
import { APP_CONFIG } from "../config.ts";
import { CanvasRenderer, type CanvasView } from "./canvas-renderer.ts";

export type SceneRenderer = THREE.WebGPURenderer | CanvasRenderer;

export interface RendererResult {
  renderer: SceneRenderer;
  backend: "webgpu" | "canvas";
  reason: string | null;
}

export interface RendererOptions {
  mode?: "auto" | "canvas";
  /** 取得共用的 WebGPU 设备。 */
  device?: () => Promise<GPUDevice>;
  timeoutMs?: number;
  /** 渲染器创建之后设备丢失时调用（Three 自己的处理之后）。 */
  onDeviceLost?: (message: string) => void;
}

function isWebGPU(renderer: SceneRenderer | null | undefined): renderer is THREE.WebGPURenderer {
  return Boolean(renderer && !(renderer instanceof CanvasRenderer));
}

/** 释放渲染器。设备属于页面（GPU 后端也在用），这里只解除画布配置，不销毁设备。 */
export function disposeRenderer(renderer: SceneRenderer | null | undefined): void {
  if (!renderer) return;
  if (!isWebGPU(renderer)) {
    renderer.dispose();
    return;
  }
  // Three 0.180 的 dispose() 在初始化失败时会重试 init()；失败路径上不调用它。
  const incomplete = (renderer as unknown as { _initialized?: boolean })._initialized === false;
  renderer.onDeviceLost = () => {};
  try {
    if (!incomplete) renderer.dispose();
  } catch {
    // 继续释放。
  }
  try {
    (renderer.backend as unknown as { context?: GPUCanvasContext }).context?.unconfigure();
  } catch {
    // 设备可能已经丢失。
  }
}

export async function createRenderer(view: CanvasView, {
  mode = APP_CONFIG.scene.renderer.mode,
  device,
  timeoutMs = APP_CONFIG.scene.renderer.initTimeoutMs,
  onDeviceLost,
}: RendererOptions = {}): Promise<RendererResult> {
  const software = (reason: string | null): RendererResult => ({ renderer: new CanvasRenderer(view), backend: "canvas", reason });
  if (mode === "canvas") return software(null);
  if (!device) return software("页面没有提供 WebGPU 设备");
  let renderer: THREE.WebGPURenderer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abandoned = false;
  // 取得设备与初始化渲染器共用一个时限。
  const initialize = async (): Promise<THREE.WebGPURenderer | null> => {
    const gpu = await device();
    if (abandoned) return null;
    renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true, device: gpu });
    // Three 0.180 否则会悄悄改用 WebGL，那不是本页的降级路径。
    renderer._getFallback = null;
    try {
      await renderer.init();
    } finally {
      if (abandoned) disposeRenderer(renderer);
    }
    if (abandoned) return null;
    if (!(renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend) throw new Error("WebGPU 未能启动");
    if (renderer._isDeviceLost) throw new Error("GPU 在初始化期间失去连接");
    return renderer;
  };
  try {
    const ready = await Promise.race([
      initialize(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("WebGPU 初始化超时")), timeoutMs);
      }),
    ]);
    if (!ready) return software("WebGPU 初始化已放弃");
    const handleLoss = ready.onDeviceLost.bind(ready);
    ready.onDeviceLost = (info) => {
      handleLoss(info);
      onDeviceLost?.(info.message || "GPU 设备连接丢失");
    };
    return { renderer: ready, backend: "webgpu", reason: null };
  } catch (error) {
    abandoned = true;
    disposeRenderer(renderer);
    return software(error instanceof Error ? error.message : "WebGPU 不可用");
  } finally {
    clearTimeout(timer);
  }
}
