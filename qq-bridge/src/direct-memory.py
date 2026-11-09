"""Copy durable QQ bridge events to 岸岸's existing memory schema."""
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys


sys.path.insert(0, os.environ.get('QQ_MEMORY_PROGRAMS', str(Path(__file__).resolve().parents[2] / 'memory-app' / 'programs')))
import memory_v2 as memory


def timestamp(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()


def archive_incoming(source, destination):
    cursor_key = "qq_direct_input_seq"
    cursor = destination.execute("SELECT value FROM metadata WHERE key=?", (cursor_key,)).fetchone()
    last_seq = None
    rows = source.execute("SELECT seq,payload FROM input WHERE seq>? ORDER BY seq", (int(cursor[0]) if cursor else 0,))
    for seq, raw in rows:
        last_seq = seq
        item = json.loads(raw)
        if item.get("opportunity"):
            continue
        refs = [{key: item.get(key) for key in ("channel", "sender", "senderId", "messageId", "quote", "mentions", "media")}]
        memory.add(destination, "qq-direct", item["channel"], item.get("messageId") or item["id"],
                   timestamp(item["at"]), "user", "transcript", item["text"], refs)
    if last_seq is not None:
        destination.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (cursor_key, str(last_seq)))


def archive_outgoing(source, destination):
    cursor_key = "qq_direct_output_seq"
    cursor = destination.execute("SELECT value FROM metadata WHERE key=?", (cursor_key,)).fetchone()
    rows = source.execute(
        "SELECT seq,id,channel,state,payload,result FROM outgoing WHERE seq>? ORDER BY seq",
        (int(cursor[0]) if cursor else 0,),
    )
    for seq, identity, channel, state, payload, raw in rows:
        if state in ("pending", "sending"):
            break
        if state == "sent":
            item = json.loads(raw)
            refs = [{key: item.get(key) for key in ("format", "messageId", "replyTo", "stickerId", "audio")}]
            memory.add(destination, "qq-direct", channel, f"sent:{item['messageId'] or identity}",
                       timestamp(item["at"]), "assistant", "spoken", item["text"], refs)
        else:
            item = json.loads(payload)
            refs = [{"delivery": state, "format": item.get("format"), "replyTo": item.get("replyTo"),
                     "stickerId": item.get("stickerId")}]
            memory.add(destination, "qq-direct", channel, f"attempt:{identity}",
                       timestamp(item.get("expires", 75000) - 75000), "assistant", "attempt", item.get("text", ""), refs)
        destination.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (cursor_key, str(seq)))


def main():
    journal = Path(sys.argv[1]).resolve()
    with closing(sqlite3.connect(journal.as_uri() + "?mode=ro", uri=True)) as source, memory.actor_lock("anan"):
        with closing(memory.connect("anan")) as destination, destination:
            archive_incoming(source, destination)
            archive_outgoing(source, destination)


if __name__ == "__main__":
    main()
