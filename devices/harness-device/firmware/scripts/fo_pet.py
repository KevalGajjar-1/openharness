#!/usr/bin/env python3
"""Fo's pet: Wajo's Fo, the little ghost on wajo.ai (its drawing there is `fo-character-working-at-computer`), drawn
for the dial's black glass.

    python3 devices/harness-device/firmware/scripts/fo_pet.py              # write assets/pets/fo
    python3 devices/harness-device/firmware/scripts/fo_pet.py --preview D  # also write animated previews to D

Wajo draws Fo as black line art on white: a soft, lumpy ghost with two tall oval eyes and a small smile, typing at a
computer. On the glass the drawing is turned out: a pink-white body with its own shading, the same eyes and smile,
and Wajo's own pink (#FFE1EE) and plum (#231020) for its props. Its scenes follow Wajo's pictures of Fo's errands:

- the small pet (rest2x/, drawn at twice its size): Fo floating, its hem rippling, a blink;
- working (work/): Fo typing at a laptop whose lid carries Wajo's W, its eyes on the work, its hands tapping;
- listening (listen/ + listen.json): Fo looking up, swaying; the sound waves are the dial's own (ht_pet_waves_t);
- sending (send/body/, send/fly/ + send.json): Fo on Wajo's delivery scooter (its `doodle-scooter`) with a parcel,
  speed lines behind it as the overlay;
- relaxing (relax/ + relax.json): Fo dozing, bobbing, with bubbles drifting up drawn by the dial.

Every frame is drawn at four times its size and reduced, so its edges are anti-aliased; scripts/gen_pets.py thresholds
the alpha and composites the edge colours over black, as it does Muse's. The layout matches Muse's (assets/pets/muse).
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/pets/fo'
S = 4                                      # supersampling

BODY = (255, 245, 250)
SHADE = (238, 214, 228)
INK = (24, 16, 24)
BLUSH = (255, 176, 206)
PINK = (255, 225, 238)                     # Wajo's mark
PLUM = (35, 16, 32)
SILVER, SILVER_DARK = (205, 208, 218), (150, 156, 172)
SCOOTER, SCOOTER_DARK = (255, 196, 222), (214, 128, 170)
PARCEL, PARCEL_DARK = (232, 186, 122), (176, 128, 70)
WHITE = (255, 255, 255)


def canvas(w, h):
    return Image.new('RGBA', (w * S, h * S), (0, 0, 0, 0))


def reduce(im):
    return im.resize((im.width // S, im.height // S), Image.LANCZOS)


def ghost_outline(cx, cy, w, phase, squash=1.0, lean=0.0):
    """Fo's body: a lumpy dome over a rippling hem. Glass px, before supersampling."""
    h = w * 1.18 * squash
    r = w / 2
    top = cy - h / 2 + r                    # the dome's centre
    pts = []
    for k in range(0, 61):
        a = math.pi + math.pi * k / 60
        rr = r * (1 + 0.03 * math.sin(5 * a + 1.3) + 0.012 * math.sin(11 * a))
        pts.append((cx + rr * math.cos(a) + lean * (1 + math.sin(a)) * 0.5, top + rr * math.sin(a)))
    bottom = cy + h / 2
    right = cx + r * 1.0
    left = cx - r * 1.0
    def side(t):                          # the sides bulge through the middle, lumpy, as Wajo draws Fo
        return r * (1 + 0.07 * math.sin(math.pi * t) + 0.018 * math.sin(7 * t + 0.6))
    for k in range(1, 11):
        t = k / 10
        pts.append((cx + side(t) + lean * (1 - t) * 0.5, top + (bottom - top) * t * 0.92))
    for k in range(0, 41):                 # the hem: three scallops, rippling with `phase`
        t = k / 40
        x = right - (right - left) * t
        y = bottom - w * 0.07 * (0.5 - 0.5 * math.cos(2 * math.pi * 3 * t + phase))
        pts.append((x, y))
    for k in range(10, 0, -1):
        t = k / 10
        pts.append((cx - side(t) * 0.98 + lean * (1 - t) * 0.5, top + (bottom - top) * t * 0.92))
    return pts, top, h


