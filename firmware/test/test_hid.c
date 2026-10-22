// Host unit tests for hid_parser.c using descriptors shaped like real mice.
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "../src/hid_parser.h"
#include "../src/report_descs.h"

static int failures;
#define CHECK(cond, ...)                                \
    do {                                                \
        if (!(cond)) {                                  \
            failures++;                                 \
            printf("FAIL %s:%d: ", __FILE__, __LINE__); \
            printf(__VA_ARGS__);                        \
            printf("\n");                               \
        }                                               \
    } while (0)

// TinyUSB-style report mouse: 5 buttons + 3 pad bits, X/Y/wheel int8, AC pan int8.
static const uint8_t desc_basic[] = {
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x09, 0x01, 0xA1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x05, 0x15, 0x00, 0x25, 0x01, 0x95, 0x05, 0x75, 0x01, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x03, 0x81, 0x01,
    0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x15, 0x81, 0x25, 0x7F, 0x75, 0x08, 0x95, 0x02, 0x81, 0x06,
    0x09, 0x38, 0x15, 0x81, 0x25, 0x7F, 0x75, 0x08, 0x95, 0x01, 0x81, 0x06,
    0x05, 0x0C, 0x0A, 0x38, 0x02, 0x15, 0x81, 0x25, 0x7F, 0x75, 0x08, 0x95, 0x01, 0x81, 0x06,
    0xC0, 0xC0};

// Logitech-style wireless: report ID 2, 16 buttons, 16-bit X/Y, wheel, AC pan.
static const uint8_t desc_logi16[] = {
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x02, 0x09, 0x01, 0xA1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x10, 0x15, 0x00, 0x25, 0x01, 0x95, 0x10, 0x75, 0x01, 0x81, 0x02,
    0x05, 0x01, 0x16, 0x01, 0x80, 0x26, 0xFF, 0x7F, 0x75, 0x10, 0x95, 0x02, 0x09, 0x30, 0x09, 0x31, 0x81, 0x06,
    0x15, 0x81, 0x25, 0x7F, 0x75, 0x08, 0x95, 0x01, 0x09, 0x38, 0x81, 0x06,
    0x05, 0x0C, 0x0A, 0x38, 0x02, 0x95, 0x01, 0x81, 0x06,
    0xC0, 0xC0};

// Same but packed 12-bit X/Y.
static const uint8_t desc_logi12[] = {
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x02, 0x09, 0x01, 0xA1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x10, 0x15, 0x00, 0x25, 0x01, 0x95, 0x10, 0x75, 0x01, 0x81, 0x02,
    0x05, 0x01, 0x16, 0x01, 0xF8, 0x26, 0xFF, 0x07, 0x75, 0x0C, 0x95, 0x02, 0x09, 0x30, 0x09, 0x31, 0x81, 0x06,
    0x15, 0x81, 0x25, 0x7F, 0x75, 0x08, 0x95, 0x01, 0x09, 0x38, 0x81, 0x06,
    0x05, 0x0C, 0x0A, 0x38, 0x02, 0x95, 0x01, 0x81, 0x06,
    0xC0, 0xC0};

// Receiver-style composite: keyboard (ID 1), mouse with X/Y as a usage range (ID 2),
// consumer control (ID 3). Only report 2 is the mouse.
static const uint8_t desc_receiver[] = {
    0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85, 0x01,
    0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
    0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x19, 0x00, 0x2A, 0xFF, 0x00, 0x81, 0x00,
    0xC0,
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x02, 0x09, 0x01, 0xA1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x08, 0x15, 0x00, 0x25, 0x01, 0x95, 0x08, 0x75, 0x01, 0x81, 0x02,
    0x05, 0x01, 0x19, 0x30, 0x29, 0x31, 0x16, 0x00, 0x80, 0x26, 0xFF, 0x7F, 0x75, 0x10, 0x95, 0x02, 0x81, 0x06,
    0x09, 0x38, 0x15, 0x81, 0x25, 0x7F, 0x75, 0x08, 0x95, 0x01, 0x81, 0x06,
    0xC0, 0xC0,
    0x05, 0x0C, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x03, 0x75, 0x10, 0x95, 0x02, 0x15, 0x01, 0x26, 0xFF, 0x02,
    0x19, 0x01, 0x2A, 0xFF, 0x02, 0x81, 0x00, 0xC0};

