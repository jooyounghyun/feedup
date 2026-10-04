// FeedUp API — Cloudflare Pages Functions
// 바인딩: env.DB (D1), 비밀값: env.ANTHROPIC_API_KEY
// 선택: env.AI_ENABLED('true'일 때만 AI 호출), env.ANTHROPIC_MODEL, env.AI_DAILY_LIMIT

const FIELD = 'golf';
const SESS = 'fu_sess';
const SESSION_DAYS = 30;
const enc = new TextEncoder();

/* ---------------- helpers ---------------- */
const J = (d, s = 200, h = {}) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...h },
  });
const fail = (m, s = 400) => J({ error: m }, s);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); };
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hashPw(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const b = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, k, 256);
  return hex(b);
}
function same(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function getCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
const sessCookie = (token, maxAge) => `${SESS}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
async function body(req) { try { return await req.json(); } catch { return {}; } }
const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/* ---------------- docs table ---------------- */
async function getDoc(env, col, id) {
  const r = await env.DB.prepare('SELECT data FROM docs WHERE col=? AND id=?').bind(col, id).first();
  return r ? JSON.parse(r.data) : null;
}
async function putDoc(env, col, id, data, meta = {}) {
  const json = JSON.stringify(data);
  if (json.length > 200000) throw new Error('데이터가 너무 커요');
  await env.DB.prepare(
    'INSERT INTO docs(col,id,owner,player,coach,data,updated) VALUES(?,?,?,?,?,?,?) ' +
    'ON CONFLICT(col,id) DO UPDATE SET owner=excluded.owner,player=excluded.player,coach=excluded.coach,data=excluded.data,updated=excluded.updated'
  ).bind(col, id, meta.owner || null, meta.player || null, meta.coach || null, json, Date.now()).run();
}
const delDoc = (env, col, id) => env.DB.prepare('DELETE FROM docs WHERE col=? AND id=?').bind(col, id).run();

const COLS_OK = new Set(['id', 'owner', 'player', 'coach']);
async function rowsIn(env, col, field, values) {
  if (!COLS_OK.has(field)) throw new Error('bad field');
  const out = [];
  const vals = [...new Set(values)].filter(Boolean);
  for (let i = 0; i < vals.length; i += 80) {
    const chunk = vals.slice(i, i + 80);
    const q = `SELECT id,data FROM docs WHERE col=? AND ${field} IN (${chunk.map(() => '?').join(',')})`;
    const r = await env.DB.prepare(q).bind(col, ...chunk).all();
    out.push(...(r.results || []));
  }
  return out;
}
const toMap = (rows, into) => { rows.forEach((r) => { into[r.id] = JSON.parse(r.data); }); return into; };

async function isActivePlayer(env, coach, player) {
  const l = await getDoc(env, 'links', coach + '__' + player);
  return !!(l && l.status === 'active');
}

/* ---------------- auth ---------------- */
async function currentUser(req, env) {
  const t = getCookie(req, SESS);
  if (!t) return null;
  const r = await env.DB.prepare(
    'SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?'
  ).bind(await sha(t), Date.now()).first();
  return r || null;
}
async function newSession(env, userId) {
  const token = rand(32);
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)')
    .bind(await sha(token), userId, Date.now() + SESSION_DAYS * 864e5).run();
  return sessCookie(token, SESSION_DAYS * 86400);
}
async function signup(req, env) {
  const b = await body(req);
  const email = str(b.email, 120).trim().toLowerCase();
  const pw = String(b.password || '');
  const name = str(b.name, 30).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('이메일 형식을 확인해 주세요.');
  if (pw.length < 8) return fail('비밀번호는 8자 이상이어야 해요.');
  if (!name) return fail('이름을 입력해 주세요.');
  const ex = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if (ex) return fail('이미 가입된 이메일이에요. 로그인해 주세요.', 409);
  const id = rand(8), salt = rand(16);
  await env.DB.prepare('INSERT INTO users(id,email,pass_hash,salt,created) VALUES(?,?,?,?,?)')
    .bind(id, email, await hashPw(pw, salt), salt, Date.now()).run();
  const ME = 'u_' + id;
  await putDoc(env, 'profiles', ME, { name, share: false, field: FIELD, coach: false, createdAt: Date.now() }, { owner: ME });
  return J({ user: { id, email }, me: ME }, 200, { 'set-cookie': await newSession(env, id) });
}
async function login(req, env) {
  const b = await body(req);
  const email = str(b.email, 120).trim().toLowerCase();
  const u = await env.DB.prepare('SELECT id,email,pass_hash,salt FROM users WHERE email=?').bind(email).first();
  if (!u || !same(await hashPw(String(b.password || ''), u.salt), u.pass_hash))
    return fail('이메일 또는 비밀번호가 맞지 않아요.', 401);
  return J({ user: { id: u.id, email: u.email }, me: 'u_' + u.id }, 200, { 'set-cookie': await newSession(env, u.id) });
}
async function logout(req, env) {
  const t = getCookie(req, SESS);
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha(t)).run();
  return J({ ok: true }, 200, { 'set-cookie': sessCookie('', 0) });
}

/* ---------------- state (what this user may see) ---------------- */
async function state(env, ME) {
  const out = { profiles: {}, links: {}, codes: {}, drills: {}, logs: {}, rounds: {}, feedback: {}, reports: {} };
  const mine = [...(await rowsIn(env, 'links', 'coach', [ME])), ...(await rowsIn(env, 'links', 'player', [ME]))];
  toMap(mine, out.links);
  const L = Object.values(out.links);
  const players = L.filter((l) => l.coachId === ME && l.status === 'active').map((l) => l.playerId);
  const coaches = L.filter((l) => l.playerId === ME && l.status === 'active').map((l) => l.coachId);
  // 내 선수들의 다른 코치 (항목 이름과 배정 항목 표시용)
  const other = (await rowsIn(env, 'links', 'player', players)).filter((r) => JSON.parse(r.data).status === 'active');
  toMap(other, out.links);
  const people = new Set([ME]);
  Object.values(out.links).forEach((l) => { people.add(l.coachId); people.add(l.playerId); });
  toMap(await rowsIn(env, 'profiles', 'id', [...people]), out.profiles);
  toMap(await rowsIn(env, 'codes', 'coach', [ME]), out.codes);
  const drillCoaches = new Set([ME, ...coaches]);
  Object.values(out.links).forEach((l) => { if (l.status === 'active' && players.includes(l.playerId)) drillCoaches.add(l.coachId); });
  toMap(await rowsIn(env, 'drills', 'id', [ME, ...players, ...[...drillCoaches].map((c) => 'c_' + c)]), out.drills);
  const scope = [ME, ...players];
  toMap(await rowsIn(env, 'logs', 'player', scope), out.logs);
  toMap(await rowsIn(env, 'rounds', 'player', scope), out.rounds);
  toMap(await rowsIn(env, 'feedback', 'player', [ME]), out.feedback);
  toMap(await rowsIn(env, 'feedback', 'coach', [ME]), out.feedback);
  const shared = players.filter((p) => out.profiles[p] && out.profiles[p].share);
  toMap(await rowsIn(env, 'feedback', 'player', shared), out.feedback);
  toMap(await rowsIn(env, 'reports', 'owner', [ME]), out.reports);
  return out;
}

/* ---------------- writes with permission checks ---------------- */
function cleanDrills(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).map((d) => ({
    id: str(d.id, 40).replace(/[^A-Za-z0-9_-]/g, '') || 'd' + rand(4),
    name: str(d.name, 40), target: str(d.target, 20), desc: str(d.desc, 80),
  })).filter((d) => d.name);
}
async function write(env, ME, b) {
  const { op, col } = b;
  const id = str(b.id, 200);
  const data = b.data && typeof b.data === 'object' ? b.data : {};
  const del = op === 'delete';
  if (!del && op !== 'set') return fail('지원하지 않는 작업이에요.');
  const deny = () => fail('권한이 없어요.', 403);

  switch (col) {
    case 'profiles': {
      if (id !== ME || del) return deny();
      const cur = (await getDoc(env, 'profiles', ME)) || {};
      const name = str(data.name, 30).trim() || cur.name || '이름 없음';
      await putDoc(env, 'profiles', ME, {
        name, share: !!data.share, field: cur.field || FIELD,
        coach: !!cur.coach, code: cur.code || null, createdAt: cur.createdAt || Date.now(),
      }, { owner: ME });
      return J({ ok: true });
    }
    case 'drills': {
      if (id !== ME && id !== 'c_' + ME) return deny();
      if (del) { await delDoc(env, col, id); return J({ ok: true }); }
      await putDoc(env, col, id, { list: cleanDrills(data.list), updatedAt: Date.now() }, { owner: ME });
      return J({ ok: true });
    }
    case 'logs': {
      const date = id.slice(ME.length + 2);
      if (!id.startsWith(ME + '__') || !isDate(date)) return deny();
      if (del) { await delDoc(env, col, id); return J({ ok: true }); }
      const checks = {};
      Object.entries(data.checks || {}).slice(0, 200).forEach(([k, v]) => { if (v) checks[str(k, 120)] = true; });
      await putDoc(env, col, id, {
        playerId: ME, date, checks, memo: str(data.memo, 3000),
        submitted: !!data.submitted, submittedAt: data.submittedAt || null, updatedAt: Date.now(),
      }, { player: ME });
      return J({ ok: true });
    }
    case 'rounds': {
      if (!/^r[a-z0-9]{4,40}$/.test(id)) return deny();
      const cur = await getDoc(env, col, id);
      if (cur && cur.playerId !== ME) return deny();
      if (del) { if (cur) await delDoc(env, col, id); return J({ ok: true }); }
      const holes = (Array.isArray(data.holes) ? data.holes : []).slice(0, 18).map((h) => ({
        par: [3, 4, 5].includes(+h.par) ? +h.par : 4,
        score: Math.max(0, Math.min(15, +h.score || 0)),
        putt: Math.max(0, Math.min(9, h.putt == null ? 2 : +h.putt)),
        fw: ['hit', 'L', 'R'].includes(h.fw) ? h.fw : null,
        note: str(h.note, 200),
      }));
      await putDoc(env, col, id, {
        playerId: ME, date: isDate(data.date) ? data.date : new Date().toISOString().slice(0, 10),
        course: str(data.course, 80), holes, misses: (data.misses || []).slice(0, 40).map((m) => str(m, 40)),
        memo: str(data.memo, 3000), createdAt: (cur && cur.createdAt) || data.createdAt || Date.now(), updatedAt: Date.now(),
      }, { player: ME });
      return J({ ok: true });
    }
    case 'feedback': {
      if (!id.startsWith(ME + '__')) return deny();
      if (del) { await delDoc(env, col, id); return J({ ok: true }); }
      const playerId = str(data.playerId, 60), kind = data.kind === 'round' ? 'round' : 'log', ref = str(data.ref, 120);
      if (id !== ME + '__' + kind + '__' + ref) return deny();
      if (!(await isActivePlayer(env, ME, playerId))) return fail('연결된 선수에게만 피드백할 수 있어요.', 403);
      await putDoc(env, col, id, {
        coachId: ME, playerId, kind, ref, date: isDate(data.date) ? data.date : '',
        text: str(data.text, 3000), at: Date.now(),
      }, { coach: ME, player: playerId });
      return J({ ok: true });
    }
    case 'reports': {
      if (!id.startsWith(ME + '__')) return deny();
      if (del) { await delDoc(env, col, id); return J({ ok: true }); }
      const playerId = str(data.playerId, 60);
      if (playerId !== ME && !(await isActivePlayer(env, ME, playerId))) return deny();
      await putDoc(env, col, id, { viewerId: ME, playerId, key: str(data.key, 20), text: str(data.text, 8000), createdAt: Date.now() }, { owner: ME, player: playerId });
      return J({ ok: true });
    }
    case 'links': {
      const cur = await getDoc(env, col, id);
      if (!cur) return fail('연결 정보를 찾지 못했어요.', 404);
      if (del) {
        if (cur.coachId !== ME && cur.playerId !== ME) return deny();
        await delDoc(env, col, id); return J({ ok: true });
      }
      if (cur.coachId !== ME || data.status !== 'active') return deny();
      await putDoc(env, col, id, { ...cur, status: 'active', approvedAt: Date.now() }, { coach: cur.coachId, player: cur.playerId });
      return J({ ok: true });
    }
    default:
      return deny();
  }
}

async function makeCode(env, ME) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  for (let t = 0; t < 10; t++) {
    const b = new Uint8Array(6); crypto.getRandomValues(b);
    code = [...b].map((x) => A[x % A.length]).join('');
    if (!(await getDoc(env, 'codes', code))) break;
  }
  await env.DB.prepare("DELETE FROM docs WHERE col='codes' AND coach=?").bind(ME).run();
  await putDoc(env, 'codes', code, { coachId: ME, createdAt: Date.now() }, { coach: ME });
  const p = (await getDoc(env, 'profiles', ME)) || {};
  await putDoc(env, 'profiles', ME, { ...p, code, coach: true }, { owner: ME });
  return J({ code });
}
async function joinCode(env, ME, b) {
  const code = str(b.code, 10).toUpperCase().replace(/\s/g, '');
  const c = code && (await getDoc(env, 'codes', code));
  if (!c) return fail('코드를 찾지 못했어요. 다시 확인해 주세요.', 404);
  if (c.coachId === ME) return fail('내 코드예요. 자기 자신과는 연결할 수 없어요.');
  const id = c.coachId + '__' + ME;
  const ex = await getDoc(env, 'links', id);
  if (ex) return fail(ex.status === 'active' ? '이미 연결된 코치예요.' : '이미 요청했어요. 코치 승인을 기다리는 중이에요.', 409);
  await putDoc(env, 'links', id, { coachId: c.coachId, playerId: ME, status: 'pending', createdAt: Date.now() }, { coach: c.coachId, player: ME });
  const p = await getDoc(env, 'profiles', c.coachId);
  return J({ ok: true, coachName: p ? p.name : '' });
}

async function ai(env, userId, b) {
  // 무료 운영 중에는 꺼둠. 정식 오픈 때 Cloudflare 변수 AI_ENABLED=true 와 ANTHROPIC_API_KEY 를 등록하세요.
  if (env.AI_ENABLED !== 'true') return fail('AI 정리는 정식 오픈 때 열려요.', 503);
  if (!env.ANTHROPIC_API_KEY) return fail('AI 정리가 아직 설정되지 않았어요. 관리자에게 문의하세요.', 503);
  const prompt = str(b.prompt, 30000);
  if (!prompt) return fail('내용이 없어요.');
  const day = new Date().toISOString().slice(0, 10);
  const limit = +(env.AI_DAILY_LIMIT || 20);
  const row = await env.DB.prepare('SELECT count FROM ai_usage WHERE user_id=? AND day=?').bind(userId, day).first();
  if (row && row.count >= limit) return fail(`오늘 AI 정리는 ${limit}회까지 쓸 수 있어요. 내일 다시 시도해 주세요.`, 429);
  await env.DB.prepare('INSERT INTO ai_usage(user_id,day,count) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1').bind(userId, day).run();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return fail('AI 응답을 받지 못했어요. (' + ((j.error && j.error.message) || r.status) + ')', 502);
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return J({ text });
}

/* ---------------- router ---------------- */
export async function onRequest({ request: req, env, params }) {
  const path = '/' + [].concat(params.path || []).join('/');
  const m = req.method;
  try {
    if (!env.DB) return fail('서버 설정 오류: D1 데이터베이스(DB)가 연결되지 않았어요.', 500);
    if (m !== 'GET') {
      const o = req.headers.get('origin');
      if (o && new URL(o).host !== new URL(req.url).host) return fail('허용되지 않은 요청이에요.', 403);
    }
    if (path === '/auth/signup' && m === 'POST') return await signup(req, env);
    if (path === '/auth/login' && m === 'POST') return await login(req, env);
    if (path === '/auth/logout' && m === 'POST') return await logout(req, env);

    const user = await currentUser(req, env);
    if (!user) return fail('로그인이 필요해요.', 401);
    const ME = 'u_' + user.id;

    if (path === '/me' && m === 'GET') return J({ user, me: ME });
    if (path === '/state' && m === 'GET') return J(await state(env, ME));
    if (path === '/docs' && m === 'POST') return await write(env, ME, await body(req));
    if (path === '/code' && m === 'POST') return await makeCode(env, ME);
    if (path === '/join' && m === 'POST') return await joinCode(env, ME, await body(req));
    if (path === '/ai' && m === 'POST') return await ai(env, user.id, await body(req));
    return fail('없는 경로예요.', 404);
  } catch (e) {
    console.error(e);
    return fail('서버 오류가 났어요. 잠시 뒤 다시 시도해 주세요.', 500);
  }
}
