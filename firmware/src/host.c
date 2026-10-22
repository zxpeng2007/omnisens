// host.c - core 1: PIO-USB host for the attached mouse (and keyboard interfaces).
#include <string.h>

#include "hid_parser.h"
#include "omnisens.h"
#include "pio_usb.h"
#include "tusb.h"

typedef struct {
    bool               used;
    bool               is_mouse;
    bool               is_keyboard;
    bool               needs_boot;  // only usable once switched to boot protocol
    uint8_t            dev_addr;
    uint8_t            idx;
    uint16_t           buttons;
    mouse_layout_t layout;
} slot_t;

static slot_t slots[CFG_TUH_HID];

// Mouse events core 0 has not taken yet because its queue was full (it is
// busy, e.g. erasing flash, or the PC stopped polling). Every button change
// stays a separate entry, in order; motion is only folded into an entry with
// the same buttons, so a quick click survives a stalled core 0.
#define BACKLOG_LEN 16
static mouse_event_t backlog[BACKLOG_LEN];
static int backlog_head, backlog_count;

// Newest keyboard report core 0 has not taken yet. Only the latest is kept:
// in-between states can be lost, but the final one (the last release) is not.
static kb_event_t kb_pending;
static bool have_kb_pending;

static slot_t *find_slot(uint8_t dev_addr, uint8_t idx) {
    for (int i = 0; i < CFG_TUH_HID; i++)
        if (slots[i].used && slots[i].dev_addr == dev_addr && slots[i].idx == idx) return &slots[i];
    return NULL;
}

static slot_t *alloc_slot(uint8_t dev_addr, uint8_t idx) {
    for (int i = 0; i < CFG_TUH_HID; i++) {
        if (!slots[i].used) {
            memset(&slots[i], 0, sizeof(slots[i]));
            slots[i].used = true;
            slots[i].dev_addr = dev_addr;
            slots[i].idx = idx;
            return &slots[i];
        }
    }
    return NULL;
}

static void refresh_status(void) {
    bool mouse = false, kb = false;
    for (int i = 0; i < CFG_TUH_HID; i++) {
        if (!slots[i].used) continue;
        mouse |= slots[i].is_mouse;
        kb |= slots[i].is_keyboard;
    }
    g_host.mouse_attached = mouse;
    g_host.keyboard_attached = kb;
    if (!mouse) {
        g_host.vid = g_host.pid = 0;
        g_host.boot_fallback = false;
    }
}

static uint16_t merged_buttons(void) {
    uint16_t b = 0;
    for (int i = 0; i < CFG_TUH_HID; i++)
        if (slots[i].used && slots[i].is_mouse) b |= slots[i].buttons;
    return b;
}

// Saturating sums: a mouse with 32-bit axes could otherwise overflow while
// core 0 is stalled.
static int32_t add32(int32_t a, int32_t b) {
    int64_t v = (int64_t)a + b;
    return (int32_t)(v > INT32_MAX ? INT32_MAX : v < INT32_MIN ? INT32_MIN : v);
}

static int16_t add16(int16_t a, int16_t b) {
    int32_t v = (int32_t)a + b;
    return (int16_t)(v > INT16_MAX ? INT16_MAX : v < INT16_MIN ? INT16_MIN : v);
}

static void fold(mouse_event_t *into, const mouse_event_t *ev) {
    into->t_us = ev->t_us;
    into->dx = add32(into->dx, ev->dx);
    into->dy = add32(into->dy, ev->dy);
    into->wheel = add16(into->wheel, ev->wheel);
    into->pan = add16(into->pan, ev->pan);
    into->buttons = ev->buttons;
}

static void flush_backlog(void) {
    while (backlog_count && queue_try_add(&g_mouse_queue, &backlog[backlog_head])) {
        backlog_head = (backlog_head + 1) % BACKLOG_LEN;
        backlog_count--;
    }
}

static void push_mouse(int32_t dx, int32_t dy, int32_t wheel, int32_t pan) {
    mouse_event_t ev = {
        .t_us = time_us_32(),
        .dx = dx,
        .dy = dy,
        .wheel = (int16_t)wheel,
        .pan = (int16_t)pan,
        .buttons = merged_buttons(),
    };
    flush_backlog();
    if (!backlog_count && queue_try_add(&g_mouse_queue, &ev)) return;
    if (backlog_count) {
        mouse_event_t *last = &backlog[(backlog_head + backlog_count - 1) % BACKLOG_LEN];
        // With the backlog full, folding is the last resort: the newest
        // button state still wins, only edges in between are lost.
        if (last->buttons == ev.buttons || backlog_count == BACKLOG_LEN) {
            fold(last, &ev);
            return;
        }
    }
    backlog[(backlog_head + backlog_count++) % BACKLOG_LEN] = ev;
}

static void flush_keyboard(void) {
    if (have_kb_pending && queue_try_add(&g_kb_queue, &kb_pending)) have_kb_pending = false;
}

