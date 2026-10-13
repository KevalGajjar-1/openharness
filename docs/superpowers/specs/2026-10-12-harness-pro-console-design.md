# Harness Pro · Console skin

Status: design · 2026-10-12 · owner 0xdiego25
Mockup: `devices/harness-pro/mockup/pro-console.html` (built by `mockup/pro-wow/build4.py`; mockups are gitignored)

## Goal

A second user interface for the Harness Pro, called **Console**. It follows the developer command-surface concept (Linear, Raycast, Vercel). The owner chooses it per device in the app. The current iPod-style UI stays, renamed **Classic**, and remains the default.

Console keeps nothing of Classic's layout:
- There is no transport bar.
- Navigation is spatial: Overview → Tab → Agent.
- The top bar is a set of breadcrumbs, and it becomes the input line while you talk.
- Voice is started by holding anywhere on the screen.

## Decisions (owner, 2026-10-12)

| Question | Decision |
|---|---|
| Replace Classic or run alongside? | **Alongside.** A per-device setting `uiSkin: "classic" \| "console"`. The default is `classic`. |
| Data the daemon does not send today (test and commit counts, step times) | **Add it in the daemon** (`turn.stats`). Step times: see "Step times" below. |
| Undo after releasing voice | **No undo.** Release sends. Sliding down while holding cancels. |

## Non-goals

- No change to Classic's look or behaviour: its 285 goldens stay byte-identical.
- No new pets, no background images, no JPEG or PPA use. Those belonged to the D–G directions, which were not chosen.
- No answering questions on the device. The device keeps pointing to the Harness app, as today.
- No support for the round dial.

## Screens

The mockup is the visual reference: sizes, colours and copy. Every screen is 720 × 720, upright; the 180° turn stays below the UI, in `pro_turn`.

| # | Screen | Built on | Notes |
|---|---|---|---|
| 1 | Overview | `TABS` view | A 3 × 2 grid of tab cards. Each card has the tab name and up to 3 agent rows (state dot, engine badge, name, time or "ask"). Its footer is a pane minimap plus a state badge. The first card is Recent. More than 6 tabs page horizontally. |
| 2 | Tab | `TAB` view (tab ≥ 0) | The tab's real pane split, from `rect[]`. Each pane is a tile: engine badge, name, state line with time, then the question (asking) or the current tool line (working) or the last activity (idle), and "pane N · machine". |
| 3 | Recent | `TAB` view (`POD_TAB_RECENT`) | A feed, newest first, up to 8 rows: age, dot, badge, name, tab, last activity line, time or "ask". |
| 4 | Agent · working | `AGENT` view | A hero: the pet in a 170 × 130 box, the name (48), "Running · m:ss", and "engine · machine · pane i of n". Below it, NOW (spinner + verb + argument, then the equaliser) and THIS TURN (a timeline of `steps[]`, newest first, each with its time). |
| 5 | Agent · needs you | `AGENT` view, state ASKING | The hero in amber, a QUESTION card ("Answer in the Harness app"), and LEADING UP TO IT (the steps, kept when the question arrives). No voice: the firmware refuses recording while a question is open, so a hold does not arm here. |
| 6 | Agent · done | `RECAP` view | The hero showing "Done · m:ss", SUMMARY (the recap, drag to scroll), and stat tiles: duration, steps, tests, commits. A tile without data is not drawn. |
| 7 | Voice · listening | `TALK` view | The bar turns violet and shows `[name]` plus the live transcript with a caret. The listening pet, a 36-bar wave driven by `pro_rec_level()`, and "Listening · m:ss". |
| 8 | Voice · sending | `TALK`, `sending` | A message card ("To name · tab · machine", the text, a progress line, "Sending…"). It stays until the turn starts or 30 s pass, as today. |
| 9 | Inbox | `INBOX` view | Grouped: NEEDS YOU (agents in ASKING), FINISHED (unread recaps), FAILED (turns that ended in `turn.error`). Unread rows have a violet left rule. |
| 10 | Toast | the banner (`pod_banner`) | Drops in under the bar for 6 s. A 3 px timer line runs along its bottom. Tap opens it; swipe up dismisses it (unchanged). |
| 11 | Update | `pod_view_ota` | "0.1.1 → 0.1.2", a progress bar with percent and time left, then a log of the fw_update stages: offer, accepted, written n / N with resends, verify sha, check, restart. |

The command bar (72 px) is on every screen:
- ◆, then breadcrumbs (every crumb but the last is tappable);
- the running count;
- the amber ▲ n chip, shown only when an agent is asking.

The hint strip (52 px, muted) runs along the bottom: up to 3 `kbd + label` pairs. It is text only, not buttons.

## Navigation and gestures

