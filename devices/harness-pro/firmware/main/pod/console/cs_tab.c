// Console Tab (mockup screen 02): the selected tab's agents in pane order, in the Recent row style without the tab name (the bar
// has it). Tap opens the agent; hold talks to that row's agent. Five rows show; a drag scrolls the rest. The working bars move
// with now_ms: the glue's unit_ms wakes at 66 ms while a visible row works.
#include <stdio.h>
#include <string.h>

#include "pod/console/cs.h"
#include "pro_canvas.h"

void cs_view_tab(pod_out_frame_t *f, const pod_nav_t *nav, pod_model_t *m, uint32_t now_ms)
{
    ht_scene_t *s = f->scene;
    const pod_frame_t *top = &nav->stack[nav->depth - 1];
    int ti = top->tab;
    const pod_tab_t *t = &m->tabs[ti];

    int running, asking;
    cs_counts(m, &running, &asking);
    const char *const crumbs[] = {"Overview", t->name};
    cs_bar(f, crumbs, 2, running, asking, cs_unread(m), NULL, now_ms);

    const char *const keys[] = {"tap", "\xe2\x86\x90 \xe2\x86\x92", "\xe2\x86\x91", "\xe2\x86\x93"}, *const labels[] = {"open", "tabs", "back", "home"};
    cs_hints(f, keys, labels, 4);

    const pod_agent_t *list[POD_AGENTS_MAX];
    int n = pod_nav_list(nav, m, list, POD_AGENTS_MAX);
    if (n <= 0) {
        const char *msg = "No panes in this tab";
        int w = ht_pro_width(&cs_rg_24, msg);
        cs_text(s, (POD_W - w) / 2, POD_W / 2, w + 2, &cs_rg_24, CS_MUTED, msg);
        return;
    }
    int max = n > CS_ROWS_MAX ? n - CS_ROWS_MAX : 0;
    cs_rows(f, m, list, n, top->scroll < 0 ? 0 : top->scroll > max ? max : top->scroll, false, now_ms);
}
