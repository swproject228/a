'use strict';
// Автотест: поднимает фейковый API Facebrowser и гоняет юзерскрипт в headless Chromium.
// Запуск: node test/e2e.cjs [путь к .user.js]   (нужен пакет playwright)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SCRIPT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'gtaw-fb-helper.user.js'));
const ME = 7;

const PAGE = `<!doctype html><meta charset="utf-8"><title>mock</title>
<script>window.__GTAWBOT_TEST__ = true; window.__GTAWBOT_API__ = location.origin;</script>
<script src="/bot.js"></script>
<body>mock<script>fetch('/api/v1/me', { headers: { 'X-Profile-Id': '${ME}' } });</script></body>`;

// ---------------------------------------------------------------- фейковый сервер
function startMock() {
  const S = { reacted: new Set(), reacts: [], requests: [], pending: new Set(), refuse: new Set([122]),
    retryAfter: null, staleFeed: false, peopleCount: 25, drops: 0, hang: new Set(), peopleCalls: 0 };
  const allPeople = () => {
    const people = [];
    for (let id = 101; id < 101 + S.peopleCount; id++) {
      people.push({ id, username: 'user' + id, is_online: id % 2 === 0, is_minor: id === 105,
        last_activity_at: '2026-10-10T10:' + String(id - 100).padStart(3, '0') });
    }
    people.splice(3, 0, { id: ME, username: 'me' });
    return people;
  };
  const feedPages = {
    '': { ids: [1, 2, 3, 4, 5, 6], next: 'c2' },
    c2: { ids: [5, 6, 7, 8, 9, 10], next: 'c3' },          // перекрывается с первой страницей
    c3: { ids: [11, 12, 13, 14, 15, 16], next: null },
  };
  const feedPost = (id) => ({ id, profile_id: id === 2 ? ME : 200 + id, profile: { username: 'author' + id },
    visibility: 'public', is_adult_content: id === 4, user_reaction: !S.staleFeed && S.reacted.has(id) ? 'like' : null });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj, headers) => {
      res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers));
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
    if (u.pathname === '/bot.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(fs.readFileSync(SCRIPT)); }
    if (u.pathname === '/sanctum/csrf-cookie') { res.writeHead(204, { 'Set-Cookie': 'XSRF-TOKEN=tok%3D1; Path=/' }); return res.end(); }
    if (!u.pathname.startsWith('/api/v1/')) return send(404, {});
    const p = u.pathname.slice('/api/v1'.length);
    if (req.method === 'POST' && req.headers['x-xsrf-token'] !== 'tok=1') return send(419, { message: 'CSRF token mismatch.' });
    let m;
    if (p === '/me') return send(200, {});
    if (p === '/conversations') return send(200, { data: [{ id: 55, unread_count: 1, last_message: { id: 9, body: 'секрет', sender_id: 301 } }] });
    if ((m = p.match(/^\/conversations\/(\d+)\/messages$/)) && req.method === 'POST') return send(201, { id: 10, body: 'секрет', status: 'sent' });
    if (p === '/notifications/unread-count') {
      if (S.drops > 0) { S.drops--; return req.socket.destroy(); }   // обрыв связи (Chromium сам повторяет GET один раз)
      return send(200, { count: 0 });
    }
    if (p === '/people' && u.searchParams.get('search')) return send(200, { people: [] });
    if (p === '/friends/sent') return send(200, { meta: { total: S.pending.size } });
    if (p === '/people') {
      const off = +u.searchParams.get('offset'), lim = +u.searchParams.get('limit');
      S.peopleCalls++;
      const list = allPeople().filter((x) => !S.pending.has(x.id));
      const from = off ? off - 1 : 0;                       // список «съезжает» на одного между страницами
      return send(200, { people: list.slice(from, from + lim) });   // поле total не отдаём
    }
    if ((m = p.match(/^\/friends\/status\/(\d+)$/))) return send(200, { status: S.pending.has(+m[1]) || +m[1] === 108 ? 'pending' : 'none' });
    if ((m = p.match(/^\/profiles\/(\d+)\/posts$/))) {
      const id = 1000 + +m[1];
      return send(200, { posts: [{ id, profile_id: +m[1], visibility: 'public', user_reaction: S.reacted.has(id) ? 'like' : null }] });
    }
    if ((m = p.match(/^\/friends\/request\/(\d+)$/)) && req.method === 'POST') {
      const id = +m[1]; S.requests.push(id);
      if (S.refuse.has(id)) return send(422, { message: 'This user does not accept friend requests.' });
      S.pending.add(id); return send(201, {});
    }
    if (p === '/feed') {
      const pg = feedPages[u.searchParams.get('cursor') || ''];
      return send(200, { posts: pg.ids.map(feedPost), next_cursor: pg.next });
    }
    if ((m = p.match(/^\/posts\/(\d+)\/react$/)) && req.method === 'POST') {
      if (S.retryAfter != null) return send(429, { message: 'Too Many Attempts.' }, { 'Retry-After': String(S.retryAfter) });
      if (S.hang.has(+m[1])) { S.reacts.push(+m[1]); S.reacted.add(+m[1]); return; }   // лайк прошёл, а ответа нет
      const id = +m[1]; S.reacts.push(id);
      if (S.reacted.has(id)) S.reacted.delete(id); else S.reacted.add(id);   // реакция работает как переключатель
      return send(200, {});
    }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ S, server, base: `http://localhost:${server.address().port}` })));
}

