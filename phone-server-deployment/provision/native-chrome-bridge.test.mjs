import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parsePortRange, probeLoopback, scanLoopback, verifyAdbPort,
  discoverAdbPort, ensureChromeForward, wakeChrome, parseKeyguardPolicy,
  adbEnvironment, runAdb, readAdbServerVersion, ensureLocalAdbServer, validChromeEndpoint, waitChromeCdpReady,
  loadForwardOwnership, saveForwardOwnership,
} from './native-chrome-bridge.mjs';

const policy = ({ showing = false, secure = false, state = 'AWAKE' } = {}) => [
  'WINDOW MANAGER POLICY STATE (dumpsys window policy)',
  '  KeyguardServiceDelegate',
  `    showing=${showing}`,
  '    inputRestricted=false',
  '    occluded=false',
  `    secure=${secure}`,
  `    interactiveState=INTERACTIVE_STATE_${state}`,
  '  AnotherPolicySection',
  '    showing=true',
].join('\n');

test('validates bounded kernel ephemeral range', () => {
  assert.deepEqual(parsePortRange('32768\t60999\n'), [32768, 60999]);
  for (const invalid of ['0 65535', '40000 39999', '1 65536', '10 20 junk', 'localhost 22']) {
    assert.equal(parsePortRange(invalid), null);
  }
});

