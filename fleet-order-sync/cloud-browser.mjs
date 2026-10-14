import {
  FREE_BROWSER_POLICY, budgetSnapshot, nextScheduledAttemptAt, recordScheduledAttempt,
  reserveBrowserRun, settleBrowserRun, nextCoordinatorAlarm,
} from './cloud-browser-budget.mjs';

// This module only controls the application's own Cloudflare browser sessions.
// It never reads local browser profiles or accepts credentials from a request.
// The existing maintenance authentication must gate EVERY public entry point.
export const CLOUD_BROWSER_SOURCES = Object.freeze({
  boataround: Object.freeze({
    url: 'https://partner.boataround.com/en/000000000000000000000000/orders',
    origin: 'https://partner.boataround.com',
    cookieDomains: Object.freeze(['boataround.com', 'partner.boataround.com']),
  }),
  clickandboat: Object.freeze({
    url: 'https://www.clickandboat.com/uk/account/bookings',
    origin: 'https://www.clickandboat.com',
    cookieDomains: Object.freeze(['clickandboat.com', 'www.clickandboat.com']),
  }),
  samboat: Object.freeze({
    url: 'https://www.samboat.com/private/reservations',
    origin: 'https://www.samboat.com',
    cookieDomains: Object.freeze(['samboat.com', 'www.samboat.com']),
  }),
});

const PREFIX = 'browser-sync:';
const BUDGET_KEY = `${PREFIX}budget`;
const ACTIVE_KEY = `${PREFIX}active`;
const LOGIN_FAILURE_KEY = `${PREFIX}last-login-failure`;
const authKey = source => `${PREFIX}auth:${source}`;
const healthKey = source => `${PREFIX}health:${source}`;
const MAX_AUTH_BYTES = 100 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const RETRY_CLOSE_MS = 20 * 1000;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const sourceConfig = source => {
  if (!own(CLOUD_BROWSER_SOURCES, source)) throw new Error('invalid_source');
  return CLOUD_BROWSER_SOURCES[source];
};
const fault = code => Object.assign(new Error(code), { code });
const originOf = value => { try { return new URL(value).origin; } catch { return null; } };
const size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const beijingDay = now => new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const verifiedSessionAbsent = (sessions, sessionId) => Array.isArray(sessions)
  && sessions.every(item => typeof item?.sessionId === 'string' && item.sessionId.length > 0)
  && !sessions.some(item => item.sessionId === sessionId);

const LOGIN_STAGES = new Set(['launch', 'connect', 'pages', 'navigate', 'create_cdp',
  'get_live_view', 'validate_live_view', 'detach_cdp', 'update_state', 'disconnect']);
const LOGIN_FAILURE_CATEGORIES = new Set(['deadline_exceeded', 'session_expired',
  'missing_cloud_session', 'unexpected_page_count', 'invalid_live_view', 'timeout',
  'protocol', 'target_closed', 'type_error', 'aborted', 'provider_acquire',
  'provider_connect', 'navigation', 'unknown']);

// Never return remote messages, stacks, URLs, session IDs, or arbitrary fields.
// The two message prefixes below are the installed SDK's wrappers; they only
// classify a failure, and their potentially sensitive suffix is discarded.
function loginErrorCategory(error) {
  if (['deadline_exceeded', 'session_expired', 'missing_cloud_session',
    'unexpected_page_count', 'invalid_live_view'].includes(error?.code)) return { category: error.code };
  const message = typeof error?.message === 'string' ? error.message : '';
  const acquire = /^Unable to create new browser: code: ([0-9]{3}):/.exec(message);
  if (acquire) {
    const httpStatus = Number(acquire[1]);
    return { category: 'provider_acquire', ...(httpStatus >= 400 && httpStatus <= 599 ? { httpStatus } : {}) };
  }
  if (message.startsWith('Unable to connect to existing session ')) return { category: 'provider_connect' };
  const names = { TimeoutError: 'timeout', ProtocolError: 'protocol', TargetCloseError: 'target_closed',
    TypeError: 'type_error', AbortError: 'aborted' };
  if (own(names, error?.name)) return { category: names[error.name] };
  return { category: message.startsWith('net::ERR_') ? 'navigation' : 'unknown' };
}

