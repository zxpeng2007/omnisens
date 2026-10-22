// main.c - core 0: USB device to the PC, correction engine, configuration.
#include <string.h>

#include "hardware/clocks.h"
#include "hardware/gpio.h"
#include "hardware/watchdog.h"
#include "omnisens.h"
#include "pico/bootrom.h"
#include "pico/multicore.h"
#include "pico/stdlib.h"
#include "report_descs.h"
#include "tusb.h"

queue_t g_mouse_queue;
queue_t g_kb_queue;
host_status_t g_host;
app_t g_app;

#define CHORD_BUTTONS 0x0007u  // left + right + middle
#define CHORD_HOLD_US 3000000u

// Accumulated output that has not been sent to the PC yet. sent_buttons is
// what the PC last received, so a change it missed while suspended is still
// reported after resume.
static int32_t acc_x, acc_y, acc_wheel, acc_pan;
static uint16_t cur_buttons, sent_buttons;
static uint32_t rate_count;  // mouse reports in the current stats window

// Keyboard passthrough: newest report from the mouse, and what the PC last received.
static kb_event_t kb_cur, kb_sent;

static uint32_t chord_start_us;
static bool chord_armed = true;

static bool reboot_pending, reboot_to_bootloader;
static uint32_t reboot_at_us;

// ------------------------------------------------------------------ config

void app_apply_config(const omni_config_t *cfg) {
    g_app.cfg = *cfg;
    omni_config_sanitize(&g_app.cfg);
    omni_engine_init(&g_app.engine, &g_app.cfg);
}

bool app_is_dirty(void) {
    uint8_t a[OMNI_CONFIG_SIZE], b[OMNI_CONFIG_SIZE];
    omni_config_pack(&g_app.cfg, a);
    omni_config_pack(&g_app.saved, b);
    return memcmp(a, b, sizeof(a)) != 0;
}

void app_request_reboot(bool bootloader) {
    reboot_pending = true;
    reboot_to_bootloader = bootloader;
    reboot_at_us = time_us_32() + 50000;  // let the control transfer finish
}

static void set_enabled(bool on) {
    omni_config_t c = g_app.cfg;
    c.flags = on ? (c.flags | OMNI_FLAG_ENABLED) : (c.flags & ~OMNI_FLAG_ENABLED);
    app_apply_config(&c);
}

// ------------------------------------------------------------------ mouse

static bool report_pending(void) {
    return acc_x || acc_y || acc_wheel || acc_pan || cur_buttons != sent_buttons;
}

static int32_t take(int32_t *acc, int32_t limit) {
    int32_t v = *acc;
    if (v > limit) v = limit;
    if (v < -limit) v = -limit;
    *acc -= v;
    return v;
}

// Sends whatever is accumulated; motion that does not fit stays for the next report.
static bool try_send_mouse(void) {
    if (!tud_hid_n_ready(ITF_MOUSE)) return false;
    if (tud_hid_n_get_protocol(ITF_MOUSE) == HID_PROTOCOL_BOOT) {
        uint8_t r[OMNI_BOOT_MOUSE_REPORT_LEN];
        r[0] = (uint8_t)cur_buttons;
        r[1] = (uint8_t)(int8_t)take(&acc_x, 127);
        r[2] = (uint8_t)(int8_t)take(&acc_y, 127);
        r[3] = (uint8_t)(int8_t)take(&acc_wheel, 127);
        acc_pan = 0;
        if (!tud_hid_n_report(ITF_MOUSE, 0, r, sizeof(r))) return false;
    } else {
        uint8_t r[OMNI_MOUSE_REPORT_LEN];
        int16_t x = (int16_t)take(&acc_x, 32767), y = (int16_t)take(&acc_y, 32767);
        r[0] = (uint8_t)cur_buttons;
        r[1] = (uint8_t)(cur_buttons >> 8);
        r[2] = (uint8_t)x;
        r[3] = (uint8_t)((uint16_t)x >> 8);
        r[4] = (uint8_t)y;
        r[5] = (uint8_t)((uint16_t)y >> 8);
        r[6] = (uint8_t)(int8_t)take(&acc_wheel, 127);
        r[7] = (uint8_t)(int8_t)take(&acc_pan, 127);
        if (!tud_hid_n_report(ITF_MOUSE, 0, r, sizeof(r))) return false;
    }
    sent_buttons = cur_buttons;
    return true;
}

