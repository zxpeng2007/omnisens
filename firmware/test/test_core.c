// Host unit tests for omni_core.c. Build and run: make -C firmware/test
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/omni_core.h"

typedef struct { int dx, dy; unsigned t; int ox, oy; } vec_step_t;
typedef struct {
    const char *name;
    const uint16_t *gains;
    int n, linear, smoothing, rot;
    const float (*curve)[2];
    size_t n_curve;
    const vec_step_t *steps;
    size_t n_steps;
} vec_profile_t;

#include "vectors.inc"

static int failures;
#define CHECK(cond, ...)                                    \
    do {                                                    \
        if (!(cond)) {                                      \
            failures++;                                     \
            printf("FAIL %s:%d: ", __FILE__, __LINE__);     \
            printf(__VA_ARGS__);                            \
            printf("\n");                                   \
        }                                                   \
    } while (0)

static void make_config(omni_config_t *cfg, const vec_profile_t *p) {
    omni_config_default(cfg);
    cfg->flags = OMNI_FLAG_ENABLED | (p->linear ? OMNI_FLAG_LINEAR : 0);
    cfg->n_points = (uint8_t)p->n;
    cfg->smoothing_counts = (uint16_t)p->smoothing;
    cfg->reset_ms = 40;
    cfg->rotation_cdeg = (int16_t)p->rot;
    for (int i = 0; i < p->n; i++) cfg->gains_q12[i] = p->gains[i];
}

static void test_vectors(void) {
    for (int pi = 0; pi < VEC_PROFILE_COUNT; pi++) {
        const vec_profile_t *p = &vec_profiles[pi];
        omni_config_t cfg;
        omni_engine_t e;
        make_config(&cfg, p);
        omni_engine_init(&e, &cfg);

        for (size_t i = 0; i < p->n_curve; i++) {
            float g = omni_engine_gain_at(&e, p->curve[i][0]);
            CHECK(fabsf(g - p->curve[i][1]) < 2e-5f, "%s curve @%.1f: got %.7f want %.7f", p->name,
                  p->curve[i][0], g, p->curve[i][1]);
        }

        // float (C) vs double (JS) may round a rare half-count differently; the
        // running totals must still agree to within one count.
        long sum_c[2] = {0, 0}, sum_js[2] = {0, 0};
        int mismatches = 0;
        for (size_t i = 0; i < p->n_steps; i++) {
            const vec_step_t *s = &p->steps[i];
            int32_t ox, oy;
            omni_engine_process(&e, s->dx, s->dy, s->t, &ox, &oy);
            if (ox != s->ox || oy != s->oy) mismatches++;
            sum_c[0] += ox; sum_c[1] += oy;
            sum_js[0] += s->ox; sum_js[1] += s->oy;
            CHECK(labs(sum_c[0] - sum_js[0]) <= 1 && labs(sum_c[1] - sum_js[1]) <= 1,
                  "%s step %zu: totals drifted C=(%ld,%ld) JS=(%ld,%ld)", p->name, i, sum_c[0], sum_c[1],
                  sum_js[0], sum_js[1]);
        }
        CHECK(mismatches * 50 <= (int)p->n_steps, "%s: %d/%zu steps differ from JS", p->name, mismatches,
              p->n_steps);
    }
}

static void test_pack_roundtrip(void) {
    omni_config_t a, b;
    omni_config_default(&a);
    a.flags = OMNI_FLAG_ENABLED | OMNI_FLAG_LINEAR;
    a.n_points = 12;
    a.smoothing_counts = 77;
    a.reset_ms = 123;
    a.rotation_cdeg = -321;
    a.calib_dpi = 1600;
    for (int i = 0; i < 12; i++) a.gains_q12[i] = (uint16_t)(3500 + 100 * i);
    strcpy(a.label, "my profile");
    CHECK(omni_config_sanitize(&a), "valid config was modified by sanitize");

    uint8_t buf[OMNI_CONFIG_SIZE];
    omni_config_pack(&a, buf);
    CHECK(buf[0] == 1 && buf[2] == 12, "header bytes");
    CHECK(buf[8] == (uint8_t)(-321 & 0xff) && buf[9] == (uint8_t)((-321 >> 8) & 0xff), "rotation LE");
    CHECK(buf[12] == (3500 & 0xff) && buf[13] == (3500 >> 8), "gain LE");
    CHECK(memcmp(buf + 44, "my profile", 10) == 0, "label");
    CHECK(omni_config_unpack(buf, &b), "unpack failed");
    CHECK(memcmp(&a, &b, sizeof(a)) == 0, "roundtrip mismatch");

    buf[0] = 99;
    CHECK(!omni_config_unpack(buf, &b), "unknown version accepted");
}

static void test_sanitize(void) {
    omni_config_t c;
    omni_config_default(&c);
    c.n_points = 40;
    c.flags = 0xff;
    c.reset_ms = 0;
    c.rotation_cdeg = 9000;
    c.gains_q12[0] = 1;
    c.gains_q12[1] = 65535;
    c.label[0] = 'a';
    c.label[1] = '\t';
    c.label[2] = 0;
    c.label[3] = 'z';
    CHECK(!omni_config_sanitize(&c), "invalid config reported as valid");
    CHECK(c.n_points == OMNI_MAX_POINTS, "n_points clamp");
    CHECK(c.flags == OMNI_FLAGS_KNOWN, "flags mask");
    CHECK(c.reset_ms == 40, "reset default");
    CHECK(c.rotation_cdeg == OMNI_ROTATION_LIMIT, "rotation clamp");
    CHECK(c.gains_q12[0] == OMNI_GAIN_MIN && c.gains_q12[1] == OMNI_GAIN_MAX, "gain clamp");
    CHECK(c.label[1] == '?' && c.label[3] == 0, "label cleanup");

    omni_config_default(&c);
    c.n_points = 4;
    c.gains_q12[6] = 1234;
    omni_config_sanitize(&c);
    CHECK(c.gains_q12[6] == OMNI_GAIN_ONE, "unused slot canonicalised");
}

