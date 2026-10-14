#!/usr/bin/env node
// Local Android Chrome bridge. Optional scoped root background preparation; no pairing, key export, legacy TCP/IP
// mode, LAN scan, credential-lock bypass, or security-setting changes.
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LOOPBACK = '127.0.0.1';
const PREFIX = '/data/data/com.termux/files/usr';
const REMOTE = 'localabstract:chrome_devtools_remote';
const DEFAULT_RANGE = [32768, 60999];
const EXPECTED_SERIAL = 'YOUR_DEVICE_SERIAL';
const ADB_SERVER_PORT = 5037;

export async function prepareChromeBackground({signal,execute=execFile}={}) {
  const run=(command)=>{
    // A previous command can finish at the same time as shutdown. Recheck at
    // every launch boundary so even a successful late callback cannot issue
    // another root mutation after the owning synchronization run is cancelled.
    ensureActive(signal);
    return new Promise((resolve,reject)=>execute('su',['-c',command],{shell:false,timeout:4000,maxBuffer:65536,signal,windowsHide:true},(error,stdout)=>error?reject(error):resolve(stdout)));
  };
  try {
    ensureActive(signal);
    const output=await run('ps -A -o PID,NAME');
    const pids=output.split('\n').map(line=>line.trim().match(/^([1-9][0-9]*)\s+(com\.android\.chrome(?::[^\s]+)?)$/)).filter(Boolean).map(m=>m[1]).slice(0,12);
    if(!pids.length)return {rootAvailable:true,unfrozen:0};
    await run('cmd deviceidle whitelist +com.android.chrome');
    let unfrozen=0;const releasedUids=new Set();
    for(const pid of pids){ensureActive(signal);try{
      await run('cmd activity unfreeze --sticky '+pid);unfrozen++;
      // Oplus may freeze the parent application UID even when Android has
      // unfrozen its individual process. Touch only the verified Chrome UID.
      const uid=(await run('cat /proc/'+pid+'/status')).match(/^Uid:\s+([0-9]+)/m)?.[1];
      if(uid&&Number(uid)>=10000&&Number(uid)<=199999&&!releasedUids.has(uid)){
        const file='/sys/fs/cgroup/apps/uid_'+uid+'/cgroup.freeze';
        await run('test "$(awk \'/^Uid:/{print $2}\' /proc/'+pid+'/status)" = '+uid+' && if [ -w '+file+' ]; then echo 0 > '+file+'; fi');
        releasedUids.add(uid);
      }
    }catch{ensureActive(signal);}}
    return {rootAvailable:true,unfrozen};
  }catch{ensureActive(signal);return {rootAvailable:false,unfrozen:0};}
}

export function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function parsePortRange(value) {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(value);
  if (!match) return null;
  const range = [Number(match[1]), Number(match[2])];
  return range.every(validPort) && range[0] <= range[1] ? range : null;
}

function abortError() {
  return Object.assign(new Error('Bridge attempt cancelled or timed out.'), { code: 'ABORTED' });
}

function ensureActive(signal) {
  if (signal?.aborted) throw abortError();
}

// Fixed numeric loopback address: never resolves a hostname or accesses LAN.
// The probe establishes and immediately closes TCP; it sends no application data.
export function probeLoopback(port, { signal, timeoutMs = 150 } = {}) {
  if (!validPort(port)) return Promise.reject(new Error('Invalid port.'));
  ensureActive(signal);
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = new net.Socket();
    const finish = (open, cancelled = false) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      cancelled ? reject(abortError()) : resolve(open);
    };
    const onAbort = () => finish(false, true);
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => finish(true));
    socket.connect({ host: LOOPBACK, port, family: 4 });
    if (signal?.aborted) onAbort();
  });
}

export async function scanLoopback(range, {
  signal, concurrency = 8, timeoutMs = 150, maxCandidates = 32,
  probe = probeLoopback,
} = {}) {
  if (!Array.isArray(range) || range.length !== 2 || !range.every(validPort) || range[0] > range[1]) {
    throw new Error('Invalid local port range.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid concurrency.');
  let next = range[0];
  const open = [];
  let tooMany = false;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next <= range[1] && !tooMany) {
      ensureActive(signal);
      const port = next++;
      if (await probe(port, { signal, timeoutMs })) {
        open.push(port);
        if (open.length > maxCandidates) tooMany = true;
      }
    }
  }));
  ensureActive(signal);
  if (tooMany) throw Object.assign(new Error('Too many local services; manual port needed.'), { code: 'TOO_MANY_CANDIDATES' });
  return open.sort((a, b) => a - b);
}

