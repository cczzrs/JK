/**
 * 本机 HTTP 服务（只监听 127.0.0.1）：把仓库文件提供给浏览器，.ts 文件去掉类型后按 JavaScript 返回；
 * 另有 /__job（取任务）、/__log（打印进度）、/__result（交回结果）三个接口，供 tools/gpu.ts 与 tools/show.ts 使用。
 * 浏览器端的运行依赖（three）经只读路由 /vendor/ 提供，其余 node_modules 与以点开头的文件不提供。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import { extname, resolve, sep } from "node:path";
import { ROOT } from "./common.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

/** 只读的运行依赖路由：URL 前缀 → 仓库内目录。只提供其中的 .js 文件。 */
const VENDOR: Record<string, string> = {
  "/vendor/three/build/": "node_modules/three/build/",
  "/vendor/three/examples/jsm/": "node_modules/three/examples/jsm/",
};

/** 运行依赖的文件路径；不属于 /vendor/ 或不允许时返回 null。 */
function vendorFile(path: string): string | null {
  for (const [prefix, dir] of Object.entries(VENDOR)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const base = resolve(ROOT, dir);
    const file = resolve(base, rest);
    const ok = extname(file) === ".js" && file.startsWith(base + sep) && !rest.split("/").some((part) => part === "" || part.startsWith("."));
    return ok ? file : null;
  }
  return null;
}

/** 去掉 TypeScript 类型（Node 内置功能；关闭它的“实验功能”提示）。 */
function stripTypes(code: string): string {
  const strip = (nodeModule as unknown as { stripTypeScriptTypes(code: string, options?: object): string }).stripTypeScriptTypes;
  const emit = process.emitWarning;
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try {
    return strip(code, { mode: "strip" });
  } finally {
    process.emitWarning = emit;
  }
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

export interface Served {
  url: string;
  result: Promise<unknown>;
  close(): Promise<void>;
}

export async function serve(options: { job?: unknown; port?: number; onLog?: (line: string) => void } = {}): Promise<Served> {
  let deliver: (value: unknown) => void = () => {};
  const result = new Promise<unknown>((ok) => (deliver = ok));
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__job") {
      res.writeHead(200, { "content-type": TYPES[".json"] });
      res.end(JSON.stringify(options.job ?? null));
      return;
    }
    if (req.method === "POST" && (url.pathname === "/__log" || url.pathname === "/__result")) {
      const text = await body(req);
      res.writeHead(204).end();
      if (url.pathname === "/__log") options.onLog?.(text);
      else deliver(JSON.parse(text));
      return;
    }
    const path = decodeURIComponent(url.pathname === "/" ? "/web/index.html" : url.pathname);
    const vendor = path.startsWith("/vendor/") ? vendorFile(path) : null;
    const file = vendor ?? resolve(ROOT, "." + path);
    const hidden = !vendor && path.split("/").some((part) => part.startsWith(".") || part === "node_modules");
    if (!file.startsWith(ROOT + sep) || hidden || (path.startsWith("/vendor/") && !vendor)) {
      res.writeHead(403).end();
      return;
    }
    try {
      let content: string | Buffer = await readFile(file);
      if (extname(file) === ".ts") content = stripTypes(content.toString("utf8"));
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(content);
    } catch {
      res.writeHead(404).end();
    }
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      res.writeHead(500).end(String(e));
    });
  });
  await new Promise<void>((ok) => server.listen(options.port ?? 0, "127.0.0.1", ok));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    result,
    close: () => new Promise<void>((ok) => {
      server.closeAllConnections();
      server.close(() => ok());
    }),
  };
}
