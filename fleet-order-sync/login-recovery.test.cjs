'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSyncMaintenancePage } = require('./frontend-sync-patch.cjs');

// Unlike the older frontend helper, this fixture records real event listeners
// and timers so refresh/back-navigation and overlapping fetches can be tested.
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function statusFixture(active = null) {
  return { automatic_enabled: false, manual_pending: false, order_sync: { platforms: {} },
    cloud: { active, budget: { remainingMs: 295000 }, sources: {
      boataround: { status: 'auth_required' }, clickandboat: { status: 'auth_required' }, samboat: { status: 'auth_required' },
    } } };
}
function loginActive(source = 'boataround', phase = 'login') {
  return { kind: 'login', source, phase, deadlineAt: Date.now() + 120000 };
}
function frontend() {
  const { html } = buildSyncMaintenancePage();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\binitializeSyncSettings\(\);\s*$/, '');
  const nodes = new Map(), calls = [], timers = new Map(), pageEvents = new Map(), documentEvents = new Map();
  let serial = 0, state = statusFixture(), handler;
  const listener = (map, name, fn) => { if (!map.has(name)) map.set(name, []); map.get(name).push(fn); };
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const attrs = match[2], events = new Map();
    nodes.set(match[3], { id: match[3], textContent: '', innerHTML: '', disabled: /\bdisabled\b/.test(attrs),
      hidden: /\bhidden\b/.test(attrs), value: '', href: '', events,
      addEventListener(name, fn) { listener(events, name, fn); },
      removeAttribute(name) { delete this[name]; }, setAttribute(name, value) { this[name] = value; },
      async click() { if (this.disabled) return; for (const fn of events.get('click') || []) await fn({ type: 'click', target: this }); },
    });
  }
  const document = { hidden: false, visibilityState: 'visible',
    getElementById(id) { const node = nodes.get(id); assert.ok(node, `Missing real rendered element: ${id}`); return node; },
    querySelectorAll() { return []; }, addEventListener(name, fn) { listener(documentEvents, name, fn); } };
  const window = { location: { href: 'https://fleet.example/sync', replace(url) { window.redirect = url; } },
    addEventListener(name, fn) { listener(pageEvents, name, fn); } };
  const timer = (fn, ms, repeat) => { const id = ++serial; timers.set(id, { fn, ms, repeat }); return id; };
  const context = vm.createContext({ document, window, URL, Response, Request, Headers, AbortController, AbortSignal, DOMException,
    console, setTimeout: (fn, ms) => timer(fn, ms, false), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => timer(fn, ms, true), clearInterval: id => timers.delete(id),
    fetch: async (url, options = {}) => { calls.push({ url, options }); return handler ? handler(url, options) : new Response(JSON.stringify(state)); } });
  vm.runInContext(script, context);
  return { html, context, calls, nodes, timers, document,
    setState(value) { state = value; context.renderSyncStatus(value); }, setFetch(value) { handler = value; },
    async initialize() { context.initializeSyncSettings(); await flush(); },
    async event(name, value = {}) { for (const fn of pageEvents.get(name) || []) await fn({ type: name, ...value }); await flush(); },
    async documentEvent(name, value = {}) { for (const fn of documentEvents.get(name) || []) await fn({ type: name, ...value }); await flush(); },
    async tickIntervals() { for (const { fn, repeat } of [...timers.values()]) if (repeat) await fn(); await flush(); },
    async expireRequestTimeout() { const timeout = [...timers.entries()].find(([, t]) => !t.repeat && t.ms >= 1000); assert.ok(timeout, 'Request must have a bounded timeout'); timers.delete(timeout[0]); timeout[1].fn(); await flush(); },
    intervalCount() { return [...timers.values()].filter(timer => timer.repeat).length; },
  };
}

function waitingPopup() {
  const body = { textContent: '', children: [], replaceChildren(...children) { this.children = children; this.textContent = children.map(child => child.textContent).join('\n'); } };
  const popup = { document: { title: '', body, createElement(tag) { return { tag, textContent: '' }; } },
    closed: false, opener: {}, location: { href: 'about:blank', replace(url) { popup.navigated = url; this.href = url; } },
    close() { popup.closed = true; } };
  return popup;
}