static void chord_check(uint16_t buttons) {
    if (!(g_app.cfg.flags & OMNI_FLAG_CHORD_TOGGLE)) return;
    if ((buttons & CHORD_BUTTONS) != CHORD_BUTTONS) {
        chord_start_us = 0;
        chord_armed = true;
        return;
    }
    if (!chord_armed) return;
    // Core 0's clock rather than the event timestamp: chord_task() checks too,
    // and a queued event can be stamped before chord_start_us.
    uint32_t now = time_us_32();
    if (chord_start_us == 0) chord_start_us = now | 1;
    if ((uint32_t)(now - chord_start_us) >= CHORD_HOLD_US) {
        chord_armed = false;
        set_enabled(!(g_app.cfg.flags & OMNI_FLAG_ENABLED));
        led_flash(3);
    }
}

static void apply_event(const mouse_event_t *ev) {
    int32_t ox, oy;
    omni_engine_process(&g_app.engine, ev->dx, ev->dy, ev->t_us, &ox, &oy);
    acc_x += ox;
    acc_y += oy;
    acc_wheel += ev->wheel;
    acc_pan += ev->pan;
    cur_buttons = ev->buttons;

    g_app.reports++;
    rate_count++;
    g_app.in_x += ev->dx;
    g_app.in_y += ev->dy;
    g_app.out_x += ox;
    g_app.out_y += oy;
    g_app.buttons = ev->buttons;
    chord_check(ev->buttons);
}

// Mice report only on change (SET_IDLE 0), so nothing arrives while the
// chord is held still: the hold time is checked from the loop as well.
static void chord_task(void) {
    if (tud_mounted() && !tud_suspended()) chord_check(cur_buttons);
}

static void mouse_task(void) {
    mouse_event_t ev;

    if (!tud_mounted()) {
        // Not configured: drop motion. Once configured, the PC starts with
        // every button released, so a button still held is sent then.
        while (queue_try_remove(&g_mouse_queue, &ev)) cur_buttons = ev.buttons;
        acc_x = acc_y = acc_wheel = acc_pan = 0;
        sent_buttons = 0;
        return;
    }
    if (tud_suspended()) {
        // Nothing can be sent: drop motion but keep sent_buttons, so a button
        // released (or still held) across the suspend is reported on resume.
        // A new press wakes the PC.
        bool press = false;
        while (queue_try_remove(&g_mouse_queue, &ev)) {
            if (ev.buttons & ~cur_buttons) press = true;
            cur_buttons = ev.buttons;
        }
        if (press) tud_remote_wakeup();
        acc_x = acc_y = acc_wheel = acc_pan = 0;
        return;
    }

    while (queue_try_peek(&g_mouse_queue, &ev)) {
        // A button edge must not be merged into a report that already carries
        // a different button state, or a fast click could vanish.
        if (ev.buttons != cur_buttons && report_pending()) {
            if (!try_send_mouse()) return;
            continue;
        }
        queue_try_remove(&g_mouse_queue, &ev);
        apply_event(&ev);
    }
    if (report_pending()) try_send_mouse();
}

// True if `now` holds a key or modifier that `before` did not.
static bool kb_new_key(const uint8_t *now, const uint8_t *before) {
    if (now[0] & ~before[0]) return true;
    for (int i = 2; i < 8; i++) {
        if (now[i] < 4) continue;  // none, or a rollover/error code
        bool held = false;
        for (int j = 2; j < 8; j++) held |= before[j] == now[i];
        if (!held) return true;
    }
    return false;
}

static void keyboard_task(void) {
    kb_event_t ev;
    if (!tud_mounted()) {
        // Once configured, the PC starts with every key released.
        while (queue_try_remove(&g_kb_queue, &ev)) kb_cur = ev;
        memset(&kb_sent, 0, sizeof(kb_sent));
        return;
    }
    if (tud_suspended()) {
        // Keep the newest state for after resume; only a new key wakes the PC.
        bool press = false;
        while (queue_try_remove(&g_kb_queue, &ev)) {
            if (kb_new_key(ev.report, kb_cur.report)) press = true;
            kb_cur = ev;
        }
        if (press) tud_remote_wakeup();
        return;
    }
    if (!tud_hid_n_ready(ITF_KEYBOARD)) return;
    // First bring the PC up to date (a change it missed while suspended, or a
    // report that could not be sent), then forward queued reports one at a
    // time so quick presses are not merged.
    if (memcmp(&kb_cur, &kb_sent, sizeof(kb_cur)) == 0) {
        if (!queue_try_remove(&g_kb_queue, &ev)) return;
        kb_cur = ev;
    }
    if (tud_hid_n_report(ITF_KEYBOARD, 0, kb_cur.report, sizeof(kb_cur.report))) kb_sent = kb_cur;
}

