// Independent telemetry: this module never modifies bookings or availability.
export const VOLTAGE_KEY='fleet-voltage:v1';
export const VOLTAGE_MAX_AGE=36*3600000;
// AD6 is the device of Lightcat 400 S2 (Tidewyn Discovery 6), as the owner
// confirmed on 2026-10-10; it had been listed under AD3, which has no device.
export const VOLTAGE_BOATS={
 ADD:'wavecat-34-open-tidewyn-dream',
 AD1:'reef-cat-37-tidewyn-discovery',
 AC1:'harbor-cruiser-34-tidewyn-cruise',
 AD2:'seacat-open-40-tidewyn-discovery-2',
 AD6:'lightcat-400-s2-tidewyn-discovery-6',
 AC2:'coastline-sea-journey-42-tidewyn-cruise-2',
 AD5:'grandcat-55-tidewyn-discovery-5'
};
/** Stored readings follow the current device table, not the one in force
 * when they were uploaded (AD6 moved to Lightcat on 2026-10-10). */
export function currentVoltageBoats(state){
 if(!state||!Array.isArray(state.devices))return state;
 return {...state,devices:state.devices.map(d=>({...d,boat:VOLTAGE_BOATS[d.code]||null}))};
}
const errors=['auth_required','fetch_failed','schema_changed','incomplete_pages','root_unavailable'];
function invalid(){throw Object.assign(new Error('invalid_voltage_snapshot'),{status:400});}
function time(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)invalid();return v;}
export function normalizeVoltage(input,now=Date.now()){
 if(!input||input.version!==1||!['success','failure'].includes(input.outcome))invalid();
 const checked_at=time(input.checked_at),next_run_at=time(input.next_run_at);
 if(Date.parse(checked_at)>now+600000||Date.parse(checked_at)<now-7*86400000||Date.parse(next_run_at)<Date.parse(checked_at)||Date.parse(next_run_at)>Date.parse(checked_at)+26*3600000)invalid();
 const result={version:1,checked_at,next_run_at,outcome:input.outcome};
 if(input.outcome==='failure'){if(!errors.includes(input.error_code))invalid();return {...result,error_code:input.error_code};}
 if(!Array.isArray(input.devices)||!input.devices.length||input.devices.length>100)invalid();
 const seen=new Set();result.devices=input.devices.map(d=>{
  if(!d||typeof d.code!=='string'||!/^[A-Z0-9-]{1,30}$/.test(d.code)||seen.has(d.code))invalid();seen.add(d.code);
  if(d.volts!==null&&(typeof d.volts!=='number'||!Number.isFinite(d.volts)||d.volts<0||d.volts>200))invalid();
  if(typeof d.online!=='boolean'||typeof d.low_voltage!=='boolean'||!['normal','power_off','backup_low','unknown'].includes(d.power))invalid();
  if(d.source_time!==null&&(typeof d.source_time!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d.source_time)||!Number.isFinite(Date.parse(d.source_time.replace(' ','T')+'Z'))||new Date(d.source_time.replace(' ','T')+'Z').toISOString().slice(0,19).replace('T',' ')!==d.source_time))invalid();
  const motion_state=d.motion_state===undefined?'unknown':d.motion_state,stationary_time=d.stationary_time===undefined?null:d.stationary_time;
  if(!['unknown','stationary','moving','offline'].includes(motion_state)||stationary_time!==null&&(typeof stationary_time!=='string'||!stationary_time.length||stationary_time.length>80||/[<>\x00-\x1f\x7f]/.test(stationary_time)))invalid();
  if(motion_state==='stationary'&&!stationary_time||['moving','unknown'].includes(motion_state)&&stationary_time!==null)invalid();
  const online=d.online&&motion_state!=='offline';
  // Apply the same conservative status rule to delayed snapshots from older
  // phone builds: an offline source must not be presented as a current reading.
  return {code:d.code,boat:VOLTAGE_BOATS[d.code]||null,volts:d.volts,online,power:d.power,low_voltage:d.low_voltage,source_time:d.source_time,motion_state:!online&&motion_state!=='unknown'?'offline':motion_state,stationary_time};
 });
 // A successful telemetry report replaces the entire stored set. Independently
 // require every configured boat here so a truncated client report cannot erase
 // the other boats' last verified readings or claim a complete fresh update.
 if(Object.keys(VOLTAGE_BOATS).some(code=>!seen.has(code)))invalid();
 return result;
}
export function mergeVoltage(previous,input){
 if(previous?.checked_at&&Date.parse(previous.checked_at)>=Date.parse(input.checked_at))return previous;
 return {version:1,checked_at:input.checked_at,next_run_at:input.next_run_at,error_code:input.outcome==='failure'?input.error_code:null,
  last_success_at:input.outcome==='success'?input.checked_at:previous?.last_success_at||null,
  devices:input.outcome==='success'?input.devices:previous?.devices||[]};
}