// Absolute pointer (tablet): must not be treated as a mouse.
static const uint8_t desc_absolute[] = {
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x09, 0x01, 0xA1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x03, 0x15, 0x00, 0x25, 0x01, 0x95, 0x03, 0x75, 0x01, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x05, 0x81, 0x03,
    0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x15, 0x00, 0x26, 0xFF, 0x7F, 0x75, 0x10, 0x95, 0x02, 0x81, 0x02,
    0xC0, 0xC0};

// Usage Page given after the Usages (legal: 16-bit usages bind at the main item),
// extended 32-bit usage for the wheel, and a Push/Pop around padding.
static const uint8_t desc_tricky[] = {
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x09, 0x01, 0xA1, 0x00,
    0x19, 0x01, 0x29, 0x03, 0x05, 0x09, 0x15, 0x00, 0x25, 0x01, 0x95, 0x03, 0x75, 0x01, 0x81, 0x02,
    0xA4, 0x95, 0x05, 0x81, 0x03, 0xB4,
    0x09, 0x30, 0x09, 0x31, 0x05, 0x01, 0x15, 0x81, 0x25, 0x7F, 0x75, 0x08, 0x95, 0x02, 0x81, 0x06,
    0x0B, 0x38, 0x00, 0x01, 0x00, 0x95, 0x01, 0x81, 0x06,
    0xC0, 0xC0};

// Absolute pointer (report 1, 3 buttons) declared before the relative mouse
// (report 2, 5 buttons). Report 1's buttons must not shadow report 2's.
static const uint8_t desc_abs_then_rel[] = {
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x01, 0x09, 0x01, 0xA1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x03, 0x15, 0x00, 0x25, 0x01, 0x95, 0x03, 0x75, 0x01, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x05, 0x81, 0x03,
    0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x15, 0x00, 0x26, 0xFF, 0x7F, 0x75, 0x10, 0x95, 0x02, 0x81, 0x02,
    0xC0, 0xC0,
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x85, 0x02, 0x09, 0x01, 0xA1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x05, 0x15, 0x00, 0x25, 0x01, 0x95, 0x05, 0x75, 0x01, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x03, 0x81, 0x01,
    0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x15, 0x81, 0x25, 0x7F, 0x75, 0x08, 0x95, 0x02, 0x81, 0x06,
    0xC0, 0xC0};

// Wheel, Usage Page Consumer, AC Pan, then one Input item for both: the
// wheel keeps the Generic Desktop page it was declared under.
static const uint8_t desc_wheel_pan_item[] = {
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x09, 0x01, 0xA1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x03, 0x15, 0x00, 0x25, 0x01, 0x95, 0x03, 0x75, 0x01, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x05, 0x81, 0x03,
    0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x15, 0x81, 0x25, 0x7F, 0x75, 0x08, 0x95, 0x02, 0x81, 0x06,
    0x09, 0x38, 0x05, 0x0C, 0x0A, 0x38, 0x02, 0x95, 0x02, 0x81, 0x06,
    0xC0, 0xC0};

// X, Y, Wheel and AC Pan all in one Input item.
static const uint8_t desc_axes_one_item[] = {
    0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x09, 0x01, 0xA1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x08, 0x15, 0x00, 0x25, 0x01, 0x95, 0x08, 0x75, 0x01, 0x81, 0x02,
    0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x09, 0x38, 0x05, 0x0C, 0x0A, 0x38, 0x02,
    0x15, 0x81, 0x25, 0x7F, 0x75, 0x08, 0x95, 0x04, 0x81, 0x06,
    0xC0, 0xC0};

static void test_basic(void) {
    mouse_layout_t l;
    CHECK(hid_parse_mouse(desc_basic, sizeof(desc_basic), &l), "basic: parse");
    CHECK(!l.uses_report_id, "basic: no report id");
    CHECK(l.button_count == 5, "basic: %d buttons", l.button_count);
    CHECK(l.x.bit_offset == 8 && l.x.bit_size == 8 && l.x.is_signed, "basic: x");
    CHECK(l.y.bit_offset == 16, "basic: y");
    CHECK(l.wheel.bit_offset == 24 && l.pan.bit_offset == 32, "basic: wheel/pan");

    uint8_t rep[] = {0x05, 0xFE, 0x03, 0x01, 0xFF};
    mouse_report_t r;
    CHECK(hid_decode_mouse(&l, rep, sizeof(rep), &r), "basic: decode");
    CHECK(r.buttons == 0x05 && r.x == -2 && r.y == 3 && r.wheel == 1 && r.pan == -1,
          "basic: values b=%x x=%d y=%d w=%d p=%d", r.buttons, (int)r.x, (int)r.y, (int)r.wheel, (int)r.pan);
}

