// Host unit tests for config_store.c (a simulated pair of flash sectors).
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

// Record layout, docs/PROTOCOL.md ("Flash storage").
#define REC_CONFIG_OFS 8
#define REC_CRC_OFS    72

static uint8_t flash[OMNI_STORE_SECTORS][OMNI_STORE_SECTOR_SIZE];
static const uint8_t *const sectors[OMNI_STORE_SECTORS] = {flash[0], flash[1]};
static int erases;

static void flash_erase(int k) {
    memset(flash[k], 0xFF, OMNI_STORE_SECTOR_SIZE);
    erases++;
}

// NOR flash programming can only clear bits.
static void flash_program(int k, int slot, const uint8_t *rec) {
    uint8_t *p = flash[k] + slot * OMNI_STORE_SLOT_SIZE;
    for (int i = 0; i < OMNI_STORE_SLOT_SIZE; i++) p[i] &= rec[i];
}

static void wipe(void) {
    flash_erase(0);
    flash_erase(1);
    erases = 0;
}

static uint32_t rng = 12345;
static uint8_t rnd(void) {
    rng = rng * 1103515245u + 12345u;
    return (uint8_t)(rng >> 16);
}

// Where save() loses power: before the erase changed anything, half-way
// through the erase (erased bytes read 0xFF, the rest is old data with stray
// ones), or half-way through the page program.
enum { CUT_NONE, CUT_ERASE_START, CUT_ERASE_MID, CUT_PROGRAM };

// Mirrors storage_save().
static omni_store_plan_t save(const omni_config_t *cfg, int cut) {
    omni_store_plan_t p;
    omni_store_plan_save(sectors, &p);
    uint8_t rec[OMNI_STORE_SLOT_SIZE];
    omni_store_build_record(cfg, p.seq, rec);
    if (p.erase) {
        if (cut == CUT_ERASE_START) return p;
        if (cut == CUT_ERASE_MID) {
            uint8_t *s = flash[p.sector];
            memset(s, 0xFF, OMNI_STORE_SECTOR_SIZE / 3);
            for (int i = OMNI_STORE_SECTOR_SIZE / 3; i < OMNI_STORE_SECTOR_SIZE; i++) s[i] |= rnd() & rnd();
            return p;
        }
        flash_erase(p.sector);
    }
    if (cut == CUT_PROGRAM) memset(rec + 40, 0xFF, OMNI_STORE_SLOT_SIZE - 40);
    flash_program(p.sector, p.slot, rec);
    return p;
}

static void save_gain(omni_config_t *cfg, int gain) {
    cfg->gains_q12[0] = (uint16_t)gain;
    save(cfg, CUT_NONE);
}

// gains_q12[0] of the record that boot would load (0 if none), and its seq.
static int loaded_gain(uint32_t *seq) {
    omni_config_t got;
    *seq = 0;
    if (!omni_store_load(sectors, &got, seq)) return 0;
    return got.gains_q12[0];
}

// Programs a valid record whose packed config says `version`.
static void program_version(int k, int slot, uint32_t seq, uint8_t version, int gain) {
    omni_config_t cfg;
    omni_config_default(&cfg);
    cfg.gains_q12[0] = (uint16_t)gain;
    uint8_t rec[OMNI_STORE_SLOT_SIZE];
    omni_store_build_record(&cfg, seq, rec);
    rec[REC_CONFIG_OFS] = version;
    uint32_t crc = omni_crc32(rec, REC_CRC_OFS);
    for (int b = 0; b < 4; b++) rec[REC_CRC_OFS + b] = (uint8_t)(crc >> (8 * b));
    flash_program(k, slot, rec);
}

