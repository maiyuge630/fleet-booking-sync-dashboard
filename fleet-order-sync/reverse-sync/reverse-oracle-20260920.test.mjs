import test from 'node:test';
import assert from 'node:assert/strict';
import {segments,uncovered} from './planner.mjs';
import {releaseOwned} from './release.mjs';

test('fixed-seed day-set oracle covers cancellation, rescheduling, overlaps and manual preservation across year/leap boundaries',async()=>{
  // All 400 cases are local simulations, not platform requests. Integer day
  // membership is the independent oracle; it does not reuse interval subtraction.
  let seed=20920317,deletions=0,preserved=0;
  const random=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;};
  const stamp='2026-09-20T12:00:00.000Z',now=Date.parse(stamp);
  for(let trial=0;trial<400;trial++){
    const base=Date.parse((trial%2?'2026-12-20':'2028-02-20')+'T00:00:00Z');
    const date=offset=>new Date(base+offset*86400000).toISOString().slice(0,10);
    const range=(start,end)=>({start:date(start),end:date(end)});
    const daySet=interval=>{const result=new Set();for(let day=0;day<40;day++)if(date(day)>=interval.start&&date(day)<interval.end)result.add(day);return result;};
    const union=items=>new Set(items.flatMap(item=>[...daySet(item)]));
    const from=random(8),until=from+1+random(6),old=range(from,until),kind=trial%5;
    const own={id:'owned',...old,type:'Unavailable'};
    const causes=[];let proof;
    if(kind===0)proof={key:'source:original',state:'cancelled'};
    else if(kind===1)proof=null;
    else{
      const next=kind===2?old:kind===3?range(until+1,until+4):range(Math.max(0,until-1),until+2);
      causes.push({key:'source:original',...next});proof={key:'source:original',state:'active',...next};
    }
    // Separate pending/manual/native obligations can surround, overlap, touch,
    // or nest in the old interval, including a duplicate manual range.
    for(let n=0;n<random(4);n++){const start=random(20);causes.push({key:'other:'+n,...range(start,start+1+random(6))});}
    const other=[];
    for(let n=0;n<random(4);n++){const start=random(20);other.push({id:'manual:'+n,...range(start,start+1+random(6)),type:'Unavailable'});}
    if(trial%3===0)other.push(...causes.map((cause,index)=>({id:'separate:'+index,start:cause.start,end:cause.end,type:'Unavailable'})));
    if(other.length&&trial%4===0)other.push({...other[0],id:'duplicate-manual'});
    const desired=segments(causes),active=union(causes),oldDays=daySet(old),othersDays=union(other);
    assert.deepEqual([...union(desired)].sort((a,b)=>a-b),[...active].sort((a,b)=>a-b));
    for(let day=0;day<40;day++){
      const covering=desired.filter(interval=>daySet(interval).has(day));assert.ok(covering.length<=1);
      assert.deepEqual(covering[0]?.causes||[],causes.filter(cause=>daySet(cause).has(day)).map(cause=>cause.key).sort());
    }
    assert.deepEqual([...union(uncovered(old,other))].sort((a,b)=>a-b),[...oldDays].filter(day=>!othersDays.has(day)).sort((a,b)=>a-b));
    const fresh=trial%11!==0,proofReady=trial%7!==0;
    const target={target:'clickandboat',boat:'oracle-boat',listing_id:'1',fresh,segments:desired,
      release_proof:{ready:proofReady,checked_at:stamp,orders:[...(proof?[proof]:[]),...causes.filter(c=>c.key!=='source:original').map(c=>({...c,state:'active'}))]}};
    const terminal=proof?.state==='cancelled'||proof?.state==='active'&&![...daySet(proof)].some(day=>oldDays.has(day));
    // 2026-10-04: a required day that no record covers (e.g. one the Click&Boat
    // app cannot close) no longer blocks an unrelated opening. Opening is still
    // refused whenever the owned record is the only cover of a required day.
    const expected=!!(fresh&&proofReady&&terminal&&[...oldDays].some(day=>!active.has(day))&&![...active].some(day=>oldDays.has(day)&&!othersDays.has(day)));
    let rows=[structuredClone(own),...structuredClone(other)],writes=0;
    const attempt={id:'attempt',target:'clickandboat:1',state:'confirmed',...old,created:structuredClone(own),causes:['source:original']};
    const ledger={version:1,attempts:[attempt],targets:{}};
    const adapter={read:async()=>({complete:true,identity_verified:true,blocks:structuredClone(rows)}),
      remove:async(_target,record,{guard})=>{await guard();writes++;assert.equal(record.id,'owned');rows=rows.filter(row=>row.id!=='owned');}};
    await releaseOwned({ledger,key:attempt.target,target,adapter,blocks:structuredClone(rows),plan:async()=>({generated_at:stamp,targets:[target]}),save:async()=>{},now:()=>now});
    assert.equal(writes,expected?1:0,'release oracle case '+trial);
    assert.deepEqual(rows.filter(row=>row.id!=='owned'),other,'manual records remain byte-for-byte unchanged');
    // Every required day that was closed before the opening is still closed.
    if(expected){deletions++;assert.ok([...active].every(day=>!(othersDays.has(day)||oldDays.has(day))||union(rows).has(day)));assert.equal(attempt.state,'released');}
    else{preserved++;assert.equal(attempt.state,'confirmed');}
  }
  assert.ok(deletions>10&&preserved>100,'both permitted openings and rejected openings were exercised');
});