def draw_ghost(im, cx, cy, w, phase=0.0, eyes='open', mouth='smile', look=(0.0, 0.0), squash=1.0, lean=0.0,
               arms=None, blush=True):
    """Fo on `im` (supersampled). `look` moves the eyes (fractions of w); `arms`: [(x, y)] hand centres."""
    pts, top, h = ghost_outline(cx, cy, w, phase, squash, lean)
    sp = [(x * S, y * S) for x, y in pts]
    body = Image.new('L', im.size, 0)
    ImageDraw.Draw(body).polygon(sp, fill=255)
    shifted = Image.new('L', im.size, 0)
    ImageDraw.Draw(shifted).polygon([(x - w * 0.05 * S, y - w * 0.10 * S) for x, y in sp], fill=255)
    shade = Image.composite(body, Image.new('L', im.size, 0), Image.eval(shifted, lambda v: 255 - v))
    im.paste(Image.new('RGBA', im.size, BODY + (255,)), (0, 0), body)
    im.paste(Image.new('RGBA', im.size, SHADE + (255,)), (0, 0), shade)
    d = ImageDraw.Draw(im)
    for hx, hy in arms or []:
        rx, ry = w * 0.09, w * 0.075
        d.ellipse([(hx - rx) * S, (hy - ry) * S, (hx + rx) * S, (hy + ry) * S], fill=BODY + (255,))
    ey = top - w * 0.02 + look[1] * w
    for side in (-1, 1):
        ex = cx + side * w * 0.17 + look[0] * w + lean * 0.3
        if eyes == 'closed':
            d.arc([(ex - w * 0.06) * S, (ey - w * 0.04) * S, (ex + w * 0.06) * S, (ey + w * 0.05) * S], 20, 160,
                  fill=INK + (255,), width=max(2, round(w * 0.028 * S)))
        else:
            ry = w * (0.10 if eyes != 'half' else 0.05)
            d.ellipse([(ex - w * 0.062) * S, (ey - ry) * S, (ex + w * 0.062) * S, (ey + ry) * S], fill=INK + (255,))
            d.ellipse([(ex - w * 0.035) * S, (ey - ry * 0.55) * S, (ex - w * 0.005) * S, (ey - ry * 0.25) * S], fill=WHITE + (255,))
        if blush:
            bx, by = cx + side * w * 0.29 + lean * 0.3, ey + w * 0.12
            d.ellipse([(bx - w * 0.05) * S, (by - w * 0.024) * S, (bx + w * 0.05) * S, (by + w * 0.024) * S], fill=BLUSH + (255,))
    mx, my = cx + look[0] * w + lean * 0.3, ey + w * 0.14
    if mouth == 'o':
        d.ellipse([(mx - w * 0.035) * S, (my - w * 0.03) * S, (mx + w * 0.035) * S, (my + w * 0.05) * S], fill=INK + (255,))
    else:
        d.arc([(mx - w * 0.075) * S, (my - w * 0.07) * S, (mx + w * 0.075) * S, (my + w * 0.045) * S], 25, 155,
              fill=INK + (255,), width=max(2, round(w * 0.026 * S)))
    return top, h


def wajo_mark(d, cx, cy, size, fill=PINK):
    """Wajo's W: two tall bars, a short block hanging between them, two short feet (wajo.ai/favicon.svg)."""
    u = size / 5
    x0, y0 = cx - size / 2, cy - size / 2
    for bx, by, bw, bh in ((0, 0, 1, 3), (4, 0, 1, 3), (2, 1, 1, 2), (1, 3, 1, 2), (3, 3, 1, 2)):
        d.rectangle([(x0 + bx * u) * S, (y0 + by * u) * S, (x0 + (bx + bw) * u) * S - 1, (y0 + (by + bh) * u) * S - 1], fill=fill + (255,))


def rounded(d, box, r, fill, outline=None, width=0):
    d.rounded_rectangle([v * S for v in box], radius=r * S, fill=fill + (255,) if fill else None,
                        outline=outline + (255,) if outline else None, width=width * S)


# ---- the small pet: floating, the hem rippling, a blink: four poses, the float the steps' dy ----
REST_W, REST_H = 112, 124                  # 2x: about 56 x 62 on the glass at 1x, beside Clawd's 72 x 50


