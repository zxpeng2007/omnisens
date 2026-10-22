// hid_parser.h - finds the mouse fields in an arbitrary HID report descriptor.
//
// Gaming mice rarely use the 3-byte boot format in report mode: they add a
// report ID, 16 buttons, 12- or 16-bit axes and a horizontal wheel. This
// parser walks the descriptor at mount time (twice: once to pick the mouse
// report, once to collect its fields) and records where each field lives,
// so reports can be decoded with a few shifts. No SDK dependencies; tested
// on the host in firmware/test.
#ifndef HID_PARSER_H
#define HID_PARSER_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define HID_MOUSE_MAX_BUTTONS 16

typedef struct {
    uint16_t bit_offset;  // from the first payload byte (after the report ID)
    uint8_t  bit_size;    // 1..32, 0 = field not present
    bool     is_signed;
} report_field_t;

typedef struct {
    bool        valid;          // X and Y (relative) were found
    bool        uses_report_id; // reports start with a report ID byte
    uint8_t     report_id;      // ID of the report that carries X/Y
    uint8_t     button_count;
    report_field_t buttons[HID_MOUSE_MAX_BUTTONS];  // buttons[i] = button i+1
    report_field_t x, y, wheel, pan;
} mouse_layout_t;

typedef struct {
    uint16_t buttons;  // bit i = button i+1
    int32_t  x, y;
    int32_t  wheel, pan;
} mouse_report_t;

// Parse a report descriptor. Returns true and fills *out if a relative
// mouse/pointer with X and Y was found. Only one report is decoded: if
// several reports carry relative X/Y, the first one declared is used and
// reports with other IDs are ignored.
bool hid_parse_mouse(const uint8_t *desc, uint16_t len, mouse_layout_t *out);

// Layout of the standard boot-protocol mouse report (buttons, X, Y, wheel).
void hid_boot_mouse_layout(mouse_layout_t *out);

// Decode one input report. Returns false if it is not the mouse report
// (different report ID) or too short to hold X and Y.
bool hid_decode_mouse(const mouse_layout_t *l, const uint8_t *report, uint16_t len,
                      mouse_report_t *out);

#ifdef __cplusplus
}
#endif

#endif  // HID_PARSER_H
