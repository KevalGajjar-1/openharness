# Harness Pro Console Skin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second Pro interface, Console. It is selectable per device as `uiSkin`. The daemon sends new `turn.stats` (tests, commits) for it.

**Architecture:**
- **Firmware.** The current views move unchanged into `main/pod/classic/`. Console views live in `main/pod/console/`. Both share `pod_model`, `pod_nav` and the hit/frame API. `pod_render` dispatches on `pod_nav_t.skin`, and the new gestures in `pod_glue.c` run only for the Console skin.
- **Daemon.** It reads shell tool results (via a new `outputTail`), keeps per-turn stats, and sends `turn.stats` before `turn.done` to devices that advertise `stats:"turn-v1"`.
- **Desktop.** It writes the `uiSkin` setting.

**Tech Stack:** C11 (ESP-IDF 5.5.4, host tests with clang and UBSan), Python 3 (font generator and tests), TypeScript (vitest), Dart/Flutter (desktop).

**Spec:** `docs/superpowers/specs/2026-10-12-harness-pro-console-design.md`. The mockup is `devices/harness-pro/mockup/pro-console.html`; it is gitignored, and copies sit in the main checkout. The mockup is the visual reference for sizes, colours and copy.

## Global Constraints

**Setting and persistence**
- The setting is `uiSkin: "classic" | "console"`. The default is `"classic"`, the NVS key is `"skin"`, and an unknown value is refused (state unchanged).

**Protocol**
- The hello cap is `stats: "turn-v1"`. The message is `turn.stats {agentId, testsPassed?, testsFailed?, commits?}`.
- It is sent once, right before `turn.done`, and fields without a value are omitted.
- The device refuses a number that is negative, non-integer, or greater than 1 000 000.

**Classic must not change**
- `bash test/golden.sh --check` must report 285 matches after every task.
- Classic code paths stay byte-for-byte; Console behaviour is gated on `skin == POD_SKIN_CONSOLE`.

**Rendering budgets**
- `HT_RUNS` = 192. Each Console screen is at most 184 runs; a toast plus a screen is at most 192.

**Fonts**
- Faces: Inter SemiBold 48 / 34 / 26 / 22, Inter Regular 24 / 20 / 17, and JetBrains Mono Medium 26 / 18 / 15.
- Coverage is Latin-1 plus Vietnamese, and the total is at most 500 KB of flash. The TTFs and their OFL licences are committed under `fonts/`.

**Gesture thresholds**
- Hold: at least 400 ms, moving no more than `POD_TAP_SLOP` (24 px).
- Voice cancel: a slide down of at least 120 px.
- Swipe down from the bar: start y < 72, travel ≥ 80 px, |dy| > 1.5|dx|.
- Horizontal swipe: the existing rules (≥ 60 px, ≤ 700 ms or ≥ 600 px/s).

**Data and layout**
- `POD_STEPS_MAX` = 6. The timeline shows up to 4 steps on Agent and 2 on Ask.
- The command bar is 72 px tall and the hint strip 52 px.

**Repo rules**
- Code and docs are in English, and comment density matches the surrounding code.
- Stage only your own files, and never flash except with `scripts/flash.sh`.

## Review Focus

These are the cases most likely to bite a user, and the task whose tests pin each one:

1. **A hold that becomes a scroll.** A finger that drifts more than 24 px before 400 ms on Recap or Tab must scroll and never start a recording. (Task 12)
2. **A skin switch mid-voice or mid-hold.** It must abort the voice, swallow the contact and reset nav to root, with no stuck "listening". (Task 4)
3. **Tool output where the summary sits in the first 2000 characters but the tail holds unrelated text.** Only the tail is parsed. A summary from an earlier command must not be counted twice, and the last summary wins. (Task 1)
4. **More than 6 panes, or a tab without `rect[]`.** The Tab view draws 6 tiles plus "+n", the minimap falls back to equal columns, and nothing overflows the run budget. (Tasks 8 and 9)
5. **`turn.stats` for an agent the device has not seen, or stats left over from the previous turn.** Unknown agents are ignored. `turn.started` clears the stats, and since the daemon sends `turn.stats` before `turn.done`, old numbers never show on a new turn. (Tasks 2 and 4)

---

## File map

