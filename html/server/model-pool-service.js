import { parseModelPool, mutateModelPool } from '../../src/jk/model-pool.js';

export const failure = (status, message) => Object.assign(new Error(message), { status });

export async function readPool(storage) {
  const { source, etag } = await storage.read();
  if (typeof etag !== 'string' || !etag) throw failure(503, '模型池缺少存储版本信息，暂不能安全保存。');
  try { return { etag, pool: parseModelPool(JSON.parse(source)) }; }
  catch (error) { throw failure(500, `模型池文件无效：${error.message}`); }
}

/** Both local development and Sites use this same revision and permission gate. */
export async function applyPoolCommand(storage, command, permanentWritable, authRequired) {
  const { pool, etag } = await readPool(storage);
  const result = mutateModelPool(pool, command);
  const permanent = command.action === 'promote'
    || (command.action === 'delete' && pool.permanent.some(entry => entry.id === command.id));
  if (permanent && !permanentWritable) {
    throw failure(authRequired ? 401 : 403, authRequired ? '操作永久模型需要有效的管理员口令。' : '服务器尚未配置管理员口令，暂不能操作永久模型。');
  }
  if (result.pool.revision !== pool.revision) await storage.write(`${JSON.stringify(result.pool, null, 2)}\n`, etag);
  return result;
}
