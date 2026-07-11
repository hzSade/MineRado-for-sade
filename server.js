// ====================================================================
//  Mineradio local desktop server
//  - Прокси локальных файлов / локальный кэш ритма / проверка обновлений
//  - По умолчанию чисто локальный режим, зависимости NetEase / QQ Music больше не подключаются
// ====================================================================
const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const { once } = require('events');
const { fileURLToPath } = require('url');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const LOCAL_FILE_TOKEN = process.env.MINERADIO_LOCAL_FILE_TOKEN || '';
const { YandexMusicClient, startDeviceAuth, pollDeviceAuth } = require('./yandex-client.js');
const YANDEX_TOKEN_FILE = process.env.MINERADIO_YANDEX_TOKEN_FILE || path.join(__dirname, 'yandex-token.txt');
let yandexClientInstance = null;
let yandexClientTokenUsed = null;
let pendingDeviceAuth = null; // { deviceCode, expiresAt }

// На Windows/macOS/Linux Electron даёт доступ к системному хранилищу
// секретов (DPAPI / Keychain / libsecret) через safeStorage — токен на
// диске лежит зашифрованным, а не открытым текстом.
let electronSafeStorage = null;
try { electronSafeStorage = require('electron').safeStorage; } catch (e) { /* не в Electron-процессе — ок, будет фоллбек */ }

function loadYandexToken() {
  const envToken = (process.env.MINERADIO_YANDEX_TOKEN || '').trim();
  if (envToken) return envToken;
  let raw;
  try {
    raw = fs.readFileSync(YANDEX_TOKEN_FILE);
  } catch (e) {
    return null;
  }
  if (electronSafeStorage && electronSafeStorage.isEncryptionAvailable()) {
    try {
      const decrypted = electronSafeStorage.decryptString(raw).trim();
      if (decrypted) return decrypted;
    } catch (e) {
      // не расшифровался — вероятно, старый файл с обычным текстом, читаем как есть ниже
    }
  }
  const plain = raw.toString('utf8').trim();
  return plain || null;
}

function saveYandexToken(token) {
  const clean = String(token || '').trim();
  if (!clean) return;
  if (electronSafeStorage && electronSafeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(YANDEX_TOKEN_FILE, electronSafeStorage.encryptString(clean));
  } else {
    fs.writeFileSync(YANDEX_TOKEN_FILE, clean, 'utf8');
  }
  yandexClientInstance = null;
  yandexClientTokenUsed = null;
}

function clearYandexToken() {
  try { fs.unlinkSync(YANDEX_TOKEN_FILE); } catch (e) { /* уже нет файла — ок */ }
  yandexClientInstance = null;
  yandexClientTokenUsed = null;
}

function getYandexClient() {
  const token = loadYandexToken();
  if (!token) return null;
  if (!yandexClientInstance || yandexClientTokenUsed !== token) {
    yandexClientInstance = new YandexMusicClient(token);
    yandexClientTokenUsed = token;
  }
  return yandexClientInstance;
}

function mapYandexTrack(t) {
  if (!t) return null;
  const artists = (t.artists || []).map((a) => a.name).filter(Boolean).join(', ') || 'Unknown Artist';
  const album = (t.albums && t.albums[0]) || null;
  const coverUri = (album && album.coverUri) || t.coverUri || null;
  return {
    source: 'yandex',
    id: String(t.id),
    title: t.title || 'Untitled',
    artist: artists,
    album: album ? album.title : '',
    albumId: album ? album.id : null,
    durationMs: t.durationMs || 0,
    cover: coverUri ? `https://${coverUri.replace('%%', '400x400')}` : null,
    available: t.available !== false,
    streamUrl: `/api/yandex/stream/${t.id}`,
  };
}
const UPDATE_WORK_DIR = process.env.MINERADIO_UPDATE_DIR || path.join(__dirname, 'updates');
const UPDATE_DOWNLOAD_DIR = process.env.MINERADIO_UPDATE_DOWNLOAD_DIR || path.join(UPDATE_WORK_DIR, 'downloads');
const UPDATE_PATCH_BACKUP_DIR = process.env.MINERADIO_PATCH_BACKUP_DIR || path.join(UPDATE_WORK_DIR, 'backups', 'patches');
const BEATMAP_CACHE_DIR = process.env.MINERADIO_BEAT_CACHE_DIR || 'D:\\MineradioCache\\beatmaps';
const APP_PACKAGE = readPackageInfo();
const APP_VERSION = process.env.MINERADIO_VERSION || APP_PACKAGE.version || '0.9.11';
const UPDATE_CONFIG = readUpdateConfig(APP_PACKAGE);
const PATCH_MAX_BYTES = 12 * 1024 * 1024;
const UPDATE_CHECK_CACHE_TTL_MS = 5 * 60 * 1000;
const UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS = 30 * 1000;
const PATCH_ALLOWED_ROOTS = new Set(['public', 'desktop', 'build']);
const PATCH_ALLOWED_FILES = new Set(['server.js', 'package.json', 'package-lock.json']);
const UPDATE_FALLBACK_NOTES = [
  'Более плавный ритм визуализации',
  'Автоматическая смена источника при сбое',
  'Уведомление об обновлении в правом верхнем углу',
];
const updateDownloadJobs = new Map();
let updateInfoCache = null;
let latestUpdateInfoPromise = null;

function applySystemCertificateAuthorities() {
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return;
    const bundled = tls.getCACertificates('default') || [];
    const system = tls.getCACertificates('system') || [];
    if (!system.length) return;
    const seen = new Set();
    const merged = [];
    bundled.concat(system).forEach(cert => {
      if (!cert || seen.has(cert)) return;
      seen.add(cert);
      merged.push(cert);
    });
    if (merged.length > bundled.length) tls.setDefaultCACertificates(merged);
  } catch (e) {
    console.warn('[TLS] system CA merge skipped:', e.message);
  }
}

applySystemCertificateAuthorities();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

const LOCAL_FILE_MIME = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.lrc': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function localContentTypeForPath(filePath) {
  return LOCAL_FILE_MIME[path.extname(String(filePath || '')).toLowerCase()] || 'application/octet-stream';
}

