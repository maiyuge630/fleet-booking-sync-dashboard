'use strict';
// 手账风看板（用户 2026-10-13 选方向 C）：纸面配色、胶带、手写标题，老鼠吉祥物
// 和“立即同步”放在标题旁，只显示看板已有的状态。外观在 notebook-theme.css，
// 老鼠的状态在 notebook-theme-ui.js；图片是 ui-assets/ 里的两张 WebP。
// 只改外观和摆放位置，不改数据、日期规则和检测条件。之后由 copy-style-patch.cjs
// 统一文案并重算脚本哈希。
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {extractHTML}=require('../cloudflare-migration/frontend-patch.cjs');
const ASSETS={idle:'ui-assets/mascot-idle.webp',busy:'ui-assets/mascot-busy.webp'};
function dataURI(file){
 const bytes=fs.readFileSync(path.join(__dirname,file));
 if(bytes.toString('latin1',0,4)!=='RIFF'||bytes.toString('latin1',8,12)!=='WEBP'||bytes.length>24000)throw Error('Mascot asset must be a small WebP: '+file);
 return 'data:image/webp;base64,'+bytes.toString('base64');
}
function minifyCSS(css){return css.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\s*\n\s*/g,'').replace(/\s*([{};,])\s*/g,'$1').replace(/;}/g,'}').trim();}
const SYNC_BUTTON='<button id="refreshBtn" class="secondary" type="button">立即同步</button>';
const stationHTML='<div class="mascot-station" id="mascot-station" data-pose="idle" data-tone="quiet"><img class="mascot-image" id="mascot-image" alt="" width="96" height="96"><div class="mascot-bubble"><div class="mascot-copy"><strong class="mascot-title" id="mascot-title">正在读取订单…</strong><span class="mascot-detail" id="mascot-detail" hidden></span><ul class="mascot-items" id="mascot-items" aria-label="需要查看的事项" hidden></ul></div>'+SYNC_BUTTON+'</div></div>';
function patchNotebookTheme(source){
 const html=extractHTML(source),oldScript=html.match(/<script>([\s\S]*?)<\/script>/)[1],oldStyle=html.match(/<style>([\s\S]*?)<\/style>/)[1];
 if(oldScript.includes('function renderMascot('))throw Error('Notebook theme already applied');
 let next=html;
 const change=(a,b)=>{if(next.split(a).length!==2)throw Error('Notebook theme anchor changed: '+a);next=next.replace(a,()=>b);};
 // The sync button moves out of the query form to sit with the mascot.
 change('<button id="queryBtn" type="submit" disabled>查询档期</button>'+SYNC_BUTTON,'<button id="queryBtn" type="submit" disabled>查询档期</button>');
 change('<form class="logout-form"',stationHTML+'<form class="logout-form"');
 // The fleet size comes from the data (8 boats since 2026-10-10), not a fixed 7.
 change('<p>7艘船 · 可查看未来15个月</p>','<p id="fleet-size">可查看未来15个月</p>');
 change('<p>Boataround · Click&amp;Boat · SamBoat</p>','<p>Boataround · Click&amp;Boat · SamBoat · MMK · NauSYS</p>');
 const ui=fs.readFileSync(path.join(__dirname,'notebook-theme-ui.js'),'utf8').replace("'__MASCOT_IDLE__'",()=>JSON.stringify(dataURI(ASSETS.idle))).replace("'__MASCOT_BUSY__'",()=>JSON.stringify(dataURI(ASSETS.busy)));
 if(ui.includes('__MASCOT_'))throw Error('Mascot image placeholder left');
 if(oldScript.split('\ninitialize();').length!==2)throw Error('Notebook theme script anchor changed');
 const script=oldScript.replace('\ninitialize();',()=>'\n'+ui+'\ninitialize();'),style=oldStyle+minifyCSS(fs.readFileSync(path.join(__dirname,'notebook-theme.css'),'utf8'));
 next=next.replace(oldScript,()=>script).replace(oldStyle,()=>style);
 const start=source.indexOf('var HTML = '),end=source.indexOf('var LOGIN_HTML = ',start);if(start<0||end<0)throw Error('Notebook theme HTML anchor changed');
 let result=source.slice(0,start)+'var HTML = '+JSON.stringify(next)+';\n'+source.slice(end);
 const csp=/("dashboard":\s*"default-src 'none'; script-src 'sha256-)[^']+('; style-src 'sha256-)[^']+(';)/;
 if(result.match(new RegExp(csp.source,'g'))?.length!==1)throw Error('Notebook theme CSP anchor missing');
 result=result.replace(csp,(_,a,b,c)=>a+createHash('sha256').update(script).digest('base64')+b+createHash('sha256').update(style).digest('base64')+c);
 // The mascot images are inline WebP data, so the dashboard page (only) allows data: images.
 const img=/("dashboard":\s*"[^"]*?img-src 'self')(;)/;
 if(result.match(new RegExp(img.source,'g'))?.length!==1)throw Error('Notebook theme img-src anchor missing');
 return result.replace(img,"$1 data:$2");
}
module.exports={patchNotebookTheme,minifyCSS,stationHTML};
