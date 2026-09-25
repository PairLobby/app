"""Build tiny video frames and a character-cell fallback; ffmpeg is build-time only."""
import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile

source = Path(sys.argv[1])
destination = Path(__file__).resolve().parents[1] / 'packages/cli/src/working-logos.json'
videos = {
    'openai': ('OAI_OpenAI-Blossom_White_spinning.mp4', 'black', '#dddddd'),
    'claude': ('File_Claude_AI_symbol_spinning.mp4', 'black', '#d97757'),
    'qwen': ('Qwen_Logo_spinning.mp4', 'black', '#8b7bff'),
    'deepseek': ('deepseek.MP4', 'white', '#536dfe'),
}
assets = {}
for provider, (name, background, color) in videos.items():
    with tempfile.TemporaryDirectory(prefix='pairlobby-logo-') as temporary:
        crop = 'crop=iw*0.72:ih*0.72,' if provider != 'deepseek' else ''
        base = f'setpts=PTS/4,fps=12,{crop}format=rgba,colorkey={background}:0.12:0.04'
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(source / name), '-map', '0:v:0', '-an', '-vf', base + ',scale=48:48', '-frames:v', '30', str(Path(temporary) / '%03d.png')], check=True)
        pixels = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(source / name), '-map', '0:v:0', '-an', '-vf', base + ',scale=12:12', '-frames:v', '30', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
        frames = []
        dots = [(0, 0, 0), (0, 1, 1), (0, 2, 2), (1, 0, 3), (1, 1, 4), (1, 2, 5), (0, 3, 6), (1, 3, 7)]
        for index, png in enumerate(sorted(Path(temporary).glob('*.png'))):
            raw = pixels[index * 576:(index + 1) * 576]
            rows = []
            for y in range(0, 12, 4):
                row = ''
                for x in range(0, 12, 2):
                    mask = 0
                    for dx, dy, bit in dots:
                        offset = ((y + dy) * 12 + x + dx) * 4
                        if raw[offset + 3] > 80:
                            mask |= 1 << bit
                    row += chr(0x2800 + mask)
                rows.append(row)
            frames.append({'png': base64.b64encode(png.read_bytes()).decode(), 'cells': '\n'.join(rows)})
        assets[provider] = {'color': color, 'frames': frames}
destination.write_text(json.dumps({'frameMs': 83, 'providers': assets}, separators=(',', ':')) + '\n')
print(f'{destination}: {destination.stat().st_size} bytes; 48px, 12fps, 4× speed, 2.5-second loops')
