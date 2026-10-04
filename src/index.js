// FeedUp Worker 진입점: /api/* 는 서버 로직, 나머지는 public 폴더의 화면 파일
import { onRequest } from './api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
      return onRequest({ request, env, params: { path } });
    }
    return env.ASSETS.fetch(request);
  },
};
