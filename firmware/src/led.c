// led.c - status LED: a plain GPIO LED or a WS2812 RGB LED, depending on the board.
//   correction on  -> solid (green on RGB boards)
//   bypass         -> off   (dim red on RGB boards)
//   no mouse       -> slow blink (blue on RGB boards)
//   chord toggled  -> quick flashes
#include "omnisens.h"
#include "pico/stdlib.h"

#if OMNI_WS2812_PIN >= 0
#include "hardware/pio.h"
#include "ws2812.pio.h"

// PIO-USB uses PIO0; the RGB LED gets a state machine on the last PIO block.
#if NUM_PIOS > 2
#define LED_PIO pio2
#else
#define LED_PIO pio1
#endif
static uint led_sm;

static void put_rgb(uint8_t r, uint8_t g, uint8_t b) {
    uint32_t grb = ((uint32_t)g << 16) | ((uint32_t)r << 8) | b;
    if (!pio_sm_is_tx_fifo_full(LED_PIO, led_sm)) pio_sm_put(LED_PIO, led_sm, grb << 8u);
}
#endif

#if OMNI_LED_PIN >= 0
static void put_led(bool on) { gpio_put(OMNI_LED_PIN, on == (OMNI_LED_ACTIVE_HIGH != 0)); }
#endif

static uint8_t flash_left;
static uint32_t flash_next_us;
static int last_level = -1;

void led_init(void) {
#if OMNI_LED_PIN >= 0
    gpio_init(OMNI_LED_PIN);
    gpio_set_dir(OMNI_LED_PIN, GPIO_OUT);
    put_led(false);
#endif
#if OMNI_WS2812_PIN >= 0
#if OMNI_WS2812_POWER_PIN >= 0
    gpio_init(OMNI_WS2812_POWER_PIN);
    gpio_set_dir(OMNI_WS2812_POWER_PIN, GPIO_OUT);
    gpio_put(OMNI_WS2812_POWER_PIN, 1);
#endif
    led_sm = (uint)pio_claim_unused_sm(LED_PIO, true);
    uint offset = pio_add_program(LED_PIO, &ws2812_program);
    ws2812_program_init(LED_PIO, led_sm, offset, OMNI_WS2812_PIN, 800000, false);
    put_rgb(0, 0, 0);
#endif
}

void led_flash(uint8_t times) {
    flash_left = (uint8_t)(times * 2);
    flash_next_us = time_us_32();
}

// level: 0 off, 1 on; state picks the RGB colour.
static void show(int level, led_state_t state) {
    int key = level * 4 + (int)state;
    if (key == last_level) return;
    last_level = key;
#if OMNI_LED_PIN >= 0
    put_led(level != 0);
#endif
#if OMNI_WS2812_PIN >= 0
    if (!level) put_rgb(state == LED_BYPASS ? 6 : 0, 0, 0);
    else if (state == LED_ENABLED) put_rgb(0, 24, 0);
    else if (state == LED_BYPASS) put_rgb(24, 0, 0);
    else put_rgb(0, 0, 24);
#endif
}

void led_task(led_state_t state) {
    uint32_t now = time_us_32();
    if (flash_left) {
        if ((int32_t)(now - flash_next_us) >= 0) {
            flash_left--;
            flash_next_us = now + 80000;
        }
        show(flash_left & 1, state);
        return;
    }
    switch (state) {
        case LED_NO_MOUSE: show((now / 500000u) & 1, state); break;
        case LED_ENABLED: show(1, state); break;
        case LED_BYPASS: show(0, state); break;
    }
}