The Classic stack and actions in `pod_nav` stay. Console adds one action and changes how gestures map onto actions.

| Gesture | Overview | Tab / Recent | Agent / Recap | Talk |
|---|---|---|---|---|
| tap | open a tab | open a pane (agent) | — | — |
| tap a crumb | — | `BACK` to Overview | `BACK` to the tab | — |
| swipe ⇠ ⇢ (rules as today: ≥ 60 px, ≤ 700 ms or ≥ 600 px/s) | Overview page | `PREV` / `NEXT` **tab** (new for `TAB`) | `PREV` / `NEXT` pane (as today) | — |
| swipe down from the bar (start y < 72, ≥ 80 px, \|dy\| > 1.5\|dx\|) | — | `BACK` | `BACK` | — |
| hold ≥ 400 ms, moving ≤ 24 px, not on a crumb or chip | — | `VOICE_BEGIN` for the held pane's agent | `VOICE_BEGIN` for this agent | — |
| release after a hold | | | | `VOICE_END` (send) |
| slide down ≥ 120 px while holding | | | | `VOICE_ABORT` |
| ▲ chip | `POD_A_ATTENTION` (new): follow to the next agent in ASKING after the open one, in model order, wrapping | | | |
| side button tap | — | `BACK` one level (Console; Classic still goes home) | `BACK` | `VOICE_ABORT` (as today) |
| side button hold 0.8 s | screen off (unchanged) | | | |

Rules:
- **Hold vs scroll.** Hold and drag-scroll exclude each other. If the finger moves more than the slop before 400 ms, the touch is a drag. Once the hold has fired, vertical movement is read as cancel and never as scroll.
- **Offline.** The offline check before voice is unchanged; it shows the notice "That machine is offline".
- **Where talking lives.** Talking is only possible from the Agent, Recap and Tab screens. On Overview, Recent and Inbox a hold does nothing.

## Data

### Already on the device

All of these are used as they are:
- per agent: name, engine, machine, state, `elapsed_s` / `since_ms`, `activity`, `verb`, `steps[]`, `question`, `recap`;
- per tab: `rect[]` and `agent[]`;
- `unread[]`, `pod_model_recent`, `pro_rec_level()`;
- the fw_update stages.

### Device-side changes

- **More steps.** `POD_STEPS_MAX` goes from 3 to 6. Classic still draws at most 3, and only those since the turn or question began (`fresh_steps`), so Classic output is unchanged. `step_total` counts a turn's steps for the Recap STEPS tile (unknown, and the tile hidden, when the turn start was not seen). The timeline shows up to 4 on Agent and 2 on Ask. Memory: 32 agents × 3 more steps × 160 B ≈ 15 KB (PSRAM).
- **Step times.** Each stored step keeps `at_s`, the seconds since the turn started, taken from the step's arrival (`since_ms`). The daemon sends one step per frame as it happens, so the arrival time is the daemon's own clock plus a few ms of USB.
  - We do not add a protocol field for this. The value would be the same and only the CLI would change.
  - Steps rebuilt after a reconnect have no time, and the timeline leaves the column empty.
  - Owner: revisit if you want the daemon to send it anyway.
- **Failed turns.** A `failed` flag on the agent, set by `turn.error` and cleared by the next `turn.started`. The agent's state stays IDLE (Classic is unchanged), and the flag drives the Inbox FAILED group.
- **Inbox kinds.** `pod_unread_t` gets `kind` (finished, failed). NEEDS YOU and failed agents without an unread entry come from agent state and open through `POD_A_FOLLOW` (open an agent by id from anywhere).
- **Turn stats.** Per agent: `tests_passed`, `tests_failed`, `commits` (-1 means unknown), filled by `turn.stats` and cleared on `turn.started`.

### Daemon: `turn.stats` (new)

- **Capability.** The hello carries `stats: "turn-v1"`. Console firmware advertises it; Classic builds do too, since the field is harmless to them.
  - The session gates the send the way `stepsActivity` is gated (cableSession.ts:2632).
  - It is added to `capabilitiesNamed` and `resetCapabilities`.
- **Message.** `turn.stats {agentId, testsPassed?, testsFailed?, commits?}`. It is sent once, right before `turn.done`, and only for fields that have a value.
- **Source.** The daemon watches the turn's top-level shell tool calls (Bash for Claude, shell / exec for Codex). It pairs each `tool_start` command with its `tool_end`.
  - **commits:** count `tool_end` with `isError == false` whose command, after leading `cd …&&` / env assignments, runs `git commit`, with any flags except `--dry-run`. A failed commit (`isError`, or "nothing to commit" in its output) is not counted.
  - **tests:** parse the **last** test summary seen in the turn's shell output. The formats are:
    - vitest / jest `Tests: [n failed, ]n passed`;
    - pytest `n passed[, n failed] in`;
    - cargo `test result: … n passed; n failed`;
    - go `ok`/`FAIL` package lines, counted as packages;
    - mocha `n passing` / `n failing`;
    - this repo's firmware `test/run.sh` "… passed" lines.
  - No match leaves the fields absent; nothing is guessed.
