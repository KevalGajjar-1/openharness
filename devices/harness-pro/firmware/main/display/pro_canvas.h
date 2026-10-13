#pragma once
#include "terminal.h"

#include "pro_font_type.h"   // ht_pro_glyph_t, struct ht_pro_font, ht_pro_24 / 32 / 42
// Extra atlas entries follow Latin-1: the 90 Vietnamese precomposed letters,
// then the 12 letters outside that block. Keep in sync with gen_fonts.py.
static inline int ht_pro_vietnamese_index(uint32_t cp)
{
    if (cp < 256) return -1;
    if (cp >= 0x1ea0 && cp <= 0x1ef9) return (int)(cp - 0x1ea0);
    static const uint16_t extra[] = {0x102,0x103,0x110,0x111,0x128,0x129,
                                   0x168,0x169,0x1a0,0x1a1,0x1af,0x1b0};
    for (unsigned i = 0; i < sizeof extra / sizeof extra[0]; i++)
        if (cp == extra[i]) return 90 + (int)i;
    return -1;
}
// The Console faces append these marks after the Vietnamese entries (glyph_count 335 against Classic's 316), in this
// order. Keep in sync with CONSOLE_EXTRA in gen_fonts.py. Classic's atlases have no such entries and draw '?'.
static inline int ht_pro_extra_index(uint32_t cp)
{
    static const uint16_t extra[] = {0x2026,0x2192,0x2191,0x2193,0x2190,0x21e2,0x25b2,0x25c6,0x2713};
    for (unsigned i = 0; i < sizeof extra / sizeof extra[0]; i++)
        if (cp == extra[i]) return 102 + (int)i;
    return -1;
}
int ht_pro_width(const ht_pro_font_t *font, const char *text);
int ht_pro_text_rows(const char *text, const ht_pro_font_t *font, int width);
bool ht_pro_text(ht_scene_t *s, int x, int y, int width, const ht_pro_font_t *font,
                 uint16_t ink, const char *text);
int ht_pro_wrap(ht_scene_t *s, int x, int y, int width, int rows, int skip,
                const ht_pro_font_t *font, uint16_t ink, const char *text);
void ht_pro_center(ht_scene_t *s, int y, const ht_pro_font_t *font, uint16_t ink, const char *text);
bool ht_pro_rect(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t ink);
// Like ht_pro_rect, but each corner pixel is blended onto the colour under it by its coverage of the circle.
bool ht_pro_rect_aa(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t ink);
// A rounded rect in `fill` with a one-pixel border in `ink`, as one run: pixel for pixel what ht_pro_rect_aa(ink, radius) followed by
// ht_pro_rect_aa(fill, x+1, y+1, w-2, h-2, radius-1) draws. Smaller than 3 x 3 it is the border fill alone.
bool ht_pro_rect_aa_stroke(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t ink, uint16_t fill);
bool ht_pro_image(ht_scene_t *s, int x, int y, const ht_pro_bitmap_t *bitmap);
bool ht_pro_image_faded(ht_scene_t *s, int x, int y, const ht_pro_bitmap_t *bitmap, unsigned opacity);   // opacity 1..254 of 255
void ht_pro_raster(const ht_run_t *run, ht_rect_t clip, uint16_t *out);
