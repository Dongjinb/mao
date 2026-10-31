/* 喵屋日记 · 存档服务（零依赖，Node 18+）
 * 账号密码：注册/登录 → 签名 token（HMAC-SHA256，30 天）→ 每个账号一份存档
 * 兼容旧版：/api/save/<同步码> 仍然可用（无账号也能同步）
 * 启动：node server.cjs        环境变量：PORT / HOST / SAVE_DIR / USERS_DIR / SAVE_SECRET
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = process.env.PUBLIC_DIR
  || (fs.existsSync(path.join(ROOT, 'public')) ? path.join(ROOT, 'public') : ROOT);
const DATA_DIR = process.env.SAVE_DIR || path.join(ROOT, 'data', 'saves');
const USERS_DIR = process.env.USERS_DIR || path.join(path.dirname(DATA_DIR), 'users');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 2 * 1024 * 1024;          // 单份存档 / 请求体上限 2MB
const CODE_RE = /^[A-Z0-9]{6,16}$/;        // 旧版同步码
const NAME_RE = /^[\w\u4e00-\u9fa5.-]{2,20}$/;  // 用户名：2-20 位中英文/数字/下划线/点/横线
const PASS_MIN = 6, PASS_MAX = 64;
const TOKEN_TTL = 30 * 24 * 3600 * 1000;   // 30 天
const RATE_WINDOW = 10 * 1000, RATE_MAX = 60;   // 普通接口：每 IP 每 10 秒 60 次
const LOGIN_WINDOW = 10 * 60 * 1000, LOGIN_MAX = 10; // 登录失败：每 IP+账号 10 分钟 10 次

for (const d of [DATA_DIR, USERS_DIR]) fs.mkdirSync(d, { recursive: true });

/* ---------------- 签名密钥（首次启动生成并落盘，重启不失效） ---------------- */
const SECRET_FILE = process.env.SAVE_SECRET ? null : path.join(path.dirname(DATA_DIR), 'secret.key');
let SECRET = process.env.SAVE_SECRET || '';
if (!SECRET) {
  try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) { SECRET = ''; }
  if (!SECRET) {
    SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/* ---------------- 限流 ---------------- */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let arr = hits.get(ip);
  if (!arr) { arr = []; hits.set(ip, arr); }
  while (arr.length && now - arr[0] > RATE_WINDOW) arr.shift();
  arr.push(now);
  return arr.length > RATE_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    while (arr.length && now - arr[0] > RATE_WINDOW) arr.shift();
    if (!arr.length) hits.delete(ip);
  }
}, 60000).unref();

const fails = new Map();
function loginBlocked(ip, key) {
  const k = ip + '|' + key;
  const now = Date.now();
  let rec = fails.get(k);
  if (!rec) { rec = { n: 0, t: now }; fails.set(k, rec); }
  if (now - rec.t > LOGIN_WINDOW) { rec.n = 0; rec.t = now; }
  return rec.n >= LOGIN_MAX;
}
function loginFailed(ip, key) {
  const k = ip + '|' + key;
  const now = Date.now();
  let rec = fails.get(k);
  if (!rec || now - rec.t > LOGIN_WINDOW) rec = { n: 0, t: now };
  rec.n += 1; rec.t = now; fails.set(k, rec);
}
function loginOk(ip, key) { fails.delete(ip + '|' + key); }

/* ---------------- 小工具 ---------------- */
function send(res, status, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    res.writeHead(status, h);
    res.end(body);
  } else {
    h['Content-Type'] = h['Content-Type'] || 'application/json; charset=utf-8';
    res.writeHead(status, h);
    res.end(JSON.stringify(body));
  }
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw); } catch (e) { const err = new Error('bad-json'); throw err; }
}
function savePath(code) { return path.join(DATA_DIR, code + '.json'); }
function userPath(uid) { return path.join(USERS_DIR, uid + '.json'); }
function userSavePath(uid) { return path.join(DATA_DIR, 'user-' + uid + '.json'); }
async function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fs.promises.rename(tmp, file);
}
async function readJsonFile(file) {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); }
  catch (e) { return null; }
}

