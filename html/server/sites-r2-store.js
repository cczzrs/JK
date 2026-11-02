import { parseModelPool } from '../../src/jk/model-pool.js';
import { failure } from './model-pool-service.js';

export const MODEL_POOL_KEY = 'model-pool.json';
const httpMetadata = { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' };
const throttled = error => error?.status === 429 || error?.code === 10058 || /\b10058\b|too many requests/i.test(error?.message ?? '');

/** Access the Site-owned binding, never S3 credentials or a public R2 URL. */
export function createSitesR2Store(bucket, seed) {
  function available() {
    if (!bucket?.get || !bucket?.put) throw failure(503, '模型池存储暂不可用，请稍后重试。');
  }
  async function snapshot(object) {
    if (!object || typeof object.etag !== 'string' || !object.etag || !object.text) {
      await object?.body?.cancel().catch(() => {});
      throw failure(503, '模型池存储响应无效，已停止保存。');
    }
    return { source: await object.text(), etag: object.etag };
  }
  return {
    async read() {
      available();
      try {
        let object = await bucket.get(MODEL_POOL_KEY);
        if (object === null) {
          // Migrate the bundled pool only when the object does not yet exist.
          // Concurrent first visits must never replace an existing pool.
          if (seed === undefined) throw failure(503, '模型池文件尚未初始化。');
          const source = `${JSON.stringify(parseModelPool(seed), null, 2)}\n`;
          const created = await bucket.put(MODEL_POOL_KEY, source, {
            onlyIf: new Headers({ 'If-None-Match': '*' }), httpMetadata,
          });
          if (created?.etag) return { source, etag: created.etag };
          object = await bucket.get(MODEL_POOL_KEY);
        }
        return await snapshot(object);
      } catch (error) {
        if (throttled(error)) throw failure(429, '模型池请求过于频繁，请稍后重试。');
        if (error.status) throw error;
        throw failure(503, '模型池读取失败，请稍后重新打开模型管理。');
      }
    },
    async write(source, etag) {
      available();
      if (typeof etag !== 'string' || !etag || etag === '*') throw failure(503, '缺少模型池存储版本，已拒绝保存。');
      let result;
      try {
        result = await bucket.put(MODEL_POOL_KEY, source, { onlyIf: { etagMatches: etag }, httpMetadata });
      } catch (error) {
        if (throttled(error)) throw failure(429, '模型池保存过于频繁，请稍后重试。');
        // A response can be lost after a commit. Do not replay the user's command.
        throw failure(503, '模型池保存结果未确认，请重新打开模型管理核对后再试。');
      }
      if (result === null) throw failure(409, '模型池已被其他设备更新，请刷新列表、核对后重试。');
      if (!result?.etag) throw failure(503, '模型池保存结果未确认，请重新打开模型管理核对后再试。');
    },
  };
}
