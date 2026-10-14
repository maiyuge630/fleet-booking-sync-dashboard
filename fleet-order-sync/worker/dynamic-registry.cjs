'use strict';

// MMK is the fourth order source since 2026-10-04 and NauSYS the fifth since
// 2026-10-09 (user decisions).
const ORDER_SYNC_SOURCES = ['boataround', 'clickandboat', 'samboat', 'mmk', 'nausys'];
const ORDER_SYNC_PREFIX = 'fleet/order-sync-v1/';
const ORDER_SYNC_MAX_BYTES = 900 * 1024;
const ORDER_SYNC_ERRORS = ['auth_required', 'fetch_failed', 'schema_changed', 'incomplete_pages', 'challenge_required'];
const ORDER_SYNC_MANUAL_CANCEL = {
  source: 'samboat', booking_id: '1000001', status: 'cancelled',
  boataround_slug: 'seacat-open-40-tidewyn-discovery-2',
  reason: '用户明确确认取消；自动同步不能恢复此订单'
};
// This is the user's authorization for one existing order, not a platform
// payment API response or a general-purpose order editing interface.
const ORDER_SYNC_MANUAL_RESCHEDULE = {
  source:'clickandboat',booking_id:'1000000',boataround_slug:'seacat-open-40-tidewyn-discovery-2',
  original_start:'2026-03-14',original_end:'2026-03-21',start:'2027-03-06',end:'2027-03-13',
  url:'https://www.clickandboat.com/uk/booking/1000000/detail',amount:'€4,200.00',amount_basis:'船东净收入',
  payment_evidence:{kind:'owner_settlement',amount:4200,currency:'EUR',paid_on:'2026-03-16',detail_url:'https://www.clickandboat.com/uk/booking/1000000/detail'}
};

