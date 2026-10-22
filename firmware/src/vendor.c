// vendor.c - HID GET/SET_REPORT handling, mainly the configuration interface
// (feature reports 1-3, docs/PROTOCOL.md).
#include <string.h>

#include "omnisens.h"
#include "pico/stdlib.h"
#include "report_descs.h"
#include "tusb.h"

enum { REPORT_CONFIG = 1, REPORT_STATUS = 2, REPORT_LIVE = 3 };
enum {
    CMD_SAVE = 0x01,
    CMD_LOAD = 0x02,
    CMD_DEFAULTS = 0x03,
    CMD_SET_ENABLED = 0x04,
    CMD_BOOTLOADER = 0x05,
    CMD_REBOOT = 0x06,
    CMD_RESET_COUNTERS = 0x07,
};
enum { RESULT_OK = 0, RESULT_UNKNOWN = 1, RESULT_FLASH = 2, RESULT_BAD_ARGS = 3 };

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static void put32(uint8_t *p, uint32_t v) { put16(p, (uint16_t)v); put16(p + 2, (uint16_t)(v >> 16)); }

static void fill_status(uint8_t *b) {
    b[0] = 1;  // protocol version
    b[1] = OMNI_FW_MAJOR;
    b[2] = OMNI_FW_MINOR;
    b[3] = OMNI_FW_PATCH;
    b[4] = (uint8_t)((g_host.mouse_attached ? 1u : 0u) | ((g_app.cfg.flags & OMNI_FLAG_ENABLED) ? 2u : 0u) |
                     (app_is_dirty() ? 4u : 0u) | (g_app.has_saved ? 8u : 0u) |
                     (g_host.keyboard_attached ? 16u : 0u) | (g_host.boot_fallback ? 32u : 0u));
    b[5] = g_app.last_result;
    put16(b + 6, g_host.vid);
    put16(b + 8, g_host.pid);
    put16(b + 10, g_app.reports_per_sec);
    // b[12] is reserved and stays 0 (TinyUSB's HID host does not keep bInterval).
    b[13] = OMNI_BOARD_ID;
    put32(b + 14, to_ms_since_boot(get_absolute_time()));
    put32(b + 18, g_app.save_seq);
    const char *name = OMNI_BOARD_NAME;  // NUL padded, not necessarily terminated
    memcpy(b + 22, name, strlen(name) < 16 ? strlen(name) : 16);
}

static void fill_live(uint8_t *b) {
    float ang = g_app.engine.last_angle_deg;
    float gain = g_app.engine.last_gain;
    put32(b + 0, g_app.reports);
    put32(b + 4, (uint32_t)g_app.in_x);
    put32(b + 8, (uint32_t)g_app.in_y);
    put32(b + 12, (uint32_t)g_app.out_x);
    put32(b + 16, (uint32_t)g_app.out_y);
    put16(b + 20, (uint16_t)(ang * 100.0f + 0.5f) % 36000u);
    put16(b + 22, (uint16_t)(gain * OMNI_GAIN_ONE + 0.5f));
    put16(b + 24, g_app.buttons);
}

uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t report_type,
                               uint8_t *buffer, uint16_t reqlen) {
    uint8_t b[OMNI_CONFIG_REPORT_LEN];
    memset(b, 0, sizeof(b));
    uint16_t len = sizeof(b);

    if (instance == ITF_MOUSE) {
        len = tud_hid_n_get_protocol(ITF_MOUSE) == HID_PROTOCOL_BOOT ? OMNI_BOOT_MOUSE_REPORT_LEN
                                                                     : OMNI_MOUSE_REPORT_LEN;
    } else if (instance == ITF_KEYBOARD) {
        len = 8;
    } else if (report_type == HID_REPORT_TYPE_FEATURE && report_id == REPORT_CONFIG) {
        omni_config_pack(&g_app.cfg, b);
    } else if (report_type == HID_REPORT_TYPE_FEATURE && report_id == REPORT_STATUS) {
        fill_status(b);
    } else if (report_type == HID_REPORT_TYPE_FEATURE && report_id == REPORT_LIVE) {
        fill_live(b);
    }
    // otherwise: zeros (e.g. GET_REPORT for the unused input report 4)

    if (len > reqlen) len = reqlen;
    memcpy(buffer, b, len);
    return len;
}

static uint8_t run_command(const uint8_t *p, uint16_t len) {
    switch (p[0]) {
        case CMD_SAVE: {
            uint32_t seq;
            if (!storage_save(&g_app.cfg, &seq)) return RESULT_FLASH;
            g_app.saved = g_app.cfg;
            g_app.has_saved = true;
            g_app.save_seq = seq;
            return RESULT_OK;
        }
        case CMD_LOAD: {
            omni_config_t c;
            uint32_t seq;
            if (storage_load(&c, &seq)) {
                g_app.saved = c;
                g_app.has_saved = true;
            }
            app_apply_config(&g_app.saved);
            return RESULT_OK;
        }
        case CMD_DEFAULTS: {
            omni_config_t c;
            omni_config_default(&c);
            app_apply_config(&c);
            return RESULT_OK;
        }
        case CMD_SET_ENABLED: {
            if (len < 2 || p[1] > 1) return RESULT_BAD_ARGS;
            omni_config_t c = g_app.cfg;
            c.flags = p[1] ? (c.flags | OMNI_FLAG_ENABLED) : (c.flags & ~OMNI_FLAG_ENABLED);
            app_apply_config(&c);
            return RESULT_OK;
        }
        case CMD_BOOTLOADER: app_request_reboot(true); return RESULT_OK;
        case CMD_REBOOT: app_request_reboot(false); return RESULT_OK;
        case CMD_RESET_COUNTERS:
            g_app.reports = 0;
            g_app.in_x = g_app.in_y = g_app.out_x = g_app.out_y = 0;
            return RESULT_OK;
        default: return RESULT_UNKNOWN;
    }
}

void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t report_type,
                           const uint8_t *buffer, uint16_t bufsize) {
    if (instance != ITF_CONFIG || report_type != HID_REPORT_TYPE_FEATURE) return;  // e.g. keyboard LEDs

    if (report_id == REPORT_CONFIG) {
        omni_config_t c;
        if (bufsize < OMNI_CONFIG_SIZE || !omni_config_unpack(buffer, &c)) {
            g_app.last_result = RESULT_BAD_ARGS;
            return;
        }
        app_apply_config(&c);
        g_app.last_result = RESULT_OK;
    } else if (report_id == REPORT_STATUS) {
        g_app.last_result = bufsize ? run_command(buffer, bufsize) : RESULT_BAD_ARGS;
    }
}
