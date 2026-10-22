// omni_core.c - see omni_core.h and docs/ALGORITHM.md.
#include "omni_core.h"

#include <math.h>
#include <string.h>

// Optional baked-in factory profile, exported by the web tool ("C header").
// Host tests define OMNI_NO_PROFILE_DEFAULT so they always see the flat one.
#if defined(__has_include) && !defined(OMNI_NO_PROFILE_DEFAULT)
#if __has_include("profile_default.h")
#include "profile_default.h"
#endif
#endif

#define OMNI_PI_F          3.14159265358979f
#define OMNI_MAX_SMOOTH    4096
#define OMNI_MAX_RESET     2000 // ms
#define OMNI_FALLBACK_RESET 40  // ms, used when reset_ms is 0

#ifndef OMNI_DEFAULT_FLAGS
#define OMNI_DEFAULT_FLAGS (OMNI_FLAG_ENABLED | OMNI_FLAG_CHORD_TOGGLE)
#endif
#ifndef OMNI_DEFAULT_N_POINTS
#define OMNI_DEFAULT_N_POINTS 8
#endif
#ifndef OMNI_DEFAULT_SMOOTHING
#define OMNI_DEFAULT_SMOOTHING 32  // counts
#endif
#ifndef OMNI_DEFAULT_RESET_MS
#define OMNI_DEFAULT_RESET_MS 40
#endif
#ifndef OMNI_DEFAULT_ROTATION_CDEG
#define OMNI_DEFAULT_ROTATION_CDEG 0
#endif
#ifndef OMNI_DEFAULT_CALIB_DPI
#define OMNI_DEFAULT_CALIB_DPI 0
#endif
#ifndef OMNI_DEFAULT_LABEL
#define OMNI_DEFAULT_LABEL ""
#endif

void omni_config_default(omni_config_t *cfg) {
    memset(cfg, 0, sizeof(*cfg));
    cfg->version = OMNI_CONFIG_VERSION;
    cfg->flags = OMNI_DEFAULT_FLAGS;
    cfg->n_points = OMNI_DEFAULT_N_POINTS;
    cfg->smoothing_counts = OMNI_DEFAULT_SMOOTHING;
    cfg->reset_ms = OMNI_DEFAULT_RESET_MS;
    cfg->rotation_cdeg = OMNI_DEFAULT_ROTATION_CDEG;
    cfg->calib_dpi = OMNI_DEFAULT_CALIB_DPI;
    for (int i = 0; i < OMNI_MAX_POINTS; i++) cfg->gains_q12[i] = OMNI_GAIN_ONE;
#ifdef OMNI_DEFAULT_GAINS_Q12
    static const uint16_t gains[] = OMNI_DEFAULT_GAINS_Q12;
    for (unsigned i = 0; i < sizeof(gains) / sizeof(gains[0]) && i < OMNI_MAX_POINTS; i++) cfg->gains_q12[i] = gains[i];
#endif
    strncpy(cfg->label, OMNI_DEFAULT_LABEL, OMNI_LABEL_LEN);
    omni_config_sanitize(cfg);
}

