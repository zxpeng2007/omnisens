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

// Accumulated output that has not been sent to the PC yet.
static int32_t acc_x, acc_y, acc_wheel, acc_pan;
static uint16_t cur_buttons, sent_buttons;

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

static void chord_check(uint16_t buttons, uint32_t now) {
    if (!(g_app.cfg.flags & OMNI_FLAG_CHORD_TOGGLE)) return;
    if ((buttons & CHORD_BUTTONS) != CHORD_BUTTONS) {
        chord_start_us = 0;
        chord_armed = true;
        return;
    }
    if (!chord_armed) return;
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
    g_app.in_x += ev->dx;
    g_app.in_y += ev->dy;
    g_app.out_x += ox;
    g_app.out_y += oy;
    g_app.buttons = ev->buttons;
    chord_check(ev->buttons, ev->t_us);
}

static void mouse_task(void) {
    mouse_event_t ev;

    if (!tud_mounted() || tud_suspended()) {
        // Nobody is listening: drop motion, but a click wakes a sleeping PC.
        bool click = false;
        while (queue_try_remove(&g_mouse_queue, &ev)) {
            if (ev.buttons & ~cur_buttons) click = true;
            cur_buttons = ev.buttons;
        }
        if (click && tud_suspended()) tud_remote_wakeup();
        acc_x = acc_y = acc_wheel = acc_pan = 0;
        sent_buttons = cur_buttons;
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

static void keyboard_task(void) {
    kb_event_t ev;
    if (!tud_mounted()) {
        while (queue_try_remove(&g_kb_queue, &ev)) {}
        return;
    }
    if (tud_suspended()) {
        if (queue_try_remove(&g_kb_queue, &ev)) tud_remote_wakeup();
        return;
    }
    if (!tud_hid_n_ready(ITF_KEYBOARD)) return;
    if (queue_try_remove(&g_kb_queue, &ev)) tud_hid_n_report(ITF_KEYBOARD, 0, ev.report, sizeof(ev.report));
}

// ------------------------------------------------------------------ housekeeping

static void stats_task(void) {
    static uint32_t window_start, window_reports;
    uint32_t now = time_us_32();
    if ((uint32_t)(now - window_start) >= 1000000u) {
        uint32_t n = g_app.reports - window_reports;
        g_app.reports_per_sec = (uint16_t)(n > 0xFFFF ? 0xFFFF : n);
        window_reports = g_app.reports;
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
        stats_task();
        led_task(!g_host.mouse_attached ? LED_NO_MOUSE
                 : (g_app.cfg.flags & OMNI_FLAG_ENABLED) ? LED_ENABLED
                                                         : LED_BYPASS);
        reboot_task();
        watchdog_task();
    }
}
