// Console skin: the Harness Pro Console look. cs_render draws the whole frame for nav->skin == POD_SKIN_CONSOLE.
#pragma once
#include "pod/pod_view.h"

void cs_render(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms);

// ---- chrome (cs_chrome.c): the command bar, hint strip, dots, badges and the step timeline ----------------------
enum { CS_GROUND = 0x08090A, CS_SURFACE = 0x111214, CS_BORDER = 0x1E2024, CS_INK = 0xEDEEF0, CS_MUTED = 0x8A8F98,
       CS_RUN = 0x3DD68C, CS_ASK = 0xF5A524, CS_FAIL = 0xF2555A, CS_FOCUS = 0x7C6CFF };
enum { CS_BAR_H = 72, CS_HINT_H = 52 };

// The 72 px command bar at the top. input == NULL: the breadcrumbs (every crumb but the last is a POD_A_BACK hit whose
// arg is the number of levels up). Otherwise the bar is the voice input: crumbs[n-1] as the "to" chip, then the text.
// Right side: (running > 0) the small working mark (cs_working_mark_small, animated from now_ms) and `running`, then (unread > 0,
// not in the voice bar) a bell chip with the count that registers POD_A_INBOX, then (asking > 0) a "▲ N" chip that registers
// POD_A_ATTENTION. A chip's hit is the full bar height and reaches 12 px past the chip (two chips split the gap between them);
// the chips' hits are added after the crumbs', so they win. The crumb gives way to the chips. With running > 0 the bar moves:
// the glue (pod_glue.c edge_ms) wakes every POD_CS_ANIM_MS while anyone runs.
void cs_bar(pod_out_frame_t *, const char *const crumbs[], int n, int running, int asking, int unread, const char *input, uint32_t now_ms);
// The bell count for a view's bar: the unread entries (at most 99) while linked; the caller passes 0 on Inbox and Talk.
int cs_unread(const pod_model_t *);
// The 52 px hint strip along the bottom: n pairs of a key cap and a label.
void cs_hints(pod_out_frame_t *, const char *const keys[], const char *const labels[], int n);
// A 12 px status dot centred on (cx, cy): 'g' running, 'q' asking, 'd' done, 'r' failed, 'i' idle. Static (now_ms unused,
// so it asks for no wake).
void cs_dot(ht_scene_t *, int cx, int cy, char state, uint32_t now_ms);
// The 28 x 28 engine badge with its two-letter code.
void cs_badge(ht_scene_t *, int x, int y, const char *engine);
// The engine's baked logo (sizes 28, 36, 44, 72) at (x, y), one image run. When the engine has no logo or the size is not
// baked it draws a size x size badge instead and returns false.
bool cs_logo(ht_scene_t *, int x, int y, int size, const char *engine);
// The working mark of Recent and Tab rows: four 5 px bars 3 px apart in a 26 x 22 box at (x, y), CS_RUN, anchored at the box's
// bottom. Each bar's height is a triangle wave between 40 % and 100 % of 22 px, period 900 ms, offset -200 / -500 / -100 / -700 ms.
// Drawn from now_ms: a screen with one needs the 66 ms wake (pod_glue.c unit_ms gives it to a Console Tab or Recent with a working row on screen).
void cs_working_mark(ht_scene_t *, int x, int y, uint32_t now_ms);
// The same mark scaled to the bell's height for the bar: four 4 px bars 2 px apart (CS_MARK_SMALL_W = 22 wide) in an 18 px box at (x, y).
enum { CS_MARK_SMALL_W = 22 };
void cs_working_mark_small(ht_scene_t *, int x, int y, uint32_t now_ms);
// Text on one line, vertically centred on cy (the lowercase band), cut with an ellipsis at w px.
void cs_text(ht_scene_t *, int x, int cy, int w, const ht_pro_font_t *, unsigned rgb, const char *);
// The runs a frame has used so far (the budget tests).
int cs_runs(const pod_out_frame_t *);