static void test_logi16(void) {
    mouse_layout_t l;
    CHECK(hid_parse_mouse(desc_logi16, sizeof(desc_logi16), &l), "logi16: parse");
    CHECK(l.uses_report_id && l.report_id == 2, "logi16: report id");
    CHECK(l.button_count == 16, "logi16: buttons");
    CHECK(l.x.bit_offset == 16 && l.x.bit_size == 16 && l.y.bit_offset == 32, "logi16: axes");
    uint8_t rep[] = {0x02, 0x01, 0x80, 0x18, 0xFC, 0xE8, 0x03, 0xFF, 0x00};
    mouse_report_t r;
    CHECK(hid_decode_mouse(&l, rep, sizeof(rep), &r), "logi16: decode");
    CHECK(r.buttons == 0x8001 && r.x == -1000 && r.y == 1000 && r.wheel == -1 && r.pan == 0,
          "logi16: values b=%x x=%d y=%d w=%d", r.buttons, (int)r.x, (int)r.y, (int)r.wheel);
    uint8_t other[] = {0x03, 0, 0, 0, 0, 0, 0, 0, 0};
    CHECK(!hid_decode_mouse(&l, other, sizeof(other), &r), "logi16: other report id rejected");
}

static void test_logi12(void) {
    mouse_layout_t l;
    CHECK(hid_parse_mouse(desc_logi12, sizeof(desc_logi12), &l), "logi12: parse");
    CHECK(l.x.bit_offset == 16 && l.x.bit_size == 12 && l.y.bit_offset == 28, "logi12: axes");
    // x = -5 (0xFFB), y = 300 (0x12C) packed LSB first: bytes FB, CF, 12
    uint8_t rep[] = {0x02, 0x00, 0x00, 0xFB, 0xCF, 0x12, 0x02, 0x00};
    mouse_report_t r;
    CHECK(hid_decode_mouse(&l, rep, sizeof(rep), &r), "logi12: decode");
    CHECK(r.x == -5 && r.y == 300 && r.wheel == 2, "logi12: x=%d y=%d w=%d", (int)r.x, (int)r.y, (int)r.wheel);
}

static void test_receiver(void) {
    mouse_layout_t l;
    CHECK(hid_parse_mouse(desc_receiver, sizeof(desc_receiver), &l), "receiver: parse");
    CHECK(l.report_id == 2 && l.button_count == 8, "receiver: id %d buttons %d", l.report_id, l.button_count);
    CHECK(l.x.bit_offset == 8 && l.x.bit_size == 16 && l.y.bit_offset == 24, "receiver: axes at %d/%d",
          l.x.bit_offset, l.y.bit_offset);
    CHECK(l.wheel.bit_offset == 40 && l.pan.bit_size == 0, "receiver: wheel");
    uint8_t rep[] = {0x02, 0x02, 0x10, 0x00, 0xF0, 0xFF, 0x00};
    mouse_report_t r;
    CHECK(hid_decode_mouse(&l, rep, sizeof(rep), &r), "receiver: decode");
    CHECK(r.buttons == 2 && r.x == 16 && r.y == -16, "receiver: values");
    uint8_t kb[] = {0x01, 0, 0, 4, 0, 0, 0, 0};
    CHECK(!hid_decode_mouse(&l, kb, sizeof(kb), &r), "receiver: keyboard report ignored");
}

static void test_absolute_and_tricky(void) {
    mouse_layout_t l;
    CHECK(!hid_parse_mouse(desc_absolute, sizeof(desc_absolute), &l), "absolute pointer rejected");

    CHECK(hid_parse_mouse(desc_tricky, sizeof(desc_tricky), &l), "tricky: parse");
    CHECK(l.button_count == 3, "tricky: late usage page buttons %d", l.button_count);
    CHECK(l.x.bit_offset == 8 && l.y.bit_offset == 16, "tricky: axes after push/pop padding %d", l.x.bit_offset);
    CHECK(l.wheel.bit_offset == 24 && l.wheel.bit_size == 8, "tricky: extended wheel usage");

    uint8_t trunc[] = {0x00, 0x05};
    mouse_report_t r;
    CHECK(!hid_decode_mouse(&l, trunc, sizeof(trunc), &r), "truncated report rejected");

    // Garbage must not crash or read out of bounds.
    uint8_t junk[64];
    for (int s = 0; s < 2000; s++) {
        unsigned v = (unsigned)s * 2654435761u;
        for (int k = 0; k < 64; k++) { v = v * 1103515245u + 12345u; junk[k] = (uint8_t)(v >> 16); }
        hid_parse_mouse(junk, (uint16_t)(s % 65), &l);
    }

    hid_boot_mouse_layout(&l);
    uint8_t boot[] = {0x03, 0x7F, 0x80, 0x01};
    CHECK(hid_decode_mouse(&l, boot, sizeof(boot), &r), "boot decode");
    CHECK(r.buttons == 3 && r.x == 127 && r.y == -128 && r.wheel == 1, "boot values");
    uint8_t boot3[] = {0x01, 0x05, 0xFB};
    CHECK(hid_decode_mouse(&l, boot3, sizeof(boot3), &r) && r.wheel == 0 && r.y == -5, "3-byte boot report");
}

