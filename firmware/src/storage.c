// storage.c - configuration persistence in a reserved pair of flash sectors
// (the log itself is config_store.c).
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
// workaround), so the pair sits just below it.
#define STORE_END (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE)
#else
#define STORE_END PICO_FLASH_SIZE_BYTES
#endif
// Sector k of the pair. The upper one is where single-sector builds kept the
// log, so a configuration saved by them still loads.
#define STORE_OFFSET(k) (STORE_END - (uint32_t)(OMNI_STORE_SECTORS - (k)) * FLASH_SECTOR_SIZE)

_Static_assert(OMNI_STORE_SECTOR_SIZE == FLASH_SECTOR_SIZE, "store expects 4 KB sectors");
_Static_assert(OMNI_STORE_SLOT_SIZE == FLASH_PAGE_SIZE, "store expects 256-byte pages");
_Static_assert(OMNI_STORE_SECTORS == 2, "sectors[] below lists two sectors");

static const uint8_t *const sectors[OMNI_STORE_SECTORS] = {
    (const uint8_t *)(XIP_BASE + STORE_OFFSET(0)),
    (const uint8_t *)(XIP_BASE + STORE_OFFSET(1)),
};

extern char __flash_binary_end;

// Refuse to touch flash if the firmware image ever grows into the config sectors.
static bool store_is_free(void) {
    return (uintptr_t)&__flash_binary_end <= (uintptr_t)(XIP_BASE + STORE_OFFSET(0));
}

bool storage_load(omni_config_t *cfg, uint32_t *seq) {
    if (!store_is_free()) return false;
    omni_config_t c;
    uint32_t s = 0;
    if (!omni_store_load(sectors, &c, &s)) return false;
    omni_config_sanitize(&c);
    *cfg = c;
    *seq = s;
    return true;
}

bool storage_save(const omni_config_t *cfg, uint32_t *seq_out) {
    if (!store_is_free()) return false;

    omni_store_plan_t p;
    omni_store_plan_save(sectors, &p);
    static uint8_t record[OMNI_STORE_SLOT_SIZE];  // static: keeps it off the stack
    omni_store_build_record(cfg, p.seq, record);

    // Only core 0 reads flash, and only here. A page program takes about
    // 1 ms; a save that switches sectors (one in 16) erases first, tens of ms.
    uint32_t ofs = STORE_OFFSET(p.sector);
    if (p.erase) flash_range_erase(ofs, FLASH_SECTOR_SIZE);
    flash_range_program(ofs + (uint32_t)p.slot * FLASH_PAGE_SIZE, record, FLASH_PAGE_SIZE);

    // Read back to be sure the record landed.
    if (memcmp(sectors[p.sector] + p.slot * FLASH_PAGE_SIZE, record, FLASH_PAGE_SIZE) != 0) return false;
    *seq_out = p.seq;
    return true;
}
