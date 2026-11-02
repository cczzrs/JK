import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { failure, readPool, applyPoolCommand } from './model-pool-service.js';
import { createLocalModelPoolStore } from './local-model-pool-store.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const bodyLimit = 32 * 1024 * 1024;
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

function json(response, status, value, head = false) {
  const content = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(content),
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(head ? undefined : content);
}

function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    request.resume();
    return Promise.reject(failure(415, '请使用 application/json 发送模型池操作。'));
  }
  if (Number(request.headers['content-length']) > bodyLimit) {
    request.resume();
    return Promise.reject(failure(413, '请求数据不能超过 32 MB。'));
  }
  return new Promise((resolve, reject) => {
    let size = 0, finished = false;
    const chunks = [];
    request.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > bodyLimit) {
        finished = true;
        chunks.length = 0;
        reject(failure(413, '请求数据不能超过 32 MB。'));
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (finished) return;
      finished = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(failure(400, '请求必须是有效的 JSON。')); }
    });
    request.on('error', error => { if (!finished) { finished = true; reject(error); } });
    request.on('aborted', () => { if (!finished) { finished = true; reject(failure(400, '请求已中断。')); } });
  });
}

function hasToken(request, token) {
  if (!token) return false;
  const authorization = request.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function inside(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/** Local development HTTP adapter. The hosted Site runs sites-worker.js. */
export function createModelPoolServer(options = {}) {
  const distDir = path.resolve(options.distDir ?? path.join(projectRoot, 'dist/client'));
  const storage = options.storage ?? createLocalModelPoolStore(path.join(projectRoot, 'html/server/.data/model-pool.json'), path.join(projectRoot, 'html/example.json'));
  const token = options.token ?? process.env.MODEL_POOL_TOKEN ?? '';
  const originOption = options.allowedOrigins ?? process.env.MODEL_POOL_ALLOWED_ORIGINS ?? '';
  const allowedOrigins = new Set((Array.isArray(originOption) ? originOption : originOption.split(',')).map(origin => origin.trim()).filter(Boolean));
  let pendingWrite = Promise.resolve();

  function checkOrigin(request, response) {
    const origin = request.headers.origin;
    response.setHeader('Vary', 'Origin');
    if (!origin) return;
    let parsed;
    try { parsed = new URL(origin); } catch { throw failure(403, '请求来源不被允许。'); }
    const localOrigin = `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}`;
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || (origin !== localOrigin && !allowedOrigins.has(origin))) {
      throw failure(403, '请求来源不被允许。');
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
  }

  async function serveStatic(request, response, pathname) {
    if (!['GET', 'HEAD'].includes(request.method)) throw failure(405, '不支持此请求方法。');
    let decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch { throw failure(400, '无效的资源路径。'); }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.')) || /\.(?:bak|tmp)$/i.test(decoded)) throw failure(404, '资源不存在。');
    const candidate = path.resolve(distDir, `.${decoded === '/' ? '/index.html' : decoded}`);
    if (!inside(distDir, candidate)) throw failure(404, '资源不存在。');
    let realRoot, realFile, content;
    try {
      [realRoot, realFile] = await Promise.all([fs.realpath(distDir), fs.realpath(candidate)]);
      if (!inside(realRoot, realFile) || !(await fs.stat(realFile)).isFile()) throw failure(404, '资源不存在。');
      content = await fs.readFile(realFile);
    } catch { throw failure(404, '资源不存在。'); }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(realFile).toLowerCase()] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://model-pool.local');
      if (url.pathname === '/api/model-pool') {
        checkOrigin(request, response);
        if (request.method === 'OPTIONS') {
          response.writeHead(204, {
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store',
          });
          response.end();
          return;
        }
        const permanentWritable = hasToken(request, token);
        if (request.method === 'GET') {
          await pendingWrite;
          const { pool } = await readPool(storage);
          json(response, 200, { pool, writable: true, authRequired: Boolean(token), permanentWritable });
        } else if (request.method === 'POST') {
          const command = await readJson(request);
          const operation = pendingWrite.then(() => applyPoolCommand(storage, command, permanentWritable, Boolean(token)));
          pendingWrite = operation.then(() => {}, () => {});
          json(response, 200, await operation);
        } else throw failure(405, '不支持此请求方法。');
      } else if (url.pathname === '/example.json') {
        if (!['GET', 'HEAD'].includes(request.method)) throw failure(405, '不支持此请求方法。');
        await pendingWrite;
        json(response, 200, (await readPool(storage)).pool, request.method === 'HEAD');
      } else await serveStatic(request, response, url.pathname);
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      const status = error.status ?? error.statusCode ?? 500;
      if (!request.complete) response.setHeader('Connection', 'close');
      json(response, status, { error: status === 500 && !error.status ? '服务器处理请求失败。' : error.message });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.once('close', () => storage.close?.());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(fileURLToPath(new URL('.env', import.meta.url))); }
  catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('服务器环境配置读取失败，请检查 html/server/.env 的格式和访问权限。');
      process.exit(1);
    }
  }
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 4173);
  const server = createModelPoolServer();
  server.on('error', error => { console.error(`模型池服务启动失败：${error.code || 'SERVER_ERROR'}`); process.exitCode = 1; });
  server.listen(port, host, () => {
    console.log(`模型管理服务：http://${host}:${port}`);
    console.log(process.env.MODEL_POOL_TOKEN ? '临时模型可公开导入和删除；操作永久模型需要管理员口令。' : '临时模型可公开导入和删除；设置 MODEL_POOL_TOKEN 后可管理永久模型。');
  });
}
