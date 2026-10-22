// omni_core.h - platform-independent directional sensitivity engine.
//
// No SDK dependencies: this file and omni_core.c build on the RP2040/RP2350
// and on a desktop compiler (see firmware/test). The web tool mirrors the same
// math in web/js/omni-core.js; docs/ALGORITHM.md is the reference for both.
//
// Conventions (identical in firmware and web tool):
//   * Deltas use HID/browser axes: +x = right, +y = down (toward the user).
//   * Direction angle theta is in degrees, counter-clockwise, "screen up":
//     theta = atan2(-dy, dx), 0 = right, 90 = up/away, 180 = left, 270 = down.
//   * Gain point k sits at theta_k = k * 360 / n_points.
#ifndef OMNI_CORE_H
#define OMNI_CORE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define OMNI_CONFIG_VERSION 1
#define OMNI_CONFIG_SIZE    63      // packed size on the wire and in flash
#define OMNI_MAX_POINTS     16
#define OMNI_GAIN_ONE       4096    // gains are Q12 fixed point: 4096 == 1.0
#define OMNI_GAIN_MIN       410     // ~0.10x
#define OMNI_GAIN_MAX       32767   // ~8.0x
#define OMNI_ROTATION_LIMIT 4500    // +-45.00 degrees, in centidegrees
#define OMNI_LABEL_LEN      16

enum {
    OMNI_FLAG_ENABLED      = 1u << 0,  // apply correction (else exact passthrough)
    OMNI_FLAG_LINEAR       = 1u << 1,  // linear interpolation instead of cubic
    OMNI_FLAG_CHORD_TOGGLE = 1u << 2,  // hold L+R+M for 3 s to toggle ENABLED
};
#define OMNI_FLAGS_KNOWN (OMNI_FLAG_ENABLED | OMNI_FLAG_LINEAR | OMNI_FLAG_CHORD_TOGGLE)

typedef struct {
    uint8_t  version;           // OMNI_CONFIG_VERSION
    uint8_t  flags;             // OMNI_FLAG_*
    uint8_t  n_points;          // 1..OMNI_MAX_POINTS
    uint16_t smoothing_counts;  // direction smoothing length L in counts (0 = per report)
    uint16_t reset_ms;          // idle gap that starts a new stroke (clears history)
    int16_t  rotation_cdeg;     // extra output rotation, CCW, centidegrees
    uint16_t calib_dpi;         // informational: DPI the profile was calibrated at
    uint16_t gains_q12[OMNI_MAX_POINTS];
    char     label[OMNI_LABEL_LEN];  // NUL-padded ASCII, not necessarily terminated
} omni_config_t;

typedef struct {
    // derived from config
    float    gains[OMNI_MAX_POINTS];
    float    gain_lo, gain_hi;  // table extremes, cubic output is clamped to them
    int      n;
    bool     enabled;
    bool     linear;
    float    smoothing;
    uint32_t reset_us;
    bool     rotate;
    float    rot_c, rot_s;
    // runtime state
    float    sx, sy;            // smoothed direction vector (raw counts)
    float    rem_x, rem_y;      // sub-count remainders carried between reports
    uint32_t last_motion_us;
    bool     active;            // inside a stroke
    // diagnostics
    float    last_angle_deg;
    float    last_gain;
} omni_engine_t;

// Factory defaults: enabled, cubic, chord toggle on, 8 points at 1.0x
// (i.e. a transparent passthrough until a profile is loaded).
void omni_config_default(omni_config_t *cfg);

// Clamp every field into its legal range. Returns true if cfg was already valid.
bool omni_config_sanitize(omni_config_t *cfg);

// Little-endian wire/flash layout, exactly OMNI_CONFIG_SIZE bytes (docs/PROTOCOL.md).
void omni_config_pack(const omni_config_t *cfg, uint8_t out[OMNI_CONFIG_SIZE]);
// Returns false (and leaves cfg untouched) if the version byte is unknown.
bool omni_config_unpack(const uint8_t in[OMNI_CONFIG_SIZE], omni_config_t *cfg);

void omni_engine_init(omni_engine_t *e, const omni_config_t *cfg);
void omni_engine_reset(omni_engine_t *e);  // forget stroke history and remainders

// Gain at an angle in degrees (any value, wrapped internally).
float omni_engine_gain_at(const omni_engine_t *e, float angle_deg);

// Process one motion report. now_us is a free-running microsecond clock
// (wraparound is fine). Writes the corrected integer deltas.
void omni_engine_process(omni_engine_t *e, int32_t dx, int32_t dy, uint32_t now_us,
                         int32_t *out_x, int32_t *out_y);

#ifdef __cplusplus
}
#endif

#endif  // OMNI_CORE_H
