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
    retryAfter: null, staleFeed: false, peopleCount: 25 };
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
    if (p === '/notifications/unread-count') return send(200, { count: 0 });
    if (p === '/friends/sent') return send(200, { meta: { total: S.pending.size } });
    if (p === '/people') {
      const off = +u.searchParams.get('offset'), lim = +u.searchParams.get('limit');
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
