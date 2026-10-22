// report_descs.h - HID report descriptors the adapter presents to the PC.
// Kept free of TinyUSB macros so host tests can parse them (firmware/test).
#ifndef REPORT_DESCS_H
#define REPORT_DESCS_H

#include <stdint.h>

#define OMNI_MOUSE_REPORT_LEN 8
#define OMNI_BOOT_MOUSE_REPORT_LEN 4
#define OMNI_CONFIG_REPORT_LEN 63

// Interface 0: 16 buttons, int16 X/Y, int8 wheel, int8 AC Pan. No report ID.
static const uint8_t omni_mouse_report_desc[] = {
    0x05, 0x01,        // Usage Page (Generic Desktop)
    0x09, 0x02,        // Usage (Mouse)
    0xA1, 0x01,        // Collection (Application)
    0x09, 0x01,        //   Usage (Pointer)
    0xA1, 0x00,        //   Collection (Physical)
    0x05, 0x09,        //     Usage Page (Button)
    0x19, 0x01,        //     Usage Minimum (1)
    0x29, 0x10,        //     Usage Maximum (16)
    0x15, 0x00,        //     Logical Minimum (0)
    0x25, 0x01,        //     Logical Maximum (1)
    0x95, 0x10,        //     Report Count (16)
    0x75, 0x01,        //     Report Size (1)
    0x81, 0x02,        //     Input (Data, Var, Abs)
    0x05, 0x01,        //     Usage Page (Generic Desktop)
    0x16, 0x01, 0x80,  //     Logical Minimum (-32767)
    0x26, 0xFF, 0x7F,  //     Logical Maximum (32767)
    0x75, 0x10,        //     Report Size (16)
    0x95, 0x02,        //     Report Count (2)
    0x09, 0x30,        //     Usage (X)
    0x09, 0x31,        //     Usage (Y)
    0x81, 0x06,        //     Input (Data, Var, Rel)
    0x15, 0x81,        //     Logical Minimum (-127)
    0x25, 0x7F,        //     Logical Maximum (127)
    0x75, 0x08,        //     Report Size (8)
    0x95, 0x01,        //     Report Count (1)
    0x09, 0x38,        //     Usage (Wheel)
    0x81, 0x06,        //     Input (Data, Var, Rel)
    0x05, 0x0C,        //     Usage Page (Consumer)
    0x0A, 0x38, 0x02,  //     Usage (AC Pan)
    0x95, 0x01,        //     Report Count (1)
    0x81, 0x06,        //     Input (Data, Var, Rel)
    0xC0,              //   End Collection
    0xC0,              // End Collection
};

// Interface 2: vendor page, three 63-byte feature reports and one unused input report.
static const uint8_t omni_config_report_desc[] = {
    0x06, 0x00, 0xFF,  // Usage Page (Vendor 0xFF00)
    0x09, 0x01,        // Usage (1)
    0xA1, 0x01,        // Collection (Application)
    0x15, 0x00,        //   Logical Minimum (0)
    0x26, 0xFF, 0x00,  //   Logical Maximum (255)
    0x75, 0x08,        //   Report Size (8)
    0x95, 0x3F,        //   Report Count (63)
    0x85, 0x01,        //   Report ID (1) configuration
    0x09, 0x01,        //   Usage (1)
    0xB1, 0x02,        //   Feature (Data, Var, Abs)
    0x85, 0x02,        //   Report ID (2) status / command
    0x09, 0x02,        //   Usage (2)
    0xB1, 0x02,        //   Feature (Data, Var, Abs)
    0x85, 0x03,        //   Report ID (3) live counters
    0x09, 0x03,        //   Usage (3)
    0xB1, 0x02,        //   Feature (Data, Var, Abs)
    0x85, 0x04,        //   Report ID (4) reserved input
    0x09, 0x04,        //   Usage (4)
    0x81, 0x02,        //   Input (Data, Var, Abs)
    0xC0,              // End Collection
};

#endif  // REPORT_DESCS_H
