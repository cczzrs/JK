import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { failure } from './model-pool-service.js';

const etagOf = source => createHash('sha256').update(source).digest('hex');

/** Local development only. Sites uses its BUCKET binding and never this module. */
export function createLocalModelPoolStore(filename, seedFile) {
  const lockFile = `${filename}.lock`;
  async function read() {
    try {
      let source;
      try { source = await fs.readFile(filename, 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        const seed = await fs.readFile(seedFile, 'utf8');
        try { await fs.writeFile(filename, seed, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        source = await fs.readFile(filename, 'utf8');
      }
      return { source, etag: etagOf(source) };
    } catch { throw failure(503, '本地模型池读取失败，请检查文件权限。'); }
  }
  return { read, async write(source, expectedEtag) {
    let lock;
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      try { lock = await fs.open(lockFile, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw failure(409, '模型池正在保存，请刷新后重试。'); throw error; }
      if ((await read()).etag !== expectedEtag) throw failure(409, '模型池已被其他设备更新，请刷新后重试。');
      await fs.writeFile(temporary, source, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, filename);
    } catch (error) { throw error.status ? error : failure(503, '本地模型池保存失败，请稍后重试。'); }
    finally {
      await fs.unlink(temporary).catch(() => {});
      if (lock) { await lock.close(); await fs.unlink(lockFile).catch(() => {}); }
    }
  } };
}
