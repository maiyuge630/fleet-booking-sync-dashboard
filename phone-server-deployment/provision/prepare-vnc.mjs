// Creates protected VNC and X11 authentication files; never prints credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {loadConfiguration} from '../phone-server/core.mjs';
if(process.getuid?.()===0)throw Error('Do not run the browser environment as root');
const home=process.env.HOME;
if(home!=='/data/data/com.termux/files/home')throw Error('Unexpected Termux home');
const state=path.join(home,'.local/share/tidewyn-phone');
const config=await loadConfiguration(state);
if(!/^[A-Za-z0-9_-]{8}$/.test(config.vnc_password||''))throw Error('VNC password not prepared by the server');
const result=spawnSync('/data/data/com.termux/files/usr/bin/vncpasswd',['-f'],{input:Buffer.from(config.vnc_password+'\n'),timeout:15000,maxBuffer:65536});
if(result.status!==0||result.stdout.length<8||result.stdout.length>16)throw Error('VNC password encoding failed');
await fs.mkdir(path.join(home,'.vnc'),{recursive:true,mode:0o700});
await fs.chmod(path.join(home,'.vnc'),0o700);
await fs.writeFile(path.join(home,'.vnc/fleet.passwd'),result.stdout,{mode:0o600});
await fs.chmod(path.join(home,'.vnc/fleet.passwd'),0o600);
// RFB/VNC authentication does not authorize X11 clients. Keep a separate
// MIT-MAGIC-COOKIE-1 file for Xvnc, Openbox and Chromium, all under this app UID.
const authority=path.join(state,'Xauthority');
let existing;
try{existing=await fs.lstat(authority);}catch(error){if(error.code!=='ENOENT')throw error;}
if(existing){
  if(!existing.isFile()||existing.size===0)throw Error('Existing X11 authority file is invalid');
  await fs.chmod(authority,0o600);
}else{
  const temporary=authority+'.'+randomUUID()+'.tmp';
  const handle=await fs.open(temporary,'wx',0o600);await handle.close();
  try{
    const cookie=randomBytes(16).toString('hex');
    const encoded=spawnSync('/data/data/com.termux/files/usr/bin/xauth',['-f',temporary,'source','-'],
      {input:Buffer.from('add :1 MIT-MAGIC-COOKIE-1 '+cookie+'\n'),timeout:15000,maxBuffer:65536});
    if(encoded.status!==0||(await fs.stat(temporary)).size===0)throw Error('X11 authentication preparation failed');
    await fs.chmod(temporary,0o600);await fs.rename(temporary,authority);
  }finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
console.log('Local VNC and X11 authentication prepared; no credentials displayed.');
