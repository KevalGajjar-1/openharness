# Harness Pro Console v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what the second device check found in Console: gestures, the bell and Inbox, the toast's smoothness, the Talk bar name, the empty Working screen, and render performance.

**Architecture:**
- **Firmware.** Gesture changes live in `main/app/pod_glue.c`, gated on `POD_SKIN_CONSOLE`. View changes live in `main/pod/console/`. Render speedups go in `main/display/pro_canvas.c`, and a speedup there must keep the output pixel-identical.
- **Daemon.** It throttles reply-text updates to steps-v1 devices.

**Tech Stack:** C11 (ESP-IDF 5.5.4, clang/UBSan host tests), TypeScript (vitest).

**Spec:** `docs/superpowers/specs/2026-10-13-harness-pro-console-v3-design.md`, together with the v1 and v2 Console specs.

## Global Constraints

- **Classic is untouched:** `golden.sh --check` gives 295 matches with both fonts after every task.
- **Renderer:** a renderer speedup must leave both the Classic and the Console goldens byte-identical (Task 4).
- **Gesture zones:** the bottom zone is y ≥ 620, the bar zone is y < 72, a swipe needs at least 80 px with |dy| > 1.5|dx|, and an Overview page needs a horizontal swipe by the v1 rules.
- **Waits and rates:**
  - toast wake: 33 ms;
  - equaliser and working mark: 66 ms;
  - Talk wave: 100 ms;
  - daemon reply text: at most once per 750 ms per agent, plus a final flush.
- **Target:** device frame_max ≤ 24 ms on every Console screen.
- **Process:**
  - don't commit or stage, and never `git stash`;
  - flash only with `scripts/flash.sh`;
  - run `test/run.sh` without sourcing IDF `export.sh`, and build in a separate shell.

## Review Focus

1. **A swipe that starts in the bottom zone on Agent but drifts sideways, or a hold that starts in the bottom zone.** It must stay a single gesture. A hold still talks; a mostly-sideways swipe steps panes and does not go BACK. (Task 1)
2. **A swipe down from the bar while a toast is showing.** The toast's own swipe-up dismiss keeps working, and the bar swipe still goes home. (Task 1)
3. **Reply text arriving every 750 ms on a lossy link.** No frame grows past the cap, and a lost update is replaced by the next. Nothing piles up. (Task 3)
4. **The AA fast path at radius 0, 1 and 2, and on rects narrower than 2r.** The result is pixel-identical to the old function. (Task 4)
5. **The bell chip together with the ▲ chip and a long crumb.** The crumb gives way: it is cut first, and neither chip is clipped. (Task 2)

---

### Task 1: Console gestures v3

**Files:**
- Modify: `main/app/pod_glue.{h,c}` (`swipes()` ~:214-219, `scrolls()` ~:203-207, the `sw_ok` start check ~:412, the bar swipe ~:526-531, the `pg_*` paging ~:264-317 / :473-485, `unit_ms`)
- Test: `test/test_cs_glue.c`

**Interfaces:**
- Produces:
  - the constants `POD_BOTTOM_Y 620` and `POD_EDGE_SWIPE 80` (reuse `POD_BAR_SWIPE` if it is equal);
  - Console only:
    - TABS takes the horizontal swipe, with NEXT/PREV meaning page ±1 through the existing scroll state;
    - bottom-zone swipe up → `POD_A_BACK` (arg 1) on every non-root screen except TALK and OTA;
    - bar swipe down → `POD_A_TABS`;
    - RECAP leaves `scrolls()`;
    - `sw_ok` uses `y < POD_BOTTOM_Y`;
    - the TABS `pg` animation is skipped.

