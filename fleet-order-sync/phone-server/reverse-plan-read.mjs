// Plan retrieval is read-only. Retrying a platform mutation or an upload here
// would be unsafe; this helper exposes only the fixed GET reverse-plan route.
const NETWORK_CODES=new Set(['ECONNRESET','ECONNREFUSED','EPIPE','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT',
 'UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
const TRANSIENT_STATUS=new Set([408,500,502,503,504,520,521,522,523,524]);
export function transientPlanRead(error){
 if(error?.code==='worker_unavailable')return TRANSIENT_STATUS.has(error.status);
 const code=error?.cause?.code||error?.code;
 return NETWORK_CODES.has(code)||error?.name==='TypeError'&&error.message==='fetch failed'&&!code;
}
const unavailable=error=>Object.assign(new Error('reverse_plan_unavailable'),{code:'reverse_plan_unavailable',cause:error});

export async function readReversePlan(remote,{signal,isCancelled=()=>false,timeoutMs=30000,retryDelays=[500,1000,2000,4000]}={}){
 if(isCancelled())throw Error('phone_shutdown');
 if(signal?.aborted)throw signal.reason||new DOMException('Aborted','AbortError');
 const controller=new AbortController();let rejectStopped;
 const stopped=new Promise((_,reject)=>{rejectStopped=reject;});stopped.catch(()=>{});
 const stop=reason=>{if(!controller.signal.aborted){controller.abort(reason);rejectStopped(reason);}};
 const onAbort=()=>stop(signal.reason||new DOMException('Aborted','AbortError'));
 signal?.addEventListener('abort',onAbort,{once:true});
 const timer=setTimeout(()=>stop(new DOMException('Plan read timed out','TimeoutError')),timeoutMs);timer.unref?.();
 try{
  for(let attempt=0;attempt<5;attempt++){
   if(isCancelled())throw Error('phone_shutdown');
   if(controller.signal.aborted)throw controller.signal.reason;
   try{
    const result=await Promise.race([Promise.resolve().then(()=>{
     if(controller.signal.aborted)throw controller.signal.reason;
     return remote.request('reverse-plan',null,'GET',{signal:controller.signal});
    }),stopped]);
    if(isCancelled())throw Error('phone_shutdown');
    if(controller.signal.aborted)throw controller.signal.reason;
    return result;
   }catch(error){
    if(isCancelled())throw Error('phone_shutdown');
    if(signal?.aborted)throw signal.reason||error;
    if(controller.signal.aborted)throw unavailable(error);
    if(!transientPlanRead(error))throw error;
    if(attempt===4)throw unavailable(error);
    let pause;
    try{await Promise.race([new Promise(resolve=>{pause=setTimeout(resolve,retryDelays[attempt]);}),stopped]);}
    catch(error){if(isCancelled())throw Error('phone_shutdown');if(signal?.aborted)throw signal.reason||error;throw unavailable(error);}
    finally{clearTimeout(pause);}
   }
  }
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
}