// ------------------------------------------------------------------ suspend

static bool mouse_power_cut;  // VBUS switched off for a suspend without remote wakeup

static void mouse_power(bool on) {
#if OMNI_VBUS_EN_PIN >= 0
    gpio_put(OMNI_VBUS_EN_PIN, on ? OMNI_VBUS_EN_LEVEL : !OMNI_VBUS_EN_LEVEL);
    mouse_power_cut = !on;
#else
    (void)on;
#endif
}

// The PC is asleep. If it did not arm remote wakeup, a click cannot wake it,
// so boards that can switch the mouse's VBUS power the mouse (sensor, RGB)
// down until resume; it then re-enumerates like a fresh plug-in. With wakeup
// armed the mouse stays powered so a click still wakes the PC. Stopping
// PIO-USB's SOFs instead is not an option: pio_usb_host_stop() never returns
// in the pinned Pico-PIO-USB.
void tud_suspend_cb(bool remote_wakeup_en) {
    if (!remote_wakeup_en) mouse_power(false);
}

void tud_resume_cb(void) { mouse_power(true); }

// A bus reset ends a suspend too, and need not come with tud_resume_cb().
static void power_task(void) {
    if (mouse_power_cut && !tud_suspended()) mouse_power(true);
}

// ------------------------------------------------------------------ housekeeping

static void stats_task(void) {
    // Own counter: RESET_COUNTERS zeroes g_app.reports mid-window.
    static uint32_t window_start;
    uint32_t now = time_us_32();
    if ((uint32_t)(now - window_start) >= 1000000u) {
        g_app.reports_per_sec = (uint16_t)(rate_count > 0xFFFF ? 0xFFFF : rate_count);
        rate_count = 0;
        window_start = now;
    }
}

static void watchdog_task(void) {
    // Only feed the watchdog while core 1 (the mouse host) is alive too.
    static uint32_t last_beat, last_change_us;
    uint32_t now = time_us_32();
    if (g_host.heartbeat != last_beat) {
        last_beat = g_host.heartbeat;
        last_change_us = now;
    }
    if ((uint32_t)(now - last_change_us) < 500000u) watchdog_update();
}

static void reboot_task(void) {
    if (!reboot_pending || (int32_t)(time_us_32() - reboot_at_us) < 0) return;
    if (reboot_to_bootloader) reset_usb_boot(0, 0);
    watchdog_reboot(0, 0, 0);
    while (true) tight_loop_contents();
}

static void vbus_init(void) {
#if OMNI_VBUS_EN_PIN >= 0
    gpio_init(OMNI_VBUS_EN_PIN);
    gpio_set_dir(OMNI_VBUS_EN_PIN, GPIO_OUT);
    gpio_put(OMNI_VBUS_EN_PIN, OMNI_VBUS_EN_LEVEL);
#endif
}

int main(void) {
    // PIO-USB bit-bangs full-speed USB and needs a 120 MHz system clock.
    set_sys_clock_khz(120000, true);

    vbus_init();
    led_init();

    omni_config_t cfg;
    uint32_t seq = 0;
    g_app.has_saved = storage_load(&cfg, &seq);
    if (!g_app.has_saved) omni_config_default(&cfg);
    g_app.save_seq = seq;
    g_app.saved = cfg;
    omni_config_sanitize(&g_app.saved);
    app_apply_config(&cfg);

    queue_init(&g_mouse_queue, sizeof(mouse_event_t), 128);
    queue_init(&g_kb_queue, sizeof(kb_event_t), 32);
    multicore_launch_core1(host_core1_main);

    const tusb_rhport_init_t dev_init = {.role = TUSB_ROLE_DEVICE, .speed = TUSB_SPEED_AUTO};
    tusb_init(BOARD_TUD_RHPORT, &dev_init);
    watchdog_enable(1000, true);

    while (true) {
        tud_task();
        mouse_task();
        keyboard_task();
        chord_task();
        stats_task();
        power_task();
        if (tud_suspended()) led_off();
        else led_task(!g_host.mouse_attached ? LED_NO_MOUSE
                      : (g_app.cfg.flags & OMNI_FLAG_ENABLED) ? LED_ENABLED
                                                              : LED_BYPASS);
        reboot_task();
        watchdog_task();
    }
}