export function adbEnvironment({ bootstrapServer = false, environment = process.env } = {}) {
  const env = { ...environment };
  for (const key of ['ADB_SERVER_SOCKET', 'ADB_SERVER_HOST', 'ADB_SERVER_PORT', 'ANDROID_ADB_SERVER_ADDRESS', 'ANDROID_ADB_SERVER_HOST', 'ANDROID_ADB_SERVER_PORT']) delete env[key];
  if (!bootstrapServer) env.ADB_SERVER_SOCKET = 'tcp:127.0.0.1:5037';
  return env;
}

export function runAdb(args, { signal, timeoutMs = 4000, adb = `${PREFIX}/bin/adb`, bootstrapServer = false, execFileImpl = execFile } = {}) {
  ensureActive(signal);
  if (bootstrapServer && JSON.stringify(args) !== JSON.stringify(['-L', 'tcp:localhost:5037', 'start-server'])) throw new Error('Invalid local ADB startup command.');
  return new Promise((resolve, reject) => {
    // Starting requires ADB's literal localhost socket spec; numeric 127 is
    // treated as remote by this build. Regular clients still use fixed 127.
    execFileImpl(adb, args, {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024,
      windowsHide: true, signal, shell: false,
      env: adbEnvironment({ bootstrapServer }),
    }, (error, stdout) => {
      if (signal?.aborted) return reject(abortError());
      if (error) return reject(Object.assign(new Error('Local ADB command failed or timed out.'), { code: 'ADB_COMMAND_FAILED' }));
      resolve(stdout.trim());
    });
  });
}

// A direct read-only smart-socket check does not auto-start or kill a server.
// Only a refused connection means absent; another or unresponsive listener is
// left untouched. ADB's CLI may kill a mismatched server during version checks.
export function readAdbServerVersion({ signal, port = ADB_SERVER_PORT, timeoutMs = 1500 } = {}) {
  if (!validPort(port)) throw new Error('Invalid local ADB port.');
  ensureActive(signal);
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();let done = false, connected = false, bytes = Buffer.alloc(0);
    const unverified = () => Object.assign(new Error('Local ADB listener could not be verified; left unchanged.'), { code: 'ADB_SERVER_UNVERIFIED' });
    const finish = (value, error) => {
      if (done) return;done = true;clearTimeout(timer);signal?.removeEventListener('abort', cancel);socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const cancel = () => finish(null, abortError());
    const timer = setTimeout(() => finish(null, unverified()), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    socket.once('connect', () => { connected = true;socket.write('000Chost:version'); });
    socket.on('data', chunk => {
      if (bytes.length + chunk.length > 12) return finish(null, unverified());
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') !== 'OKAY') return finish(null, unverified());
      if (bytes.length >= 8 && bytes.subarray(4, 8).toString('latin1') !== '0004') return finish(null, unverified());
      if (bytes.length === 12) {
        const version = bytes.subarray(8).toString('latin1');
        if (!/^[0-9a-fA-F]{4}$/.test(version) || parseInt(version, 16) === 0) return finish(null, unverified());
        finish(parseInt(version, 16));
      }
    });
    socket.once('error', error => finish(null, !connected && error.code === 'ECONNREFUSED' ? null : unverified()));
    socket.once('end', () => finish(null, unverified()));
    socket.once('close', () => { if (!done) finish(null, unverified()); });
    socket.connect({ host: LOOPBACK, port, family: 4 });
    if (signal?.aborted) cancel();
  });
}

export async function ensureLocalAdbServer({ signal, command = runAdb, readVersion = readAdbServerVersion } = {}) {
  ensureActive(signal);
  // `version` reads the installed binary's version without contacting a server.
  const output = await command(['version'], { signal, timeoutMs: 2500 });
  const version = /^Android Debug Bridge version 1\.0\.(\d+)\s*$/m.exec(output);
  if (!version || Number(version[1]) < 1 || Number(version[1]) > 65535) throw Object.assign(new Error('Installed ADB protocol version is unknown.'), { code: 'ADB_VERSION_UNKNOWN' });
  const expected = Number(version[1]);
  const existing = await readVersion({ signal });
  ensureActive(signal);
  if (existing !== null) {
    if (existing !== expected) throw Object.assign(new Error('Existing ADB server version differs; left unchanged.'), { code: 'ADB_SERVER_CONFLICT' });
    return { started: false };
  }
  ensureActive(signal);
  await command(['-L', 'tcp:localhost:5037', 'start-server'], { signal, timeoutMs: 10000, bootstrapServer: true });
  ensureActive(signal);
  const afterStart = await readVersion({ signal });ensureActive(signal);
  if (afterStart !== expected) throw Object.assign(new Error('Local ADB startup was not verified.'), { code: 'ADB_SERVER_NOT_READY' });
  return { started: true };
}

