// TinyUSB configuration: native USB = device (to the PC), PIO-USB = host (the mouse).
#ifndef TUSB_CONFIG_H
#define TUSB_CONFIG_H

#define BOARD_TUD_RHPORT 0
#define BOARD_TUH_RHPORT 1

#ifndef CFG_TUSB_MCU
#error CFG_TUSB_MCU must be defined by the build
#endif
#ifndef CFG_TUSB_OS
#define CFG_TUSB_OS OPT_OS_PICO
#endif
#define CFG_TUSB_DEBUG 0

#define CFG_TUSB_MEM_SECTION
#define CFG_TUSB_MEM_ALIGN __attribute__((aligned(4)))

//------------- device (to the PC) -------------//
#define CFG_TUD_ENABLED        1
#define CFG_TUD_ENDPOINT0_SIZE 64
#define CFG_TUD_HID            3   // mouse, keyboard, vendor config
#define CFG_TUD_HID_EP_BUFSIZE 64  // a 63-byte feature report plus its report ID

//------------- host (the mouse) -------------//
#define CFG_TUH_ENABLED     1
#define CFG_TUH_RPI_PIO_USB 1
// Gaming mice often have report descriptors well over 256 bytes.
#define CFG_TUH_ENUMERATION_BUFSIZE 1024
#define CFG_TUH_HUB         1      // a hub lets a mouse and keyboard share the port
#define CFG_TUH_DEVICE_MAX  4
#define CFG_TUH_HID         (3 * CFG_TUH_DEVICE_MAX)
#define CFG_TUH_HID_EPIN_BUFSIZE  64
#define CFG_TUH_HID_EPOUT_BUFSIZE 64

#endif  // TUSB_CONFIG_H
