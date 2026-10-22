// config_store.c - see config_store.h.
#include "config_store.h"

#include <string.h>

#define REC_CONFIG_OFS 8
#define REC_CRC_OFS    72

uint32_t omni_crc32(const uint8_t *data, size_t len) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int b = 0; b < 8; b++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}

static uint32_t rd32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void wr32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

int omni_store_find_latest(const uint8_t *sector, omni_config_t *cfg, uint32_t *seq) {
    int best = -1;
    uint32_t best_seq = 0;
    for (int s = 0; s < OMNI_STORE_SLOTS; s++) {
        const uint8_t *r = sector + s * OMNI_STORE_SLOT_SIZE;
        if (rd32(r) != OMNI_STORE_MAGIC) continue;
        if (rd32(r + REC_CRC_OFS) != omni_crc32(r, REC_CRC_OFS)) continue;
        uint32_t q = rd32(r + 4);
        if (best >= 0 && q <= best_seq) continue;
        omni_config_t c;
        if (!omni_config_unpack(r + REC_CONFIG_OFS, &c)) continue;
        best = s;
        best_seq = q;
        *cfg = c;
    }
    if (best >= 0) *seq = best_seq;
    return best;
}

int omni_store_next_slot(const uint8_t *sector, int latest) {
    for (int s = latest + 1; s < OMNI_STORE_SLOTS; s++) {
        const uint8_t *r = sector + s * OMNI_STORE_SLOT_SIZE;
        int k = 0;
        while (k < OMNI_STORE_SLOT_SIZE && r[k] == 0xFF) k++;
        if (k == OMNI_STORE_SLOT_SIZE) return s;
    }
    return -1;
}

void omni_store_build_record(const omni_config_t *cfg, uint32_t seq, uint8_t out[OMNI_STORE_SLOT_SIZE]) {
    memset(out, 0xFF, OMNI_STORE_SLOT_SIZE);
    wr32(out, OMNI_STORE_MAGIC);
    wr32(out + 4, seq);
    omni_config_pack(cfg, out + REC_CONFIG_OFS);
    out[REC_CONFIG_OFS + OMNI_CONFIG_SIZE] = 0;
    wr32(out + REC_CRC_OFS, omni_crc32(out, REC_CRC_OFS));
}
