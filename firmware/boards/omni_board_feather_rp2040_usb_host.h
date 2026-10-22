// Adafruit Feather RP2040 with USB Type A Host (product 5723).
#pragma once
#define OMNI_BOARD_NAME         "Feather USB Host"
#define OMNI_BOARD_ID           1
#define OMNI_PIO_USB_DP_PIN     16    // D- is GPIO17
#define OMNI_VBUS_EN_PIN        18    // 5 V boost for the USB-A port (pulled up, on by default)
#define OMNI_VBUS_EN_LEVEL      1
#define OMNI_LED_PIN            13    // red LED
#define OMNI_LED_ACTIVE_HIGH    1
#define OMNI_WS2812_PIN         21    // NeoPixel
#define OMNI_WS2812_POWER_PIN   20