| Area | Files |
|---|---|
| Daemon stats | create `cli/src/cable/turnStats.ts` and `.spec.ts`; modify `cli/src/engines/claude/normalize.ts`, `cli/src/engines/codex/normalizer.ts`, `cli/src/engines/kit/events.ts`, `cli/src/lib/commander.ts`, `cli/src/services/devices.ts`, `cli/src/cable/cableSession.ts` |
| Setting (daemon and desktop) | `cli/src/cable/cableSession.ts`, `cli/src/lib/harnessDevices.ts`, `desktop/lib/state/dial_status.dart`, `desktop/lib/devices/device_settings.dart`, plus their specs and tests |
| Firmware protocol and model | `main/cable/pro_cable.c`, `main/pod/pod_model.{h,c}`, `main/app/pod_glue.{h,c}`, `main/app/pro_app.c`, `main/sys/config_store.{h,c}`, `test/test_pro_cable.c`, `test/test_pod_model.c` |
| Firmware split and dispatch | move `main/pod/pod_view_*.c` and `pod_chrome.c` to `main/pod/classic/`; `main/pod/pod_view.c`, `main/pod/pod_nav.h`, `main/CMakeLists.txt`, `test/run.sh`, `test/golden.sh`, `test/pod_render.c` |
| Renderer | `main/display/terminal.h`, `main/display/pro_canvas.{h,c}`, `scripts/gen_fonts.py`, `fonts/`, `test/test_fonts.py`, `test/test_pod_draw.c` |
| Console views | create `main/pod/console/cs.h`, `cs_chrome.c`, `cs_overview.c`, `cs_tab.c`, `cs_recent.c`, `cs_agent.c`, `cs_recap.c`, `cs_talk.c`, `cs_inbox.c`, `cs_toast.c`, `cs_ota.c`; create `test/test_cs_views.c`, `test/golden-console.txt`, `test/golden-console-liberation.txt` |
| Gestures | `main/pod/pod_nav.c`, `main/app/pod_glue.c`, `main/app/pro_app.c`; create `test/test_cs_glue.c` |

---

### Task 1: Daemon turn-stats parser

**Files:**
- Create: `cli/src/cable/turnStats.ts`, `cli/src/cable/turnStats.spec.ts`

**Interfaces:**
- Produces:
  - `export interface TurnStatsFields { testsPassed?: number; testsFailed?: number; commits?: number }`
  - `export function parseTestSummary(tail: string): { passed: number; failed: number } | null`, which reads the **last** summary in `tail`
  - `export function isGitCommit(command: string): boolean`
  - `export class TurnStats` with:
    - `start(agentId: string): void` (reset)
    - `toolStart(agentId: string, id: string, command: string | undefined): void`
    - `toolEnd(agentId: string, id: string, isError: boolean, outputTail: string): void`
    - `take(agentId: string): TurnStatsFields` (returns and clears)

- [ ] **Step 1: Write the failing tests** in `turnStats.spec.ts`:
  - `parseTestSummary`:
    - `'Test Files  3 passed (3)\n      Tests  44 passed (44)'` → `{passed:44, failed:0}`
    - jest `'Tests:       2 failed, 31 passed, 33 total'` → `{31, 2}`
    - pytest `'==== 44 passed, 2 failed in 3.1s ===='` → `{44, 2}`
    - cargo `'test result: ok. 12 passed; 0 failed; 0 ignored'` → `{12, 0}`
    - mocha `'  9 passing (40ms)\n  1 failing'` → `{9, 1}`
    - go `'ok  \tpkg/a\t0.2s\nFAIL\tpkg/b\t0.1s\nok  \tpkg/c'` → `{2, 1}` (packages)
    - two summaries in one tail → the last wins
    - `'all good'` → `null`
  - `isGitCommit`:
    - true for `git commit -m "x"`, `cd cli && git commit -am x`, `GIT_AUTHOR_NAME=a git commit -m x`
    - false for `git commit --dry-run`, `git log`, `echo git commit`
  - `TurnStats`:
    - a Bash commit with `isError:false` counts 1;
    - `isError:true`, or output containing `nothing to commit`, counts 0;
    - two test runs keep the last;
    - `take` after `start` with no tools returns `{}`;
    - an unknown tool id in `toolEnd` is ignored.