static void test_sequence(void) {
    omni_config_t cfg;
    uint32_t seq;
    wipe();
    CHECK(loaded_gain(&seq) == 0, "empty pair has no record");

    omni_config_default(&cfg);
    for (int i = 0; i < 40; i++) {
        cfg.gains_q12[0] = (uint16_t)(3000 + i);
        omni_store_plan_t p = save(&cfg, CUT_NONE);
        CHECK(p.sector == (i / OMNI_STORE_SLOTS) % 2 && p.slot == i % OMNI_STORE_SLOTS,
              "save %d went to sector %d slot %d", i, p.sector, p.slot);
        CHECK(p.erase == (i % OMNI_STORE_SLOTS == 0), "save %d erase %d", i, (int)p.erase);
        CHECK(loaded_gain(&seq) == 3000 + i && seq == (uint32_t)i + 1, "save %d loads back (seq %u)", i,
              (unsigned)seq);
        if (i >= OMNI_STORE_SLOTS && i % OMNI_STORE_SLOTS == 0) {
            omni_config_t old;
            uint32_t q = 0;
            int s = omni_store_find_latest(flash[1 - p.sector], &old, &q);
            CHECK(s == OMNI_STORE_SLOTS - 1 && q == (uint32_t)i, "full sector kept after switch %d", i);
        }
    }
    CHECK(erases == 3, "erased %d times for 40 saves", erases);
}

// Power lost while switching sectors: the previous record must survive, and
// the next save must redo the switch with a full erase.
static void test_power_loss_at_switch(void) {
    static const int cuts[] = {CUT_ERASE_START, CUT_ERASE_MID, CUT_PROGRAM};
    for (int c = 0; c < 3; c++) {
        // 16: into the unused sector 1; 32: back into sector 0, which still
        // holds older records.
        for (int before = OMNI_STORE_SLOTS; before <= 2 * OMNI_STORE_SLOTS; before += OMNI_STORE_SLOTS) {
            omni_config_t cfg;
            uint32_t seq;
            wipe();
            omni_config_default(&cfg);
            for (int i = 0; i < before; i++) save_gain(&cfg, 3000 + i);

            cfg.gains_q12[0] = 9999;
            omni_store_plan_t p = save(&cfg, cuts[c]);
            CHECK(p.erase && p.slot == 0, "cut %d after %d: save switches sectors", c, before);
            CHECK(loaded_gain(&seq) == 3000 + before - 1 && seq == (uint32_t)before,
                  "cut %d after %d: previous record kept (seq %u)", c, before, (unsigned)seq);

            int erased = erases;
            cfg.gains_q12[0] = 4444;
            omni_store_plan_t q = save(&cfg, CUT_NONE);
            CHECK(q.sector == p.sector && q.slot == 0 && q.erase && erases == erased + 1,
                  "cut %d after %d: retry erases sector %d again", c, before, q.sector);
            CHECK(loaded_gain(&seq) == 4444 && seq == (uint32_t)before + 1, "cut %d after %d: retry loads (seq %u)",
                  c, before, (unsigned)seq);
        }
    }
}

static void test_torn_and_corrupt(void) {
    omni_config_t cfg;
    uint32_t seq;
    wipe();
    omni_config_default(&cfg);
    for (int i = 0; i < 5; i++) save_gain(&cfg, 3000 + i);

    // Torn write inside the active sector: ignored, and its slot is skipped.
    cfg.gains_q12[0] = 9999;
    omni_store_plan_t p = save(&cfg, CUT_PROGRAM);
    CHECK(!p.erase && p.sector == 0 && p.slot == 5, "torn: plan");
    CHECK(loaded_gain(&seq) == 3004 && seq == 5, "torn record ignored");
    CHECK(omni_store_next_slot(flash[0], 4) == 6, "torn slot not reused");
    cfg.gains_q12[0] = 4444;
    p = save(&cfg, CUT_NONE);
    CHECK(p.sector == 0 && p.slot == 6 && p.seq == 6, "after torn: slot %d seq %u", p.slot, (unsigned)p.seq);
    CHECK(loaded_gain(&seq) == 4444, "after torn: loads");

    // Corrupted CRC.
    wipe();
    save(&cfg, CUT_NONE);
    flash[0][20] ^= 0x01;
    CHECK(loaded_gain(&seq) == 0, "bad crc rejected");
}

