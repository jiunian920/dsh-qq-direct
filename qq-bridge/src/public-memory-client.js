import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
const PYTHON = process.env.QQ_PYTHON || 'python';
const SCRIPT = process.env.QQ_PUBLIC_MEMORY_SCRIPT || fileURLToPath(new URL('../../memory-app/programs/public_memory.py', import.meta.url));
export const PUBLIC_MEMORY_CORE = '【共享记忆】按当前话题查记忆。发言时按听众判断哪些内容可公开，省略私聊和他人个人细节。';
let child = null, ready = false, nextId = 1, failedAt = 0;
const pending = new Map(), cache = new Map();
function ensureProcess() {
  if (child || Date.now()-failedAt < 15000) return;
  child = spawn(PYTHON, ['-X','utf8',SCRIPT,'serve'], { windowsHide:true, stdio:['pipe','pipe','ignore'] });
  // An idle memory worker must not prevent Host graceful shutdown. Active
  // queries retain their own readiness/request timers; exit cleanup kills it.
  child.unref();
  child.stdin.unref?.();
  child.stdout.unref?.();
  const rl=readline.createInterface({input:child.stdout});
  rl.on('line',line=>{try {const r=JSON.parse(line);if(r.ready){ready=true;return;}const p=pending.get(r.id);if(p){clearTimeout(p.timer);pending.delete(r.id);p.resolve(r.ok?r:null);}}catch{}});
  const finish=()=>{ready=false;child=null;failedAt=Date.now();for(const p of pending.values()){clearTimeout(p.timer);p.resolve(null);}pending.clear();};
  child.on('error',finish);child.on('exit',finish);child.stdin.on('error',()=>{});
}
export async function publicMemoryQuery(query,key=null,recent=[],options={}) {
  if (process.env.QQ_PUBLIC_MEMORY_ENABLED !== '1') return null;
  ensureProcess();
  if(key!==null&&!/^(?:group|private):\d+$/.test(key)) return Promise.resolve(null);
  const text=String(query||'岸岸的身份和成长').slice(-200);
  const last=recent.at(-1);const cacheKey=JSON.stringify([key,text,last?.seq,last?.messageId,options.recordId,options.offset]);
  const hit=cache.get(cacheKey);if(hit&&Date.now()-hit.time<5000)return hit.result;
  const deadline=Date.now()+8000;
  while(child&&!ready&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,80));
  if(!ready)return {text:'【记忆检索服务尚未就绪，不能据此判断没有记忆；稍后再查。】',hits:0,incomplete:true};
  return new Promise(resolve=>{
    const id=nextId++;const timer=setTimeout(()=>{pending.delete(id);resolve({text:'【本地记忆检索超时，不代表没有相关记忆。】',hits:0,incomplete:true});},12000);
    pending.set(id,{timer,resolve:r=>{if(r){cache.set(cacheKey,{time:Date.now(),result:r});if(cache.size>100)cache.delete(cache.keys().next().value);}resolve(r);}});
    try {child.stdin.write(JSON.stringify({id,query:text,key,recent,recordId:options.recordId,offset:options.offset})+'\n');}catch{clearTimeout(timer);pending.delete(id);resolve(null);}
  });
}
process.once('exit',()=>{try{child?.kill();}catch{}});
