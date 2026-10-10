// ==UserScript==
// @name         Facebrowser Helper (GTA World)
// @namespace    gtaw-fb-helper
// @version      1.3.2
// @description  Лайки и заявки в друзья от имени текущего персонажа: лимиты, паузы, dry-run, авторежим, история. Работает в уже открытой и залогиненной вкладке.
// @match        https://fbv2.gtaw.io/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window || window.__gtawBotLoaded) return;
  window.__gtawBotLoaded = true;

  const VERSION = '1.3.2';
  const API = window.__GTAWBOT_API__ || 'https://fbv2-api.gtaw.io';
  const API_ORIGIN = new URL(API).origin;
  const V1 = API + '/api/v1';
  const STORE = 'gtawbot:v1';
  const REC_STORE = 'gtawbot:rec';
  const AUTO_STORE = 'gtawbot:auto';
  const LOCK = 'gtawbot:run';
  const TEST = !!window.__GTAWBOT_TEST__;
  const MIN_DELAY_FLOOR = TEST ? 0 : 5;            // сек, ниже нельзя
  const HARD_MAX = { likes: 1000, friends: 500 };  // потолок дневных лимитов (поднять можно здесь)
  const GAP = TEST ? [0, 0] : [1.5, 4];            // пауза между служебными GET-запросами, сек
  const WARMUP_GAP = TEST ? [0, 0] : [3, 8];       // от лайка «перед заявкой» до самой заявки, сек
  const REQUEST_TIMEOUT = TEST ? 3 : 25;           // сек на один запрос
  const MAX_RETRY_AFTER = 120;                     // если 429 просит ждать дольше, останавливаемся
  const MAX_REFUSALS = 5;                          // столько отказов сайта подряд, и стоп
  const RESEND_DAYS = 30;                          // столько дней не шлём повторную заявку тому же человеку
  const SENT_CAP = 3000;                           // сколько адресатов заявок помнить на персонажа
  const HIST_DAYS = 14;                            // сколько прошлых дней хранить в истории
  const AUTO_UNIT = TEST ? 1000 : 60000;           // интервал авторежима задаётся в минутах (в автотестах: в секундах)
  const AUTO_FLOOR = TEST ? 0 : 5;                 // мин, чаще авторежим не запускается
  const REC_CAP = 150;                             // сколько разных запросов помнит запись
  const NET_RETRIES = 3, NET_RETRY_MIN = 5;        // авторежим при обрыве связи: 3 попытки раз в 5 мин
  const USER_STOP = 'Остановлено кнопкой.';
  const AUTO_OFF = 'Авторежим выключен галочкой.';
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
  const ymd = (d) => d.toLocaleDateString('sv');                 // YYYY-MM-DD по местному времени
  const today = () => (TEST && window.__gtawToday) || ymd(new Date());
  const hhmm = (t) => {
    const d = new Date(t), s = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return ymd(d) === ymd(new Date()) ? s : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${s}`;
  };
  const fmtLeft = (ms) => {
    const s = Math.ceil(ms / 1000);
    if (s < 90) return `${s} с`;
    const m = Math.round(s / 60);
    return m < 90 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
  };
  class Stop extends Error { constructor(msg, transient) { super(msg); this.transient = !!transient; } }

  // ------------------------------------------------------------------ хранилище
  const readJSON = (key) => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (_) { return {}; } };
  const writeJSON = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) {} };
  const store = { read: () => readJSON(STORE), write: (v) => writeJSON(STORE, v) };

  // Счётчики общие для всех вкладок сайта. Перед записью сливаем свои данные с сохранёнными,
  // иначе вкладка, открытая утром, затрёт счётчики, набранные за день в другой вкладке.
  function pruneSent(sent) {
    const edge = Date.now() - RESEND_DAYS * DAY_MS;
    const list = Object.entries(sent || {}).filter(([, t]) => t > edge);
    if (list.length > SENT_CAP) { list.sort((a, b) => b[1] - a[1]); list.length = SENT_CAP; }
    return Object.fromEntries(list);
  }
  const maxPair = (a, b) => [Math.max((a && a[0]) || 0, (b && b[0]) || 0), Math.max((a && a[1]) || 0, (b && b[1]) || 0)];
  function pruneHist(hist) {
    const edge = new Date(today() + 'T12:00:00');
    edge.setDate(edge.getDate() - (HIST_DAYS - 1));
    const from = ymd(edge);
    const days = Object.keys(hist || {}).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && k >= from).sort();
    return Object.fromEntries(days.map((k) => [k, maxPair(hist[k], null)]));
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
    const hist = Object.assign({}, x.hist);
    for (const [d, v] of Object.entries(y.hist || {})) hist[d] = maxPair(hist[d], v);
    const old = n === x ? y : x;                                 // счётчики устаревшего дня уходят в историю
    if (dx !== dy && old.date && (old.likes || old.friends)) hist[old.date] = maxPair(hist[old.date], [old.likes, old.friends]);
    delete hist[p.date];
    p.hist = pruneHist(hist);
    return p;
  }
  function mergeProfiles(a, b) {
    a = a || {}; b = b || {};
    const out = {};
    for (const pid of new Set([...Object.keys(a), ...Object.keys(b)])) out[pid] = mergeProfile(a[pid], b[pid]);
    return out;
  }

  const state = Object.assign({ settings: {}, profiles: {}, collapsed: false, log: [], pos: null }, store.read());
  state.profiles = mergeProfiles(state.profiles, null);
  if (state.auto) { if (!localStorage.getItem(AUTO_STORE)) writeJSON(AUTO_STORE, state.auto); delete state.auto; }   // формат 1.3.0
  // Сохраняем счётчики и из остального только перечисленные ключи, которые поменяла эта вкладка
  // (settings, pos, collapsed, log): иначе вкладка со старыми данными затирала бы чужие изменения.
  function save(...keys) {
    const fresh = store.read();
    state.profiles = mergeProfiles(state.profiles, fresh.profiles);
    const out = Object.assign({}, fresh, { profiles: state.profiles });
    for (const k of keys) out[k] = state[k];
    delete out.auto;
    store.write(out);
  }
  // Состояние авторежима лежит отдельно и вместе с его настройками: продолжение после перезагрузки
  // не зависит от того, что сохранили другие вкладки.
  const readAuto = () => readJSON(AUTO_STORE);
  const writeAuto = (a) => writeJSON(AUTO_STORE, a);

  // ------------------------------------------------------------------ состояние запуска
  let run = null;          // {pid, dry, opts, seen, ...} пока идёт один запуск
  let busy = false;        // идёт запуск или авторежим
  let activePid = null, activeOpts = null;
  let stopWhy = '';        // непустая строка: пора остановиться, и вот почему
  let ui = null;
  let lastPending = null;  // сколько неотвеченных заявок видели в последний раз
  const requestStop = (why) => { if (!stopWhy) stopWhy = why; };
  const checkStop = () => { if (stopWhy) throw new Stop(stopWhy); };

  // ------------------------------------------------------------------ запись запросов сайта
  // Для настройки новых функций (автоответы в чате): запоминаем, какие запросы делает сам сайт.
  // Сохраняются только адреса (id заменены на {id}), коды ответов и структура JSON: имена полей и типы.
  // Тексты сообщений, имена, токены и cookie не записываются.
  const rec = (() => { try { return JSON.parse(localStorage.getItem(REC_STORE)) || {}; } catch (_) { return {}; } })();
  rec.on = !!rec.on;
  rec.gen = rec.gen || 0;                  // растёт при «Очистить», чтобы другие вкладки не вернули старое
  if (!rec.items || typeof rec.items !== 'object') rec.items = {};
  let recTimer = null, wsHooked = false;
  function mergeRecItems(into, from) {
    for (const [k, it] of Object.entries(from || {})) {
      const cur = into[k];
      if (!cur) { if (Object.keys(into).length < REC_CAP) into[k] = it; continue; }
      cur.n = Math.max(cur.n || 0, it.n || 0);
      cur.st = Array.from(new Set([...(cur.st || []), ...(it.st || [])])).slice(-5);
      for (const f of ['q', 'req', 'res', 'page']) if (cur[f] === undefined && it[f] !== undefined) cur[f] = it[f];
      if (it.ev) cur.ev = Object.assign({}, it.ev, cur.ev);
    }
  }
  function adoptRec(v) {
    if ((v.gen || 0) > rec.gen) { rec.gen = v.gen; rec.items = v.items && typeof v.items === 'object' ? v.items : {}; }
    else mergeRecItems(rec.items, v.items);
  }
  function recFlush(cleared) {
    clearTimeout(recTimer); recTimer = null;
    const v = readJSON(REC_STORE);
    if (cleared) rec.gen = Math.max(rec.gen, v.gen || 0) + 1; else adoptRec(v);
    writeJSON(REC_STORE, rec);
    paintRec();
  }
  const recSave = () => { if (!recTimer) recTimer = setTimeout(recFlush, 400); };
  window.addEventListener('pagehide', () => { if (recTimer) recFlush(); });
  // В адресе остаются только служебные слова (conversations, unread-count, v1); всё с цифрами,
  // заглавными буквами и прочим (id, ники, токены) заменяется на {id}.
  const tmplPath = (p) => String(p).split('/').map((seg) => (!seg || /^[a-z]+(?:[-_][a-z]+)*$/.test(seg) || /^v\d+$/.test(seg) ? seg : '{id}')).join('/');
  const pageTag = () => tmplPath('/' + (location.pathname.split('/')[1] || ''));
  const ENUMISH = /^(status|type|kind|state|role|visibility|sort|event|gender|reaction|action|direction|friendship_status)$/i;
  const SAFE_QUERY = /^(sort|type|order|filter|tab|gender|online|status|scope|kind|direction|with|include|exclude_\w+|is_\w+)$/i;
  function shape(v, depth, key) {
    depth = depth || 0;
    if (v === null) return 'null';
    if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1, key)] : [];
    switch (typeof v) {
      case 'string': return ENUMISH.test(key || '') && /^[a-z_.:-]{1,32}$/.test(v) ? `=${v}` : 'str';
      case 'number': return 'num';
      case 'boolean': return 'bool';
      case 'object': {
        if (depth >= 5) return '{…}';
        const o = {};
        let idKey = false;
        for (const k of Object.keys(v).slice(0, 50)) {
          if (/^\d+$/.test(k)) { if (!idKey) { idKey = true; o['{id}'] = shape(v[k], depth + 1, k); } continue; }
          o[k] = shape(v[k], depth + 1, k);
        }
        return o;
      }
      default: return typeof v;
    }
  }
  function bodyShape(b) {
    if (b == null) return undefined;
    if (typeof b === 'string') { try { return shape(JSON.parse(b)); } catch (_) { return 'text'; } }
    if (typeof FormData !== 'undefined' && b instanceof FormData) { const o = {}; b.forEach((v, k) => { o[k] = typeof v === 'string' ? 'str' : 'file'; }); return o; }
    if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) { const o = {}; b.forEach((v, k) => { o[k] = 'str'; }); return o; }
    return Object.prototype.toString.call(b).slice(8, -1);
  }
  const isSite = (u) => {
    try { const x = new URL(String(u), location.href); return x.origin === API_ORIGIN || x.hostname === location.hostname || /(^|\.)gtaw\.io$/.test(x.hostname); }
    catch (_) { return false; }
  };
  function recAdd(method, url, fill) {
    if (!rec.on) return;
    try {
      const u = new URL(String(url), location.href);
      const where = method === 'WS' ? u.host + tmplPath(u.pathname) : (u.origin === API_ORIGIN ? '' : u.host) + tmplPath(u.pathname);
      const key = `${method} ${where}`;
      let it = rec.items[key];
      if (!it) { if (Object.keys(rec.items).length >= REC_CAP) return; it = rec.items[key] = { n: 0 }; }
      it.n++;
      u.searchParams.forEach((v, k) => {
        it.q = it.q || {};
        it.q[k] = /^\d+$/.test(v) ? '{n}' : (SAFE_QUERY.test(k) && /^[a-z_.-]{1,24}$/.test(v) ? v : 'str');
      });
      it.page = pageTag();
      fill(it);
      recSave();
    } catch (_) { /* запись не должна ломать сайт */ }
  }
  function recHttp(method, url, req, status, text) {
    let js;
    try { js = JSON.parse(text); } catch (_) { js = undefined; }
    if (js === undefined && method === 'GET') return;                    // статика и HTML не интересны
    recAdd(method, url, (it) => {
      it.st = Array.from(new Set([...(it.st || []), status])).slice(-5);
      if (req !== undefined) it.req = req;
      if (js !== undefined) it.res = shape(js);
    });
  }
  function recWs(url, dir, data) {
    if (!rec.on) return;
    let ev = null, ch = '', payload;
    if (typeof data === 'string') {
      try {
        const j = JSON.parse(data);
        ev = j.event || j.type || null;
        ch = String(j.channel || (j.data && j.data.channel) || '').replace(/\d+/g, '{id}');
        payload = typeof j.data === 'string' ? JSON.parse(j.data) : j.data;
      } catch (_) {}
    }
    recAdd('WS', url, (it) => {
      if (!ev) return;
      it.ev = it.ev || {};
      const k = `${dir} ${String(ev).slice(0, 80)}${ch ? ' @' + ch : ''}`;
      if (!(k in it.ev) && Object.keys(it.ev).length < 40) it.ev[k] = payload === undefined ? null : shape(payload);
    });
  }
  function recText() {
    const keys = Object.keys(rec.items);
    const out = [`Facebrowser Helper ${VERSION}: запись запросов сайта (${keys.length}). Значения скрыты, видны только поля и типы.`];
    for (const k of keys) {
      const it = rec.items[k];
      const q = it.q ? ' ?' + Object.entries(it.q).map(([a, b]) => `${a}=${b}`).join('&') : '';
      out.push(`${k}${q}  [${(it.st || []).join(',')}] ×${it.n}  стр. ${it.page || '?'}`);
      if (it.req !== undefined) out.push('  req: ' + JSON.stringify(it.req));
      if (it.res !== undefined) out.push('  res: ' + JSON.stringify(it.res).slice(0, 2000));
      for (const [e, s] of Object.entries(it.ev || {})) out.push(`  ${e}${s ? ' ' + JSON.stringify(s).slice(0, 800) : ''}`);
    }
    return out.join('\n');
  }

  // ------------------------------------------------------------------ перехват запросов сайта
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
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__gtawApi = isApi(u);
    this.__gtawReq = [String(m || 'GET').toUpperCase(), u];
    return xhrOpen.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (n, v) { if (this.__gtawApi) take(n, v); return xhrSet.call(this, n, v); };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (rec.on && this.__gtawReq && isSite(this.__gtawReq[1])) {
        const [m, u] = this.__gtawReq, req = bodyShape(body);
        this.addEventListener('loadend', () => {
          try {
            const rt = this.responseType;
            const t = rt === '' || rt === 'text' ? this.responseText : (rt === 'json' ? JSON.stringify(this.response) : '');
            recHttp(m, u, req, this.status, t);
          } catch (_) {}
        });
      }
    } catch (_) {}
    return xhrSend.call(this, body);
  };
  window.fetch = function (input, init) {
    let url, method = 'GET';
    try {
      url = typeof input === 'string' ? input : (input && (input.url || input.href));   // Request или URL
      method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (isApi(url)) {
        if (typeof Request !== 'undefined' && input instanceof Request) input.headers.forEach((v, n) => take(n, v));
        if (init && init.headers) new Headers(init.headers).forEach((v, n) => take(n, v));
      }
    } catch (_) { /* перехват не должен ломать сайт */ }
    const p = origFetch(input, init);
    try {
      if (rec.on && isSite(url)) {
        const req = bodyShape(init && init.body);
        p.then((res) => {
          try {
            if (!/json/i.test(res.headers.get('content-type') || '') && method === 'GET') return;   // не держим потоки и файлы
            res.clone().text().then((t) => recHttp(method, url, req, res.status, t), () => {});
          } catch (_) {}
        }, () => {});
      }
    } catch (_) {}
    return p;
  };
  // WebSocket сайт открывает при загрузке, поэтому его оборачиваем, только если запись была включена до неё.
  if (rec.on && typeof window.WebSocket === 'function') {
    try {
      const OrigWS = window.WebSocket;
      wsHooked = true;
      window.WebSocket = class extends OrigWS {
        constructor(url, protocols) {
          super(url, protocols);
          try { recWs(url, 'open', null); this.addEventListener('message', (e) => recWs(url, 'in', e.data)); } catch (_) {}
        }
        send(data) { try { recWs(this.url, 'out', data); } catch (_) {} return super.send(data); }
      };
    } catch (_) {}
  }

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
      else if (label) setWait(`${label} через ${fmtLeft(left)}`);
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
    if (!p.hist) p.hist = {};
    const t = today();
    if (!p.date || t > p.date) {            // только вперёд: если дата ушла назад (смена пояса), день не сбрасываем
      if (p.date && (p.likes || p.friends)) { p.hist[p.date] = maxPair(p.hist[p.date], [p.likes, p.friends]); p.hist = pruneHist(p.hist); }
      p.date = t; p.likes = 0; p.friends = 0;
    }
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
    state.log = logs.slice(-60); save('log');
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
          throw new Stop(`Сайт не ответил за ${REQUEST_TIMEOUT} с` + (method === 'GET' ? '.' : ': неизвестно, прошло ли последнее действие.'), method === 'GET');
        }
        throw new Stop('Нет связи с сайтом: ' + (e && e.message), method === 'GET');   // POST мог дойти: не повторяем
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
    const target = Math.max(want * 3, 20);
    const maxPages = Math.min(60, Math.max(6, Math.ceil(target / PAGE) + 2));   // большой план: листаем дальше
    const pool = [], ids = new Set();
    let skippedSent = 0;
    for (let i = 0; i < maxPages && pool.length < target; i++) {
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

  // Один проход: заявки, потом лайки. Возвращает ошибку, на которой остановился, или null.
  async function session(pid, opts, dry) {
    run = { pid, opts, dry, seen: new Set(), next: 0, ignore: parseIgnore(opts.ignore), stats: { likes: 0, friends: 0 } };
    refusals = 0;
    log(`${dry ? 'DRY-RUN: ничего не отправляется. ' : ''}Старт для персонажа ${pid}`);
    let err = null;
    try {
      const r = await api('GET', '/notifications/unread-count');
      if (!ok(r.status)) throw new Stop(`Проверка сессии: HTTP ${r.status}`);
      if (opts.friends > 0) await doFriends();
      if (opts.likes > 0) { if (opts.friends > 0) await gap(); await doLikes(); }
      log('Готово.');
    } catch (e) {
      err = e;
      log(e instanceof Stop ? `СТОП: ${e.message}` : `Ошибка: ${e.message}`);
    }
    if (!dry) log(`Итог запуска: лайков ${run.stats.likes}, заявок ${run.stats.friends}.`);
    run = null; setPhase(''); refreshCounters();
    return err;
  }

  // ---- авторежим: повторять проходы, пока не нажат «Стоп»
  const inHours = (t, from, to) => {
    if (from === to || (from <= 0 && to >= 24)) return true;
    const d = new Date(t), h = d.getHours() + d.getMinutes() / 60;
    return from < to ? h >= from && h < to : h >= from || h < to;
  };
  function nextWindowStart(t, from, to) {
    if (inHours(t, from, to)) return t;
    const s = new Date(t);
    s.setHours(from, 0, 0, 0);
    if (s.getTime() <= t) s.setDate(s.getDate() + 1);
    return s.getTime();
  }
  const nextMidnight = () => { const d = new Date(); d.setHours(24, 1, 0, 0); return d.getTime(); };
  const exhausted = (pid, o) => {
    const d = day(pid);
    return (o.likes <= 0 || d.likes >= o.dailyLikes) && (o.friends <= 0 || d.friends >= o.dailyFriends);
  };
  const hoursLabel = (o) => (o.hourFrom === o.hourTo || (o.hourFrom <= 0 && o.hourTo >= 24) ? '' : `, только с ${o.hourFrom}:00 до ${o.hourTo}:00`);

  function notify(msg) {
    try {
      if (activeOpts && activeOpts.notify && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Facebrowser Helper', { body: msg });
      }
    } catch (_) {}
  }

  let autoCancel = false;   // галочку авторежима сняли во время работы: новых запусков не будет
  function cancelAuto(where) {
    autoCancel = true;
    writeAuto(Object.assign(readAuto(), { on: false, cancel: false }));   // сразу: перезагрузка не должна его вернуть
    if (!run) requestStop(AUTO_OFF);
    if (ui) { ui.auto.checked = false; paintStart(); }
    log(`Авторежим выключен${where ? ' ' + where : ''}: новых запусков не будет${run ? ', текущий доведу до конца' : ''}.`);
  }
  async function autoLoop(pid, opts, resumeAt) {
    log(`Авторежим: повтор каждые ${opts.autoMin}–${opts.autoMax} мин${hoursLabel(opts)}. Выключить: «Стоп».`);
    let next = resumeAt || Date.now(), netFails = 0;
    try {
      for (;;) {
        // от текущего времени: после сна компьютера или старой отметки не запускаемся вне рабочих часов
        if (autoCancel) break;
        opts = activeOpts || opts;               // правки настроек в этой вкладке действуют со следующего запуска
        next = nextWindowStart(Math.max(next, Date.now()), opts.hourFrom, opts.hourTo);
        writeAuto({ on: true, pid, next, opts });
        if (next > Date.now()) {
          setPhase('Авторежим');
          await sleep(next - Date.now(), `запуск в ${hhmm(next)},`);
        }
        if (stopWhy) {
          if (stopWhy !== USER_STOP && stopWhy !== AUTO_OFF) { log(`СТОП: ${stopWhy}`); notify(`Авторежим остановлен: ${stopWhy}`); }
          break;
        }
        if (autoCancel) break;
        if (!inHours(Date.now(), opts.hourFrom, opts.hourTo)) continue;
        const err = await session(pid, opts, false);
        if (err && err instanceof Stop && err.transient && !stopWhy && !autoCancel && ++netFails <= NET_RETRIES) {
          next = Date.now() + NET_RETRY_MIN * AUTO_UNIT;
          log(`Авторежим: нет связи, попробую снова ${hhmm(next)} (попытка ${netFails} из ${NET_RETRIES}).`);
          continue;
        }
        if (err) {
          if (!(err instanceof Stop && (err.message === USER_STOP || err.message === AUTO_OFF))) notify(`Авторежим остановлен: ${err.message}`);
          break;
        }
        netFails = 0;
        if (autoCancel) break;
        if (exhausted(pid, opts)) {
          next = nextMidnight();
          log(`Дневные лимиты выбраны. Следующий запуск ${hhmm(nextWindowStart(next, opts.hourFrom, opts.hourTo))}.`);
        } else {
          next = Date.now() + rand(opts.autoMin, opts.autoMax) * AUTO_UNIT;
          log(`Следующий запуск ${hhmm(nextWindowStart(next, opts.hourFrom, opts.hourTo))}.`);
        }
      }
    } finally {
      writeAuto({ on: false });
      log('Авторежим выключен.');
    }
  }

  async function start(opts, dry, resumeAt) {
    if (busy) return;
    if (!cap.profileId) { log('Персонаж не определён: открой любую страницу сайта (например «Друзья»).'); return; }
    busy = true; activePid = cap.profileId; activeOpts = opts; stopWhy = ''; autoCancel = false; setRunning(true);
    const auto = !!opts.auto && !dry;
    try {
      const got = await exclusive(() => (auto ? autoLoop(activePid, opts, resumeAt) : session(activePid, opts, dry)));
      if (!got) log('Уже идёт запуск в другой вкладке сайта: дождись его конца или останови там.');
    } finally {
      busy = false; activePid = null; activeOpts = null; run = null; stopWhy = ''; autoCancel = false;
      setRunning(false); setPhase(''); setWait('');
      adoptSettings(true);        // панель снова показывает сохранённые настройки (их могли поменять в другой вкладке)
      refreshCounters();
    }
  }

  const lockHeld = async () => {
    try { return !!(navigator.locks && navigator.locks.query && (await navigator.locks.query()).held.some((l) => l.name === LOCK)); }
    catch (_) { return false; }
  };

  // После перезагрузки страницы авторежим продолжает с того же места и с теми же настройками,
  // если его не выключали «Стопом» или галочкой.
  const resumeTried = new Set();
  async function maybeResume() {
    const pid = cap.profileId;
    if (busy || !ui || !pid || resumeTried.has(pid)) return;
    resumeTried.add(pid);
    const a = readAuto();
    if (!a.on || a.cancel || String(a.pid) !== pid) return;
    if (await lockHeld() || busy) return;
    const opts = Object.assign({}, DEFAULTS, a.opts || state.settings, { auto: true });
    ui.dry.checked = false; fillInputs(opts); ui.autoBox.open = true; paintStart();   // панель показывает то, что реально идёт
    log('Авторежим: продолжаю после перезагрузки страницы.');
    start(opts, false, a.next);
  }

  // ------------------------------------------------------------------ панель
  const CSS = `
    :host{all:initial}
    .box{position:fixed;right:12px;bottom:12px;z-index:2147483647;width:300px;max-height:calc(100vh - 24px);overflow:auto;
      font:12px/1.4 system-ui,sans-serif;color:#e8e8ee;background:#1b1d26f2;border:1px solid #3a3d4d;border-radius:10px;box-shadow:0 6px 24px #0008}
    .hd{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;cursor:grab;font-weight:600;user-select:none;touch-action:none}
    .bd{padding:0 10px 10px;display:grid;gap:8px}
    .bd.off{display:none}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    label{display:grid;gap:2px;color:#aab}
    label.ck{display:flex;gap:6px;align-items:center;color:#e8e8ee}
    input[type=number],select,textarea{width:100%;box-sizing:border-box;background:#11131a;color:#fff;border:1px solid #3a3d4d;border-radius:6px;padding:4px 6px;font:inherit}
    textarea{resize:vertical;min-height:30px}
    details{border:1px solid #3a3d4d;border-radius:6px;padding:4px 6px}
    details[open]{display:grid;gap:6px;padding-bottom:6px}
    summary{cursor:pointer;color:#cfd0dc}
    button{border:0;border-radius:6px;padding:7px 10px;font-weight:600;cursor:pointer;color:#fff}
    #start{background:#2f7d4f}#start.dry{background:#35608f}#start.auto{background:#7a5a1e}#stop{background:#a3413b}.sm{background:#3a3d4d}
    button:disabled{opacity:.45;cursor:default}
    .btns{display:flex;gap:6px}.btns button{flex:1}.btns button.sm{flex:0 0 auto}
    .st{color:#aab}.warn{color:#f0b35a}.stl{color:#9fd3a8}.stl:empty{display:none}
    pre{margin:0;max-height:150px;overflow:auto;white-space:pre-wrap;background:#11131a;border-radius:6px;padding:6px;font:11px/1.35 ui-monospace,monospace}
  `;
  const HTML = `
    <div class="box" id="box">
      <div class="hd" id="hd" title="Щелчок: свернуть. Перетаскивание: переместить. Двойной щелчок: вернуть в угол."><span>Facebrowser Helper</span><span id="tg">▾</span></div>
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
        <details id="autoBox"><summary>Авторежим</summary>
          <label class="ck"><input id="auto" type="checkbox"> Повторять запуски, пока не нажат «Стоп»</label>
          <div class="row">
            <label>Повтор от, мин<input id="aMin" type="number" min="0"></label>
            <label>Повтор до, мин<input id="aMax" type="number" min="0"></label>
            <label>Работать с, ч<input id="hFrom" type="number" min="0" max="23"></label>
            <label>до, ч<input id="hTo" type="number" min="0" max="24"></label>
          </div>
          <label class="ck"><input id="notify" type="checkbox"> Уведомить, если авторежим остановился</label>
        </details>
        <div class="btns"><button id="start">Старт</button><button id="stop" disabled>Стоп</button><button id="copy" class="sm" title="Скопировать лог">Лог</button><button id="clear" class="sm" title="Очистить лог">✕</button></div>
        <pre id="log"></pre>
        <details id="histBox"><summary>История за ${HIST_DAYS} дн.</summary><pre id="hist"></pre></details>
        <details id="svcBox"><summary>Запись запросов сайта</summary>
          <label class="ck"><input id="rec" type="checkbox"> Записывать (для настройки автоответов)</label>
          <div class="st" id="recInfo"></div>
          <div class="btns"><button id="recCopy" class="sm">Копировать запись</button><button id="recClear" class="sm">Очистить</button></div>
        </details>
      </div>
    </div>`;
  const DEFAULTS = { likes: 15, friends: 5, dailyLikes: 60, dailyFriends: 25, minDelay: 15, maxDelay: 45, maxPending: 200,
    reaction: 'like', warmup: false, onlineOnly: true, ignore: '',
    auto: false, autoMin: 30, autoMax: 60, hourFrom: 0, hourTo: 24, notify: false };

  function readOpts() {
    const s = Object.assign({}, DEFAULTS, state.settings);
    const minDelay = num(ui.dMin.value, s.minDelay, MIN_DELAY_FLOOR, 600);
    const autoMin = num(ui.aMin.value, s.autoMin, AUTO_FLOOR, 1440);
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
      auto: ui.auto.checked,
      autoMin, autoMax: Math.max(autoMin, num(ui.aMax.value, s.autoMax, AUTO_FLOOR, 1440)),
      hourFrom: num(ui.hFrom.value, s.hourFrom, 0, 23), hourTo: num(ui.hTo.value, s.hourTo, 0, 24),
      notify: ui.notify.checked,
    };
  }
  // показываем в полях то, что реально будет использовано (после ограничений)
  function fillInputs(s) {
    ui.likes.value = s.likes; ui.friends.value = s.friends; ui.dLikes.value = s.dailyLikes; ui.dFriends.value = s.dailyFriends;
    ui.dMin.value = s.minDelay; ui.dMax.value = s.maxDelay; ui.maxPend.value = s.maxPending;
    ui.react.value = s.reaction; ui.warm.checked = !!s.warmup; ui.online.checked = !!s.onlineOnly; ui.ignore.value = s.ignore || '';
    ui.auto.checked = !!s.auto; ui.aMin.value = s.autoMin; ui.aMax.value = s.autoMax;
    ui.hFrom.value = s.hourFrom; ui.hTo.value = s.hourTo; ui.notify.checked = !!s.notify;
  }

  function paintHist() {
    if (!ui || !cap.profileId) { if (ui) ui.hist.textContent = ''; return; }
    const d = day(cap.profileId);
    const rows = [[d.date, d.likes, d.friends], ...Object.keys(d.hist).sort().reverse().map((k) => [k, d.hist[k][0], d.hist[k][1]])];
    let tl = 0, tf = 0;
    const lines = rows.map(([k, l, f]) => { tl += l; tf += f; return `${k.slice(8, 10)}.${k.slice(5, 7)}  лайки ${String(l).padStart(4)}  заявки ${String(f).padStart(4)}`; });
    lines.push(`всего  лайки ${String(tl).padStart(4)}  заявки ${String(tf).padStart(4)}`);
    ui.hist.textContent = lines.join('\n');
  }
  function paintRec() {
    if (!ui) return;
    const n = Object.keys(rec.items).length;
    ui.rec.checked = rec.on;
    ui.recInfo.textContent = rec.on
      ? (wsHooked ? `Идёт запись: ${n} запросов. Открой чат, напиши сообщение, дождись ответа, потом «Копировать запись».`
        : `Идёт запись: ${n} запросов. Обнови эту вкладку, чтобы записывался и чат в реальном времени.`)
      : (n ? `Записано запросов: ${n}.` : 'Включи, обнови страницу, открой чат и отправь сообщение.');
  }
  // Настройки, сохранённые другой вкладкой, в эту панель: сразу, а если здесь идёт запуск или поле
  // в фокусе, то позже (конец запуска, уход фокуса, возврат на вкладку).
  function adoptSettings(force) {
    if (!ui || busy) return;
    const host = document.getElementById('gtawbot-host');
    if (!force && host && document.activeElement === host && !document.hidden) return;
    const n = store.read().settings;
    if (!n) return;
    if (force || JSON.stringify(n) !== JSON.stringify(state.settings)) {
      state.settings = n; fillInputs(Object.assign({}, DEFAULTS, n)); paintStart();
    }
  }
  function refreshCounters() {
    if (!ui) return;
    if (!cap.profileId) { ui.cnt.textContent = ''; paintHist(); return; }
    const o = activeOpts || Object.assign({}, DEFAULTS, state.settings);
    const d = day(cap.profileId);
    const pend = lastPending != null ? ` · висит заявок: ${lastPending}` : '';
    ui.cnt.textContent = `Сегодня: лайки ${d.likes}/${o.dailyLikes} · заявки ${d.friends}/${o.dailyFriends}${pend}`;
    paintHist();
  }
  function onProfile() {
    if (busy && cap.profileId !== activePid) requestStop('Сменился активный персонаж: остановлено.');
    else if (!busy) lastPending = null;
    if (!ui) return;
    ui.pid.textContent = `Персонаж: ${cap.profileId} (определён автоматически)`;
    ui.pid.className = 'st';
    setRunning(busy);
    refreshCounters();
    maybeResume();
  }
  function setRunning(on) {
    if (!ui) return;
    ui.start.disabled = on || !cap.profileId; ui.stop.disabled = !on;
  }
  function paintStart() {
    const dry = ui.dry.checked, auto = !dry && ui.auto.checked;
    ui.start.textContent = dry ? 'Пробный прогон' : (auto ? 'Старт авторежима' : 'Старт');
    ui.start.classList.toggle('dry', dry);
    ui.start.classList.toggle('auto', auto);
  }
  // панель можно перетащить за заголовок; позиция запоминается
  function placeBox() {
    if (!ui) return;
    const s = ui.box.style;
    if (!state.pos) { s.left = s.top = s.right = s.bottom = ''; return; }
    const w = ui.box.offsetWidth, h = ui.box.offsetHeight;
    const vw = document.documentElement.clientWidth || window.innerWidth;     // без полосы прокрутки
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const x = Math.min(Math.max(0, state.pos.x), Math.max(0, vw - w));
    const y = Math.min(Math.max(0, state.pos.y), Math.max(0, vh - h));
    Object.assign(s, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
  }
  function toggleCollapse() {
    state.collapsed = !state.collapsed; save('collapsed');
    ui.bd.classList.toggle('off', state.collapsed); ui.tg.textContent = state.collapsed ? '▸' : '▾';
    placeBox();
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
    ['box', 'hd', 'bd', 'tg', 'autoBox', 'pid', 'cnt', 'status', 'likes', 'friends', 'dLikes', 'dFriends', 'dMin', 'dMax', 'maxPend', 'react',
      'ignore', 'dry', 'warm', 'online', 'auto', 'aMin', 'aMax', 'hFrom', 'hTo', 'notify', 'start', 'stop', 'copy', 'clear',
      'log', 'hist', 'rec', 'recInfo', 'recCopy', 'recClear'].forEach((id) => { ui[id] = $(id); });
    fillInputs(Object.assign({}, DEFAULTS, state.settings));
    if (ui.auto.checked) ui.autoBox.open = true;
    paintStart();
    ui.bd.classList.toggle('off', !!state.collapsed); ui.tg.textContent = state.collapsed ? '▸' : '▾';
    ui.pid.textContent = 'Персонаж не определён: открой любую страницу сайта (например «Друзья»).';
    ui.pid.className = 'st warn'; ui.start.disabled = true;

    let drag = null;
    let downs = [0, 0];   // время двух последних нажатий на заголовок
    ui.hd.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      downs = [downs[1], Date.now()];
      const r = ui.box.getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, x: r.left, y: r.top, moved: false };
      try { ui.hd.setPointerCapture(e.pointerId); } catch (_) {}
    });
    ui.hd.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true; state.pos = { x: drag.x + dx, y: drag.y + dy }; placeBox();
    });
    let toggleT = null, toggledAt = 0;   // щелчок сворачивает с задержкой, чтобы двойной щелчок не дёргал панель
    ui.hd.addEventListener('pointerup', () => {
      if (!drag) return;
      const moved = drag.moved; drag = null;
      if (moved) { save('pos'); return; }
      if (toggleT) { clearTimeout(toggleT); toggleT = null; return; }
      toggleT = setTimeout(() => { toggleT = null; toggledAt = Date.now(); toggleCollapse(); }, 250);
    });
    ui.hd.addEventListener('pointercancel', () => { drag = null; });
    ui.hd.addEventListener('dblclick', () => {
      clearTimeout(toggleT); toggleT = null;
      if (toggledAt > downs[0]) toggleCollapse();                  // медленный двойной щелчок: первый щелчок уже свернул
      state.pos = null; save('pos'); placeBox();
    });
    window.addEventListener('resize', placeBox);
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (state.pos) placeBox(); }).observe(ui.box);

    const persist = (e) => {
      state.settings = readOpts(); save('settings'); fillInputs(state.settings); refreshCounters(); paintStart();
      if (busy && activeOpts && activeOpts.auto && !autoCancel && !(e && e.target === ui.auto)) {
        activeOpts = Object.assign({}, state.settings, { auto: true });
        const a = readAuto();
        if (a.on) writeAuto(Object.assign(a, { opts: activeOpts }));
        log('Новые настройки применятся со следующего запуска авторежима.');
      }
    };
    host.addEventListener('focusout', () => setTimeout(() => adoptSettings(false), 0));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) adoptSettings(false); });
    [ui.likes, ui.friends, ui.dLikes, ui.dFriends, ui.dMin, ui.dMax, ui.maxPend, ui.react, ui.ignore, ui.warm, ui.online,
      ui.auto, ui.aMin, ui.aMax, ui.hFrom, ui.hTo, ui.notify].forEach((el) => el.addEventListener('change', persist));
    ui.dry.addEventListener('change', paintStart);
    ui.notify.addEventListener('change', async () => {
      if (!ui.notify.checked) return;
      let perm = 'denied';
      try { perm = Notification.permission; if (perm === 'default') perm = await Notification.requestPermission(); } catch (_) {}
      if (perm !== 'granted') {
        ui.notify.checked = false; persist();
        log('Браузер запретил уведомления для этого сайта: разреши их в настройках сайта (значок замка у адреса).');
      }
    });
    ui.auto.addEventListener('change', async () => {
      if (busy) {
        if (!activeOpts || !activeOpts.auto) return;
        if (!ui.auto.checked) { if (!autoCancel) cancelAuto(''); return; }
        if (autoCancel && !stopWhy) { autoCancel = false; writeAuto(Object.assign(readAuto(), { on: true })); log('Авторежим снова включён.'); }
        return;
      }
      if (ui.auto.checked || !readAuto().on) return;
      if (await lockHeld()) {                 // идёт в другой вкладке: просим её остановиться
        writeAuto(Object.assign(readAuto(), { cancel: true }));
        log('Авторежим идёт в другой вкладке: попросил её больше не запускать.');
        return;
      }
      writeAuto({ on: false });
      log('Авторежим отменён: после перезагрузки не продолжится.');
    });
    ui.start.addEventListener('click', () => {
      const o = readOpts(); state.settings = o; save('settings'); fillInputs(o);
      start(o, ui.dry.checked);
    });
    ui.stop.addEventListener('click', () => { if (!busy) return; requestStop(USER_STOP); log('Останавливаю…'); });
    ui.copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(logs.join('\n')); log('Лог скопирован в буфер.'); } catch (_) { log('Не удалось скопировать лог.'); }
    });
    ui.clear.addEventListener('click', () => { logs.length = 0; state.log = []; save('log'); paintLog(); });
    ui.rec.addEventListener('change', () => {
      rec.on = ui.rec.checked; recFlush();             // сразу: обычно следом обновляют страницу
      log(rec.on ? 'Запись запросов включена. Обнови страницу, чтобы записался и чат в реальном времени.' : 'Запись запросов выключена.');
    });
    ui.recCopy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(recText()); log('Запись скопирована в буфер: пришли её разработчику.'); } catch (_) { log('Не удалось скопировать запись.'); }
    });
    ui.recClear.addEventListener('click', () => { rec.items = {}; recFlush(true); });
    paintLog(); paintStatus(); paintRec();
    placeBox();                                                     // после заполнения: высота уже настоящая
    if (cap.profileId) onProfile();
  }

  // счётчики, изменённые в другой вкладке, сразу видны и здесь
  window.addEventListener('storage', (e) => {
    if (e.key === REC_STORE) {                     // запись выключили или очистили в другой вкладке
      const v = (() => { try { return JSON.parse(e.newValue) || {}; } catch (_) { return {}; } })();
      rec.on = !!v.on; adoptRec(v);
      // другая вкладка записала поверх наших несохранённых запросов: дописываем их (вкладки быстро сходятся)
      if ((v.gen || 0) === rec.gen && Object.keys(rec.items).some((k) => !(v.items && k in v.items))) recSave();
      paintRec();
      return;
    }
    if (e.key === AUTO_STORE) {                    // авторежим этой вкладки выключили в другой
      const v = (() => { try { return JSON.parse(e.newValue) || {}; } catch (_) { return {}; } })();
      if (v.cancel && busy && activeOpts && activeOpts.auto && !autoCancel) cancelAuto('в другой вкладке');
      return;
    }
    if (e.key !== STORE) return;
    let n = {};
    try { n = JSON.parse(e.newValue) || {}; } catch (_) {}
    state.profiles = mergeProfiles(state.profiles, n.profiles);
    if (ui) {
      if (!!n.collapsed !== !!state.collapsed) { state.collapsed = !!n.collapsed; ui.bd.classList.toggle('off', state.collapsed); ui.tg.textContent = state.collapsed ? '▸' : '▾'; }
      if (JSON.stringify(n.pos || null) !== JSON.stringify(state.pos || null)) state.pos = n.pos || null;
      adoptSettings(false);
      placeBox();
    }
    refreshCounters();
  });

  if (TEST) window.__gtawInternals = { inHours, nextWindowStart, mergeProfiles, shape, tmplPath, recText, rec: () => rec };   // только для автотестов

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