- **Shell only.** `outputTail` is attached to shell tool results only (Claude `Bash`; Codex exec / shell), is stripped before anything leaves the machine (clients, history, gateway, Wi-Fi), and is read only by the device path. Commander also emits a local-only `turn_started` card so stats reset per turn.
- **Truncated output.** `tool_end.output` is cut to its **first** 2000 characters (claude normalize.ts:41/536, codex normalizer.ts), and summaries are printed last. So the claude and codex normalizers add `outputTail`: the last 600 characters of the raw output. The stats parser reads only `outputTail`. Other engines: no stats.
- **Wiring.** Commander ignores top-level `tool_end` today (commander.ts:495). It now forwards a `commander_event {kind:'tool_end', id, tool, command, isError, outputTail}` to device listeners only. Nothing else consumes it, and transcripts and the UI are unchanged.
  - A per-agent accumulator in `cli/src/cable/turnStats.ts` (new) collects these events and resets on turn start.
  - `devices.ts` calls the session's `turnStats(agentId, stats)` before `turnDone`.

### Settings: `uiSkin` (new)

- **Device.** `settings.state` / `settings.set` carry `uiSkin: "classic" | "console"`. It is stored in NVS under key `"skin"`, the default is `"classic"`, and an unknown value is refused (state unchanged).
  - Applied like the turn: between frames, with a full repaint, and a finger held across the change is swallowed. The nav stack is reset to its root.
- **Daemon.**
  - `DeviceSettings` and `readSettings` (refuse a malformed value);
  - `deviceSettingsPatchSchema` (`.strict()`, so the key must be added);
  - the local `dial_settings` path passes it through.
- **Desktop.** On Pro devices only, Device settings shows a row "Interface" with a segmented Classic | Console control (the `isPro` gate, next to "Rotate screen 180°"). `DialStatus` parses `uiSkin`.

## Firmware architecture

```
main/pod/            model, nav, glue-facing view API  (shared)
main/pod/classic/    today's pod_view_*.c + pod_chrome.c (moved, unchanged)
main/pod/console/    cs_chrome.c (bar, hints, dot, badge, timeline, tiles)
                     cs_overview.c cs_tab.c cs_recent.c cs_agent.c cs_recap.c
                     cs_talk.c cs_inbox.c cs_ota.c cs_toast.c
```

- **Dispatch.** `pod_view.c` dispatches on `(skin, view)`. `pod_out_frame_t` and the hit mechanism are shared, and the Console views register hits the same way (`pod_hit_add*`).
- **Glue.** `pod_glue.c` takes the skin. The gestures above are added behind `skin == CONSOLE`; Classic's paths stay byte-for-byte.
  - The hold fires on the touch task (the GT911 is polled every 4 ms while a finger is down), so voice begin, end and abort for a hold all run on one task. A contact cancelled after the hold fired (bad sample, turn, sleep) aborts the recording, and `pro_app_tick` discards any recording left open with no Talk screen.
- **Rounded corners.** `ht_pro_rect_aa(radius)` is new: anti-aliased corners, used only by Console. `ht_pro_rect` is untouched, so Classic goldens do not move.
- **Run budget.** `HT_RUNS` goes from 128 to 192; Classic views keep their 128 ladders through `POD_CLASSIC_RUNS`. Overview is the worst case, about 160 runs. Console screens assert ≤ 184 in tests, which leaves the toast its 16-run spare.
  - Scenes live in PSRAM. The extra cost is the damage diff over 64 more runs per frame, measured in the device check.
- **Fonts.**
  - `gen_fonts.py` learns several faces. Console faces are Inter (OFL) and JetBrains Mono (OFL); the TTFs and licences are committed under `fonts/`, so builds are reproducible.
  - The sizes form one scale:

    | Face | Sizes (px) |
    |---|---|
    | Inter SemiBold | 48, 34, 26, 22 |
    | Inter Regular | 24, 20, 17 |
    | JetBrains Mono Medium | 26, 18, 15 |

  - Coverage is the same as today: Latin-1 plus Vietnamese. Symbols are `cs_<face>_<size>`. Budget: ≤ 640 KB of flash in total; the build measured 608 KB (glyphs are cropped to their inked rows). The faces lack ⇠ ⇢, so hints use ← →. Console text skips Classic's mark-to-ASCII rewrite (`ht_display_text_ex`) so … ▲ ◆ ↑ ↓ ← → · ✓ draw.
  - Classic keeps its fonts and its build input (Helvetica or Liberation).