test('real TCP probe uses 127.0.0.1 and sends no application bytes', async () => {
  let bytes = 0;
  const server = net.createServer((socket) => {
    assert.ok(['127.0.0.1', '::ffff:127.0.0.1'].includes(socket.remoteAddress));
    socket.on('data', (chunk) => { bytes += chunk.length; });
    socket.resume();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await probeLoopback(port), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bytes, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
  assert.equal(await probeLoopback(port), false);
});

test('scan bounds concurrent probes and returns only open local ports', async () => {
  let active = 0;
  let peak = 0;
  const seen = [];
  const open = await scanLoopback([40000, 40039], {
    concurrency: 4,
    probe: async (port) => {
      seen.push(port);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return port === 40017;
    },
  });
  assert.deepEqual(open, [40017]);
  assert.equal(seen.length, 40);
  assert.ok(peak <= 4);
});

test('cancel stops scan before further probes', async () => {
  const controller = new AbortController();
  let count = 0;
  await assert.rejects(scanLoopback([40000, 50000], {
    signal: controller.signal, concurrency: 1,
    probe: async () => { count++; controller.abort(); return false; },
  }), { code: 'ABORTED' });
  assert.equal(count, 1);
});

test('scan fails safely if too many local services are open', async () => {
  await assert.rejects(scanLoopback([40000, 40040], {
    concurrency: 1, maxCandidates: 2, probe: async () => true,
  }), { code: 'TOO_MANY_CANDIDATES' });
});

test('preferred port requires authorized shell identity matching this phone', async () => {
  const calls = [];
  const command = async (args) => {
    calls.push(args);
    if (args.includes('get-state')) return 'device';
    if (args.includes('ro.serialno')) return 'YOUR_DEVICE_SERIAL';
    return 'connected';
  };
  assert.equal(await verifyAdbPort(34291, { command }), true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((args) => args.includes('127.0.0.1:34291')));
  assert.equal(await verifyAdbPort(34291, { command: async () => 'unauthorized' }), false);
  assert.equal(await verifyAdbPort(34291, { command: async (args) => args.includes('get-state') ? 'device' : 'unexpected' }), false);
  assert.deepEqual(calls[2], ['-s', '127.0.0.1:34291', 'shell', '-n', 'getprop', 'ro.serialno']);
});

test('wake uses verified phone MAIN launcher without URL or security changes', async () => {
  const calls = [];
  assert.equal(await wakeChrome(34291, { command: async (args, options) => {
    calls.push({ args, options });
    if (args.includes('ro.serialno')) return 'YOUR_DEVICE_SERIAL';
    if (args.includes('dumpsys')) return policy();
    return 'Starting: Intent\nStatus: ok\nComplete';
  } }), true);
  assert.deepEqual(calls.at(-1).args, [
    '-s', '127.0.0.1:34291', 'shell', '-n', 'am', 'start', '-W',
    '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER',
    '-p', 'com.android.chrome',
  ]);
  assert.equal(calls.at(-1).options.timeoutMs, 10000);
  assert.ok(calls.some(({ args }) => args.includes('KEYCODE_WAKEUP')));
  assert.ok(calls.every(({ args }) => !args.some((arg) => ['settings', 'unfreeze', 'locksettings', 'KEYCODE_POWER', 'KEYCODE_SLEEP', 'text', 'swipe'].includes(arg))));
  assert.ok(!calls.some(({ args }) => args.includes('dismiss-keyguard')));
});

test('wake rejects wrong identity before am command', async () => {
  const calls = [];
  await assert.rejects(wakeChrome(34291, { command: async (args) => {
    calls.push(args);
    return 'another-phone';
  } }), { code: 'DEVICE_MISMATCH' });
  assert.equal(calls.length, 1);
});

test('wake requires explicit Status ok, not any successful process exit', async () => {
  for (const output of ['', 'Error: Activity not started', 'Status: timeout', 'not Status: ok']) {
    await assert.rejects(wakeChrome(34291, {
      command: async (args) => args.includes('ro.serialno') ? 'YOUR_DEVICE_SERIAL' : args.includes('dumpsys') ? policy() : output,
    }), { code: 'CHROME_START_FAILED' });
  }
});

test('wake cancellation after identity prevents activity start', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(wakeChrome(34291, {
    signal: controller.signal,
    command: async () => { calls++; controller.abort(); return 'YOUR_DEVICE_SERIAL'; },
  }), { code: 'ABORTED' });
  assert.equal(calls, 1);
});

test('keyguard parser reads exact direct fields in one scoped delegate block', () => {
  assert.deepEqual(parseKeyguardPolicy(policy({ showing: true, state: 'SLEEP' })), {
    showing: true, secure: false, interactiveState: 'INTERACTIVE_STATE_SLEEP',
  });
  const nested = policy().replace('  AnotherPolicySection', '    KeyguardStateMonitor\n      showing=true\n      secure=true\n  AnotherPolicySection');
  assert.equal(parseKeyguardPolicy(nested).secure, false);
  for (const invalid of [
    '', policy().replace('KeyguardServiceDelegate', 'UnknownDelegate'),
    policy().replace('    secure=false\n', ''),
    policy().replace('    secure=false', '    secure=false\n    secure=true'),
    policy().replace('    secure=false', '      secure=false'),
    policy().replace('    showing=false', '    showing=unknown'),
    policy().replace('INTERACTIVE_STATE_AWAKE', 'AWAKE'),
    policy() + '\n  KeyguardServiceDelegate\n    showing=false',
  ]) assert.throws(() => parseKeyguardPolicy(invalid), { code: 'SCREEN_STATE_UNAVAILABLE' });
});

test('secure showing keyguard rejected before wake, dismissal, or Chrome start', async () => {
  const calls = [];
  await assert.rejects(wakeChrome(34291, { command: async (args) => {
    calls.push(args);
    return args.includes('ro.serialno') ? 'YOUR_DEVICE_SERIAL' : policy({ showing: true, secure: true, state: 'SLEEP' });
  } }), { code: 'SCREEN_LOCKED' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((args) => !args.includes('input') && !args.includes('wm') && !args.includes('am')));
});

test('nonsecure swipe dismissal is followed by real unlocked and awake state check', async () => {
  let reads = 0;
  const calls = [];
  assert.equal(await wakeChrome(34291, { command: async (args, options) => {
    calls.push({ args, options });
    if (args.includes('ro.serialno')) return 'YOUR_DEVICE_SERIAL';
    if (args.includes('dumpsys')) {
      reads++;
      return policy({ showing: reads < 3, state: reads === 1 ? 'SLEEP' : 'AWAKE' });
    }
    return args.includes('am') ? 'Status: ok' : '';
  } }), true);
  assert.equal(reads, 3);
  const commands = calls.map(({ args }) => args[4]);
  assert.deepEqual(commands, ['getprop', 'dumpsys', 'input', 'dumpsys', 'wm', 'dumpsys', 'am']);
  assert.ok(calls[5].options.timeoutMs <= 1500);
});

test('zero-exit dismissal without unlock cannot start Chrome and polling stays bounded', async () => {
  let time = 0;
  const calls = [];
  await assert.rejects(wakeChrome(34291, {
    now: () => time, sleep: async (ms) => { time += ms; },
    command: async (args) => {
      calls.push(args);
      if (args.includes('ro.serialno')) return 'YOUR_DEVICE_SERIAL';
      if (args.includes('dumpsys')) return policy({ showing: true });
      return '';
    },
  }), { code: 'SCREEN_LOCKED' });
  assert.equal(time, 5000);
  assert.equal(calls.filter((args) => args.includes('dismiss-keyguard')).length, 1);
  assert.ok(!calls.some((args) => args.includes('am')));
});

test('secure keyguard appearing after wake is rejected without dismissal', async () => {
  let reads = 0;
  const calls = [];
  await assert.rejects(wakeChrome(34291, { command: async (args) => {
    calls.push(args);
    if (args.includes('ro.serialno')) return 'YOUR_DEVICE_SERIAL';
    if (args.includes('dumpsys')) return policy({ showing: true, secure: ++reads > 1 });
    return '';
  } }), { code: 'SCREEN_LOCKED' });
  assert.ok(!calls.some((args) => args.includes('wm') || args.includes('am')));
});

test('unparseable screen state fails closed before activity start', async () => {
  const calls = [];
  await assert.rejects(wakeChrome(34291, { command: async (args) => {
    calls.push(args);
    return args.includes('ro.serialno') ? 'YOUR_DEVICE_SERIAL' : 'Unknown OEM dump';
  } }), { code: 'SCREEN_STATE_UNAVAILABLE' });
  assert.equal(calls.length, 2);
});

test('cancellation at dismissal stops polling and Chrome startup', async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(wakeChrome(34291, { signal: controller.signal, command: async (args) => {
    calls.push(args);
    if (args.includes('ro.serialno')) return 'YOUR_DEVICE_SERIAL';
    if (args.includes('dumpsys')) return policy({ showing: true });
    if (args.includes('dismiss-keyguard')) controller.abort();
    return '';
  } }), { code: 'ABORTED' });
  assert.equal(calls.at(-1).at(-1), 'dismiss-keyguard');
  assert.ok(!calls.some((args) => args.includes('am')));
});

test('cached transport avoids scanning and defaultport attempt', async () => {
  const seen = [];
  assert.equal(await discoverAdbPort({
    cachedPort: 40017, verify: async (port) => { seen.push(port); return true; },
    scan: async () => { assert.fail('must not scan'); },
  }), 40017);
  assert.deepEqual(seen, [40017]);
});

test('expired cache falls back to authorized candidate only', async () => {
  const seen = [];
  assert.equal(await discoverAdbPort({
    cachedPort: 40016, preferredPort: 34291,
    scan: async () => [40018, 40020],
    verify: async (port) => { seen.push(port); return port === 40020; },
  }), 40020);
  assert.deepEqual(seen, [40016, 34291, 40018, 40020]);
});

test('a verified journal port avoids another full scan after Chrome failed before updating the success cache', async () => {
  const seen = [];
  assert.equal(await discoverAdbPort({
    cachedPort: 34291, knownPorts: [40020, 34291],
    verify: async port => { seen.push(port);return port === 40020; },
    scan: async () => { assert.fail('Known current transport should not require a full scan'); },
  }), 40020);
  assert.deepEqual(seen, [40020]);
});

test('journal candidates still require exact phone authorization and are deduplicated', async () => {
  const seen = [];
  assert.equal(await discoverAdbPort({
    cachedPort: 34291, knownPorts: [40020, 34291], preferredPort: 34291,
    verify: async port => { seen.push(port);return port === 40030; },
    scan: async () => [40020, 34291, 40030],
  }), 40030);
  assert.deepEqual(seen, [40020, 34291, 40030]);
});

test('disabled discovery performs no scan', async () => {
  await assert.rejects(discoverAdbPort({
    discover: false, verify: async () => false,
    scan: async () => { assert.fail('must not scan'); },
  }), { code: 'PORT_UNAVAILABLE' });
});

test('existing same native Chrome forward reused', async () => {
  const calls = [];
  await ensureChromeForward(34291, { command: async (args) => {
    calls.push(args);
    return '127.0.0.1:34291 tcp:9222 localabstract:chrome_devtools_remote';
  } });
  assert.deepEqual(calls, [['forward', '--list']]);
});

test('foreign forward never removed or replaced', async () => {
  const calls = [];
  await assert.rejects(ensureChromeForward(34291, { command: async (args) => {
    calls.push(args);
    return 'unrelated-device tcp:9222 localabstract:chrome_devtools_remote';
  } }), { code: 'FORWARD_CONFLICT' });
  assert.deepEqual(calls, [['forward', '--list']]);
});

test('only cached bridge mapping may be rebound, final mapping rechecked', async () => {
  const calls = [];
  let listing = 0;
  await ensureChromeForward(40020, { previousPort: 34291, command: async (args) => {
    calls.push(args);
    if (args.includes('--list')) return ++listing === 1
      ? '127.0.0.1:34291 tcp:9222 localabstract:chrome_devtools_remote'
      : '127.0.0.1:40020 tcp:9222 localabstract:chrome_devtools_remote';
    return '';
  } });
  assert.deepEqual(calls[1], ['-s', '127.0.0.1:34291', 'forward', '--remove', 'tcp:9222']);
  assert.deepEqual(calls[2], ['-s', '127.0.0.1:40020', 'forward', '--no-rebind', 'tcp:9222', 'localabstract:chrome_devtools_remote']);
});

async function ownershipFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-bridge-journal-test-'));
  const file = path.join(directory, 'forward-ownership.json');
  t.after(async () => { await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });await fs.rmdir(directory); });
  return file;
}

