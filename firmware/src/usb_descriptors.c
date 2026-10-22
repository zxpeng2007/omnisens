// usb_descriptors.c - the composite HID device the PC sees.
#include <string.h>

#include "omnisens.h"
#include "pico/unique_id.h"
#include "report_descs.h"
#include "tusb.h"

static const uint8_t keyboard_report_desc[] = {TUD_HID_REPORT_DESC_KEYBOARD()};

static const tusb_desc_device_t device_desc = {
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0200,
    .bDeviceClass = 0x00,
    .bDeviceSubClass = 0x00,
    .bDeviceProtocol = 0x00,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = OMNI_USB_VID,
    .idProduct = OMNI_USB_PID,
    .bcdDevice = (OMNI_FW_MAJOR << 8) | (OMNI_FW_MINOR << 4) | OMNI_FW_PATCH,
    .iManufacturer = 1,
    .iProduct = 2,
    .iSerialNumber = 3,
    .bNumConfigurations = 1,
};

const uint8_t *tud_descriptor_device_cb(void) { return (const uint8_t *)&device_desc; }

const uint8_t *tud_hid_descriptor_report_cb(uint8_t instance) {
    switch (instance) {
        case ITF_MOUSE: return omni_mouse_report_desc;
        case ITF_KEYBOARD: return keyboard_report_desc;
        default: return omni_config_report_desc;
    }
}

#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + ITF_COUNT * TUD_HID_DESC_LEN)

static const uint8_t config_desc[] = {
    // 500 mA: the adapter passes bus power through to the mouse.
    TUD_CONFIG_DESCRIPTOR(1, ITF_COUNT, 0, CONFIG_TOTAL_LEN, TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 500),
    TUD_HID_DESCRIPTOR(ITF_MOUSE, 4, HID_ITF_PROTOCOL_MOUSE, sizeof(omni_mouse_report_desc), 0x81, 16, 1),
    TUD_HID_DESCRIPTOR(ITF_KEYBOARD, 5, HID_ITF_PROTOCOL_KEYBOARD, sizeof(keyboard_report_desc), 0x82, 8, 1),
    TUD_HID_DESCRIPTOR(ITF_CONFIG, 6, HID_ITF_PROTOCOL_NONE, sizeof(omni_config_report_desc), 0x83, 64, 10),
};

const uint8_t *tud_descriptor_configuration_cb(uint8_t index) {
    (void)index;
    return config_desc;
}

static const char *const strings[] = {
    NULL,  // 0: language, handled below
    "omnisens",
    "omnisens adapter",
    NULL,  // 3: serial, from the flash unique ID
    "omnisens mouse",
    "omnisens keyboard passthrough",
    "omnisens config",
};

static uint16_t desc_str[32 + 1];

const uint16_t *tud_descriptor_string_cb(uint8_t index, uint16_t langid) {
    (void)langid;
    char serial[2 * PICO_UNIQUE_BOARD_ID_SIZE_BYTES + 1];
    const char *str;
    size_t n;

    if (index == 0) {
        desc_str[1] = 0x0409;
        n = 1;
    } else {
        if (index == 3) {
            pico_get_unique_board_id_string(serial, sizeof(serial));
            str = serial;
        } else if (index < sizeof(strings) / sizeof(strings[0])) {
            str = strings[index];
        } else {
            return NULL;
        }
        n = strlen(str);
        if (n > 32) n = 32;
        for (size_t i = 0; i < n; i++) desc_str[1 + i] = (uint8_t)str[i];
    }
    desc_str[0] = (uint16_t)((TUSB_DESC_STRING << 8) | (2 * n + 2));
    return desc_str;
}
