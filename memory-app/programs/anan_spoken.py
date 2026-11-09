"""岸岸的群聊发言导入器  [岸岸自加 2026-10-10｜15:4x 按璃璃审查修 P1]

为什么需要它：
  二代模式下 agent 的 assistant/message 正文只是「内心话」，真正发到 QQ 群里的话
  全在 tool/call 的 arguments.messages 里。memory_store.py 的 sync() 只导
  user/message 与 assistant/message，于是「岸岸在群里说过的话」一条都没进库。

⭐ 2026-10-10 修 P1（璃璃审查指出，已实测确认）：
  **tool/call 只证明"尝试"，不证明"发送成功"。** 必须关联 tool/result 才能定性：
    · ok 不是 false 且 failed 不是正数 → kind='spoken'（真的说出口了）
    · ok:false / failed>0 / 报错文本    → kind='attempt'（想说，但没发出去）
    · 没有结果                          → kind='attempt'（不能当说过）
  ⚠️ 判据来自真实结构：成功是 {"ok":true,"sent":1,"failed":0}，
     失败时 content 里的 text 是 "Error: 发送失败：…"（根本不是 JSON）。
  ⚠️ 结果挂在 data.message.source.callId；调用挂在 data.callId（两者都是顶层）。
  ⚠️ 为什么不能只看"有没有结果"：那 17 次失败的调用**是有结果的**，
     只是结果里写着失败 —— 上一版就是这么把 22 句没发出去的话记成说过了。

它不做什么：
  · 不修改 memory_store.py 一行（只 import 它的 connect/add，共用脱敏/FTS/digest 逻辑）
  · 不导入群友的话（留隔离库）；不导入黑话 agent 会话（那是工具，不是岸岸）
  · 不删除任何东西；重复跑幂等（UNIQUE(source,session,locator) 挡着）

用法：
  python anan_spoken.py --dry-run   # 只统计，不写库
  python anan_spoken.py             # 导入（成功→spoken，失败/未知→attempt）
  python anan_spoken.py --fix       # 把库里"来自失败调用的 spoken"改判为 attempt
"""
import argparse
import json
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import _py312guard  # noqa: E402,F401  解释器守卫：不是 3.12 会自动换解释器重跑（2026-10-25 加）
import memory_store as ms  # noqa: E402  只读地用它的 connect/add

ROOT = HERE.parent
SEND_TOOLS = {
    'mcp__snowluma__qq_send_message',
    'mcp__snowluma__qq_reply',
    'mcp__snowluma__qq_send_burst',
    'mcp__snowluma__qq_send_group_message',
    'mcp__snowluma__qq_send_private_message',
}
STICKER_TOOLS = {'mcp__snowluma__qq_send_sticker'}


def iter_sessions():
    directory = os.environ.get('QQ_IMPORT_DSH_SESSIONS')
    if not directory:
        return
    dsh = pathlib.Path(directory)
    for name in os.environ.get('QQ_IMPORT_QQ_WORKSPACES', '').split(os.pathsep):
        if not name or pathlib.Path(name).name != name:
            continue
        base = dsh / name
        if base.exists():
            for path in sorted(base.rglob('session.v*.jsonl.zstd')):
                yield path


def bubbles_from(args):
    """从工具参数里取出真正要发的气泡（数组或字符串都算）。"""
    if not isinstance(args, dict):
        return []
    raw = args.get('messages', args.get('message'))
    if raw is None:
        return []
    if isinstance(raw, str) and raw.strip().startswith(('[', '"')):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, (str, list)):
                raw = parsed
        except json.JSONDecodeError:
            pass
    items = raw if isinstance(raw, list) else [raw]
    return [str(x) for x in items if str(x).strip()]


