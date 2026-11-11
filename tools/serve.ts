/**
 * 启动本机服务，供手动在浏览器中打开展示页或 GPU 对拍页面。
 *
 *   node tools/serve.ts [--port 8317]
 */

import { serve } from "./server.ts";

const i = process.argv.indexOf("--port");
const port = i >= 0 ? Number(process.argv[i + 1]) : 8317;
const served = await serve({ port });
console.log(`已启动（Ctrl+C 结束）：\n  展示页    ${served.url}/web/show/index.html\n  GPU 对拍  ${served.url}/web/index.html`);
