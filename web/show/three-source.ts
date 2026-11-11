/**
 * three 的加载来源，按顺序尝试。版本须与 package.json 锁定的 three 相同（0.180.0）。
 * 本机来源由 tools/server.ts 的只读路由 /vendor/three/ 提供，放在最后作为回退。
 */
export const THREE_SOURCES = {
  list: [
    { name: "cdn", base: "https://cdn.jsdelivr.net/npm/three@0.180.0/" },
    { name: "local", base: "/vendor/three/" },
  ],
  /** 用来判断来源是否可用的文件（相对 base）。 */
  probe: "build/three.webgpu.js",
  /** 每个远程来源的等待上限（毫秒）。 */
  timeoutMs: 3000,
} as const;