export async function verifyAdbPort(port, { signal, command = runAdb } = {}) {
  if (!validPort(port)) return false;
  const target = `${LOOPBACK}:${port}`;
  try {
    await command(['connect', target], { signal, timeoutMs: 5000 });
    ensureActive(signal);
    if (await command(['-s', target, 'get-state'], { signal, timeoutMs: 2500 }) !== 'device') return false;
    // The existing pairing key must authorize a real shell on this exact phone.
    // Never print the hardware identity in progress/error output.
    const serial = await command(['-s', target, 'shell', '-n', 'getprop', 'ro.serialno'], { signal, timeoutMs: 2500 });
    return serial === EXPECTED_SERIAL;
  } catch (error) {
    ensureActive(signal);
    return false;
  }
}

export function parseKeyguardPolicy(value) {
  const lines = String(value).split(/\r?\n/);
  const indices = lines.map((line, index) => line.trim() === 'KeyguardServiceDelegate' ? index : -1).filter((index) => index >= 0);
  const fail = () => { throw Object.assign(new Error('Cannot verify Android keyguard state.'), { code: 'SCREEN_STATE_UNAVAILABLE' }); };
  if (indices.length !== 1) fail();
  const heading = indices[0];
  const indent = /^ */.exec(lines[heading])[0].length;
  const fields = {};
  for (const line of lines.slice(heading + 1)) {
    if (!line.trim()) continue;
    const leading = /^ */.exec(line)[0].length;
    if (leading <= indent) break;
    // Read only immediate children of this block, not nested monitors or other sections.
    if (leading !== indent + 2) continue;
    const match = /^(showing|secure|interactiveState)=(.*)$/.exec(line.trim());
    if (!match) continue;
    if (Object.hasOwn(fields, match[1])) fail();
    fields[match[1]] = match[2];
  }
  if (!['true', 'false'].includes(fields.showing) || !['true', 'false'].includes(fields.secure)) fail();
  if (!['INTERACTIVE_STATE_SLEEP', 'INTERACTIVE_STATE_WAKING', 'INTERACTIVE_STATE_AWAKE', 'INTERACTIVE_STATE_GOING_TO_SLEEP'].includes(fields.interactiveState)) fail();
  return { showing: fields.showing === 'true', secure: fields.secure === 'true', interactiveState: fields.interactiveState };
}

function pause(ms, signal) {
  ensureActive(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(abortError()); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

export function validChromeEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' && url.hostname === LOOPBACK && url.port === '9222' &&
      !url.username && !url.password && !url.search && !url.hash &&
      /^\/devtools\/browser(?:\/[A-Za-z0-9-]+)?$/.test(url.pathname);
  } catch { return false; }
}

async function readChromeJSON(signal, fetchImpl, route='/json/version') {
  if(!['/json/version','/json/list'].includes(route))throw Error('Invalid Chrome read route.');
  const response = await fetchImpl('http://127.0.0.1:9222'+route, { method: 'GET', redirect: 'error', signal });
  if (response.status !== 200 || !response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return false;
  const reader = response.body.getReader(), chunks = [];let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) { await reader.cancel().catch(() => {});return false; }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return data;
}

async function readChromeVersion(signal,fetchImpl){const data=await readChromeJSON(signal,fetchImpl);return validChromeEndpoint(data?.webSocketDebuggerUrl)?data:null;}

async function probeChromeReady(signal,fetchImpl){return !!await readChromeVersion(signal,fetchImpl);}

