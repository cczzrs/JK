/**
 * 启动本机服务，供手动在浏览器中打开展示页或 GPU 对拍页面。
 *
 *   node tools/serve.ts [--port 8317]
 */

import { parseArgs } from "./common.ts";
import { serve } from "./server.ts";

const args = parseArgs(process.argv.slice(2), { port: "value" });
const served = await serve({ port: Number(args.port ?? 8317) });
console.log(`已启动（Ctrl+C 结束）：\n  展示页    ${served.url}/web/show/index.html\n  GPU 对拍  ${served.url}/web/index.html`);