function forwardFixture(initialPort = 34291) {
  const state = { port: initialPort, calls: [], failAt: null };
  const command = async args => {
    state.calls.push(args);
    const fail = point => { if (state.failAt === point) { state.failAt = null;throw Object.assign(new Error('Simulated interrupted bridge.'), { code: 'TEST_INTERRUPTION' }); } };
    if (args.includes('--list')) {
      fail('readback');
      return state.port === null ? '' : `127.0.0.1:${state.port} tcp:9222 localabstract:chrome_devtools_remote`;
    }
    if (args.includes('--remove')) { fail('before-remove');state.port = null;fail('after-remove');return ''; }
    if (args.includes('--no-rebind')) { state.port = Number(args[1].split(':')[1]);fail('after-add');return ''; }
    assert.fail('Unexpected ADB command');
  };
  return { state, command };
}

test('ownership survives Chrome failure and a second wireless-port change while the success cache stays old', async t => {
  const file = await ownershipFixture(t), { state, command } = forwardFixture();
  const cachedPort = 34291;
  const recordOwnership = ports => saveForwardOwnership(file, ports);
  await ensureChromeForward(40020, { ownedPorts: await loadForwardOwnership(file, { cachedPort }), command, recordOwnership });
  // Chrome subsequently fails to wake: no successful-connection cache write.
  assert.equal(state.port, 40020);
  assert.deepEqual(await loadForwardOwnership(file, { cachedPort }), [40020]);
  await ensureChromeForward(40030, { ownedPorts: await loadForwardOwnership(file, { cachedPort }), command, recordOwnership });
  assert.equal(state.port, 40030);
  assert.deepEqual(await loadForwardOwnership(file, { cachedPort }), [40030]);
});