export async function waitChromeCdpReady({ signal, timeoutMs = 8000, fetchImpl = fetch, now = () => performance.now(), sleep = pause } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw new Error('Invalid Chrome readiness limit.');
  ensureActive(signal);
  const deadline = now() + timeoutMs, budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
  const notReady = () => Object.assign(new Error('Local Chrome DevTools did not become ready in time.'), { code: 'CDP_NOT_READY' });
  try {
    for (;;) {
      ensureActive(signal);
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0 || budget.signal.aborted) throw notReady();
      try {
        const requestSignal = AbortSignal.any([combined, AbortSignal.timeout(Math.min(1500, remaining))]);
        if (await probeChromeReady(requestSignal, fetchImpl)) {
          ensureActive(signal);
          if (!budget.signal.aborted && now() <= deadline) return true;
        }
      } catch { ensureActive(signal); }
      const delay = Math.min(250, Math.floor(deadline - now()));
      if (delay <= 0 || budget.signal.aborted) throw notReady();
      await sleep(delay, combined);
    }
  } catch { ensureActive(signal);throw notReady(); }
  finally { clearTimeout(timer); }
}

export async function wakeChrome(port, {
  signal, command = runAdb, pollTimeoutMs = 5000,
  now = () => performance.now(), sleep = pause,
} = {}) {
  if (!validPort(port)) throw new Error('Invalid bridge port.');
  const target = `${LOOPBACK}:${port}`;
  return wakeVerifiedChrome({signal,pollTimeoutMs,now,sleep,
    command:(args,options)=>command(['-s',target,'shell','-n',...args],options)});
}

async function wakeVerifiedChrome({signal,command,pollTimeoutMs=5000,now=()=>performance.now(),sleep=pause}) {
  if (!Number.isInteger(pollTimeoutMs) || pollTimeoutMs < 1 || pollTimeoutMs > 5000) throw new Error('Invalid screen polling limit.');
  ensureActive(signal);
  // Recheck identity for callers using this export without discoverAdbPort.
  const serial = await command(['getprop', 'ro.serialno'], { signal, timeoutMs: 2500 });
  if (serial !== EXPECTED_SERIAL) {
    throw Object.assign(new Error('Authorized ADB target is not the configured phone.'), { code: 'DEVICE_MISMATCH' });
  }
  ensureActive(signal);
  const readState = async (timeoutMs = 2500) => parseKeyguardPolicy(await command([
    'dumpsys', 'window', 'policy',
  ], { signal, timeoutMs }));
  const checkSecureLock = (state) => {
    if (state.showing && state.secure) {
      throw Object.assign(new Error('The phone requires its owner to unlock the secure screen.'), { code: 'SCREEN_LOCKED' });
    }
  };
  let state = await readState();
  checkSecureLock(state);
  ensureActive(signal);
  await command(['input', 'keyevent', 'KEYCODE_WAKEUP'], { signal, timeoutMs: 2500 });
  ensureActive(signal);
  state = await readState();
  checkSecureLock(state);
  if (state.showing) {
    // Official dismissal of an existing nonsecure swipe keyguard, never password input.
    await command(['wm', 'dismiss-keyguard'], { signal, timeoutMs: 2500 });
  }
  // wm's zero exit code confirms only request submission. Verify the resulting state.
  const pollDeadline = now() + pollTimeoutMs;
  for (;;) {
    ensureActive(signal);
    const remaining = Math.floor(pollDeadline - now());
    if (remaining <= 0) throw Object.assign(new Error('Android screen did not become unlocked and awake.'), { code: 'SCREEN_LOCKED' });
    state = await readState(Math.min(1500, remaining));
    ensureActive(signal);
    checkSecureLock(state);
    if (now() > pollDeadline) throw Object.assign(new Error('Android screen verification exceeded its deadline.'), { code: 'SCREEN_LOCKED' });
    if (!state.showing && state.interactiveState === 'INTERACTIVE_STATE_AWAKE') break;
    const delay = Math.min(150, Math.floor(pollDeadline - now()));
    if (delay > 0) await sleep(delay, signal);
  }
  ensureActive(signal);
  const output = await command([
    'am', 'start', '-W',
    '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER',
    '-p', 'com.android.chrome',
  ], { signal, timeoutMs: 10000 });
  ensureActive(signal);
  if (!/^Status:\s*ok\s*$/m.test(output)) {
    throw Object.assign(new Error('Android did not confirm Chrome activity start.'), { code: 'CHROME_START_FAILED' });
  }
  return true;
}

