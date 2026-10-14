import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scriptPath=fileURLToPath(new URL('./fleet-runtime-watchdog.sh',import.meta.url));
const source=fs.readFileSync(scriptPath,'utf8');
assert.ok(source.endsWith('main "$@"\n'));
const functions=source.slice(0,-'main "$@"\n'.length);
// Some packaged Git runtimes provide GNU Bash only as sh.exe. Resolve an
// actual Bash implementation and carry its utilities into each child PATH;
// absence is an explicit test failure, never a reason to skip the watchdog.
const bundledGit=path.resolve(path.dirname(process.execPath),'../../native/git/usr/bin');
const candidates=process.env.FLEET_TEST_BASH?[process.env.FLEET_TEST_BASH]:process.platform==='win32'?
  ['bash.exe',...['C:/Program Files/Git/usr/bin',bundledGit].flatMap(dir=>['bash.exe','sh.exe'].map(name=>path.join(dir,name)))]:['bash'];
let bash,shellEnv;
for(const candidate of candidates){
  const env={...process.env},pathKey=Object.keys(env).find(key=>key.toLowerCase()==='path')||'PATH';
  if(path.isAbsolute(candidate))env[pathKey]=path.dirname(candidate)+path.delimiter+(env[pathKey]||'');
  const probe=spawnSync(candidate,['--version'],{env,encoding:'utf8',windowsHide:true,timeout:5000});
  if(probe.status===0&&/^GNU bash,/m.test(probe.stdout||'')){bash=candidate;shellEnv=env;break;}
}
assert.ok(bash,'GNU Bash is required; set FLEET_TEST_BASH to its executable path');
const shell=(args,options={})=>spawnSync(bash,args,{env:shellEnv,...options});
const q=value=>`'${String(value).replaceAll("'","'\\''")}'`;
const hostPath=shell(['--noprofile','--norc','-c','printf "%s" "$PATH"'],{encoding:'utf8',windowsHide:true}).stdout;
function run(body,setup='') {
  const result=shell(['--noprofile','--norc','-s'],{input:`${functions}\nPATH=${q(hostPath)};export PATH\n${setup}\n${body}\n`,encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.error,undefined,result.error?.message);
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}
const cycleFixture=`
exec 8>&1
ENABLED=1;SVC=0;SUP=0;READY=1;NOW=500;AM_FAIL=0;START_FAIL=0;STOP_AFTER_AM=0;STOP_BEFORE_START=0
enabled(){ [ "$ENABLED" = 1 ]; }
check_scope(){ return 0; }
identity(){ TERMUX_UID=10345;return 0; }
record(){ printf 'STATE %s\\n' "$1"; }
read_service_state(){ return "$SVC"; }
find_supervisor(){ return "$SUP"; }
clock_seconds(){ printf '%s\\n' "$NOW"; }
check_pidfile(){ [ "$STOP_BEFORE_START" = 0 ] || ENABLED=0;return 0; }
services_ready(){ [ "$READY" = 1 ]; }
sleep(){ :; }
bounded(){ shift;case "$1" in
  /system/bin/am) printf 'ACTION termux_lock\\n' >&8; [ "$AM_FAIL" = 0 ] || return 124; SVC=0; [ "$STOP_AFTER_AM" = 0 ] || ENABLED=0;;
  *) printf 'UNEXPECTED %s\\n' "$*";return 99;;esac; }
start_supervisor(){ printf 'ACTION supervisor_start\\n';[ "$START_FAIL" = 0 ] || return 124;SUP=0; }
`;

test('production has no dynamic command parameters, network, freezer writes, killing, or service-enable mutations',()=>{
  assert.match(source,/\[ "\$#" -eq 0 \]/);
  assert.match(source,/flock -n 9/);
  assert.match(source,/flock -n 9 9>&9/);
  assert.match(source,/acquire_lock \|\| exit \$\?/);
  assert.match(source,/cycle 9>&-/);
  assert.match(source,/sleep 30 9>&-/);
  const executable=source.split('\n').filter(x=>!x.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(executable,/\b(curl|wget|node|pkill|killall|eval)\b|cgroup\.freeze|sv (up|enable|restart|stop)|service-daemon (restart|stop)|rm -f|\/proc\/.*\bkill\b/);
  assert.match(executable,/bounded 8 \/system\/bin\/su -g 0 -G 3003 -c 'exec \/system\/bin\/run-as com\.termux \/system\/bin\/sh'/);
  assert.equal((executable.match(/\/system\/bin\/su\s/g)||[]).length,1);
  assert.match(executable,/\. "\$PREFIX\/etc\/profile\.d\/start-services\.sh"/);
});

test('healthy supervision does not mutate Termux or duplicate Node',()=>{
  assert.deepEqual(run('cycle',cycleFixture),['STATE healthy']);
});
test('disabled and unreadable Guardian preferences fail closed',()=>{
  assert.deepEqual(run('ENABLED=0;cycle',cycleFixture),['STATE disabled']);
  assert.deepEqual(run('enabled(){ return 2; };cycle',cycleFixture),['STATE prefs_unavailable']);
});
test('identity and root scope failure prevent every restoration action',()=>{
  assert.deepEqual(run('identity(){ return 1; };cycle',cycleFixture),['STATE identity_failed']);
  assert.deepEqual(run('check_scope(){ return 1; };cycle',cycleFixture),['STATE scope_failed']);
});
test('lost Termux FGS and lock restored without starting an existing supervisor',()=>{
  assert.deepEqual(run('SVC=1;cycle',cycleFixture),['STATE repair_started','ACTION termux_lock','STATE recovered']);
});
test('whole missing supervision chain restored after FGS, no up/down/restart operations',()=>{
  assert.deepEqual(run('SVC=1;SUP=1;cycle',cycleFixture),['STATE repair_started','ACTION termux_lock','ACTION supervisor_start','STATE recovered']);
});
test('stop arriving after dispatched service action prevents supervisor startup',()=>{
  assert.deepEqual(run('SVC=1;SUP=1;STOP_AFTER_AM=1;cycle',cycleFixture),['STATE repair_started','ACTION termux_lock','STATE disabled']);
});
test('stop arriving at the final supervisor launch boundary prevents launch',()=>{
  assert.deepEqual(run('SUP=1;STOP_BEFORE_START=1;cycle',cycleFixture),['STATE repair_started','STATE disabled']);
});
test('slow failed restore is rate limited using monotonic time even across wall-clock changes',()=>{
  assert.deepEqual(run('SVC=1;AM_FAIL=1;cycle;NOW=510;cycle;NOW=620;cycle',cycleFixture),[
    'STATE repair_started','ACTION termux_lock','STATE service_restore_failed','STATE rate_limited',
    'STATE repair_started','ACTION termux_lock','STATE service_restore_failed']);
});
test('read uncertainty or multiple matching supervisors never becomes absence',()=>{
  assert.deepEqual(run('SUP=2;cycle',cycleFixture),['STATE probe_failed']);
  assert.deepEqual(run('SUP=3;cycle',cycleFixture),['STATE supervisor_ambiguous']);
  assert.deepEqual(run('SVC=2;SUP=1;cycle',cycleFixture),['STATE probe_failed']);
});
test('supervisor appearing during FGS recovery is reused, never launched again',()=>{
  const setup=cycleFixture+'\nread_service_state(){ if [ "$SVC" = 0 ];then SUP=0;fi;return "$SVC"; }';
  assert.deepEqual(run('SVC=1;SUP=1;cycle',setup),['STATE repair_started','ACTION termux_lock','STATE recovered']);
});
test('async supervisor discovery waits rather than forcing service start',()=>{
  const setup=cycleFixture+'\nDISCOVERY=0;services_ready(){ DISCOVERY=$((DISCOVERY+1));[ "$DISCOVERY" -ge 3 ]; }';
  assert.deepEqual(run('SUP=1;cycle',setup),['STATE repair_started','ACTION supervisor_start','STATE recovered']);
});
test('failed or never-ready supervisor gives bounded safe failure',()=>{
  assert.deepEqual(run('SUP=1;START_FAIL=1;cycle',cycleFixture),['STATE repair_started','ACTION supervisor_start','STATE supervisor_restore_failed']);
  assert.deepEqual(run('SUP=1;READY=0;cycle',cycleFixture),['STATE repair_started','ACTION supervisor_start','STATE supervisor_not_ready']);
});
test('diagnostic storage failure blocks every recovery action',()=>{
  assert.deepEqual(run('record(){ printf "STATE %s\\n" "$1";return 1; };SVC=1;SUP=1;cycle;:',cycleFixture),['STATE repair_started']);
  assert.deepEqual(run('ROOT_DIR=/definitely-missing-watchdog-dir;record repair_started 2>/dev/null;printf "result=%s\\n" "$?"'),['result=1']);
});
test('Guardian preference parser accepts only one explicit complete enabled boolean',()=>{
  const variants=[
    ['<map>\n<boolean name="enabled" value="true" />\n</map>',0],
    ['<map>\n<boolean name="enabled" value="false" />\n</map>',1],
    ['<map>\n<boolean name="enabled" value="true" />',2],
    ['<map>\n<boolean name="enabled" value="true" />\n<boolean name="enabled" value="false" />\n</map>',2],
    ['<map>\n<string name="enabled">true</string>\n</map>',2],
    ['<map>\n</map>\n<boolean name="enabled" value="true" />',2],
    ['</map>\n<boolean name="enabled" value="true" />\n<map>',2],
    ['<map></map>\n<boolean name="enabled" value="true" />',2],
    ['',2],
  ];
  for(const [xml,code] of variants)assert.deepEqual(run('enabled;printf "result=%s\\n" "$?"',`read_file(){ printf '%s\\n' ${q(xml)}; }`),[`result=${code}`]);
  assert.deepEqual(run('enabled;printf "result=%s\\n" "$?"','read_file(){ return 1; }'),['result=2']);
});
test('scope validator rejects empty, incomplete, application and mixed cgroups',()=>{
  for(const [groups,valid] of [['5:freezer:/\n0::/',true],['',false],['0::/uid_10345/pid_22',false],['5:freezer:/\n0::/apps',false],['/',false]]){
    assert.deepEqual(run('check_scope;printf "result=%s\\n" "$?"',`bounded(){ printf '0\\n'; };read_file(){ printf '%s\\n' ${q(groups)}; }`),[`result=${valid?0:1}`]);
  }
});
test('foreground parser ignores other foreground services and requires unique exact block',()=>{
  const good='  * ServiceRecord{a u0 com.termux/.app.TermuxService c:com.termux}\n app=ProcessRecord{x 13727:com.termux/u0a345}\n isForeground=true foregroundId=1337';
  assert.deepEqual(run(`printf '%s\\n' ${q(good)} | foreground_pid`),['13727']);
  for(const value of [good.replace('isForeground=true','isForeground=false'),good.replace('.app.TermuxService','.app.RunCommandService'),`${good}\n${good}`]){
    assert.deepEqual(run(`printf '%s\\n' ${q(value)} | foreground_pid;printf 'result=%s\\n' "$?"`),['result=1']);
  }
});
test('wakelock check rejects history, disabled locks, wrong UID/PID and process reuse',()=>{
  const service='  * ServiceRecord{a u0 com.termux/.app.TermuxService c:com.termux}\n app=ProcessRecord{x 13727:com.termux/u0a345}\n isForeground=true foregroundId=1337';
  const good=" PARTIAL_WAKE_LOCK 'termux:service-wakelock' ACQ=-1m (uid=10345 pid=13727)";
  for(const [power,expected] of [[good,0],[good.replace('PARTIAL_WAKE_LOCK','HISTORY ACQ'),1],[good+' DISABLED',1],[good.replace('10345','10366'),1],[good.replace('13727','13728'),1]]){
    const setup=`TERMUX_UID=10345;bounded(){ shift;shift;case "$1" in activity) printf '%s\\n' ${q(service)};;power) printf '%s\\n' ${q(power)};;esac; };matches_process(){ MATCH_TOKEN=13727:99;return 0; };process_token(){ printf '13727:99\\n'; }`;
    assert.deepEqual(run('read_service_state;printf "result=%s\\n" "$?"',setup),[`result=${expected}`]);
  }
});
test('supervisor scan propagates ambiguous process reads and caps process count',()=>{
  assert.deepEqual(run('find_supervisor;printf "result=%s\\n" "$?"','bounded(){ printf "123\\n"; };matches_process(){ return 2; }'),['result=2']);
  assert.deepEqual(run('find_supervisor;printf "result=%s\\n" "$?"','bounded(){ printf "123 124\\n"; };matches_process(){ MATCH_TOKEN=$1:99;return 0; }'),['result=3']);
  assert.deepEqual(run('find_supervisor;printf "result=%s\\n" "$?"','bounded(){ printf "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17\\n"; };matches_process(){ return 1; }'),['result=2']);
});

test('package identity requires exact package, matching app owner and run-as UID',()=>{
  const setup=`bounded(){ shift;case "$1" in /system/bin/cmd)printf 'package:com.termux uid:10345\\npackage:com.termux.boot uid:10345\\n';;/system/bin/run-as)printf '%s\\n' "$RUN_UID";;esac; };owner(){ printf '%s\\n' "$OWNER"; };RUN_UID=10345;OWNER=10345`;
  assert.deepEqual(run('identity;printf "result=%s uid=%s\\n" "$?" "$TERMUX_UID"',setup),['result=0 uid=10345']);
  assert.deepEqual(run('RUN_UID=0;identity;printf "result=%s\\n" "$?"',setup),['result=1']);
  assert.deepEqual(run('OWNER=10346;identity;printf "result=%s\\n" "$?"',setup),['result=1']);
});
test('process identity tolerates parentheses in comm but rejects partial UIDs and unreadable stat',()=>{
  const stat=`123 (runsv dir (worker)) S ${Array(18).fill('0').join(' ')} 98765 0`;
  const setup=`TERMUX_UID=10345;proc_exists(){ return 0; };read_file(){ case "$1" in */stat)printf '%s\\n' ${q(stat)};;*/status)printf 'Uid:\\t10345\\t10345\\t10345\\t10345\\n';;esac; }`;
  assert.deepEqual(run('process_token 123',setup),['123:98765']);
  assert.deepEqual(run('read_file(){ return 124; };process_token 123;printf "result=%s\\n" "$?"',setup),['result=2']);
  assert.deepEqual(run('proc_exists(){ return 1; };process_token 123;printf "result=%s\\n" "$?"',setup),['result=1']);
});
test('live supervisor with an unlinked executable is ambiguous, not missing',()=>{
  const setup=`TERMUX_UID=10345;process_token(){ printf '123:98765\\n'; };process_command(){ printf '%s\\n%s\\n' "$PREFIX/bin/runsvdir" "$PREFIX/var/service"; };bounded(){ printf '%s\\n' "$EXE"; };EXE="$PREFIX/bin/runsvdir"`;
  assert.deepEqual(run('matches_process 123 supervisor;printf "result=%s\\n" "$?"',setup),['result=0']);
  assert.deepEqual(run('EXE="$EXE (deleted)";matches_process 123 supervisor;printf "result=%s\\n" "$?"',setup),['result=2']);
  assert.deepEqual(run('process_command(){ return 124; };matches_process 123 supervisor;printf "result=%s\\n" "$?"',setup),['result=2']);
});
test('process replacement between identity reads cannot count as same live supervisor',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-watchdog-pid-'));
  try{
    const count=path.join(temp,'count').replaceAll('\\','/');
    const setup=`process_token(){ local n;n=$(cat ${q(count)} 2>/dev/null || printf '0');n=$((n+1));printf '%s' "$n" >${q(count)};printf '123:%s\\n' "$n"; };process_command(){ printf 'com.termux\\n'; }`;
    assert.deepEqual(run('matches_process 123 termux;printf "result=%s\\n" "$?"',setup),['result=2']);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('service discovery preserves intentional down and rejects unexpected down',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-watchdog-down-'));
  try{
    const prefix=temp.replaceAll('\\','/');
    for(const s of ['fleet-vnc','fleet-wm','fleet-sync','fleet-voltage'])fs.mkdirSync(path.join(temp,'var','service',s),{recursive:true});
    const statuses=['fleet-vnc','fleet-wm','fleet-sync','fleet-voltage'].map(s=>`${s==='fleet-sync'?'down':'run'}: ${prefix}/var/service/${s}: 1s; run: log: (pid 8) 1s`).join('\n');
    const setup=`PREFIX=${q(prefix)};bounded(){ printf '%s\\n' ${q(statuses)}; }`;
    assert.deepEqual(run('services_ready;printf "result=%s\\n" "$?"',setup),['result=1']);
    fs.writeFileSync(path.join(temp,'var','service','fleet-sync','down'),'');
    assert.deepEqual(run('services_ready;printf "result=%s\\n" "$?"',setup),['result=0']);
    assert.equal(fs.existsSync(path.join(temp,'var','service','fleet-sync','down')),true);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('cycle function redirection closes singleton descriptor in descendant but retains parent descriptor',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-watchdog-fd-'));
  try{
    const file=path.join(temp,'lock').replaceAll('\\','/');
    const setup=`exec 9>${q(file)};cycle(){ ${q(bash.replaceAll('\\','/'))} -c 'if (: >&9) 2>/dev/null;then echo child_inherited;else echo child_closed;fi'; }`;
    assert.deepEqual(run('cycle 9>&-;if (: >&9)2>/dev/null;then echo parent_retained;else echo parent_lost;fi',setup),['child_closed','parent_retained']);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('stale or reused numeric PID file is checked without removing or rewriting it',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-watchdog-pidfile-'));
  try{
    const file=path.join(temp,'service-daemon.pid');fs.writeFileSync(file,'32123\n');
    const setup=`PIDFILE=${q(file.replaceAll('\\','/'))};TERMUX_UID=10345;owner(){ printf '10345\\n'; };read_file(){ cat "$1"; }`;
    assert.deepEqual(run('check_pidfile;printf "result=%s\\n" "$?"',setup),['result=0']);
    assert.equal(fs.readFileSync(file,'utf8'),'32123\n');
    fs.writeFileSync(file,'32123; injected\n');
    assert.deepEqual(run('check_pidfile;printf "result=%s\\n" "$?"',setup),['result=1']);
    assert.equal(fs.readFileSync(file,'utf8'),'32123; injected\n');
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('singleton contention and lock command failure are nonzero and do not publish active state',()=>{
  for(const status of [1,2,127]){
    assert.deepEqual(run(`acquire_lock 2>/dev/null;printf 'result=%s\\n' "$?"`,`lock_command(){ return ${status}; };record(){ echo BAD_STATE_WRITE; }`),[`result=${status}`]);
  }
  assert.deepEqual(run('acquire_lock;printf "result=%s\\n" "$?"','lock_command(){ return 0; };record(){ echo BAD_STATE_WRITE; }'),['result=0']);
});
test('native external printf limit: large power and service dumps use stdin, not argv',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-watchdog-large-'));
  try{
    const services=path.join(temp,'services.txt').replaceAll('\\','/');
    const power=path.join(temp,'power.txt').replaceAll('\\','/');
    const service='  * ServiceRecord{a u0 com.termux/.app.TermuxService c:com.termux}\n app=ProcessRecord{x 13727:com.termux/u0a345}\n isForeground=true foregroundId=1337\n';
    const lock=" PARTIAL_WAKE_LOCK 'termux:service-wakelock' ACQ=-1m (uid=10345 pid=13727)\n";
    const padding=('diagnostic-padding-'+'.'.repeat(1000)+'\n').repeat(260);
    const setup=`TERMUX_UID=10345;printf(){ local arg;for arg in "$@";do if [ "\${#arg}" -ge 131072 ];then /usr/bin/printf 'Argument list too long\\n' >&2;return 126;fi;done;/usr/bin/printf "$@"; };bounded(){ case "$*" in *dumpsys\\ activity*)cat ${q(services)};;*dumpsys\\ power*)cat ${q(power)};;*)return 99;;esac; };matches_process(){ MATCH_TOKEN=13727:99;return 0; };process_token(){ printf '13727:99\\n'; }`;
    for(const [largeServices,largePower] of [[false,true],[true,false],[true,true]]){
      fs.writeFileSync(services,service+(largeServices?padding:''));fs.writeFileSync(power,lock+(largePower?padding:''));
      assert.ok(Math.max(fs.statSync(services).size,fs.statSync(power).size)>200*1024);
      assert.deepEqual(run('read_service_state;printf "result=%s\\n" "$?"',setup),['result=0']);
    }
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('large partial dumps followed by timeout remain a probe error, never valid or missing',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-watchdog-partial-'));
  try{
    const file=path.join(temp,'partial.txt').replaceAll('\\','/');
    fs.writeFileSync(file,('partial-state\n').repeat(20000));
    const setup=`bounded(){ cat ${q(file)};return 124; };foreground_pid(){ echo BAD_PARSER_REACHED;return 0; }`;
    assert.deepEqual(run('read_service_state;printf "result=%s\\n" "$?"',setup),['result=2']);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('network inheritance requires granted INTERNET and the same live FGS already holding inet',()=>{
  const setup=`GRANTED=true;GROUPS_VALUE='3003 9997 20345 50345';TOKEN='13727:99';bounded(){ printf ' android.permission.INTERNET: granted=%s\\n' "$GRANTED"; };read_service_state(){ TERMUX_FGS_PID=13727;TERMUX_FGS_TOKEN=13727:99; };read_file(){ printf 'Groups: %s\\n' "$GROUPS_VALUE"; };process_token(){ printf '%s\\n' "$TOKEN"; }`;
  assert.deepEqual(run('network_capable_termux;printf "result=%s\\n" "$?"',setup),['result=0']);
  for(const change of ['GRANTED=false','GROUPS_VALUE=50345','GROUPS_VALUE=30030','TOKEN=13727:100','read_file(){ return 124; }','bounded(){ return 124; }']){
    assert.deepEqual(run(`${change};network_capable_termux;printf 'result=%s\\n' "$?"`,setup),['result=1']);
  }
  assert.deepEqual(run('bounded(){ printf "requested permissions: android.permission.INTERNET\\n"; };network_capable_termux;printf "result=%s\\n" "$?"',setup),['result=1']);
});
test('supervisor restoration uses only fixed inet wrapper then run-as, and stops if authorization disappears',()=>{
  const setup=`network_capable_termux(){ return 0; };enabled(){ return 0; };bounded(){ shift;printf 'CMD %s\\n' "$*";cat >/dev/null; }`;
  assert.deepEqual(run('start_supervisor',setup),['CMD /system/bin/su -g 0 -G 3003 -c exec /system/bin/run-as com.termux /system/bin/sh']);
  assert.deepEqual(run('enabled(){ return 1; };start_supervisor;printf "result=%s\\n" "$?"',setup),['result=1']);
  assert.deepEqual(run('network_capable_termux(){ return 1; };start_supervisor;printf "result=%s\\n" "$?"',setup),['result=1']);
});
test('post-run-as child refuses root, wrong UID, missing inet or inherited privileged groups before sourcing any service',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-watchdog-groups-'));
  try{
    const prefix=temp.replaceAll('\\','/');
    fs.mkdirSync(path.join(temp,'etc','profile.d'),{recursive:true});
    fs.writeFileSync(path.join(temp,'etc','profile.d','start-services.sh'),'echo CHILD_STARTED\n');
    const match=source.match(/<<'TERMUX_START'\n([\s\S]*?)\nTERMUX_START/);assert.ok(match);
    const child=match[1].replaceAll('/system/bin/id','fake_id').replaceAll('/system/bin/stat','fake_stat').replace('PREFIX=/data/data/com.termux/files/usr',`PREFIX=${q(prefix)}`);
    for(const [uid,owner,groups,expected] of [[10345,10345,'3003 50345 10345',0],[0,0,'3003',77],[10345,10346,'3003 50345',77],[10345,10345,'50345',77],[10345,10345,'3003 50345 0',77],[10345,10345,'3003 50345 2000',77]]){
      const input=`PATH=${q(hostPath)};export PATH\nfake_id(){ case "$1" in -u)printf '${uid}\\n';;-G)printf '%s\\n' ${q(groups)};;esac; };fake_stat(){ printf '${owner}\\n'; };\n${child}\n`;
      const result=shell(['--noprofile','--norc','-s'],{input,encoding:'utf8',timeout:5000,windowsHide:true});
      assert.equal(result.status,expected,result.stderr);assert.equal(result.stdout.trim(),expected===0?'CHILD_STARTED':'');
    }
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('script parses in sh and bounded command deadline kills only its own hung command',()=>{
  const syntax=shell(['--noprofile','--norc','-n'],{input:source,encoding:'utf8',windowsHide:true});assert.equal(syntax.status,0,syntax.stderr);
  const timeoutCandidates=process.env.FLEET_TEST_TIMEOUT?[process.env.FLEET_TEST_TIMEOUT]:[
    '/usr/bin/timeout',...(process.platform==='win32'&&process.env.LOCALAPPDATA?[path.join(process.env.LOCALAPPDATA,'TidewynTestTools/coreutils-8.32-5/usr/bin/timeout.exe')]:[])];
  const timeout=timeoutCandidates.find(candidate=>{
    const result=shell(['--noprofile','--norc','-c',`${q(candidate.replaceAll('\\','/'))} --version`],{encoding:'utf8',windowsHide:true,timeout:5000});
    return result.status===0&&/^timeout \(GNU coreutils\)/m.test(result.stdout||'');
  });
  assert.ok(timeout,'GNU timeout is required; set FLEET_TEST_TIMEOUT to its executable path');
  // Windows Git Bash has GNU timeout, but no Android toybox. Replace only
  // this executable in an isolated test copy; production has no injection API.
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-watchdog-deadline-'));
  try{
    const file=path.join(temporary,'run.sh');
    // Bundled Git may omit both coreutils timeout and sleep. Keep its other
    // utilities and DLLs available; explicitly use sleep alongside timeout.
    const sleeper=path.isAbsolute(timeout)?path.join(path.dirname(timeout),process.platform==='win32'?'sleep.exe':'sleep').replaceAll('\\','/'):'sleep';
    const child=`trap "" TERM; ${q(sleeper)} 15`;
    fs.writeFileSync(file,`${functions.replaceAll('/system/bin/timeout',q(timeout.replaceAll('\\','/')))}\nPATH=${q(hostPath)};export PATH\nbounded 1 ${q(bash.replaceAll('\\','/'))} -c ${q(child)};r=$?;printf 'exit=%s\\n' "$r"\n`);
    const start=performance.now();
    const r=shell(['--noprofile','--norc',file],{encoding:'utf8',windowsHide:true,timeout:7000});
    assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/exit=(124|137)/);assert.ok(performance.now()-start<6000);
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
