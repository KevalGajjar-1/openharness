// Console Overview (mockup screen 01, .o2* in style5.css): a 2 x 2 page of tab cards, Recent first. Each card is the tab's name
// (34 px) with a state badge, and up to three agent rows of 62 px: dot, 36 px logo, the name in the 28 px face, the time. More than
// four cards page (the TABS frame's scroll is the first row of the page, two rows a page), with dots above the hint strip.
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pro_canvas.h"

#define C(rgb) ht_rgb(rgb)
enum {
    COLS = 2, CARD_W = 338, CARD_H = 277, GAP = 12, MARGIN = 16, TOP = CS_BAR_H + 14, PAD = 19, HEAD_H = 68, ROW_H = 62,
    DOT = 8, DOT_PITCH = 16, DOT_Y = 652, DOTS_MAX = 8
};

void cs_counts(const pod_model_t *m, int *running, int *asking)
{
    int r = 0, q = 0;
    for (int i = 0; i < m->agent_count; i++) {
        pod_state_t st = pod_model_eff(m, &m->agents[i]);
        r += st == POD_WORKING;
        q += st == POD_ASKING;
    }
    if (running) *running = r;
    if (asking) *asking = q;
}

uint32_t cs_age_s(const pod_model_t *m, const pod_agent_t *a)
{
    uint32_t best = UINT32_MAX;
    const struct { bool has; uint32_t t; } at[2] = {{a->has_act, a->act_ms}, {a->has_lib, a->lib_ms}};
    for (int k = 0; k < 2; k++) {
        if (!at[k].has) continue;
        int32_t d = (int32_t)(m->clock_ms - at[k].t);
        uint32_t age = d < 0 ? 0u : (uint32_t)d / 1000u;
        if (age < best) best = age;
    }
    return best == UINT32_MAX ? 0u : best;
}

char cs_state_dot(const pod_model_t *m, const pod_agent_t *a)
{
    pod_state_t st = pod_model_eff(m, a);
    return st == POD_WORKING ? 'g' : st == POD_ASKING ? 'q' : st == POD_DONE ? 'd' : (st == POD_IDLE && a->failed) ? 'r' : 'i';
}

unsigned cs_time_col(char *out, size_t n, const pod_model_t *m, const pod_agent_t *a, uint32_t now_ms)
{
    pod_state_t st = pod_model_eff(m, a);
    if (st == POD_WORKING) { pod_fmt_time(out, n, pod_agent_secs(a, now_ms)); return CS_RUN; }
    if (st == POD_ASKING) { snprintf(out, n, "ask"); return CS_ASK; }
    if (st == POD_OFFLINE) { snprintf(out, n, "off"); return 0x5f646d; }
    pod_fmt_age(out, n, cs_age_s(m, a));
    return 0x5f646d;
}

// The agents a card lists (at most 3): Recent's newest, or the tab's panes in order. working / asking count the whole tab.
static int card_agents(const pod_model_t *m, int c, const pod_agent_t *out[3], int *working, int *asking)
{
    const pod_agent_t *all[POD_RECENT_MAX];
    int n = 0, w = 0, q = 0;
    if (c == 0) {
        int k = pod_model_recent(m, all, POD_RECENT_MAX);
        for (int i = 0; i < k; i++) {
            pod_state_t st = pod_model_eff(m, all[i]);
            w += st == POD_WORKING;
            q += st == POD_ASKING;
            if (n < 3) out[n++] = all[i];
        }
    } else {
        const pod_tab_t *t = &m->tabs[c - 1];
        for (int k = 0; k < t->count && k < POD_PANES_MAX && n < 3; k++)
            if (t->agent[k] >= 0 && t->agent[k] < m->agent_count) out[n++] = &m->agents[t->agent[k]];
        pod_tab_counts(m, t, &w, &q);
    }
    *working = w;
    *asking = q;
    return n;
}

