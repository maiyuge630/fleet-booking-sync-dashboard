'use strict';
// 2026-10-04 evening: the dashboard kept "同步中…" (disabled) because the last
// manual run, requested before MMK became a source, had only three results.
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {phoneSyncScript}=require('./frontend-sync-patch.cjs');
const context=vm.createContext({});vm.runInContext(phoneSyncScript,context);
const ok=at=>({outcome:'success',checked_at:at});
const status=(requestedAt,results,extra={})=>({ok:true,mode:'phone',paired:true,online:true,state:'idle',requested_run_id:null,order_sync:{platforms:{}},
  manual_run:{id:'26c987d3-5b2b-4c76-86a6-b12a7d5e0943',state:'completed',requested_at:requestedAt,completed_at:'2026-10-04T08:00:00.000Z',results},...extra});
const three=at=>({boataround:ok(at),clickandboat:ok(at),samboat:ok(at)});

test('a three-platform run completed before MMK joined is complete and releases the button',()=>{
  const s=status('2026-10-03T09:58:00.000Z',three('2026-10-03T10:00:00.000Z'));
  const run=context.phoneRunProgress(s);
  assert.equal(run.phase,'completed');assert.equal(run.pending,false);assert.equal(run.successful,true);
  const text=context.phoneRunText(s,x=>x);
  assert.ok(!text.includes('MMK'),'the old run is not reported as waiting for MMK');
  assert.ok(!text.includes('等待本轮结果'));
});
test('a run requested after MMK joined still waits for MMK',()=>{
  const s=status('2026-10-04T19:50:00.000Z',three('2026-10-04T19:52:00.000Z'),{});
  s.manual_run.state='running';s.manual_run.completed_at=null;s.requested_run_id=s.manual_run.id;
  const run=context.phoneRunProgress(s);
  assert.equal(run.pending,true);assert.notEqual(run.phase,'completed');
  assert.match(context.phoneRunText(s,x=>x),/MMK：等待本轮结果/);
  // Once the server has every result and the phone's acknowledgment it marks
  // the run completed; before that, three results are not completion.
  s.manual_run.state='awaiting_upload';s.manual_run.completed_at='2026-10-04T19:56:00.000Z';s.requested_run_id=null;
  assert.equal(context.phoneRunProgress(s).pending,true);
  const done=status('2026-10-04T19:50:00.000Z',{...three('2026-10-04T19:52:00.000Z'),mmk:ok('2026-10-04T19:53:00.000Z')});
  assert.equal(context.phoneRunProgress(done).phase,'completed');
  assert.match(context.phoneRunText(done,x=>x),/MMK：最新订单已保存/);
  const missing=status('2026-10-04T19:50:00.000Z',three('2026-10-04T19:52:00.000Z'));
  assert.equal(context.phoneRunProgress(missing).pending,true,'a later run is not complete without MMK even if marked completed');
});
test('an older completed run still needs its other three platforms',()=>{
  for(const source of ['boataround','clickandboat','samboat']){
    const results=three('2026-10-03T10:00:00.000Z');delete results[source];
    assert.equal(context.phoneRunProgress(status('2026-10-03T09:58:00.000Z',results)).pending,true,source);
  }
});
