cmake_minimum_required(VERSION 3.17)  # pico-sdk 2.x's picotool lookup needs 3.17

# Board: one of the files in firmware/boards (without extension).
set(OMNI_BOARD "feather_rp2040_usb_host" CACHE STRING "Target board, see firmware/boards")
set(OMNI_BOARD_DIR ${CMAKE_CURRENT_LIST_DIR}/boards)
if(NOT EXISTS ${OMNI_BOARD_DIR}/${OMNI_BOARD}.cmake)
    message(FATAL_ERROR "Unknown OMNI_BOARD '${OMNI_BOARD}'. See firmware/boards/.")
endif()
include(${OMNI_BOARD_DIR}/${OMNI_BOARD}.cmake)

# Dependencies: -D options, then environment variables, then OMNI_DEPS_DIR
# (populated by scripts/fetch-deps.sh, default firmware/deps). The resolved
# paths are cached so later re-configures keep using the same versions.
# Must be known before pico_sdk_init().
if(DEFINED ENV{OMNI_DEPS_DIR})
    set(_omni_deps_default "$ENV{OMNI_DEPS_DIR}")
else()
    set(_omni_deps_default "${CMAKE_CURRENT_LIST_DIR}/deps")
endif()
set(OMNI_DEPS_DIR "${_omni_deps_default}" CACHE PATH "Directory holding pico-sdk, tinyusb and Pico-PIO-USB (see scripts/fetch-deps.sh)")
foreach(dep PICO_SDK_PATH:pico-sdk PICO_TINYUSB_PATH:tinyusb PICO_PIO_USB_PATH:Pico-PIO-USB)
    string(REPLACE ":" ";" dep ${dep})
    list(GET dep 0 var)
    list(GET dep 1 dir)
    if(NOT ${var} AND DEFINED ENV{${var}})
        set(${var} $ENV{${var}})
    endif()
    if(NOT ${var} AND EXISTS ${OMNI_DEPS_DIR}/${dir})
        set(${var} ${OMNI_DEPS_DIR}/${dir})
    endif()
    if(NOT ${var})
        message(FATAL_ERROR "${var} is not set. Run 'bash firmware/scripts/fetch-deps.sh', "
                            "or pass -DOMNI_DEPS_DIR=<its directory> or -D${var}=<path>.")
    endif()
    set(${var} "${${var}}" CACHE PATH "omnisens: path to ${dir}" FORCE)
    message(STATUS "omnisens: ${var} = ${${var}}")
endforeach()

include(pico_sdk_import.cmake)

project(omnisens C CXX ASM)
set(CMAKE_C_STANDARD 11)

pico_sdk_init()

if(NOT TARGET tinyusb_pico_pio_usb)
    message(FATAL_ERROR "TinyUSB did not pick up Pico-PIO-USB at ${PICO_PIO_USB_PATH}")
endif()

add_executable(omnisens
    src/main.c
    src/host.c
    src/vendor.c
    src/usb_descriptors.c
    src/storage.c
    src/led.c
    src/omni_core.c
    src/hid_parser.c
    src/config_store.c
)

target_include_directories(omnisens PRIVATE src ${OMNI_BOARD_DIR})
target_compile_definitions(omnisens PRIVATE
    OMNI_BOARD_HEADER="omni_board_${OMNI_BOARD}.h"
    PICO_XOSC_STARTUP_DELAY_MULTIPLIER=64
)
target_compile_options(omnisens PRIVATE -Wall -Wextra -Wno-unused-parameter)

pico_generate_pio_header(omnisens ${CMAKE_CURRENT_LIST_DIR}/src/ws2812.pio)

target_link_libraries(omnisens PRIVATE
    pico_stdlib
    pico_multicore
    pico_unique_id
    hardware_flash
    hardware_pio
    hardware_watchdog
    tinyusb_device
    tinyusb_host
    tinyusb_pico_pio_usb
)

# Run entirely from SRAM: saving the configuration to flash then never
# stalls the PIO-USB host on the other core.
pico_set_binary_type(omnisens copy_to_ram)

# The USB port belongs to TinyUSB and GPIO0/1 may be the host port: no stdio.
pico_enable_stdio_usb(omnisens 0)
pico_enable_stdio_uart(omnisens 0)

set_target_properties(omnisens PROPERTIES OUTPUT_NAME omnisens-${OMNI_BOARD})
pico_add_extra_outputs(omnisens)
