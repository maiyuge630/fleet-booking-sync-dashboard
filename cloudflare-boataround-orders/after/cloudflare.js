var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/cloudflare.js
import { DurableObject } from "cloudflare:workers";

// dist/server/index.js
var HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="description" content="Tidewyn Charters 七艘船的三平台船期查询与十五个月占用日历。">
<title>Tidewyn Charters 船队订单看板</title>
<style>
:root{color-scheme:light dark;--bg:#f1f5f7;--card:#fff;--text:#203541;--muted:#526773;--line:#bdcdd6;--control:#6e8593;--soft:#eaf1f4;--accent:#176674;--accent-text:#fff;--booked:#f9e6e6;--booked-text:#922f39;--unavail:#f8efd9;--unavail-text:#796000;--gap:#e5edf3;--gap-text:#405b72;--free:#eaf4ef;--free-text:#245e45;font-family:"Segoe UI",system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-size:1rem;line-height:1.6;padding:28px 24px 48px}button,input,select{font:inherit}button,select{cursor:pointer}button,input,select,summary{touch-action:manipulation}button{min-height:48px;border:1px solid transparent;border-radius:10px;padding:10px 18px;font-size:.875rem;font-weight:650;background:var(--accent);color:var(--accent-text)}button:hover:not(:disabled){filter:brightness(.94)}button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.secondary{background:var(--card);color:var(--text);border-color:var(--control)}.shell{max-width:1120px;margin:auto;min-width:0}.page-header{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:22px}.brand{font-size:.75rem;letter-spacing:.14em;font-weight:750;color:var(--accent);margin:0 0 5px}h1{font-size:clamp(1.45rem,4vw,1.8rem);letter-spacing:-.025em;line-height:1.35;margin:0}h2{font-size:1.0625rem;line-height:1.4;margin:0}.logout-form{margin:0;flex:none}.logout{padding-inline:14px}.query-card{border:1px solid var(--line);border-radius:16px;background:var(--card);padding:24px;margin-bottom:24px}.section-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}.section-heading p{font-size:.875rem;color:var(--muted);margin:0}.query-form{display:grid;grid-template-columns:1fr 1fr auto auto;gap:14px;align-items:end}.field{min-width:0}.field label{display:block;font-weight:650;font-size:.875rem;margin-bottom:7px}.field input{display:block;width:100%;min-width:0;max-width:100%;min-height:48px;background:var(--bg);color:var(--text);border:1px solid var(--control);border-radius:10px;padding:10px 12px;-webkit-appearance:none;appearance:none}.field input::-webkit-date-and-time-value{text-align:left}.query-note{color:var(--muted);font-size:.875rem;margin:14px 0 0}.meta{display:flex;align-items:flex-start;gap:8px;border-top:1px solid var(--line);margin-top:18px;padding-top:14px;color:var(--muted);font-size:.875rem;overflow-wrap:anywhere}.meta::before{content:'';width:7px;height:7px;flex:none;border-radius:50%;background:var(--accent);margin-top:8px}.result{margin:0 0 28px}.result-heading{margin:0 0 12px;font-size:.875rem;color:var(--muted)}.result-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.result-card{border:1px solid var(--line);background:var(--card);border-radius:12px;padding:16px;min-width:0}.result-name{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;font-size:.9375rem;font-weight:650;margin:0 0 8px}.result-name strong{overflow-wrap:anywhere}.result-card p{font-size:.875rem;color:var(--muted);margin:7px 0 0}.result-card .conflict{color:var(--booked-text)}.result-card .pending{color:var(--unavail-text)}.query-warning{padding:14px 16px;background:var(--unavail);color:var(--unavail-text);border-radius:10px;font-size:.875rem}.badge{display:inline-flex;align-items:center;border-radius:6px;padding:3px 8px;font-size:.875rem;white-space:nowrap;font-weight:650;background:var(--soft);color:var(--muted)}.badge.free{background:var(--free);color:var(--free-text)}.badge.busy{background:var(--booked);color:var(--booked-text)}.badge.pending{background:var(--unavail);color:var(--unavail-text)}.occLine{font-size:.875rem;margin:8px 0;padding-top:8px;border-top:1px solid var(--line);overflow-wrap:anywhere}.occLine strong{display:block;color:var(--text);font-weight:600}.freeFrom{display:block;color:var(--muted);font-size:.875rem;margin-top:3px}.calendar-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:0 0 16px}.calendar-title p{margin:4px 0 0;font-size:.875rem;color:var(--muted)}.month-navigation{display:flex;gap:8px;align-items:center;flex:none}.month-navigation button{width:48px;padding:0;font-size:1.5rem;line-height:1}.month-navigation select{background:var(--card);color:var(--text);border:1px solid var(--control);border-radius:10px;min-height:48px;max-width:100%;padding:8px 32px 8px 12px;font-size:.875rem}.legend{display:flex;flex-wrap:wrap;gap:8px 18px;margin:0 0 20px;color:var(--muted);font-size:.875rem}.legend span{display:inline-flex;align-items:center;gap:7px}.sw{display:inline-block;width:15px;height:15px;border-radius:4px;border:1px solid currentColor}.sw.booked{background:var(--booked);color:var(--booked-text)}.sw.unavailable{background:var(--unavail);color:var(--unavail-text)}.sw.gap{background:var(--gap);color:var(--gap-text)}.sw.available{background:var(--soft);color:var(--muted)}.boats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;align-items:start}.boatSection{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;min-width:0}.boat-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}.boat-number{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:10px;color:var(--accent);background:var(--soft);font-size:.875rem;font-weight:650}.boat-head h3{margin:0;font-size:1.0625rem;line-height:1.4;overflow-wrap:anywhere}.boat-model{color:var(--muted);font-size:.875rem;margin:3px 0 0}.source-tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.source-tag{font-size:.875rem;line-height:1.6;background:var(--soft);color:var(--muted);border-radius:6px;padding:3px 7px}.source-tag.stale{background:var(--unavail);color:var(--unavail-text)}.cal{width:100%;border-collapse:separate;border-spacing:4px;table-layout:fixed}.cal th{font-size:.875rem;color:var(--muted);font-weight:500;padding:4px 0}.cal td{height:52px;text-align:center;border-radius:7px;font-size:1rem;vertical-align:middle;line-height:1.25}.cal td.d{background:var(--soft);color:var(--text)}.cal td.b{background:var(--booked);color:var(--booked-text)}.cal td.u{background:var(--unavail);color:var(--unavail-text)}.cal td.g{background:var(--gap);color:var(--gap-text)}.cal td.today{outline:2px solid var(--accent);outline-offset:-2px;font-weight:750}.day-status{display:block;font-size:.875rem;margin-top:2px;font-weight:550}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.records,.source-notes{border-top:1px solid var(--line);margin-top:14px}.records summary,.source-notes summary{cursor:pointer;min-height:48px;padding:12px 2px;font-size:.875rem;color:var(--muted)}.records summary{font-weight:650;color:var(--text)}.source-notes summary{color:var(--unavail-text)}.source-notes p{font-size:.875rem;margin:0 0 8px;color:var(--muted);overflow-wrap:anywhere}.records-table{width:100%;border-collapse:collapse;font-size:.875rem}.records-table th{text-align:left;color:var(--muted);font-weight:500;font-size:.875rem;padding:8px 0;border-bottom:1px solid var(--line)}.records-table td{padding:12px 0;border-bottom:1px solid var(--line);vertical-align:top}.records-table td:first-child{padding-right:10px}.record-platform{display:block;color:var(--text);font-size:.875rem}.record-type{font-size:.875rem;color:var(--muted)}.record-date{font-variant-numeric:tabular-nums;white-space:nowrap}.record-date span{display:block}.records-empty{font-size:.875rem;color:var(--muted);margin:0 0 12px}.loading{grid-column:1/-1;padding:32px;text-align:center;font-size:1rem;color:var(--muted);border:1px solid var(--line);border-radius:16px;background:var(--card)}[hidden]{display:none!important}
@media(max-width:760px){body{padding:20px 16px 32px}.query-form{grid-template-columns:repeat(auto-fit,minmax(min(100%,8.5rem),1fr))}.query-form button{width:100%}.query-card{padding:20px}.boats{grid-template-columns:1fr;gap:16px}.result-grid{grid-template-columns:1fr}.calendar-heading{align-items:flex-start;flex-direction:column;gap:14px}.month-navigation{width:100%}.month-navigation select{flex:1;min-width:0}.boatSection{padding:18px}.cal td{height:52px}.section-heading{display:block}.section-heading p{margin-top:4px}.page-header{gap:12px;margin-bottom:20px}.logout{padding:10px 12px}.legend{gap:8px 14px}.brand{font-size:.75rem}}
@media(max-width:360px){body{padding-inline:12px}.query-card,.boatSection{padding:16px}.query-form{gap:12px 8px}.field input{padding:10px 8px}.cal{border-spacing:3px}.cal td{height:48px}.cal th{font-size:.875rem}.legend{font-size:.875rem;gap:8px 12px}}
@media(prefers-color-scheme:dark){:root{--bg:#142129;--card:#1b2d38;--text:#e1ebf0;--muted:#b3c4ce;--line:#586e7b;--control:#91aab8;--soft:#263c49;--accent:#9cd3db;--accent-text:#102e35;--booked:#493724;--booked-text:#ffdce1;--unavail:#3e3525;--unavail-text:#f5dba6;--gap:#263b4c;--gap-text:#dae7f3;--free:#253f36;--free-text:#b9ead4}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}

/* Calendar cards share a compact height; booking detail has its own full-width section. */
html{scroll-padding-top:24px}.shell a,.shell a:visited{color:var(--accent)}.shell a:focus-visible{outline:3px solid var(--accent);outline-offset:3px;border-radius:4px}.query-card{padding-bottom:16px}.meta{font-variant-numeric:tabular-nums;margin-top:16px;padding-top:12px}.data-notes{font-size:.8125rem;color:var(--muted);margin-top:2px}.data-notes summary{display:list-item;cursor:pointer;padding:8px 0;min-height:36px;width:fit-content}.data-notes p{margin:4px 0 8px;max-width:78ch;line-height:1.7}.data-notes p:empty{display:none}.boats{align-items:stretch}.boatSection{display:flex;flex-direction:column;padding:20px}.boat-head{align-items:center;min-height:52px;margin-bottom:12px;gap:10px}.boat-heading-copy{min-width:0;flex:1}.boat-head h3{font-size:1rem;line-height:1.4}.boat-model{font-size:.8125rem;line-height:1.4;margin-top:4px}.boat-number{width:32px;height:32px;border-radius:8px;font-size:.8125rem}.source-tags{gap:6px;margin-bottom:12px;min-height:28px}.source-tag{padding:3px 8px;background:transparent;border:1px solid var(--line);font-size:.75rem;line-height:1.5;border-radius:5px}.source-tag a,.source-tag a:visited{text-decoration:none;color:var(--muted)}.source-tag a:hover{color:var(--accent);text-decoration:underline;text-underline-offset:3px}.cal{margin:0}.cal td a,.cal td a:visited{color:inherit;text-decoration:none;font-weight:650;display:inline-flex;justify-content:center;align-items:center;min-width:30px;min-height:25px;border-radius:4px}.cal td a:hover{text-decoration:underline;text-underline-offset:3px}.day-status{font-size:.6875rem;margin-top:1px;line-height:1.2}.boat-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:46px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line);font-size:.8125rem;color:var(--muted)}.boat-orders-link{font-weight:600;text-decoration:none;white-space:nowrap}.boat-orders-link:hover{text-decoration:underline;text-underline-offset:3px}.boat-orders-empty{font-variant-numeric:tabular-nums;white-space:nowrap}.result-grid{align-items:start;gap:14px}.result-card{padding:18px}.result-name{align-items:center;gap:12px;min-height:30px}.result-name strong{font-size:.875rem;line-height:1.5}.result-card .badge{flex:none}.result-card .occLine{padding-top:10px;margin-top:10px;line-height:1.7}.occLine strong{margin:4px 0}.occLine strong a{text-decoration:none;display:inline-flex;flex-wrap:wrap;column-gap:8px}.occLine strong a:hover{text-decoration:underline;text-underline-offset:3px}.occLine strong a span{white-space:nowrap}.freeFrom{font-size:.8125rem}.orders-section{margin-top:32px;scroll-margin-top:24px}.orders-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:16px}.orders-heading p{margin:4px 0 0;color:var(--muted);font-size:.875rem}.orders-count{display:inline-flex;align-items:center;justify-content:center;flex:none;font-variant-numeric:tabular-nums;font-size:.8125rem;font-weight:650;color:var(--accent);background:var(--soft);border:1px solid var(--line);border-radius:999px;min-width:56px;padding:5px 12px}.orders-panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:4px 20px;min-width:0}.orders-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:.875rem}.orders-table th{font-size:.75rem;font-weight:500;color:var(--muted);text-align:left;padding:16px 12px 12px;border-bottom:1px solid var(--line)}.orders-table th:nth-child(1){width:23%}.orders-table th:nth-child(2){width:20%}.orders-table th:nth-child(3){width:22%}.orders-table th:nth-child(4){width:23%}.orders-table th:nth-child(5){width:12%}.orders-table td{padding:18px 12px;border-bottom:1px solid var(--line);vertical-align:middle;overflow-wrap:anywhere}.orders-table th:first-child,.orders-table td:first-child{padding-left:0}.orders-table th:last-child,.orders-table td:last-child{padding-right:0}.orders-table tr:last-child td{border-bottom:0}.orders-table tr{scroll-margin-top:24px}.orders-table tr:target{background:var(--soft)}.order-primary{display:block;font-size:.875rem;line-height:1.5;font-weight:600;color:var(--text)}.order-secondary{display:block;font-size:.75rem;line-height:1.6;color:var(--muted);margin-top:4px}.order-platform .order-secondary{font-variant-numeric:tabular-nums}.order-dates{font-variant-numeric:tabular-nums}.order-dates .order-primary,.order-dates .order-secondary{white-space:nowrap}.order-money .order-primary{font-size:.9375rem;font-variant-numeric:tabular-nums;white-space:nowrap}.order-action{text-align:right}.order-detail-link,.order-detail-link:visited{display:inline-flex;align-items:center;justify-content:center;min-height:38px;white-space:nowrap;padding:7px 10px;border:1px solid var(--line);border-radius:7px;text-decoration:none;font-weight:600;font-size:.8125rem;color:var(--accent);background:var(--card)}.order-detail-link:hover{background:var(--soft);border-color:var(--accent)}.order-link-issue{display:block;font-size:.75rem;color:var(--muted);line-height:1.5;text-align:left}.orders-empty{padding:24px 0;margin:0;color:var(--muted);font-size:.875rem}.orders-table caption{caption-side:bottom;text-align:left;padding:12px 0 16px;color:var(--muted);font-size:.75rem}
@media(max-width:900px) and (min-width:761px){.orders-panel{padding-inline:16px}.orders-table td,.orders-table th{padding-inline:8px}.orders-table th:nth-child(1){width:23%}.orders-table th:nth-child(2){width:19%}.orders-table th:nth-child(3){width:24%}.orders-table th:nth-child(4){width:22%}.orders-table th:nth-child(5){width:12%}.order-primary{font-size:.8125rem}.order-detail-link{font-size:.75rem;padding-inline:6px}}
@media(max-width:760px){.boatSection{padding:18px}.boat-head{min-height:48px}.boat-foot{font-size:.8125rem}.meta{font-size:.8125rem;line-height:1.7}.orders-section{margin-top:28px}.orders-heading{align-items:flex-start}.orders-heading p{font-size:.8125rem}.orders-panel{background:transparent;border:0;padding:0}.orders-table,.orders-table tbody{display:block;width:100%}.orders-table thead{display:none}.orders-table tbody{display:grid;gap:12px}.orders-table tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px 18px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}.orders-table td,.orders-table td:first-child,.orders-table td:last-child{display:block;min-width:0;border:0;padding:0}.orders-table td[data-label]::before{content:attr(data-label);display:block;font-size:.6875rem;color:var(--muted);line-height:1.5;margin-bottom:5px}.orders-table td.order-boat{grid-column:1/-1;padding-bottom:12px;border-bottom:1px solid var(--line)}.orders-table td.order-boat::before{display:none}.order-boat .order-primary{font-size:.9375rem}.order-boat .order-secondary{margin-top:2px}.order-action{align-self:end;justify-self:stretch;text-align:right}.order-detail-link{min-height:42px;padding-inline:16px}.orders-table caption{display:block;padding-top:14px}.order-money .order-primary{font-size:1rem}.order-secondary{font-size:.75rem}.result-card{padding:16px}}
@media(max-width:360px){.boatSection{padding:15px}.boat-head h3{font-size:.9375rem}.boat-foot{gap:6px;font-size:.75rem}.orders-table tr{padding:16px;gap:14px 12px}.order-dates .order-primary{font-size:.8125rem}.order-dates .order-secondary{font-size:.6875rem}.order-detail-link{padding-inline:10px}}
/* Query results use one full-width row per boat so different detail heights do not leave grid holes. */
.result-grid{grid-template-columns:minmax(0,1fr);align-items:stretch;gap:12px}.result-card{display:grid;grid-template-columns:minmax(230px,.85fr) minmax(0,1.65fr);column-gap:24px;align-items:start;padding:18px 20px}.result-card>.result-name{grid-column:1;grid-row:1;margin:0;min-height:30px;align-items:center}.result-card>:not(.result-name){grid-column:2;min-width:0;margin-bottom:0}.result-card>p{margin-top:3px}.result-card .occLine{margin-bottom:0}.result-name strong{min-width:0}
@media(max-width:760px){.result-card{grid-template-columns:minmax(0,1fr);padding:16px}.result-card>.result-name{grid-column:1;grid-row:auto;margin-bottom:8px}.result-card>:not(.result-name){grid-column:1}.result-card>p{margin-top:0}}