- [ ] **Step 1: Write the failing tests:**
  - Overview with 6 tabs:
    - a left swipe moves to page 2 and a right swipe back to page 1;
    - a vertical drag of 200 px leaves the page alone;
    - no 16 ms wakes after the swipe (`pod_ui_wake_ms` > 16).
  - On Agent, Recap, Tab, Recent and Inbox: a DOWN at y 690, then a MOVE to dy −120, then UP → depth −1.
  - On Agent:
    - a DOWN at y 690 with dx 150 and dy −30 → NEXT pane, not BACK;
    - a hold at y 690 still talks.
  - A bar DOWN at y 20 with dy +120 → depth 1 (Overview), from both Agent and Inbox.
  - With a toast showing, a swipe up on the toast dismisses it.
  - A Recap vertical drag → no `scroll_emit` call.
  - Classic: the same sequences give today's results.
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement.** Record the start zone at DOWN. Decide the gesture on UP by direction dominance.
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/golden.sh --check && bash test/stress_pro_app.sh`. Expected: PASS.

### Task 2: Bell, header, hints, Talk chip, toast smoothness, Working body

**Files:**
- Modify:
  - `main/pod/console/cs_chrome.c` (`cs_bar`: bell chip; talk branch ~:89-99)
  - `cs_agent.c` (`cs_hero` ~:77-85; the working body ~:142-156; hints)
  - `cs_recap.c`, `cs_tab.c`, `cs_recent.c`, `cs_inbox.c`, `cs_overview.c` (hints)
  - `cs_talk.c` (chip)
  - `main/app/pod_glue.c` (the toast wake, 33 ms in place of 250 ms, ~:692)
- Test: `test/test_cs_views.c`, `test/test_cs_glue.c` (toast wake); Console goldens regenerated

**Interfaces:**
- Produces:
  - `cs_bar(...)` gains an `int unread` argument (update every caller). When `unread > 0` and the view is not INBOX or TALK, it draws the bell chip left of the ▲ chip, with the hit `POD_A_INBOX`.
  - The bell glyph is built from rects and arcs (`pod_arc` / `pod_tri`), about 18 × 18, in `CS_INK`. The count is in `cs_mono_18`.
  - A crumb that would overlap the chips is cut with "…" first.
- Copy:
  - Agent and Recap hints: `hold talk · ← → panes · ↑ back · ↓ home`
  - Tab, Recent and Inbox hints: `tap open · ↑ back · ↓ home`
  - Overview keeps its hints.
  - The header line drops "· pane i of n".
- [ ] **Step 1: Write the failing tests:**
  - `unread = 3` → a bell hit `POD_A_INBOX` plus the text "3";
  - `unread = 0`, or on Inbox or Talk → no bell;
  - a 39-byte crumb plus both chips → no chip run is clipped (its x + w is at most 704);
  - Agent → no run contains "pane";
  - Talk with the name "firmware-pro" → the chip text is whole and drawn in `cs_sb_26`;
  - Working with a 300-byte activity → at most 3 `cs_rg_27` lines and the last one ends in "...";
  - no activity → only the verb line;
  - with a toast showing → `pod_ui_wake_ms(now) - now <= 33`;
  - budgets still hold (at most 184 runs, 192 with the toast).
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement**, then regenerate the Console goldens (list the screens) and render PNGs for overview with bell, agent working with text, talk and toast.
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/golden.sh --check && bash test/golden.sh --skin console --check`, with both fonts. Expected: PASS.

### Task 3: Daemon streams reply text to steps-v1 devices

**Files:**
- Modify:
  - `cli/src/lib/commander.ts` (`text_delta` ~:435-438 updates `playerUpdate` / `latestUpdate`)
  - `cli/src/services/devices.ts` or `cli/src/cable/cableSession.ts`, wherever `turn.activity {action}` is sent (~:2630-2654), to add the throttle
- Test: `cli/src/lib/commander.spec.ts`, `cli/src/cable/cableSession.spec.ts` / `cli/src/services/devices.spec.ts`

