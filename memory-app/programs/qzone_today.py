"""Bounded local evidence for today's public diary decision. Never publishes."""
import datetime,json,pathlib,re
import memory_v2 as m
zone=datetime.timezone(datetime.timedelta(hours=8))
def collect(now=None):
    current=now or datetime.datetime.now(zone);day=current.astimezone(zone).date().isoformat()
    start=datetime.datetime.combine(current.astimezone(zone).date(),datetime.time(),zone).astimezone(datetime.timezone.utc)
    c=m.connect('anan',False)
    try:
        c.create_function('memory_epoch',1,lambda value:(m.normalized_time(value).timestamp() if m.normalized_time(value) else 0))
        rows=c.execute("SELECT id,source,kind,role,timestamp,body FROM messages WHERE kind!='attempt' AND memory_epoch(timestamp)>=? AND memory_epoch(timestamp)<? ORDER BY memory_epoch(timestamp) DESC,id DESC LIMIT 120",(start.timestamp(),start.timestamp()+86400)).fetchall()
        out=[];seen=set()
        for row in rows:
            source=str(row['source']).replace('\\','/');body=row['body']
            if row['role'] not in ('assistant','document') or re.search(r'identity|preferences|projects|README|人家是谁|本事',source,re.I):continue
            if row['role']=='document' and day not in source and day not in body:continue
            if re.search(r'【QQ主人明确委托|【直播自主话题】|【当前交流场景】',body[:180]):continue
            if len(body.strip())<25:continue
            key=body[:120]
            if key in seen:continue
            seen.add(key);out.append({'id':row['id'],'recordedAt':row['timestamp'],'kind':row['kind'],'excerpt':body[:360]})
            if len(out)>=6:break
        return {'day':day,'candidates':out,'warning':'记录时间不是事件发生时间；只有确认属于当天且新鲜的自身经历才可选，不能编造或公开私人细节。'}
    finally:c.close()
if __name__=='__main__':print(json.dumps(collect(),ensure_ascii=False))