// ---------- Утилиты ----------
function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}
function sendJSON(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(JSON.stringify(data));
}
function readPackageInfo() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}
function parseGitHubRepository(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const direct = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (direct) return { owner: direct[1], repo: direct[2].replace(/\.git$/i, '') };
  const github = raw.match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[#/?].*)?$/i);
  if (github) return { owner: github[1], repo: github[2].replace(/\.git$/i, '') };
  return null;
}
function readUpdateConfig(pkg) {
  const local = (pkg && pkg.mineradio && pkg.mineradio.update) || {};
  const repoHint = process.env.MINERADIO_UPDATE_REPOSITORY
    || process.env.GITHUB_REPOSITORY
    || local.repository
    || local.github
    || (pkg && pkg.repository && (pkg.repository.url || pkg.repository))
    || '';
  const parsed = parseGitHubRepository(repoHint) || {};
  const owner = process.env.MINERADIO_UPDATE_OWNER || local.owner || parsed.owner || '';
  const repo = process.env.MINERADIO_UPDATE_REPO || local.repo || parsed.repo || '';
  return {
    provider: local.provider || 'github',
    owner,
    repo,
    configured: !!(owner && repo),
    preview: local.preview !== false,
    preferMirrors: local.preferMirrors !== false,
    mirrors: readUpdateMirrors(local),
    manifest: process.env.MINERADIO_UPDATE_MANIFEST
      || process.env.MINERADIO_UPDATE_MANIFEST_URL
      || process.env.MINERADIO_UPDATE_MANIFEST_FILE
      || '',
  };
}
function parseUpdateMirrorList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/[\n,;]/);
}
function readUpdateMirrors(local) {
  const envMirrors = process.env.MINERADIO_UPDATE_MIRRORS || process.env.MINERADIO_UPDATE_MIRROR || '';
  const raw = envMirrors
    ? parseUpdateMirrorList(envMirrors)
    : parseUpdateMirrorList(local.mirrors || local.downloadMirrors || []);
  const seen = new Set();
  const mirrors = [];
  raw.forEach(item => {
    const url = String(item || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    mirrors.push(url);
  });
  return mirrors.slice(0, 6);
}
function normalizeDigest(value, algorithm) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const prefix = new RegExp('^' + algorithm + ':', 'i');
  return raw.replace(prefix, '').trim().replace(/^['"]|['"]$/g, '');
}
function assetDigestInfo(asset) {
  const digest = String(asset && asset.digest || '').trim();
  return {
    sha256: normalizeDigest((asset && asset.sha256) || (/^sha256:/i.test(digest) ? digest : ''), 'sha256').toLowerCase(),
    sha512: normalizeDigest((asset && asset.sha512) || (/^sha512:/i.test(digest) ? digest : ''), 'sha512'),
  };
}
function buildMirrorUrl(originalUrl, mirror) {
  const source = String(originalUrl || '').trim();
  const base = String(mirror || '').trim();
  if (!/^https?:\/\//i.test(source) || !/^https?:\/\//i.test(base)) return '';
  if (base.includes('{encodedUrl}')) return base.replace(/\{encodedUrl\}/g, encodeURIComponent(source));
  if (base.includes('{url}')) return base.replace(/\{url\}/g, source);
  return base.replace(/\/+$/, '/') + source;
}
function uniqueDownloadCandidates(urls, opts) {
  opts = opts || {};
  const directUrls = (Array.isArray(urls) ? urls : [urls])
    .map(url => String(url || '').trim())
    .filter(url => /^https?:\/\//i.test(url));
  const directSet = new Set(directUrls.map(url => url.toLowerCase()));
  const mirrors = opts.useMirrors === false ? [] : (UPDATE_CONFIG.mirrors || []);
  const mirrored = [];
  directUrls.forEach(source => {
    mirrors.forEach((mirror, index) => {
      const url = buildMirrorUrl(source, mirror);
      if (url) mirrored.push({
        url,
        label: 'Ускоренная линия ' + (index + 1),
        mirrored: true,
      });
    });
  });
  const direct = directUrls.map(url => ({
    url,
    label: directSet.has(url.toLowerCase()) ? 'Прямое подключение к GitHub' : 'Линия загрузки',
    mirrored: false,
  }));
  const ordered = UPDATE_CONFIG.preferMirrors === false ? direct.concat(mirrored) : mirrored.concat(direct);
  const seen = new Set();
  return ordered.filter(item => {
    const key = item.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function publicDownloadUrls(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(item => item && item.url)
    .filter(Boolean);
}
function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').replace(/[+].*$/, '').replace(/-.+$/, '');
}
function compareVersions(a, b) {
  const aa = normalizeVersion(a).split('.').map(n => parseInt(n, 10) || 0);
  const bb = normalizeVersion(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(aa.length, bb.length, 3);
  for (let i = 0; i < len; i++) {
    const left = aa[i] || 0;
    const right = bb[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}
function cleanReleaseLine(line) {
  return String(line || '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}
function extractReleaseNotes(body) {
  const notes = [];
  String(body || '').split(/\r?\n/).forEach(line => {
    const text = cleanReleaseLine(line);
    if (!text) return;
    if (/^(what'?s changed|changes|changelog|full changelog|список изменений)$/i.test(text)) return;
    if (/^https?:\/\//i.test(text)) return;
    if (text.length > 72) return;
    notes.push(text);
  });
  return notes.slice(0, 4);
}
function pickReleaseAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const preferred = list.find(a => /\.(exe|msi)$/i.test(a && a.name || ''))
    || list.find(a => /\.(zip|7z)$/i.test(a && a.name || ''))
    || list[0];
  if (!preferred) return null;
  const digest = assetDigestInfo(preferred);
  const candidates = uniqueDownloadCandidates(preferred.browser_download_url || '');
  return {
    name: preferred.name || '',
    size: preferred.size || 0,
    contentType: preferred.content_type || '',
    downloadUrl: preferred.browser_download_url || '',
    downloadUrls: publicDownloadUrls(candidates),
    sha256: digest.sha256 || '',
    sha512: digest.sha512 || '',
  };
}
function patchAssetVersions(name) {
  const matches = String(name || '').match(/\d+(?:[._-]\d+){1,3}/g) || [];
  return matches.map(item => normalizeVersion(item.replace(/[._-]/g, '.'))).filter(Boolean);
}
function pickPatchAsset(assets, currentVersion, latestVersion) {
  const list = Array.isArray(assets) ? assets : [];
  const current = normalizeVersion(currentVersion || APP_VERSION);
  const latest = normalizeVersion(latestVersion || '');
  const preferred = list.find(a => {
    const name = String(a && a.name || '');
    if (!/\.(patch\.json|patch|json)$/i.test(name)) return false;
    const versions = patchAssetVersions(name);
    if (latest) return versions[0] === current && versions[versions.length - 1] === latest;
    return versions[0] === current && name.toLowerCase().includes('patch');
  }) || list.find(a => {
    const name = String(a && a.name || '');
    if (!/\.(patch\.json|patch|json)$/i.test(name)) return false;
    const versions = patchAssetVersions(name);
    return versions[0] === current && name.toLowerCase().includes('patch');
  }) || list.find(a => /\.(patch\.json|patch)$/i.test(a && a.name || ''));
  if (!preferred) return null;
  const digest = assetDigestInfo(preferred);
  const candidates = uniqueDownloadCandidates(preferred.browser_download_url || '');
  return {
    name: preferred.name || '',
    size: preferred.size || 0,
    contentType: preferred.content_type || '',
    downloadUrl: preferred.browser_download_url || '',
    downloadUrls: publicDownloadUrls(candidates),
    sha256: digest.sha256 || '',
    sha512: digest.sha512 || '',
  };
}
function updateAssetNameFromUrl(value) {
  try {
    const u = new URL(String(value || ''));
    const base = path.basename(decodeURIComponent(u.pathname || ''));
    if (base) return base;
  } catch (_) {}
  return path.basename(String(value || '').split('?')[0]) || '';
}
function normalizeManifestUpdateInfo(data) {
  data = data || {};
  const release = data.release || {};
  const asset = release.asset || data.asset || {};
  const latestVersion = normalizeVersion(
    data.latestVersion
    || data.version
    || release.version
    || release.tagName
    || release.tag_name
    || release.name
    || APP_VERSION
  ) || APP_VERSION;
  const downloadUrl = release.downloadUrl || data.downloadUrl || asset.downloadUrl || asset.browser_download_url || '';
  const patch = release.patch || data.patch || null;
  const assetUrls = [downloadUrl].concat(Array.isArray(asset.downloadUrls) ? asset.downloadUrls : []);
  const patchUrls = patch ? [patch.downloadUrl].concat(Array.isArray(patch.downloadUrls) ? patch.downloadUrls : []) : [];
  const patchInfo = patch && patch.downloadUrl ? {
    name: patch.name || updateAssetNameFromUrl(patch.downloadUrl) || `Mineradio-${APP_VERSION}→${latestVersion}.patch.json`,
    size: Number(patch.size || 0) || 0,
    contentType: patch.contentType || patch.content_type || 'application/json',
    downloadUrl: patch.downloadUrl,
    downloadUrls: publicDownloadUrls(uniqueDownloadCandidates(patchUrls)),
    from: normalizeVersion(patch.from || APP_VERSION),
    to: normalizeVersion(patch.to || latestVersion),
    sha256: normalizeDigest(patch.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(patch.sha512 || '', 'sha512'),
  } : null;
  const notes = Array.isArray(release.notes) && release.notes.length
    ? release.notes.slice(0, 4).map(cleanReleaseLine).filter(Boolean)
    : (extractReleaseNotes(release.body || data.body).length ? extractReleaseNotes(release.body || data.body) : UPDATE_FALLBACK_NOTES);
  const assetInfo = downloadUrl ? {
    name: asset.name || updateAssetNameFromUrl(downloadUrl) || `Mineradio-${latestVersion}-Setup.exe`,
    size: Number(asset.size || 0) || 0,
    contentType: asset.contentType || asset.content_type || '',
    downloadUrl,
    downloadUrls: publicDownloadUrls(uniqueDownloadCandidates(assetUrls)),
    sha256: normalizeDigest(asset.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(asset.sha512 || release.sha512 || data.sha512 || '', 'sha512'),
  } : null;
  return {
    configured: true,
    preview: false,
    updateAvailable: data.updateAvailable != null ? !!data.updateAvailable : compareVersions(latestVersion, APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: release.tagName || release.tag_name || data.tagName || ('v' + latestVersion),
      name: release.name || data.name || ('Mineradio v' + latestVersion),
      version: latestVersion,
      publishedAt: release.publishedAt || release.published_at || data.publishedAt || '',
      htmlUrl: release.htmlUrl || release.html_url || data.htmlUrl || '',
      downloadUrl,
      asset: assetInfo,
      patch: patchInfo,
      patchAvailable: !!(patchInfo && patchInfo.downloadUrl && compareVersions(latestVersion, APP_VERSION) > 0),
      summary: release.summary || data.summary || notes[0] || 'Найдена новая версия, рекомендуется обновиться.',
      notes,
    },
    source: 'manifest',
  };
}
async function readUpdateManifest(ref) {
  const value = String(ref || '').trim();
  if (!value) throw new Error('UPDATE_MANIFEST_MISSING');
  if (/^https?:\/\//i.test(value)) {
    const resp = await fetch(value, {
      headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
    });
    if (!resp.ok) throw new Error('Update manifest ' + resp.status);
    return resp.json();
  }
  const file = /^file:/i.test(value) ? fileURLToPath(value) : path.resolve(value);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function fetchManifestUpdateInfo(ref) {
  try {
    const data = await readUpdateManifest(ref);
    return normalizeManifestUpdateInfo(data);
  } catch (err) {
    return localUpdateFallback(err.message || 'Update manifest failed', { configured: true });
  }
}
function beatCacheRootInfo() {
  const dir = path.resolve(BEATMAP_CACHE_DIR);
  const root = path.parse(dir).root;
  const drive = root ? root.replace(/[\\\/]+$/, '').toUpperCase() : '';
  const allowed = !!root && !/^C:$/i.test(drive);
  const available = allowed && fs.existsSync(root);
  return { dir, root, drive, allowed, available };
}
function ensureBeatMapCacheDir() {
  const info = beatCacheRootInfo();
  if (!info.allowed) {
    const err = new Error('BEAT_CACHE_ON_C_DRIVE_DISABLED');
    err.code = 'BEAT_CACHE_ON_C_DRIVE_DISABLED';
    err.info = info;
    throw err;
  }
  if (!info.available) {
    const err = new Error('BEAT_CACHE_DRIVE_UNAVAILABLE');
    err.code = 'BEAT_CACHE_DRIVE_UNAVAILABLE';
    err.info = info;
    throw err;
  }
  fs.mkdirSync(info.dir, { recursive: true });
  return info.dir;
}
function safeBeatMapCacheFile(key) {
  const raw = String(key || '').trim();
  if (!raw || raw.length > 240) return null;
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  const label = raw.replace(/[^a-z0-9_.-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'beatmap';
  return path.join(ensureBeatMapCacheDir(), `${label}-${hash}.json`);
}
function compactBeatMapCachePayload(body) {
  const key = String(body && body.key || '').trim();
  const map = body && body.map;
  if (!key || !map || typeof map !== 'object') return null;
  return {
    v: 1,
    key,
    savedAt: Date.now(),
    meta: {
      provider: String(body.provider || '').slice(0, 32),
      title: String(body.title || '').slice(0, 160),
      artist: String(body.artist || '').slice(0, 160),
      mode: String(body.mode || 'mr').slice(0, 32),
    },
    map,
  };
}
function readBeatMapCache(key) {
  const file = safeBeatMapCacheFile(key);
  if (!file || !fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw && raw.map ? raw : null;
}
function writeBeatMapCache(body) {
  const payload = compactBeatMapCachePayload(body);
  if (!payload) return { ok: false, error: 'INVALID_BEATMAP_CACHE_PAYLOAD' };
  const file = safeBeatMapCacheFile(payload.key);
  if (!file) return { ok: false, error: 'INVALID_BEATMAP_CACHE_KEY' };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
  return { ok: true, key: payload.key, savedAt: payload.savedAt, dir: path.dirname(file) };
}
function localUpdateFallback(reason, opts) {
  opts = opts || {};
  const configured = !!(opts.configured != null ? opts.configured : false);
  return {
    configured,
    preview: UPDATE_CONFIG.preview,
    updateAvailable: false,
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    release: {
      tagName: 'v' + APP_VERSION,
      name: 'Mineradio v' + APP_VERSION,
      version: APP_VERSION,
      htmlUrl: '',
      downloadUrl: '',
      summary: 'Текущая версия, проверка обновлений готова.',
      notes: UPDATE_FALLBACK_NOTES,
    },
    reason: reason || '',
  };
}
/**
 * Копирует результат проверки обновлений, чтобы задача загрузки или обработка ответа случайно не изменили кэшированный объект.
 * @param {object} info Объект результата проверки обновлений.
 * @returns {object} Независимая копия результата, которую можно вернуть вызывающей стороне.
 */
function cloneUpdateInfo(info) {
  return JSON.parse(JSON.stringify(info || localUpdateFallback()));
}
/**
 * Записывает кэш проверки обновлений; результат при ошибке кэшируется ненадолго, чтобы временные сетевые проблемы не блокировали уведомление о новой версии надолго.
 * @param {object} info Объект результата проверки обновлений.
 * @returns {object} Исходный объект результата проверки обновлений.
 */
function rememberUpdateInfo(info) {
  const ttl = info && info.reason ? 45 * 1000 : UPDATE_CHECK_CACHE_TTL_MS;
  updateInfoCache = {
    value: cloneUpdateInfo(info),
    expiresAt: Date.now() + ttl,
  };
  return info;
}
/**
 * Создаёт таймер простоя для потока загрузки, чтобы линия, успешно отдавшая заголовки, не зависла надолго на теле ответа.
 * @param {number} timeoutMs Таймаут простоя в миллисекундах.
 * @returns {{signal: AbortSignal, touch: Function, clear: Function}} Сигнал отмены и функции управления таймером для fetch.
 */
function createUpdateDownloadIdleGuard(timeoutMs) {
  const controller = new AbortController();
  const timeout = Math.max(5000, Number(timeoutMs) || UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS);
  let timer = null;
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeout);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  touch();
  return { signal: controller.signal, touch, clear };
}
function updateError(code, message, cause) {
  const err = new Error(message || code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}
function classifyUpdateError(err) {
  const code = String(err && err.code || '').trim();
  const message = String(err && err.message || err || '').trim();
  const detail = message || code || 'Неизвестная ошибка';
  if (/HASH|DIGEST|CHECKSUM/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_HASH_MISMATCH', reason: 'Проверка файла не пройдена, возможно сбой кэша линии — установочный пакет заблокирован.', detail };
  }
  if (/SIZE_MISMATCH|content length/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_SIZE_MISMATCH', reason: 'Размер скачанного файла не совпадает, возможно обрыв сети или неполный кэш линии.', detail };
  }
  if (/AbortError|TIMEOUT|ETIMEDOUT|timeout/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_TIMEOUT', reason: 'Тайм-аут соединения, текущее сетевое подключение к линии обновления нестабильно.', detail };
  }
  if (/ENOTFOUND|EAI_AGAIN|DNS|fetch failed|getaddrinfo/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_DNS_FAILED', reason: 'Не удалось разрешить домен, возможно текущая сеть не может подключиться к этой линии обновления.', detail };
  }
  if (/ECONNRESET|ECONNREFUSED|socket|network/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_NETWORK_FAILED', reason: 'Сетевое соединение прервано, выполнена попытка переключить линию обновления.', detail };
  }
  const http = message.match(/\bHTTP[_\s-]?(\d{3})\b/i) || message.match(/\b(\d{3})\b/);
  if (http) {
    const status = Number(http[1]);
    if (status === 403) return { code: code || 'UPDATE_HTTP_403', reason: 'Линия обновления вернула 403, возможно ограничение скорости или блокировка.', detail };
    if (status === 404) return { code: code || 'UPDATE_HTTP_404', reason: 'Файл обновления не найден, возможно ресурсы релиза ещё не синхронизировались.', detail };
    if (status >= 500) return { code: code || 'UPDATE_HTTP_5XX', reason: 'Ошибка сервера линии обновления, попробуйте позже.', detail };
    return { code: code || ('UPDATE_HTTP_' + status), reason: 'Линия обновления вернула HTTP ' + status + '.', detail };
  }
  return { code: code || 'UPDATE_FAILED', reason: 'Ошибка обновления: ' + detail, detail };
}
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}
async function fetchTextFromCandidates(candidates, timeoutMs) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : [];
  const failures = [];
  for (let i = 0; i < list.length; i++) {
    const candidate = list[i];
    try {
      const resp = await fetchWithTimeout(candidate.url, {
        headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
      }, timeoutMs || 6500);
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);
      return { text: await resp.text(), candidate };
    } catch (err) {
      const info = classifyUpdateError(err);
      failures.push(candidate.label + ': ' + info.reason);
    }
  }
  throw updateError('UPDATE_ALL_LINES_FAILED', failures.join('；') || 'All update lines failed');
}
function yamlScalar(text, key) {
  const pattern = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+?)\\s*$', 'm');
  const match = String(text || '').match(pattern);
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}
function githubReleaseDownloadUrl(version, fileName) {
  const tag = 'v' + normalizeVersion(version);
  const encodedOwner = encodeURIComponent(UPDATE_CONFIG.owner);
  const encodedRepo = encodeURIComponent(UPDATE_CONFIG.repo);
  const encodedName = String(fileName || '').split('/').map(part => encodeURIComponent(part)).join('/');
  return `https://github.com/${encodedOwner}/${encodedRepo}/releases/download/${tag}/${encodedName}`;
}
function parseLatestYmlUpdateInfo(text, reason) {
  const latestVersion = normalizeVersion(yamlScalar(text, 'version') || APP_VERSION) || APP_VERSION;
  const assetPath = yamlScalar(text, 'path') || yamlScalar(text, 'url') || `Mineradio-${latestVersion}-Setup.exe`;
  const sha512 = normalizeDigest(yamlScalar(text, 'sha512'), 'sha512');
  const size = Number(yamlScalar(text, 'size') || 0) || 0;
  const releaseDate = yamlScalar(text, 'releaseDate');
  const downloadUrl = githubReleaseDownloadUrl(latestVersion, assetPath);
  const candidates = uniqueDownloadCandidates(downloadUrl);
  const asset = {
    name: updateAssetNameFromUrl(downloadUrl) || assetPath,
    size,
    contentType: 'application/octet-stream',
    downloadUrl,
    downloadUrls: publicDownloadUrls(candidates),
    sha256: '',
    sha512,
  };
  return {
    configured: true,
    preview: false,
    updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: 'v' + latestVersion,
      name: 'Mineradio v' + latestVersion,
      version: latestVersion,
      publishedAt: releaseDate,
      htmlUrl: `https://github.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/tag/v${latestVersion}`,
      downloadUrl,
      asset,
      patch: null,
      patchAvailable: false,
      summary: 'Найдена новая версия, включена резервная линия обновления.',
      notes: ['Проверка обновлений переключена на резервную линию', 'При загрузке автоматически выбирается ускоренная линия', 'При ошибке загрузки показывается точная причина и текущая скорость'],
    },
    source: 'latest-yml',
    reason: reason || '',
  };
}
async function fetchLatestYmlUpdateInfo(reason) {
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') throw updateError('UPDATE_REPOSITORY_NOT_CONFIGURED');
  const latestYmlUrl = `https://github.com/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest/download/latest.yml`;
  const candidates = uniqueDownloadCandidates(latestYmlUrl);
  const result = await fetchTextFromCandidates(candidates, 6500);
  return parseLatestYmlUpdateInfo(result.text, reason);
}
async function fetchLatestUpdateInfoUncached() {
  if (UPDATE_CONFIG.manifest) return fetchManifestUpdateInfo(UPDATE_CONFIG.manifest);
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') return localUpdateFallback();
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);
  try {
    const resp = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': `Mineradio/${APP_VERSION}`,
        'Accept': 'application/vnd.github+json',
      },
    });
    if (!resp.ok) {
      try { return await fetchLatestYmlUpdateInfo('GitHub Releases ' + resp.status); }
      catch (_) { return localUpdateFallback('GitHub Releases ' + resp.status, { configured: true }); }
    }
    const data = await resp.json();
    const latestVersion = normalizeVersion(data.tag_name || data.name || APP_VERSION) || APP_VERSION;
    const asset = pickReleaseAsset(data.assets);
    const patch = pickPatchAsset(data.assets, APP_VERSION, latestVersion);
    const notes = extractReleaseNotes(data.body).length ? extractReleaseNotes(data.body) : UPDATE_FALLBACK_NOTES;
    return {
      configured: true,
      preview: false,
      updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
      currentVersion: APP_VERSION,
      latestVersion,
      release: {
        tagName: data.tag_name || ('v' + latestVersion),
        name: data.name || ('Mineradio v' + latestVersion),
        version: latestVersion,
        publishedAt: data.published_at || '',
        htmlUrl: data.html_url || '',
        downloadUrl: asset ? asset.downloadUrl : '',
        asset,
        patch,
        patchAvailable: !!(patch && patch.downloadUrl && compareVersions(latestVersion, APP_VERSION) > 0),
        summary: notes[0] || 'Найдена новая версия, рекомендуется обновиться.',
        notes,
      },
    };
  } catch (err) {
    const reason = err && err.message || 'Update check failed';
    try { return await fetchLatestYmlUpdateInfo(reason); }
    catch (fallbackErr) { return localUpdateFallback((fallbackErr && fallbackErr.message) || reason, { configured: true }); }
  } finally {
    clearTimeout(timer);
  }
}
/**
 * Получает информацию о последней версии, переиспользуя краткосрочный кэш и уже выполняющийся запрос проверки, чтобы уменьшить число повторных запросов к GitHub при старте и клике на загрузку.
 * @param {{force?: boolean}=} opts При force = true существующий кэш пропускается, но уже идущая проверка всё равно переиспользуется.
 * @returns {Promise<object>} Копия результата проверки обновлений.
 */
async function fetchLatestUpdateInfo(opts) {
  opts = opts || {};
  const now = Date.now();
  if (!opts.force && updateInfoCache && updateInfoCache.expiresAt > now) {
    return cloneUpdateInfo(updateInfoCache.value);
  }
  if (!latestUpdateInfoPromise) {
    latestUpdateInfoPromise = fetchLatestUpdateInfoUncached()
      .then(rememberUpdateInfo)
      .finally(() => {
        latestUpdateInfoPromise = null;
      });
  }
  return cloneUpdateInfo(await latestUpdateInfoPromise);
}
function safeUpdateFileName(name, version) {
  const raw = String(name || '').trim() || `Mineradio-${version || APP_VERSION}.exe`;
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return cleaned || `Mineradio-${version || APP_VERSION}.exe`;
}
function publicUpdateJob(job) {
  if (!job) return { ok: false, error: 'UPDATE_JOB_NOT_FOUND' };
  return {
    ok: job.status !== 'error',
    id: job.id,
    status: job.status,
    progress: job.progress || 0,
    received: job.received || 0,
    total: job.total || 0,
    speedBps: job.speedBps || 0,
    etaSeconds: job.etaSeconds || 0,
    sourceLabel: job.sourceLabel || '',
    attempt: job.attempt || 0,
    attempts: job.attempts || 0,
    mode: job.mode || 'installer',
    message: job.message || '',
    restartRequired: !!job.restartRequired,
    cached: !!job.cached,
    fileName: job.fileName || '',
    filePath: job.status === 'ready' ? job.filePath : '',
    version: job.version || '',
    releaseUrl: job.releaseUrl || '',
    error: job.error || '',
    errorReason: job.errorReason || '',
    errorDetail: job.errorDetail || '',
    failedAttempts: Array.isArray(job.failedAttempts) ? job.failedAttempts.slice(0, 6) : [],
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
function activeUpdateJobFor(version) {
  const jobs = Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jobs.find(job => job.version === version && (job.status === 'queued' || job.status === 'downloading' || job.status === 'ready'));
}
function trimUpdateJobs() {
  const jobs = Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  jobs.slice(8).forEach(job => updateDownloadJobs.delete(job.id));
}
async function downloadUpdateAsset(job) {
  const tmpPath = job.filePath + '.download';
  try {
    fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    job.status = 'downloading';
    job.updatedAt = Date.now();

    const resp = await fetch(job.downloadUrl, {
      headers: {
        'User-Agent': `Mineradio/${APP_VERSION}`,
      },
    });
    if (!resp.ok) throw new Error('Download failed ' + resp.status);

    const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
    job.total = totalHeader || job.total || 0;
    job.received = 0;
    job.progress = 0;
    job.speedBps = 0;
    job.etaSeconds = 0;
    job.message = job.total ? 'Загружается полный установочный пакет' : 'Загружается полный установочный пакет, ожидание размера от сервера';
    job.updatedAt = Date.now();
    let speedWindowAt = Date.now();
    let speedWindowBytes = 0;

    const writer = fs.createWriteStream(tmpPath);
    const reader = resp.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const buf = Buffer.from(chunk.value);
        job.received += buf.length;
        speedWindowBytes += buf.length;
        const now = Date.now();
        if (now - speedWindowAt >= 900) {
          job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
          speedWindowAt = now;
          speedWindowBytes = 0;
        }
        if (job.total > 0) {
          job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
          job.etaSeconds = job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
        } else {
          const kb = Math.max(1, job.received / 1024);
          job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(kb + 1) * 24)));
        }
        job.message = job.total > 0 ? 'Загружается полный установочный пакет' : 'Загружается полный установочный пакет, сервер не сообщил общий размер';
        job.updatedAt = Date.now();
        if (!writer.write(buf)) await once(writer, 'drain');
      }
    } finally {
      writer.end();
      await once(writer, 'finish').catch(() => {});
    }

    if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
    fs.renameSync(tmpPath, job.filePath);
    job.status = 'ready';
    job.progress = 100;
    job.message = 'Установочный пакет загружен';
    job.updatedAt = Date.now();
  } catch (e) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    job.status = 'error';
    job.error = e.message || 'UPDATE_DOWNLOAD_FAILED';
    job.updatedAt = Date.now();
  }
}
function sha512Base64(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('base64');
}
function sha512Hex(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('hex');
}
function verifyUpdateBuffer(buffer, job) {
  const expectedSize = Number(job.expectedSize || job.total || 0) || 0;
  if (expectedSize > 0 && buffer.length !== expectedSize) {
    throw updateError('UPDATE_SIZE_MISMATCH', `Expected ${expectedSize} bytes, got ${buffer.length}`);
  }
  const expectedSha256 = normalizeDigest(job.sha256 || '', 'sha256').toLowerCase();
  if (expectedSha256 && sha256Hex(buffer) !== expectedSha256) {
    throw updateError('UPDATE_SHA256_MISMATCH', 'Downloaded sha256 mismatch');
  }
  const expectedSha512 = normalizeDigest(job.sha512 || '', 'sha512');
  if (expectedSha512) {
    const actualBase64 = sha512Base64(buffer);
    const actualHex = sha512Hex(buffer).toLowerCase();
    if (actualBase64 !== expectedSha512 && actualHex !== expectedSha512.toLowerCase()) {
      throw updateError('UPDATE_SHA512_MISMATCH', 'Downloaded sha512 mismatch');
    }
  }
}
function verifyUpdateFile(filePath, job) {
  verifyUpdateBuffer(fs.readFileSync(filePath), job);
}
function moveInvalidUpdateFile(filePath, reason) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    const invalidPath = path.join(dir, `${base}.invalid-${Date.now()}${ext || '.bin'}`);
    fs.renameSync(filePath, invalidPath);
    console.warn('[UpdateDownload] cached installer moved aside:', reason || 'invalid', invalidPath);
  } catch (e) {
    console.warn('[UpdateDownload] failed to move invalid cached installer:', e.message);
  }
}
function reuseVerifiedInstallerJob(opts) {
  if (!opts || !opts.filePath || !fs.existsSync(opts.filePath)) return null;
  if (!opts.expectedSize && !opts.sha256 && !opts.sha512) return null;
  const now = Date.now();
  const stat = fs.statSync(opts.filePath);
  const job = {
    id: 'cached-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'ready',
    progress: 100,
    received: stat.size || 0,
    total: opts.expectedSize || stat.size || 0,
    speedBps: 0,
    etaSeconds: 0,
    sourceLabel: 'Локальный кэш',
    attempt: 0,
    attempts: opts.attempts || 0,
    mode: 'installer',
    message: 'Установочный пакет загружен, можно сразу запустить установку',
    fileName: opts.fileName || path.basename(opts.filePath),
    filePath: opts.filePath,
    version: opts.version || '',
    downloadUrl: opts.downloadUrl || '',
    downloadCandidates: opts.downloadCandidates || [],
    expectedSize: opts.expectedSize || 0,
    sha256: opts.sha256 || '',
    sha512: opts.sha512 || '',
    releaseUrl: opts.releaseUrl || '',
    failedAttempts: [],
    cached: true,
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  try {
    verifyUpdateFile(opts.filePath, job);
    updateDownloadJobs.set(job.id, job);
    trimUpdateJobs();
    return job;
  } catch (err) {
    moveInvalidUpdateFile(opts.filePath, (err && err.message) || 'cache verification failed');
    return null;
  }
}
function setUpdateJobError(job, err, fallbackMessage) {
  const info = classifyUpdateError(err);
  job.status = 'error';
  job.error = info.code;
  job.errorReason = info.reason;
  job.errorDetail = info.detail;
  job.message = fallbackMessage || info.reason;
  job.updatedAt = Date.now();
}
function prepareUpdateJobAttempt(job, candidate, index, total) {
  job.status = 'downloading';
  job.sourceLabel = candidate.label || 'Линия загрузки';
  job.attempt = index + 1;
  job.attempts = total;
  job.received = 0;
  job.speedBps = 0;
  job.etaSeconds = 0;
  job.error = '';
  job.errorReason = '';
  job.errorDetail = '';
  job.updatedAt = Date.now();
}
function ensureMirrorCanBeVerified(job, candidate) {
  if (!candidate || !candidate.mirrored) return;
  if (job.sha256 || job.sha512) return;
  throw updateError('MIRROR_HASH_MISSING', 'Mirror download skipped because no digest is available');
}
async function downloadUpdateAssetWithMirrors(job) {
  const tmpPath = job.filePath + '.download';
  const candidates = Array.isArray(job.downloadCandidates) && job.downloadCandidates.length
    ? job.downloadCandidates
    : uniqueDownloadCandidates(job.downloadUrl || '');
  const failures = [];
  fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      ensureMirrorCanBeVerified(job, candidate);
      prepareUpdateJobAttempt(job, candidate, i, candidates.length);
      job.message = job.total ? 'Загружается полный установочный пакет' : 'Загружается полный установочный пакет, ожидание размера от сервера';

      const idleGuard = createUpdateDownloadIdleGuard(UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS);
      try {
        const resp = await fetch(candidate.url, {
          signal: idleGuard.signal,
          headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
        });
        if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);

        const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
        job.total = totalHeader || job.expectedSize || job.total || 0;
        job.progress = 0;
        job.updatedAt = Date.now();
        let speedWindowAt = Date.now();
        let speedWindowBytes = 0;

        const writer = fs.createWriteStream(tmpPath);
        const reader = resp.body.getReader();
        try {
          while (true) {
            idleGuard.touch();
            const chunk = await reader.read();
            if (chunk.done) break;
            idleGuard.touch();
            const buf = Buffer.from(chunk.value);
            job.received += buf.length;
            speedWindowBytes += buf.length;
            const now = Date.now();
            if (now - speedWindowAt >= 900) {
              job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
              speedWindowAt = now;
              speedWindowBytes = 0;
            }
            if (job.total > 0) {
              job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
              job.etaSeconds = job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
            } else {
              const kb = Math.max(1, job.received / 1024);
              job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(kb + 1) * 24)));
            }
            job.message = job.total > 0 ? 'Загружается полный установочный пакет' : 'Загружается полный установочный пакет, сервер не сообщил общий размер';
            job.updatedAt = Date.now();
            if (!writer.write(buf)) await once(writer, 'drain');
          }
        } finally {
          writer.end();
          await once(writer, 'finish').catch(() => {});
        }
      } finally {
        idleGuard.clear();
      }

      verifyUpdateFile(tmpPath, job);
      if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
      fs.renameSync(tmpPath, job.filePath);
      job.status = 'ready';
      job.progress = 100;
      job.etaSeconds = 0;
      job.message = 'Установочный пакет загружен';
      job.updatedAt = Date.now();
      return;
    } catch (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      const info = classifyUpdateError(err);
      failures.push({ source: candidate.label || 'Линия загрузки', reason: info.reason, detail: info.detail });
      job.failedAttempts = failures.slice(-6);
      job.message = i < candidates.length - 1 ? ((candidate.label || 'Текущая линия') + ' — ошибка, переключение линии') : info.reason;
      job.updatedAt = Date.now();
      if (i >= candidates.length - 1) setUpdateJobError(job, err, 'Ошибка загрузки: ' + info.reason);
    }
  }
}
function startUpdateDownloadJob(info) {
  const release = info && info.release ? info.release : {};
  const asset = release.asset || {};
  const downloadUrl = release.downloadUrl || asset.downloadUrl || '';
  if (!info || !info.configured) return { ok: false, error: 'UPDATE_REPOSITORY_NOT_CONFIGURED' };
  if (!info.updateAvailable) return { ok: false, error: 'NO_UPDATE_AVAILABLE' };
  if (!/^https?:\/\//i.test(downloadUrl)) return { ok: false, error: 'UPDATE_ASSET_MISSING' };

  const version = info.latestVersion || release.version || '';
  const existing = activeUpdateJobFor(version);
  if (existing) return publicUpdateJob(existing);

  const fileName = safeUpdateFileName(asset.name || '', version);
  const filePath = path.join(UPDATE_DOWNLOAD_DIR, fileName);
  const downloadCandidates = uniqueDownloadCandidates([downloadUrl].concat(Array.isArray(asset.downloadUrls) ? asset.downloadUrls : []));
  const expectedSize = asset.size || 0;
  const sha256 = normalizeDigest(asset.sha256 || '', 'sha256').toLowerCase();
  const sha512 = normalizeDigest(asset.sha512 || '', 'sha512');
  const cached = reuseVerifiedInstallerJob({
    fileName,
    filePath,
    version,
    downloadUrl,
    downloadCandidates,
    expectedSize,
    sha256,
    sha512,
    releaseUrl: release.htmlUrl || '',
    attempts: downloadCandidates.length,
  });
  if (cached) return publicUpdateJob(cached);

  const now = Date.now();
  const job = {
    id: now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'queued',
    progress: 0,
    received: 0,
    total: expectedSize,
    mode: 'installer',
    fileName,
    filePath,
    version,
    downloadUrl,
    downloadCandidates,
    expectedSize,
    sha256,
    sha512,
    releaseUrl: release.htmlUrl || '',
    sourceLabel: '',
    attempt: 0,
    attempts: downloadCandidates.length,
    failedAttempts: [],
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  updateDownloadJobs.set(job.id, job);
  trimUpdateJobs();
  downloadUpdateAssetWithMirrors(job);
  return publicUpdateJob(job);
}
function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function safePatchRelativePath(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel || rel.includes('\0')) return '';
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..' || part === '.')) return '';
  const root = parts[0];
  if (PATCH_ALLOWED_FILES.has(rel)) return rel;
  if (!PATCH_ALLOWED_ROOTS.has(root)) return '';
  if (/\.(exe|dll|node|msi|bat|cmd|ps1|pfx|pem|key)$/i.test(rel)) return '';
  return parts.join('/');
}
function patchTargetPath(rel) {
  const safeRel = safePatchRelativePath(rel);
  if (!safeRel) return null;
  const target = path.resolve(__dirname, safeRel);
  const root = path.resolve(__dirname);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}
function decodePatchFile(file) {
  if (!file || typeof file !== 'object') return null;
  if (typeof file.contentBase64 === 'string') return Buffer.from(file.contentBase64, 'base64');
  if (typeof file.content === 'string') return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
  return null;
}
function backupPatchTarget(job, rel, target) {
  if (!fs.existsSync(target)) return;
  const backup = path.join(UPDATE_PATCH_BACKUP_DIR, job.id, rel);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(target, backup);
}
function writePatchFile(job, file) {
  const rel = safePatchRelativePath(file.path || file.name);
  const target = rel ? patchTargetPath(rel) : null;
  const content = decodePatchFile(file);
  if (!rel || !target || !content) throw new Error('INVALID_PATCH_FILE');
  if (content.length > PATCH_MAX_BYTES) throw new Error('PATCH_FILE_TOO_LARGE');
  const expected = String(file.sha256 || '').trim().toLowerCase();
  const actual = sha256Hex(content);
  if (expected && expected !== actual) throw new Error('PATCH_HASH_MISMATCH:' + rel);
  backupPatchTarget(job, rel, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.mineradio-patch';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
  if (expected && sha256Hex(fs.readFileSync(target)) !== expected) throw new Error('PATCH_WRITE_VERIFY_FAILED:' + rel);
  return rel;
}
function normalizePatchPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('INVALID_PATCH_PAYLOAD');
  const type = String(payload.type || payload.kind || '');
  if (type && type !== 'mineradio-resource-patch') throw new Error('UNSUPPORTED_PATCH_TYPE');
  const from = normalizeVersion(payload.from || payload.baseVersion || '');
  const to = normalizeVersion(payload.to || payload.version || payload.targetVersion || '');
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!from || compareVersions(from, APP_VERSION) !== 0) throw new Error('PATCH_VERSION_MISMATCH');
  if (!to || compareVersions(to, APP_VERSION) <= 0) throw new Error('PATCH_TARGET_VERSION_INVALID');
  if (!files.length) throw new Error('PATCH_EMPTY');
  if (files.length > 40) throw new Error('PATCH_TOO_MANY_FILES');
  return { from, to, files, restartRequired: payload.restartRequired !== false };
}
async function downloadAndApplyPatch(job) {
  const chunks = [];
  try {
    fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    job.status = 'downloading';
    job.mode = 'patch';
    job.message = 'Загружается быстрый патч';
    job.updatedAt = Date.now();

    const resp = await fetch(job.downloadUrl, {
      headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
    });
    if (!resp.ok) throw new Error('Patch download failed ' + resp.status);

    job.total = parseInt(resp.headers.get('content-length') || '0', 10) || job.total || 0;
    job.received = 0;
    const reader = resp.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const buf = Buffer.from(chunk.value);
      job.received += buf.length;
      if (job.received > PATCH_MAX_BYTES) throw new Error('PATCH_TOO_LARGE');
      chunks.push(buf);
      job.progress = job.total > 0
        ? Math.max(1, Math.min(84, Math.round((job.received / job.total) * 84)))
        : Math.max(1, Math.min(76, Math.round(Math.log10(job.received / 1024 + 1) * 24)));
      job.updatedAt = Date.now();
    }

    const raw = Buffer.concat(chunks);
    const expectedPatchHash = String(job.sha256 || '').trim().toLowerCase();
    if (expectedPatchHash && sha256Hex(raw) !== expectedPatchHash) throw new Error('PATCH_PACKAGE_HASH_MISMATCH');
    const patch = normalizePatchPayload(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
    job.version = patch.to;
    job.message = 'Применяется быстрый патч';
    job.progress = 88;
    job.updatedAt = Date.now();
    const changed = [];
    patch.files.forEach(file => changed.push(writePatchFile(job, file)));
    job.changedFiles = changed;
    job.status = 'ready';
    job.progress = 100;
    job.restartRequired = patch.restartRequired;
    job.message = patch.restartRequired ? 'Быстрый патч применён, вступит в силу после перезапуска' : 'Быстрый патч применён';
    job.updatedAt = Date.now();
  } catch (e) {
    job.status = 'error';
    job.error = e.message || 'PATCH_APPLY_FAILED';
    job.message = 'Ошибка быстрого патча, можно использовать полный установочный пакет';
    job.updatedAt = Date.now();
  }
}
async function downloadPatchBufferFromCandidate(job, candidate, index, total) {
  ensureMirrorCanBeVerified(job, candidate);
  prepareUpdateJobAttempt(job, candidate, index, total);
  job.mode = 'patch';
  job.message = 'Загружается быстрый патч';
  job.progress = 0;
  job.updatedAt = Date.now();

  const resp = await fetchWithTimeout(candidate.url, {
    headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
  }, 12000);
  if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);

  job.total = parseInt(resp.headers.get('content-length') || '0', 10) || job.expectedSize || job.total || 0;
  job.received = 0;
  const chunks = [];
  const reader = resp.body.getReader();
  let speedWindowAt = Date.now();
  let speedWindowBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const buf = Buffer.from(chunk.value);
    job.received += buf.length;
    speedWindowBytes += buf.length;
    if (job.received > PATCH_MAX_BYTES) throw updateError('PATCH_TOO_LARGE', 'Patch package is too large');
    chunks.push(buf);
    const now = Date.now();
    if (now - speedWindowAt >= 700) {
      job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
      speedWindowAt = now;
      speedWindowBytes = 0;
    }
    job.progress = job.total > 0
      ? Math.max(1, Math.min(84, Math.round((job.received / job.total) * 84)))
      : Math.max(1, Math.min(76, Math.round(Math.log10(job.received / 1024 + 1) * 24)));
    job.etaSeconds = job.total > 0 && job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
    job.updatedAt = Date.now();
  }
  const raw = Buffer.concat(chunks);
  verifyUpdateBuffer(raw, job);
  return raw;
}
async function downloadAndApplyPatchWithMirrors(job) {
  const candidates = Array.isArray(job.downloadCandidates) && job.downloadCandidates.length
    ? job.downloadCandidates
    : uniqueDownloadCandidates(job.downloadUrl || '');
  const failures = [];
  fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const raw = await downloadPatchBufferFromCandidate(job, candidate, i, candidates.length);
      const patch = normalizePatchPayload(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
      job.version = patch.to;
      job.message = 'Применяется быстрый патч';
      job.progress = 88;
      job.etaSeconds = 0;
      job.updatedAt = Date.now();
      const changed = [];
      patch.files.forEach(file => changed.push(writePatchFile(job, file)));
      job.changedFiles = changed;
      job.status = 'ready';
      job.progress = 100;
      job.restartRequired = patch.restartRequired;
      job.message = patch.restartRequired ? 'Быстрый патч применён, вступит в силу после перезапуска' : 'Быстрый патч применён';
      job.updatedAt = Date.now();
      return;
    } catch (err) {
      const info = classifyUpdateError(err);
      failures.push({ source: candidate.label || 'Линия загрузки', reason: info.reason, detail: info.detail });
      job.failedAttempts = failures.slice(-6);
      job.message = i < candidates.length - 1 ? ((candidate.label || 'Текущая линия') + ' — ошибка, переключение линии') : info.reason;
      job.updatedAt = Date.now();
      if (i >= candidates.length - 1) setUpdateJobError(job, err, 'Ошибка быстрого патча: ' + info.reason);
    }
  }
}
function startUpdatePatchJob(info) {
  const release = info && info.release ? info.release : {};
  const patch = release.patch || {};
  const downloadUrl = patch.downloadUrl || '';
  if (!info || !info.configured) return { ok: false, error: 'UPDATE_REPOSITORY_NOT_CONFIGURED' };
  if (!info.updateAvailable) return { ok: false, error: 'NO_UPDATE_AVAILABLE' };
  if (!release.patchAvailable || !/^https?:\/\//i.test(downloadUrl)) return { ok: false, error: 'PATCH_ASSET_MISSING' };

  const version = info.latestVersion || release.version || patch.to || '';
  const existing = Array.from(updateDownloadJobs.values())
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .find(job => job.mode === 'patch' && job.version === version && (job.status === 'queued' || job.status === 'downloading' || job.status === 'ready'));
  if (existing) return publicUpdateJob(existing);

  const now = Date.now();
  const downloadCandidates = uniqueDownloadCandidates([downloadUrl].concat(Array.isArray(patch.downloadUrls) ? patch.downloadUrls : []));
  const job = {
    id: 'patch-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'queued',
    progress: 0,
    received: 0,
    total: patch.size || 0,
    mode: 'patch',
    fileName: patch.name || safeUpdateFileName('', version).replace(/\.exe$/i, '.patch.json'),
    filePath: '',
    version,
    downloadUrl,
    downloadCandidates,
    releaseUrl: release.htmlUrl || '',
    expectedSize: patch.size || 0,
    sha256: normalizeDigest(patch.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(patch.sha512 || '', 'sha512'),
    restartRequired: true,
    sourceLabel: '',
    attempt: 0,
    attempts: downloadCandidates.length,
    failedAttempts: [],
    message: 'Ожидание загрузки быстрого патча',
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  updateDownloadJobs.set(job.id, job);
  trimUpdateJobs();
  downloadAndApplyPatchWithMirrors(job);
  return publicUpdateJob(job);
}
function readRequestBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) {
        const params = new URLSearchParams(raw);
        const out = {};
        params.forEach((v, k) => { out[k] = v; });
        resolve(out);
      }
    });
    req.on('error', () => resolve({}));
  });
}
// ====================================================================
//  HTTP Server
// ====================================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pn = url.pathname;

  if (pn === '/api/app/version') {
    sendJSON(res, {
      name: APP_PACKAGE.name || 'mineradio',
      productName: APP_PACKAGE.productName || 'Mineradio',
      version: APP_VERSION,
      update: {
        provider: UPDATE_CONFIG.provider,
        configured: UPDATE_CONFIG.configured,
        owner: UPDATE_CONFIG.owner,
        repo: UPDATE_CONFIG.repo,
        preview: UPDATE_CONFIG.preview,
        manifestOverride: !!UPDATE_CONFIG.manifest,
      },
    });
    return;
  }

  if (pn === '/api/update/latest') {
    try {
      const force = url.searchParams.get('force') === '1' || url.searchParams.get('refresh') === '1';
      sendJSON(res, await fetchLatestUpdateInfo({ force }));
    } catch (err) {
      sendJSON(res, {
        ...localUpdateFallback(err.message || 'Update check failed', { configured: UPDATE_CONFIG.configured }),
        error: err.message || 'Update check failed',
      });
    }
    return;
  }

  if (pn === '/api/update/download') {
    try {
      const info = await fetchLatestUpdateInfo();
      const job = startUpdateDownloadJob(info);
      sendJSON(res, job, job.ok ? 200 : 400);
    } catch (err) {
      console.error('[UpdateDownload]', err);
      sendJSON(res, { ok: false, error: err.message || 'UPDATE_DOWNLOAD_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/update/download/status') {
    const id = url.searchParams.get('id') || '';
    const job = id
      ? updateDownloadJobs.get(id)
      : Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    sendJSON(res, publicUpdateJob(job), job ? 200 : 404);
    return;
  }

  if (pn === '/api/update/patch') {
    try {
      const info = await fetchLatestUpdateInfo();
      const job = startUpdatePatchJob(info);
      sendJSON(res, job, job.ok ? 200 : 400);
    } catch (err) {
      console.error('[UpdatePatch]', err);
      sendJSON(res, { ok: false, error: err.message || 'UPDATE_PATCH_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/update/patch/status') {
    const id = url.searchParams.get('id') || '';
    const job = id
      ? updateDownloadJobs.get(id)
      : Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).find(item => item.mode === 'patch');
    sendJSON(res, publicUpdateJob(job), job ? 200 : 404);
    return;
  }

  if (pn === '/api/beatmap/cache/status') {
    const info = beatCacheRootInfo();
    sendJSON(res, {
      enabled: info.allowed && info.available,
      dir: info.dir,
      drive: info.drive,
      reason: !info.allowed ? 'C_DRIVE_DISABLED' : (!info.available ? 'TARGET_DRIVE_UNAVAILABLE' : ''),
      mode: info.allowed && info.available ? 'disk' : 'memory-only',
    });
    return;
  }

  if (pn === '/api/beatmap/cache') {
    if (req.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      try {
        const entry = readBeatMapCache(key);
        sendJSON(res, entry
          ? { ok: true, hit: true, key: entry.key || key, map: entry.map, meta: entry.meta || {}, savedAt: entry.savedAt || 0 }
          : { ok: true, hit: false, key });
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          hit: false,
          enabled: false,
          mode: 'memory-only',
          key,
          reason: err.code || err.message || 'BEAT_CACHE_READ_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        sendJSON(res, writeBeatMapCache(body));
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          enabled: false,
          mode: 'memory-only',
          reason: err.code || err.message || 'BEAT_CACHE_WRITE_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    return;
  }

  // ---------- Yandex Music bridge ----------
  if (pn === '/api/yandex/status') {
    const client = getYandexClient();
    if (!client) {
      sendJSON(res, { ok: true, connected: false, reason: 'NO_TOKEN' });
      return;
    }
    try {
      const status = await client.accountStatus();
      const account = (status && status.account) || {};
      sendJSON(res, {
        ok: true,
        connected: true,
        displayName: account.displayName || account.login || '',
        uid: account.uid || null,
      });
    } catch (err) {
      sendJSON(res, { ok: false, connected: false, error: err.message || 'YANDEX_STATUS_FAILED' }, 502);
    }
    return;
  }

  if (pn === '/api/yandex/search') {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) { sendJSON(res, { ok: false, error: 'EMPTY_QUERY' }, 400); return; }
    try {
      const result = await client.search(q);
      const tracks = (result && result.tracks && result.tracks.results) || [];
      sendJSON(res, { ok: true, tracks: tracks.map(mapYandexTrack) });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_SEARCH_FAILED' }, 502);
    }
    return;
  }

  if (pn === '/api/yandex/debug/likes-raw') {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    try {
      const uid = await client.uid();
      const raw = await client._apiGet(`/users/${uid}/likes/tracks?if-modified-since-revision=0`);
      sendJSON(res, { ok: true, uid, raw });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message || 'DEBUG_FAILED' }, 502);
    }
    return;
  }

  if (pn === '/api/yandex/likes') {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    try {
      const tracks = await client.likedTracks();
      sendJSON(res, { ok: true, tracks: tracks.map(mapYandexTrack) });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_LIKES_FAILED' }, 502);
    }
    return;
  }

  if (pn === '/api/yandex/playlists') {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    try {
      const playlists = await client.playlists();
      sendJSON(res, {
        ok: true,
        playlists: (playlists || []).map((p) => ({
          kind: p.kind,
          title: p.title,
          trackCount: p.trackCount || 0,
          cover: p.cover && p.cover.uri ? `https://${String(p.cover.uri).replace('%%', '400x400')}` : null,
        })),
      });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_PLAYLISTS_FAILED' }, 502);
    }
    return;
  }

  if (pn === '/api/yandex/playlist') {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    const kind = url.searchParams.get('kind');
    if (!kind) { sendJSON(res, { ok: false, error: 'MISSING_KIND' }, 400); return; }
    try {
      const playlist = await client.playlist(kind);
      const shorts = (playlist && playlist.tracks) || [];
      const embedded = shorts.filter((t) => t.track).map((t) => t.track);
      const missingIds = shorts.filter((t) => !t.track).map((t) => t.id);
      const fetched = missingIds.length ? await client.tracksByIds(missingIds) : [];
      sendJSON(res, { ok: true, title: playlist.title, tracks: [...embedded, ...fetched].map(mapYandexTrack) });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_PLAYLIST_FAILED' }, 502);
    }
    return;
  }

  if (pn === '/api/yandex/playlist/create') {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    if (req.method !== 'POST') { sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    const body = await readRequestBody(req);
    const title = String((body && body.title) || '').trim();
    if (!title) { sendJSON(res, { ok: false, error: 'EMPTY_TITLE' }, 400); return; }
    try {
      const pl = await client.createPlaylist(title);
      sendJSON(res, {
        ok: true,
        playlist: {
          kind: pl && pl.kind,
          title: (pl && pl.title) || title,
          trackCount: (pl && pl.trackCount) || 0,
          cover: null,
        },
      });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_PLAYLIST_CREATE_FAILED' }, 502);
    }
    return;
  }

  if (pn === '/api/yandex/playlist/remove-track') {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    if (req.method !== 'POST') { sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    const body = await readRequestBody(req);
    const kind = String((body && body.kind) || '').trim();
    const trackId = String((body && body.trackId) || '').trim();
    if (!kind || !trackId) { sendJSON(res, { ok: false, error: 'BAD_PARAMS' }, 400); return; }
    try {
      await client.removeTrackFromPlaylist(kind, trackId);
      sendJSON(res, { ok: true });
    } catch (err) {
      const status = err && err.status === 409 ? 409 : (err && err.status === 404 ? 404 : 502);
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_PLAYLIST_REMOVE_FAILED' }, status);
    }
    return;
  }

  if (pn === '/api/yandex/playlist/reorder') {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    if (req.method !== 'POST') { sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    const body = await readRequestBody(req);
    const kind = String((body && body.kind) || '').trim();
    const fromIndex = Number(body && body.fromIndex);
    const toIndex = Number(body && body.toIndex);
    if (!kind || !Number.isFinite(fromIndex) || !Number.isFinite(toIndex)) {
      sendJSON(res, { ok: false, error: 'BAD_PARAMS' }, 400); return;
    }
    try {
      await client.reorderPlaylistTrack(kind, fromIndex, toIndex);
      sendJSON(res, { ok: true });
    } catch (err) {
      const status = err && err.status === 409 ? 409 : 502;
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_PLAYLIST_REORDER_FAILED' }, status);
    }
    return;
  }

  if (pn === '/api/yandex/login/status') {
    sendJSON(res, { ok: true, loggedIn: !!getYandexClient() });
    return;
  }

  if (pn === '/api/yandex/login/start') {
    if (req.method !== 'POST') { sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    try {
      const auth = await startDeviceAuth();
      pendingDeviceAuth = { deviceCode: auth.deviceCode, expiresAt: Date.now() + auth.expiresIn * 1000 };
      sendJSON(res, {
        ok: true,
        userCode: auth.userCode,
        verificationUrl: auth.verificationUrl,
        interval: auth.interval,
        expiresIn: auth.expiresIn,
      });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_LOGIN_START_FAILED' }, 502);
    }
    return;
  }

  if (pn === '/api/yandex/login/poll') {
    if (req.method !== 'POST') { sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    if (!pendingDeviceAuth) { sendJSON(res, { ok: false, error: 'NO_PENDING_LOGIN' }, 400); return; }
    if (Date.now() > pendingDeviceAuth.expiresAt) {
      pendingDeviceAuth = null;
      sendJSON(res, { ok: true, status: 'expired' });
      return;
    }
    try {
      const result = await pollDeviceAuth(pendingDeviceAuth.deviceCode);
      if (result.status === 'success') {
        saveYandexToken(result.accessToken);
        pendingDeviceAuth = null;
      } else if (result.status === 'expired') {
        pendingDeviceAuth = null;
      }
      sendJSON(res, { ok: true, status: result.status, error: result.error });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_LOGIN_POLL_FAILED' }, 502);
    }
    return;
  }

  if (pn === '/api/yandex/logout') {
    if (req.method !== 'POST') { sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    clearYandexToken();
    sendJSON(res, { ok: true });
    return;
  }

  if (pn === '/api/yandex/playlist/add-track') {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    if (req.method !== 'POST') { sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    const body = await readRequestBody(req);
    const kind = String((body && body.kind) || '').trim();
    const trackId = String((body && body.trackId) || '').trim();
    const albumId = (body && body.albumId) || 0;
    if (!kind || !trackId) { sendJSON(res, { ok: false, error: 'BAD_PARAMS' }, 400); return; }
    try {
      const result = await client.addTrackToPlaylist(kind, trackId, albumId);
      sendJSON(res, { ok: true, duplicate: !!(result && result.duplicate) });
    } catch (err) {
      const status = err && err.status === 409 ? 409 : 502;
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_PLAYLIST_ADD_FAILED' }, status);
    }
    return;
  }

  if (pn === '/api/yandex/like' || pn === '/api/yandex/unlike') {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    if (req.method !== 'POST') { sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    const body = await readRequestBody(req);
    const trackId = String((body && body.trackId) || '').trim();
    if (!trackId || !/^[0-9]+$/.test(trackId)) { sendJSON(res, { ok: false, error: 'BAD_TRACK_ID' }, 400); return; }
    try {
      if (pn === '/api/yandex/like') await client.likeTrack(trackId);
      else await client.unlikeTrack(trackId);
      sendJSON(res, { ok: true, trackId, liked: pn === '/api/yandex/like' });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_LIKE_FAILED' }, 502);
    }
    return;
  }

  if (pn === '/api/yandex/wave') {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    const trackId = url.searchParams.get('trackId');
    if (!trackId || !/^[0-9]+$/.test(trackId)) { sendJSON(res, { ok: false, error: 'BAD_TRACK_ID' }, 400); return; }
    const queueParam = url.searchParams.get('queue') || '';
    const queueIds = queueParam.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const result = await client.stationTracks(`track:${trackId}`, { queue: queueIds });
      const sequence = (result && result.sequence) || [];
      const tracks = sequence.map((item) => item && item.track).filter(Boolean);
      sendJSON(res, { ok: true, tracks: tracks.map(mapYandexTrack), batchId: (result && result.batchId) || null });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_WAVE_FAILED' }, 502);
    }
    return;
  }

  if (pn.startsWith('/api/yandex/lyrics/')) {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    const trackId = pn.slice('/api/yandex/lyrics/'.length);
    if (!/^[0-9:]+$/.test(trackId)) { sendJSON(res, { ok: false, error: 'BAD_TRACK_ID' }, 400); return; }
    const format = (url.searchParams.get('format') || 'LRC').toUpperCase();
    try {
      const text = await client.lyrics(trackId, format);
      sendJSON(res, { ok: true, lyrics: text || '', available: !!text });
    } catch (err) {
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_LYRICS_FAILED' }, 502);
    }
    return;
  }

  if (pn.startsWith('/api/yandex/stream/')) {
    const client = getYandexClient();
    if (!client) { sendJSON(res, { ok: false, error: 'NO_TOKEN' }, 401); return; }
    const trackId = pn.slice('/api/yandex/stream/'.length);
    if (!/^[0-9]+$/.test(trackId)) { sendJSON(res, { ok: false, error: 'BAD_TRACK_ID' }, 400); return; }
    try {
      const directUrl = await client.directStreamUrl(trackId);
      const upstreamHeaders = {};
      if (req.headers.range) upstreamHeaders.Range = req.headers.range;

      const pipeAudio = (currentUrl, redirectsLeft) => {
        const target = new URL(currentUrl);
        const upstreamReq = https.request(
          { host: target.host, path: target.pathname + target.search, headers: upstreamHeaders },
          (upstreamRes) => {
            const status = upstreamRes.statusCode;
            const isRedirect = [301, 302, 303, 307, 308].includes(status);
            if (isRedirect && upstreamRes.headers.location && redirectsLeft > 0) {
              upstreamRes.resume(); // слить тело редиректа, чтобы не подвисало соединение
              const nextUrl = new URL(upstreamRes.headers.location, target).toString();
              pipeAudio(nextUrl, redirectsLeft - 1);
              return;
            }
            const headers = {
              'Content-Type': upstreamRes.headers['content-type'] || 'audio/mpeg',
              'Access-Control-Allow-Origin': '*',
              'Cross-Origin-Resource-Policy': 'cross-origin',
              'Cache-Control': 'no-store',
            };
            if (upstreamRes.headers['content-length']) headers['Content-Length'] = upstreamRes.headers['content-length'];
            if (upstreamRes.headers['content-range']) headers['Content-Range'] = upstreamRes.headers['content-range'];
            if (upstreamRes.headers['accept-ranges']) headers['Accept-Ranges'] = upstreamRes.headers['accept-ranges'];
            res.writeHead(status, headers);
            upstreamRes.pipe(res);
          }
        );
        upstreamReq.on('error', (err) => {
          console.error('[YandexStream]', err);
          if (!res.headersSent) res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
          res.end();
        });
        upstreamReq.end();
      };

      pipeAudio(directUrl, 5);
    } catch (err) {
      console.error('[YandexStream]', err);
      sendJSON(res, { ok: false, error: err.message || 'YANDEX_STREAM_FAILED' }, 502);
    }
    return;
  }

  // ---------- Прокси обложек Яндекс.Музыки (чтобы картинка была same-origin и не "пачкала" canvas/WebGL) ----------
  if (pn === '/api/cover-proxy') {
    try {
      const rawUrl = url.searchParams.get('url') || '';
      let target;
      try { target = new URL(rawUrl); } catch (e) { target = null; }
      const allowedHostSuffix = '.yandex.net';
      if (!target || target.protocol !== 'https:' || !target.hostname.endsWith(allowedHostSuffix)) {
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
        res.end('Bad cover url');
        return;
      }
      const pipeCover = (currentUrl, redirectsLeft) => {
        const t = new URL(currentUrl);
        const upstreamReq = https.request(
          { host: t.host, path: t.pathname + t.search },
          (upstreamRes) => {
            const status = upstreamRes.statusCode;
            const isRedirect = [301, 302, 303, 307, 308].includes(status);
            if (isRedirect && upstreamRes.headers.location && redirectsLeft > 0) {
              upstreamRes.resume();
              const nextUrl = new URL(upstreamRes.headers.location, t).toString();
              pipeCover(nextUrl, redirectsLeft - 1);
              return;
            }
            const headers = {
              'Content-Type': upstreamRes.headers['content-type'] || 'image/jpeg',
              'Access-Control-Allow-Origin': '*',
              'Cross-Origin-Resource-Policy': 'cross-origin',
              'Cache-Control': 'public, max-age=86400',
            };
            if (upstreamRes.headers['content-length']) headers['Content-Length'] = upstreamRes.headers['content-length'];
            res.writeHead(status, headers);
            upstreamRes.pipe(res);
          }
        );
        upstreamReq.on('error', (err) => {
          console.error('[CoverProxy]', err);
          if (!res.headersSent) res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
          res.end();
        });
        upstreamReq.end();
      };
      pipeCover(target.toString(), 5);
    } catch (err) {
      console.error('[CoverProxy]', err);
      if (!res.headersSent) res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    }
    return;
  }

  // ---------- Прокси локальных файлов (поддержка Range, для постоянной локальной библиотеки) ----------
  if (pn === '/api/local-file') {
    try {
      if (!LOCAL_FILE_TOKEN || url.searchParams.get('token') !== LOCAL_FILE_TOKEN) {
        res.writeHead(403, { 'Access-Control-Allow-Origin': '*' });
        res.end('Forbidden');
        return;
      }
      const target = path.resolve(String(url.searchParams.get('path') || ''));
      const stat = fs.statSync(target);
      if (!stat.isFile()) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('Not found');
        return;
      }
      const total = stat.size;
      let start = 0;
      let end = Math.max(0, total - 1);
      let status = 200;
      const range = req.headers.range || '';
      const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
      if (match) {
        const parsedStart = match[1] ? Number(match[1]) : 0;
        const parsedEnd = match[2] ? Number(match[2]) : end;
        if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd) || parsedStart > parsedEnd || parsedStart >= total) {
          res.writeHead(416, {
            'Access-Control-Allow-Origin': '*',
            'Content-Range': `bytes */${total}`,
          });
          res.end();
          return;
        }
        start = Math.max(0, parsedStart);
        end = Math.min(end, parsedEnd);
        status = 206;
      }
      const headers = {
        'Content-Type': localContentTypeForPath(target),
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'no-store',
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
      res.writeHead(status, headers);
      fs.createReadStream(target, { start, end })
        .on('error', (err) => {
          console.error('[LocalFile]', err);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        })
        .pipe(res);
    } catch (err) {
      console.error('[LocalFile]', err);
      res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    }
    return;
  }

  // ---------- Статические ресурсы ----------
  if (pn === '/favicon.ico') {
    serveStatic(res, path.join(__dirname, 'build', 'icon.ico'));
    return;
  }

  let filePath = pn === '/' ? '/index.html' : pn;
  filePath = path.join(__dirname, 'public', filePath);
  serveStatic(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log('======================================================');
  console.log(' Particle Music Visualizer v2  →  http://localhost:' + PORT);
  console.log('======================================================');
});

module.exports = server;