static void card(pod_out_frame_t *f, const pod_model_t *m, int c, int x, int y, bool sel, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    ht_pro_rect(s, x, y, CARD_W, CARD_H, 18, C(sel ? 0x6f4d1a : CS_BORDER));
    ht_pro_rect(s, x + 1, y + 1, CARD_W - 2, CARD_H - 2, 17, C(sel ? 0x14120d : CS_SURFACE));

    const pod_agent_t *rows[3];
    int working, asking, n = card_agents(m, c, rows, &working, &asking);
    char b[16];
    unsigned fg = CS_MUTED, bg = 0x1a1c20;
    if (c > 0 && pod_tab_panes(&m->tabs[c - 1]) == 0) snprintf(b, sizeof b, "empty");
    else if (asking > 0) { snprintf(b, sizeof b, "%d ask", asking); fg = CS_ASK; bg = 0x2e2108; }
    else if (working > 0) { snprintf(b, sizeof b, "%d run", working); fg = CS_RUN; bg = 0x0f2a1d; }
    else snprintf(b, sizeof b, "idle");
    const int left = x + PAD, right = x + CARD_W - PAD, hy = y + 38;
    int bw = ht_pro_width(&cs_mono_18, b);
    ht_pro_rect_aa(s, right - bw - 16, hy - 13, bw + 16, 26, 6, C(bg));
    cs_text(s, right - bw - 8, hy, bw + 2, &cs_mono_18, fg, b);
    const char *name = c == 0 ? "Recent" : m->tabs[c - 1].name;
    cs_text(s, left, hy, right - left - bw - 16 - 10, &cs_sb_34, CS_INK, name);
    ht_pro_rect(s, left, y + HEAD_H, right - left, 1, 0, C(CS_BORDER));

    for (int i = 0; i < n; i++) {
        const int cy = y + HEAD_H + 6 + i * ROW_H + ROW_H / 2;
        char t[12];
        unsigned tc = cs_time_col(t, sizeof t, m, rows[i], now_ms);
        int tw = ht_pro_width(&cs_mono_22, t);
        cs_dot(s, left + 6, cy, cs_state_dot(m, rows[i]), 0);
        cs_logo(s, left + 24, cy - 18, 36, rows[i]->engine);
        cs_text(s, right - tw, cy, tw + 2, &cs_mono_22, tc, t);
        int nx = left + 72;
        cs_text(s, nx, cy, right - tw - 8 - nx, &cs_md_28, 0xe3e5e9, rows[i]->name);
    }
    pod_hit_add_id(f, x, y, CARD_W, CARD_H, POD_A_OPEN_TAB, c ? c - 1 : POD_TAB_RECENT, c ? m->tabs[c - 1].id : "");
}

void cs_view_overview(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    int running, asking;
    cs_counts(m, &running, &asking);
    const char *const crumbs[] = {"Overview"};
    cs_bar(f, crumbs, 1, running, asking, cs_unread(m), NULL, now_ms);
    // tap opens a tab; ← → pages (only with more than one page); ↓ opens the Inbox; ▲ goes to the ask (only while someone asks)
    const char *keys[4], *labels[4];
    int hn = 0, pages = pod_tabs_pages_of(nav, m);
    keys[hn] = "tap"; labels[hn++] = "open tab";
    if (pages > 1) { keys[hn] = "\xe2\x86\x90 \xe2\x86\x92"; labels[hn++] = "pages"; }
    keys[hn] = "\xe2\x86\x93"; labels[hn++] = "inbox";
    if (asking > 0) { keys[hn] = "\xe2\x96\xb2"; labels[hn++] = "go to the ask"; }
    cs_hints(f, keys, labels, hn);

    int covers = 1 + m->tab_count;
    int page = nav->depth ? nav->stack[0].scroll / 2 : 0;
    page = page < 0 ? 0 : page > pages - 1 ? pages - 1 : page;
    int first = page * CS_PER_PAGE, count = covers - first < CS_PER_PAGE ? covers - first : CS_PER_PAGE;
    for (int i = 0; i < count; i++) {
        int c = first + i;
        card(f, m, c, MARGIN + (i % COLS) * (CARD_W + GAP), TOP + (i / COLS) * (CARD_H + GAP), c > 0 && c - 1 == m->selected && m->tab_count, now_ms);
    }
    int dots = pages > 1 ? (pages < DOTS_MAX ? pages : DOTS_MAX) : 0;
    int x0 = (POD_W - (dots * DOT_PITCH - (DOT_PITCH - DOT))) / 2;   // the page dots, centred above the hint strip
    for (int i = 0; i < dots; i++)
        ht_pro_rect(s, x0 + i * DOT_PITCH, DOT_Y, DOT, DOT, DOT / 2, C(i == (page < dots ? page : dots - 1) ? CS_INK : 0x33363d));
}
