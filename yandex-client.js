// ====================================================================
//  Mineradio — Yandex Music bridge
//  Неофициальный клиент API Яндекс Музыки (аналог мобильного приложения).
//  Основан на структуре запросов актуальной поддерживаемой библиотеки
//  MarshalX/yandex-music-api (те же base_url, заголовки, XML-подпись).
//  Ничего не хранит и никуда не пересылает токен, кроме самого Яндекса.
// ====================================================================

const https = require('https');
const crypto = require('crypto');

const BASE_URL = 'api.music.yandex.net';
const CLIENT_HEADER = 'YandexMusicAndroid/24023621';
const SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiA';

// OAuth Device Flow — вход через официальную страницу Яндекса без ввода
// пароля в самом приложении. client_id/secret — публично известные
// значения официального Android-клиента Яндекс.Музыки (свой OAuth-app
// с доступом к Музыке зарегистрировать нельзя, поэтому вся экосистема
// сторонних клиентов использует эти же константы).
const OAUTH_HOST = 'oauth.yandex.ru';
const DEVICE_CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const DEVICE_CLIENT_SECRET = '53bc75238f0c4d08a118e51fe9203300';

/** Шаг 1: запросить код устройства. Показываем пользователю userCode + ссылку. */
async function startDeviceAuth() {
  const body = `client_id=${DEVICE_CLIENT_ID}&client_secret=${DEVICE_CLIENT_SECRET}`;
  const res = await httpRequest({
    host: OAUTH_HOST,
    path: '/device/code',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });
  let json;
  try { json = JSON.parse(res.body.toString('utf8')); } catch (e) { json = null; }
  if (res.status < 200 || res.status >= 300 || !json || !json.device_code) {
    throw new YandexMusicError('YANDEX_DEVICE_CODE_FAILED', res.status);
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUrl: json.verification_url,
    interval: json.interval || 5,
    expiresIn: json.expires_in || 600,
  };
}

/** Шаг 2: опрос — вызывать раз в interval секунд, пока пользователь не подтвердит вход. */
async function pollDeviceAuth(deviceCode) {
  const body = `grant_type=device_code&code=${encodeURIComponent(deviceCode)}&client_id=${DEVICE_CLIENT_ID}&client_secret=${DEVICE_CLIENT_SECRET}`;
  const res = await httpRequest({
    host: OAUTH_HOST,
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });
  let json;
  try { json = JSON.parse(res.body.toString('utf8')); } catch (e) { json = null; }
  if (res.status >= 200 && res.status < 300 && json && json.access_token) {
    return { status: 'success', accessToken: json.access_token };
  }
  const err = (json && json.error) || '';
  if (err === 'authorization_pending') return { status: 'pending' };
  if (err === 'expired_token' || err === 'bad_verification_code') return { status: 'expired' };
  return { status: 'error', error: err || `HTTP_${res.status}` };
}

class YandexMusicError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'YandexMusicError';
    this.status = status;
  }
}

function httpRequest({ host, path, method = 'GET', headers = {}, body = null, timeoutMs = 12000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const req = https.request({ host, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', (err) => done(reject, err));
    });

    // Явный таймаут на простой сокета (сервер принял соединение, но молчит)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('YANDEX_REQUEST_TIMEOUT'));
    });
    req.on('timeout', () => req.destroy(new Error('YANDEX_REQUEST_TIMEOUT')));
    req.on('error', (err) => done(reject, err));

    // Аварийный дедлайн — сработает, даже если событие timeout по какой-то
    // причине не долетело (подвисший DNS/TLS-хендшейк и т.п.)
    const hardDeadline = setTimeout(() => {
      req.destroy();
      done(reject, new Error('YANDEX_REQUEST_TIMEOUT'));
    }, timeoutMs + 3000);
    hardDeadline.unref && hardDeadline.unref();

    const cleanup = () => clearTimeout(hardDeadline);
    req.on('close', cleanup);

    if (body) req.write(body);
    req.end();
  });
}

class YandexMusicClient {
  constructor(token) {
    if (!token || typeof token !== 'string') {
      throw new Error('YandexMusicClient требует токен');
    }
    this.token = token.trim();
    this._uid = null;
  }

