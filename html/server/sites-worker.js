import { env } from 'cloudflare:workers';
import seed from '../example.json';
import { createSitesR2Store } from './sites-r2-store.js';
import { createModelPoolApi } from './model-pool-api.js';

export default {
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/model-pool' || pathname === '/example.json') {
      return createModelPoolApi({
        storage: createSitesR2Store(env.BUCKET, seed),
        token: env.MODEL_POOL_TOKEN ?? '',
        allowedOrigins: env.MODEL_POOL_ALLOWED_ORIGINS ?? '',
      })(request);
    }
    return env.ASSETS?.fetch ? env.ASSETS.fetch(request) : new Response('资源不存在。', { status: 404 });
  },
};