- **Engine badges.** Badges are drawn as a filled rounded rect with a two-letter code (CL, CO, MU, CU, …), coloured from a table keyed by engine. No new images.
- **Pets.** The Agent hero uses the existing `pod_cell` at zoom ≤ 1. Talk uses the listening clip, sending uses the sending clip, done uses the small "done" pose.

## Error handling and edge cases

- **Overflowing text.** A long agent, tab or tool name is cut by `ht_pro_text` (ellipsis). The question wraps to at most 4 lines and the recap scrolls. A step longer than its row is clipped at a codepoint.
- **Many tabs.** More than 6 tabs page the Overview with the existing grid paging.
- **Many panes.** A tab with more panes than tiles fit (more than 6) draws the first 6 by rect and a "+n" tile.
- **No rect data.** The minimap for a tab without `rect[]` falls back to equal columns. Tab view: rects are always known for the selected tab.
- **Losing the device link.** If the link is lost or the agent goes offline mid-hold, the voice abort follows the existing `pro_voice` paths. A hold on an offline agent shows the offline notice and does not start a recording.
- **Skin change.** A skin change during voice aborts the voice first.
- **Turn stats.** Absent stats show no tile. `turn.stats` for an unknown agent is ignored. Malformed numbers (negative, non-integer, > 1 000 000) are refused by the device parser.
- **Classic and the new message.** Classic ignores `turn.stats` except for storage, and ignores `uiSkin` values it does not know.

## Testing

**Firmware (`test/run.sh`, host):**
- `pod_render` gains `--skin console`. A Console golden set lives at `test/golden-console.txt`, with the Liberation variant at `test/golden-console-liberation.txt`. It covers all 11 screens plus edge cases: long names, more than 6 tabs and panes, no stats, offline, and the toast over each screen, each at 5 `now` values.
- `golden.sh --check` keeps Classic's 285 unchanged.
- A run-budget check: every Console screen is at most 184 runs, the worst case is printed, and toast plus screen is at most 192.
- `test_pod_glue`:
  - a hold fires at 400 ms and not at 399;
  - movement beyond the slop before 400 ms becomes a scroll, never a talk;
  - release sends;
  - sliding down 120 px aborts;
  - a swipe on TAB steps tabs;
  - a crumb tap goes BACK;
  - swipe down from the bar goes BACK;
  - ▲ follows to the ASKING agents in order;
  - the side button goes BACK in Console and home in Classic.
- `test_pod_nav`: `POD_ACT_ATTENTION`, tab stepping on TAB.
- `test_pro_cable`:
  - `uiSkin` set/state round trip and an unknown value refused;
  - `turn.stats` parse, bounds and an unknown agent;
  - the `turn.error` → failed flag;
  - step `at_s`.
- `test_fonts.py`: the new faces exist, have the right heights, ink, and Vietnamese coverage.
- `test_tree_isolation.py` still passes.

**CLI (vitest):**
- `turnStats.spec.ts`:
  - each runner format, including real tails from repo runs;
  - the last summary wins;
  - commit detection: `cd x && git commit -m`, env prefix, `--dry-run` not counted, failed commit not counted;
  - nothing guessed when nothing matches.
- `outputTail` in both normalizers.
- `cableSession.spec.ts`: `turn.stats` sent only with `stats:"turn-v1"`, before `turn.done`, absent fields dropped; `uiSkin` in `readSettings` and `setSettings`.
- `harnessDevices.spec.ts`: the schema accepts `uiSkin` and refuses other values.
- `devices.spec.ts`: the stats wiring.
- Locally: `npm run test:core` (devices.ts and fleetRouter.ts sit under its 100% gate).

**Desktop:** a widget test for the Interface row, shown on Pro devices only, that writes `uiSkin`.

**Device check (manual, with the owner):**
1. Flash with `scripts/flash.sh`, then switch skins from the app.
2. Walk all 11 screens on a live fleet.
3. Measure `raster_max` / `frame_max` on Overview, which should be under 30 ms, and the hold latency.

## Risk

This is **critical**:
- the cable protocol gets a new message and a new setting, a public contract between daemon builds and firmware builds;
- touch gesture concurrency changes (hold timer, voice start and cancel).

Phase 3 review runs on the strongest model, and the protocol pieces get the Phase 4 audit.

## Rollout

- Ship firmware and CLI in one PR, or the CLI first, since an old device ignores `turn.stats` and `uiSkin`.
- Firmware release as 0.2.0 through `make upload-pro`. The default skin stays Classic, so users opt in from the app.
- CLI release so `turn.stats` reaches users; Console works without it, minus the test and commit tiles.
