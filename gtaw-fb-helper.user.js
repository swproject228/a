// ==UserScript==
// @name         Facebrowser Helper (GTA World)
// @namespace    gtaw-fb-helper
// @version      1.4.0
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

  const VERSION = '1.4.0';
  const API = window.__GTAWBOT_API__ || 'https://fbv2-api.gtaw.io';
  const API_ORIGIN = new URL(API).origin;
  const V1 = API + '/api/v1';
  const STORE = 'gtawbot:v1';
  const REC_STORE = 'gtawbot:rec';
  const AUTO_STORE = 'gtawbot:auto';
  const LOCK = 'gtawbot:run';
  const TEST = !!window.__GTAWBOT_TEST__;
  const MIN_DELAY_FLOOR = TEST ? 0 : 5;            // сек, ниже нельзя
  const HARD_MAX = { likes: 1000, friends: 2000 }; // потолок дневных лимитов (поднять можно здесь)
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
  const PEOPLE_PAGES_MAX = 500;                   // глубже 5000 человек в списке «Люди» за запуск не листаем
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

  // Следующая порция кандидатов: листаем список «Люди» с offset, пока не наберём около want × 3 человек.
  // Большой план проходит порциями, поэтому заявки начинают уходить сразу, а не после обхода всего списка.
  async function gatherPeople(want, offset, ids) {
    const PAGE = 10;
    const target = Math.max(want * 3, 20);
    const pages = Math.min(60, Math.max(6, Math.ceil(target / PAGE) + 2));
    const pool = [];
    let skippedSent = 0, end = false;
    for (let i = 0; i < pages && pool.length < target; i++, offset += PAGE) {
      if (offset >= PEOPLE_PAGES_MAX * PAGE) { end = true; break; }
      if (i) await gap();
      const q = new URLSearchParams({ limit: PAGE, offset, gender: 'all', exclude_friends: 'true',
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
      if (people.length < PAGE || (Number.isFinite(total) && offset + PAGE >= total)) { end = true; offset += PAGE; break; }
    }
    if (skippedSent) log(`  пропущено ${skippedSent}: заявка им уже уходила за последние ${RESEND_DAYS} дн.`);
    // сначала онлайн и самые активные: у них выше шанс ответа
    pool.sort((a, b) => (Number(!!b.is_online) - Number(!!a.is_online)) ||
      String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || '')));
    return { pool, offset, end };
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
    let done = 0, offset = 0, end = false;
    const ids = new Set();
    while (done < want && !end) {
      await gap();
      setPhase('Заявки: ищу людей');
      const chunk = await gatherPeople(want - done, offset, ids);
      const doneBefore = done;
      end = chunk.end;
      log(`  подходящих кандидатов: ${chunk.pool.length}${end ? '' : ' (дальше ещё будут)'}`);
      for (const p of chunk.pool) {
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
      // сайт убирает из списка тех, кому ушла заявка, и список сдвигается: отступаем на столько же (повторы отсеет ids)
      offset = Math.max(0, chunk.offset - (run.dry ? 0 : done - doneBefore));
    }
    if (done < want) log('  подходящие люди в списке закончились');
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

  // ------------------------------------------------------------------ распознавание личных сообщений
  // Что человек написал (приветствие, «как дела», комплимент, зовёт встретиться, грубит, спрашивает «ты бот?»…)
  // и что на это ответить. Работает по словарю фраз прямо в браузере, без внешних сервисов.
  // Бот отвечает только на короткие «светские» сообщения и не больше dmMax раз за переписку. Всё остальное он
  // передаёт тебе: вопрос «ты бот?» (врать нельзя), 18+, признаки несовершеннолетнего, грубость, приглашение
  // встретиться и любое сообщение, в котором есть что-то кроме вежливости.
  const DM_LABEL = { minor: 'несовершеннолетний', sexual: '18+', bot: '«ты бот?»', rude: 'грубость или «не пиши»',
    meet: 'зовёт встретиться', who: 'кто ты / зачем добавил', how: 'как дела', doing: 'чем занят', compliment: 'комплимент',
    meetme: 'знакомство', thanks: 'спасибо', bye: 'прощание', laugh: 'смех', emoji: 'смайлики', greeting: 'приветствие' };
  const DM_STOP = ['minor', 'sexual', 'bot', 'rude'];                         // никогда не отвечаем сами
  const DM_HANDOFF = ['meet'];   // приглашения встретиться часто соседствуют с 18+ и подростками: отвечает только человек
  const DM_ORDER = ['meet', 'who', 'how', 'doing', 'compliment', 'meetme', 'thanks', 'bye', 'laugh', 'emoji', 'greeting'];
  const DM_WORDS = {   // '=' в начале: слово целиком; '~': фраза целиком, без продолжения («как ты?», но не «как ты думаешь»);
                       // иначе начало слова. Повторы букв («приииивет») не важны, регистр тоже.
    minor: ['школьни', 'несовершеннолет', 'учусь в школе', 'в школу хожу', 'в школе', 'после уроков', 'контрольная по', 'с уроков',
      'восьмом клас', 'девятом клас', 'десятом клас', 'одинадцатом клас', 'мне тринадцать', 'мне четырнадцать', 'мне пятнадцать',
      'мне шестнадцать', 'мне семнадцать', 'underage', 'high school', 'middle school', 'junior year', 'sophomore year', 'schoolgirl',
      'schoolboy', 'school tomorrow', 'after school', 'homeroom', 'my teacher', 'sophomore', 'freshman in', '=hs', 'in hs', 'klas',
      'urok', 'на уроке', 'уроки', 'мама не разрешает', 'родители не разрешают', 'my mom checks', 'my mom says', "my mom doesn't know",
      'my mom doesnt know', 'my parents', 'grounded', "i'm thirteen", "i'm fourteen", "i'm fifteen", "i'm sixteen",
      "i'm seventeen", 'im fifteen', 'im sixteen', 'im seventeen'],
    sexual: ['секс', 'интим', 'нюдс', 'обнаж', 'разденеш', 'разденься', 'раздевайся', 'раздеться', 'вирт', 'трах', 'переспим', 'переспать',
      'минет', 'пошлост', 'голая', 'голую', 'голенькая', 'сиськ', 'без одежды', 'хочу тебя', 'ко мне на ночь', 'sext', 'hook up', 'hookup',
      'undress', 'no clothes', 'without clothes', 'without your clothes', 'without the dress', 'take that shirt off', 'take your clothes',
      'take off your', 'something spicy', 'spicy pic', 'send nude', 'nude pic', 'nude photo', '=nudes', '=sex', 'sexy pic', 'naked',
      'horny', 'fuck me', '=18+', '18+ контент', 'take things off', 'take it off', 'take off', "what's under", 'whats under',
      'what are you wearing', 'what r u wearing', 'what u wearing', 'что на тебе надето', 'private pic', 'private photo', 'for my eyes',
      'just for me', 'night with you', 'how much for', 'сколько за ночь', 'фотки без', 'фото без', 'горячие фото', 'пикантн', 'в постел',
      'in bed with', 'thinking about you in', 'spicy'],
    bot: ['ты бот', 'вы бот', '~это бот', '~бот', 'ботяра', 'автоответ', 'ты робот', 'это робот', 'ты живая', 'ты живой', 'живой человек',
      'ты реальн', 'ты настоящ', 'нейронк', 'нейросет', 'are you a bot', 'r u a bot', 'u a bot', 'you a bot', 'is this a bot', '~bot',
      'automated', 'auto reply', 'auto-reply', 'autoreply', 'real person', 'actual person', '~u real', '~you real', '~are you real',
      'r u real', 'talking to an ai', 'talking to ai', 'talking to a bot', 'are you ai', 'are you an ai', 'is this ai', 'bot or human',
      'human or bot', 'or a bot', 'a script', 'actual human', 'real human', 'a human', 'is this an ai', 'an ai?', 'replies come',
      'reply way too fast', 'replying so fast', 'auto-reply much', 'not automated', 'бот или человек', 'человек или бот', 'скрипт',
      'автоматически отвеча', 'отвечаешь как робот', 'chatgpt', '=gpt'],
    rude: ['иди нах', 'пошел нах', 'пошла нах', 'отвали', 'отстань', 'отъебись', '=дура', '=дурак', 'дебил', 'тупая', 'тупой', '=сука',
      'спамер', 'спамиш', 'спамит', 'хватит спам', 'это спам', '~спам', 'заебал', 'надоел', 'не пиши', 'хватит писать', 'хватит мне писать',
      'отпишись', 'заблокирую', 'в блок', 'в чс', 'zaebal', 'otvali', 'spamit', 'fuck off', 'stop texting', 'stop messaging', 'stop dming',
      'stop spamming', 'this is spam', '~spam', 'spammer', 'leave me alone', '=idiot', '=stupid', 'go away', "don't text", 'dont text',
      "don't dm", 'dont dm', 'dont ever dm', "don't ever dm", 'never text me', 'annoying', 'blocking you', 'blocking u', 'block you',
      'block u', '=reported', 'blowing up my', 'quit blowing', 'nobody wants', '=clown', '=creep', 'get lost', 'nobody asked',
      'not you again', 'отстаньте', 'достал', 'достала', 'задолбал'],
    meet: ['встретимся', 'встретиться', 'давай встрет', 'увидимся', 'погуляем', 'погулять', 'свидани', 'пойдем в', 'пошли в', 'сходим',
      'приезжай', 'приходи', 'в бар', 'в клуб', 'на кофе', 'в кафе', 'в кино', 'в ресторан', 'на ужин', 'заеду за', 'meet up', 'meet me',
      "let's meet", 'lets meet', 'wanna meet', 'want to meet', 'can we meet', 'hang out', 'lets hang', "let's hang", 'hang at',
      'grab a drink', 'grab drinks', 'get drinks', 'go for a drink', 'for a beer', 'grab coffee', 'go out', 'take you out', 'on a date',
      'go on a date', 'come over', 'come down to', 'come by', 'u should come', 'you should come', 'wanna come', 'want to come',
      'come with me', 'pick you up', 'u free', 'are you free', 'you free', 'party at'],
    who: ['мы знакомы', '~ты кто', '~кто ты', '~кто это', 'а вы кто', '~вы кто', 'кто ты такая', 'кто ты такой', 'зачем добавил',
      'зачем ты меня добавил', 'зачем вы добавили', 'почему добавил', 'зачем заявк', 'откуда ты меня', 'who are you', 'who r u',
      'who are u', 'who is this', 'who dis', 'do i know you', 'do i know u', 'do we know', 'know each other', 'know u from', 'know you from',
      "why'd u add", "why'd you add", 'why did you add', 'why did u add', 'why u add', 'why you add', 'why did you send',
      'why did u send', 'friend request'],
    how: ['как дела', '~как ты', '~как сам', '~как сама', 'как ты там', 'как жизнь', 'как поживаешь', 'как настроение', 'как твои дела',
      '~как оно', 'как день', 'как прошел день', 'kak dela', 'how are you', 'how r u', 'how are u', 'how u doing', 'how you doing',
      'how you doin', '=hru', "how's it going", 'hows it going', 'how is it going', "how's ur day", 'hows ur day', "how's your day",
      'hows your day', 'how is your day', 'how was your day', "how's your week", 'hows your week', "how's life", 'how u been',
      'how you been', 'how have you been', '~whats good', "~what's good", "what's up with you", 'whats up with you', 'чё как', 'че как',
      'kak ty', '~whats up',
      "~what's up", 'wassup', 'wazzup', '=sup'],
    doing: ['что делаешь', '~чем занимаешься', 'чем занимаешься сейчас', 'чем занимаешься щас', 'чем занята', 'чем занят', 'че делаешь', 'чо делаешь', 'что делаеш', 'шо делаешь',
      'что поделываешь', '=чд', 'what are you doing', 'what are u doing', 'what you doing', 'what u doing', 'what u doin', 'wat u doin',
      'what r u doing', '=wyd', 'what are you up to', 'what you up to', 'what u up to', 'whatcha up to', 'whatcha doing',
      'whatchu up to', 'whatchu doing', 'chto delaesh', 'cho delaesh', 'чем сейчас занят'],
    compliment: ['красив', 'красотк', 'краса', 'милая', 'милый', 'милаш', 'симпатичн', 'очарователь', 'прекрасн', 'шикарн', 'обалденн',
      'нравишься', 'понравил', 'клевая', 'классная', 'классные фот', 'крутая фот', 'красивые фот', 'лапочк', 'солнышко', 'залип на',
      'улыбк', 'beautiful', '=pretty', '=cute', 'cutie', 'gorgeous', '=hot', 'stunning', '=i like you', 'nice pic', 'nice photo',
      'lovely', 'look good', 'looking good', 'pics are fire', 'pic is fire', 'love your profile', 'love your pic', 'love ur pic',
      'nice pfp', 'pfp is', 'amazing on you'],
    meetme: ['познаком', 'знакомиться', 'кто ты по', 'кем работаешь', 'где работаешь', 'работаешь где', 'по жизни', 'чем занимаешься по',
      'как тебя зовут', 'как зовут', 'как твое имя', 'откуда ты', 'а ты откуда', 'где живешь', 'чем увлекаешься', 'расскажи о себе',
      'сколько тебе', 'тебе сколько', 'get to know', "what's your name", 'whats your name', 'whats ur name', "what's ur name",
      'ur name', 'your name', 'where are you from', 'where r u from', 'where u from', 'where do you live', 'where do u live',
      'where in ls', 'nice to meet', 'tell me about yourself', 'tell me about urself', 'about yourself', 'about urself', 'what do you do',
      'ты откуда', 'о себе', 'учишься или работаешь', 'работаешь или учишься',
      'what do u do', 'for work', 'ur job', 'your job', 'how old', 'what music', 'what kind of music', 'kinda music'],
    thanks: ['спасиб', 'пасиб', '=спс', 'благодар', '=мерси', 'сенкс', 'spasibo', 'thank', '=thx', '=ty', '=tysm', 'appreciate it'],
    bye: ['=пока', 'пока-пока', 'до встречи', 'до завтра', 'до связи', 'спокойной ночи', '=споки', 'сладких снов', 'доброй ночи',
      'всего доброго', 'мне пора', 'спишемся', '=афк', '=бб', '=poka', '=bye', 'goodbye', 'good night', '=gn', 'see you', 'see ya',
      '=cya', '=gtg', 'got to go', 'gotta go', 'gotta run', 'talk later', 'ttyl', '=bb', 'catch u later', 'catch you later', 'im out',
      "i'm out", 'sleep well'],
    laugh: ['ахах', 'хаха', '=хах', 'ахп', 'хпх', '=лол', '=ржу', '=lol', 'lolo', 'lmao', 'lmfao', 'haha', 'hehe', '=xd'],
    greeting: ['привет', 'превет', '=прив', '=приф', 'прифк', 'здравствуй', 'здраствуй', 'здрасьте', 'здрасте', 'здарова', 'дратути', '=хай',
      'хаюшки', 'хелоу', 'хеллоу', 'добрый день', 'добрый вечер', 'доброе утро', 'доброго дня', '=ку', '=куку', '=салют', '=йоу', '=хей',
      'privet', '=hai', '=hi', '=hello', '=hey', 'heya', 'hiya', 'good morning', 'good evening', 'good afternoon', '=yo', 'howdy'],
  };
  const DM_TRANSLIT = /\b(privet|kak dela|spasibo|poka|zdravstv)/;   // пишет по-русски латиницей: отвечаем по-русски
  // Ответы: {мужской|женский} подставляется по полу персонажа; flirt — лёгкий флирт, neutral — без него.
  const DM_REPLIES = {
    ru: {
      greeting: { flirt: ['Привет 😊', 'Приветик 😉', 'Привет-привет 😏', 'Хай) Какими судьбами?', 'Хай 😉', 'Ну привет 😊 Неожиданно, но приятно',
        'Здравствуйте) Какой приятный сюрприз 😊'], neutral: ['Привет 🙂', 'Привет!', 'Здравствуйте 🙂', 'Хай)'] },
      how: { flirt: ['Всё хорошо, а теперь ещё лучше 😉 А у тебя как?', 'Отлично 😊 А у тебя как дела?', 'Неплохо) Рассказывай, как у тебя?'],
        neutral: ['Всё хорошо, спасибо 🙂 А у тебя?', 'Нормально) А у тебя как?'] },
      doing: { flirt: ['Да так, отдыхаю 😊 А ты?', 'Листаю ленту, а тут ты 😉', 'Ничего особенного) А ты что делаешь?'],
        neutral: ['Да так, ничего особенного 🙂 А ты?', 'Отдыхаю) А ты?'] },
      compliment: { flirt: ['Ой, спасибо 😊 Приятно', 'Смущаешь 🙈', 'Спасибо) Мне очень приятно 😉'], neutral: ['Спасибо 🙂', 'Спасибо, приятно)'] },
      meetme: { flirt: ['Давай 😊 Расскажи о себе', 'С удовольствием) С чего начнём? 😉'], neutral: ['Давай 🙂 Расскажи о себе', 'Можно) Расскажи о себе'] },
      who: { flirt: ['Увидел{|а} твой профиль и решил{|а} добавиться 😊', 'Просто понравился твой профиль 😉'],
        neutral: ['Увидел{|а} твой профиль и решил{|а} добавиться 🙂', 'Просто наткнул{ся|ась} на твой профиль)'] },
      thanks: { flirt: ['Пожалуйста 😊', 'Обращайся 😉'], neutral: ['Пожалуйста 🙂', 'Не за что)'] },
      bye: { flirt: ['Пока 😊', 'До встречи 😉', 'Пока-пока 😊'], neutral: ['Пока 🙂', 'До связи)'] },
      byeNight: { flirt: ['Спокойной ночи 🌙', 'Сладких снов 😊'], neutral: ['Спокойной ночи 🙂'] },
      laugh: { flirt: ['😄', '😏', 'Ахах)'], neutral: ['🙂', 'Ахах)'] },
      emoji: { flirt: ['😊', '😉'], neutral: ['🙂'] },
      hello: { flirt: ['Привет)', 'Приветик)', 'Хай)'], neutral: ['Привет!', 'Здравствуйте!'] },
    },
    en: {
      greeting: { flirt: ['Hi 😊', 'Hey there 😉', 'Hey! What brings you here? 😊'], neutral: ['Hi 🙂', 'Hello!'] },
      how: { flirt: ["I'm good, even better now 😉 How about you?", 'Doing great 😊 You?'], neutral: ["I'm fine, thanks 🙂 You?"] },
      doing: { flirt: ['Just chilling 😊 You?', 'Scrolling the feed, and here you are 😉'], neutral: ['Not much 🙂 You?'] },
      compliment: { flirt: ['Aww, thank you 😊', "You're making me blush 🙈"], neutral: ['Thank you 🙂'] },
      meetme: { flirt: ['Sure 😊 Tell me about yourself'], neutral: ['Sure 🙂 Tell me about yourself'] },
      who: { flirt: ['Saw your profile and decided to add you 😊'], neutral: ['Saw your profile and decided to add you 🙂'] },
      thanks: { flirt: ["You're welcome 😊"], neutral: ['No problem 🙂'] },
      bye: { flirt: ['Bye 😊', 'See you 😉'], neutral: ['Bye 🙂'] },
      byeNight: { flirt: ['Good night 🌙'], neutral: ['Good night 🙂'] },
      laugh: { flirt: ['😄', 'Haha)'], neutral: ['🙂'] },
      emoji: { flirt: ['😊', '😉'], neutral: ['🙂'] },
      hello: { flirt: ['Hey)', 'Hi)'], neutral: ['Hi!'] },
    },
  };
  const squeeze = (t) => String(t).toLowerCase().replace(/ё/g, 'е').replace(/(\p{L})\1+/gu, '$1');   // «приииивет» → «привет»
  const DM_RX = {}, DM_STRIP = [];
  for (const [intent, words] of Object.entries(DM_WORDS)) {
    const alts = words.map((w) => {
      const mark = '=~'.includes(w[0]) ? w[0] : '';
      const body = squeeze(mark ? w.slice(1) : w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s,.!-]*');
      return body + (mark === '=' ? '(?![\\p{L}\\p{N}])' : mark === '~' ? '(?![\\p{L}\\p{N}])(?!\\s+[\\p{L}\\p{N}])' : '');
    });
    DM_RX[intent] = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${alts.join('|')})`, 'u');
    DM_STRIP.push(new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${alts.join('|')})[\\p{L}\\p{N}']*`, 'gu'));   // для подсчёта «лишних» слов
  }
  const AGE_MINOR = /(?:^|[^\p{L}\p{N}])(?:мне|mne|я|i'?m|i am|im|i'?ll be|ill be|turning|будет|исполнится)\s*(?:only|всего|только|ещё|еще)?\s*(?:[5-9]|1[0-7])(?![\p{N}]|[.,:]\p{N})(?!\s*(?:мин|час|сек|раз|руб|штук|см|км|кг|\$|min|hour|sec|times|ft|cm|km|kg|mph|[kкh](?![\p{L}])))/u;
  const GRADE = /(?:^|[^\p{L}\p{N}])(?:в\s*)?(?:[5-9]|1[01])\s*(?:-?(?:м|ом|ый|ой))?\s*клас|(?:^|[^\p{L}\p{N}])(?:[5-9]|1[0-2])(?:th|st|nd|rd)?\s*grade/u;
  // слова, которые не делают сообщение «содержательным»: после них бот ещё может ответить шаблоном
  const FILLER = new Set(('а и но ну да ой эй же ли бы вот так уже ещё еще тут там это то ты тебя тебе тобой я мне меня мы вы вас вам у в на с со по за из к '
    + 'о об от до для как что че чо же типа кстати слушай короче вообще просто очень ага угу ок окей хорошо норм ладно сегодня щас сейчас '
    + 'i you u ur your yours me my mine we the a an so and or but btw lol haha ok okay oh hey hi just really too very rn tho ngl fr tbh to '
    + 'of in on at for with is are am be it its this that there here now today tonight again back all how what doing up there babe dear '
    + 'love honey hun do did does add tho'.replace(/ё/g, 'е')).split(' ').map((w) => squeeze(w)));
  const DM_REPLYABLE = ['meet', 'who', 'how', 'doing', 'compliment', 'meetme', 'thanks', 'bye', 'laugh', 'emoji', 'greeting'];

  function dmDetect(text) {
    const raw = String(text || '');
    const t = squeeze(raw);
    const found = new Set();
    for (const [intent, re] of Object.entries(DM_RX)) if (re.test(t)) found.add(intent);
    if (AGE_MINOR.test(t) || GRADE.test(t)) found.add('minor');
    if (/🍆|🍑|💦|👅|😈/u.test(raw)) found.add('sexual');               // такие смайлики почти всегда про 18+
    const bare = raw.replace(/[\s.,!?)(:;*'"-]+/g, '');
    if (!found.size && raw.trim() && !/[\p{L}\p{N}]/u.test(bare)) found.add(/😂|🤣|😆|😹/u.test(raw) ? 'laugh' : 'emoji');
    if (!found.size && /😂|🤣|😆|😹/u.test(raw)) found.add('laugh');
    // что осталось, если убрать распознанные фразы и слова-связки: если много, сообщение про что-то своё
    let rest = t;
    for (const re of DM_STRIP) rest = rest.replace(re, ' ');
    const extra = (rest.match(/[\p{L}\p{N}]{2,}/gu) || []).filter((w) => !FILLER.has(w)).length;
    const link = /https?:|www\.|\.(?:com|ru|net|org|gg)\b/.test(t);
    const stop = DM_STOP.find((k) => found.has(k));
    const reply = DM_ORDER.find((k) => found.has(k));
    // приглашение распознаём и с подробностями («в бар на пирсе завтра»): на него всё равно отвечает только человек
    const main = stop || (reply && extra <= (reply === 'meet' ? 8 : 2) && !link ? reply : 'unknown');
    const cyr = /[а-яё]/i.test(raw);
    const lang = cyr || DM_TRANSLIT.test(t) ? 'ru' : (/[a-z]/i.test(raw) ? 'en' : 'ru');
    return { intents: found, main, extra, lang, question: raw.includes('?') };
  }

  // conv: { n: сколько автоответов уже было, stop: почему переписка передана тебе, used: [ответы] }
  function dmPlan(text, conv, o, now) {
    const d = dmDetect(text);
    const labels = [...d.intents].map((k) => DM_LABEL[k] || k);
    const out = (action, reason, reply) => ({ action, reason, reply: reply || '', intents: labels, lang: d.lang });
    if (conv.stop) return out('skip', `переписка уже у тебя: ${conv.stop}`);
    const stopper = DM_STOP.includes(d.main) ? d.main : null;
    if (stopper) return out('handoff', { minor: 'похоже на несовершеннолетнего: бот не отвечает', sexual: 'откровенное сообщение: бот не отвечает',
      bot: 'спросили, бот ли это: ответь сам, бот не притворяется человеком', rude: 'грубость или просьба не писать: бот замолкает' }[stopper]);
    if (DM_HANDOFF.includes(d.main)) return out('handoff', 'зовут встретиться: ответь сам');
    if (conv.n >= o.dmMax) return out('handoff', `бот уже ответил ${conv.n} раз: дальше переписка твоя`);
    const main = d.main;
    if (main === 'unknown') {
      return out('handoff', d.intents.size ? 'в сообщении есть что-то своё, кроме приветствия или вежливости: ответь сам'
        : (d.question ? 'вопрос без готового ответа: ответь сам' : 'не понял сообщение: ответь сам'));
    }
    if (main === 'greeting' && conv.n > 0) return out('skip', 'уже здоровались');
    const tone = o.dmTone === 'neutral' ? 'neutral' : 'flirt';
    const L = DM_REPLIES[d.lang] || DM_REPLIES.ru;
    const night = new Date(now || Date.now()).getHours() >= 22 || new Date(now || Date.now()).getHours() < 5;
    const pool = (L[main === 'bye' && night ? 'byeNight' : main] || L.greeting)[tone];
    const used = conv.used || [];
    const fresh = pool.filter((x) => !used.includes(x));
    let reply = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length ? fresh : pool).length)];
    if (main !== 'greeting' && d.intents.has('greeting') && conv.n === 0 && !['laugh', 'emoji', 'bye'].includes(main)) {
      const hello = L.hello[tone];
      reply = hello[Math.floor(Math.random() * hello.length)] + ' ' + reply;
    }
    reply = reply.replace(/\{([^|{}]*)\|([^|{}]*)\}/g, (_, m, f) => (o.dmGender === 'm' ? m : f));
    return out('reply', '', reply);
  }
  function dmCommit(conv, plan) {
    if (plan.action === 'reply' || plan.action === 'reply-handoff') { conv.n = (conv.n || 0) + 1; conv.used = [...(conv.used || []), plan.reply].slice(-6); }
    if (plan.action === 'handoff' || plan.action === 'reply-handoff') conv.stop = plan.reason;
    return conv;
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
        <details id="dmBox"><summary>Автоответы в ЛС</summary>
          <label class="ck"><input id="dmOn" type="checkbox" disabled> Отвечать сам (включится, когда подключу чат по записи запросов)</label>
          <div class="row">
            <label>Пол персонажа<select id="dmGender"><option value="f">женский</option><option value="m">мужской</option></select></label>
            <label>Тон<select id="dmTone"><option value="flirt">лёгкий флирт</option><option value="neutral">нейтральный</option></select></label>
            <label>Ответов на переписку<input id="dmMax" type="number" min="1" max="5"></label>
          </div>
          <label>Проверка: что тебе написали<textarea id="dmTest" rows="2" spellcheck="false" placeholder="например: приииивет, как дела?"></textarea></label>
          <div class="btns"><button id="dmTry" class="sm">Что ответит бот</button><button id="dmReset" class="sm">Новая переписка</button></div>
          <pre id="dmOut"></pre>
        </details>
        <details id="svcBox"><summary>Запись запросов сайта</summary>
          <label class="ck"><input id="rec" type="checkbox"> Записывать (для настройки автоответов)</label>
          <div class="st" id="recInfo"></div>
          <div class="btns"><button id="recCopy" class="sm">Копировать запись</button><button id="recClear" class="sm">Очистить</button></div>
        </details>
      </div>
    </div>`;
  const DEFAULTS = { likes: 15, friends: 5, dailyLikes: 60, dailyFriends: 25, minDelay: 15, maxDelay: 45, maxPending: 200,
    reaction: 'like', warmup: false, onlineOnly: true, ignore: '',
    auto: false, autoMin: 30, autoMax: 60, hourFrom: 0, hourTo: 24, notify: false, dmGender: 'f', dmTone: 'flirt', dmMax: 2 };

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
      dmGender: ui.dmGender.value === 'm' ? 'm' : 'f', dmTone: ui.dmTone.value === 'neutral' ? 'neutral' : 'flirt',
      dmMax: num(ui.dmMax.value, s.dmMax, 1, 5),
    };
  }
  // показываем в полях то, что реально будет использовано (после ограничений)
  function fillInputs(s) {
    ui.likes.value = s.likes; ui.friends.value = s.friends; ui.dLikes.value = s.dailyLikes; ui.dFriends.value = s.dailyFriends;
    ui.dMin.value = s.minDelay; ui.dMax.value = s.maxDelay; ui.maxPend.value = s.maxPending;
    ui.react.value = s.reaction; ui.warm.checked = !!s.warmup; ui.online.checked = !!s.onlineOnly; ui.ignore.value = s.ignore || '';
    ui.auto.checked = !!s.auto; ui.aMin.value = s.autoMin; ui.aMax.value = s.autoMax;
    ui.hFrom.value = s.hourFrom; ui.hTo.value = s.hourTo; ui.notify.checked = !!s.notify;
    ui.dmGender.value = s.dmGender === 'm' ? 'm' : 'f'; ui.dmTone.value = s.dmTone === 'neutral' ? 'neutral' : 'flirt'; ui.dmMax.value = s.dmMax;
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
      'log', 'hist', 'rec', 'recInfo', 'recCopy', 'recClear', 'dmGender', 'dmTone', 'dmMax', 'dmTest', 'dmTry', 'dmReset', 'dmOut']
      .forEach((id) => { ui[id] = $(id); });
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
      ui.auto, ui.aMin, ui.aMax, ui.hFrom, ui.hTo, ui.notify, ui.dmGender, ui.dmTone, ui.dmMax].forEach((el) => el.addEventListener('change', persist));
    let testConv = {};   // переписка для проверки в панели: можно написать несколько сообщений подряд
    ui.dmTry.addEventListener('click', () => {
      const text = ui.dmTest.value.trim();
      if (!text) return;
      const plan = dmPlan(text, testConv, readOpts());
      dmCommit(testConv, plan);
      const head = `Распознано: ${plan.intents.length ? plan.intents.join(' + ') : 'ничего'}${plan.lang === 'en' ? ' (англ.)' : ''}`;
      const body = plan.reply ? `Ответ: ${plan.reply}${plan.reason ? `\n${plan.reason}` : ''}` : `Не отвечает: ${plan.reason}`;
      ui.dmOut.textContent = `${head}\n${body}\nАвтоответов в этой переписке: ${testConv.n || 0}`;
    });
    ui.dmReset.addEventListener('click', () => { testConv = {}; ui.dmOut.textContent = 'Новая переписка.'; });
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

  if (TEST) window.__gtawInternals = { inHours, nextWindowStart, mergeProfiles, shape, tmplPath, recText, rec: () => rec, dmDetect, dmPlan, dmCommit };   // только для автотестов

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
