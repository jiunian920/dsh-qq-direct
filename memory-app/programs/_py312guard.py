"""解释器守卫（岸岸 2026-10-25 加）

为什么要有它：这套库的二进制依赖（zstandard / numpy / onnxruntime）都是 **cp312**。
用错解释器会在 import 阶段就炸成
    ModuleNotFoundError: No module named 'zstandard.backend_c'
看起来像"库坏了"，其实只是被别的 python 跑了一遍
（PATH 上的 `python` = sd-webui 的 3.10；`py` 不指定版本 = 3.13）。

所以：被 import 的那一刻检查版本，不是 3.12 就用本机 Python 3.12 重新执行自己。
找不到 3.12 就明说，不静默降级、不假装同步成功。

⭐ 只做这一件事：换解释器。不改任何业务逻辑、不碰任何数据。
   回退办法：把各脚本顶部那行 `import _py312guard` 删掉即可（本文件留着无害）。
"""
import os
import shutil
import subprocess
import sys

TARGET = (3, 12)
TARGET_TEXT = '3.12'
_FLAG = 'AI_MEMORY_PY_REEXEC'


def _candidates():
    out = []
    env = os.environ.get('AI_MEMORY_PYTHON')
    if env:
        out.append([env])
    local = os.environ.get('LOCALAPPDATA')
    if local:
        out.append([os.path.join(local, 'Programs', 'Python', 'Python312', 'python.exe')])
    out.append([r'C:\Python312\python.exe'])
    out.append([r'C:\Program Files\Python312\python.exe'])
    py = shutil.which('py')
    if py:
        out.append([py, '-3.12'])  # 钉死版本，不用 py 的默认（3.13）
    return out


def _is_312(prefix):
    try:
        done = subprocess.run(
            prefix + ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])'],
            capture_output=True, text=True, timeout=30)
    except Exception:
        return False
    return done.returncode == 0 and done.stdout.strip() == TARGET_TEXT


def _die_no_312():
    sys.stderr.write(
        '记忆库需要 Python %s（依赖里的 zstandard / numpy / onnxruntime 都是 cp312 二进制）。\n'
        '现在这个解释器是 %s，而且本机没找到可用的 %s。\n'
        '装一个 Python 3.12（别用 3.13），或用环境变量 AI_MEMORY_PYTHON 指向它。\n'
        % (TARGET_TEXT, '.'.join(str(x) for x in sys.version_info[:3]), TARGET_TEXT))
    raise SystemExit(2)


def _die_no_script():
    sys.stderr.write(
        '当前解释器是 Python %s，记忆库需要 %s，但这次调用拿不到脚本路径（比如 `python -c ...`），'
        '换不了解释器。\n'
        '请直接运行脚本文件：%s 程序\\memory_v2.py …（3.12 已经在本机）\n'
        % ('.'.join(str(x) for x in sys.version_info[:3]), TARGET_TEXT, TARGET_TEXT))
    raise SystemExit(2)


def enforce():
    if sys.version_info[:2] == TARGET:
        return
    if os.environ.get(_FLAG) == '1':
        _die_no_312()  # 换过一次还是不对，别再循环
    script = os.path.abspath(sys.argv[0]) if sys.argv and sys.argv[0] else ''
    for prefix in _candidates():
        if _is_312(prefix):
            if not script or not os.path.isfile(script):
                _die_no_script()  # 拿不到脚本路径就换不成（比如 python -c）
            if os.environ.get('AI_MEMORY_PY_VERBOSE') == '1':
                # ⚠️ 默认不往 stderr 写：PowerShell 脚本（$ErrorActionPreference='Stop'）
                #    会把原生命令的 stderr 当成错误记录 → 明明成功也会报失败。
                sys.stderr.write('（当前 python %s 不对，已自动换成 Python %s 重跑）\n'
                                 % ('.'.join(str(x) for x in sys.version_info[:2]), TARGET_TEXT))
                sys.stderr.flush()
            os.environ[_FLAG] = '1'
            os.execv(prefix[0], list(prefix) + ['-X', 'utf8', script] + sys.argv[1:])
    _die_no_312()


enforce()
