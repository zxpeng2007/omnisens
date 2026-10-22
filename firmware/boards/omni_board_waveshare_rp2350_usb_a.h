// Waveshare RP2350-USB-A. Host socket on GPIO12 (D+) / GPIO13 (D-), RGB LED on GPIO16.
// Host mode needs the 1.5k D+ pull-up R13 removed (see docs/HARDWARE.md).
#pragma once
#define OMNI_BOARD_NAME         "RP2350-USB-A"
#define OMNI_BOARD_ID           4
#define OMNI_PIO_USB_DP_PIN     12
#define OMNI_VBUS_EN_PIN        (-1)
#define OMNI_VBUS_EN_LEVEL      1
#define OMNI_LED_PIN            (-1)
#define OMNI_LED_ACTIVE_HIGH    1
#define OMNI_WS2812_PIN         16
#define OMNI_WS2812_POWER_PIN   (-1)