- [ ] **Step 2: Run the tests and see them fail.** Run `cd cli && npx vitest run src/cable/turnStats.spec.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `turnStats.ts`.** Regexes per format, anchored to the summary words. For the go format, count `^ok\s` and `^FAIL\s` lines. `isGitCommit` strips leading `cd …&&` segments and `VAR=value` words, then matches `^git(\s+-C\s+\S+)?\s+commit\b` and rejects `--dry-run`. Keep a `Map<agentId, {commands: Map<id,string>, tests?, commits}>`.

- [ ] **Step 4: Run the tests and see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit** `feat(cli): parse turn test and commit stats for devices`.

### Task 2: Feed stats from tool results and send `turn.stats`

**Files:**
- Modify:
  - `cli/src/engines/kit/events.ts`: `tool_end` gains `outputTail?: string`
  - `cli/src/engines/claude/normalize.ts:520-551`
  - `cli/src/engines/codex/normalizer.ts:441-460`
  - `cli/src/lib/commander.ts:438-505`
  - `cli/src/services/devices.ts:264`
  - `cli/src/cable/cableSession.ts`: caps at `:580-610` and `:1110`; send next to `turnDone` at `:2701`
- Test:
  - `cli/src/engines/claude/normalize.spec.ts`
  - `cli/src/engines/codex/normalizer.spec.ts`
  - `cli/src/lib/commander.spec.ts`
  - `cli/src/services/devices.spec.ts`
  - `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Consumes: `TurnStats` (Task 1).
- Produces:
  - `commander_event {kind:'tool_end', id, tool, command?: string, isError: boolean, outputTail: string}`, for top-level tools only
  - `CableSession.turnStats(agentId: string, stats: TurnStatsFields): void`, which sends only if `this.statsTurn` (hello `stats==='turn-v1'`) and at least one field is set
  - `capabilitiesNamed` includes `'stats'`

- [ ] **Step 1: Write the failing tests.**
  - Normalizers: a 5000-character tool result keeps the first 2000 in `output` (unchanged) and puts the **last 600 raw characters** in `outputTail`. Output of 600 characters or fewer gives `outputTail === output`.
  - Commander: a top-level Bash `tool_start {command}` followed by `tool_end` emits `kind:'tool_end'` carrying the command. A subagent's `tool_end` keeps today's behaviour.
  - devices: `turn.started` → `stats.start`; tool events are fed in; on `turn.done`, `session.turnStats` is called **before** `turnDone` with `{testsPassed:44, testsFailed:0, commits:1}`.
  - cableSession:
    - with `PRO_HELLO` plus `stats:'turn-v1'`, `turnStats('a', {commits:1})` writes `{"type":"turn.stats","agentId":"a","commits":1}`;
    - without the cap it writes nothing;
    - an empty `{}` writes nothing;
    - `resetCapabilities` clears the flag.
- [ ] **Step 2: Run them and see them fail.** Run `cd cli && npx vitest run src/engines/claude/normalize.spec.ts src/engines/codex/normalizer.spec.ts src/lib/commander.spec.ts src/services/devices.spec.ts src/cable/cableSession.spec.ts`. Expected: the new cases fail.
- [ ] **Step 3: Implement.**
  - Add `outputTail` where `rawOutput` is still whole, before the slice at normalize.ts:536 and the codex equivalent.
  - Commander remembers `tool_start` input by id for top-level tools, and emits on `tool_end` to device listeners only, not into transcripts or UI streams.
  - devices.ts owns one `TurnStats` instance.
- [ ] **Step 4: Run them again.** Same command, and also `npm run test:core`. Expected: PASS, and test:core stays at 100%.
- [ ] **Step 5: Commit** `feat(cli): send turn.stats to devices that ask for it`.

### Task 3: `uiSkin` setting in daemon and desktop

**Files:**
- Modify:
  - `cli/src/cable/cableSession.ts:425-445` (DeviceSettings) and `:520-545` (readSettings)
  - `cli/src/lib/harnessDevices.ts:96-107`
  - `desktop/lib/state/dial_status.dart:30-106`
  - `desktop/lib/devices/device_settings.dart:200-209`
- Test:
  - `cli/src/cable/cableSession.spec.ts`
  - `cli/src/lib/harnessDevices.spec.ts`
  - `desktop/test/devices/device_settings_test.dart` (create it if it is absent, following the closest existing devices widget test)

**Interfaces:**
- Produces: `DeviceSettings.uiSkin?: 'classic' | 'console'` and Dart `String? uiSkin` on `DialStatus`. The row key is `devices-ui-skin-${device.key}`.

