// FeedUp API — Cloudflare Pages Functions
// 바인딩: env.DB (D1), 비밀값: env.ANTHROPIC_API_KEY
// 선택: env.AI_ENABLED('true'일 때만 AI 호출), env.ANTHROPIC_MODEL, env.AI_DAILY_LIMIT

const FIELD = 'golf';
const TERMS_VERSION = '2026-10-draft';
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

async function isParentOf(env, parent, player) {
  return !!(await getDoc(env, 'parents', parent + '__' + player));
}
const LESSON_TOPICS = ['스윙', '숏게임', '퍼팅', '코스 매니지먼트', '멘탈'];
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
function checkAgree(a) {
  a = a || {};
  if (!a.terms || !a.privacy || !a.overseas) return { err: '필수 약관에 모두 동의해 주세요.' };
  if (a.age === 'u14') {
    const name = str(a.gname, 30).trim(), phone = str(a.gphone, 20).replace(/[^0-9]/g, '');
    if (!name || phone.length < 9 || !a.gok) return { err: '만 14세 미만은 보호자 이름, 연락처, 보호자 동의가 필요해요.' };
    return { ok: { version: TERMS_VERSION, terms: true, privacy: true, overseas: true, age14: false, guardian: { name, phone }, at: Date.now() } };
  }
  if (a.age !== '14+') return { err: '나이 확인에 체크해 주세요.' };
  return { ok: { version: TERMS_VERSION, terms: true, privacy: true, overseas: true, age14: true, guardian: null, at: Date.now() } };
}
async function signup(req, env) {
  const b = await body(req);
  const email = str(b.email, 120).trim().toLowerCase();
  const pw = String(b.password || '');
  const name = str(b.name, 30).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('이메일 형식을 확인해 주세요.');
  if (pw.length < 8) return fail('비밀번호는 8자 이상이어야 해요.');
  if (!name) return fail('이름을 입력해 주세요.');
  const ag = checkAgree(b.agree);
  if (ag.err) return fail(ag.err);
  const ex = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if (ex) return fail('이미 가입된 이메일이에요. 로그인해 주세요.', 409);
  const id = rand(8), salt = rand(16);
  await env.DB.prepare('INSERT INTO users(id,email,pass_hash,salt,created) VALUES(?,?,?,?,?)')
    .bind(id, email, await hashPw(pw, salt), salt, Date.now()).run();
  const ME = 'u_' + id;
  await putDoc(env, 'profiles', ME, { name, share: false, field: FIELD, coach: false, createdAt: Date.now() }, { owner: ME });
  await putDoc(env, 'consents', ME, ag.ok, { owner: ME });
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
  const out = { profiles: {}, links: {}, codes: {}, drills: {}, logs: {}, rounds: {}, feedback: {}, reports: {}, lessons: {}, parents: {}, pcodes: {}, consents: {} };
  toMap(await rowsIn(env, 'consents', 'owner', [ME]), out.consents);
  const mine = [...(await rowsIn(env, 'links', 'coach', [ME])), ...(await rowsIn(env, 'links', 'player', [ME]))];
  toMap(mine, out.links);
  const L = Object.values(out.links);
  const players = L.filter((l) => l.coachId === ME && l.status === 'active').map((l) => l.playerId);
  const coaches = L.filter((l) => l.playerId === ME && l.status === 'active').map((l) => l.coachId);
  // 내 선수들의 다른 코치 (항목 이름과 배정 항목 표시용)
  const other = (await rowsIn(env, 'links', 'player', players)).filter((r) => JSON.parse(r.data).status === 'active');
  toMap(other, out.links);
  // 학부모 연결: 내가 학부모인 연결 + 내가 선수인 연결
  toMap([...(await rowsIn(env, 'parents', 'owner', [ME])), ...(await rowsIn(env, 'parents', 'player', [ME]))], out.parents);
  const children = Object.values(out.parents).filter((x) => x.parentId === ME).map((x) => x.playerId);
  const childLinks = (await rowsIn(env, 'links', 'player', children)).filter((r) => JSON.parse(r.data).status === 'active');
  toMap(childLinks, out.links);
  toMap(await rowsIn(env, 'pcodes', 'owner', [ME]), out.pcodes);
  const people = new Set([ME]);
  Object.values(out.links).forEach((l) => { people.add(l.coachId); people.add(l.playerId); });
  Object.values(out.parents).forEach((l) => { people.add(l.parentId); people.add(l.playerId); });
  toMap(await rowsIn(env, 'profiles', 'id', [...people]), out.profiles);
  toMap(await rowsIn(env, 'codes', 'coach', [ME]), out.codes);
  const drillCoaches = new Set([ME, ...coaches]);
  Object.values(out.links).forEach((l) => { if (l.status === 'active' && (players.includes(l.playerId) || children.includes(l.playerId))) drillCoaches.add(l.coachId); });
  toMap(await rowsIn(env, 'drills', 'id', [ME, ...players, ...children, ...[...drillCoaches].map((c) => 'c_' + c)]), out.drills);
  const scope = [ME, ...players, ...children];
  toMap(await rowsIn(env, 'logs', 'player', scope), out.logs);
  toMap(await rowsIn(env, 'rounds', 'player', scope), out.rounds);
  toMap(await rowsIn(env, 'feedback', 'player', [ME]), out.feedback);
  toMap(await rowsIn(env, 'feedback', 'coach', [ME]), out.feedback);
  const shared = players.filter((p) => out.profiles[p] && out.profiles[p].share);
  toMap(await rowsIn(env, 'feedback', 'player', shared), out.feedback);
  toMap(await rowsIn(env, 'feedback', 'player', children), out.feedback);
  toMap(await rowsIn(env, 'lessons', 'coach', [ME]), out.lessons);
  toMap(await rowsIn(env, 'lessons', 'player', [ME, ...children, ...shared]), out.lessons);
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
        coach: !!cur.coach, code: cur.code || null, parent: !!cur.parent, pcode: cur.pcode || null, createdAt: cur.createdAt || Date.now(),
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
        mentalScore: Math.max(0, Math.min(5, Math.round(+data.mentalScore || 0))),
        kind: data.kind === 'match' ? 'match' : 'practice',
        match: data.kind === 'match' ? {
          name: str(data.match && data.match.name, 80),
          round: ['1R', '2R', '3R', '4R'].includes(data.match && data.match.round) ? data.match.round : '1R',
          rank: str(data.match && data.match.rank, 6).replace(/[^0-9]/g, ''),
          field: str(data.match && data.match.field, 6).replace(/[^0-9]/g, ''),
          tension: Math.max(0, Math.min(5, +(data.match && data.match.tension) || 0)),
        } : null,
        memo: str(data.memo, 3000), createdAt: (cur && cur.createdAt) || data.createdAt || Date.now(), updatedAt: Date.now(),
      }, { player: ME });
      return J({ ok: true });
    }
    case 'feedback': {
      if (!id.startsWith(ME + '__')) return deny();
      if (del) { await delDoc(env, col, id); return J({ ok: true }); }
      const playerId = str(data.playerId, 60), kind = ['round', 'lesson'].includes(data.kind) ? data.kind : 'log', ref = str(data.ref, 120);
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
      if (playerId !== ME && !(await isActivePlayer(env, ME, playerId)) && !(await isParentOf(env, ME, playerId))) return deny();
      await putDoc(env, col, id, { viewerId: ME, playerId, key: str(data.key, 20), text: str(data.text, 8000), createdAt: Date.now() }, { owner: ME, player: playerId });
      return J({ ok: true });
    }
    case 'lessons': {
      if (!/^l[a-z0-9]{4,40}$/.test(id)) return deny();
      const cur = await getDoc(env, col, id);
      if (cur && cur.playerId !== ME) return deny();
      if (del) {
        if (!cur) return J({ ok: true });
        await removeMedia(env, (cur.media || []).map((m) => m.key));
        await delDoc(env, col, id); return J({ ok: true });
      }
      const coachId = str(data.coachId, 60);
      if (coachId && !(await isActivePlayer(env, coachId, ME))) return fail('연결된 코치만 고를 수 있어요.', 403);
      const prefix = 'lessons/' + ME + '/' + id + '/';
      const media = (Array.isArray(data.media) ? data.media : [])
        .filter((m) => m && typeof m.key === 'string' && m.key.startsWith(prefix) && !m.key.includes('..') && ['image', 'video'].includes(m.type))
        .slice(0, 6).map((m) => ({ key: m.key, type: m.type }));
      const keep = new Set(media.map((m) => m.key));
      await removeMedia(env, ((cur && cur.media) || []).map((m) => m.key).filter((k) => !keep.has(k)));
      await putDoc(env, col, id, {
        playerId: ME, coachId: coachId || null, coachName: coachId ? '' : str(data.coachName, 30),
        date: isDate(data.date) ? data.date : new Date().toISOString().slice(0, 10),
        topics: (Array.isArray(data.topics) ? data.topics : []).filter((t) => LESSON_TOPICS.includes(t)),
        content: str(data.content, 4000), homework: str(data.homework, 1000), media,
        createdAt: (cur && cur.createdAt) || Date.now(), updatedAt: Date.now(),
      }, { coach: coachId || null, player: ME });
      return J({ ok: true });
    }
    case 'parents': {
      const cur = await getDoc(env, col, id);
      if (!del) return deny();
      if (!cur) return J({ ok: true });
      if (cur.parentId !== ME && cur.playerId !== ME) return deny();
      await delDoc(env, col, id); return J({ ok: true });
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
    if (!(await getDoc(env, 'codes', code)) && !(await getDoc(env, 'pcodes', code))) break;
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
  if (!c) {
    if (code && (await getDoc(env, 'pcodes', code))) return fail('학부모 연결 코드예요. 코치에게 받은 코드를 입력해 주세요.', 404);
    return fail('코드를 찾지 못했어요. 다시 확인해 주세요.', 404);
  }
  if (c.coachId === ME) return fail('내 코드예요. 자기 자신과는 연결할 수 없어요.');
  const id = c.coachId + '__' + ME;
  const ex = await getDoc(env, 'links', id);
  if (ex) return fail(ex.status === 'active' ? '이미 연결된 코치예요.' : '이미 요청했어요. 코치 승인을 기다리는 중이에요.', 409);
  await putDoc(env, 'links', id, { coachId: c.coachId, playerId: ME, status: 'pending', createdAt: Date.now() }, { coach: c.coachId, player: ME });
  const p = await getDoc(env, 'profiles', c.coachId);
  return J({ ok: true, coachName: p ? p.name : '' });
}