// ---------------------------------------------------------------- помощники
const $ = (page, id) => page.locator(`#gtawbot-host #${id}`);
const shadow = (page, fn, arg) => page.evaluate(([f, a]) => new Function('r', 'a', f)(document.querySelector('#gtawbot-host').shadowRoot, a), [fn, arg]);

async function openTab(ctx, base) {
  const page = await ctx.newPage();
  await page.goto(base + '/');
  await page.waitForFunction(() => {
    const h = document.querySelector('#gtawbot-host');
    return h && !h.shadowRoot.getElementById('start').disabled;
  });
  return page;
}
async function setup(page, o) {
  await shadow(page, 'r.querySelectorAll("details").forEach((d) => { d.open = true; })');
  const fields = { likes: 0, friends: 0, dMin: 0, dMax: 0, ...o.fields };
  for (const [id, v] of Object.entries(fields)) { await $(page, id).fill(String(v)); await $(page, id).dispatchEvent('change'); }
  if ('ignore' in o) { await $(page, 'ignore').fill(o.ignore); await $(page, 'ignore').dispatchEvent('change'); }
  await $(page, 'warm').setChecked(!!o.warm);
  await $(page, 'online').setChecked(false);
  await $(page, 'dry').setChecked(!!o.dry);
}
const logLen = (page) => page.evaluate(() => window.__gtawLogs.length);
const logsFrom = (page, n) => page.evaluate((k) => window.__gtawLogs.slice(k), n);
const waitIdle = (page, timeout = 20000) =>
  page.waitForFunction(() => document.querySelector('#gtawbot-host').shadowRoot.getElementById('stop').disabled, null, { timeout });
async function runOnce(page, timeout) {
  const n = await logLen(page);
  await $(page, 'start').click();
  await waitIdle(page, timeout);
  return logsFrom(page, n);
}
const ids = (lines, re) => lines.map((l) => (l.match(re) || [])[1]).filter(Boolean);
const dupes = (arr) => arr.filter((x, i) => arr.indexOf(x) !== i);
function expect(cond, msg) { if (!cond) throw new Error(msg); }
const autoOn = async (page) => { await $(page, 'auto').setChecked(true); await $(page, 'auto').dispatchEvent('change'); };
const waitLog = (page, re, timeout = 10000) => page.waitForFunction((src) => window.__gtawLogs.some((l) => new RegExp(src).test(l)), re.source, { timeout });
const readStore = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);


