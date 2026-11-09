import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
export const dayKey=t=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
export const nextDay=t=>Date.parse(dayKey(t)+'T00:00:00+08:00')+86400000;
const persist=(file,value)=>{const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,file);};
export async function todayEvidence(){
  const script=process.env.QQ_QZONE_EVIDENCE || fileURLToPath(new URL('../../memory-app/programs/qzone_today.py',import.meta.url));
  const {stdout}=await run(process.env.QQ_PYTHON||'python',['-X','utf8',script],{windowsHide:true,timeout:10000,maxBuffer:65536});return JSON.parse(stdout);
}
export class QzonePolicy{
  constructor(root,{now=Date.now,random=Math.random,evidence=todayEvidence}={}){this.file=path.join(root,'state/qzone-plan.json');this.now=now;this.random=random;this.evidence=evidence;this.busy=false;}
  load(){if(!fs.existsSync(this.file))return null;return JSON.parse(fs.readFileSync(this.file,'utf8'));}
  async opportunity(key,cfg,deliver){
    if(this.busy||cfg.socialV2?.selfAccount?.qzone===false||cfg.socialV2?.selfAccount?.enabled===false)return '';
    this.busy=true;
    try{
      const now=this.now(),day=dayKey(now);let plan=this.load();
      const accountFile=path.join(path.dirname(this.file),'self-account.json');
      if(!fs.existsSync(accountFile))return '';
      const account=JSON.parse(fs.readFileSync(accountFile,'utf8'));
      if(!account.expectedSelfId||account.qzonePending||account.pending?.operation==='qzone'||(account.last?.qzone&&dayKey(account.last.qzone)===day))return '';
      if(!plan||plan.day!==day){
        const at=Date.parse(day+'T10:00:00+08:00')+Math.floor(this.random()*12*60*60*1000);
        plan={day,at,chosen:this.random()<.65,prompted:false};persist(this.file,plan);
      }
      if(!plan.chosen||plan.prompted||now<plan.at||now>=Date.parse(day+'T23:00:00+08:00')||now<(plan.nextEvidenceCheck||0))return '';
      const evidence=await this.evidence();
      if(evidence.day!==day||!evidence.candidates?.length){plan.nextEvidenceCheck=now+5*60000;persist(this.file,plan);return '';}
      const ready={...plan,prompted:true,key,opportunityId:crypto.randomUUID(),expiresAt:Math.min(nextDay(now),now+30*60000),evidenceIds:evidence.candidates.map(x=>x.id)};
      const hint='\n【随机动态机会】上海日期='+day+'。一天最多发一条，只有当天确有适合与好友分享的自身经历，才用 qq_publish_self_qzone。写自己的经历，按公开范围判断要省略的细节。没素材可以安静结束。opportunityId='+ready.opportunityId+'；evidenceIds 选下列实际编号。\n'+JSON.stringify(evidence)+'\n';
      persist(this.file,ready);
      try {
        if(deliver&&!deliver({id:ready.opportunityId,expiresAt:ready.expiresAt,hint}))persist(this.file,plan);
      } catch(error) { persist(this.file,plan);throw error; }
      return hint;
    }finally{this.busy=false;}
  }
  authorize(key,input){
    const plan=this.load(),now=this.now();
    if(!plan||plan.day!==dayKey(now)||plan.key!==key||!plan.prompted||plan.opportunityId!==input.opportunityId||now>plan.expiresAt||plan.consumed)throw new Error('动态没有当前有效随机机会，不要重试或补发');
    const ids=input.evidenceIds;
    if(!Array.isArray(ids)||!ids.length||ids.some(id=>!Number.isSafeInteger(id)||!plan.evidenceIds.includes(id)))throw new Error('动态缺少当天真实记忆依据');
    plan.consumed=true;persist(this.file,plan);return {day:plan.day,evidenceIds:ids};
  }
}