- [ ] **Step 1: Write the failing tests.**
  - `readSettings({uiSkin:'console'})` keeps it, and `readSettings({uiSkin:'neon'})` returns `undefined`.
  - `setSettings({uiSkin:'console'})` writes `settings.set` with it.
  - The schema accepts `{uiSkin:'classic'}` and rejects `{uiSkin:1}` and `{uiSkin:'x'}`.
  - Dart:
    - the Interface row shows only when `isPro`;
    - choosing Console calls `change` with `{'uiSkin':'console'}`;
    - `DialStatus.fromJson` parses `uiSkin`.
- [ ] **Step 2: Run them and see them fail.** Run `cd cli && npx vitest run src/cable/cableSession.spec.ts src/lib/harnessDevices.spec.ts` and `cd desktop && flutter test test/devices/`. Expected: FAIL.
- [ ] **Step 3: Implement.** Model it on `screenTurned`. The desktop row is labelled "Interface", with a segmented "Classic" / "Console" control placed after "Rotate screen 180°".
- [ ] **Step 4: Run them again.** Same commands. Expected: PASS.
- [ ] **Step 5: Commit** `feat: uiSkin device setting (daemon, desktop)`.

### Task 4: Firmware protocol and model (stats, skin, failed, steps)

**Files:**
- Modify:
  - `main/pod/pod_model.h:31-161` and `pod_model.c`
  - `main/cable/pro_cable.c`: hello `:217-223`, settings `:197`, new `turn.stats` handler
  - `main/app/pod_glue.{h,c}`
  - `main/app/pro_app.c:913-932`, next to the turn
  - `main/sys/config_store.{h,c}`
  - `main/app_main.c:49`
- Test: `test/test_pod_model.c`, `test/test_pro_cable.c`

**Interfaces:**
- Produces:
  - `#define POD_STEPS_MAX 6`
  - On `pod_agent_t`:
    - `uint16_t step_at_s[POD_STEPS_MAX]`, where `0xFFFF` means unknown
    - `bool failed`
    - `int32_t tests_passed, tests_failed, commits`, where -1 means unknown
  - `typedef enum { POD_UNREAD_FINISHED, POD_UNREAD_FAILED } pod_unread_kind_t;` with `pod_unread_t.kind`
  - `void pod_model_turn_stats(pod_model_t *, const char *id, int32_t passed, int32_t failed, int32_t commits);` where -1 leaves a field unknown
  - `pod_out_t pod_ui_turn_stats(pod_ui_t *, const char *id, int32_t passed, int32_t failed, int32_t commits);`
  - `int config_load_skin(int fallback); bool config_save_skin(int skin);`
  - `void pro_app_request_skin(int skin); bool pro_app_apply_skin(void);`, applied between frames like the turn
  - `typedef enum { POD_SKIN_CLASSIC = 0, POD_SKIN_CONSOLE = 1 } pod_skin_t;` in `pod_nav.h`, plus the field `pod_skin_t skin` on `pod_nav_t` (zero-init stays Classic)

- [ ] **Step 1: Write the failing tests.**
  - `test_pod_model.c`:
    - each step stores `at_s = (now - since_ms)/1000`;
    - steps rebuilt with no turn start get `0xFFFF`;
    - with 7 steps the oldest is dropped (keep 6);
    - `turn.error` sets `failed` and keeps the state IDLE;
    - the next `turn.started` clears `failed` and the stats;
    - stats for an unknown id leave the model unchanged;
    - the unread entry made by an error turn has kind `POD_UNREAD_FAILED`.
  - `test_pro_cable.c`:
    - the hello contains `"stats":"turn-v1"`;
    - `turn.stats {agentId:"a", testsPassed:44, testsFailed:0, commits:1}` reaches the model;
    - `testsPassed:-1`, `1.5` and `1000001` are each refused, leaving the field unchanged;
    - `settings.set {uiSkin:"console"}` calls `pro_app_request_skin(1)`, and `settings.state` reports it;
    - `{uiSkin:"neon"}` is refused.
  - `test_pro_app.py`: `pro_app_request_skin(1)` while voice is open ends the voice (discarded), swallows the held contact, leaves nav at depth 1 with `skin == CONSOLE`, and the next frame is a full repaint.
