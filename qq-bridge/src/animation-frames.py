"""Decode bounded animation bytes from stdin into a time-ordered JPEG contact sheet."""
import base64
import io
import json
import math
import sys
import warnings

from PIL import Image, ImageDraw, ImageOps

Image.MAX_IMAGE_PIXELS = 16_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

def convert(raw):
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError('input too large')
    source = Image.open(io.BytesIO(raw))
    if source.width * source.height > 16_000_000:
        raise ValueError('image too large')
    # Bound both enumeration and compositing work; long animations get a marked preview.
    durations = []
    for index in range(240):
        if (index + 1) * source.width * source.height > 128_000_000:
            break
        try:
            source.seek(index)
        except EOFError:
            break
        durations.append(max(20, min(10000, int(source.info.get('duration', 100)))))
    if not durations:
        raise ValueError('empty animation')
    total = sum(durations)
    times = [round(total * i / max(1, min(6, len(durations)) - 1)) for i in range(min(6, len(durations)))]
    selected = []
    for target in times:
        elapsed = 0
        for index, duration in enumerate(durations):
            if elapsed + duration > target or index == len(durations) - 1:
                if not selected or selected[-1][0] != index:
                    selected.append((index, elapsed))
                break
            elapsed += duration
    if len(durations) <= 6:
        selected = []
        elapsed = 0
        for index, duration in enumerate(durations):
            selected.append((index, elapsed))
            elapsed += duration
    sheet = Image.new('RGB', (960, 350 * ((len(selected) + 2) // 3)), 'white')
    draw = ImageDraw.Draw(sheet)
    for slot, (index, timestamp) in enumerate(selected):
        source.seek(index)
        frame = source.convert('RGBA')
        frame.thumbnail((310, 310))
        x, y = (slot % 3) * 320, (slot // 3) * 350
        sheet.paste(frame, (x + (320-frame.width)//2, y + 25 + (310-frame.height)//2), frame)
        draw.text((x + 8, y + 5), f'{slot+1}: {timestamp/1000:.2f}s / frame {index+1}', fill='black')
    output = io.BytesIO()
    sheet.save(output, 'JPEG', quality=85)
    return output.getvalue()

def slice_long(raw):
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError('input too large')
    with Image.open(io.BytesIO(raw)) as original:
        source = ImageOps.exif_transpose(original)
        width, height = source.size
        horizontal = width > height
        long_edge, short_edge = max(width, height), min(width, height)
        if long_edge < 1800 or long_edge < 3 * short_edge:
            return []
        overlap = min(64, short_edge // 4)
        count = min(6, max(2, math.ceil(long_edge / (short_edge * 2))))
        frames = []
        for index in range(count):
            start = max(0, long_edge * index // count - overlap)
            end = min(long_edge, long_edge * (index + 1) // count + overlap)
            box = (start, 0, end, height) if horizontal else (0, start, width, end)
            segment = source.crop(box).convert('RGB')
            segment.thumbnail((1800, 1800))
            output = io.BytesIO()
            segment.save(output, 'JPEG', quality=86)
            frames.append(base64.b64encode(output.getvalue()).decode('ascii'))
        return frames


if __name__ == '__main__':
    raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if '--long' in sys.argv:
        print(json.dumps(slice_long(raw)))
    else:
        sys.stdout.buffer.write(convert(raw))
