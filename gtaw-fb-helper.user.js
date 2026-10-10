// ==UserScript==
// @name         Facebrowser Helper (GTA World)
// @namespace    gtaw-fb-helper
// @version      1.1.0
// @description  Лайки и заявки в друзья от имени текущего персонажа: лимиты, паузы, dry-run. Работает в уже открытой и залогиненной вкладке.
// @match        https://fbv2.gtaw.io/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window || window.__gtawBotLoaded) return;
  window.__gtawBotLoaded = true;

  const API = window.__GTAWBOT_API__ || 'https://fbv2-api.gtaw.io';
  const API_ORIGIN = new URL(API).origin;
  const V1 = API + '/api/v1';
  const STORE = 'gtawbot:v1';
  const LOCK = 'gtawbot:run';
  const TEST = !!window.__GTAWBOT_TEST__;
  const MIN_DELAY_FLOOR = TEST ? 0 : 5;            // сек, ниже нельзя
  const HARD_MAX = { likes: 300, friends: 80 };    // потолок дневных лимитов
  const GAP = TEST ? [0, 0] : [1.5, 4];            // пауза между служебными GET-запросами, сек
  const WARMUP_GAP = TEST ? [0, 0] : [3, 8];       // от лайка «перед заявкой» до самой заявки, сек
  const REQUEST_TIMEOUT = 25;                      // сек на один запрос
  const MAX_RETRY_AFTER = 120;                     // если 429 просит ждать дольше, останавливаемся
  const MAX_REFUSALS = 5;                          // столько отказов сайта подряд, и стоп
  const RESEND_DAYS = 30;                          // столько дней не шлём повторную заявку тому же человеку
  const SENT_CAP = 3000;                           // сколько адресатов заявок помнить на персонажа
  const DAY_MS = 864e5;

  // ------------------------------------------------------------------ утилиты
  const rand = (a, b) => a + Math.random() * (b - a);
  const num = (v, d, lo, hi) => {
    if (v == null || String(v).trim() === '') return d;          // пустое поле = значение по умолчанию, а не 0
    v = Number(v);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
  };
  const ok = (status) => status >= 200 && status < 300;
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/^@/, '');
  const today = () => new Date().toLocaleDateString('sv');   // YYYY-MM-DD по местному времени
  class Stop extends Error {}

  // ------------------------------------------------------------------ хранилище
  const store = {
    read() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (_) { return {}; } },
    write(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (_) {} },
  };

  // Счётчики общие для всех вкладок сайта. Перед записью сливаем свои данные с сохранёнными,
  // иначе вкладка, открытая утром, затрёт счётчики, набранные за день в другой вкладке.
  function pruneSent(sent) {
    const edge = Date.now() - RESEND_DAYS * DAY_MS;
    const list = Object.entries(sent || {}).filter(([, t]) => t > edge);
    if (list.length > SENT_CAP) { list.sort((a, b) => b[1] - a[1]); list.length = SENT_CAP; }
    return Object.fromEntries(list);
  }
  function mergeProfile(x, y) {
    x = x || {}; y = y || {};
    const dx = x.date || '', dy = y.date || '';
    const n = dx >= dy ? x : y;                                  // при разных датах побеждает более свежая
    const p = { date: n.date || '', likes: n.likes || 0, friends: n.friends || 0 };
    if (dx === dy) { p.likes = Math.max(x.likes || 0, y.likes || 0); p.friends = Math.max(x.friends || 0, y.friends || 0); }
    const sent = Object.assign({}, x.sent);
    for (const [id, t] of Object.entries(y.sent || {})) sent[id] = Math.max(t, sent[id] || 0);
    p.sent = pruneSent(sent);
    return p;
  }
  function mergeProfiles(a, b) {
    a = a || {}; b = b || {};
    const out = {};
    for (const pid of new Set([...Object.keys(a), ...Object.keys(b)])) out[pid] = mergeProfile(a[pid], b[pid]);
    return out;
  }

  const state = Object.assign({ settings: {}, profiles: {}, collapsed: false, log: [] }, store.read());
  state.profiles = mergeProfiles(state.profiles, null);
  const save = () => { state.profiles = mergeProfiles(state.profiles, store.read().profiles); store.write(state); };

  // ------------------------------------------------------------------ состояние запуска
  let run = null;          // {pid, dry, opts, seen, ...} пока идёт сессия
  let stopWhy = '';        // непустая строка: пора остановиться, и вот почему
  let ui = null;
  let lastPending = null;  // сколько неотвеченных заявок видели в последний раз
  const requestStop = (why) => { if (!stopWhy) stopWhy = why; };
  const checkStop = () => { if (stopWhy) throw new Stop(stopWhy); };

  // ------------------------------------------------------------------ перехват заголовков сайта
  // Сайт сам шлёт x-profile-id (какой персонаж активен) и x-xsrf-token: подхватываем их,
  // ничего не меняя в его запросах.
  const cap = { profileId: null, xsrf: null };
  const origFetch = window.fetch.bind(window);
  const isApi = (u) => { try { return new URL(String(u), location.href).origin === API_ORIGIN; } catch (_) { return false; } };
  const take = (name, value) => {
    name = String(name).toLowerCase();
    if (!value) return;
    if (name === 'x-profile-id') { if (cap.profileId !== String(value)) { cap.profileId = String(value); onProfile(); } }
    else if (name === 'x-xsrf-token') cap.xsrf = String(value);
  };
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__gtawApi = isApi(u); return xhrOpen.call(this, m, u, ...rest); };
  XMLHttpRequest.prototype.setRequestHeader = function (n, v) { if (this.__gtawApi) take(n, v); return xhrSet.call(this, n, v); };
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && (input.url || input.href));   // Request или URL
      if (isApi(url)) {
        if (typeof Request !== 'undefined' && input instanceof Request) input.headers.forEach((v, n) => take(n, v));
        if (init && init.headers) new Headers(init.headers).forEach((v, n) => take(n, v));
      }
    } catch (_) { /* перехват не должен ломать сайт */ }
    return origFetch(input, init);
  };

  // ------------------------------------------------------------------ статус и паузы
  let phase = '', waitText = '';
  const paintStatus = () => { if (ui) ui.status.textContent = [phase, waitText].filter(Boolean).join(' · '); };
  const setPhase = (t) => { phase = t; paintStatus(); };
  const setWait = (t) => { if (waitText !== t) { waitText = t; paintStatus(); } };

  // Ждёт ms, раз в 250 мс обновляя обратный отсчёт; «Стоп» прерывает ожидание сразу.
  const sleep = (ms, label) => new Promise((res) => {
    const end = Date.now() + ms;
    const tick = () => {
      const left = end - Date.now();
      if (stopWhy || left <= 0) { clearInterval(iv); setWait(''); res(); }
      else if (label) setWait(`${label} через ${Math.ceil(left / 1000)} с`);
    };
    const iv = setInterval(tick, 250);
    tick();
  });
  const pause = (lo, hi, label) => sleep(rand(lo, hi) * 1000, label);
  const gap = async () => { await pause(GAP[0], GAP[1]); checkStop(); };
  // Интервал между действиями (лайк, заявка) выдерживается перед следующим действием:
  // служебные GET в промежутке его не удлиняют, а после последнего действия лишнего ожидания нет.
  const actedNow = (lo, hi) => { run.next = Date.now() + rand(lo, hi) * 1000; };
  async function pace(label) {
    const ms = (run.next || 0) - Date.now();
    if (ms > 0) await sleep(ms, label);
    checkStop();
  }

  // ------------------------------------------------------------------ дневные счётчики
  const day = (pid) => {
    const p = state.profiles[pid] || (state.profiles[pid] = {});
    if (p.date !== today()) { p.date = today(); p.likes = 0; p.friends = 0; }
    if (!p.sent) p.sent = {};
    return p;
  };
  function bump(kind) {
    state.profiles = mergeProfiles(state.profiles, store.read().profiles);   // подтянуть то, что записали другие вкладки
    day(run.pid)[kind]++;
    run.stats[kind]++;
    save(); refreshCounters();
  }
  const remember = (id) => { day(run.pid).sent[String(id)] = Date.now(); save(); };
  const recentlySent = (id) => Date.now() - (day(run.pid).sent[String(id)] || 0) < RESEND_DAYS * DAY_MS;

  // ------------------------------------------------------------------ лог
  const logs = Array.isArray(state.log) ? state.log.slice(-60) : [];
  if (TEST) window.__gtawLogs = logs;   // только для автотестов
  function paintLog() {
    if (!ui) return;
    ui.log.textContent = logs.slice(-14).join('\n'); ui.log.scrollTop = ui.log.scrollHeight;
  }
  function log(msg) {
    logs.push(`${new Date().toLocaleTimeString('ru-RU')} ${msg}`);
    if (logs.length > 300) logs.shift();
    state.log = logs.slice(-60); save();
    paintLog();
  }

  // ------------------------------------------------------------------ API
  const readXsrf = () => {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : cap.xsrf;
  };
  async function refreshCsrf() {
    try { await origFetch(API + '/sanctum/csrf-cookie', { credentials: 'include', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } }); } catch (_) {}
  }

  async function api(method, path, body) {
    let rateLimited = 0, csrfDone = false;
    for (;;) {
      if (cap.profileId !== run.pid) requestStop('Сменился активный персонаж: остановлено.');
      checkStop();
      const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-Profile-Id': run.pid };
      let data;
      if (method !== 'GET') {
        let tok = readXsrf();
        if (!tok) { await refreshCsrf(); tok = readXsrf(); }
        if (tok) headers['X-XSRF-TOKEN'] = tok;
        if (body !== undefined) { headers['Content-Type'] = 'application/json'; data = JSON.stringify(body); }
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT * 1000);
      let res, text;
      try {
        res = await origFetch(V1 + path, { method, headers, body: data, credentials: 'include', signal: ctl.signal });
        text = await res.text();
      } catch (e) {
        if (e && e.name === 'AbortError') {
          throw new Stop(`Сайт не ответил за ${REQUEST_TIMEOUT} с` + (method === 'GET' ? '.' : ': неизвестно, прошло ли последнее действие.'));
        }
        throw new Stop('Нет связи с сайтом: ' + (e && e.message));
      } finally { clearTimeout(timer); }
      let js;
      try { js = text.trim() ? JSON.parse(text) : {}; } catch (_) { js = undefined; }
      const st = res.status;
      if (js === undefined || (st >= 502 && st <= 504)) throw new Stop('Ответ не JSON или 5xx: похоже на проверку Cloudflare или сбой. Обнови страницу, пройди проверку и запусти снова.');
      if (js === null || typeof js !== 'object') js = {};
      if (st === 429) {
        const ra = parseInt(res.headers.get('retry-after'), 10);
        const wait = (Number.isFinite(ra) ? ra : 15) + rand(1, 5);
        if (++rateLimited > 1) throw new Stop('Повторный 429 (Too Many Attempts). Попробуй позже.');
        if (wait > MAX_RETRY_AFTER) throw new Stop(`429: сайт просит подождать ${Math.round(wait / 60)} мин. Попробуй позже.`);
        log(`  429: жду ${Math.round(wait)} с`);
        await sleep(wait * 1000, 'повтор');
        continue;
      }
      if (st === 419 && !csrfDone) { csrfDone = true; await refreshCsrf(); continue; }
      if (st === 401 || st === 419) throw new Stop('Сессия не авторизована: войди на сайте и обнови страницу.');
      return { status: st, data: js };
    }
  }
  async function get(path) {
    const r = await api('GET', path);
    if (!ok(r.status)) throw new Stop(`GET ${path.split('?')[0]}: HTTP ${r.status}`);
    return r.data;
  }

  // ------------------------------------------------------------------ правила отбора
  const likeable = (p, me) =>
    (p.user_reaction == null || p.user_reaction === '' || p.user_reaction === false) &&
    String(p.profile_id) !== String(me) && p.visibility === 'public' && !p.is_adult_content && p.is_published !== false;

  const friendable = (p, me) => {
    if (String(p.id) === String(me)) return false;
    if (p.is_minor || p.is_bot || p.is_verified_bot || p.is_banned || p.is_memorial) return false;
    if (p.can_login === false) return false;
    return p.friendship_status == null || p.friendship_status === '' || p.friendship_status === 'none';
  };

  // список «не трогать»: id или ники через запятую / с новой строки
  const parseIgnore = (s) => new Set(String(s || '').split(/[,;\n]+/).map(norm).filter(Boolean));
  const ignored = (...keys) => keys.some((k) => k != null && k !== '' && run.ignore.has(norm(k)));

  let refusals = 0;
  async function refused(r, what) {
    const msg = r.data && typeof r.data.message === 'string' ? `: ${r.data.message.slice(0, 120)}` : '';
    log(`  отказ сайта (HTTP ${r.status}${msg}) для ${what}, пропускаю`);
    if (++refusals >= MAX_REFUSALS) throw new Stop(`${MAX_REFUSALS} отказов подряд: останавливаюсь, чтобы не долбить сайт.`);
    await gap();
  }

  async function react(postId) {
    run.seen.add(String(postId));          // второй POST по тому же посту мог бы снять реакцию: больше его не трогаем
    await pace('лайк');
    const r = await api('POST', `/posts/${postId}/react`, { type: run.opts.reaction });
    if (ok(r.status)) { refusals = 0; bump('likes'); return true; }
    await refused(r, `поста ${postId}`);
    return false;
  }

  // ------------------------------------------------------------------ заявки в друзья
  async function pendingCount() {
    const d = await get('/friends/sent?page=1');
    const t = d.meta ? Number(d.meta.total) : NaN;
    return Number.isFinite(t) ? t : null;
  }

  async function gatherPeople(want) {
    const PAGE = 10;
    const pool = [], ids = new Set();
    let skippedSent = 0;
    for (let i = 0; i < 6 && pool.length < Math.max(want * 3, 20); i++) {
      if (i) await gap();
      const q = new URLSearchParams({ limit: PAGE, offset: i * PAGE, gender: 'all', exclude_friends: 'true',
        exclude_requested: 'true', exclude_block_friend_requests: 'true', exclude_minors: 'true' });
      if (run.opts.onlineOnly) q.set('online', 'yes');
      const d = await get('/people?' + q);
      const people = Array.isArray(d.people) ? d.people : [];
      for (const p of people) {
        const id = String(p.id);
        if (ids.has(id)) continue;                            // список мог сдвинуться между страницами
        ids.add(id);
        if (!friendable(p, run.pid) || ignored(p.id, p.username)) continue;
        if (recentlySent(p.id)) { skippedSent++; continue; }  // отклонил или проигнорировал: не навязываемся
        pool.push(p);
      }
      const total = Number(d.total);
      if (people.length < PAGE || (Number.isFinite(total) && (i + 1) * PAGE >= total)) break;
    }
    if (skippedSent) log(`  пропущено ${skippedSent}: заявка им уже уходила за последние ${RESEND_DAYS} дн.`);
    // сначала онлайн и самые активные: у них выше шанс ответа
    pool.sort((a, b) => (Number(!!b.is_online) - Number(!!a.is_online)) ||
      String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || '')));
    return pool;
  }

  async function warmup(p, name) {
    await gap();
    const pd = await get(`/profiles/${p.id}/posts?sort=recent&type=all`);
    const arr = Array.isArray(pd.posts) ? pd.posts : ((pd.posts && pd.posts.data) || []);
    const post = arr.find((x) => !run.seen.has(String(x.id)) && likeable(x, run.pid));
    if (!post) return;
    if (run.dry) { run.seen.add(String(post.id)); log(`  [dry-run] лайк поста ${post.id} у ${name} перед заявкой`); return; }
    if (await react(post.id)) { log(`  лайк поста ${post.id} у ${name} (перед заявкой)`); actedNow(WARMUP_GAP[0], WARMUP_GAP[1]); }
  }

  async function doFriends() {
    const o = run.opts;
    const left = Math.max(0, o.dailyFriends - day(run.pid).friends);
    let want = Math.min(o.friends, left);
    log(`Заявки в друзья: план ${want} (осталось на сегодня ${left})`);
    if (want <= 0) return;
    setPhase('Заявки: проверяю висящие');
    const pending = await pendingCount();
    lastPending = pending; refreshCounters();
    if (pending != null && pending >= o.maxPending) {
      log(`  висит ${pending} неотвеченных заявок (потолок ${o.maxPending}): фазу заявок пропускаю`);
      return;
    }
    if (pending != null) want = Math.min(want, o.maxPending - pending);
    await gap();
    setPhase('Заявки: ищу людей');
    const pool = await gatherPeople(want);
    log(`  подходящих кандидатов: ${pool.length}`);
    let done = 0;
    for (const p of pool) {
      if (done >= want) break;
      setPhase(`Заявки: ${done}/${want}`);
      await gap();
      const name = p.username || p.id;
      const st = await get(`/friends/status/${p.id}`);
      if (st.status !== 'none') continue;                 // уже друзья / заявка есть / блок
      if (o.warmup && day(run.pid).likes < o.dailyLikes) await warmup(p, name);
      if (run.dry) { log(`  [dry-run] заявка в друзья: ${name} (id ${p.id})`); done++; continue; }
      await pace('заявка');
      remember(p.id);                                     // даже при отказе второй раз не пробуем
      const r = await api('POST', `/friends/request/${p.id}`);
      if (ok(r.status)) {
        refusals = 0; done++;
        if (lastPending != null) lastPending++;
        bump('friends');
        log(`  заявка отправлена: ${name} (id ${p.id}) [${done}/${want}]`);
        actedNow(o.minDelay, o.maxDelay);
      } else await refused(r, name);
    }
    log(`Заявки в друзья: ${run.dry ? 'в плане' : 'отправлено'} ${done}`);
  }

  // ------------------------------------------------------------------ лайки ленты
  async function doLikes() {
    const o = run.opts;
    const left = Math.max(0, o.dailyLikes - day(run.pid).likes);
    const want = Math.min(o.likes, left);
    log(`Лайки ленты: план ${want} (осталось на сегодня ${left})`);
    if (want <= 0) return;
    const firstIds = new Set();
    let cursor = null, done = 0;
    for (let page = 0; page < 10 && done < want; page++) {
      if (page) await gap();
      setPhase(`Лайки: ${done}/${want}`);
      const q = new URLSearchParams({ sort: 'recent', type: 'all' });
      if (cursor) q.set('cursor', cursor);
      const data = await get('/feed?' + q);
      const posts = Array.isArray(data.posts) ? data.posts : [];
      if (!posts.length || firstIds.has(String(posts[0].id))) break;   // курсор не сработал или лента кончилась
      firstIds.add(String(posts[0].id));
      for (const p of posts) {
        if (done >= want) break;
        const id = String(p.id);
        if (run.seen.has(id) || !likeable(p, run.pid)) continue;
        const who = (p.profile && p.profile.username) || '?';
        if (ignored(p.profile_id, p.profile && p.profile.username)) continue;
        if (run.dry) { run.seen.add(id); done++; log(`  [dry-run] лайк поста ${p.id} (автор ${who})`); continue; }
        if (await react(p.id)) {
          done++; setPhase(`Лайки: ${done}/${want}`);
          log(`  лайк поста ${p.id} (автор ${who}) [${done}/${want}]`);
          actedNow(o.minDelay, o.maxDelay);
        }
      }
      cursor = data.next_cursor;
      if (!cursor) break;
    }
    log(`Лайки ленты: ${run.dry ? 'в плане' : 'сделано'} ${done}`);
  }

  // ------------------------------------------------------------------ запуск
  // Одна сессия на все вкладки сайта: иначе две вкладки вдвоём перешагнут дневные потолки.
  async function exclusive(fn) {
    let ran = false;
    const body = async () => { ran = true; await fn(); };
    if (navigator.locks && typeof navigator.locks.request === 'function') {
      try {
        return await navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => { if (!lock) return false; await body(); return true; });
      } catch (_) { if (ran) return true; }                // Web Locks недоступны: работаем без блокировки
    }
    await body();
    return true;
  }

  async function session() {
    const { dry, opts, pid } = run;
    log(`${dry ? 'DRY-RUN: ничего не отправляется. ' : ''}Старт для персонажа ${pid}`);
    try {
      const r = await api('GET', '/notifications/unread-count');
      if (!ok(r.status)) throw new Stop(`Проверка сессии: HTTP ${r.status}`);
      if (opts.friends > 0) await doFriends();
      if (opts.likes > 0) { if (opts.friends > 0) await gap(); await doLikes(); }
      log('Готово.');
    } catch (e) {
      log(e instanceof Stop ? `СТОП: ${e.message}` : `Ошибка: ${e.message}`);
    }
    if (!dry) log(`Итог запуска: лайков ${run.stats.likes}, заявок ${run.stats.friends}.`);
  }

  async function start(opts, dry) {
    if (run) return;
    if (!cap.profileId) { log('Персонаж не определён: открой любую страницу сайта (например «Друзья»).'); return; }
    run = { pid: cap.profileId, opts, dry, seen: new Set(), next: 0, ignore: parseIgnore(opts.ignore), stats: { likes: 0, friends: 0 } };
    stopWhy = ''; refusals = 0; setRunning(true);
    try {
      if (!(await exclusive(session))) log('Уже идёт запуск в другой вкладке сайта: дождись его конца или останови там.');
    } finally {
      run = null; stopWhy = ''; setRunning(false); setPhase(''); setWait(''); refreshCounters();
    }
  }

  // ------------------------------------------------------------------ панель
  const CSS = `
    :host{all:initial}
    .box{position:fixed;right:12px;bottom:12px;z-index:2147483647;width:300px;font:12px/1.4 system-ui,sans-serif;
      color:#e8e8ee;background:#1b1d26f2;border:1px solid #3a3d4d;border-radius:10px;box-shadow:0 6px 24px #0008}
    .hd{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;cursor:pointer;font-weight:600}
    .bd{padding:0 10px 10px;display:grid;gap:8px}
    .bd.off{display:none}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    label{display:grid;gap:2px;color:#aab}
    label.ck{display:flex;gap:6px;align-items:center;color:#e8e8ee}
    input[type=number],select,textarea{width:100%;box-sizing:border-box;background:#11131a;color:#fff;border:1px solid #3a3d4d;border-radius:6px;padding:4px 6px;font:inherit}
    textarea{resize:vertical;min-height:30px}
    button{border:0;border-radius:6px;padding:7px 10px;font-weight:600;cursor:pointer;color:#fff}
    #start{background:#2f7d4f}#start.dry{background:#35608f}#stop{background:#a3413b}.sm{background:#3a3d4d}
    button:disabled{opacity:.45;cursor:default}
    .btns{display:flex;gap:6px}.btns button{flex:1}.btns button.sm{flex:0 0 auto}
    .st{color:#aab}.warn{color:#f0b35a}.stl{color:#9fd3a8}.stl:empty{display:none}
    pre{margin:0;max-height:150px;overflow:auto;white-space:pre-wrap;background:#11131a;border-radius:6px;padding:6px;font:11px/1.35 ui-monospace,monospace}
  `;
  const HTML = `
    <div class="box">
      <div class="hd" id="hd"><span>Facebrowser Helper</span><span id="tg">▾</span></div>
      <div class="bd" id="bd">
        <div class="st" id="pid"></div>
        <div class="st" id="cnt"></div>
        <div class="stl" id="status"></div>
        <div class="row">
          <label>Лайков за запуск<input id="likes" type="number" min="0"></label>
          <label>Заявок за запуск<input id="friends" type="number" min="0"></label>
          <label>Потолок лайков/день<input id="dLikes" type="number" min="0"></label>
          <label>Потолок заявок/день<input id="dFriends" type="number" min="0"></label>
          <label>Пауза от, с<input id="dMin" type="number" min="0"></label>
          <label>Пауза до, с<input id="dMax" type="number" min="0"></label>
          <label>Макс. висящих заявок<input id="maxPend" type="number" min="0"></label>
          <label>Реакция<select id="react"><option value="like">like</option><option value="love">love</option></select></label>
        </div>
        <label>Не трогать: id или ники через запятую<textarea id="ignore" rows="2" spellcheck="false"></textarea></label>
        <label class="ck"><input id="dry" type="checkbox" checked> Dry-run (ничего не отправлять)</label>
        <label class="ck"><input id="warm" type="checkbox"> Лайкнуть пост перед заявкой</label>
        <label class="ck"><input id="online" type="checkbox"> Заявки только онлайн-людям</label>
        <div class="btns"><button id="start">Старт</button><button id="stop" disabled>Стоп</button><button id="copy" class="sm" title="Скопировать лог">Лог</button><button id="clear" class="sm" title="Очистить лог">✕</button></div>
        <pre id="log"></pre>
      </div>
    </div>`;
  const DEFAULTS = { likes: 15, friends: 5, dailyLikes: 60, dailyFriends: 25, minDelay: 15, maxDelay: 45, maxPending: 200,
    reaction: 'like', warmup: false, onlineOnly: true, ignore: '' };

  function readOpts() {
    const s = Object.assign({}, DEFAULTS, state.settings);
    const minDelay = num(ui.dMin.value, s.minDelay, MIN_DELAY_FLOOR, 600);
    return {
      likes: num(ui.likes.value, s.likes, 0, HARD_MAX.likes),
      friends: num(ui.friends.value, s.friends, 0, HARD_MAX.friends),
      dailyLikes: num(ui.dLikes.value, s.dailyLikes, 0, HARD_MAX.likes),
      dailyFriends: num(ui.dFriends.value, s.dailyFriends, 0, HARD_MAX.friends),
      minDelay, maxDelay: Math.max(minDelay, num(ui.dMax.value, s.maxDelay, MIN_DELAY_FLOOR, 1200)),
      maxPending: num(ui.maxPend.value, s.maxPending, 0, 5000),
      reaction: ui.react.value === 'love' ? 'love' : 'like',
      warmup: ui.warm.checked, onlineOnly: ui.online.checked,
      ignore: String(ui.ignore.value || '').slice(0, 4000),
    };
  }
  // показываем в полях то, что реально будет использовано (после ограничений)
  function fillInputs(s) {
    ui.likes.value = s.likes; ui.friends.value = s.friends; ui.dLikes.value = s.dailyLikes; ui.dFriends.value = s.dailyFriends;
    ui.dMin.value = s.minDelay; ui.dMax.value = s.maxDelay; ui.maxPend.value = s.maxPending;
    ui.react.value = s.reaction; ui.warm.checked = !!s.warmup; ui.online.checked = !!s.onlineOnly; ui.ignore.value = s.ignore || '';
  }

  function refreshCounters() {
    if (!ui) return;
    if (!cap.profileId) { ui.cnt.textContent = ''; return; }
    const o = run ? run.opts : Object.assign({}, DEFAULTS, state.settings);
    const d = day(cap.profileId);
    const pend = lastPending != null ? ` · висит заявок: ${lastPending}` : '';
    ui.cnt.textContent = `Сегодня: лайки ${d.likes}/${o.dailyLikes} · заявки ${d.friends}/${o.dailyFriends}${pend}`;
  }
  function onProfile() {
    if (run && cap.profileId !== run.pid) requestStop('Сменился активный персонаж: остановлено.');
    else if (!run) lastPending = null;
    if (!ui) return;
    ui.pid.textContent = `Персонаж: ${cap.profileId} (определён автоматически)`;
    ui.pid.className = 'st';
    setRunning(!!run);
    refreshCounters();
  }
  function setRunning(on) {
    if (!ui) return;
    ui.start.disabled = on || !cap.profileId; ui.stop.disabled = !on;
  }
  function paintStart() {
    ui.start.textContent = ui.dry.checked ? 'Пробный прогон' : 'Старт';
    ui.start.classList.toggle('dry', ui.dry.checked);
  }

  function mount() {
    if (ui || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = 'gtawbot-host';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = HTML;
    try {
      const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS);   // CSSOM: не блокируется CSP
      root.adoptedStyleSheets = [sheet];
    } catch (_) {                                                  // старый браузер: обычный <style>
      const st = document.createElement('style'); st.textContent = CSS; root.prepend(st);
    }
    document.documentElement.appendChild(host);                    // вне <body>: React не трогает
    const $ = (id) => root.getElementById(id);
    ui = {};
    ['bd', 'tg', 'pid', 'cnt', 'status', 'likes', 'friends', 'dLikes', 'dFriends', 'dMin', 'dMax', 'maxPend', 'react',
      'ignore', 'dry', 'warm', 'online', 'start', 'stop', 'copy', 'clear', 'log'].forEach((id) => { ui[id] = $(id); });
    fillInputs(Object.assign({}, DEFAULTS, state.settings));
    paintStart();
    ui.bd.classList.toggle('off', !!state.collapsed); ui.tg.textContent = state.collapsed ? '▸' : '▾';
    ui.pid.textContent = 'Персонаж не определён: открой любую страницу сайта (например «Друзья»).';
    ui.pid.className = 'st warn'; ui.start.disabled = true;
    $('hd').addEventListener('click', () => {
      state.collapsed = !state.collapsed; save();
      ui.bd.classList.toggle('off', state.collapsed); ui.tg.textContent = state.collapsed ? '▸' : '▾';
    });
    const persist = () => { state.settings = readOpts(); save(); fillInputs(state.settings); refreshCounters(); };
    [ui.likes, ui.friends, ui.dLikes, ui.dFriends, ui.dMin, ui.dMax, ui.maxPend, ui.react, ui.ignore, ui.warm, ui.online]
      .forEach((el) => el.addEventListener('change', persist));
    ui.dry.addEventListener('change', paintStart);
    ui.start.addEventListener('click', () => {
      const o = readOpts(); state.settings = o; save(); fillInputs(o);
      start(o, ui.dry.checked);
    });
    ui.stop.addEventListener('click', () => { if (!run) return; requestStop('Остановлено кнопкой.'); log('Останавливаю…'); });
    ui.copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(logs.join('\n')); log('Лог скопирован в буфер.'); } catch (_) { log('Не удалось скопировать лог.'); }
    });
    ui.clear.addEventListener('click', () => { logs.length = 0; state.log = []; save(); paintLog(); });
    paintLog(); paintStatus();
    if (cap.profileId) onProfile();
  }

  // счётчики, изменённые в другой вкладке, сразу видны и здесь
  window.addEventListener('storage', (e) => {
    if (e.key !== STORE) return;
    try { state.profiles = mergeProfiles(state.profiles, (JSON.parse(e.newValue) || {}).profiles); } catch (_) {}
    refreshCounters();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
