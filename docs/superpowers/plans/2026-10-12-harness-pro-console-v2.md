# Harness Pro Console v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the owner's device-check changes to Console: bigger type, real engine logos, the 2×2 Overview, one row style for Recent and Tab with a working mark, the Agent header variant C, tokens on done only, the Classic-length recap, and hands-free voice with tap to send.

**Architecture:**
- Changes stay inside the Console views (`main/pod/console/`), the glue's Console-only voice path, and the font and logo generators.
- The daemon adds `tokensIn` / `tokensOut` to the existing `turn.stats`. They come from `CoreApi.usage` readings taken at turn start and at done.
- Classic is untouched.

**Tech Stack:** C11 (ESP-IDF 5.5.4; host tests with clang and UBSan), Python 3 (generators), TypeScript (vitest).

**Spec:** `docs/superpowers/specs/2026-10-12-harness-pro-console-v2-design.md`, read together with the v1 spec `2026-10-12-harness-pro-console-design.md`.
**Mockups:** `devices/harness-pro/mockup/pro-console-v2.html`, plus `pro-console-agent.html` variant C for the Agent header. Sources are in `mockup/pro-wow/build5.py`, `build6.py`, `style5.css` and `style6.css`, with exact sizes, colours and copy.
**Starting state:** v1 is fully implemented and uncommitted on `feat/pro-console` (plan `2026-10-12-harness-pro-console.md`, all tasks done).

## Global Constraints

- **Classic is unchanged.** `bash test/golden.sh --check` gives 295 matches with both fonts after every task, and every Console change is gated on `POD_SKIN_CONSOLE`.
- **Budgets:**
  - each Console screen is at most 184 runs, and screen plus toast at most 192;
  - fonts total at most 640 KB;
  - the two new logo sizes total at most 350 KB.
- **Wire:**
  - `turn.stats {agentId, testsPassed?, testsFailed?, commits?, tokensIn?, tokensOut?}`, under `stats:"turn-v1"`, sent once before `turn.done`;
  - token values are whole numbers from 0 to 50 000 000;
  - a missing or negative difference, or one over the cap, means the field is omitted.
- **Token freshness:** the done reading uses a fresh read, and a read slower than 2 s sends `turn.stats` without tokens and never delays `turn.done`.
- **Agent header copy:** state words "Running", "Needs input", "Done". An unknown time is not drawn and leaves no "·".
- **Voice (Console):**
  - hold ≥ 400 ms starts listening;
  - the lift does nothing;
  - the next tap anywhere on Talk sends (`VOICE_END`);
  - the side button discards;
  - a contact cancel no longer aborts;
  - the orphan guard stays.
- **Process:**
  - don't commit or stage;
  - never `git stash`;
  - flash only with `scripts/flash.sh`;
  - code and docs in English, matching the comment density around them.

## Review Focus

1. **A tap on the Talk screen that lands on a bar crumb or the ▲ chip while hands-free.** It must still send. While listening, the full-screen hit is the topmost hit, so no crumb can steal the tap. (Task 5)
2. **The first DOWN after the hold fired, if it is the same contact.** The lift of the holding finger must not count as the send tap; only a new DOWN then UP sends. (Task 5)
3. **A token reading taken at done before the transcript's last usage line is flushed.** The fresh read must see it, or the field is omitted. A stale, smaller value must never be shown. (Task 1)
4. **A very long agent name in the 34 px header, or a tab with 20 agents in the Recent-style Tab list.** The name is cut with "…", the list scrolls by rows, and the budget holds. (Task 4)
5. **An engine without a baked logo, for example a new engine the daemon reports.** It falls back to the two-letter badge at the same size, with nothing missing or misaligned. (Task 3)

---

### Task 1: Daemon turn tokens

**Files:**
- Modify:
  - `cli/src/services/devices.ts`, which owns `TurnStats`, takes `take()` on done and drops stats on `turn_started`
  - `cli/src/cable/turnStats.ts`: `TurnStatsFields` gains `tokensIn?` and `tokensOut?`
  - `cli/src/cable/cableSession.ts`, `turnStats()`: pass the two fields through
  - the place where the devices service gets core access. Find how a service process calls core queries, e.g. `answerAgentQuery` in `cli/src/core/agentQueries.ts:12-16` and how `agentCleanupLink` gets `core.usage`. Wire a usage read the same way.