- [ ] **Step 2: Run them and see them fail.** Run `cd devices/harness-pro/firmware && bash test/run.sh`. Expected: FAIL in test_pod_model and test_pro_cable.
- [ ] **Step 3: Implement.** Stats are stored per agent and cleared in the `turn.started` branch of `pod_model_turn`.
  - `pro_app_apply_skin` swallows a held contact (`s_turn_swallow` pattern) and forces a full repaint.
  - If voice is open, it calls `pro_voice_end(false)` first, then sets `nav.skin` and resets the nav to root.
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/golden.sh --check`. Expected: all pass, and 285 goldens match.
- [ ] **Step 5: Commit** `feat(pro): turn.stats, uiSkin setting, failed turns, six steps with times`.

### Task 5: Split Classic and add skin dispatch

**Files:**
- Move, with `git mv` and no edits beyond include paths:
  - `main/pod/pod_view_{tabs,tab,agent,recap,talk,inbox,ota}.c` → `main/pod/classic/`
  - `main/pod/pod_chrome.c` → `main/pod/classic/`
- Modify:
  - `main/pod/pod_view.c`, which dispatches `if (nav->skin == POD_SKIN_CONSOLE) cs_render(...) else` today's switch
  - `main/CMakeLists.txt`, `test/run.sh`, `test/golden.sh`, `test/pod_render.c`
  - `test/test_tree_isolation.py`, only if its path rules need it
- Create: `main/pod/console/cs.h`, declaring `void cs_render(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);`, and `main/pod/console/cs_view.c`, a stub that draws only the background `#08090A`

**Interfaces:**
- Produces:
  - `cs_render`
  - `pod_render --skin console <screen> <out.ppm> [now]`
  - `golden.sh [--skin console] [--check]`, which uses `test/golden-console*.txt` for Console

- [ ] **Step 1: Write the failing check.** `pod_render --skin console tabs out.ppm` must exit 0 and produce a 720×720 image whose pixel (10,10) is `#08090A`. Add this as a case in `test/run.sh`.
- [ ] **Step 2: Run it and see it fail.** Run `bash test/run.sh`. Expected: FAIL (unknown option).
- [ ] **Step 3: Implement** the move, the dispatch and the flag.
- [ ] **Step 4: Run it again.** Run `bash test/run.sh && bash test/golden.sh --check && idf.py -B build -DPROJECT_VER=0.0.99-pod -DPOD_PANEL_TURN=180 build`. Expected: all pass, 285 match, and the firmware builds.
- [ ] **Step 5: Commit** `refactor(pro): Classic views in their own folder; skin dispatch`.

### Task 6: Renderer: run budget, AA rounded rect, Console fonts

**Files:**
- Modify:
  - `main/display/terminal.h:16`: `HT_RUNS 192`
  - `main/display/pro_canvas.{h,c}`
  - `scripts/gen_fonts.py`
  - `main/CMakeLists.txt:96-135`
  - `main/display/pro_font_type.h:15`
  - `test/test_fonts.py`, `test/test_pod_draw.c`
- Add:
  - `fonts/Inter-SemiBold.ttf`, `fonts/Inter-Regular.ttf`, `fonts/JetBrainsMono-Medium.ttf`
  - `fonts/LICENSE-Inter.txt`, `fonts/LICENSE-JetBrainsMono.txt`
  - Fetch each from its upstream release at a pinned version and record the URL and sha256 in `fonts/README.md`.

**Interfaces:**
- Produces:
  - `bool ht_pro_rect_aa(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t ink);`, with an anti-aliased corner coverage blended onto the colour under it, the same way `pod_arc` does
  - Font symbols (`extern const ht_pro_font_t`):
    - `cs_sb_48`, `cs_sb_34`, `cs_sb_26`, `cs_sb_22`
    - `cs_rg_24`, `cs_rg_20`, `cs_rg_17`
    - `cs_mono_26`, `cs_mono_18`, `cs_mono_15`