/* ---------------- 账号：哈希、token ---------------- */
function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 64).toString('hex'); }
function sameHash(a, b) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function uidOf(name) {
  return crypto.createHash('sha256').update(name.normalize('NFKC').toLowerCase()).digest('hex').slice(0, 16);
}
function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function signToken(name, uid) {
  const payload = b64u(JSON.stringify({ u: name, i: uid, e: Date.now() + TOKEN_TTL }));
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}
function verifyToken(tok) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const i = tok.lastIndexOf('.');
  const payload = tok.slice(0, i), sig = tok.slice(i + 1);
  const want = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  let obj;
  try { obj = JSON.parse(unb64u(payload).toString('utf8')); } catch (e) { return null; }
  if (!obj || !obj.u || !obj.i || !(obj.e > Date.now())) return null;
  return obj;
}
function authUser(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? verifyToken(m[1].trim()) : null;
}

/* ---------------- 接口：注册 / 登录 ---------------- */
async function handleRegister(req, res, ip) {
  let body;
  try { body = await readJson(req); } catch (e) { return send(res, 400, { error: 'bad-json' }); }
  const name = String(body.name || '').trim();
  const pass = String(body.pass || '');
  if (!NAME_RE.test(name)) return send(res, 400, { error: 'bad-name', message: '用户名 2-20 位，中文/字母/数字/下划线' });
  if (pass.length < PASS_MIN || pass.length > PASS_MAX) return send(res, 400, { error: 'bad-pass', message: '密码至少 6 位' });
  const uid = uidOf(name);
  if (await readJsonFile(userPath(uid))) return send(res, 409, { error: 'name-taken', message: '这个用户名已经有人用了' });
  const salt = crypto.randomBytes(16).toString('hex');
  await writeJsonAtomic(userPath(uid), { uid, name, salt, hash: hashPass(pass, salt), createdAt: Date.now() });
  return send(res, 200, { token: signToken(name, uid), name, uid });
}

async function handleLogin(req, res, ip) {
  let body;
  try { body = await readJson(req); } catch (e) { return send(res, 400, { error: 'bad-json' }); }
  const name = String(body.name || '').trim();
  const pass = String(body.pass || '');
  if (!NAME_RE.test(name)) return send(res, 401, { error: 'bad-credentials', message: '用户名或密码不对' });
  const uid = uidOf(name);
  if (loginBlocked(ip, uid)) return send(res, 429, { error: 'too-many-tries', message: '试错太多次了，10 分钟后再试' });
  const u = await readJsonFile(userPath(uid));
  if (!u || !sameHash(hashPass(pass, u.salt), u.hash)) {
    loginFailed(ip, uid);
    return send(res, 401, { error: 'bad-credentials', message: '用户名或密码不对' });
  }
  loginOk(ip, uid);
  return send(res, 200, { token: signToken(u.name, uid), name: u.name, uid });
}

/* ---------------- 接口：账号存档 ---------------- */
async function handleMeSave(req, res, user) {
  const file = userSavePath(user.i);
  if (req.method === 'GET') {
    const row = await readJsonFile(file);
    if (!row) return send(res, 404, { error: 'not-found' });
    return send(res, 200, { name: row.name, updatedAt: row.updatedAt, data: row.data });
  }
  if (req.method === 'PUT') {
    let body;
    try { body = await readJson(req); }
    catch (e) { return send(res, e.message === 'too-large' ? 413 : 400, { error: e.message === 'too-large' ? 'too-large' : 'bad-json' }); }
    const data = body && body.data;
    if (!data || typeof data !== 'object' || !Array.isArray(data.cats)) {
      return send(res, 400, { error: 'bad-data', message: 'data 必须是游戏存档对象' });
    }
    const updatedAt = Number(body.updatedAt) || Date.now();
    const old = await readJsonFile(file);
    if (old && old.data) {   // 留一个上一版，防误覆盖
      await writeJsonAtomic(file.replace(/\.json$/, '.bak.json'), old);
    }
    await writeJsonAtomic(file, { name: user.u, updatedAt, data });
    return send(res, 200, { ok: true, name: user.u, updatedAt });
  }
  return send(res, 405, { error: 'method-not-allowed' });
}

