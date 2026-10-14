import {FleetPhoneAgent,PHONE_AGENT_KEY} from '../phone-agent.mjs';
import {ReverseSync} from '../reverse-sync/store.mjs';
import {FLEET} from '../parsers.mjs';
export const fixedNow=Date.parse('2026-09-22T08:00:00Z'),boat=FLEET[3].slug,origin='http://127.0.0.1:8883';
export class Storage {
  data=new Map();pending=Promise.resolve();failPut=null;
  async get(k){return structuredClone(this.data.get(k));}async put(k,v){this.data.set(k,structuredClone(v));}async deleteAlarm(){}
  transaction(work){const run=this.pending.then(async()=>{const staged=new Map(structuredClone([...this.data]));const tx={get:async k=>structuredClone(staged.get(k)),put:async(k,v)=>{if(k===this.failPut)throw Error('injected storage failure');staged.set(k,structuredClone(v));}};const result=await work(tx);this.data=staged;return result;});this.pending=run.catch(()=>{});return run;}
}
export function harness(now=()=>fixedNow){const storage=new Storage(),mapping={boataround:[],clickandboat:[],samboat:[],mmk:[],nausys:[]};let failed=false;
 const status=async()=>({platforms:Object.fromEntries(['boataround','clickandboat','samboat','mmk','nausys'].map(s=>[s,{mode:'dynamic',last_success_at:new Date(now()).toISOString(),last_error:failed&&s==='samboat'?'auth_required':null}]))});
 const agent=new FleetPhoneAgent({storage,registry:async()=>mapping,registryStatus:status,ingest:async()=>({results:[]}),now});
 const reverse=new ReverseSync({storage,registry:async()=>mapping,registryStatus:status,now});
 storage.data.set(PHONE_AGENT_KEY,{mode:'phone',token_hash:'fixture-only-not-a-credential',enabled:true,state:'idle',requested_run_id:null,manual_run:null});
 return {storage,mapping,status,agent,reverse,failSource:()=>failed=true};
}
export const add=(revision=0,extra={})=>({action:'add',request_id:crypto.randomUUID(),revision,boat,name:'WhatsApp · 验收客户',channel:'WhatsApp',start:'2027-03-06',end:'2027-03-13',payment_status:'deposit_paid',...extra});
export const cancel=(id,revision)=>({action:'cancel',request_id:crypto.randomUUID(),revision,id});
export function req(path,data,headers={}){return new Request(origin+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin',...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});}
export const submit=(h,p)=>h.agent.user(req('/api/manual-orders',p));