// ---- Overview and Recent (cs_overview.c, cs_recent.c) -------------------------------------------------------------
// The Recent-style row list shared by Recent and Tab: up to CS_ROWS_MAX rows of CS_ROW_H px from `first`, right under the bar.
// Each row: the 44 px logo, the working mark (WORKING) or a dot, the name, the tab's name when tab_col, the time (or "ask") right
// aligned, and the agent's line. Its hit is POD_A_OPEN_AGENT with the agent's index in `list` and its id. Returns the rows drawn.
enum { CS_ROW_H = 108, CS_ROWS_MAX = 5, CS_ROWS_TOP = CS_BAR_H + 4, CS_PER_PAGE = 4 };
int cs_rows(pod_out_frame_t *, const pod_model_t *, const pod_agent_t *const list[], int n, int first, bool tab_col, uint32_t now_ms);
// The scroll limit of a Recent or Tab frame: its agents less the rows that show.
int cs_rows_max(const pod_nav_t *, const pod_model_t *);
void cs_view_overview(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
void cs_view_recent(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// The selected tab (mockup screen 02): its panes, in pane order, as the Recent rows without the tab name.
void cs_view_tab(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// Agents running (WORKING) and asking (ASKING), for the bar's chips.
void cs_counts(const pod_model_t *, int *running, int *asking);
// Seconds since the agent last had a task (act / library stamps against the model clock); 0 when unknown.
uint32_t cs_age_s(const pod_model_t *, const pod_agent_t *);
// The state letter cs_dot takes: 'g' working, 'q' asking, 'r' failed, 'd' done (has a recap), else 'i'.
char cs_state_dot(const pod_model_t *, const pod_agent_t *);
// The right-hand time of a row: working "m:ss" (CS_RUN), asking "ask" (CS_ASK), else the age ("now", "4m"; CS_MUTED).
// Returns the colour.
unsigned cs_time_col(char *out, size_t n, const pod_model_t *, const pod_agent_t *, uint32_t now_ms);

// ---- Agent, Recap, Talk, Inbox, Toast, Update (cs_agent.c, cs_recap.c, cs_talk.c, cs_inbox.c, cs_toast.c, cs_ota.c) ----
// Agent: working (the header, NOW and the equaliser) or asking (the header and the QUESTION card). No steps, no tokens.
void cs_view_agent(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// Recap (an agent with a recap): the header, SUMMARY (Classic's cut, no scrolling) and a row of up to four tiles: TOKENS, DURATION,
// TESTS, COMMITS. A tile is drawn only with data; with none the row is gone.
void cs_view_recap(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// Talk: listening (pet, the mic wave from f->mic_level, "Listening . m:ss") or sending (the message card).
void cs_view_talk(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// Inbox: NEEDS YOU (asking agents), FINISHED (unread finished entries), FAILED (failed agents, unread failures).
void cs_view_inbox(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms);
// The software update, drawn by the glue instead of the stack: pct 0..100, restarting after the image is verified.
void cs_view_ota(pod_out_frame_t *, const char *from, const char *to, int pct, bool restarting);
// The notification toast for unread entry `u` (call it last, after cs_render): drops under the bar, a timer line shrinks along
// its bottom over CS_TOAST_MS from u->at_ms. Adds the POD_A_BANNER hit. At most CS_TOAST_RUNS runs.
enum { CS_TOAST_MS = 6000, CS_TOAST_RUNS = 12, CS_RECAP_ROW = 35 };
void cs_toast(pod_out_frame_t *, const pod_model_t *, const pod_unread_t *u, uint32_t now_ms);
// Scroll geometry (rows) for Recap and Inbox.
int cs_recap_max_row(const pod_nav_t *, const pod_model_t *);
int cs_inbox_pitch(void);
int cs_inbox_max_row(const pod_model_t *);
// Shared by the agent screens. cs_hero: the header (variant C): the 170 x 130 pet box, the name (34 px), "state . m:ss" and the
// 28 px logo with the machine; returns its bottom (240). cs_back_hit: the bar's one crumb goes back a level. cs_parent_name: the screen one level up ("Overview", a tab's name, "Recent" or "Inbox"). cs_label: a small
// caps heading centred on cy. cs_spin: a 24 px spinner turning with now_ms.
int cs_hero(pod_out_frame_t *, const pod_nav_t *, const pod_model_t *, const pod_agent_t *, uint32_t now_ms);
void cs_back_hit(pod_out_frame_t *, const char *crumb);
const char *cs_parent_name(const pod_nav_t *, const pod_model_t *);
void cs_label(ht_scene_t *, int x, int cy, unsigned rgb, const char *);
void cs_spin(ht_scene_t *, int cx, int cy, unsigned rgb, uint32_t now_ms);
