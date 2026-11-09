"""Compatibility entry; the local databases do not require Codex or DSH."""
import os as _os
import sys
sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import _py312guard  # noqa: E402,F401  解释器守卫：不是 3.12 会自动换解释器重跑（2026-10-25 加）
import legacy_v1 as _legacy
import memory_v2 as _v2
ROOT = _v2.ROOT
ACTORS = _v2.ACTORS
clean = _legacy.clean
json_records = _legacy.json_records
content_parts = _legacy.content_parts
connect = _v2.connect
add = _v2.add
search = _v2.search
context = _v2.context
mcp = _v2.mcp

def main():
    if len(sys.argv)==2 and sys.argv[1]=='sync':
        import json
        for actor in ACTORS:
            report = _v2.sync(actor)
            print(json.dumps(report,ensure_ascii=False))
            if report['warnings']:
                raise SystemExit(1)
    else:
        _v2.main()

if __name__=='__main__': main()