function publicLoginFailure(value) {
  if (!value || !['start', 'resume'].includes(value.operation)
    || !own(CLOUD_BROWSER_SOURCES, value.source) || !LOGIN_STAGES.has(value.stage)
    || !LOGIN_FAILURE_CATEGORIES.has(value.category)
    || !Number.isSafeInteger(value.at) || value.at < 0
    || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0
    || typeof value.sessionIdentified !== 'boolean') return null;
  return { operation: value.operation, source: value.source, stage: value.stage,
    category: value.category, at: value.at, elapsedMs: value.elapsedMs,
    sessionIdentified: value.sessionIdentified,
    ...(Number.isInteger(value.httpStatus) && value.httpStatus >= 400 && value.httpStatus <= 599
      ? { httpStatus: value.httpStatus } : {}) };
}

// Official history has millisecond startTime/endTime and a closed reason. Use
// only a unique match for our current saved id, never a guessed historical run.
export function confirmedSessionHistory(history, run, now) {
  if (!Array.isArray(history) || typeof run?.sessionId !== 'string' || !run.sessionId
    || !Number.isSafeInteger(run.startedAt) || !Number.isSafeInteger(now)) return null;
  const matches = history.filter(item => item?.sessionId === run.sessionId);
  if (matches.length !== 1) return null;
  const record = matches[0];
  if (!Number.isSafeInteger(record.startTime) || !Number.isSafeInteger(record.endTime)
    || record.startTime < run.startedAt || record.endTime < record.startTime || record.endTime > now
    || !Number.isSafeInteger(record.closeReason) || record.closeReason < 1
    || typeof record.closeReasonText !== 'string' || !record.closeReasonText) return null;
  return { providerClosedAt: record.endTime };
}

// Only known domain cookies are saved. Third-party, malformed, expired, and
// partitioned cookies are excluded rather than broadened during restoration.
function checkedCookies(source, cookies, now) {
  const config = sourceConfig(source);
  if (!Array.isArray(cookies)) throw fault('invalid_cloud_auth');
  return cookies.filter(cookie => cookie && typeof cookie.name === 'string'
    && typeof cookie.value === 'string' && typeof cookie.domain === 'string'
    && config.cookieDomains.includes(cookie.domain.replace(/^\./, '').toLowerCase())
    && typeof cookie.path === 'string' && cookie.path.startsWith('/')
    && !cookie.partitionKey
    && (cookie.expires == null || cookie.expires === -1 || cookie.expires * 1000 > now)
  ).map(cookie => {
    const clean = { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path };
    for (const key of ['httpOnly', 'secure']) if (typeof cookie[key] === 'boolean') clean[key] = cookie[key];
    if (['Strict', 'Lax', 'None'].includes(cookie.sameSite)) clean.sameSite = cookie.sameSite;
    if (Number.isFinite(cookie.expires) && cookie.expires > 0) clean.expires = cookie.expires;
    return clean;
  });
}

function checkedAuth(source, state, now) {
  if (!state || state.version !== 1 || state.source !== source
    || state.origin !== sourceConfig(source).origin || !Array.isArray(state.localStorage)
    || !state.localStorage.every(row => Array.isArray(row) && row.length === 2
      && row.every(value => typeof value === 'string')) || size(state) > MAX_AUTH_BYTES) {
    throw fault('invalid_cloud_auth');
  }
  return { version: 1, source, origin: state.origin, capturedAt: state.capturedAt,
    cookies: checkedCookies(source, state.cookies, now), localStorage: state.localStorage };
}

