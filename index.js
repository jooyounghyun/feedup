// FeedUp Worker 진입점: /api/* 는 서버 로직, /pt 는 관리자 전용 PT 미리보기, 나머지는 public 폴더의 화면 파일
import { onRequest, adminUser } from './api.js';
import PT_PAGE from './pt.html';

const PRIVATE = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'x-frame-options': 'DENY' };
const LOCKED = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>FeedUp</title></head>' +
  '<body style="margin:0;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#fff;color:#0B0B0C">' +
  '<div style="text-align:center;padding:24px"><h1 style="font-size:22px;margin:0 0 8px">관리자만 볼 수 있어요</h1><p style="color:#5B616E;margin:0 0 18px">앱에서 관리자 계정으로 로그인한 뒤 다시 열어 주세요.</p>' +
  '<a href="/" style="display:inline-block;background:#0B0B0C;color:#fff;border-radius:12px;padding:12px 18px;text-decoration:none;font-weight:700">FeedUp으로 가기</a></div></body></html>';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
      return onRequest({ request, env, params: { path } });
    }
    if (url.pathname === '/pt' || url.pathname === '/pt/') {
      const ok = await adminUser(request, env).catch(() => null);
      return new Response(ok ? PT_PAGE : LOCKED, { status: ok ? 200 : 403, headers: PRIVATE });
    }
    return env.ASSETS.fetch(request);
  },
};