static void test_behaviour(void) {
    omni_config_t cfg;
    omni_engine_t e;
    int32_t ox, oy;

    // Disabled: exact passthrough regardless of gains.
    omni_config_default(&cfg);
    cfg.flags = 0;
    cfg.gains_q12[0] = 8192;
    omni_engine_init(&e, &cfg);
    omni_engine_process(&e, 37, -5, 1000, &ox, &oy);
    CHECK(ox == 37 && oy == -5, "disabled passthrough");

    // Flat 1.0 table is lossless.
    omni_config_default(&cfg);
    omni_engine_init(&e, &cfg);
    for (int i = 0; i < 1000; i++) {
        int dx = (i * 7) % 13 - 6, dy = (i * 5) % 11 - 5;
        omni_engine_process(&e, dx, dy, 1000u * (uint32_t)i, &ox, &oy);
        CHECK(ox == dx && oy == dy, "flat table changed (%d,%d) -> (%d,%d)", dx, dy, ox, oy);
    }

    // 1.5x to the right, 0.5x to the left: totals follow the gain exactly
    // (within one count) even with 1-count reports.
    omni_config_default(&cfg);
    cfg.n_points = 2;
    cfg.flags = OMNI_FLAG_ENABLED | OMNI_FLAG_LINEAR;
    cfg.gains_q12[0] = 6144;  // 0 deg (right)
    cfg.gains_q12[1] = 2048;  // 180 deg (left)
    omni_engine_init(&e, &cfg);
    long sum = 0;
    for (int i = 0; i < 1000; i++) {
        omni_engine_process(&e, 1, 0, 1000u * (uint32_t)i, &ox, &oy);
        sum += ox;
    }
    CHECK(labs(sum - 1500) <= 1, "right total %ld", sum);
    sum = 0;
    for (int i = 0; i < 1000; i++) {
        omni_engine_process(&e, -1, 0, 2000000u + 1000u * (uint32_t)i, &ox, &oy);
        sum += ox;
    }
    CHECK(labs(sum + 500) <= 1, "left total %ld", sum);

    // Smoothing: a 1-count diagonal staircase (1,0),(0,-1),... moving up-right
    // should be treated as 45 deg, not alternate between 0 and 90 deg.
    omni_config_default(&cfg);
    cfg.n_points = 8;
    cfg.flags = OMNI_FLAG_ENABLED | OMNI_FLAG_LINEAR;
    for (int i = 0; i < 8; i++) cfg.gains_q12[i] = OMNI_GAIN_ONE;
    cfg.gains_q12[1] = 8192;  // only 45 deg is boosted 2x
    omni_engine_init(&e, &cfg);
    for (int i = 0; i < 200; i++) {
        omni_engine_process(&e, i & 1 ? 0 : 1, i & 1 ? -1 : 0, 1000u * (uint32_t)i, &ox, &oy);
    }
    CHECK(fabsf(e.last_angle_deg - 45.0f) < 3.0f, "staircase angle %.2f", e.last_angle_deg);
    CHECK(e.last_gain > 1.9f, "staircase gain %.3f", e.last_gain);

    // Idle longer than reset_ms forgets the old direction immediately.
    omni_engine_process(&e, -20, 0, 1000u * 200 + 100000u, &ox, &oy);
    CHECK(fabsf(e.last_angle_deg - 180.0f) < 0.01f, "reset angle %.2f", e.last_angle_deg);

    // Rotation: +90 deg turns "right" into "up" (negative HID y).
    omni_config_default(&cfg);
    cfg.rotation_cdeg = 4500;
    omni_engine_init(&e, &cfg);
    omni_engine_process(&e, 100, 0, 1000, &ox, &oy);
    CHECK(ox == 71 && oy == -71, "rotation 45: (%d,%d)", ox, oy);

    // Cubic interpolation never leaves the configured range.
    omni_config_default(&cfg);
    cfg.n_points = 8;
    uint16_t spiky[8] = {4096, 4096, 8000, 4096, 4096, 2000, 4096, 4096};
    memcpy(cfg.gains_q12, spiky, sizeof(spiky));
    omni_engine_init(&e, &cfg);
    for (float a = 0; a < 360; a += 0.5f) {
        float g = omni_engine_gain_at(&e, a);
        CHECK(g >= 2000.0f / 4096 - 1e-6f && g <= 8000.0f / 4096 + 1e-6f, "cubic overshoot %.4f @%.1f", g, a);
    }
    CHECK(fabsf(omni_engine_gain_at(&e, 90.0f) - 8000.0f / 4096) < 1e-5f, "knot value exact");
}

int main(void) {
    test_pack_roundtrip();
    test_sanitize();
    test_behaviour();
    test_vectors();
    if (failures) {
        printf("%d check(s) failed\n", failures);
        return 1;
    }
    printf("all core tests passed\n");
    return 0;
}
