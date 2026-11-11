/**
 * 页面共用的 WebGPU 设备：3D 渲染与 GPU 后端使用同一个设备（WebGPU.md 第 11 节第 2 阶段）。
 * 设备由 src/gpu/backend.ts 的 requestDevice() 取得；丢失后，下一次取得时重新请求。
 */

import { requestDevice } from "../../src/gpu/backend.ts";

export class SharedDevice {
  private pending: Promise<GPUDevice> | null = null;
  current: GPUDevice | null = null;
  /** 适配器说明（厂商、架构、描述）。 */
  adapter = "";

  acquire(): Promise<GPUDevice> {
    if (!this.pending) {
      const pending = requestDevice().then(({ adapter, device }) => {
        this.current = device;
        this.adapter = [adapter.info.vendor, adapter.info.architecture, adapter.info.description].filter(Boolean).join(" · ");
        void device.lost.then(() => {
          if (this.current === device) {
            this.current = null;
            this.pending = null;
          }
        });
        return device;
      });
      pending.catch(() => {
        if (this.pending === pending) this.pending = null;
      });
      this.pending = pending;
    }
    return this.pending;
  }

  dispose(): void {
    this.current?.destroy();
    this.current = null;
    this.pending = null;
  }
}