- Test: `cli/src/services/devices.spec.ts`, `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Produces:
  - `TurnStatsFields.tokensIn?: number` and `TurnStatsFields.tokensOut?: number`
  - in devices.ts, an injected `readUsage(agentId: string): Promise<{ input?: number; output?: number } | null>`, resolved through core's fresh usage read (`AgentTokenUsageCache.read`, not `get`)

- [ ] **Step 1: Write the failing tests** in devices.spec:
  - start reading `{input: 1000, output: 200}` and done reading `{input: 43900, output: 18700}` → `turnStats` carries `{tokensIn: 42900, tokensOut: 18500}` before `turnDone`;
  - the start reading is missing → no token fields;
  - a negative difference → no token fields;
  - a difference of 50 000 001 → no token fields;
  - the done read resolves after 2.5 s (fake timers) → `turnStats` without tokens and `turnDone` within 2 s;
  - an agent whose usage target is unknown or remote (`readUsage` returns null) → no token fields;
  - tests and commits still merge into the same message.

  In cableSession.spec: `turnStats('a', {tokensIn: 5, tokensOut: 7})` writes `{"t":"turn.stats","agentId":"a","tokensIn":5,"tokensOut":7}` under the cap and nothing without it.
- [ ] **Step 2: Run the tests and see them fail.** Run `cd cli && npx vitest run src/services/devices.spec.ts src/cable/cableSession.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Take the start reading on the local-only `turn_started` card. Take the done reading on done, racing a 2 s timer.
  - Keep the per-agent start reading in a `Map` cleared on done and on error.
- [ ] **Step 4: Run the tests again.** Run the same command, then `npm run typecheck`, then `npm run test:core`. Expected: PASS, with test:core at 100%.

### Task 2: Firmware tokens in the model

**Files:**
- Modify: `main/pod/pod_model.{h,c}`, `main/cable/pro_cable.c` (the `turn.stats` handler and `stat_of`), `main/app/pod_glue.{h,c}` and `main/app/pro_app.c` (the stats pass-through)
- Test: `test/test_pro_cable.c`, `test/test_pod_model.c`

**Interfaces:**
- Produces: `int32_t tokens_in, tokens_out` on `pod_agent_t` (-1 means unknown). These are set by the existing stats path, extended to `pod_model_turn_stats(pod_model_t *, const char *id, int32_t passed, int32_t failed, int32_t commits, int32_t tokens_in, int32_t tokens_out)`, and the same for `pod_ui_turn_stats` and `pro_app_turn_stats`.

- [ ] **Step 1: Write the failing tests.**
  - `turn.stats {tokensIn: 42900, tokensOut: 18500}` reaches the model.
  - `tokensIn: 50000001`, `-1` and `1.5` each refuse the whole message.
  - An absent field leaves -1.
  - `turn.started` clears both to -1.
- [ ] **Step 2: Run them and see them fail.** Run `export IDF_PATH=~/esp/esp-idf-5.5.4; bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement.** Extend `stat_of` bounds per field: 1 000 000 for tests and commits, 50 000 000 for tokens.
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/golden.sh --check`. Expected: PASS, and 295 match.

### Task 3: Fonts and logos for v2

**Files:**
- Modify:
  - `scripts/gen_fonts.py`, `main/display/pro_font_type.h`, `test/test_fonts.py`
  - `scripts/pod_gen_logos.py`, plus the generated `main/pod/engine_logos.{c,h}` (regenerate; do not hand-edit)
  - `main/pod/console/cs.h` and `cs_chrome.c`
- Test: `test/test_fonts.py`, `test/test_cs_views.c`

