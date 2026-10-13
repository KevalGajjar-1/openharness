# Harness Pro · Console v2 (device-check changes)

Status: design · 2026-10-12 · owner 0xdiego25
Builds on: `2026-10-12-harness-pro-console-design.md`, which is implemented on branch `feat/pro-console` and uncommitted. That spec still holds wherever this one is silent.
Mockups (gitignored): `devices/harness-pro/mockup/pro-console-v2.html` (built by `mockup/pro-wow/build5.py`) and, for the Agent header, `pro-console-agent.html` variant **C** (built by `build6.py`). v1 for comparison: `pro-console.html`.

## Why

The owner tried Console on a real Pro (E8:F6:0A:E7:64:61) and asked for:
- bigger type;
- the real engine logos instead of two-letter badges;
- fewer, larger cards;
- one row style for Recent and Tab;
- a different voice gesture;
- token burn in place of steps, shown only once a turn is done.

## Changes by screen

| Screen | v1 (built) | v2 |
|---|---|---|
| Overview | 3 × 2 cards; agent names in `cs_rg_20`; two-letter badges | **2 × 2 cards per page** (each 338 × 277 at x 16 / 366, y 86 / 375). Tab name in `cs_sb_34`. Agent rows are 62 px: dot, **36 px logo**, name in **Inter Medium 30**, time in `cs_mono_22`. Up to 3 rows per card. The minimap footer is dropped. Pages hold 4 cards each, with page dots above the hint strip. |
| Recent | 68 px rows, `cs_rg_20` name, `cs_rg_17` line | Rows are about 104 px: **44 px logo**, mark, name in **Inter SemiBold 32**, tab name in `cs_rg_22`, time or "ask" in `cs_mono_24`, and the line in **Inter Regular 27**. The mark is the **4 green bars when working** and a dot otherwise. Up to 5 rows show, and drag scrolls through the rest. |
| Tab | the real pane split as tiles | **The Recent row style** for the tab's panes, in pane order, without the tab name. Tap opens the agent. Hold talks to that row's agent, as v1 did for tiles. |
| Agent header (working, asking, done) | the bar shows `Tab / name`; the hero has the name in `cs_sb_48` | **The bar names only the tab** (one crumb, `POD_A_BACK`). The hero keeps the pet box (170 × 130), then:<br>- the **name in `cs_sb_34`**, one line, cut with an ellipsis;<br>- **state · time** in Inter Medium 26, with the time in `cs_mono_26`;<br>- the **28 px logo**, then "machine · pane i of n" in `cs_rg_20`.<br>A time that is unknown is not drawn (no "·"). |
| Agent · working | hero, NOW plus equaliser, THIS TURN timeline | Header, NOW plus equaliser. **No steps and no tokens.** |
| Agent · needs you | hero, QUESTION, LEADING UP TO IT | Header and QUESTION ("Answer in the Harness app"). **No steps and no tokens.** |
| Agent · done (Recap) | hero, SUMMARY scrolling, tiles DURATION / STEPS / TESTS / COMMITS | Hero, then SUMMARY **cut like Classic** (same words and "..."; with the tile row present it may stop a line earlier): the same cut and "…" as `classic/pod_view_recap.c`, with no scrolling, in **Inter Regular 36**. Then a tile row: **TOKENS** (a wide tile: total in `cs_mono_40` plus "in x · out y"), DURATION, TESTS, COMMITS. A tile without data is not drawn, and with no data at all the whole tile row is gone (the mockup's "Done · no numbers"), as is the header's time. |
| Voice · listening | hold to start, release to send, slide down to cancel | **Hold to start; the lift does not send.** Recording continues hands-free, and **a tap anywhere sends** (`VOICE_END`). There is no slide-to-cancel. The side button still discards, and the 600 s cap still sends. The screen shows a "Tap anywhere to send" pill, and the hint is "tap send". |
| Voice · sending, Inbox, Toast, Update, bar, hints | — | unchanged |

**The working mark.** It replaces the green dot in Recent and Tab rows, and nowhere else.
- It is four 5 px bars with 3 px gaps, 26 × 22 px in total, coloured `CS_RUN` and anchored at the bottom.
- Each bar's height follows its own triangle wave between 40 % and 100 %. The periods are 900 ms, offset -200, -500, -100 and -700 ms.
- It is drawn from `now_ms`. Any working row on screen keeps the view's existing 33 ms wake, and the damage is small (26 × 22 per row).

**Inbox.** Inbox rows keep the v1 badges, swapped for the 36 px logo, because the Inbox layout does not change.

## Data

### Turn tokens (new, daemon)

- **Field.** `turn.stats` gains `tokensIn?` and `tokensOut?`, the tokens this turn consumed. It is sent once, before `turn.done`, under the existing `stats:"turn-v1"` cap.
  - There is no new message. A device that does not know the fields ignores them; the firmware parser already ignores unknown keys, and Task 4's handler is extended.
- **Source.** The conversation's cumulative usage, `CoreApi.usage(target)` → `AgentTokenUsage {inputTokens?, outputTokens?}` (cli/src/lib/agentUsageWire.ts). It is read the way `answerAgentQuery` reads it (cli/src/core/agentQueries.ts:16).
  - The device path takes a reading when the turn starts (the local-only `turn_started` card) and another when the turn is done.
  - The values sent are the differences: `tokensIn = in₁ - in₀` and `tokensOut = out₁ - out₀`.
- **When a field is omitted:**
  - either reading is missing, for example an engine without usage (only claude, codex and opencode have it) or a remote-machine agent;
  - a difference is negative, for example after a transcript rewrite;
  - a difference exceeds 50 000 000.
- **Freshness.** Usage refreshes every 15 s (`USAGE_REFRESH_MS`). The reading at done must not be a cached value older than the turn's last event.
  - Use the cache's fresh `read(target)` path (`AgentTokenUsageCache.read`), not `get`.
  - If the read takes more than 2 s, send `turn.stats` without tokens rather than holding back `turn.done`.
- **Firmware.**
  - `pod_agent_t` gains `int32_t tokens_in` and `int32_t tokens_out` (-1 means unknown). They are cleared on `turn.started` and filled by `turn.stats`.
  - The bounds check is 0..50 000 000, whole numbers only; a bad value refuses the message, as the existing stats fields do.

### Steps

The model keeps `steps[]`, `step_total` and `fresh_steps`, because Classic uses them. Console no longer draws them.

## Firmware

- **Logos.** `scripts/pod_gen_logos.py` adds sizes **36 and 44** to `POD_LOGO_NSIZES`, from the same `.github/assets/engines/*.png`.
  - Budget: at most 350 KB of flash for the two new sizes over all engines. The current image is 0x2778a0 with 69 % of the slot free.
  - Console views draw logos with the existing logo blitter (find the Classic `pod_mark_chip` path). An engine with no logo falls back to the v1 badge.
- **Fonts.**
  - New faces: Inter Medium 30, Inter SemiBold 32, Inter Regular 27 / 36 / 22, JetBrains Mono Medium 22 / 24 / 40.
  - Faces nothing uses any more are dropped (check after the views change).
  - The font total stays at or under 900 KB (owner: flash is plentiful; 879 KB measured). `cs_sb_48` (Update version only) and `cs_mono_24` (times) are cut to the characters they draw. If it would not, the 36 and 40 faces are cut to the characters they need: digits, ".kKmM" and space for mono 40, and the full set for Inter 36.
- **Voice.** In Console, when the hold fires, the glue enters a "listening, hands-free" state. The contact's lift is ignored, and the next tap (DOWN then UP on the Talk screen, anywhere) performs `VOICE_END`.
  - The Talk view registers one full-screen `POD_A_TALK` hit while listening in Console.
  - Leaving Talk by the side button discards, as today. A send tap for an agent whose machine went offline discards with the notice "That machine is offline". Cancelling the contact (bad sample, turn, sleep) **does not** abort a hands-free recording any more, since the finger is no longer the control. The orphan guard in `pro_app_tick` still applies.
- **Recap length.** The Classic cut function is factored out of `classic/pod_view_recap.c` into `pod_view_shared` (or reused if it is already shared), so both skins cut the same way.
- **Unchanged.** The cable `uiSkin` handling, nav, attention, Inbox, toast and OTA stay as v1 built them.

## Tests

**Firmware.**
- Console goldens are regenerated for every changed screen. Classic stays at 295 matches in both fonts.
- `test_cs_views`:
  - Overview has 4 cards per page and 2 pages for 6 tabs; names use the 30 px face; a logo is drawn and there is no badge text.
  - Recent and Tab rows draw the bars for WORKING and a dot otherwise; there is no tab-name run on Tab.
  - The Agent working and Ask screens have no timeline and no TOKENS label.
  - Recap: the cut text equals Classic's cut for the same recap; TOKENS shows only with `tokens_in >= 0`; all budgets stay at or under 184 runs.
- `test_cs_glue`:
  - hold → listening; the lift sends nothing; a tap anywhere sends `VOICE_END`;
  - the side button discards;
  - a contact cancel after the hold no longer aborts;
  - the orphan guard still closes a recording left open with no Talk screen.
- `test_pro_cable`: `turn.stats` with `tokensIn` / `tokensOut` in and out of bounds.
- `test_fonts.py`: the new faces exist, with their coverage, and the total is within the cap.
- Logo generator: the new sizes exist for every engine, and the flash bytes are printed.

**CLI.**
- `devices.spec`:
  - the start and done readings give the deltas;
  - missing, negative or over-cap differences give no fields;
  - a slow read (over 2 s) still sends `turn.done` in time;
  - a remote agent gets no tokens.
- `cableSession.spec`: `tokensIn` / `tokensOut` are passed through under the cap.
- `npm run test:core` stays at 100%.

**Device check.** Flash, keep the dev CLI, switch to Console, and walk the 7 changed screens. Run a Claude turn that tests and commits, and check that TOKENS / TESTS / COMMITS appear on Recap.

## Risk

**Critical:**
- the voice gesture changes, from hold-release to hands-free with tap to send;
- the cable message gets new fields.

Phase 3 review runs on the strongest model.
