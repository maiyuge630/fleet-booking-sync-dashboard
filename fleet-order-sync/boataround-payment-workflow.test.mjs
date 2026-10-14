import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {FLEET} from './parsers.mjs';
import {buildPlan} from './reverse-sync/planner.mjs';
const require=createRequire(import.meta.url),{extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const html=extractHTML(fs.readFileSync(new URL('./integrated-source.mjs',import.meta.url),'utf8'));
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const ctx=vm.createContext({document:{getElementById(){return {addEventListener(){}}},querySelectorAll(){return []},addEventListener(){}},window:{addEventListener(){}},URL,Date,setTimeout(){},clearTimeout(){},AbortController,console});
vm.runInContext(script.replace(/\binitialize\(\);\s*$/,''),ctx);
test('dashboard shows payment separately from the real Boataround workflow',()=>{
 // 2026-09-27 copy review: keep the platform's own workflow name.
 for(const [platform_status,suffix] of [['NEW',' · NEW'],['IN PROCESS',' · IN PROCESS'],['CONFIRMED','']]){
  assert.equal(ctx.orderStatus({source:'boataround',status:'deposit_paid',platform_status}),'已付定金'+suffix);
  assert.equal(ctx.orderStatus({source:'boataround',status:'paid',platform_status}),'已付款'+suffix);
 }
 assert.equal(ctx.orderStatus({source:'clickandboat',status:'accepted',platform_status:'ACCEPTED'}),'已接受');
 assert.equal(ctx.orderStatus({source:'samboat',status:'deposit_paid',platform_status:'DEPOSIT PAID'}),'已付定金');
});
test('paid unconfirmed requests verify the whole stay on all mapped targets, without assuming a native block',()=>{
 const now=Date.parse('2026-09-24T05:00:00Z'),stamp=new Date(now).toISOString();
 const status={platforms:Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(s=>[s,{mode:'dynamic',last_error:null,last_success_at:stamp}]))};
 for(const platform_status of ['NEW','IN PROCESS']){
  const record={booking_id:'319580',boataround_slug:FLEET[4].slug,start:'2027-01-24',end:'2027-01-30',status:'deposit_paid',platform_status,customer_payment:'PARTIALLY PAID',verified_at:stamp};
  const plan=buildPlan({boataround:[record],clickandboat:[],samboat:[],mmk:[],nausys:[]},status,{now});
  for(const target of plan.targets.filter(t=>t.boat===record.boataround_slug))assert.deepEqual(target.segments,[{start:'2027-01-24',end:'2027-01-31',causes:['boataround:319580']}]);
  assert.equal(record.end,'2027-01-30');
 }
});
