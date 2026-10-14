// Independent audit regression. Synthetic progressive DOM states are not
// claimed as a newly observed live platform response. No browser or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {clickAndBoatDetailReady} from '../../collectors/clickandboat.mjs';
import {parseClickAndBoatDetail} from '../../parsers.mjs';

const ready=bodyText=>runInNewContext(`(${clickAndBoatDetailReady.toString()})()`,{document:{body:{innerText:bodyText}}});
const options={url:'https://www.clickandboat.com/uk/booking/1250578/detail',
  boataround_slug:'seacat-open-40-tidewyn-discovery-2',verifiedAt:'2026-09-10T08:00:00Z'};

test('CB readiness must wait when date labels exist before their values',()=>{
  for(const status of ['ACCEPTED','CANCELLED']){
    const text=`Booking N°1250578\n${status}\nCHECK-IN\nCHECK-OUT\nNet amount (boat owner)\n`;
    assert.throws(()=>parseClickAndBoatDetail({...options,bodyText:text}));
    assert.equal(ready(text),false,'Date labels alone are not completed current order fields: '+status);
  }
});

test('CB readiness must wait when the accepted order net-price label has no value yet',()=>{
  const text='Booking N°1250578\nACCEPTED\nCHECK-IN\n07/11/2026\nCHECK-OUT\n13/11/2026\nNet amount (boat owner)\n';
  assert.throws(()=>parseClickAndBoatDetail({...options,bodyText:text}));
  assert.equal(ready(text),false,'A present financial heading must not end the loading wait.');
});

test('loaded paid detail and current cancellation without any financial section remain ready',()=>{
  const dates='CHECK-IN\n07/11/2026\nCHECK-OUT\n13/11/2026';
  const paid=`Booking N°1250578\nACCEPTED\n${dates}\nNet amount (boat owner)\n€11,310`;
  const cancelled=`Booking N°1250578\nCANCELLED\n${dates}`;
  assert.equal(ready(paid),true);assert.equal(ready(cancelled),true);
  assert.equal(parseClickAndBoatDetail({...options,bodyText:paid}).status,'accepted');
  assert.equal(parseClickAndBoatDetail({...options,bodyText:cancelled}).status,'cancelled');
});