test('every interrupted rebind stage remains recoverable from the durable ownership journal', async t => {
  for (const failure of ['before-remove', 'after-remove', 'after-add', 'readback', 'commit']) {
    await t.test(failure, async t => {
      const file = await ownershipFixture(t), { state, command } = forwardFixture();
      let writes = 0;
      const recordOwnership = async ports => {
        writes++;
        if (failure === 'commit' && writes === 2) throw Object.assign(new Error('Simulated commit failure.'), { code: 'TEST_INTERRUPTION' });
        await saveForwardOwnership(file, ports);
        // Enable a readback failure only after ownership is durable, so the
        // initial mapping inspection does not fail before the transaction.
        if (writes === 1) state.failAt = failure;
      };
      await assert.rejects(ensureChromeForward(40020, {
        ownedPorts: await loadForwardOwnership(file, { cachedPort: 34291 }), command, recordOwnership,
      }), { code: 'TEST_INTERRUPTION' });
      assert.deepEqual(await loadForwardOwnership(file, { cachedPort: 34291 }), [34291, 40020]);
      state.failAt = null;
      await ensureChromeForward(40030, {
        ownedPorts: await loadForwardOwnership(file, { cachedPort: 34291 }), command,
        recordOwnership: ports => saveForwardOwnership(file, ports),
      });
      assert.equal(state.port, 40030);
      assert.deepEqual(await loadForwardOwnership(file), [40030]);
    });
  }
});