.meta{overflow-wrap:normal;word-break:keep-all}

/* Each boat keeps its own native, initially collapsed order details. */
.boats{align-items:start}.boat-bookings{border-top:1px solid var(--line);margin-top:12px}.boat-bookings>summary{cursor:pointer;min-height:48px;padding:14px 0;font-size:.875rem;font-weight:600;line-height:1.5;color:var(--text)}.boat-bookings-count{font-weight:400;color:var(--muted)}.boat-booking-list{margin:0;padding:0}.boat-booking{padding:16px 0;border-top:1px solid var(--line);min-width:0}.boat-booking:last-child{padding-bottom:2px}.boat-booking-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.boat-booking-platform{font-size:.8125rem;font-weight:600;line-height:1.5;overflow-wrap:anywhere}.boat-booking-status{font-size:.75rem;color:var(--muted);white-space:nowrap;flex:none}.boat-booking-dates{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:center;padding:12px 14px;background:var(--soft);border-radius:8px;font-variant-numeric:tabular-nums}.boat-booking-dates small{display:block;font-size:.6875rem;color:var(--muted);line-height:1.5;margin-bottom:3px}.boat-booking-dates strong{display:block;font-size:.875rem;font-weight:600;line-height:1.5;white-space:nowrap}.boat-date-arrow{color:var(--muted);font-size:.875rem}.boat-booking-dates>span:last-child{text-align:right}.boat-booking-bottom{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-top:14px}.boat-booking-money{min-width:0}.boat-booking-money strong{display:block;font-size:.9375rem;font-weight:650;line-height:1.5;font-variant-numeric:tabular-nums;white-space:nowrap}.boat-booking-money small{display:block;font-size:.6875rem;color:var(--muted);line-height:1.6;margin-top:2px;overflow-wrap:anywhere}.boat-booking-bottom .order-detail-link{flex:none;min-height:38px;font-size:.75rem;padding:7px 10px}.boat-booking-bottom .order-link-issue{max-width:45%;text-align:right}.boat-bookings-empty{font-size:.8125rem;line-height:1.6;color:var(--muted);margin:0;padding:4px 0 12px}
@media(max-width:360px){.boat-booking-dates{padding:10px;gap:7px}.boat-booking-dates strong{font-size:.8125rem}.boat-booking-bottom{gap:10px}.boat-booking-bottom .order-detail-link{padding-inline:8px}}
</style>
</head>
<body>
<main class="shell">
<header class="page-header"><div><p class="brand">TIDEWYN CHARTERS</p><h1>船队订单看板</h1></div><form class="logout-form" method="post" action="/auth/logout"><button class="secondary logout" type="submit">退出登录</button></form></header>
<section class="query-card" aria-labelledby="query-title">
<div class="section-heading"><h2 id="query-title">查找可用船只</h2><p>Boataround · Click&amp;Boat · SamBoat</p></div>
<form class="query-form" id="queryForm"><div class="field"><label for="d1">入住日期</label><input type="date" id="d1" required></div><div class="field"><label for="d2">退房日期</label><input type="date" id="d2" required></div><button id="queryBtn" type="submit" disabled>查询档期</button><button id="refreshBtn" class="secondary" type="button">刷新数据</button></form>
<p class="query-note">按入住日至退房前一晚查询，最终以平台确认为准。</p><div id="meta" class="meta" role="status" aria-live="polite">正在读取船期…</div><details class="data-notes"><summary>数据说明</summary><p>仅有效订单影响可用状态，按入住日至退房前一晚计算。刷新仅更新公开船期；新增、改期和取消需更新订单映射。</p><p>三平台订单快照更新时间：<span id="bookingVerifiedAt">未记录</span>。订单状态来自已登录平台核验的记录。</p><p id="dataIssues"></p></details>
</section>
<section id="result" class="result" aria-live="polite" aria-label="档期查询结果" hidden></section>
<section aria-labelledby="calendar-title"><div class="calendar-heading"><div class="calendar-title"><h2 id="calendar-title">船队日历</h2><p>7艘船 · 可查看未来15个月</p></div><div class="month-navigation"><button id="prevMonth" class="secondary" type="button" aria-label="上一个月">‹</button><label class="sr-only" for="monthSelect">查看月份</label><select id="monthSelect"></select><button id="nextMonth" class="secondary" type="button" aria-label="下一个月">›</button></div></div>
<div class="legend" aria-label="日历图例"><span><i class="sw booked" aria-hidden="true"></i>不可用</span><span><i class="sw available" aria-hidden="true"></i>可用</span></div>
<div class="boats" id="boats"><div id="loading" class="loading">正在加载三平台船期…</div></div></section>