// No ADB pairing, listener creation or port replacement. Root is used only for
// normal local wake controls; the existing TCP endpoint must identify the same
// Chrome instance as the phone's abstract Unix socket before it can be reused.
const rootCurl="/data/data/com.termux/files/usr/bin/curl --noproxy '*' --abstract-unix-socket chrome_devtools_remote --max-time 5 --silent --show-error";
const rootRelayDirectory='/data/adb/tidewyn-fleet';
const rootRelayFile=rootRelayDirectory+'/native-chrome-root-relay.mjs';
function rootRelayCommand(mode){
  if(!['--start','--check'].includes(mode))throw new Error('Invalid fixed relay command.');
  const check=['/data/adb',rootRelayDirectory,rootRelayFile].map(file=>`test ! -L ${file} && test "$(/system/bin/stat -c '%u:%a' ${file})" = '0:700'`).join(' && ');
  return check+` && exec /system/bin/env -i PATH=/system/bin:/system/xbin HOME=${rootRelayDirectory} ${PREFIX}/bin/node ${rootRelayFile} ${mode}`;
}
function rootRunner(signal,execute){return (command,{timeoutMs=10000}={})=>{
  ensureActive(signal);
  return new Promise((resolve,reject)=>execute('su',['-c',command],{shell:false,timeout:timeoutMs,maxBuffer:65536,signal,windowsHide:true},
    (error,stdout)=>error?reject(Object.assign(new Error('Local root command unavailable.'),{code:'ROOT_UNAVAILABLE'})):resolve(stdout.trim())));
};}
async function readRootRelayOwner(run,signal){
  try{
    const state=JSON.parse(await run(rootRelayCommand('--check'),{timeoutMs:5000}));ensureActive(signal);
    return state?.ready===true&&state.port===9222&&/^[a-f0-9]{32}$/.test(state.instance||'')&&Number.isSafeInteger(state.pid)&&state.pid>0&&/^\d+$/.test(state.start||'')?state:null;
  }catch{ensureActive(signal);return null;}
}
async function proveRootRelay(run,fetchImpl,signal){
  const before=await readRootRelayOwner(run,signal);if(!before)return false;
  const tcp=await readChromeVersion(signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000),fetchImpl);
  ensureActive(signal);if(!tcp)return false;
  const after=await readRootRelayOwner(run,signal);ensureActive(signal);
  return !!after&&before.instance===after.instance&&before.pid===after.pid&&before.start===after.start;
}
export async function tryRootChromeRelay({signal,execute=execFile,fetchImpl=fetch,probe=probeLoopback,sleep=pause,now=()=>performance.now()}={}){
  const run=rootRunner(signal,execute);
  try{
    if(await run('id -u')!=='0')return false;
    if(await run('getprop ro.serialno')!==EXPECTED_SERIAL)throw Object.assign(new Error('Root target is not the configured phone.'),{code:'DEVICE_MISMATCH'});
    if(await proveRootRelay(run,fetchImpl,signal))return true;
    // A healthy existing ADB endpoint can still be reused using its strong
    // Chrome identity. Never displace any process or forward occupying 9222.
    if(await probe(9222,{signal,timeoutMs:250})){
      const direct=JSON.parse(await run(rootCurl+' http://localhost/json/version'));
      if(!validRootChromeEndpoint(direct?.webSocketDebuggerUrl))return false;
      return await proveLocalChromeTargets(run,fetchImpl,signal);
    }
    const direct=JSON.parse(await run(rootCurl+' http://localhost/json/version'));
    if(!validRootChromeEndpoint(direct?.webSocketDebuggerUrl))return false;
    ensureActive(signal);
    await run(rootRelayCommand('--start'),{timeoutMs:8000});
    ensureActive(signal);
    await waitChromeCdpReady({signal,fetchImpl,timeoutMs:5000,sleep,now});
    return await proveRootRelay(run,fetchImpl,signal);
  }catch(error){ensureActive(signal);if(['DEVICE_MISMATCH','FORWARD_CONFLICT'].includes(error.code))throw error;return false;}
}
function validRootChromeEndpoint(value){
  try{const url=new URL(value);return url.protocol==='ws:'&&url.hostname==='localhost'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/devtools\/browser(?:\/[A-Za-z0-9-]+)?$/.test(url.pathname);}catch{return false;}
}
function chromeTargetIdentity(rows){
  if(!Array.isArray(rows)||!rows.length||rows.length>1000)return null;
  const ids=new Set(),identity=[];let strong=false;
  for(const row of rows){
    if(typeof row?.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(row.id)||ids.has(row.id)||typeof row.type!=='string'||!/^[a-z_]{1,40}$/.test(row.type))return null;
    ids.add(row.id);identity.push([row.id,row.type]);
    // Short Android page IDs and even long decimal counters are not sufficient.
    // Require an existing Chrome-generated 128-bit hex or UUID target identity.
    if(/^(?=.*[a-fA-F])[a-fA-F0-9]{32}$/.test(row.id)||/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(row.id))strong=true;
  }
  return strong?JSON.stringify(identity.sort((a,b)=>a[0].localeCompare(b[0]))):null;
}
async function proveLocalChromeTargets(run,fetchImpl,signal){
  // Android exposes a bare /devtools/browser and cannot always create tabs via
  // HTTP. Read only: local Unix socket -> loopback TCP -> local Unix socket.
  // Require a strong target identity (e.g. service_worker) plus the entire same
  // identity set on all three reads; changing or merely numeric sets fail safe.
  const readLocal=async()=>chromeTargetIdentity(JSON.parse(await run(rootCurl+' http://localhost/json/list')));
  const before=await readLocal();if(!before)return false;
  const limited=signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000);
  const tcp=chromeTargetIdentity(await readChromeJSON(limited,fetchImpl,'/json/list'));
  ensureActive(signal);
  const after=await readLocal();ensureActive(signal);
  if(!after||before!==after)return false;
  if(tcp!==before)throw Object.assign(new Error('Existing CDP endpoint is not this local Chrome instance.'),{code:'FORWARD_CONFLICT'});
  return true;
}
export async function tryRootChromeWake({signal,execute=execFile,fetchImpl=fetch,sleep=pause,now=()=>performance.now(),restoreRelay=tryRootChromeRelay}={}) {
  const run=rootRunner(signal,execute);
  try{
    if(await run('id -u')!=='0')return false;
    await wakeVerifiedChrome({signal,sleep,now,command:(args,options)=>run(args.join(' '),options)});
    // Chrome may have been stopped along with its socket. Recreate the fixed
    // relay after normal wake, in this attempt, without requiring wireless ADB.
    if(await restoreRelay({signal,execute,fetchImpl,sleep,now}))return true;
    const direct=JSON.parse(await run(rootCurl+' http://localhost/json/version'));
    const localUrl=new URL(direct.webSocketDebuggerUrl);
    if(localUrl.protocol!=='ws:'||localUrl.hostname!=='localhost'||localUrl.port||localUrl.username||localUrl.password||localUrl.search||localUrl.hash||!/^\/devtools\/browser(?:\/[A-Za-z0-9-]+)?$/.test(localUrl.pathname))return false;
    await waitChromeCdpReady({signal,fetchImpl,timeoutMs:5000,sleep,now});
    const tcp=await readChromeVersion(signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000),fetchImpl);
    ensureActive(signal);
    if(tcp&&localUrl.pathname==='/devtools/browser')return await proveLocalChromeTargets(run,fetchImpl,signal);
    if(!tcp||new URL(tcp.webSocketDebuggerUrl).pathname!==localUrl.pathname)throw Object.assign(new Error('Existing CDP endpoint is not this local Chrome instance.'),{code:'FORWARD_CONFLICT'});
    return true;
  }catch(error){
    ensureActive(signal);
    if(['DEVICE_MISMATCH','SCREEN_LOCKED','SCREEN_STATE_UNAVAILABLE','FORWARD_CONFLICT'].includes(error.code))throw error;
    return false;
  }
}

