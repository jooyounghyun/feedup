// FeedUp Worker 진입점: /api/* 는 서버 로직, /pt 는 PT 앱(골프와 같은 계정 시스템, 기록은 따로), 나머지는 public 폴더의 화면 파일
import { onRequest, scheduledReminders } from './api.js';
import PT_PAGE from './pt.html';

const PAGE = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-robots-tag': 'noindex, nofollow' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
      return onRequest({ request, env, params: { path } });
    }
    if (url.pathname === '/pt' || url.pathname === '/pt/') {
      return new Response(PT_PAGE, { headers: PAGE });
    }
    return env.ASSETS.fetch(request);
  },
  // 매일 05:00 UTC(한국 오후 2시): 내일 레슨·PT 수업 알림 (wrangler.jsonc 의 triggers.crons)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledReminders(env));
  },
};