</main>
<script>
let DATA=null,hasQuery=false,monthIndex=0;
const WD=['一','二','三','四','五','六','日'];
const baseMonth=new Date();baseMonth.setDate(1);baseMonth.setHours(0,0,0,0);
const months=Array.from({length:15},(_,i)=>new Date(baseMonth.getFullYear(),baseMonth.getMonth()+i,1));
function fmt(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function srcLabel(src){return src==='boataround'?'Boataround':src==='clickandboat'?'Click&Boat':'SamBoat';}
function dayAfter(day){const date=new Date(day+'T00:00:00');date.setDate(date.getDate()+1);return fmt(date);}
function shiftDay(day,offset){const date=new Date(day+'T12:00:00');date.setDate(date.getDate()+offset);return fmt(date);}
function validDate(day){return /^\\d{4}-\\d{2}-\\d{2}$/.test(day||'')&&fmt(new Date(day+'T12:00:00'))===day;}
function confirmed(booking){return !!booking&&['accepted','deposit_paid','paid'].includes(booking.status)&&validDate(booking.start)&&validDate(booking.end)&&booking.start<booking.end;}
function activeBookings(boat){return (Array.isArray(boat.bookings)?boat.bookings:[]).filter(confirmed);}
function knownOrders(boat){const today=fmt(new Date());return activeBookings(boat).filter(b=>b.end>today);}
function orderURL(booking){
 try{const u=new URL(booking.url);
  if(booking.source==='boataround')return typeof booking.detail_id==='string'&&/^[a-f0-9]{24}$/.test(booking.detail_id)&&/^\\d+$/.test(String(booking.booking_id))&&booking.url==='https://partner.boataround.com/en/000000000000000000000000/orders/'+booking.detail_id&&u.protocol==='https:'&&u.hostname==='partner.boataround.com'&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/en/000000000000000000000000/orders/'+booking.detail_id?u.href:null;
  const pattern=booking.source==='clickandboat'?/^\\/uk\\/booking\\/(\\d+)\\/detail$/:booking.source==='samboat'?/^\\/private\\/reservation\\/(\\d+)$/:null,match=pattern&&u.pathname.match(pattern),host=booking.source==='clickandboat'?'www.clickandboat.com':'www.samboat.com';
  return u.protocol==='https:'&&u.hostname===host&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&match&&match[1]===String(booking.booking_id)?u.href:null;
 }catch{return null;}
}
function sourceURL(boat,source){if(source==='clickandboat'&&Number.isInteger(boat.clickandboat_id)&&boat.clickandboat_id>0)return 'https://www.clickandboat.com/uk/account/listing/edit/'+boat.clickandboat_id+':7';if(source==='samboat'&&Number.isInteger(boat.samboat_id)&&boat.samboat_id>0)return 'https://www.samboat.com/private/announcement/'+boat.samboat_id+'/calendar';return null;}
function orderStatus(b){return b.status==='paid'?'已付款':b.status==='deposit_paid'?'已付定金':'已接受';}
function linkedRange(b){const text='<span>'+esc(b.start)+'</span><span>至 '+esc(b.end)+'（退房）</span>',url=orderURL(b);return url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" title="打开 '+esc(srcLabel(b.source))+' 订单 '+esc(b.booking_id)+'；需登录平台">'+text+'</a>':text+'<span class="record-type">'+esc(b.link_issue||'详情链接待核实')+'</span>';}
function knownBlocks(boat){return activeBookings(boat).map(booking=>({start:booking.start,end:shiftDay(booking.end,-1),booking}));}
function mergedOccupancy(boat){
 const merged=[];for(const block of knownBlocks(boat).sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end))){const last=merged[merged.length-1];if(last&&block.start<=shiftDay(last.end,1)){if(block.end>last.end)last.end=block.end;}else merged.push({start:block.start,end:block.end});}return merged;
}
function dayStatus(boat,month=months[monthIndex]){
 const map=new Map(),first=fmt(month),last=fmt(new Date(month.getFullYear(),month.getMonth()+1,0));
 for(const block of knownBlocks(boat)){
  const start=block.start>first?block.start:first,end=block.end<last?block.end:last;if(start>end)continue;
  for(let day=start;day<=end;day=shiftDay(day,1))if(!map.has(day))map.set(day,{cls:'b',label:'不可用',booking:block.booking});
 }
 return map;
}
window.checkAvail=function(){
 if(!DATA)return;
 const d1=document.getElementById('d1').value,d2=document.getElementById('d2').value,el=document.getElementById('result');el.hidden=false;
 if(!validDate(d1)||!validDate(d2)||d2<=d1){el.innerHTML='<div class="query-warning">请选择有效的起止日期，退房日需晚于入住日。</div>';return;}
 hasQuery=true;const end=shiftDay(d2,-1),nights=Math.round((Date.parse(d2)-Date.parse(d1))/86400000);
 let freeCount=0,busyCount=0;
 const cards=DATA.boats.map(boat=>{
  const overlaps=mergedOccupancy(boat).filter(b=>b.start<=end&&b.end>=d1);
  let kind,label,body;
  if(overlaps.length){busyCount++;kind='busy';label='不可用';
   const orders=activeBookings(boat).filter(b=>b.start<d2&&b.end>d1).sort((a,b)=>a.start.localeCompare(b.start));
   body='<p class="conflict">所选日期已有 '+orders.length+' 笔有效订单</p>'+orders.map(b=>'<div class="occLine">'+esc(srcLabel(b.source))+' #'+esc(b.booking_id)+' · '+esc(orderStatus(b))+'<strong>'+linkedRange(b)+'</strong>'+esc(b.amount||'金额待补充')+' · '+esc(b.amount_basis||'金额口径待核实')+'</div>').join('')+overlaps.map(b=>'<div class="occLine">连续订单日期<strong>'+esc(b.start)+' → '+esc(b.end)+'</strong><span class="freeFrom">'+esc(dayAfter(b.end))+' 起该连续订单结束；后续航程请按日期查询。</span></div>').join('');
  }else{freeCount++;kind='free';label='可用';body='<p>'+nights+' 晚内没有有效订单占用。</p>';}
  return '<article class="result-card"><div class="result-name"><strong>'+esc(boat.name)+'</strong><span class="badge '+kind+'">'+label+'</span></div>'+body+'</article>';
 });
 el.innerHTML='<p class="result-heading">'+esc(d1)+' → '+esc(d2)+' · '+freeCount+'/'+DATA.boats.length+' 艘可用 · '+busyCount+' 艘不可用</p><div class="result-grid">'+cards.join('')+'</div>';
};
function calendar(boat,month){
 const map=dayStatus(boat,month),lead=(month.getDay()+6)%7,dim=new Date(month.getFullYear(),month.getMonth()+1,0).getDate(),today=fmt(new Date());
 let html='<table class="cal"><caption class="sr-only">'+esc(boat.name)+' '+month.getFullYear()+'年'+(month.getMonth()+1)+'月</caption><thead><tr>'+WD.map(d=>'<th scope="col">'+d+'</th>').join('')+'</tr></thead><tbody><tr>';
 for(let i=0;i<lead;i++)html+='<td></td>';
 for(let day=1;day<=dim;day++){const date=fmt(new Date(month.getFullYear(),month.getMonth(),day)),status=map.get(date),label=status?'不可用':'可用',booking=status?.booking,url=booking&&orderURL(booking),title=booking?srcLabel(booking.source)+' #'+booking.booking_id+' '+booking.start+' → '+booking.end:date+' '+label;
  html+='<td class="'+(status?'b':'d')+(date===today?' today':'')+'" aria-label="'+esc(date+' '+label+(date===today?' 今天':''))+'" title="'+esc(title)+'"><span>'+(url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" aria-label="'+esc(title)+'">'+day+'</a>':day)+'</span>'+(status?'<span class="day-status">订</span>':'')+'</td>';if((lead+day)%7===0&&day<dim)html+='</tr><tr>';}
 for(let i=0;i<(7-(lead+dim)%7)%7;i++)html+='<td></td>';
 return html+'</tr></tbody></table>';
}
function renderBoats(){
 const prev=document.getElementById('prevMonth'),next=document.getElementById('nextMonth');prev.disabled=monthIndex===0;next.disabled=monthIndex===14;document.getElementById('monthSelect').value=String(monthIndex);
 if(!DATA)return;
 const expanded=new Set(Array.from(document.querySelectorAll('#boats details.boat-bookings[open]'),el=>el.dataset.boatKey));
 document.getElementById('boats').innerHTML=DATA.boats.map((boat,index)=>{
  const match=boat.name.match(/^(.*?)\\s*\\((.*?)\\)$/),name=match?match[1]:boat.name,model=match?match[2]:'',boatKey=String(boat.boataround_slug||boat.name);
  const tags=['boataround','clickandboat','samboat'].map(src=>{const url=sourceURL(boat,src),label=esc(srcLabel(src));return '<span class="source-tag">'+(url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" title="打开平台船期日历；需登录平台">'+label+'</a>':label)+'</span>';}).join('');
  const rows=knownOrders(boat).sort((a,b)=>a.start.localeCompare(b.start)||String(a.booking_id).localeCompare(String(b.booking_id)));
  const records=rows.length?'<div class="boat-booking-list">'+rows.map(b=>{
   const url=orderURL(b),action=url?'<a class="order-detail-link" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" aria-label="查看 '+esc(srcLabel(b.source))+' 订单 '+esc(b.booking_id)+'">查看订单 ↗</a>':'<span class="order-link-issue">'+esc(b.link_issue||'详情链接待核实')+'</span>';
   return '<article class="boat-booking" data-booking-id="'+esc(b.booking_id)+'"><div class="boat-booking-heading"><span class="boat-booking-platform">'+esc(srcLabel(b.source))+' #'+esc(b.booking_id)+'</span><span class="boat-booking-status">'+esc(orderStatus(b))+'</span></div><div class="boat-booking-dates"><span><small>入住</small><strong>'+esc(b.start)+'</strong></span><span class="boat-date-arrow" aria-hidden="true">→</span><span><small>退房</small><strong>'+esc(b.end)+'</strong></span></div><div class="boat-booking-bottom"><div class="boat-booking-money"><strong>'+esc(b.amount||'金额待补充')+'</strong><small>'+esc(b.amount_basis||'金额口径待核实')+'</small></div>'+action+'</div></article>';
  }).join('')+'</div>':'<p class="boat-bookings-empty">暂无当前或未来有效订单。</p>';
  return '<article class="boatSection"><div class="boat-head"><span class="boat-number" aria-hidden="true">'+String(index+1).padStart(2,'0')+'</span><div class="boat-heading-copy"><h3>'+esc(name)+'</h3>'+(model?'<p class="boat-model">'+esc(model)+'</p>':'')+'</div></div><div class="source-tags">'+tags+'</div>'+calendar(boat,months[monthIndex])+'<details class="boat-bookings" data-boat-key="'+esc(boatKey)+'"'+(expanded.has(boatKey)?' open':'')+'><summary>订单明细 <span class="boat-bookings-count">· '+rows.length+' 笔</span></summary>'+records+'</details></article>';
 }).join('');
}
function beijingRefreshTime(value){
 const date=new Date(value||NaN);if(!Number.isFinite(date.getTime()))return '未记录';
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date),p=Object.fromEntries(parts.map(item=>[item.type,item.value]));
 return p.year+'-'+p.month+'-'+p.day+' '+p.hour+':'+p.minute+':'+p.second+'（北京时间）';
}
function render(){document.getElementById('bookingVerifiedAt').textContent=beijingRefreshTime(DATA.mapping_updated_at);document.getElementById('meta').textContent='最新刷新数据时间：'+beijingRefreshTime(DATA.generated_at);document.getElementById('dataIssues').textContent=(DATA.booking_mapping_complete===false?'订单映射不完整。':'')+(DATA.warning||'');renderBoats();}
async function loadData(force){
 const btn=document.getElementById('refreshBtn'),meta=document.getElementById('meta');btn.disabled=true;btn.textContent=force?'正在刷新…':'刷新数据';meta.textContent=force?'正在刷新三个平台，稍候即可查看结果…':'正在读取船期…';
 try{
  const response=await fetch(force?'/api/refresh':'/api/data',{method:force?'POST':'GET'});
  if(response.status===401){window.location.replace('/login');return;}
  const data=await response.json();if(!response.ok||data.error)throw new Error(data.error||'服务暂不可用，请稍后重试');
  if(data.schema_version!==2||!Array.isArray(data.boats))throw new Error('请更新服务端订单逻辑后重试');
  DATA=data;document.getElementById('queryBtn').disabled=false;render();if(hasQuery)window.checkAvail();
 }catch(error){if(DATA&&force){for(const boat of DATA.boats)for(const info of Object.values(boat.sources||{}))info.stale=true;renderBoats();if(hasQuery)window.checkAvail();}meta.textContent=(DATA?'最新刷新数据时间：'+beijingRefreshTime(DATA.generated_at)+'；':'')+error.message+(DATA?'；当前保留上次数据。':'');if(!DATA)document.getElementById('boats').innerHTML='<div class="loading">暂时无法读取船期，请点击“刷新数据”重试。</div>';}
 finally{btn.disabled=false;btn.textContent='刷新数据';}
}
function initialize(){
 document.getElementById('monthSelect').innerHTML=months.map((m,i)=>'<option value="'+i+'">'+m.getFullYear()+'年'+(m.getMonth()+1)+'月</option>').join('');
 document.getElementById('monthSelect').addEventListener('change',event=>{monthIndex=Number(event.target.value);renderBoats();});
 document.getElementById('prevMonth').addEventListener('click',()=>{monthIndex=Math.max(0,monthIndex-1);renderBoats();});
 document.getElementById('nextMonth').addEventListener('click',()=>{monthIndex=Math.min(14,monthIndex+1);renderBoats();});
 document.getElementById('queryForm').addEventListener('submit',event=>{event.preventDefault();window.checkAvail();});
 document.getElementById('refreshBtn').addEventListener('click',()=>loadData(true));
 const today=new Date(),tomorrow=new Date();tomorrow.setDate(today.getDate()+1);document.getElementById('d1').value=fmt(today);document.getElementById('d2').value=fmt(tomorrow);
 for(const id of ['d1','d2'])document.getElementById(id).addEventListener('change',()=>{hasQuery=false;document.getElementById('result').hidden=true;});
 window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload();});
 renderBoats();loadData(false);
}
initialize();
<\/script>
</body>
</html>
`;
var LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<title>\u767B\u5F55 \xB7 Tidewyn Charters \u8239\u961F\u8BA2\u5355\u770B\u677F</title>
<style>
:root{color-scheme:light dark;--bg:#f1f5f7;--card:#fff;--text:#203541;--muted:#526773;--line:#bdcdd6;--control:#6e8593;--accent:#176674;--accent-text:#fff;--soft:#eaf1f4;--error:#922f39;--error-bg:#f9e6e6;font-family:"Segoe UI",system-ui,-apple-system,sans-serif;color:var(--text);background:var(--bg)}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:32px 20px;font-size:1rem;line-height:1.6}main{width:min(100%,440px);background:var(--card);border:1px solid var(--line);border-radius:20px;padding:40px;box-shadow:0 18px 54px #20765140}.brand{margin:0 0 8px;font-size:.875rem;font-weight:750;letter-spacing:.14em;color:var(--accent)}.product{margin:0 0 32px;color:var(--muted);font-size:.875rem}h1{margin:0 0 24px;font-size:1.75rem;line-height:1.3;letter-spacing:-.02em}.field-label{display:block;margin:22px 0 8px;font-size:.875rem;font-weight:650}input[type=email],input[type=password],input[type=text]{display:block;width:100%;min-width:0;min-height:52px;border:1px solid var(--control);border-radius:10px;padding:12px 14px;font:inherit;background:var(--bg);color:var(--text)}input::placeholder{color:var(--muted);opacity:1}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.password-field{position:relative}.password-field input{padding-right:76px}.reveal{position:absolute;right:4px;top:4px;min-width:64px;min-height:44px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:var(--accent);font:inherit;font-size:.875rem;cursor:pointer}.remember{display:flex;align-items:flex-start;gap:12px;margin:24px 0 0;min-height:48px;cursor:pointer}.remember input{accent-color:var(--accent);width:22px;height:22px;flex:none;margin:3px 0 0}.remember strong{display:block;font-size:1rem;font-weight:600}.remember small{display:block;font-size:.875rem;color:var(--muted);margin-top:3px}.submit{width:100%;min-height:52px;margin-top:26px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:650;cursor:pointer}.submit:hover{filter:brightness(.94)}.error{margin:0 0 20px;padding:12px 14px;border:1px solid var(--error);border-radius:10px;background:var(--error-bg);color:var(--error);font-size:.875rem}.session-note{font-size:.875rem;color:var(--muted);margin:16px 0 0;text-align:center}
@media(max-width:480px){body{padding:max(20px,env(safe-area-inset-top)) 16px max(20px,env(safe-area-inset-bottom));align-content:center}main{padding:30px 24px;border-radius:16px;box-shadow:none}}
@media(prefers-color-scheme:dark){:root{--bg:#142129;--card:#1b2d38;--text:#e1ebf0;--muted:#b3c4ce;--line:#586e7b;--control:#91aab8;--accent:#9cd3db;--accent-text:#102e35;--soft:#263c49;--error:#ffdce1;--error-bg:#493724}}
</style>
</head>
<body>
<main>
<p class="brand">TIDEWYN CHARTERS</p><p class="product">\u8239\u961F\u8BA2\u5355\u770B\u677F</p><h1>\u767B\u5F55\u770B\u677F</h1>
<!--LOGIN_ERROR-->
<form action="/auth/login" method="post">
<label class="field-label" for="username">\u8D26\u53F7</label>
<input id="username" name="username" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="254" placeholder="\u8BF7\u8F93\u5165\u8D26\u53F7\u90AE\u7BB1" value="__LOGIN_USERNAME__">
<label class="field-label" for="password">\u5BC6\u7801</label>
<div class="password-field"><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256" placeholder="\u8BF7\u8F93\u5165\u5BC6\u7801"><button class="reveal" type="button" aria-controls="password" aria-pressed="false">\u663E\u793A</button></div>
<label class="remember"><input type="checkbox" name="remember" value="1" __REMEMBER_CHECKED__><span><strong>\u8BB0\u4F4F\u6211</strong><small>\u5728\u6B64\u8BBE\u5907\u4E0A\u81EA\u52A8\u767B\u5F55\uFF0C\u6700\u957F30\u5929</small></span></label>
<button class="submit" type="submit">\u767B\u5F55</button>
<p class="session-note">\u4E0D\u52FE\u9009\u65F6\uFF0C\u767B\u5F55\u72B6\u6001\u6700\u591A\u4FDD\u755912\u5C0F\u65F6</p>
</form>
</main>
<script>
document.querySelector('.reveal').addEventListener('click',function(){const field=document.getElementById('password');const show=field.type==='password';field.type=show?'text':'password';this.textContent=show?'\u9690\u85CF':'\u663E\u793A';this.setAttribute('aria-pressed',String(show));});
<\/script>
</body>
</html>
`;
var SEED = {"generated_at":"2026-09-08T01:43:28.000Z","boats":[{"name":"Tidewyn Dream (Wavecat 34)","boataround_slug":"wavecat-34-open-tidewyn-dream","clickandboat_id":100001,"samboat_id":200001,"sources":{"boataround":{"ok":true,"blocks":[{"start":"2027-01-23","end":"2027-01-29","type":"booked"}]},"clickandboat":{"ok":true,"blocks":[{"start":"2027-01-23","end":"2027-01-30","type":"Unavailable"},{"start":"2027-01-21","end":"2027-01-23","type":"not_selectable"}]},"samboat":{"ok":true,"blocks":[]}},"bookings":[{"source":"clickandboat","booking_id":"1274920","start":"2026-05-27","end":"2026-05-30","url":"https://www.clickandboat.com/uk/booking/1274920/detail","link_issue":null,"amount":"€2,280","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"}]},{"name":"Tidewyn Discovery (Reef Cat 37)","boataround_slug":"reef-cat-37-tidewyn-discovery","clickandboat_id":100002,"samboat_id":200002,"sources":{"boataround":{"ok":true,"blocks":[{"start":"2026-12-22","end":"2026-12-31","type":"booked"},{"start":"2027-02-13","end":"2027-02-27","type":"booked"}]},"clickandboat":{"ok":true,"blocks":[{"start":"2026-12-22","end":"2026-12-25","type":"Booked"},{"start":"2026-12-26","end":"2026-12-31","type":"Booked"},{"start":"2027-02-13","end":"2027-02-27","type":"Unavailable"},{"start":"2026-12-17","end":"2026-12-22","type":"not_selectable"},{"start":"2026-12-21","end":"2026-12-26","type":"not_selectable"},{"start":"2027-02-11","end":"2027-02-13","type":"not_selectable"}]},"samboat":{"ok":true,"blocks":[{"start":"2026-12-22","end":"2026-12-31","type":"Unavailable"},{"start":"2027-02-13","end":"2027-02-26","type":"Booked"}]}},"bookings":[{"source":"clickandboat","booking_id":"1219878","start":"2025-09-27","end":"2025-09-29","url":"https://www.clickandboat.com/uk/booking/1219878/detail","link_issue":null,"amount":"€4,581","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1219385","start":"2025-11-17","end":"2025-11-21","url":"https://www.clickandboat.com/uk/booking/1219385/detail","link_issue":null,"amount":"€9,444","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1128533","start":"2026-01-01","end":"2026-01-04","url":"https://www.clickandboat.com/uk/booking/1128533/detail","link_issue":null,"amount":"€7,596","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1219603","start":"2026-01-05","end":"2026-01-08","url":"https://www.clickandboat.com/uk/booking/1219603/detail","link_issue":null,"amount":"€8,742","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1229396","start":"2026-02-22","end":"2026-02-27","url":"https://www.clickandboat.com/uk/booking/1229396/detail","link_issue":null,"amount":"€9,306","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1230411","start":"2026-03-13","end":"2026-03-20","url":"https://www.clickandboat.com/uk/booking/1230411/detail","link_issue":null,"amount":"€10,080","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1228470","start":"2026-03-21","end":"2026-03-28","url":"https://www.clickandboat.com/uk/booking/1228470/detail","link_issue":null,"amount":"€9,717","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1215268","start":"2026-04-04","end":"2026-04-10","url":"https://www.clickandboat.com/uk/booking/1215268/detail","link_issue":null,"amount":"€14,859","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1256673","start":"2026-12-22","end":"2026-12-25","url":"https://www.clickandboat.com/uk/booking/1256673/detail","link_issue":null,"amount":"€6,384","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-08T01:25:43.6676365Z"},{"source":"clickandboat","booking_id":"1252516","start":"2026-12-26","end":"2026-12-31","url":"https://www.clickandboat.com/uk/booking/1252516/detail","link_issue":null,"amount":"€9,831","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-08T01:25:43.6676365Z"},{"source":"samboat","booking_id":"1549424","start":"2027-02-13","end":"2027-02-27","url":"https://www.samboat.com/private/reservation/1549424","link_issue":null,"amount":"$26,358.69","amount_basis":"租客在线支付金额","status":"deposit_paid","verified_at":"2026-09-08T01:25:43.6676365Z"}]},{"name":"Tidewyn Cruise (Harbor 34)","boataround_slug":"harbor-cruiser-34-tidewyn-cruise","clickandboat_id":100003,"samboat_id":null,"sources":{"boataround":{"ok":true,"blocks":[{"start":"2027-03-06","end":"2027-03-12","type":"booked"},{"start":"2026-09-08","end":"2026-09-30","type":"booked"},{"start":"2026-10-17","end":"2026-10-23","type":"booked"}]},"clickandboat":{"ok":true,"blocks":[{"start":"2027-03-06","end":"2027-03-13","type":"Unavailable"},{"start":"2027-03-04","end":"2027-03-06","type":"not_selectable"}]}},"bookings":[]},{"name":"Tidewyn Discovery 2 (Seacat 40)","boataround_slug":"seacat-open-40-tidewyn-discovery-2","clickandboat_id":100004,"samboat_id":200003,"sources":{"boataround":{"ok":true,"blocks":[{"start":"2026-10-17","end":"2026-10-27","type":"booked"},{"start":"2026-11-07","end":"2026-11-27","type":"booked"},{"start":"2027-02-27","end":"2027-03-13","type":"booked"},{"start":"2026-12-26","end":"2027-01-08","type":"booked"},{"start":"2026-12-12","end":"2026-12-18","type":"booked"}]},"clickandboat":{"ok":true,"blocks":[{"start":"2026-11-07","end":"2026-11-13","type":"Booked"},{"start":"2026-11-14","end":"2026-11-21","type":"Unavailable"},{"start":"2026-11-22","end":"2026-11-28","type":"Unavailable"},{"start":"2026-12-26","end":"2026-12-30","type":"Unavailable"},{"start":"2027-01-01","end":"2027-01-08","type":"Unavailable"},{"start":"2027-03-06","end":"2027-03-13","type":"Unavailable"},{"start":"2026-11-02","end":"2026-11-07","type":"not_selectable"},{"start":"2026-11-08","end":"2026-11-14","type":"not_selectable"},{"start":"2026-11-16","end":"2026-11-22","type":"not_selectable"},{"start":"2026-12-20","end":"2026-12-26","type":"not_selectable"},{"start":"2026-12-30","end":"2027-01-01","type":"not_selectable"},{"start":"2027-03-04","end":"2027-03-06","type":"not_selectable"}]},"samboat":{"ok":true,"blocks":[{"start":"2026-10-27","end":"2026-10-27","type":"Unavailable"},{"start":"2027-03-06","end":"2027-03-13","type":"Unavailable"},{"start":"2026-11-07","end":"2026-11-13","type":"Unavailable"},{"start":"2027-03-20","end":"2027-03-20","type":"Unavailable"},{"start":"2026-09-01","end":"2026-09-30","type":"Unavailable"},{"start":"2026-10-01","end":"2026-10-16","type":"Unavailable"},{"start":"2026-10-28","end":"2026-10-31","type":"Unavailable"},{"start":"2026-11-01","end":"2026-11-06","type":"Unavailable"},{"start":"2026-11-14","end":"2026-11-30","type":"Unavailable"},{"start":"2026-12-01","end":"2026-12-31","type":"Unavailable"},{"start":"2027-01-08","end":"2027-01-31","type":"Unavailable"},{"start":"2027-02-01","end":"2027-02-28","type":"Unavailable"},{"start":"2027-03-01","end":"2027-03-05","type":"Unavailable"},{"start":"2027-03-14","end":"2027-03-19","type":"Unavailable"},{"start":"2027-03-21","end":"2027-03-31","type":"Unavailable"},{"start":"2027-04-01","end":"2027-04-30","type":"Unavailable"},{"start":"2027-05-01","end":"2027-05-31","type":"Unavailable"},{"start":"2027-06-01","end":"2027-06-30","type":"Unavailable"},{"start":"2026-10-17","end":"2026-10-26","type":"Booked"},{"start":"2027-01-01","end":"2027-01-07","type":"Booked"}]}},"bookings":[{"source":"clickandboat","booking_id":"1183339","start":"2025-11-17","end":"2025-11-24","url":"https://www.clickandboat.com/uk/booking/1183339/detail","link_issue":null,"amount":"€12,294","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1215199","start":"2025-11-26","end":"2025-11-29","url":"https://www.clickandboat.com/uk/booking/1215199/detail","link_issue":null,"amount":"€8,307","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1161991","start":"2025-12-20","end":"2025-12-31","url":"https://www.clickandboat.com/uk/booking/1161991/detail","link_issue":null,"amount":"€25,791","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1000000","start":"2026-03-14","end":"2026-03-21","url":"https://www.clickandboat.com/uk/booking/1000000/detail","link_issue":null,"amount":"€4,200","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1151370","start":"2026-04-04","end":"2026-04-17","url":"https://www.clickandboat.com/uk/booking/1151370/detail","link_issue":null,"amount":"€22,371","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"clickandboat","booking_id":"1232398","start":"2026-04-20","end":"2026-04-24","url":"https://www.clickandboat.com/uk/booking/1232398/detail","link_issue":null,"amount":"€7,236","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-07T17:48:00-07:00"},{"source":"samboat","booking_id":"1000001","start":"2026-10-17","end":"2026-10-27","url":"https://www.samboat.com/private/reservation/1000001","link_issue":null,"amount":"$11,954.04","amount_basis":"租客在线支付金额","status":"completed","verified_at":"2026-09-08T01:25:43.6676365Z"},{"source":"clickandboat","booking_id":"1250578","start":"2026-11-07","end":"2026-11-13","url":"https://www.clickandboat.com/uk/booking/1250578/detail","link_issue":null,"amount":"€11,310","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-08T01:25:43.6676365Z"},{"source":"samboat","booking_id":"1502428","start":"2027-01-01","end":"2027-01-08","url":"https://www.samboat.com/private/reservation/1502428","link_issue":null,"amount":"$22,443.72","amount_basis":"租客在线支付金额","status":"deposit_paid","verified_at":"2026-09-08T01:25:43.6676365Z"}]},{"name":"Tidewyn Discovery 3 (Bluecat 42)","boataround_slug":"bluecat-42-tidewyn-discovery-3","clickandboat_id":100005,"samboat_id":null,"sources":{"boataround":{"ok":true,"blocks":[{"start":"2026-09-08","end":"2026-12-04","type":"booked"}]},"clickandboat":{"ok":true,"blocks":[]}},"bookings":[]},{"name":"Tidewyn Cruise 2 (Coastline 42DS)","boataround_slug":"coastline-sea-journey-42-tidewyn-cruise-2","clickandboat_id":100006,"samboat_id":null,"sources":{"boataround":{"ok":true,"blocks":[{"start":"2026-12-05","end":"2026-12-11","type":"booked"},{"start":"2026-11-24","end":"2026-11-29","type":"booked"},{"start":"2026-09-08","end":"2026-09-30","type":"booked"}]},"clickandboat":{"ok":true,"blocks":[{"start":"2026-09-01","end":"2026-10-01","type":"Unavailable"},{"start":"2026-12-05","end":"2026-12-12","type":"Unavailable"},{"start":"2026-08-31","end":"2026-09-01","type":"not_selectable"},{"start":"2026-11-29","end":"2026-12-05","type":"not_selectable"}]}},"bookings":[]},{"name":"Tidewyn Discovery 5 (Grandcat 55)","boataround_slug":"grandcat-55-tidewyn-discovery-5","clickandboat_id":100007,"samboat_id":null,"sources":{"boataround":{"ok":true,"blocks":[{"start":"2026-10-17","end":"2026-10-30","type":"booked"},{"start":"2026-11-07","end":"2026-11-28","type":"booked"},{"start":"2027-02-13","end":"2027-02-19","type":"booked"},{"start":"2026-12-05","end":"2026-12-18","type":"booked"},{"start":"2027-01-04","end":"2027-01-16","type":"booked"},{"start":"2027-01-18","end":"2027-01-30","type":"booked"},{"start":"2027-05-02","end":"2027-05-08","type":"booked"},{"start":"2026-09-08","end":"2026-09-30","type":"booked"}]},"clickandboat":{"ok":true,"blocks":[{"start":"2026-10-17","end":"2026-10-23","type":"Unavailable"},{"start":"2026-10-24","end":"2026-10-31","type":"Unavailable"},{"start":"2026-11-07","end":"2026-11-13","type":"Booked"},{"start":"2026-11-14","end":"2026-11-21","type":"Unavailable"},{"start":"2026-11-22","end":"2026-11-28","type":"Unavailable"},{"start":"2026-12-05","end":"2026-12-19","type":"Unavailable"},{"start":"2027-01-04","end":"2027-01-09","type":"Unavailable"},{"start":"2027-01-09","end":"2027-01-16","type":"Booked"},{"start":"2027-01-18","end":"2027-01-22","type":"Booked"},{"start":"2027-01-23","end":"2027-01-30","type":"Unavailable"},{"start":"2027-02-13","end":"2027-02-20","type":"Unavailable"},{"start":"2027-05-02","end":"2027-05-08","type":"Booked"},{"start":"2026-10-15","end":"2026-10-17","type":"not_selectable"},{"start":"2026-10-22","end":"2026-10-24","type":"not_selectable"},{"start":"2026-11-02","end":"2026-11-07","type":"not_selectable"},{"start":"2026-11-08","end":"2026-11-14","type":"not_selectable"},{"start":"2026-11-16","end":"2026-11-22","type":"not_selectable"},{"start":"2026-11-29","end":"2026-12-05","type":"not_selectable"},{"start":"2027-01-02","end":"2027-01-04","type":"not_selectable"},{"start":"2027-01-08","end":"2027-01-09","type":"not_selectable"},{"start":"2027-01-17","end":"2027-01-18","type":"not_selectable"},{"start":"2027-01-21","end":"2027-01-23","type":"not_selectable"},{"start":"2027-02-11","end":"2027-02-13","type":"not_selectable"},{"start":"2027-05-01","end":"2027-05-02","type":"not_selectable"}]}},"bookings":[{"source":"clickandboat","booking_id":"1000002","start":"2026-11-07","end":"2026-11-13","url":"https://www.clickandboat.com/uk/booking/1000002/detail","link_issue":null,"amount":"€12,705","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-08T01:25:43.6676365Z"},{"source":"clickandboat","booking_id":"1244141","start":"2027-01-09","end":"2027-01-16","url":"https://www.clickandboat.com/uk/booking/1244141/detail","link_issue":null,"amount":"€18,468","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-08T01:25:43.6676365Z"},{"source":"clickandboat","booking_id":"1364259","start":"2027-01-18","end":"2027-01-22","url":"https://www.clickandboat.com/uk/booking/1364259/detail","link_issue":null,"amount":"€11,820","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-08T01:25:43.6676365Z"},{"source":"clickandboat","booking_id":"1327680","start":"2027-05-02","end":"2027-05-08","url":"https://www.clickandboat.com/uk/booking/1327680/detail","link_issue":null,"amount":"€10,350","amount_basis":"船东净收入","status":"accepted","verified_at":"2026-09-08T01:25:43.6676365Z"}]}],"schema_version":2,"mapping_updated_at":"2026-09-08T01:25:43.6676365Z","booking_mapping_complete":true,"booking_warnings":[],"warnings":[],"warning":""};
var SECURITY_HEADERS = { "Cache-Control": "private, no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Strict-Transport-Security": "max-age=31536000", "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()", "X-Robots-Tag": "noindex, nofollow" };
var PAGE_CSP = { "login": "default-src 'none'; script-src 'sha256-BPxAJk7oge6YnpQXY6jSsGfXw5WWyUGWvXuwZZGGEjE='; style-src 'sha256-W0nPjkO9aR+ltpzZqZswMjplNdWSmY3FFlRe+8URieU='; script-src-attr 'none'; style-src-attr 'none'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com; upgrade-insecure-requests", "dashboard": "default-src 'none'; script-src 'sha256-BcAquqOntBaYnMoVFR/G6infUkmyerHRtTc1d3hOCxI='; style-src 'sha256-0msf3imGLBSG41q3yXakHwnm5L3MpF1KKCpdhbqYJfE='; script-src-attr 'none'; style-src-attr 'none'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com; upgrade-insecure-requests" };
var SESSION_COOKIE = "__Host-fleet_session";
var SESSION_LIFETIME = 12 * 60 * 60 * 1e3;
var REMEMBER_LIFETIME = 30 * 24 * 60 * 60 * 1e3;
var ATTEMPT_WINDOW = 15 * 60 * 1e3;
var MAX_ATTEMPTS = 8;
var encoder = new TextEncoder();
var authHeaders = { ...SECURITY_HEADERS, "Content-Security-Policy": PAGE_CSP.login };
var hex = /* @__PURE__ */ __name((bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""), "hex");
var unhex = /* @__PURE__ */ __name((value) => Uint8Array.from(value.match(/../g), (byte) => parseInt(byte, 16)), "unhex");
async function digest(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
__name(digest, "digest");
function authConfig(env) {
  const config = JSON.parse(env.FLEET_AUTH_CONFIG || "null");
  if (!env.BUCKET || !config || typeof config.username !== "string" || !config.username || config.iterations !== 1e5 || !/^[a-f0-9]{64}$/.test(config.salt) || !/^[a-f0-9]{64}$/.test(config.pepper) || !/^[a-f0-9]{64}$/.test(config.verifier)) {
    throw new Error("Authentication configuration unavailable");
  }
  return config;
}
__name(authConfig, "authConfig");
async function passwordVerifier(password, config) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(config.salt), iterations: config.iterations }, key, 256);
  const pepper = await crypto.subtle.importKey("raw", unhex(config.pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", pepper, derived));
}
__name(passwordVerifier, "passwordVerifier");
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(a, b);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
__name(equalBytes, "equalBytes");
function sessionToken(request) {
  const matches = (request.headers.get("Cookie") || "").split(";").map((value) => value.trim()).filter((value) => value.startsWith(SESSION_COOKIE + "="));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(SESSION_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
__name(sessionToken, "sessionToken");
async function sessionKey(token) {
  return "auth/sessions/" + await digest(token) + ".json";
}
__name(sessionKey, "sessionKey");
async function credentialTag(config) {
  return digest(JSON.stringify(config));
}
__name(credentialTag, "credentialTag");
async function authenticated(request, env, config) {
  const token = sessionToken(request);
  if (!token) return false;
  const entry = await env.BUCKET.get(await sessionKey(token));
  if (!entry) return false;
  let session;
  try {
    session = await entry.json();
  } catch {
    return false;
  }
  const now = Date.now();
  if (!session || !Number.isFinite(session.expiresAt) || now >= session.expiresAt) return false;
  if (session.issuedAt === void 0 && session.rememberMe === void 0) {
    if (session.expiresAt > now + SESSION_LIFETIME + 6e4) return false;
  } else {
    if (typeof session.rememberMe !== "boolean" || !Number.isFinite(session.issuedAt) || session.issuedAt < 0 || session.issuedAt > now + 6e4) return false;
    const lifetime = session.rememberMe ? REMEMBER_LIFETIME : SESSION_LIFETIME;
    if (session.expiresAt <= session.issuedAt || session.expiresAt - session.issuedAt > lifetime) return false;
  }
  return session.credentialTag === await credentialTag(config);
}
__name(authenticated, "authenticated");
function loginPage(message = "", status = 200, extra = {}, values = {}) {
  const error = message ? '<p class="error" role="alert">' + message + "</p>" : "";
  const escaped = String(values.username || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const page = LOGIN_HTML.replace("<!--LOGIN_ERROR-->", error).replace("__LOGIN_USERNAME__", () => escaped).replace("__REMEMBER_CHECKED__", values.rememberMe ? "checked" : "");
  return new Response(page, { status, headers: { ...authHeaders, "Content-Type": "text/html; charset=utf-8", ...extra } });
}
__name(loginPage, "loginPage");
function authJson(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { ...authHeaders, "Content-Type": "application/json; charset=utf-8" } });
}
__name(authJson, "authJson");
function redirectLogin(cookie) {
  return new Response(null, { status: 303, headers: { ...authHeaders, Location: "/login", ...cookie ? { "Set-Cookie": cookie } : {} } });
}
__name(redirectLogin, "redirectLogin");
var expiredCookie = /* @__PURE__ */ __name(() => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, "expiredCookie");
function sameOrigin(request) {
  return request.headers.get("Origin") === new URL(request.url).origin && request.headers.get("Sec-Fetch-Site") !== "cross-site";
}
__name(sameOrigin, "sameOrigin");
async function reserveAttempt(request, env) {
  const key = "auth/attempts/account.json";
  const old = await env.BUCKET.get(key);
  const now = Date.now();
  const previous = old ? await old.json() : null;
  let count = 0, resetAt = now + ATTEMPT_WINDOW;
  if (old && (!previous || !Number.isInteger(previous.count) || previous.count < 0 || !Number.isFinite(previous.resetAt))) throw new Error("Invalid attempt state");
  if (previous && previous.resetAt > now) {
    count = previous.count;
    resetAt = previous.resetAt;
  }
  if (count >= MAX_ATTEMPTS) return false;
  const result = await env.BUCKET.put(key, JSON.stringify({ count: count + 1, resetAt }), {
    onlyIf: old ? { etagMatches: old.etag } : new Headers({ "If-None-Match": "*" }),
    httpMetadata: { contentType: "application/json" }
  });
  return result !== null;
}
__name(reserveAttempt, "reserveAttempt");
async function login(request, env, config) {
  if (!sameOrigin(request)) return loginPage("\u8BF7\u6C42\u65E0\u6548\uFF0C\u8BF7\u4ECE\u6B64\u9875\u9762\u91CD\u65B0\u767B\u5F55\u3002", 403);
  if (!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return loginPage("\u767B\u5F55\u4FE1\u606F\u683C\u5F0F\u65E0\u6548\uFF0C\u8BF7\u91CD\u8BD5\u3002", 400);
  if (Number(request.headers.get("Content-Length")) > 4096) return loginPage("\u767B\u5F55\u4FE1\u606F\u8FC7\u957F\uFF0C\u8BF7\u91CD\u8BD5\u3002", 413);
  const reader = request.body?.getReader();
  let length = 0;
  const chunks = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        return loginPage("\u767B\u5F55\u4FE1\u606F\u8FC7\u957F\uFF0C\u8BF7\u91CD\u8BD5\u3002", 413);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  const username = (form.get("username") || "").trim().toLowerCase();
  const password = form.get("password") || "";
  if (form.getAll("remember").length > 1 || !["1", null].includes(form.get("remember"))) return loginPage("\u767B\u5F55\u4FE1\u606F\u683C\u5F0F\u65E0\u6548\uFF0C\u8BF7\u91CD\u8BD5\u3002", 400);
  const rememberMe = form.get("remember") === "1";
  const values = { username, rememberMe };
  if (form.getAll("username").length !== 1 || form.getAll("password").length !== 1 || username.length > 254 || password.length > 256 || !password) return loginPage("\u8D26\u53F7\u6216\u5BC6\u7801\u4E0D\u6B63\u786E\u3002", 401);
  let allowed;
  try {
    allowed = await reserveAttempt(request, env);
  } catch {
    return loginPage("\u767B\u5F55\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", 503, {}, values);
  }
  if (!allowed) return loginPage("\u5C1D\u8BD5\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7 15 \u5206\u949F\u540E\u518D\u8BD5\u3002", 429, { "Retry-After": "900" }, values);
  const actual = await passwordVerifier(password, config);
  const matches = equalBytes(actual, unhex(config.verifier));
  if (!matches || username !== config.username.toLowerCase()) return loginPage("\u8D26\u53F7\u6216\u5BC6\u7801\u4E0D\u6B63\u786E\u3002", 401, {}, values);
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const issuedAt = Date.now(), lifetime = rememberMe ? REMEMBER_LIFETIME : SESSION_LIFETIME, expiresAt = issuedAt + lifetime;
  await env.BUCKET.put(await sessionKey(token), JSON.stringify({ issuedAt, expiresAt, rememberMe, credentialTag: await credentialTag(config) }), { httpMetadata: { contentType: "application/json" } });
  const prior = sessionToken(request);
  if (prior) await env.BUCKET.delete(await sessionKey(prior));
  const persistence = rememberMe ? `; Max-Age=${REMEMBER_LIFETIME / 1e3}; Expires=${new Date(expiresAt).toUTCString()}` : "";
  return new Response(null, { status: 303, headers: { ...authHeaders, Location: "/", "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax${persistence}` } });
}
__name(login, "login");
async function authGate(request, env) {
  const path = new URL(request.url).pathname;
  try {
    const config = authConfig(env);
    if (path === "/auth/login") return request.method === "POST" ? await login(request, env, config) : authJson("\u4E0D\u652F\u6301\u7684\u8BF7\u6C42\u65B9\u5F0F", 405);
    if (path === "/auth/logout") {
      if (request.method !== "POST") return authJson("\u4E0D\u652F\u6301\u7684\u8BF7\u6C42\u65B9\u5F0F", 405);
      if (!sameOrigin(request)) return authJson("\u8BF7\u6C42\u65E0\u6548\uFF0C\u8BF7\u91CD\u8BD5", 403);
      const token = sessionToken(request);
      if (token) await env.BUCKET.delete(await sessionKey(token));
      return redirectLogin(expiredCookie());
    }
    const signedIn = await authenticated(request, env, config);
    if (path === "/login") {
      if (!["GET", "HEAD"].includes(request.method)) return authJson("\u4E0D\u652F\u6301\u7684\u8BF7\u6C42\u65B9\u5F0F", 405);
      if (signedIn) return new Response(null, { status: 303, headers: { ...authHeaders, Location: "/" } });
      if (request.method === "HEAD") return new Response(null, { headers: { ...authHeaders, "Content-Type": "text/html; charset=utf-8" } });
      return loginPage();
    }
    if (signedIn) return null;
    return path.startsWith("/api/") ? authJson("\u8BF7\u5148\u767B\u5F55", 401) : redirectLogin();
  } catch {
    return path.startsWith("/api/") ? authJson("\u767B\u5F55\u670D\u52A1\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", 503) : loginPage("\u767B\u5F55\u670D\u52A1\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", 503);
  }
}
__name(authGate, "authGate");
var CACHE_KEY = "fleet/fleet-data-v2.json";
var FLEET_SPECS = [{"name":"Tidewyn Dream (Wavecat 34)","boataround_slug":"wavecat-34-open-tidewyn-dream","clickandboat_id":100001,"samboat_id":200001},{"name":"Tidewyn Discovery (Reef Cat 37)","boataround_slug":"reef-cat-37-tidewyn-discovery","clickandboat_id":100002,"samboat_id":200002},{"name":"Tidewyn Cruise (Harbor 34)","boataround_slug":"harbor-cruiser-34-tidewyn-cruise","clickandboat_id":100003,"samboat_id":null},{"name":"Tidewyn Discovery 2 (Seacat 40)","boataround_slug":"seacat-open-40-tidewyn-discovery-2","clickandboat_id":100004,"samboat_id":200003},{"name":"Tidewyn Discovery 3 (Bluecat 42)","boataround_slug":"bluecat-42-tidewyn-discovery-3","clickandboat_id":100005,"samboat_id":null},{"name":"Tidewyn Cruise 2 (Coastline 42DS)","boataround_slug":"coastline-sea-journey-42-tidewyn-cruise-2","clickandboat_id":100006,"samboat_id":null},{"name":"Tidewyn Discovery 5 (Grandcat 55)","boataround_slug":"grandcat-55-tidewyn-discovery-5","clickandboat_id":100007,"samboat_id":null}];
var BOOKING_MAP = {"clickandboat":[{"start":"2026-11-07","end":"2026-11-13","boat":100007,"amount":"€12,705","url":"https://www.clickandboat.com/uk/booking/1000002/detail","booking_id":"1000002","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-08T01:25:43.6676365Z","verification_source":"已登录浏览器逐笔核验订单详情"},{"start":"2026-11-07","end":"2026-11-13","boat":100004,"amount":"€11,310","url":"https://www.clickandboat.com/uk/booking/1250578/detail","booking_id":"1250578","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-08T01:25:43.6676365Z","verification_source":"已登录浏览器逐笔核验订单详情"},{"start":"2026-12-22","end":"2026-12-25","boat":"comet","amount":"€6,384","url":"https://www.clickandboat.com/uk/booking/1256673/detail","booking_id":"1256673","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-08T01:25:43.6676365Z","verification_source":"已登录浏览器逐笔核验订单详情"},{"start":"2026-12-26","end":"2026-12-31","boat":"comet","amount":"€9,831","url":"https://www.clickandboat.com/uk/booking/1252516/detail","booking_id":"1252516","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-08T01:25:43.6676365Z","verification_source":"已登录浏览器逐笔核验订单详情"},{"start":"2027-01-09","end":"2027-01-16","boat":100007,"amount":"€18,468","url":"https://www.clickandboat.com/uk/booking/1244141/detail","booking_id":"1244141","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-08T01:25:43.6676365Z","verification_source":"已登录浏览器逐笔核验订单详情"},{"start":"2027-01-18","end":"2027-01-22","boat":100007,"amount":"€11,820","url":"https://www.clickandboat.com/uk/booking/1364259/detail","booking_id":"1364259","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-08T01:25:43.6676365Z","verification_source":"已登录浏览器逐笔核验订单详情"},{"start":"2027-05-02","end":"2027-05-08","boat":100007,"amount":"€10,350","url":"https://www.clickandboat.com/uk/booking/1327680/detail","booking_id":"1327680","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-08T01:25:43.6676365Z","verification_source":"已登录浏览器逐笔核验订单详情"},{"start":"2026-05-27","end":"2026-05-30","boat":100001,"amount":"€2,280","url":"https://www.clickandboat.com/uk/booking/1274920/detail","booking_id":"1274920","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2026-04-20","end":"2026-04-24","boat":100004,"amount":"€7,236","url":"https://www.clickandboat.com/uk/booking/1232398/detail","booking_id":"1232398","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2026-04-04","end":"2026-04-17","boat":100004,"amount":"€22,371","url":"https://www.clickandboat.com/uk/booking/1151370/detail","booking_id":"1151370","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2026-04-04","end":"2026-04-10","boat":"comet","amount":"€14,859","url":"https://www.clickandboat.com/uk/booking/1215268/detail","booking_id":"1215268","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2026-03-21","end":"2026-03-28","boat":"comet","amount":"€9,717","url":"https://www.clickandboat.com/uk/booking/1228470/detail","booking_id":"1228470","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2026-03-14","end":"2026-03-21","boat":100004,"amount":"€4,200","url":"https://www.clickandboat.com/uk/booking/1000000/detail","booking_id":"1000000","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2026-03-13","end":"2026-03-20","boat":"comet","amount":"€10,080","url":"https://www.clickandboat.com/uk/booking/1230411/detail","booking_id":"1230411","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2026-02-22","end":"2026-02-27","boat":"comet","amount":"€9,306","url":"https://www.clickandboat.com/uk/booking/1229396/detail","booking_id":"1229396","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2026-01-05","end":"2026-01-08","boat":"comet","amount":"€8,742","url":"https://www.clickandboat.com/uk/booking/1219603/detail","booking_id":"1219603","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2026-01-01","end":"2026-01-04","boat":"comet","amount":"€7,596","url":"https://www.clickandboat.com/uk/booking/1128533/detail","booking_id":"1128533","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2025-12-20","end":"2025-12-31","boat":100004,"amount":"€25,791","url":"https://www.clickandboat.com/uk/booking/1161991/detail","booking_id":"1161991","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2025-11-26","end":"2025-11-29","boat":100004,"amount":"€8,307","url":"https://www.clickandboat.com/uk/booking/1215199/detail","booking_id":"1215199","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2025-11-17","end":"2025-11-24","boat":100004,"amount":"€12,294","url":"https://www.clickandboat.com/uk/booking/1183339/detail","booking_id":"1183339","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2025-11-17","end":"2025-11-21","boat":"comet","amount":"€9,444","url":"https://www.clickandboat.com/uk/booking/1219385/detail","booking_id":"1219385","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"},{"start":"2025-09-27","end":"2025-09-29","boat":"comet","amount":"€4,581","url":"https://www.clickandboat.com/uk/booking/1219878/detail","booking_id":"1219878","status":"accepted","amount_basis":"船东净收入","verified_at":"2026-09-07T17:48:00-07:00","verification_source":"交接档案 research/cb-bookings-v2.json；本轮未逐笔复核历史订单"}],"samboat":[{"start":"2026-10-17","end":"2026-10-27","boat":200003,"amount":"$11,954.04","url":"https://www.samboat.com/private/reservation/1000001","booking_id":"1000001","status":"cancelled","amount_basis":"租客在线支付金额","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"2026-09-08 用户明确确认：已经取消，不计入占用。平台 Confirmed 列表及 Reservation 日历残留不作为有效订单依据。","platform_status":"Completed"},{"start":"2027-01-01","end":"2027-01-08","boat":200003,"amount":"$22,443.72","url":"https://www.samboat.com/private/reservation/1502428","booking_id":"1502428","status":"deposit_paid","amount_basis":"租客在线支付金额","verified_at":"2026-09-08T01:25:43.6676365Z","verification_source":"已登录浏览器逐笔核验订单详情"},{"start":"2027-02-13","end":"2027-02-27","boat":200002,"amount":"$26,358.69","url":"https://www.samboat.com/private/reservation/1549424","booking_id":"1549424","status":"deposit_paid","amount_basis":"租客在线支付金额","verified_at":"2026-09-08T01:25:43.6676365Z","verification_source":"已登录浏览器逐笔核验订单详情"}],"schema_version":2,"mapping_updated_at":"2026-09-08T03:44:36.051Z","boataround":[{"booking_id":"280707","detail_id":"b386b5a4271f3a72a26a93d0","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2026-10-17","end":"2026-10-24","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/b386b5a4271f3a72a26a93d0","amount":"€14,086.50","amount_basis":"船东净价","client_amount":"€15,585.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"PARTIALLY PAID","verified_at":"2026-09-08T03:38:13.981Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"300000","detail_id":"caa620655de6a253a462dece","boataround_slug":"seacat-open-40-tidewyn-discovery-2","start":"2026-12-12","end":"2026-12-19","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/caa620655de6a253a462dece","amount":"€13,500.33","amount_basis":"船东净价","client_amount":"€15,750.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"NOT PAID","verified_at":"2026-09-08T03:37:16.147Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"317743","detail_id":"60f986f556cfd78131f0c0b3","boataround_slug":"coastline-sea-journey-42-tidewyn-cruise-2","start":"2026-11-24","end":"2026-11-30","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/60f986f556cfd78131f0c0b3","amount":"€6,775.77","amount_basis":"船东净价","client_amount":"€7,971.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"NOT PAID","verified_at":"2026-09-08T03:37:19.231Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"317460","detail_id":"1d4dcb2af25a038311893a61","boataround_slug":"seacat-open-40-tidewyn-discovery-2","start":"2027-02-27","end":"2027-03-06","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/1d4dcb2af25a038311893a61","amount":"€16,506.00","amount_basis":"船东净价","client_amount":"€19,287.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"NOT PAID","verified_at":"2026-09-08T03:37:21.050Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"317442","detail_id":"91b1463cc7d580391f35778d","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2027-12-11","end":"2027-12-18","status":"pending","url":"https://partner.boataround.com/en/000000000000000000000000/orders/91b1463cc7d580391f35778d","amount":"€17,477.28","amount_basis":"船东净价","client_amount":"€6,800.00","platform_status":"CONFIRMED","customer_payment":"NOT PAID","agency_payment":"NOT PAID","verified_at":"2026-09-08T03:37:22.999Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"316463","detail_id":"c9f53cd893b94fb285b7917f","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2027-01-04","end":"2027-01-09","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/c9f53cd893b94fb285b7917f","amount":"€14,389.65","amount_basis":"船东净价","client_amount":"€16,929.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"NOT PAID","verified_at":"2026-09-08T03:37:26.244Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"316455","detail_id":"eeebc4f7d7d6cd6382faa7c0","boataround_slug":"wavecat-34-open-tidewyn-dream","start":"2027-01-23","end":"2027-01-30","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/eeebc4f7d7d6cd6382faa7c0","amount":"€9,180.00","amount_basis":"船东净价","client_amount":"€3,600.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"PARTIALLY PAID","verified_at":"2026-09-08T03:37:45.255Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"315492","detail_id":"311102cbe881b2b9a46c5929","boataround_slug":"harbor-cruiser-34-tidewyn-cruise","start":"2027-03-06","end":"2027-03-13","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/311102cbe881b2b9a46c5929","amount":"€7,995.00","amount_basis":"船东净价","client_amount":"€3,100.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"PARTIALLY PAID","verified_at":"2026-09-08T03:37:47.132Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"313464","detail_id":"1f5e5e5591350f950d50b325","boataround_slug":"seacat-open-40-tidewyn-discovery-2","start":"2026-11-21","end":"2026-11-28","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/1f5e5e5591350f950d50b325","amount":"€12,750.33","amount_basis":"船东净价","client_amount":"€5,000.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"NOT PAID","verified_at":"2026-09-08T03:37:50.152Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"310879","detail_id":"95a80bb41f8e468a03c29fef","boataround_slug":"seacat-open-40-tidewyn-discovery-2","start":"2026-11-14","end":"2026-11-21","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/95a80bb41f8e468a03c29fef","amount":"€13,500.33","amount_basis":"船东净价","client_amount":"€15,750.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"NOT PAID","verified_at":"2026-09-08T03:37:52.676Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"309387","detail_id":"4a2a879541fb54876c53cc27","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2026-12-05","end":"2026-12-12","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/4a2a879541fb54876c53cc27","amount":"€17,552.43","amount_basis":"船东净价","client_amount":"€6,500.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"NOT PAID","verified_at":"2026-09-08T03:37:54.644Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"308889","detail_id":"d7966378cd7bf65287aa26b0","boataround_slug":"coastline-sea-journey-42-tidewyn-cruise-2","start":"2026-12-05","end":"2026-12-12","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/d7966378cd7bf65287aa26b0","amount":"€8,370.06","amount_basis":"船东净价","client_amount":"€9,297.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"NOT PAID","verified_at":"2026-09-08T03:38:23.327Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"308285","detail_id":"6665d1adc641ece781860030","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2027-02-13","end":"2027-02-20","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/6665d1adc641ece781860030","amount":"€21,330.54","amount_basis":"船东净价","client_amount":"€7,900.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"NOT PAID","verified_at":"2026-09-08T03:38:25.366Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"303719","detail_id":"4f0da29648642f696520fd9e","boataround_slug":"seacat-open-40-tidewyn-discovery-2","start":"2026-12-26","end":"2027-01-02","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/4f0da29648642f696520fd9e","amount":"€18,444.87","amount_basis":"船东净价","client_amount":"€20,493.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"PARTIALLY PAID","verified_at":"2026-09-08T03:38:27.235Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"299413","detail_id":"f222b71f2889aec1bdb9c4ea","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2026-12-12","end":"2026-12-19","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/f222b71f2889aec1bdb9c4ea","amount":"€18,449.43","amount_basis":"船东净价","client_amount":"€20,472.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"PARTIALLY PAID","verified_at":"2026-09-08T03:38:29.219Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"286493","detail_id":"0ddd6309fdb26b25dd604b2a","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2026-11-14","end":"2026-11-21","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/0ddd6309fdb26b25dd604b2a","amount":"€17,552.43","amount_basis":"船东净价","client_amount":"€6,500.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"PARTIALLY PAID","verified_at":"2026-09-08T03:38:32.005Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"285474","detail_id":"15aff1dbd4085525414fea3a","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2026-10-24","end":"2026-10-31","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/15aff1dbd4085525414fea3a","amount":"€12,961.62","amount_basis":"船东净价","client_amount":"€4,800.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"PARTIALLY PAID","verified_at":"2026-09-08T03:38:45.342Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"278139","detail_id":"260f19951f6f29e6201abf9f","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2026-11-21","end":"2026-11-28","status":"deposit_paid","url":"https://partner.boataround.com/en/000000000000000000000000/orders/260f19951f6f29e6201abf9f","amount":"€15,430.50","amount_basis":"船东净价","client_amount":"€16,284.00","platform_status":"CONFIRMED","customer_payment":"PARTIALLY PAID","agency_payment":"PARTIALLY PAID","verified_at":"2026-09-08T03:38:47.395Z","verification_source":"已登录 Boataround 逐笔核验详情；付款判断使用 Customer payment；金额使用 Agency price"},{"booking_id":"316192","detail_id":"76672c46190ad4e15abe3e27","boataround_slug":"coastline-sea-journey-42-tidewyn-cruise-2","start":"2027-01-31","end":"2027-02-13","status":"cancelled","url":"https://partner.boataround.com/en/000000000000000000000000/orders/76672c46190ad4e15abe3e27","platform_status":"CANCELLED","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"已登录 Boataround 完整三页订单列表，明确显示 CANCELLED；不计入明细或占用"},{"booking_id":"312630","detail_id":"0ddf19fa46abb83662a7e756","boataround_slug":"harbor-cruiser-34-tidewyn-cruise","start":"2026-11-30","end":"2026-12-04","status":"cancelled","url":"https://partner.boataround.com/en/000000000000000000000000/orders/0ddf19fa46abb83662a7e756","platform_status":"CANCELLED","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"已登录 Boataround 完整三页订单列表，明确显示 CANCELLED；不计入明细或占用"},{"booking_id":"309851","detail_id":"4c36c36edc164b6e2427385d","boataround_slug":"seacat-open-40-tidewyn-discovery-2","start":"2026-11-14","end":"2026-11-21","status":"cancelled","url":"https://partner.boataround.com/en/000000000000000000000000/orders/4c36c36edc164b6e2427385d","platform_status":"CANCELLED","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"已登录 Boataround 完整三页订单列表，明确显示 CANCELLED；不计入明细或占用"},{"booking_id":"308901","detail_id":"1a719ea8d492d449959a7e9b","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2027-11-06","end":"2027-11-20","status":"cancelled","url":"https://partner.boataround.com/en/000000000000000000000000/orders/1a719ea8d492d449959a7e9b","platform_status":"CANCELLED","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"已登录 Boataround 完整三页订单列表，明确显示 CANCELLED；不计入明细或占用"},{"booking_id":"308112","detail_id":"9daf1d0b7362bec1f3536d33","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2026-11-29","end":"2026-12-05","status":"cancelled","url":"https://partner.boataround.com/en/000000000000000000000000/orders/9daf1d0b7362bec1f3536d33","platform_status":"CANCELLED","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"已登录 Boataround 完整三页订单列表，明确显示 CANCELLED；不计入明细或占用"},{"booking_id":"307322","detail_id":"4d5964e854dc4fe31ad27d24","boataround_slug":"seacat-open-40-tidewyn-discovery-2","start":"2026-11-14","end":"2026-12-05","status":"cancelled","url":"https://partner.boataround.com/en/000000000000000000000000/orders/4d5964e854dc4fe31ad27d24","platform_status":"CANCELLED","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"已登录 Boataround 完整三页订单列表，明确显示 CANCELLED；不计入明细或占用"},{"booking_id":"302428","detail_id":"d070accbd89bec16243d8bcb","boataround_slug":"harbor-cruiser-34-tidewyn-cruise","start":"2026-11-18","end":"2026-11-25","status":"cancelled","url":"https://partner.boataround.com/en/000000000000000000000000/orders/d070accbd89bec16243d8bcb","platform_status":"CANCELLED","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"已登录 Boataround 完整三页订单列表，明确显示 CANCELLED；不计入明细或占用"},{"booking_id":"298395","detail_id":"04c5f3851bfbed5b85330e2a","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2026-12-13","end":"2026-12-20","status":"cancelled","url":"https://partner.boataround.com/en/000000000000000000000000/orders/04c5f3851bfbed5b85330e2a","platform_status":"CANCELLED","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"已登录 Boataround 完整三页订单列表，明确显示 CANCELLED；不计入明细或占用"},{"booking_id":"293635","detail_id":"9e88bbcfba8ef6d01c5a2e57","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2026-11-07","end":"2026-11-14","status":"cancelled","url":"https://partner.boataround.com/en/000000000000000000000000/orders/9e88bbcfba8ef6d01c5a2e57","platform_status":"CANCELLED","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"已登录 Boataround 完整三页订单列表，明确显示 CANCELLED；不计入明细或占用"},{"booking_id":"293500","detail_id":"4262e5251446d10c90eea6cf","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2026-12-12","end":"2026-12-19","status":"cancelled","url":"https://partner.boataround.com/en/000000000000000000000000/orders/4262e5251446d10c90eea6cf","platform_status":"CANCELLED","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"已登录 Boataround 完整三页订单列表，明确显示 CANCELLED；不计入明细或占用"},{"booking_id":"292934","detail_id":"13c2fa44f1d13caf3222579d","boataround_slug":"harbor-cruiser-34-tidewyn-cruise","start":"2026-10-14","end":"2026-10-21","status":"cancelled","url":"https://partner.boataround.com/en/000000000000000000000000/orders/13c2fa44f1d13caf3222579d","platform_status":"CANCELLED","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"已登录 Boataround 完整三页订单列表，明确显示 CANCELLED；不计入明细或占用"},{"booking_id":"281534","detail_id":"8dfaadf3fcecb2bc240ebcb7","boataround_slug":"grandcat-55-tidewyn-discovery-5","start":"2026-12-14","end":"2026-12-21","status":"cancelled","url":"https://partner.boataround.com/en/000000000000000000000000/orders/8dfaadf3fcecb2bc240ebcb7","platform_status":"CANCELLED","verified_at":"2026-09-08T03:44:36.051Z","verification_source":"已登录 Boataround 完整三页订单列表，明确显示 CANCELLED；不计入明细或占用"}],"audit":{"verified_at":"2026-09-08T03:44:36.051Z","boataround":{"list_records":51,"list_pages":3,"future_confirmed_details_verified":18,"paid_active":17,"confirmed_unpaid_excluded":["317442"]},"clickandboat":{"current_future_active":7},"samboat":{"current_future_active":2,"user_confirmed_cancelled":["1000001"]}}};
function bookingStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[- ]/g, '_');
}
function normalizeBooking(source, record) {
  if (!['boataround', 'clickandboat', 'samboat'].includes(source)) throw new Error('订单来源无效');
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('订单记录必须为对象');
  const booking_id = String(record.booking_id || '');
  if (!/^[0-9]+$/.test(booking_id)) throw new Error('缺少有效订单编号');
  const status = bookingStatus(record.status);
  const allowedStatuses = source === 'boataround' ? ['paid', 'deposit_paid', 'completed', 'cancelled', 'canceled', 'refused', 'declined', 'pending'] : ['accepted', 'deposit_paid', 'completed', 'cancelled', 'canceled', 'refused', 'declined', 'pending'];
  if (!allowedStatuses.includes(status)) throw new Error(`订单 ${booking_id} 缺少明确状态`);
  if (!['accepted', 'deposit_paid', 'paid', 'completed'].includes(status)) return { source, booking_id, status };
  const { start, end, verified_at } = record;
  if (!validDay(start) || !validDay(end) || end <= start) throw new Error(`订单 ${booking_id} 日期无效`);
  if (typeof verified_at !== 'string' || !verified_at || !Number.isFinite(Date.parse(verified_at))) throw new Error(`订单 ${booking_id} 缺少有效核验时间`);
  const detail_id = source === 'boataround' && typeof record.detail_id === 'string' && /^[a-f0-9]{24}$/.test(record.detail_id) ? record.detail_id : null;
  let url = null, link_issue = '缺少订单详情链接';
  if (typeof record.url === 'string' && record.url) {
    try {
      const parsed = new URL(record.url);
      const host = source === 'boataround' ? 'partner.boataround.com' : source === 'clickandboat' ? 'www.clickandboat.com' : 'www.samboat.com';
      if (source === 'boataround' && !detail_id) throw new Error('invalid');
      const pathname = source === 'boataround' ? `/en/000000000000000000000000/orders/${detail_id}` : source === 'clickandboat' ? `/uk/booking/${booking_id}/detail` : `/private/reservation/${booking_id}`;
      if (parsed.protocol !== 'https:' || parsed.host !== host || parsed.pathname !== pathname || parsed.search || parsed.hash || parsed.username || parsed.password || record.url !== `https://${host}${pathname}`) throw new Error('invalid');
      url = record.url; link_issue = null;
    } catch { link_issue = '订单链接格式或订单编号不匹配，待核验'; }
  }
  const booking = { source, booking_id, start, end, url, link_issue, amount: typeof record.amount === 'string' && record.amount ? record.amount : null, amount_basis: typeof record.amount_basis === 'string' && record.amount_basis ? record.amount_basis : 'unspecified', status, verified_at };
  if (source === 'boataround') {
    booking.detail_id = detail_id;
    for (const field of ['customer_payment', 'platform_status', 'agency_payment', 'client_amount']) {
      if (typeof record[field] === 'string' && record[field]) booking[field] = record[field];
    }
  }
  return booking;
}
function applyBookingRegistry(data, mapping = BOOKING_MAP) {
  const prior = new Map(), entries = new Map(), seen = new Set(), warnings = [];
  let incomplete = !mapping || typeof mapping !== 'object' || Array.isArray(mapping);
  for (const boat of data.boats) {
    const records = new Map();
    for (const record of Array.isArray(boat.bookings) ? boat.bookings : []) {
      try {
        if (!['boataround', 'clickandboat', 'samboat'].includes(record?.source)) continue;
        const booking = normalizeBooking(record.source, record);
        if (['accepted', 'deposit_paid', 'paid', 'completed'].includes(booking.status)) records.set(`${booking.source}:${booking.booking_id}`, booking);
      } catch { /* Only verified cached records survive an incomplete registry. */ }
    }
    prior.set(boat.boataround_slug, records);
  }
  for (const source of ['boataround', 'clickandboat', 'samboat']) {
    if (!Array.isArray(mapping?.[source])) {
      incomplete = true;
      warnings.push(`${source} 订单映射缺失或格式无效，保留已有核验订单`);
      continue;
    }
    mapping[source].forEach((record, index) => {
      try {
        const booking = normalizeBooking(source, record);
        const key = source === 'boataround' ? record.boataround_slug ?? record.boat : record.boat ?? record.boataround_slug;
        const alias = String(key) === 'comet' ? 'reef-cat-37-tidewyn-discovery' : String(key);
        const idField = source === 'clickandboat' ? 'clickandboat_id' : 'samboat_id';
        const matches = data.boats.filter(boat => source === 'boataround' ? typeof key === 'string' && key === boat.boataround_slug : alias === boat.boataround_slug || boat[idField] != null && String(key) === String(boat[idField]));
        if (matches.length !== 1) throw new Error(`订单 ${booking.booking_id} 船只映射无法唯一识别`);
        const identity = `${source}:${booking.booking_id}`;
        if (seen.has(identity)) throw new Error(`订单 ${booking.booking_id} 编号重复`);
        seen.add(identity);
        const slug = matches[0].boataround_slug;
        if (!entries.has(slug)) entries.set(slug, new Map());
        entries.get(slug).set(identity, booking);
        if (booking.link_issue) warnings.push(`${source} 订单 ${booking.booking_id}：${booking.link_issue}`);
      } catch (error) {
        incomplete = true;
        warnings.push(`${source} 映射第 ${index + 1} 条无效：${error.message}`);
      }
    });
  }
  for (const boat of data.boats) {
    const confirmed = incomplete ? new Map(prior.get(boat.boataround_slug)) : new Map();
    for (const [identity, booking] of entries.get(boat.boataround_slug) || []) {
      if (['accepted', 'deposit_paid', 'paid', 'completed'].includes(booking.status)) confirmed.set(identity, booking);
      else confirmed.delete(identity);
    }
    boat.bookings = [...confirmed.values()].sort((a, b) => a.start.localeCompare(b.start) || a.source.localeCompare(b.source) || a.booking_id.localeCompare(b.booking_id));
    for (const info of Object.values(boat.sources)) {
      for (const block of info.blocks || []) { delete block.url; delete block.amount; delete block.booking_id; }
    }
  }
  const oldWarnings = new Set(data.booking_warnings || []);
  const otherWarnings = (data.warnings || []).filter(item => !oldWarnings.has(item));
  data.schema_version = 2;
  data.mapping_updated_at = mapping?.mapping_updated_at || mapping?.verified_at || mapping?.updated_at || null;
  data.booking_mapping_complete = !incomplete;
  data.booking_warnings = [...new Set(warnings)];
  data.warnings = [...new Set([...otherWarnings, ...warnings])];
  data.warning = data.warnings.join('；');
  return data;
}

var SOURCE_IDS = { boataround: "boataround_slug", clickandboat: "clickandboat_id", samboat: "samboat_id" };
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36";
var MAX_AGE = 20 * 60 * 60 * 1e3;
var headers = { ...SECURITY_HEADERS, "Content-Security-Policy": PAGE_CSP.dashboard };
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", ...extra } });
}
__name(json, "json");
async function upstreamJson(response) {
  const limit = 2 * 1024 * 1024;
  if (Number(response.headers.get("Content-Length")) > limit) {
    await response.body?.cancel();
    throw new Error("\u5E73\u53F0\u8FD4\u56DE\u7684\u6570\u636E\u8FC7\u5927\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("\u5E73\u53F0\u672A\u8FD4\u56DE\u6709\u6548\u8239\u671F\u6570\u636E");
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error("\u5E73\u53F0\u8FD4\u56DE\u7684\u6570\u636E\u8FC7\u5927\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("\u5E73\u53F0\u672A\u8FD4\u56DE\u6709\u6548\u8239\u671F\u6570\u636E");
  }
}
__name(upstreamJson, "upstreamJson");
function mergeSnapshot(data) {
  const usable = data && Array.isArray(data.boats);
  const result = structuredClone(usable ? data : SEED);
  const previousBoats = new Map(result.boats.map(boat => [boat.boataround_slug, boat]));
  result.boats = FLEET_SPECS.map(spec => {
    const prior = previousBoats.get(spec.boataround_slug) || {};
    const seedBoat = SEED.boats.find(boat => boat.boataround_slug === spec.boataround_slug);
    const boat = { ...prior, ...spec, sources: {} };
    for (const [source, idField] of Object.entries(SOURCE_IDS)) {
      if (!spec[idField]) continue;
      const existing = prior.sources?.[source];
      const info = structuredClone(existing || seedBoat?.sources?.[source] || { ok: false, blocks: [], error: '缺少平台船期，请刷新确认' });
      try { info.blocks = validateBlocks(info.blocks); }
      catch {
        info.blocks = structuredClone(seedBoat?.sources?.[source]?.blocks || []);
        info.ok = false; info.stale = true; info.refresh_error = '缓存船期格式无效，保留已核验快照';
      }
      if (!info.updated_at || !Number.isFinite(Date.parse(info.updated_at))) {
        info.stale = true;
        if (!info.refresh_error) info.note = '：上传的数据快照，请刷新确认';
      } else if (Date.now() - Date.parse(info.updated_at) > MAX_AGE) {
        info.stale = true;
        if (!info.refresh_error) info.note = '：缓存已超过 20 小时，请刷新确认';
      }
      if (info.ok !== true) info.stale = true;
      boat.sources[source] = info;
    }
    return boat;
  });
  if (!Array.isArray(result.warnings)) result.warnings = [];
  if (!usable) result.warnings.push('存储的数据格式无效，已使用上传快照，请刷新确认');
  return applyBookingRegistry(result);
}
__name(mergeSnapshot, "mergeSnapshot");
async function readData(env) {
  if (!env.BUCKET) throw new Error("\u8239\u671F\u7F13\u5B58\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
  const file = await env.BUCKET.get(CACHE_KEY);
  return mergeSnapshot(file ? await file.json() : SEED);
}
__name(readData, "readData");
function validDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = /* @__PURE__ */ new Date(value + "T00:00:00Z");
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}
__name(validDay, "validDay");
function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length > 1e4) throw new Error("\u5E73\u53F0\u8FD4\u56DE\u7684\u8239\u671F\u683C\u5F0F\u5DF2\u53D8\u5316");
  return blocks.map((block) => {
    if (!validDay(block.start) || !validDay(block.end) || block.end < block.start || Date.parse(block.end) - Date.parse(block.start) > 3660 * 864e5 || !["booked", "Booked", "Unavailable", "not_selectable"].includes(block.type)) {
      throw new Error("\u5E73\u53F0\u8FD4\u56DE\u7684\u8239\u671F\u683C\u5F0F\u5DF2\u53D8\u5316");
    }
    return { start: block.start, end: block.end, type: block.type };
  });
}
__name(validateBlocks, "validateBlocks");
async function fetchSource(source, boat, fetcher) {
  if (source === "samboat") return fetchSamBoat(boat.samboat_id, fetcher);
  const url = source === "boataround" ? "https://api.boataround.com/v1/availability/" + encodeURIComponent(boat.boataround_slug) : "https://www.clickandboat.com/libs/Api/API.php?rquest=ProduitDisponibilite";
  const options = { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(3e4) };
  if (source === "clickandboat") {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.headers.Origin = "https://www.clickandboat.com";
    options.headers.Referer = "https://www.clickandboat.com/";
    options.body = JSON.stringify({ __verb: "GET", ProduitId: boat.clickandboat_id, withNotSelectableDates: true });
  }
  const response = await fetcher(url, options);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("\u5E73\u53F0\u6682\u4E0D\u53EF\u8BBF\u95EE\uFF08HTTP " + response.status + "\uFF09");
  }
  const data = await upstreamJson(response);
  const list = source === "boataround" ? data?.data?.[0]?.availabilities : data?.Resultat?.list;
  if (!Array.isArray(list)) throw new Error("\u5E73\u53F0\u8FD4\u56DE\u7684\u8239\u671F\u683C\u5F0F\u5DF2\u53D8\u5316");
  return validateBlocks(list.map((item) => source === "boataround" ? { start: item.chin, end: item.chout, type: "booked" } : { start: item.startAt?.slice(0, 10), end: item.endAt?.slice(0, 10), type: item.type }));
}
__name(fetchSource, "fetchSource");
function setCookieValues(responseHeaders) {
  if (typeof responseHeaders.getSetCookie === "function") return responseHeaders.getSetCookie();
  if (typeof responseHeaders.getAll === "function") return responseHeaders.getAll("Set-Cookie");
  return (responseHeaders.get("Set-Cookie") || "").split(/,\s*(?=[^;,\s]+=)/).filter(Boolean);
}
__name(setCookieValues, "setCookieValues");
async function fetchSamBoat(id, fetcher) {
  const origin = "https://www.samboat.com";
  let pageUrl = new URL(`/boat-rental/phuket-city/catamaran/${encodeURIComponent(id)}`, origin);
  const apiUrl = new URL(`/announcements/${encodeURIComponent(id)}/unavailabilities`, origin);
  const jar = /* @__PURE__ */ new Map();
  const signal = AbortSignal.timeout(3e4);
  function rememberCookies(responseHeaders, responseUrl) {
    for (const value of setCookieValues(responseHeaders)) {
      const [pair, ...attributes] = value.split(";");
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\r\n]/.test(cookieValue)) continue;
      const attrs = Object.fromEntries(attributes.map((attribute) => {
        const i = attribute.indexOf("=");
        return [attribute.slice(0, i < 0 ? void 0 : i).trim().toLowerCase(), i < 0 ? "" : attribute.slice(i + 1).trim()];
      }));
      const domain = (attrs.domain || responseUrl.hostname).replace(/^\./, "").toLowerCase();
      if (domain !== "samboat.com" && domain !== "www.samboat.com") continue;
      const path = attrs.path?.startsWith("/") ? attrs.path : responseUrl.pathname.slice(0, responseUrl.pathname.lastIndexOf("/") + 1);
      const key = `${name};${domain};${path}`;
      if (attrs["max-age"] !== void 0 && Number(attrs["max-age"]) <= 0 || attrs["max-age"] === void 0 && attrs.expires && Date.parse(attrs.expires) <= Date.now()) jar.delete(key);
      else jar.set(key, { name, value: cookieValue, path, domain });
    }
  }
  __name(rememberCookies, "rememberCookies");
  function cookiesFor(url) {
    return [...jar.values()].filter(
      (cookie) => (url.hostname === cookie.domain || url.hostname.endsWith("." + cookie.domain)) && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path) && (cookie.path.endsWith("/") || url.pathname[cookie.path.length] === "/"))
    ).sort((a, b) => b.path.length - a.path.length);
  }
  __name(cookiesFor, "cookiesFor");
  let pageReady = false;
  for (let hop = 0; hop < 5; hop++) {
    const pageHeaders = { "User-Agent": USER_AGENT, Accept: "text/html" };
    const cookies2 = cookiesFor(pageUrl);
    if (cookies2.length) pageHeaders.Cookie = cookies2.map((c) => `${c.name}=${c.value}`).join("; ");
    const response2 = await fetcher(pageUrl.href, { headers: pageHeaders, redirect: "manual", signal });
    rememberCookies(response2.headers, pageUrl);
    await response2.body?.cancel();
    if ([301, 302, 303, 307, 308].includes(response2.status)) {
      const location = response2.headers.get("Location");
      if (!location) throw new Error("SamBoat \u8239\u9875\u8DF3\u8F6C\u5F02\u5E38");
      const next = new URL(location, pageUrl);
      if (next.origin !== origin || next.username || next.password) throw new Error("SamBoat \u8239\u9875\u8DF3\u8F6C\u5F02\u5E38");
      pageUrl = next;
      continue;
    }
    if (!response2.ok) throw new Error(`SamBoat \u8239\u9875\u6682\u4E0D\u53EF\u8BBF\u95EE\uFF08HTTP ${response2.status}\uFF09`);
    pageReady = true;
    break;
  }
  if (!pageReady) throw new Error("SamBoat \u8239\u9875\u8DF3\u8F6C\u6B21\u6570\u8FC7\u591A");
  const cookies = cookiesFor(apiUrl);
  const xsrf = cookies.find((cookie) => cookie.name === "XSRF-TOKEN");
  if (!xsrf) throw new Error("SamBoat \u672A\u8FD4\u56DE\u4F1A\u8BDD\u6821\u9A8C\u4FE1\u606F");
  let token;
  try {
    token = decodeURIComponent(xsrf.value);
  } catch {
    throw new Error("SamBoat \u4F1A\u8BDD\u6821\u9A8C\u4FE1\u606F\u65E0\u6548");
  }
  if (/[\r\n]/.test(token)) throw new Error("SamBoat \u4F1A\u8BDD\u6821\u9A8C\u4FE1\u606F\u65E0\u6548");
  const response = await fetcher(apiUrl.href, {
    method: "POST",
    body: "{}",
    redirect: "manual",
    signal,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": token,
      Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
      Origin: origin,
      Referer: pageUrl.href
    }
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`SamBoat \u8239\u671F\u6682\u4E0D\u53EF\u8BBF\u95EE\uFF08HTTP ${response.status}\uFF09`);
  }
  const data = await upstreamJson(response);
  if (!Array.isArray(data?.unavailabilities)) throw new Error("SamBoat \u8FD4\u56DE\u7684\u8239\u671F\u683C\u5F0F\u5DF2\u53D8\u5316");
  const blocks = [];
  const types = { reservation: "Booked", unavailability: "Unavailable", anticipation: "not_selectable" };
  for (const item of data.unavailabilities) {
    const start = typeof item?.start === "string" ? item.start.slice(0, 10) : "";
    const end = typeof item?.end === "string" ? item.end.slice(0, 10) : "";
    if (!validDay(start) || !validDay(end)) throw new Error("SamBoat \u8FD4\u56DE\u7684\u8239\u671F\u683C\u5F0F\u5DF2\u53D8\u5316");
    if (item.unavailability_type === "anticipation" && start === end) continue;
    blocks.push({ start, end, type: types[item.unavailability_type] || "Unavailable" });
  }
  return validateBlocks(blocks);
}
__name(fetchSamBoat, "fetchSamBoat");
async function refreshData(env, fetcher = fetch) {
  const data = await readData(env);
  const refreshedAt = new Date().toISOString();
  const jobs = [];
  let failed = 0;
  for (const boat of data.boats) {
    for (const [source, idField] of Object.entries(SOURCE_IDS)) {
      if (!boat[idField]) continue;
      jobs.push(async () => {
        try {
          boat.sources[source] = { ok: true, blocks: await fetchSource(source, boat, fetcher), updated_at: refreshedAt, last_success_at: refreshedAt, stale: false };
        } catch (error) {
          failed++;
          const previous = boat.sources[source] || {};
          const message = String(error?.message || error).slice(0, 200);
          boat.sources[source] = { ...previous, ok: false, blocks: Array.isArray(previous.blocks) ? previous.blocks : [], stale: true, error: message, refresh_error: message, last_success_at: previous.last_success_at || previous.updated_at || data.generated_at || null, note: '：刷新失败，保留旧缓存（' + message + '）' };
        }
      });
    }
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < jobs.length) await jobs[cursor++]();
  }));
  data.refresh_attempted_at = refreshedAt;
  if (failed < jobs.length) data.generated_at = refreshedAt;
  data.warnings = [...data.booking_warnings || []];
  if (failed) data.warnings.push(`${failed} 个平台船期未能刷新，已保留已有数据，请核验提示`);
  data.warning = data.warnings.join('；');
  await env.BUCKET.put(CACHE_KEY, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } });
  return data;
}
__name(refreshData, "refreshData");
var activeRefresh = null;
async function reserveRefresh(env) {
  const key = "fleet/refresh-reservation.json", now = Date.now(), duration = 18e4;
  const previous = await env.BUCKET.get(key);
  const state = previous ? await previous.json() : null;
  if (previous && (!state || !Number.isFinite(state.until) || state.until > now + duration + 6e4)) throw new Error("Invalid refresh reservation");
  if (state?.until > now) throw Object.assign(new Error("\u6570\u636E\u6B63\u5728\u5237\u65B0\u6216\u521A\u521A\u5DF2\u5237\u65B0\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002"), { status: 429, retryAfter: Math.ceil((state.until - now) / 1e3) });
  const reservation = await env.BUCKET.put(key, JSON.stringify({ until: now + duration }), { onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ "If-None-Match": "*" }), httpMetadata: { contentType: "application/json" } });
  if (reservation === null) throw Object.assign(new Error("\u6570\u636E\u6B63\u5728\u5237\u65B0\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002"), { status: 429, retryAfter: 180 });
}
__name(reserveRefresh, "reserveRefresh");
var server_default = {
  async fetch(request, env) {
    const gate = await authGate(request, env);
    if (gate) return gate;
    const url = new URL(request.url);
    if (url.pathname === "/api/refresh" && request.method !== "POST") return json({ error: "\u8BF7\u4F7F\u7528\u5237\u65B0\u6309\u94AE\u63D0\u4EA4\u8BF7\u6C42" }, 405, { Allow: "POST" });
    if (!["GET", "HEAD"].includes(request.method) && !(request.method === "POST" && url.pathname === "/api/refresh")) return json({ error: "\u4E0D\u652F\u6301\u7684\u8BF7\u6C42\u65B9\u5F0F" }, 405);
    if (["/", "/index.html", "/dashboard-live.html"].includes(url.pathname)) {
      return new Response(request.method === "HEAD" ? null : HTML, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
    if (!["/api/data", "/api/refresh"].includes(url.pathname)) return json({ error: "\u9875\u9762\u4E0D\u5B58\u5728" }, 404);
    if (request.method === "HEAD") return new Response(null, { headers });
    if (url.pathname === "/api/refresh") {
      const origin = request.headers.get("Origin");
      const fetchSite = request.headers.get("Sec-Fetch-Site");
      if (request.method === "POST" && origin !== url.origin || origin && origin !== url.origin || ["cross-site", "same-site"].includes(fetchSite)) return json({ error: "\u8BF7\u4ECE\u770B\u677F\u5185\u5237\u65B0" }, 403);
    }
    try {
      if (url.pathname === "/api/data") return json(await readData(env));
      if (!activeRefresh) activeRefresh = (async () => {
        await reserveRefresh(env);
        return refreshData(env);
      })().finally(() => {
        activeRefresh = null;
      });
      return json(await activeRefresh);
    } catch (error) {
      if (error.status === 429) return json({ error: error.message }, 429, { "Retry-After": String(error.retryAfter) });
      console.error("Fleet data operation failed:", error.message);
      return json({ error: "\u8239\u671F\u8BFB\u53D6\u6216\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\uFF1B\u5DF2\u6709\u6570\u636E\u4ECD\u4FDD\u7559" }, 503);
    }
  }
};

// worker/durable-storage.js
var MAX_VALUE_BYTES = 1024 * 1024;
function durableBucket(storage) {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS fleet_objects (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, etag TEXT NOT NULL, expires_at INTEGER
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS fleet_expiry ON fleet_objects(expires_at)");
  function checkKey(key) {
    if (typeof key !== "string" || !key || key.length > 256) throw new Error("Invalid storage key");
  }
  __name(checkKey, "checkKey");
  return {
    async get(key) {
      checkKey(key);
      const row = sql.exec("SELECT value, etag FROM fleet_objects WHERE key = ?", key).toArray()[0];
      return row ? { etag: row.etag, json: /* @__PURE__ */ __name(async () => JSON.parse(row.value), "json") } : null;
    },
    async put(key, value, options = {}) {
      checkKey(key);
      if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES) {
        throw new Error("Stored data exceeds the application limit");
      }
      const parsed = JSON.parse(value);
      const session = key.startsWith("auth/sessions/");
      const expiresAt = session ? parsed?.expiresAt : null;
      if (session && (!Number.isFinite(expiresAt) || expiresAt <= 0)) throw new Error("Invalid session expiry");
      const condition = options.onlyIf;
      const createOnly = condition instanceof Headers && condition.get("If-None-Match") === "*";
      const match = !(condition instanceof Headers) && condition?.etagMatches;
      if (condition && !createOnly && (typeof match !== "string" || !match)) throw new Error("Unsupported storage condition");
      const etag = crypto.randomUUID();
      return storage.transactionSync(() => {
        let result;
        if (createOnly) {
          result = sql.exec("INSERT INTO fleet_objects (key, value, etag, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING RETURNING etag", key, value, etag, expiresAt);
        } else if (match) {
          result = sql.exec("UPDATE fleet_objects SET value = ?, etag = ?, expires_at = ? WHERE key = ? AND etag = ? RETURNING etag", value, etag, expiresAt, key, match);
        } else {
          result = sql.exec("INSERT INTO fleet_objects (key, value, etag, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, etag = excluded.etag, expires_at = excluded.expires_at RETURNING etag", key, value, etag, expiresAt);
        }
        const row = result.toArray()[0];
        if (!row) return null;
        if (session) sql.exec("DELETE FROM fleet_objects WHERE key IN (SELECT key FROM fleet_objects WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)", Date.now());
        return { etag: row.etag };
      });
    },
    async delete(key) {
      checkKey(key);
      sql.exec("DELETE FROM fleet_objects WHERE key = ?", key);
    }
  };
}
__name(durableBucket, "durableBucket");

// worker/cloudflare.js
function unavailable() {
  return new Response("\u7F51\u7AD9\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=31536000",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
}
__name(unavailable, "unavailable");
var FleetDashboard = class extends DurableObject {
  static {
    __name(this, "FleetDashboard");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.appEnv = { FLEET_AUTH_CONFIG: env.FLEET_AUTH_CONFIG, BUCKET: durableBucket(ctx.storage) };
  }
  async fetch(request) {
    try {
      return await server_default.fetch(request, this.appEnv);
    } catch {
      return unavailable();
    }
  }
};
var cloudflare_default = {
  async fetch(request, env) {
    try {
      return await env.FLEET_APP.getByName("tidewyn-fleet").fetch(request);
    } catch {
      return unavailable();
    }
  }
};
export {
  FleetDashboard,
  cloudflare_default as default
};
//# sourceMappingURL=cloudflare.js.map
