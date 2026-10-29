#!/usr/bin/env node
/**
 * 喵屋日记 · 自建存档服务
 * 零依赖（Node 16+），同时提供静态页面和存档 API。
 *
 * 目录结构：
 *   server.js
 *   public/index.html      <- 游戏页面（就是 index.html）
 *   data/saves/XXXX.json   <- 自动生成的存档文件
 *
 * 运行：
 *   node server.js
 *   PORT=8787 node server.js
 *
 * API：
 *   GET  /api/health
 *   GET  /api/save/:code      -> 200 {code,updatedAt,data} | 404
 *   PUT  /api/save/:code      body {data,updatedAt?} -> 200 {ok,updatedAt}
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC_DIR = process.env.PUBLIC_DIR
  || (fs.existsSync(path.join(ROOT, 'public')) ? path.join(ROOT, 'public') : ROOT);
const DATA_DIR = process.env.SAVE_DIR || path.join(ROOT, 'data', 'saves');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 2 * 1024 * 1024;          // 单份存档上限 2MB
const CODE_RE = /^[A-Z0-9]{6,16}$/;        // 同步码：大写字母 + 数字
const RATE_WINDOW = 10 * 1000;             // 限流窗口
const RATE_MAX = 60;                       // 每 IP 每窗口最多 60 次

fs.mkdirSync(DATA_DIR, { recursive: true });

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

/* ---------------- 限流：按 IP 的滑动窗口 ---------------- */
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
function savePath(code) {
  return path.join(DATA_DIR, code + '.json');
}
async function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fs.promises.rename(tmp, file);
}

/* ---------------- 存档 API ---------------- */
async function handleSave(req, res, code) {
  cors(res);
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
        const files = await fs.promises.readdir(DATA_DIR).catch(() => []);
        return send(res, 200, { ok: true, saves: files.filter((f) => f.endsWith('.json')).length });
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
});
