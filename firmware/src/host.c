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

// Motion that could not be queued (core 0 busy) is merged into the next event.
static mouse_event_t pending;
static bool have_pending;

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

static void push_mouse(int32_t dx, int32_t dy, int32_t wheel, int32_t pan) {
    mouse_event_t ev = {
        .t_us = time_us_32(),
        .dx = dx,
        .dy = dy,
        .wheel = (int16_t)wheel,
        .pan = (int16_t)pan,
        .buttons = merged_buttons(),
    };
    if (have_pending) {
        // Core 0 was not draining the queue: fold the backlog into this event.
        ev.dx += pending.dx;
        ev.dy += pending.dy;
        ev.wheel = (int16_t)(ev.wheel + pending.wheel);
        ev.pan = (int16_t)(ev.pan + pending.pan);
        have_pending = false;
    }
    if (!queue_try_add(&g_mouse_queue, &ev)) {
        pending = ev;
        have_pending = true;
    }
}

static void push_keyboard(const uint8_t *report, uint16_t len) {
    kb_event_t ev;
    memset(&ev, 0, sizeof(ev));
    memcpy(ev.report, report, len < sizeof(ev.report) ? len : sizeof(ev.report));
    queue_try_add(&g_kb_queue, &ev);  // keyboard events are rare; drop if core 0 is stuck
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
        push_keyboard(report, len);
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
        if (have_pending) push_mouse(0, 0, 0, 0);
        g_host.heartbeat++;
    }
}
