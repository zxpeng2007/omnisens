// config_store.h - append-only configuration log in one flash sector.
//
// The sector holds OMNI_STORE_SLOTS records of one flash page each. A save
// programs the next erased page (about 1 ms, no erase), and the sector is
// erased only when it is full, which keeps wear low and USB stalls short.
// Layout is documented in docs/PROTOCOL.md ("Flash storage"). These are pure
// functions over a sector image; the flash I/O lives in the board code.
#ifndef CONFIG_STORE_H
#define CONFIG_STORE_H

#include <stddef.h>
#include <stdint.h>

#include "omni_core.h"

#ifdef __cplusplus
extern "C" {
#endif

#define OMNI_STORE_SECTOR_SIZE 4096
#define OMNI_STORE_SLOT_SIZE   256
#define OMNI_STORE_SLOTS       (OMNI_STORE_SECTOR_SIZE / OMNI_STORE_SLOT_SIZE)
#define OMNI_STORE_MAGIC       0x534E4D4Fu  // "OMNS"

uint32_t omni_crc32(const uint8_t *data, size_t len);

// Newest valid record in the sector: returns its slot index (or -1 if none)
// and fills *cfg / *seq when found.
int omni_store_find_latest(const uint8_t *sector, omni_config_t *cfg, uint32_t *seq);

// Slot to program next given the newest valid slot (-1 if none): the first
// fully erased slot after it. Returns -1 if the sector must be erased first.
int omni_store_next_slot(const uint8_t *sector, int latest);

// Builds the 256-byte record for cfg with sequence number seq.
void omni_store_build_record(const omni_config_t *cfg, uint32_t seq, uint8_t out[OMNI_STORE_SLOT_SIZE]);

#ifdef __cplusplus
}
#endif

#endif  // CONFIG_STORE_H
