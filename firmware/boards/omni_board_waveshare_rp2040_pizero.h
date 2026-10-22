// Waveshare RP2040-PiZero. PIO-USB Type-C port: D+ GPIO6, D- GPIO7. No user LED.
// Host mode needs the 2.2k D+ pull-up R34 removed (see docs/HARDWARE.md).
#pragma once
#define OMNI_BOARD_NAME         "RP2040-PiZero"
#define OMNI_BOARD_ID           5
#define OMNI_PIO_USB_DP_PIN     6
#define OMNI_VBUS_EN_PIN        (-1)
#define OMNI_VBUS_EN_LEVEL      1
#define OMNI_LED_PIN            (-1)
#define OMNI_LED_ACTIVE_HIGH    1
#define OMNI_WS2812_PIN         (-1)
#define OMNI_WS2812_POWER_PIN   (-1)
