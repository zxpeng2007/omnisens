// config_store.h - append-only configuration log in a pair of flash sectors.
//
// Each sector holds OMNI_STORE_SLOTS records of one flash page each. A save
// programs the next erased page after the newest record (about 1 ms, no
// erase). When that sector is full, the save erases the other sector and
// writes slot 0 there; the full sector is left alone until the next switch.
// The sector holding the newest record is therefore never erased, and a
// power loss during a save always leaves the previous record loadable.
// Layout is documented in docs/PROTOCOL.md ("Flash storage"). These are pure
// functions over sector images; the flash I/O lives in storage.c.
#ifndef CONFIG_STORE_H
#define CONFIG_STORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "omni_core.h"

#ifdef __cplusplus
extern "C" {
#endif

#define OMNI_STORE_SECTOR_SIZE 4096
#define OMNI_STORE_SLOT_SIZE   256
#define OMNI_STORE_SLOTS       (OMNI_STORE_SECTOR_SIZE / OMNI_STORE_SLOT_SIZE)
#define OMNI_STORE_SECTORS     2
#define OMNI_STORE_MAGIC       0x534E4D4Fu  // "OMNS"

uint32_t omni_crc32(const uint8_t *data, size_t len);

// Newest record in the sector that this firmware can load (ties go to the
// higher slot): returns its slot index (or -1 if none) and fills *cfg / *seq
// when found.
int omni_store_find_latest(const uint8_t *sector, omni_config_t *cfg, uint32_t *seq);

// Newest valid record (magic and CRC) whatever its config version, so that
// numbering continues above records written by other firmware versions
// (ties go to the higher slot). Returns its slot index (or -1 if none) and
// fills *seq when found.
int omni_store_find_newest(const uint8_t *sector, uint32_t *seq);

// Slot to program next given the newest valid slot (-1 if none): the first
// fully erased slot after it. Returns -1 if the sector is full.
int omni_store_next_slot(const uint8_t *sector, int latest);

// Builds the 256-byte record for cfg with sequence number seq.
void omni_store_build_record(const omni_config_t *cfg, uint32_t seq, uint8_t out[OMNI_STORE_SLOT_SIZE]);

// Newest loadable record across the sector pair. Returns false if there is none.
bool omni_store_load(const uint8_t *const sectors[OMNI_STORE_SECTORS], omni_config_t *cfg, uint32_t *seq);

// Where the next record goes.
typedef struct {
    int      sector;  // index into sectors[]
    int      slot;
    bool     erase;   // erase that sector first; it never holds the newest record
    uint32_t seq;     // sequence number for the new record
} omni_store_plan_t;

void omni_store_plan_save(const uint8_t *const sectors[OMNI_STORE_SECTORS], omni_store_plan_t *plan);

#ifdef __cplusplus
}
#endif

#endif  // CONFIG_STORE_H