// ---------------------------------------------------------------- тесты
const tests = {
  async 'dry-run: ничего не отправляет, план без дублей'(ctx, { S, base }) {
    const page = await openTab(ctx, base);
    await setup(page, { dry: true, warm: true, fields: { likes: 10, friends: 4 } });
    const out = await runOnce(page);
    expect(S.reacts.length === 0 && S.requests.length === 0, `были POST: ${S.reacts} / ${S.requests}`);
    const liked = ids(out, /лайк поста (\d+) \(/);
    const friends = ids(out, /заявка в друзья: .* \(id (\d+)\)/);
    expect(liked.length === 10, `в плане ${liked.length} лайков вместо 10`);
    expect(!dupes(liked).length, `пост в плане дважды: ${dupes(liked)}`);
    expect(friends.length === 4 && !dupes(friends).length, `заявки в плане: ${friends}`);
    expect(!friends.some((x) => ['7', '105', '108'].includes(x)), `лишние адресаты: ${friends}`);
    const cand = +((out.join('\n').match(/подходящих кандидатов: (\d+)/) || [])[1]);
    expect(cand > 10, `кандидатов только ${cand}: дальше первой страницы /people не пошли`);
  },

  async 'реальный запуск: лимиты, фильтры, «не трогать», отказ сайта'(ctx, { S, base }) {
    const page = await openTab(ctx, base);
    await setup(page, { warm: true, ignore: 'user124, @Author3', fields: { likes: 6, friends: 4 } });
    const out = await runOnce(page);
    const sent = S.requests.filter((x) => !S.refuse.has(x));
    expect(sent.length === 4, `успешных заявок ${sent.length}, ожидалось 4; лог:\n${out.join('\n')}`);
    expect(!dupes(S.requests).length, `повторные заявки: ${dupes(S.requests)}`);
    expect(!S.requests.some((x) => [7, 105, 108, 124].includes(x)), `лишние адресаты: ${S.requests}`);
    expect(S.requests.includes(122) && out.some((l) => /HTTP 422: This user/.test(l)), 'отказ 422 не залогирован');
    const feed = S.reacts.filter((x) => x < 1000);
    expect(feed.length === 6 && !dupes(S.reacts).length, `лайки ленты: ${feed}`);
    expect(!feed.some((x) => [2, 3, 4].includes(x)), `лайкнут свой/18+/игнор: ${feed}`);
    const cnt = await shadow(page, 'return r.getElementById("cnt").textContent');
    expect(cnt.includes(`лайки ${S.reacts.length}/`) && cnt.includes('заявки 4/'), `счётчик: ${cnt}`);
  },

  async 'большой план заявок: листает дальше 6 страниц и выше старого потолка 80'(ctx, { S, base }) {
    S.peopleCount = 400; S.refuse.clear();
    const page = await openTab(ctx, base);
    await setup(page, { fields: { friends: 120, dFriends: 120 } });
    const out = await runOnce(page, 60000);
    expect(S.requests.length === 120 && !dupes(S.requests).length, `заявок ${S.requests.length}; лог:\n${out.slice(-5).join('\n')}`);
  },

  async 'авторежим: повторяет запуски до дневного лимита'(ctx, { S, base }) {
    const page = await openTab(ctx, base);
    await $(page, 'autoBox').evaluate((d) => { d.open = true; });
    await setup(page, { fields: { likes: 2, dLikes: 4, aMin: 1, aMax: 1 } });
    await $(page, 'auto').setChecked(true);
    await $(page, 'auto').dispatchEvent('change');
    expect((await $(page, 'start').textContent()) === 'Старт авторежима', 'кнопка не переключилась на авторежим');
    await $(page, 'start').click();
    await page.waitForFunction(() => window.__gtawLogs.some((l) => /Дневные лимиты выбраны/.test(l)), null, { timeout: 15000 });
    expect(S.reacts.length === 4 && !dupes(S.reacts).length, `лайков ${S.reacts.length}: ${S.reacts}`);
    const runs = (await logsFrom(page, 0)).filter((l) => /Старт для персонажа/.test(l)).length;
    expect(runs === 2, `запусков ${runs}, ожидалось 2`);
    await $(page, 'stop').click();
    await waitIdle(page, 3000);
    expect((await logsFrom(page, 0)).some((l) => /Авторежим выключен/.test(l)), 'нет строки о выключении');
  },

  async 'авторежим продолжается после перезагрузки, «Стоп» его отменяет'(ctx, { S, base }) {
    let page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 1, dLikes: 50, aMin: 60, aMax: 60 } });
    await $(page, 'auto').setChecked(true);
    await $(page, 'auto').dispatchEvent('change');
    await $(page, 'start').click();
    await page.waitForFunction(() => window.__gtawLogs.some((l) => /Следующий запуск/.test(l)));
    await page.reload();
    await page.waitForFunction(() => window.__gtawLogs.some((l) => /продолжаю после перезагрузки/.test(l)), null, { timeout: 5000 });
    const status = await shadow(page, 'return r.getElementById("status").textContent');
    expect(/запуск в .* через/.test(status), `нет обратного отсчёта: «${status}»`);
    expect(S.reacts.length === 1, `после перезагрузки сразу ушёл лайк: ${S.reacts.length}`);
    await $(page, 'stop').click();
    await waitIdle(page, 3000);
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#gtawbot-host').shadowRoot.getElementById('start').disabled);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => window.__gtawLogs.filter((l) => /продолжаю после перезагрузки/.test(l)).length);
    expect(after === 1, 'после «Стоп» авторежим снова продолжился при перезагрузке');
  },

  async 'авторежим выключается при ошибке сайта'(ctx, { S, base }) {
    S.retryAfter = 600;
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 2, aMin: 1, aMax: 1 } });
    await $(page, 'auto').setChecked(true);
    await $(page, 'auto').dispatchEvent('change');
    const out = await runOnce(page, 10000);
    expect(out.some((l) => /СТОП: 429/.test(l)) && out.some((l) => /Авторежим выключен/.test(l)), `лог:\n${out.join('\n')}`);
    const runs = out.filter((l) => /Старт для персонажа/.test(l)).length;
    expect(runs === 1, `после ошибки было ещё запусков: ${runs}`);
  },

  async 'рабочие часы авторежима'(ctx, { base }) {
    const page = await openTab(ctx, base);
    const r = await page.evaluate(() => {
      const { inHours, nextWindowStart } = window.__gtawInternals;
      const at = (h, m) => new Date(2026, 9, 10, h, m || 0).getTime();
      const fmt = (t) => { const d = new Date(t); return `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
      return {
        always: inHours(at(3), 0, 24) && inHours(at(3), 5, 5),
        day: [inHours(at(9, 59), 10, 23), inHours(at(10), 10, 23), inHours(at(23), 10, 23)],
        night: [inHours(at(23), 22, 3), inHours(at(2, 30), 22, 3), inHours(at(12), 22, 3)],
        next: [fmt(nextWindowStart(at(2), 10, 23)), fmt(nextWindowStart(at(23, 30), 10, 23)), fmt(nextWindowStart(at(12), 22, 3)), fmt(nextWindowStart(at(15), 10, 23))],
      };
    });
    expect(r.always, 'весь день не считается рабочим');
    expect(JSON.stringify(r.day) === '[false,true,false]', `10–23: ${r.day}`);
    expect(JSON.stringify(r.night) === '[true,true,false]', `22–3: ${r.night}`);
    expect(JSON.stringify(r.next) === '["10 10:00","11 10:00","10 22:00","10 15:00"]', `ближайший старт: ${r.next}`);
  },

  async 'история: вчерашние счётчики уходят в историю, сегодня с нуля'(ctx, { base }) {
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 3 } });
    await runOnce(page);
    const [today, tomorrow] = await page.evaluate(() => [new Date().toLocaleDateString('sv'), new Date(Date.now() + 864e5).toLocaleDateString('sv')]);
    await page.evaluate((t) => { window.__gtawToday = t; }, tomorrow);
    await $(page, 'likes').dispatchEvent('change');               // любое обновление панели
    const cnt = await shadow(page, 'return r.getElementById("cnt").textContent');
    const hist = await shadow(page, 'return r.getElementById("hist").textContent');
    expect(/лайки 0\//.test(cnt), `сегодня не с нуля: ${cnt}`);
    const dm = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
    expect(new RegExp(`${dm(tomorrow)}\\s+лайки\\s+0`).test(hist) && new RegExp(`${dm(today)}\\s+лайки\\s+3\\s+заявки\\s+0`).test(hist)
      && /всего\s+лайки\s+3/.test(hist), `история:\n${hist}`);
  },

  async 'запись запросов: адреса и поля без значений'(ctx, { base }) {
    const page = await openTab(ctx, base);
    await $(page, 'svcBox').evaluate((d) => { d.open = true; });
    await $(page, 'rec').setChecked(true);
    await $(page, 'rec').dispatchEvent('change');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#gtawbot-host'));
    await page.evaluate(async () => {
      await (await fetch('/api/v1/conversations?page=1')).json();
      await fetch('/api/v1/conversations/55/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': 'tok=1' }, body: JSON.stringify({ body: 'секретный текст' }) });
      await new Promise((ok) => { const x = new XMLHttpRequest(); x.open('GET', '/api/v1/notifications/unread-count'); x.onloadend = ok; x.send(); });
      try { new WebSocket(location.origin.replace('http', 'ws') + '/app/abc123'); } catch (_) {}
    });
    await page.waitForTimeout(800);
    const text = await page.evaluate(() => window.__gtawInternals.recText());
    expect(text.includes('POST /api/v1/conversations/{id}/messages'), `нет POST сообщения:\n${text}`);
    expect(text.includes('req: {"body":"str"}'), `нет формы тела запроса:\n${text}`);
    expect(text.includes('"status":"=sent"') && text.includes('"unread_count":"num"'), `нет формы ответа:\n${text}`);
    expect(text.includes('GET /api/v1/conversations ?page={n}'), `нет списка чатов:\n${text}`);
    expect(text.includes('GET /api/v1/notifications/unread-count'), `XHR не записан:\n${text}`);
    expect(/WS [^\n]*\/app\/\{id\}/.test(text), `WebSocket не записан:\n${text}`);
    expect(!/секрет/.test(text), 'в запись попал текст сообщения');
  },

  async 'запись запросов: ники, каналы и параметры поиска не попадают в текст'(ctx, { base }) {
    const page = await openTab(ctx, base);
    await shadow(page, 'r.getElementById("svcBox").open = true');
    await $(page, 'rec').setChecked(true);
    await $(page, 'rec').dispatchEvent('change');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#gtawbot-host'));
    await page.evaluate(async () => {
      history.pushState(null, '', '/profile/Carlos_Mendez');
      await (await fetch('/api/v1/people?search=Carlos_Mendez&sort=recent&limit=10')).json();
      const ws = new WebSocket(location.origin.replace('http', 'ws') + '/app/abc123?token=Zx9_secret');
      try { ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'private-App.Models.User.4821', auth: 'k' } })); } catch (_) {}
    });
    await page.waitForTimeout(800);
    const text = await page.evaluate(() => window.__gtawInternals.recText());
    expect(!/Carlos|Mendez|4821|Zx9|secret/.test(text), `в запись попали личные значения:\n${text}`);
    expect(text.includes('search=str') && text.includes('sort=recent') && text.includes('стр. /profile'), `нет ожидаемых заглушек:\n${text}`);
    expect(text.includes('out pusher:subscribe @private-App.Models.User.{id}'), `нет события WebSocket:\n${text}`);
  },

  async 'запись: выключение в одной вкладке не отменяется другой'(ctx, { base }) {
    const a = await openTab(ctx, base);
    await shadow(a, 'r.getElementById("svcBox").open = true');
    await $(a, 'rec').setChecked(true);
    await $(a, 'rec').dispatchEvent('change');
    const b = await openTab(ctx, base);
    await $(a, 'rec').setChecked(false);
    await $(a, 'rec').dispatchEvent('change');
    await b.waitForTimeout(300);
    await b.evaluate(() => fetch('/api/v1/me').then((r) => r.json()));
    await b.waitForTimeout(800);
    const stored = await a.evaluate(() => JSON.parse(localStorage.getItem('gtawbot:rec')).on);
    expect(stored === false, 'вторая вкладка снова включила запись');
  },

  async 'авторежим: галочка снята во время ожидания — повторов нет и после перезагрузки'(ctx, { S, base }) {
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 1, dLikes: 50, aMin: 60, aMax: 60 } });
    await $(page, 'auto').setChecked(true);
    await $(page, 'auto').dispatchEvent('change');
    await $(page, 'start').click();
    await page.waitForFunction(() => window.__gtawLogs.some((l) => /Следующий запуск/.test(l)));
    await $(page, 'auto').setChecked(false);
    await $(page, 'auto').dispatchEvent('change');
    await waitIdle(page, 3000);
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#gtawbot-host').shadowRoot.getElementById('start').disabled);
    await page.waitForTimeout(500);
    const resumed = await page.evaluate(() => window.__gtawLogs.some((l) => /продолжаю после перезагрузки/.test(l)));
    expect(!resumed && S.reacts.length === 1, `авторежим продолжился: resumed=${resumed}, лайков ${S.reacts.length}`);
  },

  async 'авторежим: правка настроек в другой вкладке не сбивает продолжение и его настройки'(ctx, { S, base }) {
    const b = await openTab(ctx, base);                    // открыта до включения авторежима
    const a = await openTab(ctx, base);
    await setup(a, { fields: { likes: 1, dLikes: 50, aMin: 60, aMax: 60 } });
    await $(a, 'auto').setChecked(true);
    await $(a, 'auto').dispatchEvent('change');
    await $(a, 'start').click();
    await a.waitForFunction(() => window.__gtawLogs.some((l) => /Следующий запуск/.test(l)));
    await $(b, 'likes').fill('7');
    await $(b, 'likes').dispatchEvent('change');
    await b.evaluate(() => document.querySelector('#gtawbot-host').shadowRoot.getElementById('hd').click());
    const auto = await a.evaluate(() => JSON.parse(localStorage.getItem('gtawbot:auto')));
    expect(auto.on === true && auto.opts.likes === 1, `другая вкладка испортила авторежим: ${JSON.stringify(auto)}`);
    await a.reload();
    await a.waitForFunction(() => window.__gtawLogs.some((l) => /продолжаю после перезагрузки/.test(l)), null, { timeout: 5000 });
    const ui = await shadow(a, 'return { dry: r.getElementById("dry").checked, label: r.getElementById("start").textContent, likes: r.getElementById("likes").value }');
    expect(!ui.dry && ui.label === 'Старт авторежима' && ui.likes === '1', `панель после продолжения: ${JSON.stringify(ui)}`);
    await $(a, 'stop').click();
    await waitIdle(a, 3000);
  },

  async 'авторежим: старая отметка вне рабочих часов не запускает сразу'(ctx, { S, base }) {
    const page = await openTab(ctx, base);
    await page.evaluate(() => {
      const h = new Date().getHours();
      localStorage.setItem('gtawbot:auto', JSON.stringify({ on: true, pid: '7', next: Date.now() - 3600e3,
        opts: { likes: 1, dailyLikes: 50, friends: 0, minDelay: 0, maxDelay: 0, autoMin: 60, autoMax: 60, hourFrom: (h + 2) % 24, hourTo: (h + 3) % 24, auto: true } }));
    });
    await page.reload();
    await page.waitForFunction(() => window.__gtawLogs.some((l) => /продолжаю после перезагрузки/.test(l)), null, { timeout: 5000 });
    await page.waitForTimeout(1500);
    const status = await shadow(page, 'return r.getElementById("status").textContent');
    expect(S.reacts.length === 0 && /запуск в/.test(status), `запустился вне часов: лайков ${S.reacts.length}, статус «${status}»`);
    await $(page, 'stop').click();
    await waitIdle(page, 3000);
  },

  async 'авторежим: обрыв связи — повтор, а не выключение'(ctx, { S, base }) {
    S.drops = 2;
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 1, dLikes: 50, aMin: 60, aMax: 60 } });
    await $(page, 'auto').setChecked(true);
    await $(page, 'auto').dispatchEvent('change');
    await $(page, 'start').click();
    await page.waitForFunction(() => window.__gtawLogs.some((l) => /нет связи, попробую снова/.test(l)), null, { timeout: 10000 });
    await page.waitForFunction(() => window.__gtawLogs.some((l) => /Следующий запуск/.test(l)), null, { timeout: 15000 });
    expect(S.reacts.length === 1, `после повтора лайков ${S.reacts.length}`);
    await $(page, 'stop').click();
    await waitIdle(page, 3000);
  },

  async 'смена персонажа во время ожидания авторежима: причина в логе'(ctx, { base }) {
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 1, dLikes: 50, aMin: 60, aMax: 60 } });
    await $(page, 'auto').setChecked(true);
    await $(page, 'auto').dispatchEvent('change');
    await $(page, 'start').click();
    await page.waitForFunction(() => window.__gtawLogs.some((l) => /Следующий запуск/.test(l)));
    await page.evaluate(() => fetch('/api/v1/me', { headers: { 'X-Profile-Id': '8' } }));
    await waitIdle(page, 3000);
    expect((await logsFrom(page, 0)).some((l) => /СТОП: Сменился активный персонаж/.test(l)), 'причина остановки не залогирована');
  },

  async 'дата ушла назад (смена пояса): лимит не обнуляется'(ctx, { S, base }) {
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 2, dLikes: 2 } });
    await runOnce(page);
    await page.evaluate(() => { const d = new Date(Date.now() - 864e5); window.__gtawToday = d.toLocaleDateString('sv'); });
    await runOnce(page);
    await runOnce(page);
    expect(S.reacts.length === 2, `лайков ${S.reacts.length} при дневном лимите 2`);
  },

  async 'уведомления запрещены: галочка снимается с объяснением'(ctx, { base }) {
    const page = await openTab(ctx, base);
    await page.evaluate(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true });
      Notification.requestPermission = () => Promise.resolve('denied');
    });
    await shadow(page, 'r.getElementById("autoBox").open = true');
    await $(page, 'notify').click();                         // галочка снимается сразу, поэтому не setChecked
    await page.waitForFunction(() => window.__gtawLogs.some((l) => /запретил уведомления/.test(l)), null, { timeout: 3000 });
    expect(!(await $(page, 'notify').isChecked()), 'галочка осталась включённой');
  },

  async 'авторежим: галочка снята посреди прохода — перезагрузка его не возвращает'(ctx, { S, base }) {
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 3, dLikes: 50, dMin: 2, dMax: 2, aMin: 60, aMax: 60 } });
    await autoOn(page);
    await $(page, 'start').click();
    await page.waitForFunction(() => window.__gtawLogs.some((l) => /лайк поста 1 /.test(l)));
    await $(page, 'auto').setChecked(false);
    await $(page, 'auto').dispatchEvent('change');
    const rec = await readStore(page, 'gtawbot:auto');
    expect(rec && rec.on === false, `сразу после снятия галочки: ${JSON.stringify(rec)}`);
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#gtawbot-host').shadowRoot.getElementById('start').disabled);
    await page.waitForTimeout(500);
    const resumed = await page.evaluate(() => window.__gtawLogs.some((l) => /продолжаю после перезагрузки/.test(l)));
    expect(!resumed, 'авторежим вернулся после перезагрузки');
  },

  async 'авторежим: правка в этой же вкладке переживает перезагрузку'(ctx, { S, base }) {
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 1, dLikes: 50, aMin: 60, aMax: 60 } });
    await autoOn(page);
    await $(page, 'start').click();
    await waitLog(page, /Следующий запуск/);
    await $(page, 'ignore').fill('author3, author5');
    await $(page, 'ignore').dispatchEvent('change');
    await waitLog(page, /применятся со следующего запуска/);
    await page.evaluate(() => {   // следующий запуск — сразу после перезагрузки
      const a = JSON.parse(localStorage.getItem('gtawbot:auto')); a.next = Date.now(); localStorage.setItem('gtawbot:auto', JSON.stringify(a));
    });
    await page.reload();
    await page.waitForFunction(() => window.__gtawLogs.filter((l) => /Следующий запуск/.test(l)).length >= 2, null, { timeout: 10000 });
    expect(S.reacts.length === 2 && S.reacts[0] === 1, `лайкнуты: ${S.reacts}`);
    expect(!S.reacts.includes(3) && !S.reacts.includes(5), `лайкнут игнорируемый автор: ${S.reacts}`);
    const ign = await $(page, 'ignore').inputValue();
    expect(ign === 'author3, author5', `панель после продолжения: «${ign}»`);
    await $(page, 'stop').click();
    await waitIdle(page, 3000);
  },

  async 'авторежим: таймаут POST не повторяется (лайк мог пройти)'(ctx, { S, base }) {
    S.hang.add(1);
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 2, dLikes: 2, aMin: 60, aMax: 60 } });
    await autoOn(page);
    const out = await runOnce(page, 15000);
    expect(out.some((l) => /не ответил/.test(l)) && !out.some((l) => /попробую снова/.test(l)) && out.some((l) => /Авторежим выключен/.test(l)),
      `лог:\n${out.join('\n')}`);
    expect(S.reacts.length === 1, `ушло лайков ${S.reacts.length}`);
  },

  async 'авторежим: галочка снята в другой вкладке — там больше не запускает'(ctx, { S, base }) {
    const a = await openTab(ctx, base);
    const b = await openTab(ctx, base);
    await setup(a, { fields: { likes: 1, dLikes: 50, aMin: 60, aMax: 60 } });
    await autoOn(a);
    await $(a, 'start').click();
    await waitLog(a, /Следующий запуск/);
    await shadow(b, 'r.getElementById("autoBox").open = true');
    await $(b, 'auto').setChecked(true);
    await $(b, 'auto').dispatchEvent('change');
    await $(b, 'auto').setChecked(false);
    await $(b, 'auto').dispatchEvent('change');
    await waitIdle(a, 3000);
    expect((await logsFrom(a, 0)).some((l) => /выключен в другой вкладке/.test(l)), 'вкладка A не узнала об отмене');
    expect((await readStore(a, 'gtawbot:auto')).on === false, 'запись авторежима осталась включённой');
  },

  async 'лог: сворачивание панели в другой вкладке его не стирает'(ctx, { base }) {
    const b = await openTab(ctx, base);
    const a = await openTab(ctx, base);
    await setup(a, { fields: { likes: 2 } });
    await runOnce(a);
    const before = (await readStore(a, 'gtawbot:v1')).log.length;
    await b.evaluate(() => document.querySelector('#gtawbot-host').shadowRoot.getElementById('hd').dispatchEvent(new PointerEvent('pointerdown', { button: 0 })));
    await shadow(b, 'r.getElementById("hd").dispatchEvent(new PointerEvent("pointerup"))');
    await b.waitForTimeout(500);
    const st = await readStore(a, 'gtawbot:v1');
    expect(st.collapsed === true && st.log.length >= before, `лог ${before} → ${st.log.length}, collapsed=${st.collapsed}`);
  },

  async 'настройки из другой вкладки доходят после окончания запуска'(ctx, { S, base }) {
    const a = await openTab(ctx, base);
    const b = await openTab(ctx, base);
    await setup(a, { fields: { likes: 1, dLikes: 50, aMin: 60, aMax: 60 } });
    await autoOn(a);
    await $(a, 'start').click();
    await waitLog(a, /Следующий запуск/);
    await $(b, 'friends').fill('9');
    await $(b, 'friends').dispatchEvent('change');
    await $(a, 'stop').click();
    await waitIdle(a, 3000);
    expect((await $(a, 'friends').inputValue()) === '9', 'панель A не подхватила правку из B');
    await $(a, 'dMax').fill('3');
    await $(a, 'dMax').dispatchEvent('change');
    expect((await readStore(a, 'gtawbot:v1')).settings.friends === 9, 'правка B затёрта');
  },

  async 'запись из двух вкладок сливается'(ctx, { base }) {
    const a = await openTab(ctx, base);
    const b = await openTab(ctx, base);                      // открыта до включения записи: WebSocket не перехвачен
    await shadow(a, 'r.getElementById("svcBox").open = true');
    await $(a, 'rec').setChecked(true);
    await $(a, 'rec').dispatchEvent('change');
    await b.waitForTimeout(300);
    await Promise.all([
      a.evaluate(() => fetch('/api/v1/notifications/unread-count').then((r) => r.json())),
      b.evaluate(() => fetch('/api/v1/conversations/55/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': 'tok=1' }, body: '{"body":"x"}' }).then((r) => r.json())),
    ]);
    await a.waitForTimeout(1500);
    const keys = Object.keys((await readStore(a, 'gtawbot:rec')).items);
    expect(keys.includes('POST /api/v1/conversations/{id}/messages') && keys.includes('GET /api/v1/notifications/unread-count'), `в записи: ${keys}`);
    const info = await shadow(b, 'return r.getElementById("recInfo").textContent');
    expect(/Обнови эту вкладку/.test(info), `вкладка без перехвата WebSocket не предупреждает: «${info}»`);
  },

  async 'медленный двойной щелчок не сворачивает панель'(ctx, { base }) {
    const page = await openTab(ctx, base);
    const h0 = await $(page, 'hd').boundingBox();             // сначала переносим: заголовок перестаёт прыгать при сворачивании
    await page.mouse.move(h0.x + 40, h0.y + 10);
    await page.mouse.down();
    await page.mouse.move(h0.x - 160, h0.y - 40, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const b = await $(page, 'hd').boundingBox();
    const x = b.x + 40, y = b.y + 10;
    await page.mouse.move(x, y);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(330);
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
    await page.waitForTimeout(500);
    expect(!(await shadow(page, 'return r.getElementById("bd").classList.contains("off")')), 'панель осталась свёрнутой');
    const box = await $(page, 'box').boundingBox(), vp = page.viewportSize();
    expect(Math.abs(box.x + box.width - (vp.width - 12)) < 3, `позиция не сброшена: ${JSON.stringify(box)}`);
  },

  async 'панель перетаскивается и запоминает место'(ctx, { base }) {
    const page = await openTab(ctx, base);
    const hd = $(page, 'hd');
    const b = await hd.boundingBox(), box0 = await $(page, 'box').boundingBox();
    await page.mouse.move(b.x + 40, b.y + 10);
    await page.mouse.down();
    await page.mouse.move(b.x - 200, b.y - 40, { steps: 5 });
    await page.mouse.up();
    const moved = await $(page, 'box').boundingBox();
    expect(Math.abs(moved.x - (box0.x - 240)) < 3 && Math.abs(moved.y - (box0.y - 50)) < 3, `панель не сдвинулась: ${JSON.stringify(moved)} от ${JSON.stringify(box0)}`);
    expect(!(await shadow(page, 'return r.getElementById("bd").classList.contains("off")')), 'перетаскивание свернуло панель');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#gtawbot-host'));
    const after = await $(page, 'box').boundingBox();
    expect(Math.abs(after.x - moved.x) < 3 && Math.abs(after.y - moved.y) < 3, 'позиция не запомнилась');
    await hd.click();
    await page.waitForTimeout(400);
    expect(await shadow(page, 'return r.getElementById("bd").classList.contains("off")'), 'щелчок по заголовку не свернул панель');
    await hd.click();
    await page.waitForTimeout(400);
    await hd.dblclick();
    await page.waitForTimeout(400);
    const reset = await $(page, 'box').boundingBox();
    const vp = page.viewportSize();
    expect(Math.abs(reset.x + reset.width - (vp.width - 12)) < 3 && !(await shadow(page, 'return r.getElementById("bd").classList.contains("off")')),
      `двойной щелчок: ${JSON.stringify(reset)}`);
  },

  async 'потолок заявок 2000 и план больше одной порции кандидатов'(ctx, { S, base }) {
    S.peopleCount = 800; S.refuse.clear();
    const page = await openTab(ctx, base);
    await setup(page, { fields: { friends: 650, dFriends: 1500, maxPend: 5000 } });
    expect((await $(page, 'dFriends').inputValue()) === '1500', 'потолок 1500 урезан');
    await $(page, 'dFriends').fill('99999');
    await $(page, 'dFriends').dispatchEvent('change');
    expect((await $(page, 'dFriends').inputValue()) === '2000', 'потолок не 2000');
    const out = await runOnce(page, 120000);
    expect(S.requests.length === 650 && !dupes(S.requests).length, `заявок ${S.requests.length}; лог:\n${out.slice(-4).join('\n')}`);
    expect(S.peopleCalls > 60, `не было второй порции кандидатов: запросов списка ${S.peopleCalls} (порция — максимум 60)`);
  },

  async 'автоответы: проверка в панели распознаёт и отвечает'(ctx, { base }) {
    const page = await openTab(ctx, base);
    await shadow(page, 'r.getElementById("dmBox").open = true');
    const ask = async (text) => {
      await $(page, 'dmTest').fill(text);
      await $(page, 'dmTry').click();
      return $(page, 'dmOut').textContent();
    };
    let out = await ask('приииивет, как дела?');
    expect(/приветствие/.test(out) && /как дела/.test(out) && /Ответ: /.test(out), `ответ на приветствие:\n${out}`);
    out = await ask('ты бот?');
    expect(/Не отвечает: спросили, бот ли это/.test(out), `вопрос «ты бот?»:\n${out}`);
    out = await ask('привет');
    expect(/Не отвечает: переписка уже у тебя/.test(out), `после передачи бот должен молчать:\n${out}`);
    await $(page, 'dmReset').click();
    await $(page, 'dmGender').selectOption('m');
    await $(page, 'dmGender').dispatchEvent('change');
    for (let i = 0; i < 5; i++) {
      out = await ask('кто ты?');
      if (/Увидел твой/.test(out)) break;
      await $(page, 'dmReset').click();
    }
    expect(/Ответ: (Привет[)!]? )?(Увидел твой профиль и решил|Просто)/.test(out) && !/\{/.test(out), `мужской род:\n${out}`);
  },

  async 'устаревшая лента: один пост не нажимается дважды'(ctx, { S, base }) {
    S.staleFeed = true;
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 10 } });
    await runOnce(page);
    expect(!dupes(S.reacts).length, `повторный POST react (снимает лайк): ${dupes(S.reacts)}`);
  },

  async 'повторный запуск: отклонившим заявку не пишем снова'(ctx, { S, base }) {
    const page = await openTab(ctx, base);
    await setup(page, { fields: { friends: 4 } });
    await runOnce(page);
    S.pending.clear();                                     // все отклонили
    const out = await runOnce(page);
    expect(!dupes(S.requests).length, `заявка ушла тому же человеку повторно: ${dupes(S.requests)}`);
    expect(out.some((l) => /уже уходила/.test(l)), 'нет строки о пропущенных');
  },

  async 'две вкладки: одновременно работает только одна'(ctx, { S, base }) {
    const a = await openTab(ctx, base), b = await openTab(ctx, base);
    await setup(a, { fields: { likes: 3, dMin: 1, dMax: 1 } });
    await setup(b, { fields: { likes: 3, dMin: 1, dMax: 1 } });
    const nb = await logLen(b);
    await $(a, 'start').click();
    await a.waitForFunction(() => window.__gtawLogs.some((l) => /Старт для/.test(l)));
    await $(b, 'start').click();
    await waitIdle(b);
    expect((await logsFrom(b, nb)).some((l) => /другой вкладке/.test(l)), 'вторая вкладка запустилась параллельно');
    await waitIdle(a);
    expect(S.reacts.length === 3, `лайков ${S.reacts.length}, ожидалось 3`);
    await b.waitForFunction(() => /лайки 3\//.test(document.querySelector('#gtawbot-host').shadowRoot.getElementById('cnt').textContent));
  },

  async 'пустое поле = значение по умолчанию'(ctx, { base }) {
    const page = await openTab(ctx, base);
    await $(page, 'likes').fill('');
    await $(page, 'likes').dispatchEvent('change');
    await $(page, 'start').click();                       // dry-run по умолчанию включён
    await waitIdle(page);
    const out = await logsFrom(page, 0);
    expect(out.some((l) => /Лайки ленты: план 15/.test(l)), `пустое поле дало не 15:\n${out.join('\n')}`);
  },

  async '«Стоп» срабатывает сразу, даже во время паузы'(ctx, { S, base }) {
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 5, dMin: 30, dMax: 30 } });
    await $(page, 'start').click();
    await page.waitForFunction(() => window.__gtawLogs.some((l) => /лайк поста 1 /.test(l)));
    await page.waitForTimeout(500);
    const t0 = Date.now();
    await $(page, 'stop').click();
    await waitIdle(page, 5000);
    expect(Date.now() - t0 < 2000, `остановка заняла ${Date.now() - t0} мс`);
    expect(S.reacts.length === 1, `после «Стоп» ушло ещё ${S.reacts.length - 1} лайков`);
    expect((await logsFrom(page, 0)).some((l) => /СТОП: Остановлено кнопкой/.test(l)), 'нет строки СТОП');
  },

  async '429 с огромным Retry-After: остановка без многоминутного ожидания'(ctx, { S, base }) {
    S.retryAfter = 600;
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 2 } });
    const out = await runOnce(page, 10000);
    expect(out.some((l) => /СТОП: 429/.test(l)), `лог:\n${out.join('\n')}`);
  },

  async 'смена персонажа во время паузы останавливает запуск'(ctx, { S, base }) {
    const page = await openTab(ctx, base);
    await setup(page, { fields: { likes: 5, dMin: 30, dMax: 30 } });
    await $(page, 'start').click();
    await page.waitForFunction(() => window.__gtawLogs.some((l) => /лайк поста 1 /.test(l)));
    await page.evaluate(() => fetch('/api/v1/me', { headers: { 'X-Profile-Id': '8' } }));
    await waitIdle(page, 5000);
    expect(S.reacts.length === 1, `лайков ${S.reacts.length}`);
    expect((await logsFrom(page, 0)).some((l) => /Сменился активный персонаж/.test(l)), 'нет строки о смене персонажа');
  },
};

// ---------------------------------------------------------------- прогон
(async () => {
  const browser = await chromium.launch();
  const only = process.env.ONLY;
  let failed = 0;
  console.log(`Скрипт: ${SCRIPT}`);
  for (const [name, fn] of Object.entries(tests)) {
    if (only && !name.includes(only)) continue;
    const mock = await startMock();
    const ctx = await browser.newContext();
    try {
      await fn(ctx, mock);
      console.log(`  ok    ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').join('\n        ')}`);
    } finally {
      await ctx.close();
      mock.server.closeAllConnections();
      mock.server.close();
    }
  }
  await browser.close();
  console.log(failed ? `\nУпало: ${failed}` : '\nВсе тесты прошли');
  process.exit(failed ? 1 : 0);
})();
