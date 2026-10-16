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
// 종목: 계정마다 sports 목록(예: ['golf','pt']). 예전 계정은 가입 종목(field) 하나.
const SPORTS = ['golf', 'pt'];
const fid = (f) => (typeof f === 'string' ? f : (f && f.id)) || 'golf';
const sportsOf = (p) => (p && Array.isArray(p.sports) && p.sports.filter(Boolean).length ? p.sports.filter(Boolean) : [fid(p && p.field)]);
// 연결(links)의 종목. 예전 연결은 코치의 가입 종목으로 봐요.
async function linkSport(env, l) {
  if (l.sport) return l.sport;
  const p = await getDoc(env, 'profiles', l.coachId);
  return fid(p && p.field);
}
// 골프 코치-선수 연결 (id: 코치__선수)
async function isActivePlayer(env, coach, player) {
  const l = await getDoc(env, 'links', coach + '__' + player);
  return !!(l && l.status === 'active' && (await linkSport(env, l)) === 'golf');
}
// PT 트레이너-회원 연결 (id: 트레이너__회원__pt, 예전 PT 연결은 접미사 없음)
async function isActivePt(env, coach, player) {
  const l = await getDoc(env, 'links', coach + '__' + player + '__pt');
  if (l && l.status === 'active') return true;
  const o = await getDoc(env, 'links', coach + '__' + player);
  return !!(o && o.status === 'active' && (await linkSport(env, o)) === 'pt');
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
const SPACES = ['academy', 'solo'];
const PT_FIELD = { id: 'pt', label: 'PT' };
const fieldOf = (p) => fid(p && p.field);
const SPACE_NAME = { academy: '아카데미', solo: '개인 · 개인 레슨' };
async function sameSpace(env, a, b) {
  const pa = (await getDoc(env, 'profiles', a)) || {}, pb = (await getDoc(env, 'profiles', b)) || {};
  return !pa.space || !pb.space || pa.space === pb.space ? null : pb.space;
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
  const space = SPACES.includes(b.space) ? b.space : null;
  const field = b.app === 'pt' ? PT_FIELD : FIELD;
  await putDoc(env, 'profiles', ME, { name, share: false, field, sports: [b.app === 'pt' ? 'pt' : 'golf'], codes: {}, coaches: {}, coach: false, space: b.app === 'pt' ? null : space, createdAt: Date.now() }, { owner: ME });
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
  const out = { profiles: {}, links: {}, codes: {}, drills: {}, logs: {}, rounds: {}, feedback: {}, reports: {}, lessons: {}, parents: {}, pcodes: {}, consents: {}, homework: {} };
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
  toMap(await rowsIn(env, 'drills', 'id', [ME, ...players, ...children, ...[ME, ...players, ...children].map((x) => 's_' + x), ...[...drillCoaches].map((c) => 'c_' + c)]), out.drills);
  const scope = [ME, ...players, ...children];
  toMap(await rowsIn(env, 'logs', 'player', scope), out.logs);
  toMap(await rowsIn(env, 'rounds', 'player', scope), out.rounds);
  toMap(await rowsIn(env, 'feedback', 'player', [ME]), out.feedback);
  toMap(await rowsIn(env, 'feedback', 'coach', [ME]), out.feedback);
  const shared = players.filter((p) => out.profiles[p] && out.profiles[p].share);
  toMap(await rowsIn(env, 'feedback', 'player', shared), out.feedback);
  toMap(await rowsIn(env, 'feedback', 'player', children), out.feedback);
  toMap(await rowsIn(env, 'lessons', 'coach', [ME]), out.lessons);
  toMap(await rowsIn(env, 'homework', 'coach', [ME]), out.homework);
  toMap(await rowsIn(env, 'homework', 'player', [ME, ...children]), out.homework);
  toMap(await rowsIn(env, 'lessons', 'player', [ME, ...children, ...shared]), out.lessons);
  toMap(await rowsIn(env, 'reports', 'owner', [ME]), out.reports);
  // 골프 레슨 일정
  out.gclass = {};
  toMap(await rowsIn(env, 'gclass', 'coach', [ME]), out.gclass);
  toMap(await rowsIn(env, 'gclass', 'player', [ME, ...children]), out.gclass);
  // PT: 나와 내 회원들의 기록 + 내가 만든 운동
  out.ptdocs = {};
  toMap(await rowsIn(env, 'ptdocs', 'player', [ME, ...players]), out.ptdocs);
  toMap(await rowsIn(env, 'ptdocs', 'owner', [ME]), out.ptdocs);
  return out;
}

/* ---------------- writes with permission checks ---------------- */
function cleanDrills(list, keepEmpty) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).map((d) => ({
    id: str(d.id, 40).replace(/[^A-Za-z0-9_-]/g, '') || 'd' + rand(4),
    name: str(d.name, 40), target: str(d.target, 20), desc: str(d.desc, 80),
  })).filter((d) => keepEmpty || d.name);
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
        sports: sportsOf(cur), codes: cur.codes || {}, coaches: cur.coaches || {},
        // 사용 방식(아카데미/개인)은 처음 한 번만 정해요. 바꾸는 건 관리자만 할 수 있어요.
        space: cur.space || (SPACES.includes(data.space) ? data.space : null),
      }, { owner: ME });
      return J({ ok: true });
    }
    case 'drills': {
      if (id !== ME && id !== 'c_' + ME && id !== 's_' + ME) return deny();
      if (del) { await delDoc(env, col, id); return J({ ok: true }); }
      await putDoc(env, col, id, { list: cleanDrills(data.list, id === 's_' + ME), updatedAt: Date.now() }, { owner: ME });
      return J({ ok: true });
    }
    case 'logs': {
      let rest = id.slice(ME.length + 2), lspace = 'academy';
      if (rest.startsWith('s__')) { lspace = 'solo'; rest = rest.slice(3); }
      const date = rest;
      if (!id.startsWith(ME + '__') || !isDate(date)) return deny();
      if (del) { await delDoc(env, col, id); return J({ ok: true }); }
      const checks = {};
      Object.entries(data.checks || {}).slice(0, 200).forEach(([k, v]) => { if (v) checks[str(k, 120)] = true; });
      await putDoc(env, col, id, {
        playerId: ME, date, space: lspace, checks, memo: str(data.memo, 3000),
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
        shots: (Array.isArray(h.shots) ? h.shots : []).slice(0, 30).map((m) => str(m, 40)).filter(Boolean),
      }));
      await putDoc(env, col, id, {
        playerId: ME, date: isDate(data.date) ? data.date : new Date().toISOString().slice(0, 10),
        course: str(data.course, 80), holes, misses: (data.misses || []).slice(0, 40).map((m) => str(m, 40)),
        mentalScore: Math.max(0, Math.min(5, Math.round(+data.mentalScore || 0))),
        space: (data.space === 'solo' ? 'solo' : 'academy'),
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
      const cur = await getDoc(env, col, id);
      const curKeys = ((cur && cur.media) || []).map((m) => m.key);
      if (del) { await removeMedia(env, curKeys); await delDoc(env, col, id); return J({ ok: true }); }
      const playerId = str(data.playerId, 60), kind = ['round', 'lesson'].includes(data.kind) ? data.kind : 'log', ref = str(data.ref, 120);
      if (id !== ME + '__' + kind + '__' + ref) return deny();
      if (!(await isActivePlayer(env, ME, playerId))) return fail('연결된 선수에게만 피드백할 수 있어요.', 403);
      // 피드백 사진·영상: fb/<선수>/<코치>/ 아래 파일만 받아요
      const pfx = 'fb/' + playerId + '/' + ME + '/';
      const media = (Array.isArray(data.media) ? data.media : []).filter((m) => m && typeof m.key === 'string' && m.key.startsWith(pfx) && !m.key.includes('..') && ['image', 'video'].includes(m.type)).slice(0, 6).map((m) => ({ key: m.key, type: m.type }));
      const keep = new Set(media.map((m) => m.key));
      await removeMedia(env, curKeys.filter((k) => !keep.has(k)));
      await putDoc(env, col, id, {
        coachId: ME, playerId, kind, ref, date: isDate(data.date) ? data.date : '',
        text: str(data.text, 3000), media, at: Date.now(),
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
      // 선수가 쓴 레슨(author: player)과 개인 레슨에서 코치가 쓴 레슨(author: coach)을 모두 받아요. 쓴 사람만 고치고 지울 수 있어요.
      if (!/^l[a-z0-9]{4,40}$/.test(id)) return deny();
      const cur = await getDoc(env, col, id);
      const byCoach = cur ? cur.author === 'coach' : data.author === 'coach';
      if (cur) {
        if (byCoach ? cur.coachId !== ME : cur.playerId !== ME) return deny();
      }
      if (del) {
        if (!cur) return J({ ok: true });
        await removeMedia(env, (cur.media || []).map((m) => m.key));
        await delDoc(env, col, id); return J({ ok: true });
      }
      let playerId, coachId, coachName = '';
      if (byCoach) {
        if (data.space !== 'solo') return fail('코치 레슨 기록은 개인 레슨에서만 쓸 수 있어요.', 403);
        playerId = cur ? cur.playerId : str(data.playerId, 60);
        if (!(await isActivePlayer(env, ME, playerId))) return fail('연결된 선수에게만 레슨을 기록할 수 있어요.', 403);
        coachId = ME;
      } else {
        playerId = ME;
        coachId = str(data.coachId, 60);
        if (coachId && !(await isActivePlayer(env, coachId, ME))) return fail('연결된 코치만 고를 수 있어요.', 403);
        coachName = coachId ? '' : str(data.coachName, 30);
      }
      const prefix = 'lessons/' + playerId + '/' + id + '/';
      const media = (Array.isArray(data.media) ? data.media : [])
        .filter((m) => m && typeof m.key === 'string' && m.key.startsWith(prefix) && !m.key.includes('..') && ['image', 'video'].includes(m.type))
        .slice(0, 6).map((m) => ({ key: m.key, type: m.type }));
      const keep = new Set(media.map((m) => m.key));
      await removeMedia(env, ((cur && cur.media) || []).map((m) => m.key).filter((k) => !keep.has(k)));
      await putDoc(env, col, id, {
        playerId, coachId: coachId || null, coachName, author: byCoach ? 'coach' : 'player',
        date: isDate(data.date) ? data.date : new Date().toISOString().slice(0, 10),
        topics: (Array.isArray(data.topics) ? data.topics : []).filter((t) => LESSON_TOPICS.includes(t)),
        content: str(data.content, 4000), homework: str(data.homework, 1000), media, space: (data.space === 'solo' ? 'solo' : 'academy'),
        createdAt: (cur && cur.createdAt) || Date.now(), updatedAt: Date.now(),
      }, { coach: coachId || null, player: playerId });
      return J({ ok: true });
    }
    case 'homework': {
      if (!/^h[a-z0-9]{4,40}$/.test(id)) return deny();
      const cur = await getDoc(env, col, id);
      if (cur && cur.coachId !== ME) return deny();
      if (del) { if (cur) await delDoc(env, col, id); return J({ ok: true }); }
      const playerId = str(data.playerId, 60);
      if (!(await isActivePlayer(env, ME, playerId))) return fail('연결된 선수에게만 숙제를 보낼 수 있어요.', 403);
      const homework = str(data.homework, 1000).trim();
      if (!homework) return fail('숙제를 한 줄 이상 적어 주세요.');
      await putDoc(env, col, id, {
        coachId: ME, playerId, date: isDate(data.date) ? data.date : new Date().toISOString().slice(0, 10),
        homework, memo: str(data.memo, 1000), space: (data.space === 'solo' ? 'solo' : 'academy'),
        createdAt: (cur && cur.createdAt) || Date.now(), updatedAt: Date.now(),
      }, { coach: ME, player: playerId });
      return J({ ok: true });
    }
    case 'parents': {
      const cur = await getDoc(env, col, id);
      if (!del) return deny();
      if (!cur) return J({ ok: true });
      if (cur.parentId !== ME && cur.playerId !== ME) return deny();
      await delDoc(env, col, id); return J({ ok: true });
    }
    case 'gclass': {
      // 골프 레슨 일정: 코치가 연결된 선수의 레슨 날짜·시간을 잡아요 (하루 전 오후 2시 알림)
      if (!/^gc[a-z0-9]{6,40}$/.test(id)) return deny();
      const cur = await getDoc(env, col, id);
      if (cur && cur.coachId !== ME) return deny();
      if (del) { if (cur) await delDoc(env, col, id); return J({ ok: true }); }
      const playerId = cur ? cur.playerId : str(data.playerId, 60);
      if (!(await isActivePlayer(env, ME, playerId))) return fail('연결된 선수에게만 레슨을 잡을 수 있어요.', 403);
      if (!isDate(data.date) || !/^\d{2}:\d{2}$/.test(String(data.time || ''))) return fail('날짜와 시간을 확인해 주세요.');
      await putDoc(env, col, id, { coachId: ME, playerId, date: data.date, time: data.time, memo: str(data.memo, 60), status: data.status === 'done' ? 'done' : 'booked', space: data.space === 'solo' ? 'solo' : 'academy', createdAt: (cur && cur.createdAt) || Date.now(), updatedAt: Date.now() }, { coach: ME, player: playerId });
      return J({ ok: true });
    }
    case 'ptdocs': {
      // PT 기록. 회원이 쓰는 것(log 운동, meal 식단, pain 통증), 트레이너가 쓰는 것(session 수업, class 일정, fb 피드백, pkg 회원권),
      // 둘 다 쓰는 것(inbody), 트레이너 자신의 운동(cex). 쓴 사람만 고치고 지울 수 있어요.
      const mm = id.match(/^(log|meal|pain|session|class|fb|pkg|inbody|body|cex)_[a-z0-9_]{4,90}$/);
      if (!mm) return deny();
      const kind = mm[1];
      const cur = await getDoc(env, col, id);
      if (kind === 'cex') {
        if (cur && cur.author !== ME) return deny();
        if (del) { if (cur) await delDoc(env, col, id); return J({ ok: true }); }
        await putDoc(env, col, id, { kind, author: ME, name: str(data.name, 40), part: str(data.part, 10), eq: str(data.eq, 20), updatedAt: Date.now() }, { owner: ME });
        return J({ ok: true });
      }
      const memberId = cur ? cur.memberId : str(data.memberId, 60);
      let role = null;
      if (memberId === ME) role = 'member';
      else if (memberId && (await isActivePt(env, ME, memberId))) role = 'trainer';
      if (!role) return deny();
      if (['log', 'meal', 'pain'].includes(kind) && role !== 'member') {
        // 트레이너는 회원 통증을 '확인함'으로만 바꿀 수 있어요
        if (kind === 'pain' && cur && !del) { await putDoc(env, col, id, { ...cur, seen: true }, { player: memberId }); return J({ ok: true }); }
        return deny();
      }
      if (['session', 'class', 'fb', 'pkg'].includes(kind) && role !== 'trainer') return deny();
      if (cur && cur.author !== ME) return deny();
      const pfx = 'pt/' + memberId + '/';
      const keysOf = (d) => [...((d && Array.isArray(d.media)) ? d.media.map((x) => x && x.key) : []), d && d.key].filter((k) => typeof k === 'string' && k.startsWith(pfx));
      if (del) { if (cur) { await removeMedia(env, keysOf(cur)); await delDoc(env, col, id); } return J({ ok: true }); }
      const clean = { ...data };
      delete clean.memberId; delete clean.author; delete clean.kind;
      if ('media' in clean) clean.media = (Array.isArray(clean.media) ? clean.media : []).filter((x) => x && typeof x.key === 'string' && x.key.startsWith(pfx) && !x.key.includes('..') && ['image', 'video'].includes(x.type)).slice(0, 12).map((x) => ({ key: x.key, type: x.type, ex: str(x.ex || '', 60) }));
      if (kind === 'body') { if (typeof clean.key !== 'string' || !clean.key.startsWith(pfx) || clean.key.includes('..')) return fail('사진을 먼저 올려 주세요.'); clean.angle = ['정면', '측면', '후면'].includes(clean.angle) ? clean.angle : '정면'; }
      if (cur) { const keep = new Set(keysOf(clean)); await removeMedia(env, keysOf(cur).filter((k) => !keep.has(k))); }
      await putDoc(env, col, id, { ...clean, kind, memberId, author: ME, createdAt: (cur && cur.createdAt) || Date.now(), updatedAt: Date.now() }, { player: memberId, coach: role === 'trainer' ? ME : null });
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

async function makeCode(env, ME, b) {
  const p0 = (await getDoc(env, 'profiles', ME)) || {};
  const sport = b && b.sport === 'pt' ? 'pt' : 'golf';
  if (!sportsOf(p0).includes(sport)) return fail('이 계정은 ' + (sport === 'pt' ? 'PT' : '골프') + ' 종목을 쓰지 않아요. 종목 추가는 관리자에게 문의해 주세요.', 403);
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  for (let t = 0; t < 10; t++) {
    const u = new Uint8Array(6); crypto.getRandomValues(u);
    code = [...u].map((x) => A[x % A.length]).join('');
    if (!(await getDoc(env, 'codes', code)) && !(await getDoc(env, 'pcodes', code))) break;
  }
  const primary = fid(p0.field);
  // 같은 종목의 예전 코드만 지워요 (종목마다 코드 하나)
  for (const r of await rowsIn(env, 'codes', 'coach', [ME])) {
    const d = JSON.parse(r.data);
    if ((d.sport || primary) === sport) await delDoc(env, 'codes', r.id);
  }
  await putDoc(env, 'codes', code, { coachId: ME, sport, createdAt: Date.now() }, { coach: ME });
  const p = (await getDoc(env, 'profiles', ME)) || {};
  const next = { ...p, codes: { ...(p.codes || {}), [sport]: code }, coaches: { ...(p.coaches || {}), [sport]: true } };
  if (sport === primary) { next.code = code; next.coach = true; }
  await putDoc(env, 'profiles', ME, next, { owner: ME });
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
  const coachP = (await getDoc(env, 'profiles', c.coachId)) || {};
  const sport = c.sport || fid(coachP.field);
  const meP = (await getDoc(env, 'profiles', ME)) || {};
  if (!sportsOf(meP).includes(sport)) return fail(sport === 'pt' ? '이 코드는 PT 트레이너 코드예요. PT를 쓰는 계정에서 입력해 주세요. (종목 추가는 관리자에게 문의)' : '이 코드는 골프 코치 코드예요. 골프를 쓰는 계정에서 입력해 주세요. (종목 추가는 관리자에게 문의)', 409);
  if (sport === 'golf') {
    const diff = await sameSpace(env, ME, c.coachId);
    if (diff) return fail('이 코치는 ' + SPACE_NAME[diff] + ' 회원이에요. 사용 방식이 같아야 연결할 수 있어요. 변경이 필요하면 문의해 주세요.', 409);
  }
  const id = c.coachId + '__' + ME + (sport === 'pt' ? '__pt' : '');
  let ex = await getDoc(env, 'links', id);
  if (!ex && sport === 'pt') { const o = await getDoc(env, 'links', c.coachId + '__' + ME); if (o && (await linkSport(env, o)) === 'pt') ex = o; }
  const who = sport === 'pt' ? '트레이너' : '코치';
  if (ex) return fail(ex.status === 'active' ? '이미 연결된 ' + who + '예요.' : '이미 요청했어요. ' + who + ' 승인을 기다리는 중이에요.', 409);
  await putDoc(env, 'links', id, { coachId: c.coachId, playerId: ME, status: 'pending', sport, createdAt: Date.now() }, { coach: c.coachId, player: ME });
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
  const owner = url.searchParams.get('player') || ME;
  if (owner === ME) {
    if (cur && (cur.author === 'coach' || cur.playerId !== ME)) return fail('권한이 없어요.', 403);
  } else {
    if (!(await isActivePlayer(env, ME, owner))) return fail('권한이 없어요.', 403);
    if (cur && (cur.author !== 'coach' || cur.coachId !== ME || cur.playerId !== owner)) return fail('권한이 없어요.', 403);
  }
  const ct = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const isImg = !!IMG_TYPES[ct], isVid = !!VID_TYPES[ct];
  if (!isImg && !isVid) return fail('사진(jpg, png) 또는 영상(mp4, mov) 파일만 올릴 수 있어요.');
  const max = isImg ? 8 * 1024 * 1024 : 40 * 1024 * 1024;
  if (+(req.headers.get('content-length') || 0) > max) return fail(isImg ? '사진 용량이 너무 커요.' : '영상 용량이 너무 커요. 40MB 이하로 올려 주세요.', 413);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > max) return fail('파일 용량을 확인해 주세요.', 413);
  const key = 'lessons/' + owner + '/' + lessonId + '/' + rand(8) + '.' + (IMG_TYPES[ct] || VID_TYPES[ct]);
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: ct } });
  return J({ key, type: isImg ? 'image' : 'video' });
}
// PT 사진·영상: pt/<회원>/<올린 사람>/<파일> — 회원 본인과 연결된 트레이너만 올리고 볼 수 있어요.
// 골프 코치 피드백 사진·영상: fb/<선수>/<코치>/<파일> — 선수와 연결된 코치만 올려요
async function fbMediaPut(req, env, ME, url) {
  const player = str(url.searchParams.get('player') || '', 60);
  if (!/^u_[a-z0-9]{4,40}$/.test(player) || !(await isActivePlayer(env, ME, player))) return fail('연결된 선수에게만 보낼 수 있어요.', 403);
  return await mediaPutAt(req, env, 'fb/' + player + '/' + ME + '/');
}
async function ptMediaPut(req, env, ME, url) {
  if (!env.MEDIA) return fail('사진·영상 저장소가 아직 설정되지 않았어요.', 503);
  const member = str(url.searchParams.get('member') || ME, 60);
  if (!/^u_[a-z0-9]{4,40}$/.test(member)) return fail('회원 정보가 올바르지 않아요.');
  if (member !== ME && !(await isActivePt(env, ME, member))) return fail('권한이 없어요.', 403);
  return await mediaPutAt(req, env, 'pt/' + member + '/' + ME + '/');
}
async function mediaPutAt(req, env, prefix) {
  if (!env.MEDIA) return fail('사진·영상 저장소가 아직 설정되지 않았어요.', 503);
  const ct = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const isImg = !!IMG_TYPES[ct], isVid = !!VID_TYPES[ct];
  if (!isImg && !isVid) return fail('사진(jpg, png) 또는 영상(mp4, mov) 파일만 올릴 수 있어요.');
  const max = isImg ? 8 * 1024 * 1024 : 40 * 1024 * 1024;
  if (+(req.headers.get('content-length') || 0) > max) return fail(isImg ? '사진 용량이 너무 커요.' : '영상 용량이 너무 커요. 40MB 이하로 올려 주세요.', 413);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > max) return fail('파일 용량을 확인해 주세요.', 413);
  const key = prefix + rand(8) + '.' + (IMG_TYPES[ct] || VID_TYPES[ct]);
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: ct } });
  return J({ key, type: isImg ? 'image' : 'video' });
}
/* 큰 영상(원본) 나눠 올리기: 소리를 지키려고 압축 못 한 원본을 20MB씩 나눠 R2에 올려요 */
const BIG_MAX = 400 * 1024 * 1024, PART = 20 * 1024 * 1024;
async function bigStart(env, ME, b) {
  if (!env.MEDIA) return fail('사진·영상 저장소가 아직 설정되지 않았어요.', 503);
  const ct = str(b.type, 40).toLowerCase();
  if (!VID_TYPES[ct]) return fail('mp4나 mov 영상만 올릴 수 있어요.');
  if (!(+b.size > 0) || +b.size > BIG_MAX) return fail('영상 용량이 너무 커요. 400MB 이하로 올려 주세요.', 413);
  let key;
  if (b.kind === 'fb') {
    const player = str(b.player || '', 60);
    if (!/^u_[a-z0-9]{4,40}$/.test(player) || !(await isActivePlayer(env, ME, player))) return fail('연결된 선수에게만 보낼 수 있어요.', 403);
    key = 'fb/' + player + '/' + ME + '/' + rand(8) + '.' + VID_TYPES[ct];
  } else if (b.kind === 'pt') {
    const member = str(b.member || ME, 60);
    if (!/^u_[a-z0-9]{4,40}$/.test(member)) return fail('회원 정보가 올바르지 않아요.');
    if (member !== ME && !(await isActivePt(env, ME, member))) return fail('권한이 없어요.', 403);
    key = 'pt/' + member + '/' + ME + '/' + rand(8) + '.' + VID_TYPES[ct];
  } else {
    const lessonId = str(b.lesson, 50);
    if (!/^l[a-z0-9]{4,40}$/.test(lessonId)) return fail('레슨 정보가 올바르지 않아요.');
    const cur = await getDoc(env, 'lessons', lessonId);
    const owner = str(b.player || ME, 60);
    if (owner === ME) { if (cur && (cur.author === 'coach' || cur.playerId !== ME)) return fail('권한이 없어요.', 403); }
    else {
      if (!(await isActivePlayer(env, ME, owner))) return fail('권한이 없어요.', 403);
      if (cur && (cur.author !== 'coach' || cur.coachId !== ME || cur.playerId !== owner)) return fail('권한이 없어요.', 403);
    }
    key = 'lessons/' + owner + '/' + lessonId + '/' + rand(8) + '.' + VID_TYPES[ct];
  }
  const mpu = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: ct } });
  await putDoc(env, 'uploads', mpu.uploadId.slice(0, 180), { key, by: ME, size: +b.size, at: Date.now() }, { owner: ME });
  return J({ key, uploadId: mpu.uploadId, partSize: PART });
}
async function bigCheck(env, ME, uploadId, key) {
  const d = await getDoc(env, 'uploads', String(uploadId || '').slice(0, 180));
  return d && d.by === ME && d.key === key ? d : null;
}
async function bigPart(req, env, ME, url) {
  const key = url.searchParams.get('key') || '', uploadId = url.searchParams.get('uploadId') || '', n = +url.searchParams.get('n');
  if (!(n >= 1 && n <= 40) || !(await bigCheck(env, ME, uploadId, key))) return fail('권한이 없어요.', 403);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > PART) return fail('조각 크기가 올바르지 않아요.', 413);
  const part = await env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(n, buf);
  return J({ partNumber: part.partNumber, etag: part.etag });
}
async function bigDone(env, ME, b) {
  const key = str(b.key, 200), uploadId = str(b.uploadId, 400);
  if (!(await bigCheck(env, ME, uploadId, key))) return fail('권한이 없어요.', 403);
  const up = env.MEDIA.resumeMultipartUpload(key, uploadId);
  await delDoc(env, 'uploads', uploadId.slice(0, 180));
  if (b.abort) { try { await up.abort(); } catch (e) {} return J({ ok: true }); }
  const parts = (Array.isArray(b.parts) ? b.parts : []).map((p) => ({ partNumber: +p.partNumber, etag: str(p.etag, 200) })).sort((a, c) => a.partNumber - c.partNumber);
  await up.complete(parts);
  return J({ key, type: 'video' });
}
async function mediaGet(req, env, ME, key) {
  if (!env.MEDIA) return fail('사진·영상 저장소가 아직 설정되지 않았어요.', 503);
  const parts = key.split('/');
  if (parts.length !== 4 || !['lessons', 'pt', 'fb'].includes(parts[0]) || key.includes('..')) return fail('없는 파일이에요.', 404);
  if (parts[0] === 'pt') { if (parts[1] !== ME && !(await isActivePt(env, ME, parts[1]))) return fail('권한이 없어요.', 403); }
  else if (!(await canSeePlayer(env, ME, parts[1]))) return fail('권한이 없어요.', 403);
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
  if (parts.length === 4 && (parts[0] === 'pt' || parts[0] === 'fb') && !key.includes('..')) {
    if (parts[2] !== ME) return fail('직접 올린 파일만 지울 수 있어요.', 403);
    await removeMedia(env, [key]); return J({ ok: true });
  }
  if (parts.length !== 4 || parts[0] !== 'lessons' || key.includes('..')) return fail('권한이 없어요.', 403);
  if (parts[1] !== ME) {
    if (!(await isActivePlayer(env, ME, parts[1]))) return fail('권한이 없어요.', 403);
    const l = await getDoc(env, 'lessons', parts[2]);
    if (l && (l.author !== 'coach' || l.coachId !== ME)) return fail('권한이 없어요.', 403);
  } else {
    const l = await getDoc(env, 'lessons', parts[2]);
    if (l && l.author === 'coach') return fail('권한이 없어요.', 403);
  }
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
    // 내가 코치로 보낸 피드백 사진·영상도 지워요
    const myFb = (await env.DB.prepare("SELECT data FROM docs WHERE col='feedback' AND coach=?").bind(ME).all()).results || [];
    await removeMedia(env, myFb.flatMap((r) => (JSON.parse(r.data).media || []).map((m) => m.key)).filter((k) => typeof k === 'string' && k.startsWith('fb/')));
    for (const prefix of ['lessons/' + ME + '/', 'pt/' + ME + '/', 'fb/' + ME + '/']) {
      let cursor;
      do {
        const l = await env.MEDIA.list({ prefix, cursor });
        const keys = l.objects.map((o) => o.key);
        if (keys.length) await env.MEDIA.delete(keys);
        cursor = l.truncated ? l.cursor : undefined;
      } while (cursor);
    }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM docs WHERE owner=?1 OR player=?1 OR (coach=?1 AND col IN ('links','codes','feedback','gclass'))").bind(ME),
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
async function adminSports(env, b) {
  const id = str(b.id, 60);
  const sports = (Array.isArray(b.sports) ? b.sports : []).filter((x) => SPORTS.includes(x));
  if (!sports.length) return fail('종목은 하나 이상이어야 해요.');
  const p = await getDoc(env, 'profiles', id);
  if (!p) return fail('회원을 찾지 못했어요.', 404);
  const next = { ...p, sports: [...new Set(sports)] };
  if (!next.sports.includes(fid(p.field))) next.field = next.sports[0] === 'pt' ? PT_FIELD : FIELD;
  await putDoc(env, 'profiles', id, next, { owner: id });
  return J({ ok: true });
}
async function adminSpace(env, b) {
  const id = str(b.id, 60), space = b.space;
  if (!SPACES.includes(space)) return fail('사용 방식을 골라 주세요.');
  const p = await getDoc(env, 'profiles', id);
  if (!p) return fail('회원을 찾지 못했어요.', 404);
  await putDoc(env, 'profiles', id, { ...p, space }, { owner: id });
  return J({ ok: true });
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
      id: me, space: p.space || null, field: fid(p.field), sports: sportsOf(p), name: p.name || '(프로필 없음)', email: u.email, created: u.created, last: act[me] || null,
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
  const diff = await sameSpace(env, ME, c.playerId);
  if (diff) return fail('자녀 계정은 ' + SPACE_NAME[diff] + ' 회원이에요. 사용 방식이 같아야 연결할 수 있어요. 변경이 필요하면 문의해 주세요.', 409);
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

/* ---------------- 푸시 알림 (Web Push, 표준 암호화 aes128gcm + VAPID) ---------------- */
const b64u = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const ub64 = (s) => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const cat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0), o = new Uint8Array(n); let i = 0; a.forEach((y) => { o.set(y, i); i += y.length; }); return o; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// 서버 알림 열쇠(VAPID): 처음 한 번 자동으로 만들어 D1에 보관해요(따로 설정할 것 없음)
async function vapidKeys(env) {
  const cur = await getDoc(env, 'sys', 'vapid');
  if (cur && cur.pub && cur.jwk) return cur;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const v = { pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), at: Date.now() };
  await putDoc(env, 'sys', 'vapid', v, {});
  return v;
}
async function vapidJWT(env, aud) {
  const v = await vapidKeys(env);
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.PUSH_SUBJECT || 'mailto:noreply@feedup.app' })));
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(h + '.' + p));
  return { jwt: h + '.' + p + '.' + b64u(sig), pub: v.pub };
}
async function encryptPush(sub, text) {
  const uaPub = ub64(sub.keys.p256dh), auth = ub64(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = (await hmac(await hmac(auth, shared), cat(enc.encode('WebPush: info\u0000'), uaPub, asPub, new Uint8Array([1])))).slice(0, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\u0000'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\u0000'), new Uint8Array([1])))).slice(0, 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, cat(enc.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
const PUSH_HOSTS = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;
const pushOk = (env, ep) => PUSH_HOSTS.test(ep) || (env.PUSH_ALLOW_LOCAL === '1' && /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(ep));
async function sendPush(env, sub, msg) {
  const { jwt, pub } = await vapidJWT(env, new URL(sub.endpoint).origin);
  const body = await encryptPush(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, { method: 'POST', body, headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high', Authorization: 'vapid t=' + jwt + ', k=' + pub } });
  return r.status;
}
// 한 사람의 모든 기기로 보내요. 만료된 구독은 지워요.
async function pushTo(env, userId, msg) {
  const rows = (await env.DB.prepare("SELECT id,data FROM docs WHERE col='pushsub' AND owner=?").bind(userId).all()).results || [];
  let ok = 0;
  for (const r of rows) {
    const sub = JSON.parse(r.data);
    try {
      const st = await sendPush(env, sub, msg);
      if (st === 404 || st === 410) await delDoc(env, 'pushsub', r.id); else if (st < 300) ok++;
    } catch (e) { console.error('push', e); }
  }
  return ok;
}
async function pushSub(env, ME, b) {
  const sub = b && b.sub, ep = sub && str(sub.endpoint, 1000);
  if (!ep || !sub.keys || !sub.keys.p256dh || !sub.keys.auth || !pushOk(env, ep)) return fail('알림을 켜지 못했어요. 다른 브라우저로 시도해 주세요.');
  const id = 'p' + (await sha(ep)).slice(0, 40);
  await putDoc(env, 'pushsub', id, { endpoint: ep, keys: { p256dh: str(sub.keys.p256dh, 200), auth: str(sub.keys.auth, 100) }, at: Date.now() }, { owner: ME });
  return J({ ok: true });
}
async function pushUnsub(env, ME, b) {
  const ep = str(b && b.endpoint, 1000);
  if (ep) { const id = 'p' + (await sha(ep)).slice(0, 40); const d = await env.DB.prepare("SELECT owner FROM docs WHERE col='pushsub' AND id=?").bind(id).first(); if (d && d.owner === ME) await delDoc(env, 'pushsub', id); }
  return J({ ok: true });
}
// 매일 오후 2시(한국): 내일 레슨·수업이 있는 선수·회원과 코치·트레이너에게 알림
async function runReminders(env, when) {
  const kst = new Date((when || Date.now()) + 9 * 3600e3);
  const t = new Date(kst.getTime() + 864e5).toISOString().slice(0, 10);
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  const label = t.slice(5).replace('-', '.') + '(' + WD[new Date(t + 'T00:00:00Z').getUTCDay()] + ')';
  const hm = (x) => { const m = /^(\d{2}):(\d{2})$/.exec(x || ''); if (!m) return x || ''; const h = +m[1]; return (h < 12 ? '오전 ' : '오후 ') + ((h % 12) || 12) + '시' + (m[2] !== '00' ? ' ' + (+m[2]) + '분' : ''); };
  const all = async (q, ...b) => ((await env.DB.prepare(q).bind(...b).all()).results || []).map((r) => JSON.parse(r.data));
  const golf = (await all("SELECT data FROM docs WHERE col='gclass' AND json_extract(data,'$.date')=?", t)).filter((c) => c.status !== 'done').map((c) => ({ coach: c.coachId, who: c.playerId, time: c.time, memo: c.memo, pt: false }));
  const pt = (await all("SELECT data FROM docs WHERE col='ptdocs' AND json_extract(data,'$.kind')='class' AND json_extract(data,'$.date')=?", t)).filter((c) => c.status !== 'done').map((c) => ({ coach: c.author, who: c.memberId, time: c.time, memo: c.memo, pt: true }));
  const list = golf.concat(pt);
  if (!list.length) return { date: t, sent: 0 };
  const ids = [...new Set(list.flatMap((x) => [x.coach, x.who]))];
  const names = {};
  (await rowsIn(env, 'profiles', 'id', ids)).forEach((r) => { names[r.id] = JSON.parse(r.data).name || ''; });
  let sent = 0;
  for (const x of list) {
    sent += await pushTo(env, x.who, { title: x.pt ? '내일 PT 수업이 있어요' : '내일 레슨이 있어요', body: label + ' ' + hm(x.time) + ' · ' + (names[x.coach] || (x.pt ? '트레이너' : '코치')) + (x.memo ? ' · ' + x.memo : ''), url: x.pt ? '/pt' : '/', tag: 'remind-' + t });
  }
  const byCoach = {};
  list.forEach((x) => { (byCoach[x.coach + (x.pt ? ':pt' : '')] = byCoach[x.coach + (x.pt ? ':pt' : '')] || []).push(x); });
  for (const k of Object.keys(byCoach)) {
    const xs = byCoach[k].sort((a, b) => (a.time || '').localeCompare(b.time || '')), pt = k.endsWith(':pt'), c = k.replace(':pt', '');
    sent += await pushTo(env, c, { title: '내일 ' + (pt ? '수업' : '레슨') + ' ' + xs.length + '건이 있어요', body: label + ' ' + xs.map((x) => hm(x.time) + ' ' + (names[x.who] || '')).join(', '), url: pt ? '/pt' : '/', tag: 'remindc-' + t });
  }
  return { date: t, lessons: list.length, sent };
}
export async function scheduledReminders(env) { if (env.DB) return await runReminders(env); }

/* ---------------- PT 의견 보내기 ---------------- */
async function ptFeedback(env, ME, b) {
  const text = str(b.text, 2000).trim();
  if (!text) return fail('내용을 적어 주세요.');
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE col='ptfeedback' AND owner=?").bind(ME).first()).n;
  if (n >= 100) return fail('의견을 너무 많이 보냈어요. 감사합니다!', 429);
  const p = (await getDoc(env, 'profiles', ME)) || {};
  await putDoc(env, 'ptfeedback', 'f' + rand(8), { name: p.name || '', text, at: Date.now() }, { owner: ME });
  return J({ ok: true });
}
async function ptFeedbackList(env) {
  const r = (await env.DB.prepare("SELECT d.id,d.data,u.email FROM docs d LEFT JOIN users u ON ('u_'||u.id)=d.owner WHERE d.col='ptfeedback' ORDER BY d.updated DESC LIMIT 300").all()).results || [];
  return J({ feedback: r.map((x) => ({ id: x.id, email: x.email || '', ...JSON.parse(x.data) })) });
}

// 관리자 전용 페이지(/pt 미리보기 등)에서 쓰는 확인 함수
export async function adminUser(req, env) {
  if (!env.DB) return null;
  const user = await currentUser(req, env);
  return user && (await isAdmin(env, user)) ? user : null;
}
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
    if (path === '/push/key' && m === 'GET') return J({ key: (await vapidKeys(env)).pub });
    if (path === '/push/sub' && m === 'POST') return await pushSub(env, ME, await body(req));
    if (path === '/push/unsub' && m === 'POST') return await pushUnsub(env, ME, await body(req));
    if (path === '/push/test' && m === 'POST') { const n = await pushTo(env, ME, { title: 'FeedUp 알림 테스트', body: '알림이 잘 와요! 레슨·수업 하루 전 오후 2시에 알려 드릴게요.', url: '/' }); return n ? J({ ok: true, sent: n }) : fail('이 기기로 알림을 보내지 못했어요. 알림을 껐다가 다시 켜 주세요.'); }
    if (path === '/admin/remind' && m === 'POST') return (await isAdmin(env, user)) ? J(await runReminders(env, Date.now())) : fail('관리자만 쓸 수 있어요.', 403);
    if (path === '/ptfeedback' && m === 'POST') return await ptFeedback(env, ME, await body(req));
    if (path === '/admin/ptfeedback' && m === 'GET') return (await isAdmin(env, user)) ? await ptFeedbackList(env) : fail('관리자만 볼 수 있어요.', 403);
    if (path === '/admin/sports' && m === 'POST') return (await isAdmin(env, user)) ? await adminSports(env, await body(req)) : fail('관리자만 바꿀 수 있어요.', 403);
    if (path === '/admin/space' && m === 'POST') return (await isAdmin(env, user)) ? await adminSpace(env, await body(req)) : fail('관리자만 바꿀 수 있어요.', 403);
    if (path === '/admin/overview' && m === 'GET') return (await isAdmin(env, user)) ? await adminOverview(env) : fail('관리자만 볼 수 있어요.', 403);
    if (path === '/state' && m === 'GET') return J(await state(env, ME));
    if (path === '/docs' && m === 'POST') return await write(env, ME, await body(req));
    if (path === '/code' && m === 'POST') return await makeCode(env, ME, await body(req));
    if (path === '/join' && m === 'POST') return await joinCode(env, ME, await body(req));
    if (path === '/pcode' && m === 'POST') return await makePcode(env, ME);
    if (path === '/consent' && m === 'POST') return await giveConsent(env, ME, await body(req));
    if (path === '/account/delete' && m === 'POST') return await deleteAccount(req, env, user);
    if (path === '/media' && m === 'POST') return await mediaPut(req, env, ME, new URL(req.url));
    if (path === '/upload/start' && m === 'POST') return await bigStart(env, ME, await body(req));
    if (path === '/upload/part' && m === 'PUT') return await bigPart(req, env, ME, new URL(req.url));
    if (path === '/upload/done' && m === 'POST') return await bigDone(env, ME, await body(req));
    if (path === '/fbmedia' && m === 'POST') return await fbMediaPut(req, env, ME, new URL(req.url));
    if (path === '/ptmedia' && m === 'POST') return await ptMediaPut(req, env, ME, new URL(req.url));
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