function assertRetainedFailure(popup) {
  assert.equal(popup.closed, false);
  assert.equal(popup.navigated, undefined);
  assert.equal(popup.document.title, '平台连接未完成');
  assert.match(popup.document.body.textContent, /返回同步设置/);
  const back = popup.document.body.children.find(child => child.tag === 'a');
  assert.equal(back.href, 'https://fleet.example/sync');
  assert.doesNotMatch(popup.document.body.textContent, /PRIVATE|cookie|token|OLD_SESSION|unsafe-preview/);
}

test('reloading with an active login and no local URL leaves its resume control available', () => {
  const f = frontend();
  f.setState(statusFixture(loginActive()));
  assert.equal(f.nodes.get('login-link-boataround').hidden, true);
  assert.equal(f.nodes.get('connect-boataround').disabled, false);
  assert.match(f.nodes.get('connect-boataround').textContent, /重新打开/);
  assert.equal(f.nodes.get('connect-samboat').disabled, true);
  assert.equal(f.nodes.get('connect-clickandboat').disabled, true);
  assert.equal(f.calls.length, 0);
});

test('active platform connect click resumes its existing session; it never calls fresh login', async () => {
  const f = frontend(), active = loginActive();
  f.setState(statusFixture(active));
  f.setFetch(async (url) => new Response(JSON.stringify(url.endsWith('/resume')
    ? { status: 'login_required', liveViewUrl: 'https://live.browser.run/ui/view?wss=TEMPORARY', expiresAt: active.deadlineAt, deadlineAt: active.deadlineAt }
    : statusFixture(active))));
  await f.initialize();
  await f.nodes.get('connect-boataround').click();
  await flush();
  const posts = f.calls.filter(call => call.options.method === 'POST');
  assert.deepEqual(posts.map(call => call.url), ['/api/cloud-sync/resume']);
  assert.equal(posts[0].options.body, '{"source":"boataround"}');
  assert.equal(f.nodes.get('login-link-boataround').hidden, false);
  assert.match(f.nodes.get('login-link-boataround').href, /^https:\/\/live\.browser\.run\//);
  assert.equal(f.nodes.get('connect-boataround').disabled, false);
});

test('status polling never creates or resumes a session merely because its local URL is missing', async () => {
  const f = frontend();
  f.setState(statusFixture(loginActive()));
  await f.initialize();
  await f.tickIntervals();
  await f.tickIntervals();
  assert.ok(f.calls.length >= 2);
  assert.ok(f.calls.every(call => call.url === '/api/cloud-sync/status' && call.options.method !== 'POST'));
});

test('finishing and closing phases disable resume and finish, hide stale links, and show progress', () => {
  for (const phase of ['finishing', 'closing']) {
    const f = frontend();
    f.nodes.get('login-link-boataround').href = 'https://live.browser.run/ui/view?wss=OLD';
    f.nodes.get('login-link-boataround').hidden = false;
    f.setState(statusFixture(loginActive('boataround', phase)));
    assert.equal(f.nodes.get('connect-boataround').disabled, true, phase);
    assert.equal(f.nodes.get('finish-boataround').disabled, true, phase);
    assert.equal(f.nodes.get('login-link-boataround').hidden, true, phase);
    assert.match(f.nodes.get('connection-boataround').textContent, phase === 'closing' ? /关闭|取消/ : /确认|验证|完成/);
  }
});

test('cancel login is an explicit same-source POST and cannot silently launch a replacement', async () => {
  const f = frontend(), active = loginActive();
  assert.match(f.html, /id="cancel-boataround"/);
  f.setState(statusFixture(active));
  let cancelled = false;
  f.setFetch(async url => {
    if (url.endsWith('/cancel')) { cancelled = true; return new Response(JSON.stringify({ status: 'cancelled' })); }
    return new Response(JSON.stringify(statusFixture(cancelled ? null : active)));
  });
  await f.initialize();
  await f.nodes.get('cancel-boataround').click();
  await flush();
  assert.deepEqual(f.calls.filter(call => call.options.method === 'POST').map(call => [call.url, call.options.body]),
    [['/api/cloud-sync/cancel', '{"source":"boataround"}']]);
  assert.equal(f.nodes.get('login-link-boataround').hidden, true);
  assert.equal(f.nodes.get('connect-boataround').disabled, false);
  assert.match(f.nodes.get('operation-message').textContent, /本次登录已结束/);
});

test('late older status response cannot overwrite a newer recovery or finished state', async () => {
  const f = frontend(), oldRequest = deferred(), active = loginActive();
  let count = 0;
  f.setFetch(async () => ++count === 1 ? oldRequest.promise : new Response(JSON.stringify(statusFixture(active))));
  const old = f.context.refreshSyncStatus();
  const current = f.context.refreshSyncStatus();
  await current;
  assert.match(f.nodes.get('connection-boataround').textContent, /登录/);
  oldRequest.resolve(new Response(JSON.stringify(statusFixture(null))));
  await old;
  assert.match(f.nodes.get('connect-boataround').textContent, /重新打开/);
  assert.equal(f.nodes.get('connect-samboat').disabled, true);
});

test('a request timeout releases busy controls and reloads authoritative session status', async () => {
  const f = frontend(), active = loginActive();
  f.setState(statusFixture(active));
  f.setFetch(async (url, options) => {
    if (url.endsWith('/resume')) return new Promise((_, reject) => {
      assert.ok(options.signal, 'Recovery request must be abortable');
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    return new Response(JSON.stringify(statusFixture(active)));
  });
  const pending = f.context.performSyncAction('resume', 'boataround');
  await flush();
  assert.equal(f.nodes.get('connect-boataround').disabled, true);
  await f.expireRequestTimeout();
  await pending;
  assert.equal(f.nodes.get('connect-boataround').disabled, false);
  assert.ok(f.calls.some(call => call.url === '/api/cloud-sync/status'));
  assert.ok(f.calls.every(call => call.url !== '/api/cloud-sync/login'));
  assert.match(f.nodes.get('operation-message').textContent, /超时|重试|暂时|稍后/);
});

test('pagehide then pageshow restores one polling timer and immediately refreshes status', async () => {
  const f = frontend();
  await f.initialize();
  assert.equal(f.intervalCount(), 1);
  await f.event('pagehide', { persisted: true });
  assert.equal(f.intervalCount(), 0);
  const before = f.calls.length;
  await f.event('pageshow', { persisted: true });
  assert.equal(f.intervalCount(), 1);
  assert.ok(f.calls.length > before);
  await f.event('pageshow', { persisted: true });
  assert.equal(f.intervalCount(), 1);
  assert.ok(f.calls.every(call => call.url === '/api/cloud-sync/status'));
});

test('double resume clicks issue at most one recovery POST and display the original deadline', async () => {
  const f = frontend(), response = deferred(), active = loginActive();
  f.setState(statusFixture(active));
  f.setFetch(async url => url.endsWith('/resume') ? response.promise : new Response(JSON.stringify(statusFixture(active))));
  const first = f.context.performSyncAction('resume', 'boataround');
  const duplicate = f.context.performSyncAction('resume', 'boataround');
  await duplicate;
  response.resolve(new Response(JSON.stringify({ status: 'login_required', liveViewUrl: 'https://live.browser.run/ui/view?wss=TEMPORARY', deadlineAt: active.deadlineAt, expiresAt: active.deadlineAt })));
  await first;
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.ok(f.nodes.get('login-hint-boataround').textContent.includes(f.context.syncTime(active.deadlineAt)));
});

test('cancel close_pending remains visibly closing and cannot enable a new platform login', async () => {
  const f = frontend(), active = loginActive();
  f.setState(statusFixture(active));
  f.setFetch(async url => new Response(JSON.stringify(url.endsWith('/cancel') ? { status: 'close_pending' }
    : statusFixture({ ...active, phase: 'closing' }))));
  await f.context.performSyncAction('cancel', 'boataround');
  assert.match(f.nodes.get('operation-message').textContent, /正在关闭/);
  assert.ok(!f.nodes.get('operation-message').textContent.includes('已结束'));
  assert.equal(f.nodes.get('connect-boataround').disabled, true);
  assert.equal(f.nodes.get('connect-samboat').disabled, true);
  assert.equal(f.nodes.get('login-link-boataround').hidden, true);
});

test('a delayed resume URL from an earlier same-platform session is never opened for its replacement', async () => {
  const f = frontend(), earlier = loginActive(), replacement = { ...earlier, deadlineAt: earlier.deadlineAt + 60000 };
  f.setState(statusFixture(earlier));
  const popup = waitingPopup();
  f.context.window.open = () => popup;
  f.setFetch(async url => new Response(JSON.stringify(url.endsWith('/resume')
    ? { status: 'login_required', liveViewUrl: 'https://live.browser.run/ui/view?wss=OLD_SESSION', deadlineAt: earlier.deadlineAt, expiresAt: earlier.deadlineAt }
    : statusFixture(replacement))));
  await f.context.performSyncAction('resume', 'boataround');
  assertRetainedFailure(popup);
  assert.equal(f.nodes.get('login-link-boataround').hidden, true);
  assert.equal(f.nodes.get('connect-boataround').disabled, false);
  assert.ok(f.calls.every(call => call.url !== '/api/cloud-sync/login'));
});

test('an API failure retains a useful waiting window and restores usable recovery controls', async () => {
  const f = frontend(), active = loginActive();
  f.setState(statusFixture(active));
  const popup = waitingPopup();
  f.context.window.open = () => popup;
  f.setFetch(async url => url.endsWith('/resume')
    ? new Response(JSON.stringify({ error: 'PRIVATE_PROVIDER_ERROR' }), { status: 503 })
    : new Response(JSON.stringify(statusFixture(active))));
  await f.context.performSyncAction('resume', 'boataround');
  assertRetainedFailure(popup);
  assert.equal(f.nodes.get('connect-boataround').disabled, false);
  assert.ok(!f.nodes.get('operation-message').textContent.includes('PRIVATE'));
  assert.ok(f.calls.some(call => call.url.endsWith('/status')));
});

test('a popup blocker still leaves the same-session recovery anchor visible and usable', async () => {
  const f = frontend(), active = loginActive();
  f.setState(statusFixture(active));
  let attempted = 0;
  f.context.window.open = () => { attempted++; return null; };
  f.setFetch(async url => new Response(JSON.stringify(url.endsWith('/resume')
    ? { status: 'login_required', liveViewUrl: 'https://live.browser.run/ui/view?wss=POPUP_BLOCKED', deadlineAt: active.deadlineAt, expiresAt: active.deadlineAt }
    : statusFixture(active))));
  await f.context.performSyncAction('resume', 'boataround');
  assert.equal(attempted, 1);
  const anchor = f.nodes.get('login-link-boataround');
  assert.equal(anchor.hidden, false);
  assert.equal(anchor.href, 'https://live.browser.run/ui/view?wss=POPUP_BLOCKED');
  assert.match(f.html, /id="login-link-boataround"[^>]+target="_blank"[^>]+rel="noopener noreferrer"/);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('short login is visible only within its free budget range and while no session is active', () => {
  const f = frontend();
  for (const [remainingMs, expected] of [[109999, false], [110000, true], [184999, true], [185000, false], [null, false]]) {
    const state = statusFixture(); state.cloud.budget.remainingMs = remainingMs; f.setState(state);
    for (const source of ['boataround', 'clickandboat', 'samboat']) {
      assert.equal(f.nodes.get('short-connect-' + source).hidden, !expected);
      assert.equal(f.nodes.get('short-connect-' + source).disabled, !expected);
    }
    if (expected) assert.match(f.nodes.get('login-hint-boataround').textContent, /最多45秒.*加载.*核验.*保存.*手动输入时间可能更短/);
  }
  for (const patch of [{ active: loginActive() }, { active: { kind: 'manual', deadlineAt: Date.now() + 45000 } }, { budget: { remainingMs: 110000, blocked: 'suspended' } }]) {
    const state = statusFixture(); state.cloud.budget.remainingMs = 110000; Object.assign(state.cloud, patch); f.setState(state);
    assert.equal(f.nodes.get('short-connect-boataround').hidden, true);
    assert.equal(f.nodes.get('short-connect-boataround').disabled, true);
  }
});

test('explicit short button sends strict shortLogin true and shares popup and same-session recovery', async () => {
  const f = frontend(), state = statusFixture(), active = loginActive();
  state.cloud.budget.remainingMs = 110000; active.deadlineAt = Date.now() + 45000;
  let created = false, opened = 0, navigated;
  f.context.window.open = () => { opened++; return { closed: false, opener: {}, document: { title: '', body: { textContent: '' } }, location: { replace(url) { navigated = url; } }, close() { this.closed = true; } }; };
  f.setFetch(async url => {
    if (url.endsWith('/login') || url.endsWith('/resume')) {
      created = true; return new Response(JSON.stringify({ status: 'login_required', liveViewUrl: 'https://live.browser.run/ui/view?wss=SHORT_FIXTURE', expiresAt: active.deadlineAt, deadlineAt: active.deadlineAt }));
    }
    return new Response(JSON.stringify({ ...state, cloud: { ...state.cloud, active: created ? active : null } }));
  });
  await f.initialize();
  await f.nodes.get('short-connect-boataround').click();
  assert.equal(opened, 1);
  assert.equal(navigated, 'https://live.browser.run/ui/view?wss=SHORT_FIXTURE');
  assert.match(f.nodes.get('operation-message').textContent, /最多45秒.*加载.*核验.*保存.*手动输入时间可能更短/);
  assert.equal(f.nodes.get('short-connect-boataround').hidden, true);
  f.nodes.get('login-link-boataround').hidden = true;
  await f.nodes.get('connect-boataround').click();
  assert.deepEqual(f.calls.filter(call => call.options.method === 'POST').map(call => [call.url, JSON.parse(call.options.body)]), [
    ['/api/cloud-sync/login', { source: 'boataround', shortLogin: true }],
    ['/api/cloud-sync/resume', { source: 'boataround' }]
  ]);
  assert.equal(f.nodes.get('login-link-boataround').hidden, false);
});

test('short login rejects an unsafe live-view URL and cannot launch from a stale active-session state', async () => {
  const f = frontend(), state = statusFixture(); state.cloud.budget.remainingMs = 110000; f.setState(state);
  const popup = waitingPopup();
  f.context.window.open = () => popup;
  f.setFetch(async url => new Response(JSON.stringify(url.endsWith('/login')
    ? { status: 'login_required', liveViewUrl: 'https://example.invalid/unsafe-preview', expiresAt: Date.now() + 45000 }
    : state)));
  await f.context.performSyncAction('short-login', 'boataround');
  assertRetainedFailure(popup);
  assert.equal(f.nodes.get('login-link-boataround').hidden, true);
  const prior = f.calls.length; f.setState({ ...state, cloud: { ...state.cloud, active: loginActive() } });
  await f.context.performSyncAction('short-login', 'samboat');
  assert.equal(f.calls.length, prior, 'Stale short-entry calls must not launch or resume any browser');
});

test('insufficient budget retains the waiting window and does not retry a launch', async () => {
  const f = frontend(), popup = waitingPopup(), state = statusFixture();
  state.cloud.budget.remainingMs = 102000; f.setState(state);
  f.context.window.open = () => popup;
  f.setFetch(async url => new Response(JSON.stringify(url.endsWith('/login')
    ? { status: 'unavailable', reason: 'daily_budget', message: 'PRIVATE_PROVIDER_TOKEN' } : state)));
  await f.context.performSyncAction('login', 'boataround');
  assertRetainedFailure(popup);
  assert.match(f.nodes.get('operation-message').textContent, /预算不足/);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(f.nodes.get('connect-boataround').disabled, false);
});

test('request timeout retains the waiting window while recovering the still-active session', async () => {
  const f = frontend(), popup = waitingPopup(), active = loginActive();
  f.setState(statusFixture(active)); f.context.window.open = () => popup;
  f.setFetch(async (url, options) => url.endsWith('/resume')
    ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
    : new Response(JSON.stringify(statusFixture(active))));
  const pending = f.context.performSyncAction('resume', 'boataround');
  await flush(); await f.expireRequestTimeout(); await pending;
  assertRetainedFailure(popup);
  assert.equal(f.nodes.get('connect-boataround').disabled, false);
  assert.match(f.nodes.get('connect-boataround').textContent, /重新打开/);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('a manually closed waiting window is neither reopened nor touched by late results', async () => {
  for (const success of [false, true]) {
    const f = frontend(), popup = waitingPopup(), response = deferred(), active = loginActive();
    let opens = 0; f.context.window.open = () => { opens++; return popup; };
    f.setState(statusFixture());
    f.setFetch(async url => url.endsWith('/login') ? response.promise : new Response(JSON.stringify(statusFixture(success ? active : null))));
    const pending = f.context.performSyncAction('login', 'boataround'); await flush();
    popup.closed = true;
    Object.defineProperty(popup, 'document', { get() { throw Error('Closed window document must not be touched'); } });
    response.resolve(success
      ? new Response(JSON.stringify({ status: 'login_required', liveViewUrl: 'https://live.browser.run/ui/view?wss=LATE', deadlineAt: active.deadlineAt, expiresAt: active.deadlineAt }))
      : new Response(JSON.stringify({ error: 'PRIVATE' }), { status: 503 }));
    await pending;
    assert.equal(opens, 1); assert.equal(popup.navigated, undefined);
    assert.equal(f.nodes.get('connect-boataround').disabled, false);
    assert.equal(f.nodes.get('login-link-boataround').hidden, !success);
  }
});

test('a changed or inaccessible popup document cannot break maintenance recovery', async () => {
  for (const crossOrigin of [false, true]) {
    const f = frontend(), popup = waitingPopup(), response = deferred(), userDocument = { title: 'User page' };
    f.setState(statusFixture()); f.context.window.open = () => popup;
    f.setFetch(async url => url.endsWith('/login') ? response.promise : new Response(JSON.stringify(statusFixture())));
    const pending = f.context.performSyncAction('login', 'boataround'); await flush();
    if (crossOrigin) Object.defineProperty(popup, 'document', { get() { throw new DOMException('PRIVATE_CROSS_ORIGIN', 'SecurityError'); } });
    else { popup.document = userDocument; popup.location.href = 'https://fleet.example/'; }
    response.resolve(new Response(JSON.stringify({ error: 'PRIVATE_PROVIDER' }), { status: 503 }));
    await pending;
    assert.equal(userDocument.title, 'User page'); assert.equal(popup.closed, false);
    assert.equal(f.nodes.get('connect-boataround').disabled, false);
    assert.match(f.nodes.get('operation-message').textContent, /同步服务暂时不可用/);
    assert.doesNotMatch(f.nodes.get('operation-message').textContent, /PRIVATE/);
  }
});

test('successful handoff navigates once with no opener and never revisits the remote document', async () => {
  const f = frontend(), popup = waitingPopup(), active = loginActive();
  let navigations = 0;
  popup.location.replace = url => {
    navigations++; popup.navigated = url;
    Object.defineProperty(popup, 'document', { get() { throw Error('Remote document must not be inspected'); } });
  };
  f.setState(statusFixture()); f.context.window.open = () => popup;
  f.setFetch(async url => new Response(JSON.stringify(url.endsWith('/login')
    ? { status: 'login_required', liveViewUrl: 'https://live.browser.run/ui/view?wss=SUCCESS', deadlineAt: active.deadlineAt, expiresAt: active.deadlineAt }
    : statusFixture(active))));
  await f.context.performSyncAction('login', 'boataround');
  assert.equal(popup.opener, null); assert.equal(navigations, 1);
  assert.equal(popup.navigated, 'https://live.browser.run/ui/view?wss=SUCCESS');
  assert.equal(popup.closed, false);
  assert.equal(f.nodes.get('login-link-boataround').hidden, false);
  assert.equal(f.nodes.get('connect-boataround').disabled, false);
});
