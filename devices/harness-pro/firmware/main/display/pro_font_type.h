#pragma once
/* Pro text atlas types: all that the generated pro_fonts.c needs, with no dependency on the compositor.
 * pro_canvas.h includes this file. */
#include <stdint.h>

// rows == 0: the mask is the font's full height. Otherwise it holds only `rows` rows, starting `top` rows down
// the cell (the Console faces; the rows above and below are empty).
typedef struct { uint32_t offset; uint8_t width, advance, top, rows; } ht_pro_glyph_t;
struct ht_pro_font {
    uint16_t first, last;
    uint8_t height;
    uint16_t glyph_count; // includes the Vietnamese entries after Latin-1
    const ht_pro_glyph_t *glyphs;
    const uint8_t *alpha;
};
typedef struct ht_pro_font ht_pro_font_t;

extern const ht_pro_font_t ht_pro_24, ht_pro_32, ht_pro_42, ht_pro_56;
// Console: Inter SemiBold / Medium / Regular and JetBrains Mono Medium, always from fonts/ (see scripts/gen_fonts.py).
extern const ht_pro_font_t cs_sb_48, cs_sb_34, cs_sb_26, cs_sb_22, cs_rg_24, cs_rg_20, cs_rg_17,
                           cs_mono_26, cs_mono_18, cs_mono_15,
                           cs_md_28, cs_sb_32, cs_rg_36, cs_rg_27, cs_rg_22, cs_mono_24, cs_mono_22;