def rest_frames():
    poses = []
    for pose in range(4):
        im = canvas(REST_W, REST_H)
        eyes = 'half' if pose == 2 else 'closed' if pose == 3 else 'open'
        draw_ghost(im, REST_W / 2, REST_H / 2 - 2, 84, phase=math.pi * (pose % 2), eyes=eyes,
                   arms=[(REST_W / 2 - 46, REST_H / 2 + 12), (REST_W / 2 + 46, REST_H / 2 + 12)])
        poses.append(reduce(im))
    steps = []
    for k in range(24):
        pose = 2 if k in (15, 17) else 3 if k == 16 else (k // 3) % 2
        steps.append([pose, round(2 * math.sin(2 * math.pi * k / 24))])
    return poses, steps


# ---- the scenes, as Clawd's are (scripts/gen_pets.py generate_claude_scene): a body of a few poses at body_at on
# the glass, a step's nod or hop its dy, and per step a small props sprite placed on the glass (or -1, none) ----

# Working: Fo typing at a laptop with Wajo's W on its lid; two poses (the left hand tapping, the right), a bob.
WORK_W, WORK_H = 118, 116


def work_scene():
    bodies = []
    for tap in (0, 1):
        im = canvas(WORK_W, WORK_H)
        cx = WORK_W / 2
        draw_ghost(im, cx, 46, 72, phase=math.pi * tap, look=(0, 0.035))
        d = ImageDraw.Draw(im)
        rounded(d, (cx - 38, 64, cx + 38, 104), 5, SILVER, SILVER_DARK, 1)
        wajo_mark(d, cx, 84, 18, PLUM)
        d.polygon([((cx - 46) * S, 104 * S), ((cx + 46) * S, 104 * S), ((cx + 41) * S, 111 * S), ((cx - 41) * S, 111 * S)],
                  fill=SILVER_DARK + (255,))
        for hx, up in ((cx - 26, tap == 0), (cx + 26, tap == 1)):
            hy = 65 - (4 if up else 0)
            d.ellipse([(hx - 8) * S, (hy - 6) * S, (hx + 8) * S, (hy + 6) * S], fill=BODY + (255,))
        bodies.append(reduce(im))
    # A tap's spark: three short pink strokes, the props sprite over the tapping hand.
    spark = canvas(16, 10)
    sd = ImageDraw.Draw(spark)
    for x1, y1, x2, y2 in ((2, 9, 0, 4), (8, 8, 8, 1), (14, 9, 16, 4)):
        sd.line([(x1 * S, y1 * S), (x2 * S, y2 * S)], fill=PINK + (255,), width=2 * S)
    props = [reduce(spark)]
    x0, y0 = 233 - WORK_W // 2, 233 - WORK_H // 2
    steps = []
    for k in range(16):
        tap = (k // 2) % 2
        hand_x = x0 + WORK_W / 2 + (-26 if tap == 0 else 26)
        spark_on = k % 2 == 0
        steps.append([tap, 0 if spark_on else -1, round(hand_x - 8), y0 + 50, -1 if k % 4 in (1, 2) else 0])
    return bodies, props, {'step_ms': 110, 'body_at': [x0, y0], 'steps': steps, 'cell2': []}


# Listening: one picture, Fo looking up, a gentle bob; the dial draws the waves from its head.
LISTEN_W, LISTEN_H = 96, 108


def listen_scene():
    im = canvas(LISTEN_W, LISTEN_H)
    draw_ghost(im, LISTEN_W / 2, LISTEN_H / 2, 78, mouth='o', look=(0, -0.03),
               arms=[(LISTEN_W / 2 - 42, LISTEN_H / 2 + 14), (LISTEN_W / 2 + 42, LISTEN_H / 2 + 14)])
    x0, y0 = 233 - LISTEN_W // 2, 226 - LISTEN_H // 2
    steps = [[0, -1, 0, 0, round(2 * math.sin(2 * math.pi * k / 28))] for k in range(28)]
    waves = {'centre': [233, y0 + 34], 'gap': 0, 'r_far': 60, 'r_near': 40, 'width': 3, 'half_angle_deg': 26, 'count': 3,
             'colour': list(PINK), 'period_ms': 1680}
    return [reduce(im)], [], {'step_ms': 60, 'body_at': [x0, y0], 'steps': steps, 'cell2': [], 'waves': waves}


# Sending: Fo on Wajo's delivery scooter (doodle-scooter) with a parcel; three poses (the wheels' three spokes turned
# 40 degrees, the hem, a bump), speed lines behind as the props sprite.
SEND_W, SEND_H = 168, 104


def scooter_small(d, x, y, spin):
    for wx in (x, x + 78):
        d.ellipse([(wx - 12) * S, (y - 12) * S, (wx + 12) * S, (y + 12) * S], fill=PLUM + (255,), outline=WHITE + (255,), width=3 * S)
        for a in range(3):
            t = spin + a * 2 * math.pi / 3
            d.line([(wx * S, y * S), ((wx + 8 * math.cos(t)) * S, (y + 8 * math.sin(t)) * S)], fill=WHITE + (255,), width=2 * S)
    d.rounded_rectangle([(x - 20) * S, (y - 30) * S, (x + 30) * S, (y - 9) * S], radius=10 * S, fill=SCOOTER + (255,), outline=SCOOTER_DARK + (255,), width=1 * S)
    d.rectangle([(x + 20) * S, (y - 15) * S, (x + 66) * S, (y - 7) * S], fill=SCOOTER + (255,))
    d.polygon([((x + 57) * S, (y - 7) * S), ((x + 65) * S, (y - 29) * S), ((x + 71) * S, (y - 51) * S), ((x + 84) * S, (y - 48) * S),
               ((x + 82) * S, (y - 26) * S), ((x + 79) * S, (y - 7) * S)], fill=SCOOTER + (255,), outline=SCOOTER_DARK + (255,))
    d.line([((x + 77) * S, (y - 49) * S), ((x + 75) * S, (y - 64) * S)], fill=WHITE + (255,), width=3 * S)
    d.line([((x + 66) * S, (y - 66) * S), ((x + 83) * S, (y - 64) * S)], fill=WHITE + (255,), width=3 * S)


def send_scene():
    bodies = []
    for k in range(3):
        im = canvas(SEND_W, SEND_H)
        d = ImageDraw.Draw(im)
        rx, ry = 54, 90 - (0, 1, 0)[k]
        rounded(d, (rx - 33, ry - 70, rx - 5, ry - 41), 3, PARCEL, PARCEL_DARK, 1)
        d.line([((rx - 19) * S, (ry - 70) * S), ((rx - 19) * S, (ry - 41) * S)], fill=PARCEL_DARK + (255,), width=2 * S)
        draw_ghost(im, rx + 13, ry - 57, 60, phase=2 * math.pi * k / 3, look=(0.05, 0), lean=5)
        d = ImageDraw.Draw(im)
        d.line([((rx + 34) * S, (ry - 54) * S), ((rx + 66) * S, (ry - 64) * S)], fill=BODY + (255,), width=10 * S)
        d.ellipse([(rx + 61) * S, (ry - 70) * S, (rx + 71) * S, (ry - 60) * S], fill=BODY + (255,))
        scooter_small(d, rx, ry, spin=k * math.radians(40))
        bodies.append(reduce(im))
    props = []
    for long_ in (True, False):
        im = canvas(26, 22)
        d = ImageDraw.Draw(im)
        for y, l in ((4, 20 if long_ else 14), (11, 14 if long_ else 20), (18, 17)):
            d.line([((25 - l) * S, y * S), (24 * S, y * S)], fill=WHITE + (255,), width=3 * S)
        props.append(reduce(im))
    x0, y0 = 233 - SEND_W // 2, 226 - SEND_H // 2
    steps = [[k % 3, k % 2, x0 + 54 - 33 - 30, y0 + 90 - 70 + 4, 0] for k in range(24)]
    return bodies, props, {'step_ms': 90, 'body_at': [x0, y0], 'steps': steps, 'cell2': []}


# Relaxing: dozing, bobbing, bubbles drifting up drawn by the dial (relax.json, as Clawd's and Jolly's).
RELAX_W, RELAX_H = 88, 98
RELAX_AT = (233 - RELAX_W // 2, 233 - RELAX_H // 2 + 6)


def relax_frames():
    poses = []
    for k in range(2):
        im = canvas(RELAX_W, RELAX_H)
        draw_ghost(im, RELAX_W / 2, RELAX_H / 2 + 2, 70, phase=math.pi * k, eyes='closed', squash=0.97,
                   arms=[(RELAX_W / 2 - 37, RELAX_H / 2 + 14), (RELAX_W / 2 + 37, RELAX_H / 2 + 14)])
        poses.append(reduce(im))
    steps = [[(k // 6) % 2, round(-3 * math.sin(2 * math.pi * k / 24))] for k in range(24)]
    shapes = []
    for k in range(24):
        step = []
        for j in range(3):                     # three bubbles rising from the top right, each a third behind
            u = ((k / 24) + j / 3) % 1
            if u > 0.85:
                step.append(['none', 0, 0])
                continue
            cx = RELAX_AT[0] + RELAX_W - 12 + 7 * math.sin(2 * math.pi * u * 1.5 + j)
            cy = RELAX_AT[1] + 12 - 52 * u
            step.append(['disc', round(cx, 3), round(cy, 3), round(2 + 3.5 * u, 3), list(PINK if j != 1 else BLUSH)])
        shapes.append(step)
    return poses, {'step_ms': 120, 'body_at': list(RELAX_AT), 'steps': steps, 'shapes': shapes}


def save(folder, frames):
    path = OUT / folder
    path.mkdir(parents=True, exist_ok=True)
    for old in path.glob('*.png'):
        old.unlink()
    for k, im in enumerate(frames):
        im.save(path / f'{k:02d}.png')


def glass():
    g = Image.new('RGBA', (466, 466), (0, 0, 0, 255))
    return g


def preview_scene(path, bodies, props, meta):
    """An animated GIF of a body scene on the 466 px glass, placed as the dial places it."""
    out = []
    mask = Image.new('L', (466, 466), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, 465, 465], fill=255)
    for pose, prop, px, py, dy in meta['steps']:
        g = glass()
        x0, y0 = meta['body_at']
        b = bodies[pose]
        g.alpha_composite(b, (x0, y0 + dy))
        if prop >= 0:
            g.alpha_composite(props[prop], (px, py + dy))
        bg = Image.new('RGB', (466, 466), (40, 40, 40))
        bg.paste(g.convert('RGB'), (0, 0), mask)
        out.append(bg)
    out[0].save(path, save_all=True, append_images=out[1:], duration=meta['step_ms'], loop=0, disposal=2)


def main():
    rest, rest_steps = rest_frames()
    save('rest2x', rest)
    (OUT / 'rest.json').write_text(json.dumps({'steps': rest_steps}) + '\n')
    scenes = {}
    for name, make in (('work', work_scene), ('listen', listen_scene), ('send', send_scene)):
        bodies, props, meta = make()
        save(f'{name}/body', bodies)
        save(f'{name}/props', props)
        scenes[name] = (bodies, props, meta)
    poses, relax = relax_frames()
    save('relax', poses)
    (OUT / 'relax.json').write_text(json.dumps(relax) + '\n')
    meta = {name: m for name, (_, _, m) in scenes.items()}
    meta['rest'] = {'step_ms': 140}
    (OUT / 'scenes.json').write_text(json.dumps(meta) + '\n')
    for stale in ('send/fly', 'send.json', 'listen.json'):
        target = OUT / stale
        if target.is_dir():
            for old in target.glob('*'):
                old.unlink()
            target.rmdir()
        elif target.exists():
            target.unlink()
    if '--preview' in sys.argv[1:]:
        to = Path(sys.argv[sys.argv.index('--preview') + 1])
        to.mkdir(parents=True, exist_ok=True)
        small = [r.resize((REST_W // 2, REST_H // 2), Image.LANCZOS) for r in rest]
        preview_scene(to / 'fo-rest.gif', small, [], {'step_ms': 140, 'body_at': [233 - REST_W // 4, 233 - REST_H // 4],
                      'steps': [[p, -1, 0, 0, dy] for p, dy in rest_steps]})
        for name, (bodies, props, m) in scenes.items():
            preview_scene(to / f'fo-{name}.gif', bodies, props, m)
        preview_scene(to / 'fo-relax.gif', poses, [], {'step_ms': 120, 'body_at': list(RELAX_AT),
                      'steps': [[p, -1, 0, 0, dy] for p, dy in relax['steps']]})
    return 0


if __name__ == '__main__':
    sys.exit(main())
