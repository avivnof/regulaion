import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 8020);
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

const paths = {
  tracks: path.join(rootDir, 'assets', 'tracks.json'),
  cues: path.join(rootDir, 'assets', 'cues.json'),
  audio: path.join(rootDir, 'audio'),
  cueImages: path.join(rootDir, 'assets', 'cue-images'),
  admin: path.join(rootDir, 'tools', 'admin', 'index.html')
};

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav']
]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...headers });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), jsonHeaders);
}

function sanitizeFileName(name) {
  let rawName = String(name || '').trim();
  try {
    rawName = decodeURIComponent(rawName);
  } catch {
    rawName = String(name || '').trim();
  }
  const base = path.basename(rawName);
  return base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function listFiles(dir, prefix) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => `${prefix}/${entry.name}`)
      .sort((a, b) => a.localeCompare(b, 'he'));
  } catch {
    return [];
  }
}

function readBody(req, limit = 300 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function findGitExecutable() {
  const candidates = [
    process.env.GIT_EXE,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'git', 'cmd', 'git.exe'),
    'git'
  ].filter(Boolean);
  return candidates[0];
}

function runGit(args) {
  return new Promise((resolve) => {
    const child = spawn(findGitExecutable(), args, { cwd: rootDir, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => resolve({ ok: false, code: -1, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const [tracks, cues, audioFiles, cueImageFiles] = await Promise.all([
      readJson(paths.tracks, []),
      readJson(paths.cues, {}),
      listFiles(paths.audio, 'audio'),
      listFiles(paths.cueImages, 'assets/cue-images')
    ]);
    sendJson(res, 200, { tracks, cues, audioFiles, cueImageFiles });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/tracks') {
    const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'));
    if (!Array.isArray(body.tracks)) {
      sendJson(res, 400, { error: 'tracks must be an array' });
      return true;
    }
    await writeJson(paths.tracks, body.tracks);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cues') {
    const body = JSON.parse((await readBody(req, 10 * 1024 * 1024)).toString('utf8'));
    if (!body.cues || typeof body.cues !== 'object' || Array.isArray(body.cues)) {
      sendJson(res, 400, { error: 'cues must be an object' });
      return true;
    }
    await writeJson(paths.cues, body.cues);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const kind = url.searchParams.get('kind');
    const fileName = sanitizeFileName(req.headers['x-file-name']);
    const targetDir = kind === 'audio' ? paths.audio : kind === 'cue-image' ? paths.cueImages : null;
    const allowed = kind === 'audio' ? ['.mp3', '.wav', '.m4a'] : ['.png', '.jpg', '.jpeg', '.webp'];
    const ext = path.extname(fileName).toLowerCase();
    if (!targetDir || !fileName || !allowed.includes(ext)) {
      sendJson(res, 400, { error: 'Unsupported file upload' });
      return true;
    }
    await mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, fileName);
    const body = await readBody(req);
    await new Promise((resolve, reject) => {
      const stream = createWriteStream(target);
      stream.on('finish', resolve);
      stream.on('error', reject);
      stream.end(body);
    });
    const publicPath = kind === 'audio' ? `audio/${fileName}` : `assets/cue-images/${fileName}`;
    sendJson(res, 200, { ok: true, path: publicPath });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/git-status') {
    const result = await runGit(['status', '--short']);
    sendJson(res, result.ok ? 200 : 500, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/git-commit') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
    const message = String(body.message || 'Update relaxation site content').trim();
    await runGit(['add', 'assets', 'audio', 'index.html', 'README.md', 'reg.png']);
    const result = await runGit(['commit', '-m', message]);
    sendJson(res, result.ok ? 200 : 500, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/git-push') {
    const result = await runGit(['push', 'origin', 'main']);
    sendJson(res, result.ok ? 200 : 500, result);
    return true;
  }

  return false;
}

async function serveStatic(req, res, url) {
  let requested = decodeURIComponent(url.pathname);
  if (requested === '/admin' || requested === '/admin/') {
    requested = '/tools/admin/index.html';
  }
  if (requested === '/') requested = '/index.html';

  const filePath = path.resolve(rootDir, requested.replace(/^\/+/, ''));
  if (!filePath.startsWith(rootDir)) {
    send(res, 403, 'Forbidden', { 'content-type': 'text/plain; charset=utf-8' });
    return;
  }

  try {
    const info = await stat(filePath);
    const finalPath = info.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    const body = await readFile(finalPath);
    send(res, 200, body, {
      'content-type': mimeTypes.get(path.extname(finalPath).toLowerCase()) || 'application/octet-stream',
      'cache-control': 'no-store'
    });
  } catch {
    send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendJson(res, 404, { error: 'Not found' });
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Relaxation site manager: http://127.0.0.1:${port}/admin`);
});
