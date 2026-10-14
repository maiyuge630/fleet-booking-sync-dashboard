import {collectBoataround} from './collectors/boataround.mjs';
import {collectClickAndBoat} from './collectors/clickandboat.mjs';
import {collectSamBoat} from './collectors/samboat.mjs';
export {collectBoataround, collectClickAndBoat, collectSamBoat};

// The MMK collector (since 2026-10-04) is registered by the phone server only:
// this module is also bundled into the Cloudflare Worker, which cannot load
// the Node modules the MMK reader uses.
export const PLATFORM_URLS = Object.freeze({
 boataround:'https://partner.boataround.com/en/000000000000000000000000/orders',
 clickandboat:'https://www.clickandboat.com/uk/account/bookings',
 samboat:'https://www.samboat.com/private/reservations',
 mmk:'https://portal.booking-manager.com/wbm2/app/my_bookings/editor.jsp',
 // NauSYS (since 2026-10-09) is also read by the phone server only.
 nausys:'https://app.nausys.com/NauSYS-app/app/yachtReservations.xhtml'
});
const AUTH_CHECKS={
 boataround:()=>location.hostname==='partner.boataround.com'&&location.pathname.startsWith('/en/000000000000000000000000/')&&document.body.innerText.includes('Tidewyn Marine')&&Array.from(document.querySelectorAll('a')).some(a=>a.pathname==='/en/000000000000000000000000/orders'),
 clickandboat:()=>location.hostname==='www.clickandboat.com'&&document.body.innerText.includes('All your bookings')&&Array.from(document.querySelectorAll('h1')).some(e=>e.innerText.trim()==='Demo Owner')&&Array.from(document.querySelectorAll('button')).some(b=>b.innerText.trim()==='History'),
 samboat:()=>location.hostname==='www.samboat.com'&&!!document.querySelector('[role="tablist"] [href="#confirmed"]')&&Array.from(document.querySelectorAll('a')).some(a=>a.pathname==='/private/reservations/new-messages/mark-as-read'&&new URL(a.href).searchParams.get('to_user_id')==='700000'),
 // The account itself (service 0000, charter company) is checked by the collector.
 mmk:()=>location.origin==='https://portal.booking-manager.com'&&location.pathname.startsWith('/wbm2/app/my_bookings/')&&typeof ReservationsAPI!=='undefined'&&typeof ReservationsAPI?.getData==='function',
 // The signed-in user (demo-user@AGENCY shows as DEMO, USER) is checked by the collector.
 nausys:()=>location.origin==='https://app.nausys.com'&&location.pathname==='/NauSYS-app/app/yachtReservations.xhtml'&&!!document.getElementById('searchCriteriaForm')
};
export const verifyAuth=Object.fromEntries(Object.entries(AUTH_CHECKS).map(([source,predicate])=>[source,async page=>{
 // Android can suspend animation frames while the phone screen is off.
 // Timed polling still observes delayed login content in a running renderer.
 try{await page.waitForFunction(predicate,{timeout:15000,polling:250});return true;}catch{return false;}
}]));
export const collectors={boataround:collectBoataround,clickandboat:collectClickAndBoat,samboat:collectSamBoat};
