// Host unit tests for config_store.c (simulated flash sector).
#include <stdio.h>
#include <string.h>

#include "../src/config_store.h"

static int failures;
#define CHECK(cond, ...)                                \
    do {                                                \
        if (!(cond)) {                                  \
            failures++;                                 \
            printf("FAIL %s:%d: ", __FILE__, __LINE__); \
            printf(__VA_ARGS__);                        \
            printf("\n");                               \
        }                                               \
    } while (0)

static uint8_t sector[OMNI_STORE_SECTOR_SIZE];
static int erases;

static void flash_erase(void) { memset(sector, 0xFF, sizeof(sector)); erases++; }

// NOR flash programming can only clear bits.
static void flash_program(int slot, const uint8_t *rec) {
    uint8_t *p = sector + slot * OMNI_STORE_SLOT_SIZE;
    for (int i = 0; i < OMNI_STORE_SLOT_SIZE; i++) p[i] &= rec[i];
}

// Mirrors the firmware's save routine.
static void save(const omni_config_t *cfg) {
    omni_config_t cur;
    uint32_t seq = 0;
    int latest = omni_store_find_latest(sector, &cur, &seq);
    int slot = omni_store_next_slot(sector, latest);
    if (slot < 0) { flash_erase(); slot = 0; }
    uint8_t rec[OMNI_STORE_SLOT_SIZE];
    omni_store_build_record(cfg, latest >= 0 ? seq + 1 : 1, rec);
    flash_program(slot, rec);
}

int main(void) {
    CHECK(omni_crc32((const uint8_t *)"123456789", 9) == 0xCBF43926u, "crc32 check value");

    flash_erase();
    erases = 0;
    omni_config_t cfg, got;
    uint32_t seq;
    CHECK(omni_store_find_latest(sector, &got, &seq) == -1, "empty sector has no record");

    omni_config_default(&cfg);
    for (int i = 0; i < 40; i++) {
        cfg.gains_q12[0] = (uint16_t)(3000 + i);
        save(&cfg);
        int s = omni_store_find_latest(sector, &got, &seq);
        CHECK(s == i % OMNI_STORE_SLOTS, "save %d landed in slot %d", i, s);
        CHECK(seq == (uint32_t)i + 1, "seq %u", (unsigned)seq);
        CHECK(got.gains_q12[0] == 3000 + i, "value after save %d", i);
    }
    CHECK(erases == 2, "erased %d times for 40 saves", erases);

    // Torn write: a half-programmed record must be ignored and skipped.
    int latest = omni_store_find_latest(sector, &got, &seq);
    uint8_t rec[OMNI_STORE_SLOT_SIZE];
    cfg.gains_q12[0] = 9999;
    omni_store_build_record(&cfg, seq + 1, rec);
    memset(rec + 40, 0xFF, OMNI_STORE_SLOT_SIZE - 40);  // power lost mid-page
    flash_program(latest + 1, rec);
    CHECK(omni_store_find_latest(sector, &got, &seq) == latest && got.gains_q12[0] != 9999, "torn record ignored");
    CHECK(omni_store_next_slot(sector, latest) == latest + 2, "torn slot not reused");

    // Corrupted CRC.
    flash_erase();
    omni_config_default(&cfg);
    save(&cfg);
    sector[20] ^= 0x01;
    CHECK(omni_store_find_latest(sector, &got, &seq) == -1, "bad crc rejected");

    if (failures) {
        printf("%d check(s) failed\n", failures);
        return 1;
    }
    printf("all config store tests passed\n");
    return 0;
}