test('ownership journal failure or cancellation prevents any ADB forward mutation', async () => {
  for (const cancellation of [false, true]) {
    const { state, command } = forwardFixture(), controller = new AbortController();
    await assert.rejects(ensureChromeForward(40020, {
      ownedPorts: [34291], command, signal: controller.signal,
      recordOwnership: async () => {
        if (cancellation) controller.abort();
        else throw Object.assign(new Error('Cannot persist ownership.'), { code: 'FORWARD_STATE_WRITE_FAILED' });
      },
    }), { code: cancellation ? 'ABORTED' : 'FORWARD_STATE_WRITE_FAILED' });
    assert.equal(state.port, 34291);assert.deepEqual(state.calls, [['forward', '--list']]);
  }
});

test('pending ownership never authorizes a foreign transport or a different remote socket', async () => {
  for (const mapping of ['127.0.0.1:40040 tcp:9222 localabstract:chrome_devtools_remote', '127.0.0.1:40020 tcp:9222 localabstract:other_socket']) {
    const calls = [];
    await assert.rejects(ensureChromeForward(40030, {
      ownedPorts: [34291, 40020],
      command: async args => { calls.push(args);return mapping; },
      recordOwnership: async () => { assert.fail('Foreign mapping must not gain journal ownership'); },
    }), { code: 'FORWARD_CONFLICT' });
    assert.deepEqual(calls, [['forward', '--list']]);
  }
});

test('reuse and missing-forward recovery establish ownership without depending on Chrome readiness', async t => {
  const file = await ownershipFixture(t), { state, command } = forwardFixture(40020);
  await ensureChromeForward(40020, { command, recordOwnership: ports => saveForwardOwnership(file, ports) });
  assert.deepEqual(state.calls, [['forward', '--list']]);
  assert.deepEqual(await loadForwardOwnership(file), [40020]);
  state.port = null;
  await ensureChromeForward(40030, { ownedPorts: await loadForwardOwnership(file), command, recordOwnership: ports => saveForwardOwnership(file, ports) });
  assert.equal(state.port, 40030);
  assert.deepEqual(await loadForwardOwnership(file), [40030]);
});

test('legacy cache migrates only when journal is absent; invalid existing ownership fails closed', async t => {
  const file = await ownershipFixture(t);
  assert.deepEqual(await loadForwardOwnership(file, { cachedPort: 34291 }), [34291]);
  assert.deepEqual(await loadForwardOwnership(file), []);
  await saveForwardOwnership(file, [40020]);
  assert.deepEqual(await loadForwardOwnership(file, { cachedPort: 34291 }), [40020]);
  const valid = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const content of ['{', 'x'.repeat(1025), JSON.stringify({ ...valid, host: 'example.com' }), JSON.stringify({ ...valid, remote: 'localabstract:other_socket' }), JSON.stringify({ ...valid, localPort: 9999 }), JSON.stringify({ ...valid, ports: [40020, 40020] }), JSON.stringify({ ...valid, ports: [40020, 40030, 40040] })]) {
    await fs.writeFile(file, content);
    await assert.rejects(loadForwardOwnership(file, { cachedPort: 34291 }), { code: 'FORWARD_STATE_INVALID' });
  }
});

