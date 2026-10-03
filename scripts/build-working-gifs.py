"""Add one animated GIF per provider to working-logos.json, built from its validated PNG frames.

iTerm2 animates an inline GIF itself, so PairLobby uploads the logo once instead of
erasing and re-uploading a PNG every frame (the churn behind the orange-placeholder
flash). Build-time only: run in a throwaway virtualenv with Pillow installed.

    python3 -m venv /tmp/logo-env && /tmp/logo-env/bin/pip install pillow
    /tmp/logo-env/bin/python scripts/build-working-gifs.py
"""
import base64
import io
import json
from pathlib import Path

from PIL import Image

destination = Path(__file__).resolve().parents[1] / 'packages/cli/src/working-logos.json'
data = json.loads(destination.read_text())
duration = data['frameMs']
TRANSPARENT = 255
# GIF transparency is all-or-nothing; this keeps the logo's body and drops faint fringe.
ALPHA_CUTOFF = 96


def to_palette(frame: Image.Image) -> Image.Image:
    """Quantize to 255 colours and reserve index 255 for pixels that must stay transparent."""
    rgba = frame.convert('RGBA')
    # Quantize the frame's own colours, not a blend onto black, so edges keep the logo's colour.
    paletted = rgba.convert('RGB').quantize(colors=255, dither=Image.Dither.NONE)
    palette = paletted.getpalette()[:255 * 3] + [0, 0, 0]
    paletted.putpalette(palette)
    alpha = rgba.getchannel('A')
    pixels = paletted.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            if alpha.getpixel((x, y)) < ALPHA_CUTOFF:
                pixels[x, y] = TRANSPARENT
    paletted.info['transparency'] = TRANSPARENT
    return paletted


def delays(count: int) -> list[int]:
    """GIF delays are whole hundredths of a second; spread the remainder so a loop keeps its length."""
    return [round((index + 1) * duration / 10) * 10 - round(index * duration / 10) * 10 for index in range(count)]


for provider, asset in data['providers'].items():
    frames = [to_palette(Image.open(io.BytesIO(base64.b64decode(frame['png'])))) for frame in asset['frames']]
    timing = delays(len(frames))
    output = io.BytesIO()
    # disposal=2 clears each frame to transparent before the next, so frames never smear.
    frames[0].save(output, format='GIF', save_all=True, append_images=frames[1:], duration=timing, loop=0, disposal=2, transparency=TRANSPARENT, optimize=False)
    gif = output.getvalue()

    # Validate what was written rather than trusting the encoder.
    check = Image.open(io.BytesIO(gif))
    assert check.n_frames == len(asset['frames']), (provider, check.n_frames)
    assert check.info.get('loop') == 0, (provider, 'must loop forever')
    for index in range(check.n_frames):
        check.seek(index)
        assert check.info.get('duration') == timing[index], (provider, index, check.info.get('duration'))
        rgba = check.convert('RGBA')
        opaque = sum(rgba.getchannel('A').histogram()[1:])
        # Never a filled rectangle: each frame keeps transparent corners and a partly empty area.
        assert 0 < opaque < rgba.width * rgba.height * 0.8, (provider, index, opaque)
        assert all(rgba.getpixel(corner)[3] == 0 for corner in ((0, 0), (rgba.width - 1, 0), (0, rgba.height - 1), (rgba.width - 1, rgba.height - 1))), (provider, index)
    assert abs(sum(timing) - duration * len(frames)) < 10, (provider, sum(timing))
    asset['gif'] = base64.b64encode(gif).decode()
    print(f'{provider}: {len(gif)} bytes, {check.n_frames} frames, {sum(timing)} ms loop, looping')

destination.write_text(json.dumps(data, separators=(',', ':')) + '\n')
print(f'{destination}: {destination.stat().st_size} bytes')