**Interfaces:**
- Produces:
  - while a turn runs, commander emits a processing update when `latestUpdate` changes, and the device path sends `turn.activity {agentId, text:'', action}` to steps-v1 sessions;
  - it is throttled to one send per 750 ms per agent, with a trailing send of the last value at the end of the window and at turn end, before `turn.done`;
  - the existing `ACTION_MAX_BYTES` (188) clip applies.
- [ ] **Step 1: Write the failing tests** (fake timers):
  - text deltas at t = 0, 100, 200 and 900 ms → sends at 0 and 750 (with the 200 ms text), then at 1500 (the 900 ms text);
  - turn end at 1000 → a flush before `turn.done`;
  - a non-steps-v1 session receives none;
  - a 500-byte paragraph is clipped to at most 188 bytes on a codepoint boundary;
  - existing heartbeat behaviour is unchanged.
- [ ] **Step 2: Run them and see them fail.** Run `cd cli && npx vitest run src/lib/commander.spec.ts src/cable/cableSession.spec.ts src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the update local to the device path, so no extra frames go to the gateway or the desktop.
- [ ] **Step 4: Run them again.** Run the same command, then `npm run typecheck`, then `npm run test:core`. Expected: PASS, with test:core at 100%.

### Task 4: Render performance

**Files:**
- Modify:
  - `main/pod/console/cs_view.c` (ground as the scene background)
  - `main/display/pro_canvas.c` (`corner_cover` fast path ~:248-265; a border stroke helper)
  - the Console card, tile, hero and toast draws (border as a stroke)
  - `main/pod/console/cs_agent.c`, `cs_chrome.c`, `cs_talk.c` and the glue wake rules (animation rates)
  - `test/pod_render.c` (the `time:` mode includes the toast)
  - `docs/size-baseline.txt`
- Test: `test/test_pod_draw.c`, plus a new `test/test_cs_perf.sh` (or a case in `run.sh`) that compares host µs against a recorded baseline

**Interfaces:**
- Produces:
  - `bool ht_pro_rect_aa_stroke(ht_scene_t *, int x, int y, int w, int h, int radius, uint16_t ink, uint16_t fill);` draws a fill with a 1 px border in one run kind. Use it where the code drew a border fill under a surface fill.
  - Animation steps: equaliser and working mark at 66 ms; Talk wave at 100 ms with square bars.
- [ ] **Step 1: Write the failing tests:**
  - `test_pod_draw`: the old and new `corner_cover` agree on every pixel for radius 0..40 and sizes from 1×1 to 120×80. Keep the old function as `corner_cover_ref` in the test.
  - `ht_pro_rect_aa_stroke` output equals the old two-fill drawing pixel for pixel.
  - Perf check: the host µs of each Console screen is at most 0.85 × the pre-change value (record the pre-change numbers first).
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh`. Expected: the new perf check fails before the change.
- [ ] **Step 3: Implement.** The Console goldens must stay byte-identical for items 1–3. Items 4 (rates) and the square wave bars legitimately change the talk and equaliser screens: regenerate only those and list them.
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/golden.sh --check && PRO_FONT=fonts/LiberationSans-Regular.ttf bash test/golden.sh --check && bash test/golden.sh --skin console --check && bash test/stress_pro_app.sh`, then the idf build. Expected: PASS. Record the before and after host µs in `docs/size-baseline.txt`.

### Task 5: Review, device check

- [ ] **Step 1: Review.** An independent review on the strongest model covers the Task 1–4 diff: gesture zones and conflicts, the throttle and link load, pixel identity of the renderer, and Classic invariance. Fix the findings with tests.
- [ ] **Step 2: Flash and walk.** Flash with `FLASH_PORT=<port> bash scripts/flash.sh` and reinstall the dev CLI. The owner walks through:
  - Overview, swiping left and right;
  - Agent, swiping up (back) and down (home);
  - the bell and Inbox;
  - the toast, which should be smooth;
  - the Talk bar name;
  - Working, with "Sol thì sao" showing the reply text.

  Read the heartbeat `frame_max_us` on each Console screen. The target is 24 000 or less; report any screen above it.
