// Raspberry Pi Pico 2 (RP2350) with a DIY USB-A socket: D+ GPIO0, D- GPIO1,
// VBUS from the Pico's VBUS pin (40), GND to any GND.
#pragma once
#define OMNI_BOARD_NAME         "Pico 2 DIY"
#define OMNI_BOARD_ID           3
#define OMNI_PIO_USB_DP_PIN     0
#define OMNI_VBUS_EN_PIN        (-1)
#define OMNI_VBUS_EN_LEVEL      1
#define OMNI_LED_PIN            25
#define OMNI_LED_ACTIVE_HIGH    1
#define OMNI_WS2812_PIN         (-1)
#define OMNI_WS2812_POWER_PIN   (-1)