/* ---------------- media (R2) ---------------- */
const IMG_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const VID_TYPES = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
async function removeMedia(env, keys) {
  if (!env.MEDIA || !keys.length) return;
  try { await env.MEDIA.delete(keys); } catch (e) { console.error(e); }
}
async function canSeePlayer(env, ME, player) {
  return player === ME || (await isActivePlayer(env, ME, player)) || (await isParentOf(env, ME, player));
}
async function mediaPut(req, env, ME, url) {
  if (!env.MEDIA) return fail('사진·영상 저장소가 아직 설정되지 않았어요.', 503);
  const lessonId = url.searchParams.get('lesson') || '';
  if (!/^l[a-z0-9]{4,40}$/.test(lessonId)) return fail('레슨 정보가 올바르지 않아요.');
  const cur = await getDoc(env, 'lessons', lessonId);
  if (cur && cur.playerId !== ME) return fail('권한이 없어요.', 403);
  const ct = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const isImg = !!IMG_TYPES[ct], isVid = !!VID_TYPES[ct];
  if (!isImg && !isVid) return fail('사진(jpg, png) 또는 영상(mp4, mov) 파일만 올릴 수 있어요.');
  const max = isImg ? 8 * 1024 * 1024 : 40 * 1024 * 1024;
  if (+(req.headers.get('content-length') || 0) > max) return fail(isImg ? '사진 용량이 너무 커요.' : '영상 용량이 너무 커요. 40MB 이하로 올려 주세요.', 413);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > max) return fail('파일 용량을 확인해 주세요.', 413);
  const key = 'lessons/' + ME + '/' + lessonId + '/' + rand(8) + '.' + (IMG_TYPES[ct] || VID_TYPES[ct]);
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: ct } });
  return J({ key, type: isImg ? 'image' : 'video' });
}
async function mediaGet(req, env, ME, key) {
  if (!env.MEDIA) return fail('사진·영상 저장소가 아직 설정되지 않았어요.', 503);
  const parts = key.split('/');
  if (parts.length !== 4 || parts[0] !== 'lessons' || key.includes('..')) return fail('없는 파일이에요.', 404);
  if (!(await canSeePlayer(env, ME, parts[1]))) return fail('권한이 없어요.', 403);
  const hasRange = !!req.headers.get('range');
  const obj = await env.MEDIA.get(key, hasRange ? { range: req.headers } : undefined);
  if (!obj) return fail('없는 파일이에요.', 404);
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag); h.set('accept-ranges', 'bytes'); h.set('cache-control', 'private, max-age=86400');
  if (hasRange && obj.range) {
    let offset = obj.range.offset, length = obj.range.length;
    if (obj.range.suffix != null) { length = Math.min(obj.range.suffix, obj.size); offset = obj.size - length; }
    if (offset == null) offset = 0;
    if (length == null) length = obj.size - offset;
    h.set('content-range', 'bytes ' + offset + '-' + (offset + length - 1) + '/' + obj.size);
    h.set('content-length', String(length));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set('content-length', String(obj.size));
  return new Response(obj.body, { headers: h });
}
async function mediaDelete(env, ME, key) {
  const parts = key.split('/');
  if (parts.length !== 4 || parts[0] !== 'lessons' || parts[1] !== ME) return fail('권한이 없어요.', 403);
  await removeMedia(env, [key]);
  return J({ ok: true });
}