def scan_details(path):
    """→ (session, [(locator, name, text, status)])，status ∈ spoken/attempt"""
    session = path.stem
    calls = []
    results = {}
    for line_num, ev in ms.json_records(path, compressed=True):
        t = ev.get('type')
        if t == 'session':
            session = str(ev.get('id', session))
        elif t == 'tool/call':
            d = ev.get('data', {})
            name = d.get('name')
            if name not in SEND_TOOLS and name not in STICKER_TOOLS:
                continue
            args = d.get('arguments')
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = None
            texts = [''] if name in STICKER_TOOLS else bubbles_from(args)
            calls.append((line_num, d.get('callId'), name, texts, ev.get('time', '')))
        elif t == 'tool/result':
            d = ev.get('data', {})
            msg = d.get('message') or {}
            # ⭐⭐ 2026-10-15 修：**会话格式换代了（v3 → v4），判据必须同时认两种形状。**
            #   · 老（v3）：`data.message.content[]` 里有一层
            #       {"type":"tool-result", toolCallId, isError, content:[{"type":"text"}]}
            #   · 新（v4）：**那层包装没了** —— `data.message` 自己就是结果体，
            #       顶层直接带 `toolCallId` / `isError` / `content:[{"type":"text"}]`
            #   ⚠️ 只认老形状的后果：**发送成功也一律记成 attempt** ——
            #      2026-10-15 那天群里 73 条话全被判成"尝试"，`spoken` 卡在 370 一动不动
            #      （连群里收到的话都检索不到，因为默认查询排除 attempt），
            #      而 `bridge.log` 里明明写着「工具统一发送：成功 2/2 条」。**就是这一处路径写死了。**
            wrapped = [b for b in (msg.get('content') or [])
                       if isinstance(b, dict) and b.get('type') == 'tool-result']
            for block in (wrapped or [msg]):
                cid = (block.get('toolCallId')
                       or msg.get('toolCallId')
                       or (msg.get('source') or {}).get('callId'))
                if not cid:
                    continue
                result = {'error': bool(block.get('isError')), 'ok': False}
                for part in (block.get('content') or []):
                    if not isinstance(part, dict) or part.get('type') != 'text':
                        continue
                    try:
                        parsed = json.loads(part.get('text', ''))
                        if isinstance(parsed, dict):
                            result.update({k: parsed.get(k) for k in ('ok', 'sent', 'failed')})
                    except json.JSONDecodeError:
                        pass
                results[cid] = result

    out = []
    for line_num, cid, name, texts, ts in calls:
        result = results.get(cid, {})
        confirmed = (not result.get('error', True) and result.get('ok') is True
                     and result.get('failed') == 0 and result.get('sent') == len(texts))
        status = 'spoken' if confirmed else 'attempt'
        # Aggregate partial-success counts do not identify which bubbles went out.
        delivery = 'confirmed' if confirmed else 'partial_or_unconfirmed'
        for i, text in enumerate(texts):
            loc = f'{line_num}-sticker' if name in STICKER_TOOLS else f'{line_num}-{i}'
            out.append((loc, name, text, status, ts, cid, delivery))
    return session, out


def scan(path):
    """Compatibility view for existing four-field readers."""
    session, items = scan_details(path)
    return session, [r[:4] for r in items]


def run(dry_run, fix, reclassify=False):
    conn = None if dry_run else ms.connect('anan')
    stat = {'files': 0, 'spoken': 0, 'attempt': 0, 'inserted': 0, 'updated': 0,
            'duplicate': 0, 'empty': 0, 'fixed': 0, 'reclassified': 0}
    try:
        for path in iter_sessions():
            stat['files'] += 1
            source = str(path.resolve())
            session, items = scan_details(path)
            if fix:
                for loc, _n, _t, status, _ts, _cid, _delivery in items:
                    if status == 'spoken':
                        continue
                    row = conn.execute(
                        "SELECT id FROM messages WHERE source=? AND session=? AND locator=? AND kind='spoken'",
                        (source, session, loc)).fetchone()
                    if row:
                        conn.execute("UPDATE messages SET kind='attempt' WHERE id=?", (row['id'],))
                        stat['fixed'] += 1
                continue
            if reclassify and conn is not None:
                # ⭐⭐ 2026-10-15 加：把库里"其实发出去了、却被老判据记成 attempt"的**改回 spoken**。
                #   起因：会话格式换代（v3 → v4）之后，`tool/result` 的取数路径变了，
                #   而老判据只认 v3 的形状 → **762 条真的说过的话被记成"尝试"**，
                #   记忆库默认查询又排除 attempt → 那些话在检索里等于不存在。
                #   ⚠️ 判据本身**没有放宽**：仍然要求 ok==True / failed==0 / sent==气泡数。
                #     （要退回去就用 `--fix`，那是反方向的。）
                for loc, _n, _t, status, _ts, cid, delivery in items:
                    if status != 'spoken':
                        continue
                    row = conn.execute(
                        "SELECT id FROM messages WHERE source=? AND session=? AND locator=? AND kind='attempt'",
                        (source, session, loc)).fetchone()
                    if row:
                        conn.execute(
                            "UPDATE messages SET kind='spoken', refs=? WHERE id=?",
                            (json.dumps([{'type': 'delivery_evidence', 'call_id': cid,
                                          'delivery': delivery}], ensure_ascii=False), row['id']))
                        stat['reclassified'] += 1
                continue
            for loc, name, text, status, ts, cid, delivery in items:
                stat[status] += 1
                if dry_run:
                    continue
                refs = [{'type': 'delivery_evidence', 'call_id': cid, 'delivery': delivery}]
                if name in STICKER_TOOLS:
                    refs.append({'type': 'sticker'})
                st, _red = ms.add(conn, source, session, loc, ts, 'assistant', status, text, refs)
                stat[st] = stat.get(st, 0) + 1
        if conn:
            conn.commit()
    finally:
        if conn:
            conn.close()
    print(('DRY-RUN ' if dry_run else '') + ('FIX ' if fix else '') + json.dumps(stat, ensure_ascii=False))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--fix', action='store_true', help='把库里来自失败调用的 spoken 改判为 attempt')
    ap.add_argument('--reclassify', action='store_true',
                    help='反方向：把库里被误记成 attempt、其实确认发出去的改回 spoken（2026-10-15 加）')
    a = ap.parse_args()
    if a.dry_run:
        run(True, a.fix, a.reclassify)
    else:
        import memory_v2
        with memory_v2.actor_lock('anan'):
            run(False, a.fix, a.reclassify)
            memory_v2.curate('anan')
            memory_v2.export('anan')