static void push_keyboard(const uint8_t *report, uint16_t len) {
    kb_event_t ev;
    memset(&ev, 0, sizeof(ev));
    memcpy(ev.report, report, len < sizeof(ev.report) ? len : sizeof(ev.report));
    flush_keyboard();
    if (have_kb_pending || !queue_try_add(&g_kb_queue, &ev)) {
        kb_pending = ev;
        have_kb_pending = true;
    }
}

void tuh_hid_mount_cb(uint8_t dev_addr, uint8_t idx, const uint8_t *desc, uint16_t desc_len) {
    slot_t *s = alloc_slot(dev_addr, idx);
    if (!s) return;
    uint8_t itf_protocol = tuh_hid_interface_protocol(dev_addr, idx);

    if (itf_protocol == HID_ITF_PROTOCOL_KEYBOARD) {
        // Boot keyboard reports have a fixed 8-byte layout we can forward as-is.
        // Reports are only requested once the switch to boot protocol is
        // confirmed, so report-protocol bytes are never sent as keystrokes.
        s->is_keyboard = true;
        s->needs_boot = true;
        tuh_hid_set_protocol(dev_addr, idx, HID_PROTOCOL_BOOT);  // queued if the control pipe is busy
    } else if (desc && hid_parse_mouse(desc, desc_len, &s->layout)) {
        s->is_mouse = true;
        tuh_hid_receive_report(dev_addr, idx);
    } else if (itf_protocol == HID_ITF_PROTOCOL_MOUSE) {
        // Descriptor missing or unparseable: fall back to the boot protocol.
        s->is_mouse = true;
        s->needs_boot = true;
        hid_boot_mouse_layout(&s->layout);
        g_host.boot_fallback = true;
        tuh_hid_set_protocol(dev_addr, idx, HID_PROTOCOL_BOOT);
    } else {
        s->used = false;  // vendor interface or other HID we do not forward
        return;
    }

    if (s->is_mouse) {
        uint16_t vid = 0, pid = 0;
        tuh_vid_pid_get(dev_addr, &vid, &pid);
        g_host.vid = vid;
        g_host.pid = pid;
    }
    refresh_status();
}

void tuh_hid_set_protocol_complete_cb(uint8_t dev_addr, uint8_t idx, uint8_t protocol) {
    slot_t *s = find_slot(dev_addr, idx);
    if (!s || !s->needs_boot) return;
    if (protocol != HID_PROTOCOL_BOOT) {
        // The device refused: we cannot decode its reports safely, so ignore it.
        s->used = false;
        refresh_status();
        return;
    }
    tuh_hid_receive_report(dev_addr, idx);
}

void tuh_hid_umount_cb(uint8_t dev_addr, uint8_t idx) {
    slot_t *s = find_slot(dev_addr, idx);
    if (!s) return;
    bool was_mouse = s->is_mouse, was_kb = s->is_keyboard;
    s->used = false;
    refresh_status();
    // Release anything that was held so nothing stays stuck on the PC.
    if (was_mouse) push_mouse(0, 0, 0, 0);
    if (was_kb) {
        static const uint8_t released[8] = {0};
        push_keyboard(released, sizeof(released));
    }
}

void tuh_hid_report_received_cb(uint8_t dev_addr, uint8_t idx, const uint8_t *report, uint16_t len) {
    slot_t *s = find_slot(dev_addr, idx);
    if (s && s->is_mouse) {
        mouse_report_t r;
        if (hid_decode_mouse(&s->layout, report, len, &r)) {
            s->buttons = r.buttons;
            push_mouse(r.x, r.y, r.wheel, r.pan);
        }
    } else if (s && s->is_keyboard) {
        // TinyUSB drops the transfer result, so a failed or stalled IN
        // transfer arrives here with len 0. Forwarding it would release every
        // held key on the PC; a boot keyboard report is always 8 bytes.
        if (len >= 8) push_keyboard(report, len);
    }
    tuh_hid_receive_report(dev_addr, idx);
}

void host_core1_main(void) {
    pio_usb_configuration_t pio_cfg = PIO_USB_DEFAULT_CONFIG;
    pio_cfg.pin_dp = OMNI_PIO_USB_DP_PIN;
    tuh_configure(BOARD_TUH_RHPORT, TUH_CFGID_RPI_PIO_USB_CONFIGURATION, &pio_cfg);

    // Report protocol gives mice their full resolution and all buttons;
    // keyboards are switched to boot protocol individually on mount.
    tuh_hid_set_default_protocol(HID_PROTOCOL_REPORT);

    // Initialised on this core so the PIO-USB frame timer interrupt runs here.
    const tusb_rhport_init_t host_init = {.role = TUSB_ROLE_HOST, .speed = TUSB_SPEED_AUTO};
    tusb_init(BOARD_TUH_RHPORT, &host_init);

    while (true) {
        tuh_task();
        flush_backlog();
        flush_keyboard();
        g_host.heartbeat++;
    }
}