async function giveConsent(env, ME, b) {
  const ag = checkAgree(b.agree);
  if (ag.err) return fail(ag.err);
  await putDoc(env, 'consents', ME, ag.ok, { owner: ME });
  return J({ ok: true });
}
async function deleteAccount(req, env, user) {
  const b = await body(req);
  const u = await env.DB.prepare('SELECT pass_hash,salt FROM users WHERE id=?').bind(user.id).first();
  if (!u || !same(await hashPw(String(b.password || ''), u.salt), u.pass_hash)) return fail('비밀번호가 맞지 않아요.', 401);
  const ME = 'u_' + user.id;
  if (env.MEDIA) {
    let cursor;
    do {
      const l = await env.MEDIA.list({ prefix: 'lessons/' + ME + '/', cursor });
      const keys = l.objects.map((o) => o.key);
      if (keys.length) await env.MEDIA.delete(keys);
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM docs WHERE owner=?1 OR player=?1 OR (coach=?1 AND col IN ('links','codes','feedback'))").bind(ME),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),
    env.DB.prepare('DELETE FROM ai_usage WHERE user_id=?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id=?').bind(user.id),
  ]);
  return J({ ok: true }, 200, { 'set-cookie': sessCookie('', 0) });
}

/* ---------------- admin ---------------- */
// 관리자: Cloudflare 런타임 변수 ADMIN_EMAILS 또는 D1의 admins 행으로 지정
async function isAdmin(env, user) {
  if (!user) return false;
  const email = String(user.email || '').trim().toLowerCase();
  const list = String(env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (list.includes(email)) return true;
  const r = await env.DB.prepare("SELECT 1 AS ok FROM docs WHERE col='admins' AND lower(id)=?").bind(email).first();
  return !!r;
}
async function adminOverview(env) {
  const all = async (q, ...b) => ((await env.DB.prepare(q).bind(...b).all()).results || []);
  const users = await all('SELECT id,email,created FROM users ORDER BY created DESC');
  const docs = await all("SELECT col,id,data FROM docs WHERE col IN ('profiles','consents','links','parents')");
  const P = {}, C = {}, links = [], parents = [];
  docs.forEach((r) => {
    const d = JSON.parse(r.data);
    if (r.col === 'profiles') P[r.id] = d; else if (r.col === 'consents') C[r.id] = d;
    else if (r.col === 'links') links.push(d); else parents.push(d);
  });
  const counts = {};
  (await all('SELECT col,COUNT(*) AS n FROM docs GROUP BY col')).forEach((r) => { counts[r.col] = r.n; });
  const matches = (await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE col='rounds' AND json_extract(data,'$.kind')='match'").first()).n;
  const media = (await env.DB.prepare("SELECT COALESCE(SUM(json_array_length(data,'$.media')),0) AS n FROM docs WHERE col='lessons' AND json_type(data,'$.media')='array'").first()).n;
  const act = {}, perUser = {};
  (await all("SELECT player,col,COUNT(*) AS n,MAX(updated) AS last FROM docs WHERE col IN ('logs','rounds','lessons') AND player IS NOT NULL GROUP BY player,col")).forEach((r) => {
    act[r.player] = Math.max(act[r.player] || 0, r.last);
    (perUser[r.player] = perUser[r.player] || {})[r.col] = r.n;
  });
  const fbBy = {};
  (await all("SELECT coach,COUNT(*) AS n,MAX(updated) AS last FROM docs WHERE col='feedback' GROUP BY coach")).forEach((r) => {
    fbBy[r.coach] = r.n; act[r.coach] = Math.max(act[r.coach] || 0, r.last);
  });
  const members = users.map((u) => {
    const me = 'u_' + u.id, p = P[me] || {}, c = C[me];
    const asCoach = links.filter((l) => l.coachId === me), asPlayer = links.filter((l) => l.playerId === me);
    const kids = parents.filter((x) => x.parentId === me), myParents = parents.filter((x) => x.playerId === me);
    const pu = perUser[me] || {};
    const isCoach = !!p.coach || asCoach.length > 0;
    const isParent = !!p.parent || kids.length > 0;
    const isPlayer = asPlayer.length > 0 || myParents.length > 0 || !!(pu.logs || pu.rounds || pu.lessons) || (!isCoach && !isParent);
    return {
      name: p.name || '(프로필 없음)', email: u.email, created: u.created, last: act[me] || null,
      roles: [isPlayer && 'player', isCoach && 'coach', isParent && 'parent'].filter(Boolean),
      under14: !!(c && c.age14 === false), consent: !!c,
      players: asCoach.filter((l) => l.status === 'active').length, pending: asCoach.filter((l) => l.status === 'pending').length,
      coaches: asPlayer.filter((l) => l.status === 'active').length, kids: kids.length, parents: myParents.length,
      logs: pu.logs || 0, rounds: pu.rounds || 0, lessons: pu.lessons || 0, feedback: fbBy[me] || 0,
    };
  });
  return J({
    now: Date.now(), members,
    totals: {
      users: users.length,
      players: members.filter((m) => m.roles.includes('player')).length,
      coaches: members.filter((m) => m.roles.includes('coach')).length,
      parents: members.filter((m) => m.roles.includes('parent')).length,
      under14: members.filter((m) => m.under14).length,
      active7: members.filter((m) => m.last && m.last > Date.now() - 7 * 864e5).length,
      linksActive: links.filter((l) => l.status === 'active').length, linksPending: links.filter((l) => l.status === 'pending').length,
      parentLinks: parents.length,
      logs: counts.logs || 0, lessons: counts.lessons || 0, rounds: counts.rounds || 0, matches, feedback: counts.feedback || 0, media,
    },
  });
}

async function makePcode(env, ME) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  for (let t = 0; t < 10; t++) {
    const b = new Uint8Array(6); crypto.getRandomValues(b);
    code = [...b].map((x) => A[x % A.length]).join('');
    if (!(await getDoc(env, 'pcodes', code)) && !(await getDoc(env, 'codes', code))) break;
  }
  await env.DB.prepare("DELETE FROM docs WHERE col='pcodes' AND owner=?").bind(ME).run();
  await putDoc(env, 'pcodes', code, { playerId: ME, createdAt: Date.now() }, { owner: ME });
  const p = (await getDoc(env, 'profiles', ME)) || {};
  await putDoc(env, 'profiles', ME, { ...p, pcode: code }, { owner: ME });
  return J({ code });
}
async function joinParent(env, ME, b) {
  const code = str(b.code, 10).toUpperCase().replace(/\s/g, '');
  const c = code && (await getDoc(env, 'pcodes', code));
  if (!c) {
    if (code && (await getDoc(env, 'codes', code))) return fail('코치 초대 코드예요. 자녀에게 받은 학부모 코드를 입력해 주세요.', 404);
    return fail('코드를 찾지 못했어요. 다시 확인해 주세요.', 404);
  }
  if (c.playerId === ME) return fail('내 코드예요. 자기 자신과는 연결할 수 없어요.');
  const id = ME + '__' + c.playerId;
  if (await getDoc(env, 'parents', id)) return fail('이미 연결된 자녀예요.', 409);
  await putDoc(env, 'parents', id, { parentId: ME, playerId: c.playerId, status: 'active', createdAt: Date.now() }, { owner: ME, player: c.playerId });
  const me = (await getDoc(env, 'profiles', ME)) || {};
  await putDoc(env, 'profiles', ME, { ...me, parent: true }, { owner: ME });
  const p = await getDoc(env, 'profiles', c.playerId);
  return J({ ok: true, childName: p ? p.name : '' });
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

    if (path === '/me' && m === 'GET') return J({ user, me: ME, admin: await isAdmin(env, user) });
    if (path === '/admin/overview' && m === 'GET') return (await isAdmin(env, user)) ? await adminOverview(env) : fail('관리자만 볼 수 있어요.', 403);
    if (path === '/state' && m === 'GET') return J(await state(env, ME));
    if (path === '/docs' && m === 'POST') return await write(env, ME, await body(req));
    if (path === '/code' && m === 'POST') return await makeCode(env, ME);
    if (path === '/join' && m === 'POST') return await joinCode(env, ME, await body(req));
    if (path === '/pcode' && m === 'POST') return await makePcode(env, ME);
    if (path === '/consent' && m === 'POST') return await giveConsent(env, ME, await body(req));
    if (path === '/account/delete' && m === 'POST') return await deleteAccount(req, env, user);
    if (path === '/media' && m === 'POST') return await mediaPut(req, env, ME, new URL(req.url));
    if (path.startsWith('/media/') && (m === 'GET' || m === 'HEAD')) return await mediaGet(req, env, ME, decodeURIComponent(path.slice(7)));
    if (path.startsWith('/media/') && m === 'DELETE') return await mediaDelete(env, ME, decodeURIComponent(path.slice(7)));
    if (path === '/pjoin' && m === 'POST') return await joinParent(env, ME, await body(req));
    if (path === '/ai' && m === 'POST') return await ai(env, user.id, await body(req));
    return fail('없는 경로예요.', 404);
  } catch (e) {
    console.error(e);
    return fail('서버 오류가 났어요. 잠시 뒤 다시 시도해 주세요.', 500);
  }
}
