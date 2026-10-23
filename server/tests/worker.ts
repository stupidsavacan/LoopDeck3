import { syncApi, maintenance } from '../lib/sync-api';
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    // This worker is bundled only by the local test harness, never by Sites.
    if (new URL(request.url).pathname === '/__test/gc') {
      const bucket = new Proxy(env.BUCKET, {
        get(target, key) {
          if (key === 'delete' && request.headers.has('x-fail-delete'))
            return async () => {
              throw new Error('injected');
            };
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      await maintenance(env.DB, bucket);
      return new Response('ok');
    }
    return syncApi(request, env, ctx);
  }
};