// Cancel the operation at the work deadline. Closing the browser in finally is
// the enforcement mechanism when a hook does not cooperate with AbortSignal.
async function bounded(work, { now, deadlineAt, signal }) {
  if (signal?.aborted || now() >= deadlineAt) throw fault('deadline_exceeded');
  let timer;
  let abort;
  const timeout = new Promise((_, reject) => {
    abort = () => reject(fault('deadline_exceeded'));
    timer = setTimeout(abort, Math.max(1, deadlineAt - now()));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(work), timeout]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export class CloudBrowserController {
  constructor({ puppeteer, binding, storage, now = Date.now, uuid = () => crypto.randomUUID() }) {
    if (!puppeteer?.launch || !puppeteer?.connect || !storage?.transaction
      || !storage?.getAlarm || !storage?.setAlarm) throw new Error('invalid_cloud_browser_dependencies');
    this.puppeteer = puppeteer;
    this.binding = binding;
    this.storage = storage;
    this.now = now;
    this.uuid = uuid;
    this.live = new Map();
    this.closing = new Map();
  }

  async status() {
    const [ledger, active, sourceRows, loginFailure] = await Promise.all([
      this.storage.get(BUDGET_KEY), this.storage.get(ACTIVE_KEY),
      Promise.all(Object.keys(CLOUD_BROWSER_SOURCES).map(async source => {
        const health = await this.storage.get(healthKey(source));
        return [source, health ?? { status: 'auth_required', checkedAt: null }];
      })),
      this.storage.get(LOGIN_FAILURE_KEY),
    ]);
    return {
      budget: budgetSnapshot(ledger, this.now()), nextSyncAt: nextScheduledAttemptAt(ledger, this.now()),
      active: active ? { kind: active.kind, source: active.source, phase: active.phase, deadlineAt: active.deadlineAt } : null,
      sources: Object.fromEntries(sourceRows),
      lastLoginFailure: publicLoginFailure(loginFailure),
    };
  }

  _loginFailure(operation, source, stage, startedAt, run, error) {
    const at = this.now();
    return publicLoginFailure({ operation, source, stage, ...loginErrorCategory(error), at,
      elapsedMs: Math.max(0, at - startedAt), sessionIdentified: typeof run.sessionId === 'string' && !!run.sessionId });
  }

  async _recordLoginFailure(diagnostic) {
    if (!diagnostic) return;
    // Diagnostics must never prevent closing or turn a failed save into a
    // different login result. Persist only after the existing cleanup attempt.
    try { await this.storage.put(LOGIN_FAILURE_KEY, diagnostic); } catch { /* best effort */ }
  }

  async nextAlarmAt(nextSyncAt) {
    const active = await this.storage.get(ACTIVE_KEY);
    return nextCoordinatorAlarm({ now: this.now(), nextSyncAt,
      activeDeadlineAt: active ? (active.retryCloseAt ?? active.deadlineAt) : null });
  }

  async _arm(deadlineAt) {
    // Native DO alarms are durable. Preserve an earlier sync/alarm obligation.
    const existing = await this.storage.getAlarm();
    if (existing === null || existing > deadlineAt) await this.storage.setAlarm(deadlineAt);
  }

  async _reserve(kind, source = null, options = {}) {
    await this.closeExpiredSession();
    const id = this.uuid();
    const result = await this.storage.transaction(async txn => {
      if ((await txn.get('phone-agent:state'))?.mode === 'phone') return { allowed:false, reason:'phone_sync_selected', retryAt:null };
      const active = await txn.get(ACTIVE_KEY);
      if (active) {
        if (kind === 'scheduled') await txn.put(BUDGET_KEY, recordScheduledAttempt(await txn.get(BUDGET_KEY), this.now()));
        return { allowed: false, reason: 'session_in_progress', retryAt: active.retryCloseAt ?? active.deadlineAt };
      }
      const admission = reserveBrowserRun(await txn.get(BUDGET_KEY), { id, kind, now: this.now(),
        shortLogin: kind === 'login' && options?.shortLogin === true });
      await txn.put(BUDGET_KEY, admission.ledger);
      if (!admission.allowed) return { allowed: false, reason: admission.reason, retryAt: admission.retryAt };
      const run = { id, kind, source, sessionId: null, phase: 'launching',
        startedAt: admission.reservation.startedAt, deadlineAt: admission.reservation.workDeadlineAt,
        safeCloseAt: admission.reservation.safeCloseAt };
      await txn.put(ACTIVE_KEY, run);
      return { allowed: true, run };
    });
    if (result.allowed) {
      try { await this._arm(result.run.deadlineAt); }
      catch {
        // No launch has happened yet. Failure to arm the stop alarm fails closed.
        await this._settle(result.run, { definitelyNotLaunched: true });
        return { allowed: false, reason: 'alarm_unavailable', retryAt: null };
      }
    }
    return result;
  }

  async _changeRun(run, patch) {
    return this.storage.transaction(async txn => {
      const current = await txn.get(ACTIVE_KEY);
      if (!current || current.id !== run.id) throw fault('session_expired');
      if (patch.phase && patch.phase !== 'closing') {
        if (current.phase === 'closing') throw fault('session_expired');
        if (this.now() >= current.deadlineAt) throw fault('deadline_exceeded');
      }
      Object.assign(current, patch);
      await txn.put(ACTIVE_KEY, current);
      Object.assign(run, current);
      return current;
    });
  }

  async _settle(run, { closed = false, definitelyNotLaunched = false, absent = false, providerClosedAt = null } = {}) {
    await this.storage.transaction(async txn => {
      const ledger = await txn.get(BUDGET_KEY);
      await txn.put(BUDGET_KEY, settleBrowserRun(ledger, { id: run.id, now: this.now(), closed, definitelyNotLaunched, confirmedAbsent: absent, providerClosedAt }));
      const active = await txn.get(ACTIVE_KEY);
      if (active?.id !== run.id) return;
      if (closed || definitelyNotLaunched || absent) await txn.delete(ACTIVE_KEY);
      else await txn.put(ACTIVE_KEY, { ...active, phase: 'closing', retryCloseAt: this.now() + RETRY_CLOSE_MS });
    });
    if (!closed && !definitelyNotLaunched && !absent) await this._arm(this.now() + RETRY_CLOSE_MS);
  }

  async _settleConfirmedAbsent(run) {
    let evidence = null;
    if (run.sessionId && typeof this.puppeteer.history === 'function') {
      try {
        const history = await bounded(() => this.puppeteer.history(this.binding),
          { now: this.now, deadlineAt: this.now() + FREE_BROWSER_POLICY.closeGraceMs });
        evidence = confirmedSessionHistory(history, run, this.now());
      } catch { /* unknown or delayed provider history retains the full charge */ }
    }
    await this._settle(run, { absent: true, providerClosedAt: evidence?.providerClosedAt ?? null });
  }

  async _launch(run) {
    // Omitting keep_alive deliberately retains Cloudflare's 60s idle fallback.
    const browser = await this.puppeteer.launch(this.binding);
    this.live.set(run.id, { browser, abort: new AbortController() });
    try {
      const sessionId = browser.sessionId();
      if (typeof sessionId !== 'string' || !sessionId) throw fault('missing_cloud_session');
      // Record an id even if cancellation arrived while launch was pending, so
      // subsequent cleanup can still identify this exact provider session.
      run.sessionId = sessionId;
      await this._changeRun(run, { sessionId });
      await this._changeRun(run, { phase: run.kind === 'login' ? 'login' : 'sync' });
      if (this.now() >= run.deadlineAt) throw fault('deadline_exceeded');
      return browser;
    } catch (error) {
      await this._close(run, browser);
      throw error;
    }
  }

  async _connect(run, deadlineAt) {
    const browser = await this.puppeteer.connect(this.binding, run.sessionId);
    // Promise.race does not cancel the underlying connection request. Dispose a
    // late response immediately instead of resuming expired login/cleanup work.
    if (this.now() >= deadlineAt) {
      await this._close(run, browser);
      throw fault('deadline_exceeded');
    }
    return browser;
  }

  async _pages(browser, count) {
    // Reuse the initial about:blank instead of creating a fourth page for 3 sources.
    const existing = await browser.pages();
    if (existing.length > 3) throw fault('unexpected_page_count');
    const pages = existing.slice(0, count);
    while (pages.length < count) pages.push(await browser.newPage());
    for (const extra of existing.slice(count)) await extra.close();
    return pages;
  }

  async _restore(source, page, state) {
    if (!state) return;
    const saved = checkedAuth(source, state, this.now());
    if (saved.cookies.length) await page.setCookie(...saved.cookies.map(cookie => {
      if (cookie.domain.startsWith('.')) return cookie;
      // Preserve host-only cookies (including __Host-*) without broadening them.
      const { domain, ...rest } = cookie;
      return { ...rest, url: `https://${domain}${cookie.path}` };
    }));
    // Runs only in this platform's exact origin, never an SSO/third-party frame.
    return page.evaluateOnNewDocument((origin, entries) => {
      if (window.top !== window || location.origin !== origin) return;
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, saved.origin, saved.localStorage);
  }

  async _navigate(source, page, run) {
    const remaining = Math.max(1, run.deadlineAt - this.now());
    page.setDefaultTimeout(Math.min(15000, remaining));
    page.setDefaultNavigationTimeout(Math.min(25000, remaining));
    await page.goto(sourceConfig(source).url, { waitUntil: 'domcontentloaded', timeout: Math.min(25000, remaining) });
  }

  async _authenticated(source, page, verifyAuth) {
    return originOf(page.url()) === sourceConfig(source).origin && await verifyAuth(page) === true;
  }

  async _saveAuth(source, page, run) {
    if (this.now() >= run.deadlineAt) throw fault('deadline_exceeded');
    if (originOf(page.url()) !== sourceConfig(source).origin) throw fault('auth_required');
    const raw = await page.evaluate(() => JSON.stringify({ origin: location.origin, localStorage: Object.entries(localStorage) }));
    const local = JSON.parse(raw);
    const state = checkedAuth(source, { version: 1, source, origin: local.origin,
      localStorage: local.localStorage, cookies: await page.cookies(sourceConfig(source).url), capturedAt: this.now() }, this.now());
    await this.storage.transaction(async txn => {
      const active = await txn.get(ACTIVE_KEY);
      if (this.now() >= run.deadlineAt) throw fault('deadline_exceeded');
      if (active?.id !== run.id || active.phase === 'closing') throw fault('session_expired');
      await txn.put(authKey(source), state);
      await txn.put(healthKey(source), { status: 'connected', checkedAt: this.now() });
    });
  }

  async _health(source, status) {
    await this.storage.put(healthKey(source), { status, checkedAt: this.now() });
  }

  async _close(run, browser = this.live.get(run.id)?.browser) {
    if (this.closing.has(run.id)) return this.closing.get(run.id);
    const closing = (async () => {
      this.live.get(run.id)?.abort.abort();
      try {
        if (!browser) throw fault('cloud_session_unavailable');
        const closeDeadlineAt = this.now() + FREE_BROWSER_POLICY.closeGraceMs;
        await bounded(() => browser.close(), { now: this.now, deadlineAt: closeDeadlineAt });
        // @cloudflare/puppeteer 1.4.0 swallows Browser.close protocol errors.
        // A resolved close is therefore insufficient proof that billing stopped.
        // Keep this verification inside the same reserved close-grace window.
        if (!run.sessionId) throw fault('cloud_session_unverified');
        const sessions = await bounded(() => this.puppeteer.sessions(this.binding),
          { now: this.now, deadlineAt: closeDeadlineAt });
        if (!verifiedSessionAbsent(sessions, run.sessionId)) {
          throw fault('cloud_session_unverified');
        }
        this.live.delete(run.id);
        await this._settle(run, { closed: true });
        return true;
      } catch {
        // A failing close is not a refund. Keep the durable lock for an alarm retry.
        try { await browser?.disconnect(); } catch { /* no credential-bearing errors */ }
        this.live.delete(run.id);
        await this._settle(run);
        return false;
      }
    })();
    this.closing.set(run.id, closing);
    try { return await closing; } finally { this.closing.delete(run.id); }
  }

  async closeExpiredSession(expectedRunId = null) {
    const run = await this.storage.get(ACTIVE_KEY);
    if (expectedRunId !== null && run?.id !== expectedRunId) return { status: 'idle' };
    if (!run || this.now() < (run.retryCloseAt ?? run.deadlineAt)) return { status: run ? 'active' : 'idle' };
    try { await this._changeRun(run, { phase: 'closing' }); }
    catch (error) { if (error?.code === 'session_expired') return { status: 'idle' }; throw error; }
    let browser = this.live.get(run.id)?.browser;
    if (!browser && run.sessionId) {
      const connectDeadlineAt = this.now() + FREE_BROWSER_POLICY.closeGraceMs;
      try { browser = await bounded(() => this._connect(run, connectDeadlineAt),
        { now: this.now, deadlineAt: connectDeadlineAt }); }
      catch {
        // Only inspect our exact saved session. Never reuse or terminate another
        // Cloudflare session belonging to the account.
        try {
          const sessions = await bounded(() => this.puppeteer.sessions(this.binding),
            { now: this.now, deadlineAt: this.now() + FREE_BROWSER_POLICY.closeGraceMs });
          if (verifiedSessionAbsent(sessions, run.sessionId)) {
            await this._settleConfirmedAbsent(run);
            return { status: 'closed', verifiedAbsent: true };
          }
        } catch { /* keep the lock when the provider cannot confirm closure */ }
      }
    }
    if (browser) return { status: await this._close(run, browser) ? 'closed' : 'close_pending' };
    if (!run.sessionId && this.now() >= run.safeCloseAt) {
      // An ambiguous launch without an id has had the entire idle fallback.
      // Retain the full precharge; never credit this as a successful sync.
      await this._settle(run, { absent: true });
      return { status: 'closed', verifiedAbsent: false };
    }
    await this._settle(run);
    return { status: 'close_pending' };
  }

  async startLogin(source, options = {}) {
    sourceConfig(source);
    const admission = await this._reserve('login', source, { shortLogin: options?.shortLogin === true });
    if (!admission.allowed) return { status: 'unavailable', reason: admission.reason, retryAt: admission.retryAt };
    const { run } = admission;
    let browser;
    let handedOff = false;
    let stage = 'launch';
    let diagnostic = null;
    try {
      return await bounded(async () => {
        browser = await this._launch(run);
        stage = 'pages';
        const [page] = await this._pages(browser, 1);
        stage = 'navigate';
        await this._navigate(source, page, run);
        stage = 'create_cdp';
        const cdp = await page.createCDPSession();
        const expiresInMs = Math.max(1, run.deadlineAt - this.now());
        stage = 'get_live_view';
        const { devtoolsFrontendUrl } = await cdp.send('Cloudflare.getLiveView', { mode: 'tab', expiresInMs });
        stage = 'validate_live_view';
        if (originOf(devtoolsFrontendUrl) !== 'https://live.browser.run') throw fault('invalid_live_view');
        stage = 'detach_cdp';
        await cdp.detach();
        stage = 'update_state';
        await this._changeRun(run, { phase: 'login' });
        stage = 'disconnect';
        await browser.disconnect();
        this.live.delete(run.id);
        handedOff = true;
        // This temporary capability is the sole secret intentionally returned,
        // and ONLY to the authenticated maintenance operator. Never log it.
        return { status: 'login_required', liveViewUrl: devtoolsFrontendUrl,
          expiresAt: run.deadlineAt, deadlineAt: run.deadlineAt };
      }, { now: this.now, deadlineAt: run.deadlineAt });
    } catch (error) {
      diagnostic = this._loginFailure('start', source, stage, run.startedAt, run, error);
      return { status: 'unavailable', reason: error?.code === 'deadline_exceeded' ? 'deadline_exceeded' : 'cloud_browser_unavailable', diagnostic };
    } finally {
      try { if (!handedOff) await this._close(run, browser); }
      finally { await this._recordLoginFailure(diagnostic); }
    }
  }

  async resumeLogin(source) {
    sourceConfig(source);
    const claim = await this.storage.transaction(async txn => {
      const active = await txn.get(ACTIVE_KEY);
      if (!active || active.kind !== 'login' || active.source !== source) return { reason: 'no_active_login' };
      if (this.now() >= active.deadlineAt) return { reason: 'deadline_exceeded', expired: true, runId: active.id };
      if (active.phase !== 'login') return { reason: active.phase === 'closing' ? 'close_pending' : 'session_in_progress' };
      if (!active.sessionId) return { reason: 'cloud_browser_unavailable', expired: true, runId: active.id };
      const run = { ...active, phase: 'resuming' };
      await txn.put(ACTIVE_KEY, run);
      return { run };
    });
    if (!claim.run) {
      if (claim.expired) await this.cancelLogin(source, claim.runId);
      return { status: 'unavailable', reason: claim.reason };
    }
    const { run } = claim;
    const startedAt = this.now();
    let browser;
    let handedOff = false;
    let stage = 'connect';
    let diagnostic = null;
    try {
      return await bounded(async () => {
        browser = await this._connect(run, run.deadlineAt);
        this.live.set(run.id, { browser, abort: new AbortController() });
        stage = 'update_state';
        await this._changeRun(run, { phase: 'resuming' });
        stage = 'pages';
        const pages = await browser.pages();
        if (!pages.length || pages.length > 3) throw fault('unexpected_page_count');
        // Preserve an in-progress login/MFA page; never navigate or open a tab.
        const page = pages.find(candidate => originOf(candidate.url()) === sourceConfig(source).origin) || pages[0];
        stage = 'create_cdp';
        const cdp = await page.createCDPSession();
        let liveViewUrl;
        let liveViewFailed = false;
        try {
          stage = 'get_live_view';
          const remaining = run.deadlineAt - this.now();
          if (remaining <= 0) throw fault('deadline_exceeded');
          const response = await cdp.send('Cloudflare.getLiveView', { mode: 'tab', expiresInMs: remaining });
          liveViewUrl = response.devtoolsFrontendUrl;
          stage = 'validate_live_view';
          if (originOf(liveViewUrl) !== 'https://live.browser.run') throw fault('invalid_live_view');
        } catch (error) {
          // Keep the primary failure's stage even when detach cleanup also fails.
          liveViewFailed = true;
          diagnostic = this._loginFailure('resume', source, stage, startedAt, run, error);
          throw error;
        } finally {
          if (!liveViewFailed) stage = 'detach_cdp';
          await cdp.detach();
        }
        stage = 'disconnect';
        await browser.disconnect();
        this.live.delete(run.id);
        stage = 'update_state';
        await this._changeRun(run, { phase: 'login' });
        handedOff = true;
        return { status: 'login_required', liveViewUrl, expiresAt: run.deadlineAt, deadlineAt: run.deadlineAt };
      }, { now: this.now, deadlineAt: run.deadlineAt });
    } catch (error) {
      diagnostic ??= this._loginFailure('resume', source, stage, startedAt, run, error);
      return { status: 'unavailable', reason: error?.code === 'deadline_exceeded' ? 'deadline_exceeded' : 'cloud_browser_unavailable', diagnostic };
    } finally {
      try { if (!handedOff) await this._close(run, browser); }
      finally { await this._recordLoginFailure(diagnostic); }
    }
  }

  async cancelLogin(source, expectedRunId = null) {
    sourceConfig(source);
    const run = await this.storage.transaction(async txn => {
      const active = await txn.get(ACTIVE_KEY);
      if (!active || active.kind !== 'login' || active.source !== source
        || (expectedRunId !== null && active.id !== expectedRunId)) return null;
      const cancelled = { ...active, phase: 'closing', retryCloseAt: this.now(),
        deadlineAt: Math.min(active.deadlineAt, this.now()) };
      await txn.put(ACTIVE_KEY, cancelled);
      return cancelled;
    });
    if (!run) return { status: 'unavailable', reason: 'no_active_login' };
    this.live.get(run.id)?.abort.abort();
    const result = await this.closeExpiredSession(run.id);
    return { status: result.status === 'closed' || result.status === 'idle' ? 'cancelled' : 'close_pending' };
  }

  async finishLogin(source, verifyAuth) {
    sourceConfig(source);
    if (typeof verifyAuth !== 'function') throw new Error('missing_auth_verifier');
    await this.closeExpiredSession();
    const run = await this.storage.transaction(async txn => {
      const active = await txn.get(ACTIVE_KEY);
      if (!active || active.kind !== 'login' || active.source !== source
        || active.phase !== 'login' || this.now() >= active.deadlineAt) return null;
      await txn.put(ACTIVE_KEY, { ...active, phase: 'finishing' });
      return { ...active, phase: 'finishing' };
    });
    if (!run) return { status: 'auth_required', reason: 'no_active_login' };
    let browser;
    let keepOpen = false;
    try {
      return await bounded(async () => {
        browser = await this._connect(run, run.deadlineAt);
        this.live.set(run.id, { browser, abort: new AbortController() });
        const pages = await browser.pages();
        if (pages.length > 3) throw fault('unexpected_page_count');
        const page = pages.find(candidate => originOf(candidate.url()) === sourceConfig(source).origin);
        // The operator pressed Finish; return to the fixed orders page so the
        // verifier can prove both the signed-in identity and the fleet account.
        if (page) await this._navigate(source, page, run);
        if (!page || !await this._authenticated(source, page, verifyAuth)) {
          await this._health(source, 'auth_required');
          await this._changeRun(run, { phase: 'login' });
          await browser.disconnect();
          this.live.delete(run.id);
          keepOpen = true;
          return { status: 'auth_required', deadlineAt: run.deadlineAt };
        }
        await this._saveAuth(source, page, run);
        return { status: 'connected' };
      }, { now: this.now, deadlineAt: run.deadlineAt });
    } catch {
      await this._health(source, 'auth_required');
      return { status: 'auth_required', reason: 'cloud_login_not_verified' };
    } finally {
      if (!keepOpen) await this._close(run, browser);
    }
  }

  async runSync({ collectors, verifyAuth, kind = 'scheduled' }) {
    if (!['scheduled', 'manual'].includes(kind)) throw new Error('invalid_sync_kind');
    const fromDay = beijingDay(this.now()-86400000);
    const results = {};
    const states = {};
    for (const source of Object.keys(CLOUD_BROWSER_SOURCES)) {
      const [state, health] = await Promise.all([this.storage.get(authKey(source)), this.storage.get(healthKey(source))]);
      if (!state || health?.status !== 'connected') { results[source] = { status: 'auth_required' }; continue; }
      if (typeof collectors?.[source] !== 'function' || typeof verifyAuth?.[source] !== 'function') {
        results[source] = { status: 'collector_unavailable' }; continue;
      }
      try { states[source] = checkedAuth(source, state, this.now()); }
      catch { results[source] = { status: 'auth_required' }; await this._health(source, 'auth_required'); }
    }
    const sources = Object.keys(states);
    if (!sources.length) {
      // Scheduling continues even before the first cloud login, without launching.
      if (kind === 'scheduled') await this.storage.transaction(async txn => {
        await txn.put(BUDGET_KEY, recordScheduledAttempt(await txn.get(BUDGET_KEY), this.now()));
      });
      return { status: 'auth_required', fromDay, sources: results };
    }
    const admission = await this._reserve(kind);
    if (!admission.allowed) return { status: 'skipped', reason: admission.reason, retryAt: admission.retryAt, fromDay, sources: results };
    const { run } = admission;
    let browser;
    try {
      await bounded(async () => {
        browser = await this._launch(run);
        const { abort } = this.live.get(run.id);
        const pages = await this._pages(browser, sources.length);
        await Promise.all(sources.map(async (source, index) => {
          const page = pages[index];
          try {
            await bounded(async () => {
              const restoreScript = await this._restore(source, page, states[source]);
              try { await this._navigate(source, page, run); }
              finally {
                // Do not overwrite refreshed tokens on later collector navigations.
                if (restoreScript?.identifier) await page.removeScriptToEvaluateOnNewDocument(restoreScript.identifier);
              }
              if (!await this._authenticated(source, page, verifyAuth[source])) throw fault('auth_required');
              const snapshot = await collectors[source]({ page, browser, signal: abort.signal,
                deadlineAt: run.deadlineAt, fromDay });
              if (!snapshot || !Array.isArray(snapshot.orders) || size(snapshot) > MAX_SNAPSHOT_BYTES) throw fault('invalid_snapshot');
              // Capture only after account verification. Snapshot completeness and
              // paid/cancelled semantics remain the registry validator's job.
              await this._saveAuth(source, page, run);
              results[source] = { status: 'collected', snapshot };
            }, { now: this.now, deadlineAt: run.deadlineAt, signal: abort.signal });
          } catch (error) {
            const status = error?.code === 'auth_required' ? 'auth_required'
              : error?.code === 'deadline_exceeded' ? 'timed_out' : 'collection_failed';
            if (status === 'auth_required') await this._health(source, 'auth_required');
            results[source] = { status };
          }
        }));
      }, { now: this.now, deadlineAt: run.deadlineAt });
    } catch (error) {
      for (const source of sources) if (!results[source]) results[source] = {
        status: error?.code === 'deadline_exceeded' ? 'timed_out' : 'cloud_browser_unavailable',
      };
    } finally {
      await this._close(run, browser);
    }
    return { status: 'finished', fromDay, sources: results };
  }
}