- [ ] **Step 1: Write the failing tests.**
  - `test_fonts.py`:
    - each `cs_*` symbol exists;
    - its height matches the size within ±1;
    - `ink('A') > 0`;
    - "ạ ố ữ" are covered;
    - all `cs_*` atlases together are at most 500 KB.
  - `test_pod_draw.c`: an r=16 `ht_pro_rect_aa` on black has a corner pixel at (x+1, y+1) whose value lies strictly between the background and the ink, and its centre pixel equals the ink.
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement.** `gen_fonts.py` takes a list of `(symbol, ttf, size)` and keeps the Classic entries unchanged.
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/golden.sh --check && PRO_FONT=fonts/LiberationSans-Regular.ttf bash test/golden.sh --check`, then the idf build from Task 5. Expected: pass, and record the image size growth in the commit message.
- [ ] **Step 5: Commit** `feat(pro): AA rounded rects, Console typefaces, 192-run scenes`.

### Task 7: Console chrome and golden set

**Files:**
- Create:
  - `main/pod/console/cs_chrome.c`, plus declarations in `cs.h`
  - `test/test_cs_views.c`
  - `test/golden-console.txt` and `test/golden-console-liberation.txt`, generated
- Modify: `test/run.sh`, `test/golden.sh`

**Interfaces:**
- Produces, in `cs.h`:
  - the colour constants `CS_GROUND 0x08090A`, `CS_SURFACE 0x111214`, `CS_BORDER 0x1E2024`, `CS_INK 0xEDEEF0`, `CS_MUTED 0x8A8F98`, `CS_RUN 0x3DD68C`, `CS_ASK 0xF5A524`, `CS_FAIL 0xF2555A`, `CS_FOCUS 0x7C6CFF`
  - `void cs_bar(pod_out_frame_t *, const char *const crumbs[], int n, int running, int asking, const char *input, uint32_t now_ms);`
    - `input == NULL` means breadcrumbs. Every crumb but the last registers `POD_ACT_BACK` (the arg is the number of levels).
    - The chip registers `POD_ACT_ATTENTION`.
  - `void cs_hints(pod_out_frame_t *, const char *const keys[], const char *const labels[], int n);`
  - `void cs_dot(ht_scene_t *, int cx, int cy, char state /* 'g','q','d','r','i' */, uint32_t now_ms);`
  - `void cs_badge(ht_scene_t *, int x, int y, const char *engine);`: 28 × 28, r 7. Codes are CL, CO, MU, CU, and the first two letters uppercased otherwise.
  - `int cs_timeline(ht_scene_t *, int x, int y, int w, const pod_agent_t *, int max_items);`, which returns the height used
  - `int cs_runs(const pod_out_frame_t *);`, a counter used by the budget test
  - `POD_ACT_ATTENTION` is added to `pod_action_t` in `pod_nav.h`, with no behaviour yet (Task 11)

- [ ] **Step 1: Write the failing tests** in `test_cs_views.c`:
  - `cs_bar` with `{"Overview","Backend"}` registers one BACK hit covering "Overview" and none for "Backend";
  - with `asking == 0` there is no ATTENTION hit;
  - with `input = "make the"` there are no crumb hits and the bar fill is `#14122a`;
  - `cs_badge("claude")` draws the text "CL";
  - `cs_timeline` with 6 steps and `max_items = 4` draws 4 rows, and a step whose `at_s == 0xFFFF` draws no time run.
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `ht_pro_rect_aa`, the `cs_*` fonts, and `ht_pro_text` for every clipped string.
- [ ] **Step 4: Run them again.** Run `bash test/run.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pro): Console chrome (bar, hints, dots, badges, timeline)`.

### Task 8: Overview and Recent

**Files:**
- Create: `main/pod/console/cs_overview.c`, `cs_recent.c`
- Modify: `cs_view.c` (dispatch `TABS` → overview, and `TAB` with `POD_TAB_RECENT` → recent), `test/test_cs_views.c`, `test/golden.sh` (Console screen list)

**Interfaces:**
- Consumes: Task 7 chrome; `pod_model_recent`, `pod_tabs_pages`, `pod_hit_add_id`.
- Produces:
  - `void cs_view_overview(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);` and `void cs_view_recent(...)`, with the same parameters
  - Card hits are `POD_ACT_OPEN_TAB` with the tab id; Recent rows are `POD_ACT_OPEN_AGENT` with the agent id.
- Layout: from the mockup.
  - Cards are 3 × 2 with a 12 px gap, inset 16 px, 276 px tall.
  - Each card has up to 3 rows and a footer with the minimap plus a badge.
  - Recent shows up to 8 rows, 68 px each.