test('ADB startup strips inherited host/socket/port overrides while regular clients stay fixed on loopback', async () => {
  const environment = { HOME: '/private/home', ADB_SERVER_SOCKET: 'tcp:other:1', ADB_SERVER_HOST: 'other', ADB_SERVER_PORT: '1', ANDROID_ADB_SERVER_ADDRESS: 'other', ANDROID_ADB_SERVER_HOST: 'other', ANDROID_ADB_SERVER_PORT: '1' };
  assert.deepEqual(adbEnvironment({ bootstrapServer: true, environment }), { HOME: '/private/home' });
  assert.deepEqual(adbEnvironment({ environment }), { HOME: '/private/home', ADB_SERVER_SOCKET: 'tcp:127.0.0.1:5037' });
  let seen;
  await runAdb(['-L', 'tcp:localhost:5037', 'start-server'], { bootstrapServer: true, execFileImpl: (file, args, options, callback) => { seen = { file, args, options };callback(null, ''); } });
  assert.equal(seen.file, '/data/data/com.termux/files/usr/bin/adb');assert.equal(seen.options.shell, false);assert.equal(seen.options.windowsHide, true);
  assert.equal(seen.options.env.ADB_SERVER_SOCKET, undefined);assert.deepEqual(seen.args, ['-L', 'tcp:localhost:5037', 'start-server']);
  assert.throws(() => runAdb(['-a', 'start-server'], { bootstrapServer: true }), /Invalid local ADB startup/);
});