bool omni_config_sanitize(omni_config_t *cfg) {
    omni_config_t before = *cfg;

    cfg->version = OMNI_CONFIG_VERSION;
    cfg->flags &= OMNI_FLAGS_KNOWN;
    if (cfg->n_points < 1) cfg->n_points = 1;
    if (cfg->n_points > OMNI_MAX_POINTS) cfg->n_points = OMNI_MAX_POINTS;
    if (cfg->smoothing_counts > OMNI_MAX_SMOOTH) cfg->smoothing_counts = OMNI_MAX_SMOOTH;
    if (cfg->reset_ms == 0) cfg->reset_ms = OMNI_FALLBACK_RESET;
    if (cfg->reset_ms > OMNI_MAX_RESET) cfg->reset_ms = OMNI_MAX_RESET;
    if (cfg->rotation_cdeg > OMNI_ROTATION_LIMIT) cfg->rotation_cdeg = OMNI_ROTATION_LIMIT;
    if (cfg->rotation_cdeg < -OMNI_ROTATION_LIMIT) cfg->rotation_cdeg = -OMNI_ROTATION_LIMIT;
    for (int i = 0; i < OMNI_MAX_POINTS; i++) {
        uint16_t *g = &cfg->gains_q12[i];
        if (i >= cfg->n_points) *g = OMNI_GAIN_ONE;  // unused slots are canonical
        else if (*g < OMNI_GAIN_MIN) *g = OMNI_GAIN_MIN;
        else if (*g > OMNI_GAIN_MAX) *g = OMNI_GAIN_MAX;
    }
    // Printable ASCII only; everything after the first NUL is zeroed.
    bool ended = false;
    for (int i = 0; i < OMNI_LABEL_LEN; i++) {
        char c = cfg->label[i];
        if (ended || c == 0) { ended = true; cfg->label[i] = 0; continue; }
        if (c < 0x20 || c > 0x7e) cfg->label[i] = '?';
    }
    return memcmp(&before, cfg, sizeof(before)) == 0;
}

static void put_u16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static uint16_t get_u16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }

void omni_config_pack(const omni_config_t *cfg, uint8_t out[OMNI_CONFIG_SIZE]) {
    memset(out, 0, OMNI_CONFIG_SIZE);
    out[0] = cfg->version;
    out[1] = cfg->flags;
    out[2] = cfg->n_points;
    put_u16(out + 4, cfg->smoothing_counts);
    put_u16(out + 6, cfg->reset_ms);
    put_u16(out + 8, (uint16_t)cfg->rotation_cdeg);
    put_u16(out + 10, cfg->calib_dpi);
    for (int i = 0; i < OMNI_MAX_POINTS; i++) put_u16(out + 12 + 2 * i, cfg->gains_q12[i]);
    memcpy(out + 44, cfg->label, OMNI_LABEL_LEN);
}

bool omni_config_unpack(const uint8_t in[OMNI_CONFIG_SIZE], omni_config_t *cfg) {
    if (in[0] != OMNI_CONFIG_VERSION) return false;
    omni_config_t c;
    memset(&c, 0, sizeof(c));
    c.version = in[0];
    c.flags = in[1];
    c.n_points = in[2];
    c.smoothing_counts = get_u16(in + 4);
    c.reset_ms = get_u16(in + 6);
    c.rotation_cdeg = (int16_t)get_u16(in + 8);
    c.calib_dpi = get_u16(in + 10);
    for (int i = 0; i < OMNI_MAX_POINTS; i++) c.gains_q12[i] = get_u16(in + 12 + 2 * i);
    memcpy(c.label, in + 44, OMNI_LABEL_LEN);
    *cfg = c;
    return true;
}

void omni_engine_reset(omni_engine_t *e) {
    e->sx = e->sy = 0.0f;
    e->rem_x = e->rem_y = 0.0f;
    e->active = false;
}

void omni_engine_init(omni_engine_t *e, const omni_config_t *cfg_in) {
    omni_config_t cfg = *cfg_in;
    omni_config_sanitize(&cfg);

    memset(e, 0, sizeof(*e));
    e->n = cfg.n_points;
    e->enabled = (cfg.flags & OMNI_FLAG_ENABLED) != 0;
    e->linear = (cfg.flags & OMNI_FLAG_LINEAR) != 0;
    e->smoothing = (float)cfg.smoothing_counts;
    e->reset_us = (uint32_t)cfg.reset_ms * 1000u;
    e->gain_lo = 1e9f;
    e->gain_hi = 0.0f;
    for (int i = 0; i < e->n; i++) {
        float g = (float)cfg.gains_q12[i] / (float)OMNI_GAIN_ONE;
        e->gains[i] = g;
        if (g < e->gain_lo) e->gain_lo = g;
        if (g > e->gain_hi) e->gain_hi = g;
    }
    e->rotate = cfg.rotation_cdeg != 0;
    float rad = (float)cfg.rotation_cdeg * (OMNI_PI_F / 18000.0f);
    e->rot_c = cosf(rad);
    e->rot_s = sinf(rad);
    e->last_gain = 1.0f;
    omni_engine_reset(e);
}

