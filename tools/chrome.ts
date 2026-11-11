/**
 * 用独立的临时用户目录启动本机 Chrome（运行后删除，不影响日常使用的 Chrome 配置），打开本机服务上的页面，
 * 等待页面经 /__result 交回结果。tools/gpu.ts 与 tools/show.ts 共用。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Served } from "./server.ts";

const DEFAULT_CHROME: Record<string, string> = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "google-chrome",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
};

export interface ChromeOptions {
  /** Chrome 位置；也可以用环境变量 CHROME。 */
  chrome?: string;
  /** 显示浏览器窗口。 */
  headed: boolean;
  /** 等待结果的时间上限（秒）。 */
  timeout: number;
}

function launchChrome(url: string, options: ChromeOptions): { proc: ChildProcess; profile: string } {
  const binary = options.chrome ?? process.env.CHROME ?? DEFAULT_CHROME[process.platform] ?? "google-chrome";
  const profile = mkdtempSync(join(tmpdir(), "jk-chrome-"));
  const flags = [
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--enable-unsafe-webgpu", ...(options.headed ? [] : ["--headless"]), url,
  ];
  const proc = spawn(binary, flags, { stdio: "ignore" });
  proc.on("error", (e) => {
    console.error(`无法启动 Chrome（${binary}）：${e.message}。可用 --chrome 或环境变量 CHROME 指定路径。`);
    process.exit(2);
  });
  return { proc, profile };
}

/** 打开页面并等待结果；结束后关闭 Chrome、删除临时目录、关闭本机服务。 */
export async function runInChrome(url: string, served: Served, options: ChromeOptions): Promise<Record<string, unknown>> {
  const { proc, profile } = launchChrome(url, options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`等待 ${options.timeout} 秒仍未得到结果`)), options.timeout * 1000);
  });
  try {
    return (await Promise.race([served.result, timeout])) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
    const exited = new Promise((ok) => proc.once("exit", ok));
    proc.kill();
    await Promise.race([exited, new Promise((ok) => setTimeout(ok, 3000))]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      console.error(`临时目录未能删除：${profile}`);
    }
    await served.close();
  }
}