/* ---------------- 接口：旧版同步码存档 ---------------- */
async function handleSave(req, res, code) {
  if (!CODE_RE.test(code)) {
    return send(res, 400, { error: 'bad-code', message: '同步码只能是 6-16 位大写字母或数字' });
  }
  const file = savePath(code);

  if (req.method === 'GET') {
    let raw;
    try { raw = await fs.promises.readFile(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return send(res, 404, { error: 'not-found' });
      throw e;
    }
    let row;
    try { row = JSON.parse(raw); } catch (e) { return send(res, 500, { error: 'corrupt' }); }
    return send(res, 200, { code: row.code, updatedAt: row.updatedAt, data: row.data });
  }

  if (req.method === 'PUT') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) {
      return send(res, e.message === 'too-large' ? 413 : 400,
        { error: e.message === 'too-large' ? 'too-large' : 'bad-json' });
    }
    const data = body && body.data;
    if (!data || typeof data !== 'object' || !Array.isArray(data.cats)) {
      return send(res, 400, { error: 'bad-data', message: 'data 必须是游戏存档对象' });
    }
    const updatedAt = Number(body.updatedAt) || Date.now();
    await writeJsonAtomic(file, { code, updatedAt, data });
    return send(res, 200, { ok: true, code, updatedAt });
  }

  return send(res, 405, { error: 'method-not-allowed' });
}

/* ---------------- 静态文件 ---------------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  const relOut = path.relative(PUBLIC_DIR, file);
  if (relOut.startsWith('..') || path.isAbsolute(relOut)) {
    return send(res, 403, 'forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- 服务 ---------------- */
const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname.startsWith('/api/')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (rateLimited(ip)) return send(res, 429, { error: 'rate-limited', message: '请求太频繁，稍后再试' });

    try {
      if (pathname === '/api/health') {
        const [saves, users] = await Promise.all([
          fs.promises.readdir(DATA_DIR).catch(() => []),
          fs.promises.readdir(USERS_DIR).catch(() => []),
        ]);
        return send(res, 200, {
          ok: true,
          saves: saves.filter((f) => f.endsWith('.json') && f.indexOf('.bak') < 0).length,
          users: users.filter((f) => f.endsWith('.json')).length,
        });
      }
      if (pathname === '/api/register') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });
        return await handleRegister(req, res, ip);
      }
      if (pathname === '/api/login') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });
        return await handleLogin(req, res, ip);
      }
      if (pathname === '/api/me' || pathname === '/api/me/save') {
        const user = authUser(req);
        if (!user) return send(res, 401, { error: 'unauthorized', message: '登录已过期，请重新登录' });
        if (pathname === '/api/me') {
          const row = await readJsonFile(userSavePath(user.i));
          return send(res, 200, { name: user.u, uid: user.i, updatedAt: row ? row.updatedAt : null });
        }
        return await handleMeSave(req, res, user);
      }
      const m = pathname.match(/^\/api\/save\/([^/]+)$/);
      if (m) return await handleSave(req, res, m[1].toUpperCase());
      return send(res, 404, { error: 'no-such-api' });
    } catch (e) {
      console.error('[api error]', e);
      return send(res, 500, { error: 'server-error', message: String(e && e.message || e) });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log('喵屋日记存档服务已启动');
  console.log('  页面：http://127.0.0.1:' + PORT + '/');
  console.log('  接口：http://127.0.0.1:' + PORT + '/api/health');
  console.log('  存档目录：' + DATA_DIR);
  console.log('  账号目录：' + USERS_DIR);
});