  _headers(extra = {}) {
    return {
      'Authorization': `OAuth ${this.token}`,
      'X-Yandex-Music-Client': CLIENT_HEADER,
      'Accept': 'application/json',
      ...extra,
    };
  }

  async _apiGet(path) {
    const res = await httpRequest({ host: BASE_URL, path, headers: this._headers() });
    if (res.status === 401) throw new YandexMusicError('YANDEX_UNAUTHORIZED', 401);
    if (res.status < 200 || res.status >= 300) {
      throw new YandexMusicError(`YANDEX_HTTP_${res.status}`, res.status);
    }
    let json;
    try {
      json = JSON.parse(res.body.toString('utf8'));
    } catch (e) {
      throw new YandexMusicError('YANDEX_BAD_JSON', res.status);
    }
    return json.result !== undefined ? json.result : json;
  }

  async accountStatus() {
    const result = await this._apiGet('/account/status');
    this._uid = result && result.account && result.account.uid;
    return result;
  }

  async uid() {
    if (this._uid) return this._uid;
    await this.accountStatus();
    return this._uid;
  }

  async search(query, { type = 'track', page = 0 } = {}) {
    const q = encodeURIComponent(query);
    return this._apiGet(
      `/search?text=${q}&type=${type}&page=${page}&nocorrect=false&playlist-in-best=true`
    );
  }

  async likedTracks() {
    const uid = await this.uid();
    const result = await this._apiGet(`/users/${uid}/likes/tracks?if-modified-since-revision=0`);
    const library = (result && result.library) || {};
    // на случай, если структура ответа окажется плоской (без обёртки library)
    const rawTracks = (library.tracks && library.tracks.length) ? library.tracks : (result && result.tracks) || [];
    const ids = rawTracks.map((t) => t.id).filter(Boolean);
    return this.tracksByIds(ids);
  }

  async tracksByIds(ids) {
    if (!ids.length) return [];
    // Батчами по 100, чтобы не упереться в лимиты API
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const body = `track-ids=${batch.join(',')}&with-positions=true`;
      const res = await httpRequest({
        host: BASE_URL,
        path: '/tracks',
        method: 'POST',
        headers: this._headers({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        }),
        body,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new YandexMusicError(`YANDEX_HTTP_${res.status}`, res.status);
      }
      const json = JSON.parse(res.body.toString('utf8'));
      out.push(...(json.result || []));
    }
    return out;
  }

  async playlists() {
    const uid = await this.uid();
    return this._apiGet(`/users/${uid}/playlists/list`);
  }

  async playlist(kind) {
    const uid = await this.uid();
    return this._apiGet(`/users/${uid}/playlists/${kind}`);
  }

  /** Создать новый плейлист в аккаунте пользователя. */
  async createPlaylist(title) {
    const uid = await this.uid();
    const body = `title=${encodeURIComponent(title || 'Новый плейлист')}&visibility=private`;
    const res = await httpRequest({
      host: BASE_URL,
      path: `/users/${uid}/playlists/create`,
      method: 'POST',
      headers: this._headers({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }),
      body,
    });
    if (res.status < 200 || res.status >= 300) throw new YandexMusicError(`YANDEX_HTTP_${res.status}`, res.status);
    const json = JSON.parse(res.body.toString('utf8'));
    return json.result !== undefined ? json.result : json;
  }

  /**
   * Добавить трек в конец плейлиста. Яндекс требует "revision" плейлиста
   * (защита от гонок при параллельном редактировании) — берём его свежим
   * прямо перед изменением.
   */
  async addTrackToPlaylist(kind, trackId, albumId) {
    const uid = await this.uid();
    const info = await this.playlist(kind);
    const revision = (info && info.revision) || 1;
    const at = (info && typeof info.trackCount === 'number') ? info.trackCount : 0;
    const idStr = String(trackId);
    const existingTracks = (info && info.tracks) || [];
    const alreadyThere = existingTracks.some((t) => String((t.track && t.track.id) || t.id) === idStr);
    if (alreadyThere) return { duplicate: true };
    const diff = JSON.stringify([{ op: 'insert', at, tracks: [{ id: String(trackId), albumId: albumId || 0 }] }]);
    const body = `diff=${encodeURIComponent(diff)}&revision=${encodeURIComponent(revision)}`;
    const res = await httpRequest({
      host: BASE_URL,
      path: `/users/${uid}/playlists/${kind}/change-relative`,
      method: 'POST',
      headers: this._headers({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }),
      body,
    });
    if (res.status === 409) throw new YandexMusicError('YANDEX_PLAYLIST_CONFLICT', 409); // кто-то одновременно изменил плейлист — надо повторить
    if (res.status < 200 || res.status >= 300) throw new YandexMusicError(`YANDEX_HTTP_${res.status}`, res.status);
    const json = JSON.parse(res.body.toString('utf8'));
    return json.result !== undefined ? json.result : json;
  }