function createOrderRegistry({ bucket, normalizeBooking, fleetSpecs, bootstrapMap, now = () => Date.now() }) {
  if (!bucket || typeof normalizeBooking !== 'function' || !Array.isArray(fleetSpecs)) throw new Error('Order registry dependencies unavailable');
  const fleetSlugs = fleetSpecs.map(boat => boat.boataround_slug).sort();
  const clone = value => JSON.parse(JSON.stringify(value));
  const issue = (message, status = 422) => Object.assign(new Error(message), { status });
  const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  function day(value) {return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && instant(value + 'T00:00:00Z')?.slice(0, 10) === value;}
  // Only SamBoat's verified day-trip format permits identical source dates.
  function orderDates(source,start,end) {return day(start) && day(end) && (end > start || source === 'samboat' && end === start);}
  function beijingDay(value) {const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value)).map(part=>[part.type,part.value]));return parts.year+'-'+parts.month+'-'+parts.day;}
  function jsonValue(value) {
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > ORDER_SYNC_MAX_BYTES) throw issue('订单快照超过保存上限', 413);
    return text;
  }
  async function fingerprint(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function resolveBoat(source, record) {
    // The MMK and NauSYS collectors map their own yachts and send only the fleet slug.
    const bySlug = source === 'boataround' || source === 'mmk' || source === 'nausys';
    const key = bySlug ? record.boataround_slug ?? (source === 'boataround' ? record.boat : undefined) : record.boat ?? record.boataround_slug;
    const alias = String(key) === 'comet' ? 'reef-cat-37-tidewyn-discovery' : String(key);
    const idField = source === 'clickandboat' ? 'clickandboat_id' : 'samboat_id';
    const matches = fleetSpecs.filter(boat => bySlug
      ? typeof key === 'string' && key === boat.boataround_slug
      : alias === boat.boataround_slug || boat[idField] != null && String(key) === String(boat[idField]));
    if (matches.length !== 1) throw issue('订单船只无法唯一匹配');
    return matches[0].boataround_slug;
  }
  function validatePaymentEvidence(source, record, normalized) {
    const label = value => typeof value === 'string' ? value.trim().replace(/\s+/g,' ').toUpperCase() : '';
    // Cancellation can authorize reverse opening. The adapter's normalized
    // label alone must not turn an active/unknown platform record into proof.
    // All three observed current-status parsers use these two terminal labels.
    if (['cancelled','canceled'].includes(normalized.status)) {
      // MMK and NauSYS also end an Option by letting it expire.
      if (!['CANCELLED','CANCELED',...(['mmk','nausys'].includes(source) ? ['OPTION EXPIRED'] : [])].includes(label(record.platform_status))) {
        throw issue('取消订单必须有一致的平台当前已取消状态');
      }
      normalized.platform_status = record.platform_status;
      return;
    }
    const active = ['accepted','deposit_paid','paid'].includes(normalized.status);
    if (!active) return; // Cancellation/inactive status wins over historical payment fields.
    if (source === 'boataround') {
      const required = normalized.status === 'paid' ? 'PAID' : normalized.status === 'deposit_paid' ? 'PARTIALLY PAID' : null;
      if (!required || !['CONFIRMED','NEW','IN PROCESS'].includes(label(record.platform_status)) || label(record.customer_payment) !== required) {
        throw issue('Boataround 有效订单必须有明确的未取消状态和一致的客户实际付款状态');
      }
      normalized.customer_payment = required;
    } else if (source === 'clickandboat') {
      const paid = record.customer_payment_verified === true && typeof record.customer_paid_amount === 'number' &&
        Number.isFinite(record.customer_paid_amount) && record.customer_paid_amount > 0;
      // User decision 2026-09-29: the official app shows no customer payment, so
      // an order it lists as Accepted counts. It must carry that exact label.
      const appAccepted = !paid && record.payment_basis === 'platform_accepted' && label(record.platform_status) === 'ACCEPTED';
      if (normalized.status !== 'accepted' || !(paid || appAccepted) ||
          (record.platform_status !== undefined && label(record.platform_status) !== 'ACCEPTED')) {
        throw issue('Click&Boat 有效订单必须已接受，并有客户已付款核验或官方 App 的 Accepted 状态');
      }
      if (appAccepted) {
        normalized.payment_basis = 'platform_accepted';
        if (record.payment_basis_source !== undefined) {
          if (typeof record.payment_basis_source !== 'string' || !record.payment_basis_source.trim() || record.payment_basis_source.length > 500) throw issue('Click&Boat 订单依据来源格式无效');
          normalized.payment_basis_source = record.payment_basis_source;
        }
        normalized.platform_status = record.platform_status;
        return;
      }
      // Preserve the adapter's actual customer-payment audit, not its net-owner
      // display price. These fields are not reconstructed from legacy mappings.
      normalized.customer_payment_verified = true;
      normalized.customer_paid_amount = record.customer_paid_amount;
      for (const field of ['customer_balance_amount','customer_total_online_amount']) {
        if (record[field] === undefined) continue;
        if (typeof record[field] !== 'number' || !Number.isFinite(record[field]) || record[field] < 0) throw issue('Click&Boat 付款审计金额格式无效');
        normalized[field] = record[field];
      }
      if (record.customer_payment_verification_source !== undefined) {
        if (typeof record.customer_payment_verification_source !== 'string' || !record.customer_payment_verification_source.trim() || record.customer_payment_verification_source.length > 500) throw issue('Click&Boat 付款审计来源格式无效');
        normalized.customer_payment_verification_source = record.customer_payment_verification_source;
      }
    } else if (source === 'mmk') {
      // User decision 2026-10-04: a Reservation or Option with a customer is a
      // valid order without payment. The collector sends exactly this basis.
      if (normalized.status !== 'accepted' || record.payment_basis !== 'mmk_client_assigned' ||
          !['RESERVATION','OPTION'].includes(label(record.platform_status))) {
        throw issue('MMK 有效订单必须是有客户的 Reservation 或 Option');
      }
      normalized.payment_basis = 'mmk_client_assigned';
    } else if (source === 'nausys') {
      // User decision 2026-10-09: a Reservation or Option an agency made counts
      // without payment; copies our own users entered are not sent.
      if (normalized.status !== 'accepted' || record.payment_basis !== 'nausys_agency' ||
          !['RESERVATION','OPTION'].includes(label(record.platform_status))) {
        throw issue('NauSYS 有效订单必须是代理下的 Reservation 或 Option');
      }
      normalized.payment_basis = 'nausys_agency';
    } else if (source === 'samboat') {
      const paymentMatches =normalized.status === 'paid' ? label(record.platform_status) === 'PAID' :
        normalized.status === 'deposit_paid' && ['DEPOSIT PAID','VALIDATED / DEPOSIT PAID','DEPOSIT_PAID','DEPOSIT PAID ONLY','VALIDATED/DEPOSIT PAID'].includes(label(record.platform_status));
      if (!paymentMatches) {
        throw issue('SamBoat 有效订单必须有一致的客户已付款或已付定金状态');
      }
    }
    if (typeof record.platform_status === 'string') normalized.platform_status = record.platform_status;
  }
  function normalize(source, record, checkedAt, requireScope) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw issue('订单记录格式无效');
    const input = {...record, verified_at: record.verified_at || checkedAt};
    if (requireScope) {
      // The legacy normalizer throws plain Error for bad record fields. Check
      // deterministic input failures here so the batch records schema_changed
      // and can retire this invalid upload. Do not catch unexpected normalizer
      // or storage exceptions: those must remain retryable and keep the run ID.
      const bookingId = String(input.booking_id || '');
      const status = String(input.status || '').trim().toLowerCase().replace(/[- ]/g, '_');
      const allowed = [['boataround','samboat'].includes(source) ? 'paid' : 'accepted', 'deposit_paid',
        'completed', 'cancelled', 'canceled', 'refused', 'declined', 'pending'];
      if (!/^[0-9]+$/.test(bookingId)) throw issue('缺少有效订单编号');
      if (!allowed.includes(status)) throw issue('订单缺少明确的平台状态');
      if (!orderDates(source,input.start,input.end)) throw issue('全量同步的每笔订单必须包含有效入住与退房日期');
      if (!instant(input.verified_at)) throw issue('订单缺少有效核验时间');
    }
    const normalized = normalizeBooking(source, input);
    // Only the durable authorized projection below may add this metadata.
    delete normalized.manual_adjustment;
    normalized.boataround_slug = resolveBoat(source, record);
    if (orderDates(source,record.start,record.end)) {normalized.start = record.start; normalized.end = record.end;}
    normalized.verified_at = input.verified_at || null;
    if (requireScope && ['accepted','deposit_paid','paid'].includes(normalized.status) && !normalized.url) throw issue('有效订单详情链接未通过校验');
    // Apply the new gate only to complete incoming snapshots. Bootstrap and
    // previously verified stored records remain readable without rewriting them.
    if (requireScope) validatePaymentEvidence(source, record, normalized);
    return normalized;
  }
  function stateFromBootstrap(source) {
    const seen = new Set(), records = [];
    for (const raw of bootstrapMap?.[source] || []) {
      const record = normalize(source, raw, bootstrapMap?.mapping_updated_at, false);
      if (seen.has(record.booking_id)) throw issue('启动映射含重复订单');
      seen.add(record.booking_id); records.push(record);
    }
    return {schema_version: 1, source, mode: 'bootstrap', records, last_success_at: null,
      last_attempt_at: null, last_checked_at: instant(bootstrapMap?.mapping_updated_at),
      last_error: 'awaiting_first_sync', last_run_id: null, last_digest: null, scope: null};
  }
  function validState(value, source) {
    if (!value || value.schema_version !== 1 || value.source !== source || !Array.isArray(value.records)) throw issue('动态订单存储格式无效；未回退覆盖为静态映射', 503);
    return value;
  }
  async function ensureSource(source) {
    const key = ORDER_SYNC_PREFIX + source + '.json';
    const found = await bucket.get(key);
    if (found) return validState(await found.json(), source);
    await bucket.put(key, jsonValue(stateFromBootstrap(source)), {onlyIf: new Headers({'If-None-Match':'*'})});
    const stored = await bucket.get(key);
    if (!stored) throw issue('动态订单初始化失败', 503);
    return validState(await stored.json(), source);
  }
  async function ensureOverrides() {
    const key = ORDER_SYNC_PREFIX + 'manual-overrides.json';
    let file = await bucket.get(key);
    if (!file) {
      await bucket.put(key, jsonValue({schema_version:1, records:[{...ORDER_SYNC_MANUAL_CANCEL, recorded_at: new Date(now()).toISOString()}]}), {onlyIf:new Headers({'If-None-Match':'*'})});
      file = await bucket.get(key);
    }
    const data = file && await file.json();
    if (!data || data.schema_version !== 1 || !Array.isArray(data.records)) throw issue('手工订单覆盖记录不可用',503);
    // This user-confirmed cancellation remains enforced even if an old stored
    // override document lacks it. An incoming snapshot cannot alter overrides.
    return [...data.records.filter(record => !(record.source === 'samboat' && String(record.booking_id) === '1000001')), ORDER_SYNC_MANUAL_CANCEL];
  }
  async function ensureReschedule() {
    const key=ORDER_SYNC_PREFIX+'manual-reschedules.json';
    let file=await bucket.get(key);
    if(!file){
      await bucket.put(key,jsonValue({schema_version:1,records:[{...clone(ORDER_SYNC_MANUAL_RESCHEDULE),recorded_at:new Date(now()).toISOString()}]}),{onlyIf:new Headers({'If-None-Match':'*'})});
      file=await bucket.get(key);
    }
    const data=file&&await file.json(),record=data?.records?.[0];
    if(data?.schema_version!==1||!Array.isArray(data.records)||data.records.length!==1||
      !record||instant(record.recorded_at)!==record.recorded_at||
      Object.entries(ORDER_SYNC_MANUAL_RESCHEDULE).some(([name,value])=>JSON.stringify(record[name])!==JSON.stringify(value)))
      throw issue('人工改期授权记录不可用；未回退或覆盖',503);
    return record;
  }
  function manualObservations(snapshot,checkedAt) {
    if(snapshot.manual_order_observations===undefined)return [];
    if(snapshot.source!=='clickandboat'||snapshot.outcome==='failure'||!Array.isArray(snapshot.manual_order_observations)||snapshot.manual_order_observations.length>1)
      throw issue('人工改期状态观测格式无效');
    const fields=['booking_id','boataround_slug','platform_status','start','end','checked_at','detail_url'];
    return snapshot.manual_order_observations.map(observation=>{
      if(!observation||typeof observation!=='object'||Array.isArray(observation)||
        Object.keys(observation).length!==fields.length||fields.some(field=>!Object.hasOwn(observation,field))||
        observation.booking_id!==ORDER_SYNC_MANUAL_RESCHEDULE.booking_id||
        observation.detail_url!==ORDER_SYNC_MANUAL_RESCHEDULE.url||!fleetSlugs.includes(observation.boataround_slug)||
        !day(observation.start)||!day(observation.end)||observation.end<=observation.start||
        typeof observation.platform_status!=='string'||!observation.platform_status.trim()||observation.platform_status.length>80||/[\x00-\x1f\x7f]/.test(observation.platform_status)||
        instant(observation.checked_at)!==observation.checked_at||Date.parse(observation.checked_at)>now()+60000||
        Date.parse(observation.checked_at)>Date.parse(checkedAt)+60000||Date.parse(observation.checked_at)<Date.parse(checkedAt)-10*60000)
        throw issue('人工改期状态观测的订单、链接、船只、日期或时间无效');
      return clone(observation);
    });
  }
  function updateRescheduleObservation(state,event) {
    if(event.source!=='clickandboat')return;
    const previous=state.manual_adjustment_state||{
      verification_status:'awaiting_observation',review_reason:null,last_verified_at:null,
      platform_status:null,platform_start:null,platform_end:null,platform_boat:null,cancelled_at:null
    };
    const observation=event.manual_order_observations?.[0];
    const currentRecord=event.records?.find(record=>record.booking_id===ORDER_SYNC_MANUAL_RESCHEDULE.booking_id);
    const cancelledRecord=currentRecord&&['cancelled','canceled'].includes(currentRecord.status);
    if(observation){
      const label=observation.platform_status.trim().replace(/\s+/g,' ').toUpperCase();
      if(previous.last_verified_at&&observation.checked_at<previous.last_verified_at){
        previous.verification_status=previous.cancelled_at?'cancelled':'needs_review';
        previous.review_reason='observation_missing';
      }else{
        Object.assign(previous,{last_verified_at:observation.checked_at,platform_status:observation.platform_status,
          platform_start:observation.start,platform_end:observation.end,platform_boat:observation.boataround_slug});
        if(['CANCELLED','CANCELED'].includes(label))previous.cancelled_at ||= observation.checked_at;
        const original=observation.start===ORDER_SYNC_MANUAL_RESCHEDULE.original_start&&observation.end===ORDER_SYNC_MANUAL_RESCHEDULE.original_end;
        const adjusted=observation.start===ORDER_SYNC_MANUAL_RESCHEDULE.start&&observation.end===ORDER_SYNC_MANUAL_RESCHEDULE.end;
        previous.review_reason=observation.boataround_slug!==ORDER_SYNC_MANUAL_RESCHEDULE.boataround_slug?'platform_boat_changed':
          !original&&!adjusted?'platform_dates_changed':label!=='ACCEPTED'?'platform_status_changed':null;
        previous.verification_status=previous.cancelled_at?'cancelled':previous.review_reason?'needs_review':'verified';
      }
    }else{
      previous.verification_status=previous.cancelled_at?'cancelled':'needs_review';
      previous.review_reason=event.outcome==='failure'?'source_sync_failed':'observation_missing';
    }
    // A complete ordinary record that explicitly cancels this same identity is
    // also authoritative. Missing extra observations can never undo a cancel.
    if(cancelledRecord)previous.cancelled_at ||= event.checked_at;
    if(previous.cancelled_at){previous.verification_status='cancelled';previous.review_reason=null;}
    state.manual_adjustment_state=previous;
  }
  function projectReschedule(authorization,state) {
    const observed=state.manual_adjustment_state||{
      verification_status:'awaiting_observation',review_reason:null,last_verified_at:null,
      platform_status:null,platform_start:null,platform_end:null,platform_boat:null,cancelled_at:null
    };
    return {
      source:authorization.source,booking_id:authorization.booking_id,boataround_slug:authorization.boataround_slug,
      start:authorization.start,end:authorization.end,status:observed.cancelled_at?'cancelled':'accepted',
      url:authorization.url,amount:authorization.amount,amount_basis:authorization.amount_basis,
      verified_at:observed.last_verified_at||authorization.recorded_at,
      manual_adjustment:{kind:'reschedule',original_start:authorization.original_start,original_end:authorization.original_end,
        recorded_at:authorization.recorded_at,...clone(observed),payment_evidence:clone(authorization.payment_evidence)}
    };
  }
  async function mutate(source, change) {
    await ensureSource(source);
    const key = ORDER_SYNC_PREFIX + source + '.json';
    for (let attempt = 0; attempt < 5; attempt++) {
      const file = await bucket.get(key);
      if (!file) throw issue('动态订单存储暂不可用',503);
      const current = validState(await file.json(),source);
      const result = change(clone(current));
      if (!result.write) return result.result;
      const saved = await bucket.put(key,jsonValue(result.state),{onlyIf:{etagMatches:file.etag}});
      if (saved !== null) return result.result;
    }
    throw issue('订单同步并发更新，请重试',409);
  }
  function validateEnvelope(snapshot) {
    if (!snapshot || !ORDER_SYNC_SOURCES.includes(snapshot.source)) throw issue('同步平台无效');
    if (typeof snapshot.run_id !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(snapshot.run_id)) throw issue('缺少有效同步运行编号');
    const checkedAt = instant(snapshot.checked_at);
    if (!checkedAt || Date.parse(checkedAt) > now() + 60000) throw issue('核验时间无效或晚于当前时间');
    if (snapshot.outcome === 'failure') {
      if (!ORDER_SYNC_ERRORS.includes(snapshot.error_code)) throw issue('同步失败类型无效');
      manualObservations(snapshot,checkedAt);
      return {source:snapshot.source,run_id:snapshot.run_id,checked_at:checkedAt,outcome:'failure',error_code:snapshot.error_code};
    }
    if (snapshot.outcome && snapshot.outcome !== 'success') throw issue('同步结果类型无效');
    const scope = snapshot.scope, pagination = snapshot.pagination;
    if (snapshot.complete !== true || scope?.kind !== 'current_future' || !day(scope.from_day) || scope.from_day > beijingDay(now())) throw issue('只能接收完整的当前及未来订单快照');
    if (!Array.isArray(scope.fleet_slugs) || JSON.stringify([...scope.fleet_slugs].sort()) !== JSON.stringify(fleetSlugs)) throw issue('全量快照必须覆盖全部七艘船');
    if (!pagination || pagination.complete !== true || !Number.isInteger(pagination.total_pages) || pagination.total_pages < 1 || pagination.total_pages > 1000 || !Array.isArray(pagination.pages_read) || JSON.stringify([...pagination.pages_read].sort((a,b)=>a-b)) !== JSON.stringify(Array.from({length:pagination.total_pages},(_,i)=>i+1))) throw issue('列表分页尚未完整读取');
    if (!Array.isArray(snapshot.orders) || snapshot.orders.length > 3000 || !Number.isInteger(snapshot.expected_count) || snapshot.expected_count !== snapshot.orders.length) throw issue('订单条数与完整性证据不一致');
    if (!Number.isInteger(pagination.listed_count) || pagination.listed_count < snapshot.orders.length) throw issue('缺少列表总条数证据');
    const seen = new Set();
    const records = snapshot.orders.map(raw => {
      const record = normalize(snapshot.source,raw,checkedAt,true);
      if (seen.has(record.booking_id)) throw issue('同平台快照含重复订单');
      if (record.end < scope.from_day) throw issue('同步记录超出声明的当前未来日期范围');
      seen.add(record.booking_id); return record;
    });
    records.sort((a,b)=>a.booking_id.localeCompare(b.booking_id));
    const observations=manualObservations(snapshot,checkedAt);
    return {source:snapshot.source,run_id:snapshot.run_id,checked_at:checkedAt,outcome:'success',scope:clone(scope),pagination:clone(pagination),records,
      ...(snapshot.manual_order_observations===undefined?{}:{manual_order_observations:observations})};
  }
  async function ingestSnapshot(snapshot) {
    const event = validateEnvelope(snapshot), digest = await fingerprint(event);
    await ensureOverrides();
    await ensureReschedule();
    return mutate(event.source, state => {
      if (state.last_run_id === event.run_id) {
        if (state.last_digest !== digest) throw issue('同一运行编号不能提交不同快照',409);
        return {write:false,result:{source:event.source,accepted:true,idempotent:true,received_at:state.last_attempt_at}};
      }
      if (state.last_checked_at && event.checked_at <= state.last_checked_at) return {write:false,result:{source:event.source,accepted:false,ignored:'older_snapshot'}};
      const receivedAt = new Date(now()).toISOString();
      updateRescheduleObservation(state,event);
      if (event.outcome === 'failure') {
        Object.assign(state,{last_attempt_at:receivedAt,last_checked_at:event.checked_at,last_run_id:event.run_id,last_digest:digest,last_error:event.error_code});
      } else {
        const incomingIds = new Set(event.records.map(record=>record.booking_id));
        // Identity takes precedence over its previous boat or dates. A moved
        // or rescheduled order is replaced once across the entire platform.
        // Checkout remains protected today. Only earlier checkout dates may
        // bypass this full snapshot as history; otherwise a cancellation or
        // disappearance on checkout day would retain a stale paid order.
        const historical = state.records.filter(record => record.end && record.end < event.scope.from_day && !incomingIds.has(record.booking_id));
        Object.assign(state,{mode:'dynamic',records:[...historical,...event.records],last_success_at:event.checked_at,last_attempt_at:receivedAt,
          last_checked_at:event.checked_at,last_run_id:event.run_id,last_digest:digest,last_error:null,scope:event.scope,pagination:event.pagination});
      }
      return {write:true,state,result:{source:event.source,accepted:true,outcome:event.outcome,last_success_at:state.last_success_at,received_at:receivedAt}};
    });
  }
  async function ingestBatch(payload) {
    if (!payload || payload.schema_version !== 1 || !Array.isArray(payload.snapshots) || payload.snapshots.length < 1 || payload.snapshots.length > ORDER_SYNC_SOURCES.length || payload.manual_overrides !== undefined||payload.manual_reschedules!==undefined||payload.manual_adjustments!==undefined) throw issue('订单同步请求格式无效');
    const sources = payload.snapshots.map(snapshot=>snapshot?.source);
    if (new Set(sources).size !== sources.length || sources.some(source=>!ORDER_SYNC_SOURCES.includes(source))) throw issue('同步平台重复或无效');
    jsonValue(payload);
    const results = [];
    for (const snapshot of payload.snapshots) {
      try {results.push(await ingestSnapshot(snapshot));}
      catch (error) {
        let failureReceipt;
        // A malformed/incomplete collection is a failed attempt, never a
        // successful empty snapshot. Persist only its failure metadata.
        if (error.status === 422) {
          const failureCode=/分页/.test(error.message)?'incomplete_pages':'schema_changed';
          try {
            const saved=await ingestSnapshot({source:snapshot.source,run_id:snapshot.run_id,checked_at:snapshot.checked_at,outcome:'failure',error_code:failureCode});
            // The phone retires permanent rejections instead of uploading this
            // invalid financial snapshot again. Preserve proof of the actual
            // failure commit so its manual request can finish as a failure.
            // An old/invalid event or a failed commit provides no such proof.
            if(saved.accepted===true)failureReceipt={...saved,run_id:snapshot.run_id,checked_at:instant(snapshot.checked_at),
              outcome:'failure',error_code:failureCode};
          } catch { /* Do not conceal the original validation error. */ }
        }
        // An unclassified storage/runtime exception may happen after a commit.
        // Keep it retryable; never consume this valid run ID as a schema failure.
        results.push({source:snapshot.source,accepted:false,error:error.status?error.message:'订单存储暂不可用，请重试',status:error.status||503,
          ...(failureReceipt?{failure_receipt:failureReceipt}:{})});
      }
    }
    return {schema_version:1,results,order_sync:await status()};
  }
  async function registry() {
    const states = await Promise.all(ORDER_SYNC_SOURCES.map(ensureSource));
    const mapping = {schema_version:2};
    for (const state of states) mapping[state.source] = clone(state.records);
    const authorization=await ensureReschedule(),manualSource=states.find(state=>state.source===authorization.source);
    mapping[authorization.source]=mapping[authorization.source].filter(record=>String(record.booking_id)!==authorization.booking_id);
    mapping[authorization.source].push(projectReschedule(authorization,manualSource));
    for (const override of await ensureOverrides()) {
      if (!ORDER_SYNC_SOURCES.includes(override.source) || override.status !== 'cancelled') continue;
      mapping[override.source] = mapping[override.source].filter(record=>String(record.booking_id)!==String(override.booking_id));
      mapping[override.source].push({source:override.source,booking_id:String(override.booking_id),status:'cancelled',boataround_slug:override.boataround_slug});
    }
    const successes = states.map(state=>state.last_success_at).filter(Boolean).sort();
    mapping.mapping_updated_at = successes[successes.length-1] || bootstrapMap?.mapping_updated_at || null;
    return mapping;
  }
  async function status() {
    const states = await Promise.all(ORDER_SYNC_SOURCES.map(ensureSource));
    const platforms = Object.fromEntries(states.map(state=>[state.source,{mode:state.mode,last_success_at:state.last_success_at,last_attempt_at:state.last_attempt_at,last_checked_at:state.last_checked_at,
      age_ms:state.last_success_at?Math.max(0,now()-Date.parse(state.last_success_at)):null,
      last_error:state.last_error,scope:state.scope,pagination:state.pagination||null,record_count:state.records.length}]));
    const successes = states.map(state=>state.last_success_at).filter(Boolean).sort();
    return {schema_version:1,automatic_enabled:false,platforms,last_all_platforms_success_at:successes.length===ORDER_SYNC_SOURCES.length?successes[0]:null,
      latest_platform_success_at:successes[successes.length-1]||null,manual_overrides:['samboat:1000001']};
  }
  return {ingestSnapshot, ingestBatch, registry, status};
}

module.exports = {createOrderRegistry,ORDER_SYNC_SOURCES,ORDER_SYNC_PREFIX,ORDER_SYNC_MAX_BYTES};