export function parseForwardList(value) {
  return value.split(/\r?\n/).filter(Boolean).map((line) => {
    const [serial, local, remote, extra] = line.trim().split(/\s+/);
    if (!serial || !local || !remote || extra) throw new Error('Unexpected ADB forward listing.');
    return { serial, local, remote };
  });
}

function validOwnedPorts(ports) {
  return Array.isArray(ports) && ports.length >= 1 && ports.length <= 2 &&
    ports.every(validPort) && new Set(ports).size === ports.length;
}

// Forward ownership must survive a failed Chrome wake/readiness check. The
// separate successful-connection cache is deliberately not used once this
// journal exists, because its port may lag behind a completed rebind.
export async function loadForwardOwnership(file, { cachedPort = null, localPort = 9222 } = {}) {
  try {
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > 1024) throw new Error('Invalid ownership journal.');
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    if (state?.version !== 1 || state.host !== LOOPBACK || state.localPort !== localPort ||
        state.remote !== REMOTE || !validOwnedPorts(state.ports)) throw new Error('Invalid ownership journal.');
    return state.ports;
  } catch (error) {
    // One-time migration from the previous verified connection cache only.
    if (error.code === 'ENOENT') return validPort(cachedPort) ? [cachedPort] : [];
    throw Object.assign(new Error('Local Chrome forward ownership could not be verified; left unchanged.'), { code: 'FORWARD_STATE_INVALID' });
  }
}