static void test_report_selection(void) {
    mouse_layout_t l;
    mouse_report_t r;
    CHECK(hid_parse_mouse(desc_abs_then_rel, sizeof(desc_abs_then_rel), &l), "abs+rel: parse");
    CHECK(l.uses_report_id && l.report_id == 2, "abs+rel: report id %d", l.report_id);
    CHECK(l.button_count == 5, "abs+rel: %d buttons", l.button_count);
    CHECK(l.buttons[0].bit_offset == 0 && l.buttons[0].bit_size == 1, "abs+rel: button 1 from report 2");
    CHECK(l.x.bit_offset == 8 && l.x.bit_size == 8 && l.y.bit_offset == 16, "abs+rel: axes");
    uint8_t rep[] = {0x02, 0x01, 0x05, 0xFB};
    CHECK(hid_decode_mouse(&l, rep, sizeof(rep), &r), "abs+rel: decode");
    CHECK(r.buttons == 0x1 && r.x == 5 && r.y == -5, "abs+rel: values b=%x x=%d y=%d", r.buttons, (int)r.x,
          (int)r.y);
    uint8_t abs_rep[] = {0x01, 0x01, 0x00, 0x10, 0x00, 0x10};
    CHECK(!hid_decode_mouse(&l, abs_rep, sizeof(abs_rep), &r), "abs+rel: absolute report ignored");
}

static void test_usage_page_binding(void) {
    mouse_layout_t l;
    mouse_report_t r;
    CHECK(hid_parse_mouse(desc_wheel_pan_item, sizeof(desc_wheel_pan_item), &l), "wheel+pan: parse");
    CHECK(l.wheel.bit_offset == 24 && l.wheel.bit_size == 8, "wheel+pan: wheel at %d size %d", l.wheel.bit_offset,
          l.wheel.bit_size);
    CHECK(l.pan.bit_offset == 32 && l.pan.bit_size == 8, "wheel+pan: pan at %d size %d", l.pan.bit_offset,
          l.pan.bit_size);
    uint8_t rep[] = {0x01, 0x05, 0xFB, 0x01, 0xFF};
    CHECK(hid_decode_mouse(&l, rep, sizeof(rep), &r), "wheel+pan: decode");
    CHECK(r.buttons == 1 && r.x == 5 && r.y == -5 && r.wheel == 1 && r.pan == -1,
          "wheel+pan: values b=%x x=%d y=%d w=%d p=%d", r.buttons, (int)r.x, (int)r.y, (int)r.wheel, (int)r.pan);

    CHECK(hid_parse_mouse(desc_axes_one_item, sizeof(desc_axes_one_item), &l), "axes in one item: parse");
    CHECK(l.button_count == 8, "axes in one item: buttons %d", l.button_count);
    CHECK(l.x.bit_offset == 8 && l.y.bit_offset == 16 && l.wheel.bit_offset == 24 && l.pan.bit_offset == 32,
          "axes in one item: x %d y %d wheel %d pan %d", l.x.bit_offset, l.y.bit_offset, l.wheel.bit_offset,
          l.pan.bit_offset);
}

// Hostile descriptors must be rejected quickly: the firmware parses on
// core 1, and a long stall there trips the watchdog on every enumeration.
static void check_rejected_fast(const char *name, const uint8_t *desc, uint16_t len) {
    mouse_layout_t l;
    clock_t t0 = clock();
    bool ok = hid_parse_mouse(desc, len, &l);
    double ms = (double)(clock() - t0) * 1000.0 / CLOCKS_PER_SEC;
    CHECK(!ok, "%s: rejected", name);
    CHECK(ms < 50.0, "%s: took %.1f ms", name, ms);
}