  /**
   * Добавить трек в "Мне нравится". Яндекс использует свой нестандартный
   * REST-стиль: и добавление, и удаление идут через POST на спец-путь.
   */
  async likeTrack(trackId) {
    const uid = await this.uid();
    const body = `track-ids=${encodeURIComponent(trackId)}`;
    const res = await httpRequest({
      host: BASE_URL,
      path: `/users/${uid}/likes/tracks/add-multiple`,
      method: 'POST',
      headers: this._headers({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }),
      body,
    });
    if (res.status < 200 || res.status >= 300) throw new YandexMusicError(`YANDEX_HTTP_${res.status}`, res.status);
    return true;
  }

  async unlikeTrack(trackId) {
    const uid = await this.uid();
    const res = await httpRequest({
      host: BASE_URL,
      path: `/users/${uid}/likes/tracks/${encodeURIComponent(trackId)}/remove`,
      method: 'POST',
      headers: this._headers({ 'Content-Length': 0 }),
    });
    if (res.status < 200 || res.status >= 300) throw new YandexMusicError(`YANDEX_HTTP_${res.status}`, res.status);
    return true;
  }

  /**
   * Удалить трек из плейлиста. Яндекс требует диапазон позиций (from/to),
   * а не id трека — поэтому сначала находим текущую позицию трека в
   * актуальном (свежем) списке плейлиста.
   */
  async removeTrackFromPlaylist(kind, trackId) {
    const uid = await this.uid();
    const info = await this.playlist(kind);
    const revision = (info && info.revision) || 1;
    const shorts = (info && info.tracks) || [];
    const idStr = String(trackId);
    const pos = shorts.findIndex((t) => String((t.track && t.track.id) || t.id) === idStr);
    if (pos === -1) throw new YandexMusicError('YANDEX_TRACK_NOT_IN_PLAYLIST', 404);
    const diff = JSON.stringify([{ op: 'delete', from: pos, to: pos + 1 }]);
    const body = `diff=${encodeURIComponent(diff)}&revision=${encodeURIComponent(revision)}`;
    const res = await httpRequest({
      host: BASE_URL,
      path: `/users/${uid}/playlists/${kind}/change-relative`,
      method: 'POST',
      headers: this._headers({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }),
      body,
    });
    if (res.status === 409) throw new YandexMusicError('YANDEX_PLAYLIST_CONFLICT', 409);
    if (res.status < 200 || res.status >= 300) throw new YandexMusicError(`YANDEX_HTTP_${res.status}`, res.status);
    const json = JSON.parse(res.body.toString('utf8'));
    return json.result !== undefined ? json.result : json;
  }

  /**
   * Переместить трек внутри плейлиста с позиции fromIndex на позицию toIndex
   * (используется при перетаскивании трека в интерфейсе).
   */
  async reorderPlaylistTrack(kind, fromIndex, toIndex) {
    const uid = await this.uid();
    const info = await this.playlist(kind);
    const revision = (info && info.revision) || 1;
    const diff = JSON.stringify([{ op: 'move', from: fromIndex, to: toIndex, count: 1 }]);
    const body = `diff=${encodeURIComponent(diff)}&revision=${encodeURIComponent(revision)}`;
    const res = await httpRequest({
      host: BASE_URL,
      path: `/users/${uid}/playlists/${kind}/change-relative`,
      method: 'POST',
      headers: this._headers({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }),
      body,
    });
    if (res.status === 409) throw new YandexMusicError('YANDEX_PLAYLIST_CONFLICT', 409);
    if (res.status < 200 || res.status >= 300) throw new YandexMusicError(`YANDEX_HTTP_${res.status}`, res.status);
    const json = JSON.parse(res.body.toString('utf8'));
    return json.result !== undefined ? json.result : json;
  }

