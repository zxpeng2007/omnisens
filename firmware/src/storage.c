// storage.c - configuration persistence in a reserved flash sector.
//
// The firmware runs from SRAM (copy_to_ram), so flash can be erased and
// programmed with interrupts on and the PIO-USB host running on core 1:
// nothing executes from flash while it is busy.
#include <string.h>

#include "config_store.h"
#include "hardware/flash.h"
#include "omnisens.h"

#if PICO_RP2350
// RP2350 UF2 downloads erase the last flash sector (erratum RP2350-E10
// workaround), so keep the configuration one sector below it.
#define STORE_OFFSET (PICO_FLASH_SIZE_BYTES - 2 * FLASH_SECTOR_SIZE)
#else
#define STORE_OFFSET (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE)
#endif

_Static_assert(OMNI_STORE_SECTOR_SIZE == FLASH_SECTOR_SIZE, "store expects 4 KB sectors");
_Static_assert(OMNI_STORE_SLOT_SIZE == FLASH_PAGE_SIZE, "store expects 256-byte pages");

extern char __flash_binary_end;

static const uint8_t *sector(void) { return (const uint8_t *)(XIP_BASE + STORE_OFFSET); }

// Refuse to touch flash if the firmware image ever grows into the config sector.
static bool sector_is_free(void) {
    return (uintptr_t)&__flash_binary_end <= (uintptr_t)(XIP_BASE + STORE_OFFSET);
}

bool storage_load(omni_config_t *cfg, uint32_t *seq) {
    if (!sector_is_free()) return false;
    omni_config_t c;
    uint32_t s = 0;
    if (omni_store_find_latest(sector(), &c, &s) < 0) return false;
    omni_config_sanitize(&c);
    *cfg = c;
    *seq = s;
    return true;
}

bool storage_save(const omni_config_t *cfg, uint32_t *seq_out) {
    if (!sector_is_free()) return false;

    omni_config_t current;
    uint32_t seq = 0;
    int latest = omni_store_find_latest(sector(), &current, &seq);
    int slot = omni_store_next_slot(sector(), latest);
    static uint8_t record[OMNI_STORE_SLOT_SIZE];  // static: keeps it off the stack
    uint32_t next_seq = latest >= 0 ? seq + 1 : 1;
    omni_store_build_record(cfg, next_seq, record);

    // Only core 0 reads flash, and only here; the erase (when the log is full)
    // takes tens of ms, a page program about 1 ms.
    if (slot < 0) {
        flash_range_erase(STORE_OFFSET, FLASH_SECTOR_SIZE);
        slot = 0;
    }
    flash_range_program(STORE_OFFSET + (uint32_t)slot * FLASH_PAGE_SIZE, record, FLASH_PAGE_SIZE);

    // Read back to be sure the record landed.
    if (memcmp(sector() + slot * FLASH_PAGE_SIZE, record, FLASH_PAGE_SIZE) != 0) return false;
    *seq_out = next_seq;
    return true;
}
