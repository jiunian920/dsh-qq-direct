"""Bounded complete recall with relevant recent evidence, not a dump of the library."""
import datetime,re
TOPICS=('直播','弹幕','开播','游戏','minecraft','建造','挖矿','群聊','私聊')
def candidates(m,q):
    hits=m.search('anan',q,20)
    topics=[w for w in TOPICS if w in q.lower()]
    if re.search(r'\bmc\b',q,re.I):topics+=['minecraft','游戏']
    temporal=bool(re.search(r'今天|昨天|昨晚|刚刚|最近|新记录|新记忆|新.{0,4}(模块|部分|资料|记录)',q))
    if not topics and not temporal:return hits
    c=m.connect('anan',False)
    try:
        after=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=7)).timestamp()
        c.create_function('memory_epoch',1,lambda value:(m.normalized_time(value).timestamp() if m.normalized_time(value) else 0))
        sql="SELECT id,session,timestamp,role,kind,source,body FROM messages WHERE kind!='attempt' AND memory_epoch(timestamp)>=?"
        params=[after]
        if topics:
            sql+=' AND ('+' OR '.join('lower(body) LIKE ?' for _ in topics)+')';params+=['%'+w+'%' for w in topics]
        rows=c.execute(sql+' ORDER BY memory_epoch(timestamp) DESC,id DESC LIMIT 40',params).fetchall()
        extras=[]
        for row in rows:
            body=row['body'];lower=body.lower();matched=[w for w in topics if w in lower]
            if topics and not matched:continue
            at=min((lower.find(w) for w in matched),default=0)
            extras.append({key:row[key] for key in ('id','session','timestamp','role','kind','source') }|{'preview':body[max(0,at-80):max(0,at-80)+500],'score':0,'recentEvidence':True})
        # Reserve at most two relevant evidence slots. Older identity/pinned records
        # still participate through the original hybrid search for every query.
        extras.sort(key=lambda h:(sum(w in h['source'].lower().replace('\\','/').split('/')[-1] for w in topics),h['kind']=='summary',(m.normalized_time(h['timestamp']).timestamp() if m.normalized_time(h['timestamp']) else 0)),reverse=True)
        unique=[];seen_sources=set()
        for hit in extras:
            if hit['source'] in seen_sources:continue
            seen_sources.add(hit['source']);unique.append(hit)
            if len(unique)==2:break
        ids={x['id'] for x in unique}
        return unique+[hit for hit in hits if hit['id'] not in ids]
    finally:c.close()