**Interfaces:**
- Produces:
  - Fonts:
    - `cs_md_30` (Inter Medium 30, from a committed `fonts/Inter-Medium.ttf` of the same Inter 4.1 release; record it in `fonts/README.md`)
    - `cs_sb_32`
    - `cs_rg_36`, `cs_rg_27`, `cs_rg_22`
    - `cs_mono_40`, `cs_mono_24`, `cs_mono_22`
    - remove any `cs_*` face no view uses after Task 4 (do the removal in Task 4's last step, re-running test_fonts)
  - Logos: `POD_LOGO_NSIZES` grows to 4 with the sizes 28, 36, 44, 72.
  - `bool cs_logo(ht_scene_t *, int x, int y, int size, const char *engine);` draws the baked logo, or falls back to `cs_badge` scaled to `size` when the engine has none. The return value means it was drawn.
- [ ] **Step 1: Write the failing tests.**
  - test_fonts: each new symbol exists, its height matches `ceil(size*1.375)` ±1, it inks "A ạ ố ữ", and the total is at most 640 000 bytes.
  - test_cs_views:
    - `cs_logo(…, 36, "claude")` draws an image run 36 × 36 and no text run;
    - `cs_logo(…, 44, "nosuchengine")` draws the badge, a rect plus a 2-letter text.
  - Generator: the bytes of the two new sizes are printed and at most 350 000 (assert in test_fonts.py, or in a new test_logos.py next to it).
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh && python3 test/test_fonts.py`. Expected: FAIL.
- [ ] **Step 3: Implement.** Find how Classic draws a logo through `pod_mark_chip` / `engine_logos` and reuse that blitter. Do not add a new image format.
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && python3 test/test_fonts.py && bash test/golden.sh --check`, then the idf build `idf.py -B build -DPROJECT_VER=0.0.99-pod -DPOD_PANEL_TURN=180 build`. Expected: PASS, 295 match, and report the size line.

### Task 4: Console views v2

**Files:**
- Modify:
  - `main/pod/console/cs_overview.c`
  - `cs_recent.c` (it becomes the shared row list)
  - `cs_tab.c` (it now uses the shared rows)
  - `cs_agent.c`, `cs_recap.c`
  - `cs_chrome.c` (`cs_working_mark`)
  - `classic/pod_view_recap.c` plus `main/pod/pod_view_shared.h` (factor the recap cut, Classic output identical)
  - `test/test_cs_views.c`, `test/golden.sh` (Console list), `test/golden-console*.txt` (regenerate)

**Interfaces:**
- Consumes: Task 2 tokens, Task 3 `cs_logo` and fonts.
- Produces:
  - `void cs_working_mark(ht_scene_t *, int x, int y, uint32_t now_ms);`: 4 bars, 5 px wide with 3 px gaps, 26 × 22 in `CS_RUN`. Each bar's height follows a triangle wave between 40 % and 100 % of 22 px, with a 900 ms period and phase offsets −200, −500, −100 and −700 ms.
  - `int cs_rows(pod_out_frame_t *, const pod_model_t *, const pod_agent_t *const list[], int n, int first, bool tab_col, uint32_t now_ms);` draws the Recent-style rows and returns how many it drew. Each row's hit is `POD_A_OPEN_AGENT` with the agent id.
  - `int pod_recap_cut(const char *recap, char *out, size_t cap);` lives in pod_view_shared. It is the Classic cut (same words and "…"), and returns the number of bytes written.
- Layout (exact values from the spec and mockup):
  - **Overview:** 2 × 2 cards, 338 × 277 at x 16 / 366, y 86 / 375. The name is `cs_sb_34`. Rows are 62 px: dot, 36 px logo, the name in `cs_md_30`, time in `cs_mono_22`. At most 3 rows per card. No minimap. 4 cards per page, page dots at y 652.
  - **Rows:** about 104 px tall:
    - a 44 px logo;
    - a mark: the working bars when WORKING, a dot otherwise;
    - the name in `cs_sb_32`;
    - the tab in `cs_rg_22`, only if `tab_col`;
    - time or "ask" in `cs_mono_24`, right-aligned;
    - the line in `cs_rg_27`, cut with "…".

    At most 5 rows; drag scroll shows the rest.
  - **Agent header (variant C):**
    - the bar crumbs are just the tab name;
    - a 170 × 130 pet box;
    - the name in `cs_sb_34`, cut with "…";
    - "state · m:ss" in Inter Medium 26 (use `cs_md_30` if no 26 face exists; do not add a face for it), with the time in `cs_mono_26`;
    - a 28 px logo, then "machine · pane i of n" in `cs_rg_20`.
  - **Agent working:** the header, then NOW plus the equaliser. No timeline.
  - **Agent asking:** the header, then the QUESTION card ("Answer in the Harness app"). No steps.
  - **Recap:**
    - the header;
    - SUMMARY: `pod_recap_cut` text in `cs_rg_36`, no scrolling;
    - tiles: TOKENS (wide, 1.9 fr: total in `cs_mono_40`, then "in x · out y" in `cs_mono_15`), DURATION, TESTS, COMMITS. Each is drawn only with data, and with none the row is gone.
- [ ] **Step 1: Write the failing tests** in test_cs_views:
  - Overview with 6 tabs: 4 cards and 2 pages, names drawn with `cs_md_30`, no badge text runs, at most 184 runs.
  - Rows:
    - a WORKING agent has 4 working-mark runs and no dot;
    - Tab rows have no tab-name run;
    - a 20-agent tab draws 5 rows, and `pod_scroll_max > 0`.
  - Agent:
    - the bar has 1 crumb;
    - the name is drawn in `cs_sb_34`;
    - a 120-character name is cut with "…";
    - working and asking have no "THIS TURN" / "LEADING UP TO IT" / "TOKENS" text.
  - Recap:
    - the summary equals `pod_recap_cut` of the same recap;
    - with tokens 61400 / 42900 / 18500 the text "61.4k" is drawn;
    - with every stat at -1 and no duration there are no tile runs, and no "·" in the header.
  - Classic recap goldens are unchanged (golden.sh).
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate the Console goldens. Render PNGs (as earlier tasks did) for overview, recent, tab, agent working / asking / done / done-bare, and compare them with the mockups. Drop unused `cs_*` faces and re-run test_fonts.
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/golden.sh --check && PRO_FONT=fonts/LiberationSans-Regular.ttf bash test/golden.sh --check && bash test/golden.sh --skin console --check` (both fonts), then `python3 test/test_fonts.py`. Expected: PASS, with 295 Classic matches.

### Task 5: Hands-free voice (Console)

**Files:**
- Modify: `main/app/pod_glue.{h,c}` (hold path, touch cancel), `main/pod/console/cs_talk.c` (full-screen hit, pill and hint), `main/app/pro_app.c` (only if cancel handling needs it)
- Test: `test/test_cs_glue.c`, `test/test_pro_app.py`

**Interfaces:**
- Produces: a `bool hands_free` field on `pod_ui_t`. It is set when the Console hold fires, and cleared by `VOICE_END`, `VOICE_ABORT`, `talk_over` and a skin switch.
  - While it is set, the lift of the holding contact is ignored.
  - A new DOWN then UP anywhere on Talk gives `POD_A_TALK`, which nav turns into `VOICE_END`.
  - `pod_ui_touch_cancel` no longer returns `VOICE_ABORT` for a hands-free recording.
- Talk screen copy: the pill reads "Tap anywhere to send", and the hint is `tap send`. There are no "release" or "slide" hints.
- [ ] **Step 1: Write the failing tests** in test_cs_glue:
  - hold → `VOICE_BEGIN`, then the lift → no effect, and Talk is still open;
  - a new tap anywhere (including over the bar crumb area at y 20) → `VOICE_END`;
  - a slide of dy +200 while holding → no abort;
  - a contact cancel after the hold → no abort;
  - the side button → discard (test_pro_app.py);
  - the orphan guard replay still closes an open recording with no Talk;
  - Classic is unchanged (its tap-to-talk paths).
  - Update the v1 tests that expected release-to-send and slide-to-cancel to the new behaviour, and list them.
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement.** Make the full-screen `POD_A_TALK` hit the last-registered hit on the Console Talk frame (hits are scanned last to first), so it wins over crumbs.
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/stress_pro_app.sh && bash test/golden.sh --skin console --check` (regenerate the talk goldens) and `bash test/golden.sh --check`. Expected: PASS.

### Task 6: Review, device check, docs

- [ ] **Step 1: Review.** An independent review on the strongest model covers the Task 1–5 diff: the voice task ordering (hands-free), token freshness and timeouts, Classic invariance and budgets. Fix the findings with tests.
- [ ] **Step 2: Flash and walk the screens.**
  - Build `idf.py -B build -DPROJECT_VER=0.0.99-pod -DPOD_PANEL_TURN=180 build`, then `FLASH_PORT=<port> bash scripts/flash.sh`.
  - Reinstall the dev CLI with `bash cli/scripts/install-cli.sh`.
  - Keep `uiSkin` as console (`harness hardware set … --patch '{"uiSkin":"console"}'` if needed).
  - The owner walks the 7 changed screens and runs a Claude turn that tests and commits. Check that TOKENS / TESTS / COMMITS appear on Recap.
  - Read `raster_max_us` / `frame_max_us` from the device log heartbeat on Overview.
- [ ] **Step 3: Update the docs.** Update `devices/harness-pro/README.md` (Console skin, gestures, the stats it shows) and the v1 spec's notes where v2 superseded them. PR, merge and release happen only when the owner asks.