- [ ] **Step 1: Write the failing tests.**
  - Overview with the pod_render `mock` fleet:
    - 6 cards, the first titled "Recent";
    - a tab with an ASKING agent shows the badge "1 ask";
    - the run count is at most 184 (`cs_runs`).
  - 8 tabs give 2 pages.
  - A tab with no `rect[]` draws a minimap of equal columns (n rects with equal widths).
  - Recent: 8 rows, newest first; an ASKING agent's time column reads "ask".
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/golden.sh --skin console` (this writes the first baselines), then `--skin console --check`. Expected: PASS. Look at the PNGs (`python3 test/pod_render.py`) against mockup screens 01 and 03.
- [ ] **Step 5: Commit** `feat(pro): Console Overview and Recent`.

### Task 9: Tab view (real panes)

**Files:**
- Create: `main/pod/console/cs_tab.c`
- Modify: `cs_view.c`, `test/test_cs_views.c`, `test/golden.sh`

**Interfaces:**
- Produces: `void cs_view_tab(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);`. Tile hits are `POD_ACT_OPEN_AGENT` with the agent id.
- Tile content by state:
  - ASKING: the question, wrapped to at most 4 lines.
  - WORKING: a spinner plus the first step, or the activity.
  - IDLE / DONE: the last activity, dimmed, plus "Nm ago".
  - Every tile has the footer "pane i · machine".

- [ ] **Step 1: Write the failing tests.**
  - With the 3-pane Backend fixture: tile rects follow `rect[]` (0..1000 scaled into 688 × 564 at 16, 88) with a 12 px gutter.
  - The ASKING tile has an amber border (`#5a4210`).
  - 8 panes give 6 tiles plus one "+2" tile.
  - The run count is at most 184.
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/golden.sh --skin console --check`, after regenerating with the new screens added. Compare against mockup screen 02.
- [ ] **Step 5: Commit** `feat(pro): Console Tab view drawn from the real pane split`.

### Task 10: Agent, Recap, Talk, Inbox, Toast, Update

**Files:**
- Create: `main/pod/console/cs_agent.c` (working and asking), `cs_recap.c`, `cs_talk.c`, `cs_inbox.c`, `cs_toast.c`, `cs_ota.c`
- Modify: `cs_view.c`, `test/test_cs_views.c`, `test/golden.sh`

**Interfaces:**
- Consumes: `pod_cell` for pets, `pro_rec_level()` through the frame (pass the level in `pod_out_frame_t` as a new field `int mic_level` that the glue fills; no other caller), and the fw_update stage and progress already read by `pod_view_ota`.
- Produces: `cs_view_agent`, `cs_view_recap`, `cs_view_talk`, `cs_view_inbox`, `cs_view_ota`, all with the view signature above, and `void cs_toast(pod_out_frame_t *, const pod_model_t *, const pod_unread_t *, uint32_t now_ms);`. The glue calls `cs_toast` instead of `pod_banner` when the skin is Console. Its tap and swipe hits are the same as the banner's.
- Copy, exactly as in the spec and mockup:
  - "NOW", "THIS TURN", "QUESTION", "LEADING UP TO IT", "SUMMARY"
  - "Answer in the Harness app", "or hold to answer by voice"
  - "Listening · m:ss", "Sending…"
  - "NEEDS YOU", "FINISHED", "FAILED"
  - "tap to open", "swipe ↑ to dismiss"

- [ ] **Step 1: Write the failing tests.**
  - Agent working: 4 timeline rows from 6 steps; "Running" in `CS_RUN`.
  - Ask: "QUESTION" card and 2 rows.
  - Recap:
    - with `tests_passed = 54`, `commits = 0` it draws 4 stat tiles;
    - with all -1 it draws 2 (duration, steps);
    - a 2048-byte recap scrolls (`pod_scroll_max > 0`).
  - Talk:
    - a `mic_level` of 0 and of 4 draws different wave heights;
    - the sending state shows "Sending…".
  - Inbox:
    - an ASKING agent and a failed unread give the group order NEEDS YOU, FINISHED, FAILED;
    - an empty group is not drawn.
  - Toast: screen plus toast is at most 192 runs on every Console screen.
  - Update: "0.1.1 → 0.1.2" and 62 %.
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/golden.sh --skin console --check` (regenerate with all screens and edge cases: long names, offline, no stats, toast over each screen), plus the Liberation variant. Compare against mockup screens 04–11.
- [ ] **Step 5: Commit** `feat(pro): Console agent, recap, voice, inbox, toast and update screens`.

### Task 11: Navigation: attention and tab stepping

**Files:**
- Modify: `main/pod/pod_nav.c:63-208`
- Test: `test/test_pod_nav.c`

**Interfaces:**
- Consumes: `pod_nav_follow`, `pod_model_recent`.
- Produces:
  - `POD_ACT_ATTENTION`: from any view but TALK, it follows to the first ASKING agent after the current one in `pod_model_recent` order, wrapping round, and does nothing if none is asking.
  - `PREV` / `NEXT` on `TAB` (Console only) step the tab, wrapping round the tab list and skipping Recent.
  - `BACK` with `arg = n` pops n levels (0 or 1 means one, as today).