  /**
   * "Волна" (rotor) — подбор похожих треков.
   * station: например 'track:54491929' (похожие на трек) или 'user:onyourwave'.
   * queue: id уже сыгранных/добавленных треков в этом сеансе волны — Яндекс
   * использует это, чтобы не повторяться и разнообразить подборку.
   */
  async stationTracks(station, { queue = [] } = {}) {
    const q = queue.length ? `&queue=${encodeURIComponent(queue.join(','))}` : '';
    return this._apiGet(`/rotor/station/${encodeURIComponent(station)}/tracks?settings2=true${q}`);
  }

  /**
   * Текст песни (LRC с таймкодами либо простой текст).
   * Возвращает null, если текста нет у трека.
   */
  async lyrics(trackId, format = 'LRC') {
    const numericId = String(trackId).split(':')[0];
    const ts = Math.floor(Date.now() / 1000);
    const sign = crypto
      .createHmac('sha256', 'p93jhgh689SBReK6ghtw62')
      .update(`${numericId}${ts}`, 'utf8')
      .digest('base64');
    let meta;
    try {
      meta = await this._apiGet(
        `/tracks/${numericId}/lyrics?format=${format}&timeStamp=${ts}&sign=${encodeURIComponent(sign)}`
      );
    } catch (err) {
      if (err && err.status === 404) return null; // текста нет — это нормально
      throw err;
    }
    if (!meta || !meta.downloadUrl) return null;
    const buf = await this._fetchUrl(meta.downloadUrl);
    return buf.toString('utf8');
  }

  /**
   * Возвращает варианты загрузки трека (список кодеков/битрейтов).
   */
  async downloadInfo(trackId) {
    const list = await this._apiGet(`/tracks/${trackId}/download-info`);
    return list || [];
  }

  /**
   * Возвращает прямую, но КРАТКОЖИВУЩУЮ (около минуты) ссылку на аудиофайл.
   * Нужно вызывать непосредственно перед проигрыванием, не кешировать надолго.
   */
  async directStreamUrl(trackId, { preferCodec = 'mp3' } = {}) {
    const infos = await this.downloadInfo(trackId);
    if (!infos.length) throw new YandexMusicError('YANDEX_NO_DOWNLOAD_INFO', 404);

    const nonPreview = infos.filter((i) => !i.preview);
    const pool = nonPreview.length ? nonPreview : infos;
    const byCodec = pool.filter((i) => i.codec === preferCodec);
    const chosen = (byCodec.length ? byCodec : pool)
      .sort((a, b) => (b.bitrateInKbps || 0) - (a.bitrateInKbps || 0))[0];

    const xmlRes = await this._fetchUrl(chosen.downloadInfoUrl);
    const xml = xmlRes.toString('utf8');

    const host = this._xmlTag(xml, 'host');
    const path = this._xmlTag(xml, 'path');
    const ts = this._xmlTag(xml, 'ts');
    const s = this._xmlTag(xml, 's');
    if (!host || !path || !ts || !s) throw new YandexMusicError('YANDEX_BAD_DOWNLOAD_XML', 502);

    const sign = crypto
      .createHash('md5')
      .update(SIGN_SALT + path.slice(1) + s, 'utf8')
      .digest('hex');

    return `https://${host}/get-mp3/${sign}/${ts}${path}`;
  }

  _xmlTag(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1] : null;
  }

  _fetchUrl(fullUrl) {
    const u = new URL(fullUrl);
    return httpRequest({
      host: u.host,
      path: u.pathname + u.search,
      headers: this._headers(),
    }).then((res) => {
      if (res.status < 200 || res.status >= 300) {
        throw new YandexMusicError(`YANDEX_HTTP_${res.status}`, res.status);
      }
      return res.body;
    });
  }
}

module.exports = { YandexMusicClient, YandexMusicError, startDeviceAuth, pollDeviceAuth };
