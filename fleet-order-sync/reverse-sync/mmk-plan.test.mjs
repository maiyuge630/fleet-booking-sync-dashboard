import test from 'node:test';
import assert from 'node:assert/strict';
import {mmkPlan,mmkNights,MMK_FLEET} from './mmk-plan.mjs';
const boat=MMK_FLEET[1].boat;
function input(){return {rule_version:2,generated_at:'2026-09-13T09:00:00Z',targets:['boataround','clickandboat','samboat'].map(target=>({boat,target,fresh:true,release_proof:{ready:true}})),causes:[{key:'boataround:303719',boat,start:'2026-12-26',end:'2027-01-03',fresh:true},{key:'samboat:1502428',boat,start:'2027-01-01',end:'2027-01-09',fresh:true}]};}
test('MMK closes nights only: the checkout day is dropped and real overlaps keep both causes (2026-10-09)',()=>{
 const source=input(),before=JSON.stringify(source),a=mmkPlan(source).targets[1];
 // Boataround 12-26 to 01-02 and SamBoat 01-01 to 01-08 (checkout dates).
 assert.equal(a.fresh,true);
 assert.deepEqual(a.segments,[{start:'2026-12-26',end:'2027-01-01',causes:['boataround:303719']},
  {start:'2027-01-01',end:'2027-01-02',causes:['boataround:303719','samboat:1502428']},
  {start:'2027-01-02',end:'2027-01-08',causes:['samboat:1502428']}]);
 assert.equal(JSON.stringify(source),before);assert.deepEqual(mmkPlan(source).targets[1],a);
});
test('a turnover day is not a night of either order',()=>{
 const p=input();p.causes[1].start='2027-01-02';
 assert.deepEqual(mmkPlan(p).targets[1].segments.map(s=>[s.start,s.end,s.causes.length]),[['2026-12-26','2027-01-02',1],['2027-01-02','2027-01-08',1]]);
});
test('a day trip keeps its one night; malformed dates pass through for the planner to reject',()=>{
 assert.deepEqual(mmkNights({start:'2027-02-10',end:'2027-02-11'}),{start:'2027-02-10',end:'2027-02-11'});
 assert.deepEqual(mmkNights({start:'2027-02-10',end:'2027-02-12'}),{start:'2027-02-10',end:'2027-02-11'});
 for(const bad of [{start:'2027-02-10'},{start:'bad',end:'2027-02-12'},{start:'2027-02-10',end:'2027-02-30x'}])assert.deepEqual(mmkNights(bad),bad);
});
test('MMK fails closed on a stale or missing source',()=>{
 const source=input();source.targets[0].fresh=false;assert.equal(mmkPlan(source).targets[1].fresh,false);
 source.targets.shift();assert.equal(mmkPlan(source).targets[1].fresh,false);
});
test('MMK only maps the three verified boats',()=>{
 const result=mmkPlan(input());assert.equal(result.targets.length,3);
 assert.ok(result.targets.every(t=>!t.boat.includes('discovery-3')&&!t.boat.includes('cruise-2')));
 assert.throws(()=>mmkPlan({...input(),rule_version:1}),/invalid/);
});
test('machine wire plan derives nights from validated full order proofs',()=>{
 const p=input();p.targets[0].release_proof.orders=p.causes.map(c=>({...c,state:'active'}));delete p.causes;
 assert.equal(mmkPlan(p).targets[1].segments.at(-1).end,'2027-01-08');
 assert.equal(mmkPlan(p).targets[1].fresh,true);
 delete p.targets[0].release_proof.orders;assert.equal(mmkPlan(p).targets[1].fresh,false);
});
test('the release proof is converted to nights on a copy; cancellations pass unchanged',()=>{
 const p=input();
 p.targets[0].release_proof={ready:true,checked_at:p.generated_at,orders:[{key:'boataround:303719',state:'active',start:'2026-12-26',end:'2027-01-03'},{key:'boataround:1',state:'cancelled'}]};
 const before=JSON.stringify(p.targets[0].release_proof),proof=mmkPlan(p).targets[1].release_proof;
 assert.deepEqual(proof.orders,[{key:'boataround:303719',state:'active',start:'2026-12-26',end:'2027-01-02'},{key:'boataround:1',state:'cancelled'}]);
 assert.equal(proof.ready,true);assert.equal(JSON.stringify(p.targets[0].release_proof),before);
});
