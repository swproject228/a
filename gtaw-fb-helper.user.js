// ==UserScript==
// @name         Facebrowser Helper (GTA World)
// @namespace    gtaw-fb-helper
// @version      1.0.0
// @description  Лайки и заявки в друзья от имени текущего персонажа: лимиты, паузы, dry-run. Работает в уже открытой и залогиненной вкладке.
// @match        https://fbv2.gtaw.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window || window.__gtawBotLoaded) return;
  window.__gtawBotLoaded = true;

  const API = window.__GTAWBOT_API__ || 'https://fbv2-api.gtaw.io';
  const V1 = API + '/api/v1';
  const STORE = 'gtawbot:v1';
  const TEST = !!window.__GTAWBOT_TEST__;
  const MIN_DELAY_FLOOR = TEST ? 0 : 5;            // сек, ниже нельзя
  const HARD_MAX = { likes: 300, friends: 80 };    // потолок дневных лимитов

  // ------------------------------------------------------------------ утилиты
  const rand = (a, b) => a + Math.random() * (b - a);
  const num = (v, d, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const today = () => new Date().toLocaleDateString('sv');   // YYYY-MM-DD по местному времени
  class Stop extends Error {}

  const store = {
    read() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (_) { return {}; } },
    write(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (_) {} },
  };
  const state = Object.assign({ settings: {}, profiles: {}, collapsed: false, log: [] }, store.read());
  const save = () => store.write(state);

  // ------------------------------------------------------------------ перехват заголовков сайта
  // Сайт сам шлёт x-profile-id (какой персонаж активен) и x-xsrf-token: подхватываем их,
  // ничего не меняя в его запросах.
  const cap = { profileId: null, xsrf: null };
  const origFetch = window.fetch.bind(window);
  const isApi = (u) => { try { return new URL(String(u), location.href).href.startsWith(API); } catch (_) { return false; } };
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
      const url = typeof input === 'string' ? input : (input && input.url);
      if (isApi(url)) {
        const src = (init && init.headers) || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
        if (src) new Headers(src).forEach((v, n) => take(n, v));
      }
    } catch (_) { /* перехват не должен ломать сайт */ }
    return origFetch(input, init);
  };

  // ------------------------------------------------------------------ состояние запуска
  let run = null;          // {pid, dry, ...} пока идёт сессия
  let stopFlag = false;
  const sleep = (ms) => new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => { if (stopFlag || Date.now() - t0 >= ms) { clearInterval(iv); res(); } }, 100);
  });
  const pause = (lo, hi) => sleep(rand(lo, hi) * 1000);

  const day = (pid) => {
    const p = state.profiles[pid] || (state.profiles[pid] = {});
    if (p.date !== today()) { p.date = today(); p.likes = 0; p.friends = 0; }
    return p;
  };

  // ------------------------------------------------------------------ лог
  const logs = [];
  if (TEST) window.__gtawLogs = logs;   // только для автотестов
  let ui = null;
  function log(msg) {
    const line = `${new Date().toLocaleTimeString('ru-RU')} ${msg}`;
    logs.push(line); if (logs.length > 300) logs.shift();
    state.log = logs.slice(-60); save();
    if (ui) { ui.log.textContent = logs.slice(-14).join('\n'); ui.log.scrollTop = ui.log.scrollHeight; }
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
      if (stopFlag) throw new Stop('Остановлено кнопкой');
      if (cap.profileId !== run.pid) throw new Stop('Сменился активный персонаж: остановлено');
      const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-Profile-Id': run.pid };
      let data;
      if (method !== 'GET') {
        let tok = readXsrf();
        if (!tok) { await refreshCsrf(); tok = readXsrf(); }
        if (tok) headers['X-XSRF-TOKEN'] = tok;
        if (body !== undefined) { headers['Content-Type'] = 'application/json'; data = JSON.stringify(body); }
      }
      let res, text, js = null;
      try { res = await origFetch(V1 + path, { method, headers, body: data, credentials: 'include' }); text = await res.text(); }
      catch (e) { throw new Stop('Нет связи с сайтом: ' + e.message); }
      try { js = text.trim() ? JSON.parse(text) : {}; } catch (_) { js = null; }
      const st = res.status;
      if (js === null || (st >= 502 && st <= 504)) throw new Stop('Ответ не JSON или 5xx: похоже на проверку Cloudflare или сбой. Обнови страницу, пройди проверку и запусти снова.');
      if (st === 429) {
        if (++rateLimited > 1) throw new Stop('Повторный 429 (Too Many Attempts). Попробуй позже.');
        const wait = (parseInt(res.headers.get('retry-after'), 10) || 15) + rand(1, 5);
        log(`  429: жду ${Math.round(wait)} с`);
        await sleep(wait * 1000);
        continue;
      }
      if (st === 419 && !csrfDone) { csrfDone = true; await refreshCsrf(); continue; }
      if (st === 401 || st === 419) throw new Stop('Сессия не авторизована: войди на сайте и обнови страницу.');
      return { status: st, data: js };
    }
  }
  async function get(path) {
    const r = await api('GET', path);
    if (r.status !== 200) throw new Stop(`GET ${path.split('?')[0]}: HTTP ${r.status}`);
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

  let refusals = 0;
  function refused(status, what) {
    log(`  отказ сайта (HTTP ${status}) для ${what}, пропускаю`);
    if (++refusals >= 5) throw new Stop('5 отказов подряд: останавливаюсь, чтобы не долбить сайт.');
  }

  async function react(postId, who) {
    const r = await api('POST', `/posts/${postId}/react`, { type: run.opts.reaction });
    if (r.status === 200) {
      refusals = 0; day(run.pid).likes++; save(); refreshCounters();
      return true;
    }
    refused(r.status, `поста ${postId}`);
    return false;
  }

  // ------------------------------------------------------------------ заявки в друзья
  async function pendingCount() {
    const d = await get('/friends/sent?page=1');
    return d.meta && Number.isFinite(d.meta.total) ? d.meta.total : null;
  }

  async function gatherPeople(want) {
    const pool = [];
    for (let i = 0; i < 6 && pool.length < Math.max(want * 3, 20); i++) {
      const q = new URLSearchParams({ limit: 10, offset: i * 10, gender: 'all', exclude_friends: 'true',
        exclude_requested: 'true', exclude_block_friend_requests: 'true', exclude_minors: 'true' });
      if (run.opts.onlineOnly) q.set('online', 'yes');
      const d = await get('/people?' + q);
      const people = d.people || [];
      if (!people.length) break;
      for (const p of people) if (friendable(p, run.pid)) pool.push(p);
      if ((i + 1) * 10 >= (d.total || 0)) break;
    }
    // сначала онлайн и самые активные: у них выше шанс ответа
    pool.sort((a, b) => (Number(!!b.is_online) - Number(!!a.is_online)) ||
      String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || '')));
    return pool;
  }

  async function doFriends() {
    const o = run.opts, d = day(run.pid);
    let want = Math.min(o.friends, Math.max(0, o.dailyFriends - d.friends));
    log(`Заявки в друзья: план ${want} (осталось на сегодня ${Math.max(0, o.dailyFriends - d.friends)})`);
    if (want <= 0) return;
    const pending = await pendingCount();
    run.pending = pending; refreshCounters();
    if (pending != null && pending >= o.maxPending) {
      log(`  висит ${pending} неотвеченных заявок (потолок ${o.maxPending}): фазу заявок пропускаю`);
      return;
    }
    if (pending != null) want = Math.min(want, Math.max(0, o.maxPending - pending));
    const pool = await gatherPeople(want);
    log(`  подходящих кандидатов: ${pool.length}`);
    let done = 0;
    for (const p of pool) {
      if (done >= want) break;
      const name = p.username || p.id;
      const st = await get(`/friends/status/${p.id}`);
      if (st.status !== 'none') continue;                 // уже друзья / заявка есть / блок
      if (o.warmup && day(run.pid).likes < o.dailyLikes) {
        const pd = await get(`/profiles/${p.id}/posts?sort=recent&type=all`);
        const arr = Array.isArray(pd.posts) ? pd.posts : ((pd.posts && pd.posts.data) || []);
        const post = arr.find((x) => likeable(x, run.pid));
        if (post) {
          if (run.dry) log(`  [dry-run] лайк поста ${post.id} у ${name} перед заявкой`);
          else if (await react(post.id, name)) { log(`  лайк поста ${post.id} у ${name} (перед заявкой)`); await pause(3, 8); }
        }
      }
      if (run.dry) { log(`  [dry-run] заявка в друзья: ${name} (id ${p.id})`); done++; continue; }
      const r = await api('POST', `/friends/request/${p.id}`);
      if (r.status === 200 || r.status === 201) {
        refusals = 0; day(run.pid).friends++; save(); refreshCounters(); done++;
        log(`  заявка отправлена: ${name} (id ${p.id}) [${done}/${want}]`);
        await pause(o.minDelay, o.maxDelay);
      } else refused(r.status, name);
    }
    log(`Заявки в друзья: ${run.dry ? 'в плане' : 'отправлено'} ${done}`);
  }

  // ------------------------------------------------------------------ лайки ленты
  async function doLikes() {
    const o = run.opts, d = day(run.pid);
    const left = Math.max(0, o.dailyLikes - d.likes);
    const want = Math.min(o.likes, left);
    log(`Лайки ленты: план ${want} (осталось на сегодня ${left})`);
    if (want <= 0) return;
    let cursor = null, firstId = null, done = 0;
    for (let page = 0; page < 10 && done < want; page++) {
      const q = new URLSearchParams({ sort: 'recent', type: 'all' });
      if (cursor) q.set('cursor', cursor);
      const data = await get('/feed?' + q);
      const posts = data.posts || [];
      if (!posts.length || posts[0].id === firstId) break;   // курсор не сработал или лента кончилась
      firstId = posts[0].id;
      for (const p of posts) {
        if (done >= want) break;
        if (!likeable(p, run.pid)) continue;
        const who = (p.profile && p.profile.username) || '?';
        if (run.dry) { log(`  [dry-run] лайк поста ${p.id} (автор ${who})`); done++; continue; }
        if (await react(p.id, who)) { done++; log(`  лайк поста ${p.id} (автор ${who}) [${done}/${want}]`); await pause(o.minDelay, o.maxDelay); }
      }
      cursor = data.next_cursor;
      if (!cursor) break;
    }
    log(`Лайки ленты: ${run.dry ? 'в плане' : 'сделано'} ${done}`);
  }

  // ------------------------------------------------------------------ запуск
  async function start(opts, dry) {
    if (run) return;
    if (!cap.profileId) { log('Персонаж не определён: открой любую страницу сайта (например «Друзья»).'); return; }
    run = { pid: cap.profileId, opts, dry, pending: null };
    stopFlag = false; refusals = 0; setRunning(true);
    log(`${dry ? 'DRY-RUN: ничего не отправляется. ' : ''}Старт для персонажа ${run.pid}`);
    try {
      const r = await api('GET', '/notifications/unread-count');
      if (r.status !== 200) throw new Stop(`Проверка сессии: HTTP ${r.status}`);
      if (opts.friends > 0) await doFriends();
      if (opts.likes > 0) await doLikes();
      log('Готово.');
    } catch (e) {
      log(e instanceof Stop ? `СТОП: ${e.message}` : `Ошибка: ${e.message}`);
    } finally {
      run = null; stopFlag = false; setRunning(false); refreshCounters();
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
    input[type=number],select{width:100%;box-sizing:border-box;background:#11131a;color:#fff;border:1px solid #3a3d4d;border-radius:6px;padding:4px 6px}
    button{border:0;border-radius:6px;padding:7px 10px;font-weight:600;cursor:pointer;color:#fff}
    #start{background:#2f7d4f}#stop{background:#a3413b}#copy{background:#3a3d4d}
    button:disabled{opacity:.45;cursor:default}
    .btns{display:flex;gap:6px}.btns button{flex:1}
    .st{color:#aab}.warn{color:#f0b35a}
    pre{margin:0;max-height:150px;overflow:auto;white-space:pre-wrap;background:#11131a;border-radius:6px;padding:6px;font:11px/1.35 ui-monospace,monospace}
  `;
  const HTML = `
    <div class="box">
      <div class="hd" id="hd"><span>Facebrowser Helper</span><span id="tg">▾</span></div>
      <div class="bd" id="bd">
        <div class="st" id="pid"></div>
        <div class="st" id="cnt"></div>
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
        <label class="ck"><input id="dry" type="checkbox" checked> Dry-run (ничего не отправлять)</label>
        <label class="ck"><input id="warm" type="checkbox"> Лайкнуть пост перед заявкой</label>
        <label class="ck"><input id="online" type="checkbox"> Заявки только онлайн-людям</label>
        <div class="btns"><button id="start">Старт</button><button id="stop" disabled>Стоп</button><button id="copy">Лог</button></div>
        <pre id="log"></pre>
      </div>
    </div>`;
  const DEFAULTS = { likes: 15, friends: 5, dailyLikes: 60, dailyFriends: 25, minDelay: 15, maxDelay: 45, maxPending: 200,
    reaction: 'like', warmup: false, onlineOnly: true };

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
    };
  }

  function refreshCounters() {
    if (!ui) return;
    const o = Object.assign({}, DEFAULTS, state.settings);
    if (!cap.profileId) { ui.cnt.textContent = ''; return; }
    const d = day(cap.profileId);
    const pend = run && run.pending != null ? ` · висит заявок: ${run.pending}` : '';
    ui.cnt.textContent = `Сегодня: лайки ${d.likes}/${o.dailyLikes} · заявки ${d.friends}/${o.dailyFriends}${pend}`;
  }
  function onProfile() {
    if (!ui) return;
    ui.pid.textContent = `Персонаж: ${cap.profileId} (определён автоматически)`;
    ui.pid.className = 'st';
    ui.start.disabled = !!run;
    refreshCounters();
  }
  function setRunning(on) {
    if (!ui) return;
    ui.start.disabled = on || !cap.profileId; ui.stop.disabled = !on;
  }

  function mount() {
    if (ui || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = 'gtawbot-host';
    const root = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS);   // CSSOM: не блокируется CSP
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = HTML;
    document.documentElement.appendChild(host);                  // вне <body>: React не трогает
    const $ = (id) => root.getElementById ? root.getElementById(id) : root.querySelector('#' + id);
    ui = { bd: $('bd'), tg: $('tg'), pid: $('pid'), cnt: $('cnt'), likes: $('likes'), friends: $('friends'),
      dLikes: $('dLikes'), dFriends: $('dFriends'), dMin: $('dMin'), dMax: $('dMax'), maxPend: $('maxPend'),
      react: $('react'), dry: $('dry'), warm: $('warm'), online: $('online'),
      start: $('start'), stop: $('stop'), copy: $('copy'), log: $('log') };
    const s = Object.assign({}, DEFAULTS, state.settings);
    ui.likes.value = s.likes; ui.friends.value = s.friends; ui.dLikes.value = s.dailyLikes; ui.dFriends.value = s.dailyFriends;
    ui.dMin.value = s.minDelay; ui.dMax.value = s.maxDelay; ui.maxPend.value = s.maxPending;
    ui.react.value = s.reaction; ui.warm.checked = s.warmup; ui.online.checked = s.onlineOnly;
    ui.bd.classList.toggle('off', !!state.collapsed); ui.tg.textContent = state.collapsed ? '▸' : '▾';
    ui.pid.textContent = 'Персонаж не определён: открой любую страницу сайта (например «Друзья»).';
    ui.pid.className = 'st warn'; ui.start.disabled = true;
    root.getElementById('hd').addEventListener('click', () => {
      state.collapsed = !state.collapsed; save();
      ui.bd.classList.toggle('off', state.collapsed); ui.tg.textContent = state.collapsed ? '▸' : '▾';
    });
    const persist = () => { state.settings = readOpts(); save(); refreshCounters(); };
    [ui.likes, ui.friends, ui.dLikes, ui.dFriends, ui.dMin, ui.dMax, ui.maxPend, ui.react, ui.warm, ui.online]
      .forEach((el) => el.addEventListener('change', persist));
    ui.start.addEventListener('click', () => { const o = readOpts(); state.settings = o; save(); start(o, ui.dry.checked); });
    ui.stop.addEventListener('click', () => { stopFlag = true; log('Останавливаю…'); });
    ui.copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(logs.join('\n')); log('Лог скопирован в буфер.'); } catch (_) { log('Не удалось скопировать лог.'); }
    });
    if (state.log && state.log.length) { logs.push(...state.log); ui.log.textContent = logs.slice(-14).join('\n'); }
    if (cap.profileId) onProfile();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