- [ ] **Step 1: Write the failing tests.**
  - Two asking agents A and B: ATTENTION from Overview opens A, and again opens B, then A.
  - With none asking, nothing happens.
  - In Classic, NEXT on TAB is unchanged (today's behaviour). In Console, NEXT on TAB moves to the next tab and wraps.
  - `BACK` with arg 2 from AGENT reaches TABS.
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement**, gated on `nav->skin` where the spec says Console only.
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/golden.sh --check`. Expected: PASS, 285 match.
- [ ] **Step 5: Commit** `feat(pro): attention jump and tab stepping for Console`.

### Task 12: Gestures: hold to talk, slide to cancel, crumbs, swipe down, side button

**Files:**
- Modify:
  - `main/app/pod_glue.c:186-457`
  - `main/app/pod_glue.h`: `POD_HOLD_MS 400`, `POD_HOLD_CANCEL 120`, `POD_BAR_H 72`, `POD_BAR_SWIPE 80`
  - `main/app/pro_app.c:738-764`, side button
- Create: `test/test_cs_glue.c`, added to `test/run.sh`

**Interfaces:**
- Consumes: the nav actions (Task 11) and the `POD_FX_VOICE_*` effects.
- Produces:
  - `pod_out_t pod_ui_tick(pod_ui_t *, uint32_t now_ms);` fires the hold when its deadline passes. `pro_app` calls it on each wake, and `pod_ui_next_wake` includes the hold deadline while a contact is down.

- [ ] **Step 1: Write the failing tests** in `test_cs_glue.c`, driving `pod_ui_touch` and `pod_ui_tick` with synthetic times:
  - on Agent:
    - DOWN, then tick at +399 → nothing; at +400 → `POD_FX_VOICE_BEGIN` for that agent;
    - UP → `VOICE_END`;
    - DOWN, hold fires, then MOVE dy = +120 → `VOICE_ABORT`, and a following UP sends nothing;
    - DOWN, MOVE 30 px at +200, tick at +500 → no voice. On Recap the same contact scrolls.
  - DOWN at y = 20 then MOVE dy = +90 → BACK.
  - On Tab, a left swipe → NEXT tab; a hold on a tile → VOICE_BEGIN for that tile's agent.
  - A hold on Overview, Recent or Inbox → nothing.
  - A hold on a crumb or the chip → no voice, and a tap there still works.
  - Offline agent: the hold gives the notice "That machine is offline" and no `VOICE_BEGIN`.
  - In Classic the same sequences give today's results (no hold, the swipe-down does nothing).
  - Side button: in Console → BACK one level; in Classic → home (unchanged).
- [ ] **Step 2: Run them and see them fail.** Run `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The glue keeps `hold_due_ms`, `hold_fired` and the down position. Once the hold has fired, vertical movement is cancel-only: no scroll is applied after it fires.
  - Every new path is gated on `nav.skin == POD_SKIN_CONSOLE`.
- [ ] **Step 4: Run them again.** Run `bash test/run.sh && bash test/golden.sh --check && bash test/golden.sh --skin console --check && bash test/stress_pro_app.sh`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(pro): Console gestures (hold to talk, slide to cancel, crumbs, swipe down)`.

### Task 13: Device check, docs, release prep

**Files:**
- Modify:
  - `devices/harness-pro/README.md`: Console skin, setting, gestures
  - `devices/harness-pro/firmware/docs/size-baseline.txt`: new image size, `raster_max` / `frame_max` on Overview
  - the port inventory and spec bullets that list Pro settings and cable messages, wherever `screenTurned` is documented today (`grep -rn screenTurned docs devices/harness-pro`)

- [ ] **Step 1: Build and flash.** Run `idf.py -B build -DPROJECT_VER=0.0.99-pod -DPOD_PANEL_TURN=180 build`, then `FLASH_PORT=<port> scripts/flash.sh` (it checks the chip and MAC).
- [ ] **Step 2: Walk it with the owner.** Run the dev CLI (`bash cli/scripts/install-cli.sh`). Switch to Console from the desktop app, walk all 11 screens on a live fleet, and confirm `turn.stats` tiles after a turn that ran tests and committed.
- [ ] **Step 3: Measure.** Read `raster_max` and `frame_max` from the heartbeat log on Overview. Expected: under 30 ms. Also measure the hold-to-listening latency.
- [ ] **Step 4: Update the docs** listed above.
- [ ] **Step 5: Commit** `docs(pro): Console skin`. PR, merge and the 0.2.0 release happen only when the owner asks.