export async function saveForwardOwnership(file, ports, { localPort = 9222 } = {}) {
  if (!validOwnedPorts(ports) || !validPort(localPort)) throw new Error('Invalid forward ownership.');
  const temporary = `${file}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'w', 0o600);
    await handle.writeFile(JSON.stringify({ version: 1, host: LOOPBACK, localPort, remote: REMOTE, ports }));
    await handle.sync();
    await handle.close();handle = null;
    await fs.rename(temporary, file);
    // Android keeps this journal in Termux's private Linux filesystem. Flush
    // the rename before touching ADB; Windows test hosts cannot fsync dirs.
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw Object.assign(new Error('Local Chrome forward ownership could not be saved.'), { code: 'FORWARD_STATE_WRITE_FAILED' });
  }
}

export async function ensureChromeForward(port, {
  signal, localPort = 9222, previousPort = null, ownedPorts = [], command = runAdb,
  recordOwnership = async () => {},
} = {}) {
  if (!validPort(port) || !validPort(localPort)) throw new Error('Invalid bridge port.');
  if (!Array.isArray(ownedPorts) || ownedPorts.length > 2 || !ownedPorts.every(validPort)) throw new Error('Invalid forward ownership.');
  const target = `${LOOPBACK}:${port}`;
  const local = `tcp:${localPort}`;
  const mappings = parseForwardList(await command(['forward', '--list'], { signal, timeoutMs: 2500 }));
  const existing = mappings.find((entry) => entry.local === local);
  if (existing?.serial === target && existing.remote === REMOTE) {
    ensureActive(signal);await recordOwnership([port]);return;
  }
  // Rebind only a mapping demonstrably recorded by this bridge's private state.
  // Any other service/transport owning 9222 is left untouched.
  const knownPorts = new Set([...ownedPorts, ...(validPort(previousPort) ? [previousPort] : [])]);
  let existingPort = null;
  if (existing) {
    existingPort = [...knownPorts].find(value => existing.serial === `${LOOPBACK}:${value}`) ?? null;
    if (existingPort === null || existing.remote !== REMOTE) {
      throw Object.assign(new Error('CDP port already belongs to another forward.'), { code: 'FORWARD_CONFLICT' });
    }
  }
  // Write intent before either mutation. If the process stops after removing
  // or creating a forward, the next run can recognize both possible owners.
  ensureActive(signal);
  await recordOwnership(existingPort === null ? [port] : [existingPort, port]);
  ensureActive(signal);
  if (existing) {
    await command(['-s', existing.serial, 'forward', '--remove', local], { signal, timeoutMs: 2500 });
  }
  ensureActive(signal);
  await command(['-s', target, 'forward', '--no-rebind', local, REMOTE], { signal, timeoutMs: 3000 });
  const finalMappings = parseForwardList(await command(['forward', '--list'], { signal, timeoutMs: 2500 }));
  if (!finalMappings.some((entry) => entry.serial === target && entry.local === local && entry.remote === REMOTE)) {
    throw Object.assign(new Error('CDP forward was not verified.'), { code: 'FORWARD_NOT_VERIFIED' });
  }
  ensureActive(signal);
  await recordOwnership([port]);
}

export async function discoverAdbPort({
  signal, cachedPort = null, preferredPort = 34291, discover = true,
  knownPorts = [],
  range = DEFAULT_RANGE, verify = verifyAdbPort, scan = scanLoopback,
  onProgress = () => {},
} = {}) {
  if (!Array.isArray(knownPorts) || knownPorts.length > 2 || !knownPorts.every(validPort)) throw new Error('Invalid known bridge ports.');
  const tried = new Set();
  for (const port of [...knownPorts, cachedPort, preferredPort]) {
    ensureActive(signal);
    if (!validPort(port) || tried.has(port)) continue;
    tried.add(port);
    if (await verify(port, { signal })) return port;
  }
  if (!discover) throw Object.assign(new Error('Cached port unavailable; discovery disabled.'), { code: 'PORT_UNAVAILABLE' });
  onProgress({ phase: 'loopback_discovery', host: LOOPBACK, range });
  const candidates = await scan(range, { signal });
  onProgress({ phase: 'verifying_candidates', count: candidates.length });
  for (const port of candidates) {
    ensureActive(signal);
    if (tried.has(port)) continue;
    if (await verify(port, { signal })) return port;
  }
  throw Object.assign(new Error('No authorized local wireless ADB transport found. Wireless debugging may be off.'), { code: 'NO_AUTHORIZED_LOCAL_ADB' });
}

export async function main(args = process.argv.slice(2)) {
  const options = { discover: true, preferredPort: 34291, budgetMs: 90000, localPort: 9222, wakeChrome: false, backgroundRoot:false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-discover') options.discover = false;
    else if (args[i] === '--wake-chrome') options.wakeChrome = true;
    else if (args[i] === '--background-root') options.backgroundRoot = true;
    else if (args[i] === '--port') options.preferredPort = Number(args[++i]);
    else if (args[i] === '--budget-ms') options.budgetMs = Number(args[++i]);
    else throw new Error('Usage: native-chrome-bridge.mjs [--port current-port] [--budget-ms 1000..120000] [--no-discover] [--wake-chrome]');
  }
  if (!validPort(options.preferredPort) || !Number.isInteger(options.budgetMs) || options.budgetMs < 1000 || options.budgetMs > 120000) {
    throw new Error('Invalid command options.');
  }
  if (process.env.PREFIX !== PREFIX || !['linux', 'android'].includes(process.platform) || process.getuid?.() === 0) {
    throw new Error('Run only as the ordinary Termux app user on the phone.');
  }
  const stateDir = path.join(os.homedir(), '.local', 'state', 'fleet-native-chrome');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDir, 0o700);
  const stateFile = path.join(stateDir, 'bridge.json');
  let state = null;
  try {
    const info = await fs.stat(stateFile);
    if (info.size <= 1024) state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  } catch {}
  const cachedPort = state?.host === LOOPBACK && validPort(state?.port) ? state.port : null;
  const ownershipFile = path.join(stateDir, 'forward-ownership.json');
  let range = DEFAULT_RANGE;
  try {
    const kernelRange = parsePortRange(await fs.readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8'));
    if (kernelRange) range = kernelRange;
  } catch {}
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, options.budgetMs);
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const report = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  try {
    if(options.backgroundRoot){
      report({event:'chrome_background_prepare',...await prepareChromeBackground({signal:controller.signal})});
      if(await tryRootChromeRelay({signal:controller.signal})&&(!options.wakeChrome||await tryRootChromeWake({signal:controller.signal}))){
        ensureActive(controller.signal);report({ok:true,transport:'root_local_chrome',cdpPort:options.localPort,chromeStarted:options.wakeChrome,cdpReady:true});
        return {port:null,localPort:options.localPort};
      }
    }
    if(options.wakeChrome&&options.backgroundRoot&&await tryRootChromeWake({signal:controller.signal})){
      ensureActive(controller.signal);
      report({ok:true,transport:'existing_local_chrome',cdpPort:options.localPort,chromeStarted:true,cdpReady:true});
      return {port:null,localPort:options.localPort};
    }
    // ADB pairing and journal requirements apply only to the ADB fallback.
    // Root's fixed loopback relay does not depend on wireless debugging state.
    const key=await fs.stat(path.join(os.homedir(),'.android','adbkey')).catch(()=>null);
    if(!key?.isFile())throw Object.assign(new Error('Existing Termux pairing key required.'),{code:'PAIRING_REQUIRED'});
    const ownedPorts=await loadForwardOwnership(ownershipFile,{cachedPort,localPort:options.localPort});
    await ensureLocalAdbServer({ signal: controller.signal });
    const port = await discoverAdbPort({
      ...options, cachedPort, knownPorts: [...ownedPorts].reverse(), range, signal: controller.signal, onProgress: report,
    });
    await ensureChromeForward(port, {
      signal: controller.signal, ownedPorts, localPort: options.localPort,
      recordOwnership: ports => saveForwardOwnership(ownershipFile, ports, { localPort: options.localPort }),
    });
    if (options.wakeChrome) await wakeChrome(port, { signal: controller.signal });
    await waitChromeCdpReady({ signal: controller.signal });
    ensureActive(controller.signal);
    const temporary = `${stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ host: LOOPBACK, port, localPort: options.localPort, checkedAt: new Date().toISOString() }), { mode: 0o600 });
    await fs.rename(temporary, stateFile);
    ensureActive(controller.signal);
    report({ ok: true, adbHost: LOOPBACK, adbPort: port, cdpPort: options.localPort, chromeStarted: options.wakeChrome, cdpReady: true });
    return { port, localPort: options.localPort };
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || 'BRIDGE_FAILED', message: error.message })}\n`);
    process.exitCode = 1;
  });
}