test('real read-only ADB listener probe parses fragmented version replies and identifies an absent listener', async () => {
  const requests = [];
  const server = net.createServer(socket => socket.once('data', chunk => {
    requests.push(chunk.toString());socket.write('OKAY0004');setImmediate(() => socket.end('0029'));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));const port = server.address().port;
  try { assert.equal(await readAdbServerVersion({ port }), 41);assert.deepEqual(requests, ['000Chost:version']); }
  finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(await readAdbServerVersion({ port }), null);
});

test('a foreign or unresponsive listener is not treated as an absent ADB daemon', async () => {
  for (const reply of ['HTTP/1.1 200 OK', 'OKAY000400zz', 'FAIL0000', null]) {
    const server = net.createServer(socket => { socket.on('error', () => {});socket.once('data', () => { if (reply) socket.end(reply); }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await assert.rejects(readAdbServerVersion({ port: server.address().port, timeoutMs: 25 }), { code: 'ADB_SERVER_UNVERIFIED' }); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
});

test('existing matching ADB daemon is reused without any start or kill command', async () => {
  const calls = [];
  assert.deepEqual(await ensureLocalAdbServer({ command: async args => { calls.push(args);return 'Android Debug Bridge version 1.0.41\nVersion 35.0.2'; }, readVersion: async () => 41 }), { started: false });
  assert.deepEqual(calls, [['version']]);
});

test('missing daemon starts once with the tested localhost listener and is verified afterward', async () => {
  let reads = 0;const calls = [];
  const result = await ensureLocalAdbServer({ command: async (args, options) => { calls.push({ args, options });return args[0] === 'version' ? 'Android Debug Bridge version 1.0.41' : ''; }, readVersion: async () => ++reads === 1 ? null : 41 });
  assert.deepEqual(result, { started: true });assert.equal(reads, 2);
  assert.deepEqual(calls[1].args, ['-L', 'tcp:localhost:5037', 'start-server']);assert.equal(calls[1].options.bootstrapServer, true);assert.equal(calls[1].options.timeoutMs, 10000);
});

test('conflicting listener versions, unknown client versions and unverified startups fail closed without killing a daemon', async () => {
  let starts = 0;
  const command = async args => { if (args[0] !== 'version') starts++;return 'Android Debug Bridge version 1.0.41'; };
  await assert.rejects(ensureLocalAdbServer({ command, readVersion: async () => 40 }), { code: 'ADB_SERVER_CONFLICT' });assert.equal(starts, 0);
  await assert.rejects(ensureLocalAdbServer({ command: async () => 'unknown binary', readVersion: async () => { assert.fail('must not inspect/start'); } }), { code: 'ADB_VERSION_UNKNOWN' });
  await assert.rejects(ensureLocalAdbServer({ command, readVersion: async () => null }), { code: 'ADB_SERVER_NOT_READY' });assert.equal(starts, 1);
});

test('cancellation after listener inspection prevents daemon startup', async () => {
  const controller = new AbortController();let commands = 0;
  await assert.rejects(ensureLocalAdbServer({ signal: controller.signal, command: async () => { commands++;return 'Android Debug Bridge version 1.0.41'; }, readVersion: async () => { controller.abort();return null; } }), { code: 'ABORTED' });
  assert.equal(commands, 1);
});

const chromeResponse = (endpoint = 'ws://127.0.0.1:9222/devtools/browser') => new Response(JSON.stringify({ webSocketDebuggerUrl: endpoint }), { headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
test('Chrome readiness accepts only the fixed local browser endpoint forms', () => {
  assert.equal(validChromeEndpoint('ws://127.0.0.1:9222/devtools/browser'), true);assert.equal(validChromeEndpoint('ws://127.0.0.1:9222/devtools/browser/id-123'), true);
  for (const endpoint of ['ws://example.com:9222/devtools/browser', 'ws://127.0.0.1:9223/devtools/browser', 'ws://name:password@127.0.0.1:9222/devtools/browser', 'ws://127.0.0.1:9222/devtools/page/id', 'ws://127.0.0.1:9222/devtools/browser?x=1', 'ws://127.0.0.1:9222/devtools/browser/', 'not-url']) assert.equal(validChromeEndpoint(endpoint), false);
});

test('cold Chrome readiness retries briefly and reports ready only after a valid 200 JSON endpoint', async () => {
  let time = 0, attempts = 0;
  assert.equal(await waitChromeCdpReady({ now: () => time, sleep: async ms => { time += ms; }, fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:9222/json/version');assert.equal(options.redirect, 'error');assert.ok(options.signal instanceof AbortSignal);
    return ++attempts === 1 ? new Response('unavailable', { status: 503 }) : chromeResponse();
  } }), true);
  assert.equal(attempts, 2);assert.equal(time, 250);
});

test('Chrome coldstart and malformed endpoint waits stay within eight seconds without false readiness', async () => {
  for (const mode of ['external', 'malformed', 'oversized', 'non200']) {
    let time = 0;
    await assert.rejects(waitChromeCdpReady({ now: () => time, sleep: async ms => { time += ms; }, fetchImpl: async () => {
      if (mode === 'external') return chromeResponse('ws://external.example:9222/devtools/browser');
      if (mode === 'malformed') return new Response('{', { headers: { 'Content-Type': 'application/json' } });
      if (mode === 'oversized') return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser', padding: 'x'.repeat(65536) }), { headers: { 'Content-Type': 'application/json' } });
      return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } });
    } }), { code: 'CDP_NOT_READY' });
    assert.equal(time, 8000);
  }
});

test('Chrome readiness abort interrupts a stalled request and preserves cancellation', async () => {
  const controller = new AbortController();let calls = 0;
  const waiting = waitChromeCdpReady({ signal: controller.signal, fetchImpl: async (url, options) => {
    calls++;return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
  } });
  controller.abort();await assert.rejects(waiting, { code: 'ABORTED' });assert.equal(calls, 1);
});

test('Chrome readiness own deadline interrupts a stalled request instead of hanging until the outer task timeout', async () => {
  const start = performance.now();let attempts = 0;
  await assert.rejects(waitChromeCdpReady({ timeoutMs: 25, fetchImpl: async (url, options) => {
    attempts++;return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('deadline')), { once: true }));
  } }), { code: 'CDP_NOT_READY' });
  assert.equal(attempts, 1);assert.ok(performance.now() - start < 1000);
});
