// omnisens.h - shared declarations for the RP2040/RP2350 firmware.
//
// Core 1 runs the PIO-USB host (the mouse side) and pushes decoded reports
// into queues; core 0 runs the USB device (the PC side), the correction
// engine, configuration and the status LED.
#ifndef OMNISENS_H
#define OMNISENS_H

#include <stdbool.h>
#include <stdint.h>

#include "omni_core.h"
#include "pico/util/queue.h"

#include OMNI_BOARD_HEADER

#define OMNI_FW_MAJOR 0
#define OMNI_FW_MINOR 1
#define OMNI_FW_PATCH 0

// WARNING: 0x1209:0x0001 is the pid.codes test PID. It is not unique and is
// meant for testing only; omnisens will move to a dedicated PID. Builds that
// are redistributed should set their own IDs (and update web/js/device.js).
#ifndef OMNI_USB_VID
#define OMNI_USB_VID 0x1209
#endif
#ifndef OMNI_USB_PID
#define OMNI_USB_PID 0x0001
#endif

// USB device interface / HID instance numbers (docs/PROTOCOL.md).
enum { ITF_MOUSE = 0, ITF_KEYBOARD = 1, ITF_CONFIG = 2, ITF_COUNT };

// One decoded report from the attached mouse(s), core 1 -> core 0.
typedef struct {
    uint32_t t_us;     // receive time, time_us_32()
    int32_t  dx, dy;   // raw counts
    int16_t  wheel, pan;
    uint16_t buttons;  // OR of all attached mice
} mouse_event_t;

typedef struct {
    uint8_t report[8];  // boot keyboard report
} kb_event_t;

extern queue_t g_mouse_queue;
extern queue_t g_kb_queue;

// Written by core 1 only, read by core 0.
typedef struct {
    volatile bool     mouse_attached;
    volatile bool     keyboard_attached;
    volatile bool     boot_fallback;
    volatile uint16_t vid, pid;
    volatile uint32_t heartbeat;   // incremented by the host loop
} host_status_t;
extern host_status_t g_host;

// host.c (core 1)
void host_core1_main(void);

// app state on core 0 (main.c)
typedef struct {
    omni_config_t cfg;        // live configuration
    omni_config_t saved;      // what is in flash (defaults if nothing saved)
    bool          has_saved;  // a valid record exists in flash
    uint32_t      save_seq;
    omni_engine_t engine;
    uint8_t       last_result;
    // live counters (report 3)
    uint32_t      reports;
    int32_t       in_x, in_y, out_x, out_y;
    uint16_t      buttons;
    uint16_t      reports_per_sec;
} app_t;
extern app_t g_app;

void app_apply_config(const omni_config_t *cfg);  // sanitize, apply, reset engine
bool app_is_dirty(void);
void app_request_reboot(bool bootloader);          // performed shortly after, from the main loop

// storage.c (core 0)
bool storage_load(omni_config_t *cfg, uint32_t *seq);
bool storage_save(const omni_config_t *cfg, uint32_t *seq);

// led.c (core 0)
typedef enum { LED_NO_MOUSE, LED_ENABLED, LED_BYPASS } led_state_t;
void led_init(void);
void led_task(led_state_t state);
void led_flash(uint8_t times);  // short attention pattern (chord toggle)

#endif  // OMNISENS_H
