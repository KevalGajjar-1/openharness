# Harness Pro · Console v3 (second device check)

Status: design · 2026-10-13 · owner 0xdiego25
Builds on: the v1 and v2 Console specs (`2026-10-12-harness-pro-console-design.md`, `…-v2-design.md`), both implemented on `feat/pro-console` and uncommitted.
Root causes come from the investigation of 2026-10-13: file:line references are in the plan, and host perf numbers are below.

## Changes

### Gestures

These apply only in Console, on every screen except Talk and Update. Classic is unchanged.

| Gesture | Where it starts | Result |
|---|---|---|
| swipe **left / right** | Overview | next / previous page (4 cards). It switches at once, with no settle animation. Vertical drag on Overview does nothing. |
| swipe **up** (≥ 80 px, \|dy\| > 1.5\|dx\|) | the bottom zone, y ≥ 620 | `BACK` one level. From Agent or Recap that is the tab's list, or wherever the stack came from. |
| swipe **down** (≥ 80 px, \|dy\| > 1.5\|dx\|) | the bar, y < 72 | **to Overview** (`POD_A_TABS`, pop to the root). Today it goes back one level. |

- Horizontal pane and tab swipes keep the v1 rules, but their start zone is anything above the bottom zone (y < 620), no longer Classic's transport line.
- Recap no longer counts as a vertical scroll target in Console. Its summary does not scroll, and the host terminal must not scroll either.
- **Hints:**
  - Overview: `tap open tab · ← → pages · ▲ go to the ask`
  - Agent and Recap: `hold talk · ← → panes · ↑ back · ↓ home`
  - Tab, Recent and Inbox: `tap open · ↑ back · ↓ home`

### Agent header

Drop "pane i of n". The line under the state is the 28 px logo plus the machine name.

### Notifications

- **Bell chip.** The Console bar gets a bell chip with the unread count, left of the ▲ chip. It is styled like that chip: dark fill, ink text, a bell glyph built from the existing primitives, and the count in `cs_mono_18`.
  - It is hidden when nothing is unread, and on the Inbox and Talk screens.
  - Tapping it gives `POD_A_INBOX`.
- **Toast.** The toast stays as it is, timer line included, but must run smoothly.
  - The glue wakes every 33 ms while a toast is up, in place of 250 ms, so the line shrinks evenly.
  - The damage is only the line's few pixels.

### Listening

The bar's agent chip uses `cs_sb_26`, the same size as the crumbs elsewhere. It may run up to the caret, with no 200 px cap, and is cut with "…" only when it really does not fit.

### Working: show the reply as it streams

- **Daemon.** While a turn runs, each `text_delta` updates `latestUpdate` (commander). The daemon sends `turn.activity {agentId, text:'', action: latestUpdate}` to devices with `activity:"steps-v1"`.
  - It sends at most once per **750 ms** per agent, plus once at the end of the turn if the last text has not been sent.
  - `action` keeps its 188-byte cap. Nothing else changes.
- **Console Working screen.**
  - Under NOW: the verb (or "Working") and the equaliser.
  - Then the latest reply text (`a->activity`), wrapped to at most **3 lines** in `cs_rg_27`, cut with "…".
  - With no activity the body is just the verb line. The elapsed time is already in the header.
- **Classic.** Classic shows `activity` as it does today, so the more frequent updates simply make it livelier.

### Performance

The target is every Console screen at **frame_max ≤ 24 ms** on the device, measured from the heartbeat. Today it is 31 ms, against 21.7 ms for Classic.

| Screen (host µs) | Console | Classic |
|---|---|---|
| Overview | 202 | 139 |
| Recap | 407 | 271 |
| Agent asking | 307 | 117 |
| Talk | 325 | 150 |
| Toast over agent | 314 | 296 |

1. **Ground as background.** Set `scene->background = CS_GROUND` and drop the full-screen ground rect (`cs_view.c`).
2. **AA corner fast path.** Return full coverage inside (r−0.5)² and none outside (r+0.5)². The isqrt is only reached on the edge ring. The output must be pixel-identical; the goldens prove it.
3. **Borders as strokes.** Cards, tiles, the hero box and the toast draw their 1 px border as a stroke (four edge rects, or one new run kind), instead of a border fill under a surface fill.
4. **Animation rates.**
   - The equaliser and the working mark: **66 ms**.
   - The Talk wave: **100 ms**, with square bars (radius 0).
   - The Overview page switch has no animation and no 16 ms settle wakes.
5. **Measure.** The host perf mode (`pod_render time:`) must include the toast. Record the host µs before and after in `docs/size-baseline.txt`, plus the device's `raster_max_us` / `frame_max_us` per Console screen.

Items 1 and 2 together were measured at −20 to −25 % on the host for every screen. With items 3 and 4 the target should hold. If a screen still misses it, the plan's device check reports which one.

## Not changing

- Hands-free voice.
- Tokens on done only.
- The v2 layouts.
- Classic in every respect: 295 goldens in both fonts.

## Tests

**Firmware:**
- `test_cs_glue`:
  - a horizontal swipe on Overview pages, and a vertical drag does not;
  - a swipe up from y ≥ 620 on Agent, Recap, Tab, Recent and Inbox goes BACK;
  - a swipe down from the bar goes to the root;
  - a pane swipe starting at y 600 still steps;
  - Recap emits no host scroll;
  - the Classic sequences are unchanged.
- `test_cs_views`:
  - the bell chip appears only with unread entries and not on Inbox or Talk, and tapping it gives `POD_A_INBOX`;
  - there is no "pane" text;
  - the Talk chip is drawn in `cs_sb_26` and is not cut when it fits;
  - Working draws up to 3 wrapped lines of activity.
- `test_pro_frame` or a new perf check: the host µs of every Console screen is at most its recorded baseline. The test fails on a 15 % regression.
- Goldens: Console regenerated (list the screens), Classic 295 unchanged.

**CLI:**
- `cableSession.spec` / `devices.spec`:
  - `text_delta` updates produce `turn.activity {action}` no more than every 750 ms, with a final flush;
  - nothing goes to non-steps-v1 devices;
  - the 188-byte clip holds.
- `npm run test:core` stays at 100%.

**Device:**
- Flash and walk every item above.
- Run a short text-only Claude turn ("Sol thì sao") and see the reply text on Working.
- Heartbeat frame_max ≤ 24 ms on each Console screen.

## Risk

**Critical:** touch gestures change (new zones, a new meaning for the bar swipe), and the daemon sends `turn.activity` more often (the cable link has a known byte-loss issue, so watch the frame rate). The review runs on the strongest model.