float omni_engine_gain_at(const omni_engine_t *e, float angle_deg) {
    const int n = e->n;
    if (n <= 1) return e->gains[0];

    // Position in table index space, wrapped to [0, n).
    float u = angle_deg * (float)n / 360.0f;
    u = fmodf(u, (float)n);
    if (u < 0.0f) u += (float)n;
    int k = (int)u;
    if (k >= n) k = n - 1;  // guards u == n after float rounding
    float t = u - (float)k;

    float p1 = e->gains[k];
    float p2 = e->gains[(k + 1) % n];
    if (e->linear) return p1 + (p2 - p1) * t;

    // Periodic Catmull-Rom spline, clamped to the table's own range so it
    // never produces a gain more extreme than the user configured.
    float p0 = e->gains[(k + n - 1) % n];
    float p3 = e->gains[(k + 2) % n];
    float g = p1 + 0.5f * t * (p2 - p0 + t * (2.0f * p0 - 5.0f * p1 + 4.0f * p2 - p3 +
                                              t * (3.0f * (p1 - p2) + p3 - p0)));
    if (g < e->gain_lo) g = e->gain_lo;
    if (g > e->gain_hi) g = e->gain_hi;
    return g;
}

// Round half away from zero; the web mirror uses the same rule.
static int32_t round_away(float v) {
    if (v > 2.0e9f) v = 2.0e9f;
    if (v < -2.0e9f) v = -2.0e9f;
    return v >= 0.0f ? (int32_t)(v + 0.5f) : -(int32_t)(-v + 0.5f);
}

void omni_engine_process(omni_engine_t *e, int32_t dx, int32_t dy, uint32_t now_us,
                         int32_t *out_x, int32_t *out_y) {
    if (!e->enabled) {
        *out_x = dx;
        *out_y = dy;
        return;
    }
    if (dx == 0 && dy == 0) {
        *out_x = 0;
        *out_y = 0;
        return;
    }

    // A pause longer than reset_us starts a new stroke.
    if (!e->active || (uint32_t)(now_us - e->last_motion_us) > e->reset_us) omni_engine_reset(e);
    e->active = true;
    e->last_motion_us = now_us;

    const float fx = (float)dx, fy = (float)dy;

    // Direction estimate: exponential window over the last ~L counts of travel,
    // so per-report quantization (1-2 count deltas at high polling rates) does
    // not make the gain jump between neighbouring directions.
    if (e->smoothing > 0.0f) {
        float m = sqrtf(fx * fx + fy * fy);
        float keep = e->smoothing / (e->smoothing + m);
        e->sx = e->sx * keep + fx;
        e->sy = e->sy * keep + fy;
    } else {
        e->sx = fx;
        e->sy = fy;
    }

    float ang = atan2f(-e->sy, e->sx) * (180.0f / OMNI_PI_F);
    if (ang < 0.0f) ang += 360.0f;
    float g = omni_engine_gain_at(e, ang);
    e->last_angle_deg = ang;
    e->last_gain = g;

    // Scalar gain: changes how far the cursor moves, never which way.
    float vx = fx * g, vy = fy * g;
    if (e->rotate) {
        // CCW in screen-up coordinates, expressed in y-down HID axes.
        float rx = vx * e->rot_c + vy * e->rot_s;
        float ry = -vx * e->rot_s + vy * e->rot_c;
        vx = rx;
        vy = ry;
    }

    vx += e->rem_x;
    vy += e->rem_y;
    int32_t ix = round_away(vx), iy = round_away(vy);
    e->rem_x = vx - (float)ix;
    e->rem_y = vy - (float)iy;
    *out_x = ix;
    *out_y = iy;
}
