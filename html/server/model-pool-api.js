import { failure, readPool, applyPoolCommand } from './model-pool-service.js';

const bodyLimit = 32 * 1024 * 1024;
const encoder = new TextEncoder();

async function authorized(request, token) {
  const header = request.headers.get('Authorization') ?? '';
  if (!token || !header.startsWith('Bearer ')) return false;
  const hashes = await Promise.all([header.slice(7), token].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const supplied = new Uint8Array(hashes[0]), expected = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= supplied[i] ^ expected[i];
  return difference === 0;
}

async function commandFrom(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) throw failure(415, '请使用 application/json 发送模型池操作。');
  if (Number(request.headers.get('Content-Length')) > bodyLimit) throw failure(413, '请求数据不能超过 32 MB。');
  const reader = request.body?.getReader();
  if (!reader) throw failure(400, '请求必须是有效的 JSON。');
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > bodyLimit) { await reader.cancel(); throw failure(413, '请求数据不能超过 32 MB。'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text); }
  catch { throw failure(400, '请求必须是有效的 JSON。'); }
}

/** Fetch API keeps the hosted route independent of a local Node HTTP server. */
export function createModelPoolApi({ storage, token = '', allowedOrigins = '' }) {
  const allowed = new Set((Array.isArray(allowedOrigins) ? allowedOrigins : allowedOrigins.split(',')).map(value => value.trim()).filter(Boolean));
  return async request => {
    const headers = new Headers({ 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' });
    const respond = (status, data) => new Response(request.method === 'HEAD' ? null : JSON.stringify(data), { status, headers });
    try {
      const url = new URL(request.url), origin = request.headers.get('Origin');
      if (origin) {
        let parsed;
        try { parsed = new URL(origin); } catch { throw failure(403, '请求来源不被允许。'); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || (origin !== url.origin && !allowed.has(origin))) throw failure(403, '请求来源不被允许。');
        headers.set('Access-Control-Allow-Origin', origin);
      }
      if (url.pathname === '/example.json') {
        if (!['GET', 'HEAD'].includes(request.method)) throw failure(405, '不支持此请求方法。');
        return respond(200, (await readPool(storage)).pool);
      }
      if (url.pathname !== '/api/model-pool') throw failure(404, '资源不存在。');
      if (request.method === 'OPTIONS') {
        headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        headers.set('Access-Control-Max-Age', '600');
        return new Response(null, { status: 204, headers });
      }
      const permanentWritable = await authorized(request, token);
      if (request.method === 'GET') return respond(200, { pool: (await readPool(storage)).pool, writable: true, authRequired: Boolean(token), permanentWritable });
      if (request.method !== 'POST') throw failure(405, '不支持此请求方法。');
      return respond(200, await applyPoolCommand(storage, await commandFrom(request), permanentWritable, Boolean(token)));
    } catch (error) {
      return respond(error.status ?? 500, { error: error.status ? error.message : '服务器处理请求失败。' });
    }
  };
}