static const uint8_t mouse_head[] = {0x05, 0x01, 0x09, 0x02, 0xA1, 0x01};

// Mouse collection, then `item` once, then Input (Data, Var) items to the end.
static uint16_t fill_repeated_inputs(uint8_t *buf, uint16_t size, const uint8_t *item, uint16_t item_len) {
    uint16_t n = 0;
    memcpy(buf, mouse_head, sizeof(mouse_head));
    n += sizeof(mouse_head);
    memcpy(buf + n, item, item_len);
    n += item_len;
    while (n + 2 <= size) {
        buf[n++] = 0x81;
        buf[n++] = 0x02;
    }
    return n;
}

static void test_hostile(void) {
    // Report Size 0 with Report Count 0xFFFFFFFF.
    static const uint8_t size0[] = {0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, 0x75, 0x00,
                                    0x97, 0xFF, 0xFF, 0xFF, 0xFF, 0x81, 0x02, 0xC0};
    check_rejected_fast("size 0", size0, sizeof(size0));

    // size * count overflowing 32 bits must not wrap the offset back to 0.
    static uint8_t buf[1024];
    static const uint8_t wrap_to_base[] = {0x75, 0x02, 0x97, 0x00, 0x00, 0x00, 0x80};
    static const uint8_t swing[] = {0x75, 0x01, 0x97, 0x01, 0x00, 0xFF, 0xFF};
    uint16_t n = fill_repeated_inputs(buf, sizeof(buf), wrap_to_base, sizeof(wrap_to_base));
    check_rejected_fast("2 x 0x80000000 bits", buf, n);
    n = fill_repeated_inputs(buf, sizeof(buf), swing, sizeof(swing));
    check_rejected_fast("1 x 0xFFFF0001 bits", buf, n);

    // 16 report IDs, each with 65536 one-bit fields.
    memcpy(buf, mouse_head, sizeof(mouse_head));
    n = sizeof(mouse_head);
    for (uint8_t id = 1; id <= 16; id++) {
        const uint8_t item[] = {0x85, id, 0x75, 0x01, 0x97, 0x00, 0x00, 0x01, 0x00, 0x81, 0x02};
        memcpy(buf + n, item, sizeof(item));
        n += sizeof(item);
    }
    buf[n++] = 0xC0;
    check_rejected_fast("16 report ids x 65536 fields", buf, n);

    // A long item near the end of a 64 KB descriptor must not wrap the index.
    static uint8_t big[65535];
    big[65400] = 0xFE;
    big[65401] = 0xFF;
    check_rejected_fast("long item at 65400", big, sizeof(big));
}

// The adapter's own descriptors must describe exactly what main.c sends.
static void test_own_descriptors(void) {
    mouse_layout_t l;
    CHECK(hid_parse_mouse(omni_mouse_report_desc, sizeof(omni_mouse_report_desc), &l), "own mouse descriptor parses");
    CHECK(!l.uses_report_id && l.button_count == 16, "own: 16 buttons, no report id");
    CHECK(l.x.bit_offset == 16 && l.x.bit_size == 16 && l.x.is_signed, "own: x");
    CHECK(l.y.bit_offset == 32 && l.y.bit_size == 16, "own: y");
    CHECK(l.wheel.bit_offset == 48 && l.wheel.bit_size == 8, "own: wheel");
    CHECK(l.pan.bit_offset == 56 && l.pan.bit_size == 8, "own: pan");
    CHECK((l.pan.bit_offset + l.pan.bit_size) / 8 == OMNI_MOUSE_REPORT_LEN, "own: report length");
    uint8_t rep[OMNI_MOUSE_REPORT_LEN] = {0x05, 0x80, 0x18, 0xFC, 0xE8, 0x03, 0xFF, 0x01};
    mouse_report_t r;
    CHECK(hid_decode_mouse(&l, rep, sizeof(rep), &r), "own: decode");
    CHECK(r.buttons == 0x8005 && r.x == -1000 && r.y == 1000 && r.wheel == -1 && r.pan == 1, "own: values");
    CHECK(!hid_parse_mouse(omni_config_report_desc, sizeof(omni_config_report_desc), &l), "config descriptor is not a mouse");
}

int main(void) {
    test_own_descriptors();
    test_basic();
    test_logi16();
    test_logi12();
    test_receiver();
    test_absolute_and_tricky();
    test_report_selection();
    test_usage_page_binding();
    test_hostile();
    if (failures) {
        printf("%d check(s) failed\n", failures);
        return 1;
    }
    printf("all hid parser tests passed\n");
    return 0;
}
