/**
 * 展示页的启动：先决定 three 从哪里加载，再写入 import map 并载入 main.ts。
 *
 * three 优先从官方推荐的 CDN（jsDelivr 上的 npm 包，版本与 package.json 锁定的 0.180.0 相同）加载；
 * CDN 在限定时间内取不到时，改用本机服务的只读路由 /vendor/three/（tools/server.ts）。
 * import map 在 main.ts 及其依赖开始解析之前写入；动态写入 import map 需要浏览器支持多个 import map
 * （Chrome 133 起）。页面只在本机 Chrome 上核对过。
 */

import { THREE_SOURCES } from "./three-source.ts";

/** 取到的来源，供页面显示与验收读取。 */
declare global {
  interface Window {
    jkThreeSource?: { name: string; base: string };
  }
}

async function reachable(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "HEAD", mode: "cors", cache: "force-cache", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function chooseSource(): Promise<{ name: string; base: string }> {
  const forced = new URLSearchParams(location.search).get("three"); // ?three=local 只用本机副本
  for (const source of THREE_SOURCES.list) {
    if (forced && forced !== source.name) continue;
    if (source.name === "local" || await reachable(source.base + THREE_SOURCES.probe, THREE_SOURCES.timeoutMs)) return source;
  }
  return THREE_SOURCES.list[THREE_SOURCES.list.length - 1];
}

const source = await chooseSource();
window.jkThreeSource = source;
const map = document.createElement("script");
map.type = "importmap";
map.textContent = JSON.stringify({
  imports: {
    "three": `${source.base}build/three.webgpu.js`,
    "three/webgpu": `${source.base}build/three.webgpu.js`,
    "three/tsl": `${source.base}build/three.tsl.js`,
    "three/addons/": `${source.base}examples/jsm/`,
  },
});
document.head.append(map);
await import("./main.ts");