// Records this firmware cannot load (another config version) still count
// for numbering, so a save after a downgrade outranks them.
static void test_other_versions(void) {
    omni_config_t cfg, got;
    uint32_t seq;
    wipe();
    omni_config_default(&cfg);
    for (int i = 0; i < 3; i++) save_gain(&cfg, 3000 + i);  // seq 1-3, slots 0-2
    program_version(0, 3, 10, 2, 7777);                      // newer firmware saved up to seq 10

    CHECK(loaded_gain(&seq) == 3002 && seq == 3, "version 2 record not loaded");
    CHECK(omni_store_find_newest(flash[0], &seq) == 3 && seq == 10, "version 2 record is the newest");
    cfg.gains_q12[0] = 4444;
    omni_store_plan_t p = save(&cfg, CUT_NONE);
    CHECK(p.sector == 0 && p.slot == 4 && p.seq == 11 && !p.erase, "after v2: slot %d seq %u", p.slot,
          (unsigned)p.seq);
    CHECK(loaded_gain(&seq) == 4444 && seq == 11, "after v2: loads");
    CHECK(omni_store_find_newest(flash[0], &seq) == 4 && seq == 11, "a newer firmware would pick the new save");

    // Same across sectors: the newest record of any version picks the sector.
    wipe();
    for (int i = 0; i < OMNI_STORE_SLOTS; i++) save_gain(&cfg, 3000 + i);
    program_version(1, 0, 20, 2, 7777);
    p = save(&cfg, CUT_NONE);
    CHECK(p.sector == 1 && p.slot == 1 && p.seq == 21 && !p.erase, "v2 in sector 1: sector %d slot %d seq %u",
          p.sector, p.slot, (unsigned)p.seq);
    CHECK(omni_store_find_latest(flash[0], &got, &seq) == OMNI_STORE_SLOTS - 1, "v2 in sector 1: sector 0 kept");

    // Equal sequence numbers: the later slot wins.
    wipe();
    uint8_t rec[OMNI_STORE_SLOT_SIZE];
    cfg.gains_q12[0] = 1111;
    omni_store_build_record(&cfg, 5, rec);
    flash_program(0, 0, rec);
    cfg.gains_q12[0] = 2222;
    omni_store_build_record(&cfg, 5, rec);
    flash_program(0, 1, rec);
    CHECK(omni_store_find_latest(flash[0], &got, &seq) == 1 && got.gains_q12[0] == 2222, "tie: later slot loads");
    CHECK(omni_store_find_newest(flash[0], &seq) == 1, "tie: later slot is the newest");
    CHECK(save(&cfg, CUT_NONE).slot == 2, "tie: next save after the later slot");
}

// Single-sector builds kept the log in what is now the upper sector.
static void test_upper_sector_only(void) {
    omni_config_t cfg;
    uint32_t seq;
    wipe();
    omni_config_default(&cfg);
    uint8_t rec[OMNI_STORE_SLOT_SIZE];
    for (int i = 0; i < 3; i++) {
        cfg.gains_q12[0] = (uint16_t)(5000 + i);
        omni_store_build_record(&cfg, (uint32_t)i + 1, rec);
        flash_program(1, i, rec);
    }
    CHECK(loaded_gain(&seq) == 5002 && seq == 3, "upper sector loads");
    for (int i = 3; i <= OMNI_STORE_SLOTS; i++) {
        cfg.gains_q12[0] = (uint16_t)(6000 + i);
        omni_store_plan_t p = save(&cfg, CUT_NONE);
        int want_sector = i < OMNI_STORE_SLOTS ? 1 : 0, want_slot = i < OMNI_STORE_SLOTS ? i : 0;
        CHECK(p.sector == want_sector && p.slot == want_slot, "upper: save %d to sector %d slot %d", i, p.sector,
              p.slot);
    }
    CHECK(loaded_gain(&seq) == 6000 + OMNI_STORE_SLOTS && seq == OMNI_STORE_SLOTS + 1, "upper: switched to sector 0");
}

int main(void) {
    CHECK(omni_crc32((const uint8_t *)"123456789", 9) == 0xCBF43926u, "crc32 check value");
    test_sequence();
    test_power_loss_at_switch();
    test_torn_and_corrupt();
    test_other_versions();
    test_upper_sector_only();
    if (failures) {
        printf("%d check(s) failed\n", failures);
        return 1;
    }
    printf("all config store tests passed\n");
    return 0;
}
