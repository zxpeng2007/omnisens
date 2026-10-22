package rawaccel

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"

	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
	"github.com/zxpeng2007/omnisens/desktop/internal/state"
)

// settings.json v1.7 keys omnisens reads or changes (verbatim from Raw
// Accel's wrapper.cpp; Raw Accel reads them by name).
const (
	keyOutputDPI = "Output DPI"
	keyYX        = "Y/X output DPI ratio (vertical sens multiplier)"
	keyLR        = "L/R output DPI ratio (left sens multiplier)"
	keyUD        = "U/D output DPI ratio (up sens multiplier)"
	keyRotation  = "Degrees of rotation"
)

// valueKeys are the five profile fields omnisens changes, in the order of
// state.ProfileRecord.
var valueKeys = [5]string{keyOutputDPI, keyYX, keyLR, keyUD, keyRotation}

var topKeys = []string{"version", "defaultDeviceConfig", "profiles", "devices"}

// profileKeys are required in every profile (Profile is
// ItemRequired = Always in wrapper.cpp).
var profileKeys = []string{
	"name",
	"Stretches domain for horizontal vs vertical inputs",
	"Stretches accel range for horizontal vs vertical inputs",
	"Whole or horizontal accel parameters",
	"Vertical accel parameters",
	"Input speed calculation parameters",
	keyOutputDPI, keyYX, keyLR, keyUD, keyRotation,
	"Degrees of angle snapping",
	"Input Speed Cap",
}

// templateProfile is a flat Raw Accel profile, the same as
// rawAccelSettings() in web/js/export.js produces for a flat omnisens profile.
const templateProfile = `{
      "name": "default",
      "Stretches domain for horizontal vs vertical inputs": { "x": 1, "y": 1 },
      "Stretches accel range for horizontal vs vertical inputs": { "x": 1, "y": 1 },
      "Whole or horizontal accel parameters": {
        "mode": "noaccel", "Gain / Velocity": true, "inputOffset": 0, "outputOffset": 0, "acceleration": 0.005,
        "decayRate": 0.1, "gamma": 1, "motivity": 1.5, "exponentClassic": 2, "scale": 1, "exponentPower": 0.05,
        "limit": 1.5, "syncSpeed": 5, "smooth": 0.5, "Cap / Jump": { "x": 15, "y": 1.5 }, "Cap mode": "output", "data": []
      },
      "Vertical accel parameters": {
        "mode": "noaccel", "Gain / Velocity": true, "inputOffset": 0, "outputOffset": 0, "acceleration": 0.005,
        "decayRate": 0.1, "gamma": 1, "motivity": 1.5, "exponentClassic": 2, "scale": 1, "exponentPower": 0.05,
        "limit": 1.5, "syncSpeed": 5, "smooth": 0.5, "Cap / Jump": { "x": 15, "y": 1.5 }, "Cap mode": "output", "data": []
      },
      "Input speed calculation parameters": {
        "Whole/combined accel (set false for 'by component' mode)": true,
        "lpNorm": 2,
        "Time in ms after which an input is weighted at half its original value.": 0,
        "Time in ms after which scale is weighted at half its original value.": 0,
        "Time in ms after which an output is weighted at half its original value.": 0
      },
      "Output DPI": 1000,
      "Y/X output DPI ratio (vertical sens multiplier)": 1,
      "L/R output DPI ratio (left sens multiplier)": 1,
      "U/D output DPI ratio (up sens multiplier)": 1,
      "Degrees of rotation": 0,
      "Degrees of angle snapping": 0,
      "Input Speed Cap": 0
    }`

const templateSettings = `{
  "### Accel modes ###": "classic | jump | natural | synchronous | power | lut | noaccel",
  "### Cap modes ###": "in_out | input | output",
  "version": "1.7.0",
  "defaultDeviceConfig": {
    "disable": false,
    "Use constant time interval based on polling rate": false,
    "DPI (normalizes input speed unit: counts/ms -> in/s)": 0,
    "Polling rate Hz (keep at 0 for automatic adjustment)": 0
  },
  "profiles": [
    ` + templateProfile + `
  ],
  "devices": []
}
`

// DefaultSettings is the settings.json omnisens creates when Raw Accel has
// none yet: Raw Accel's defaults with one flat profile named "default".
func DefaultSettings() []byte {
	root, err := parseSettings([]byte(templateSettings))
	if err != nil {
		panic(err) // the template is a constant
	}
	b, err := encodeSettings(root)
	if err != nil {
		panic(err)
	}
	return b
}

// Factors are what omnisens multiplies into the user's own Raw Accel
// settings: the gain for each direction relative to the current
// sensitivity, and degrees added to the rotation (clockwise positive).
type Factors struct {
	Right, Left, Up, Down float64
	RotationDeg           float64
}

// FactorsFor is the Raw Accel correction for a profile: the least-squares
// 4-direction fit, and the rotation converted to Raw Accel's sign.
func FactorsFor(cfg omnicore.Config) (Factors, omnicore.RawAccelFit) {
	cfg.Sanitize()
	fit := omnicore.FitRawAccel(cfg)
	return Factors{
		Right: fit.Right, Left: fit.Left, Up: fit.Up, Down: fit.Down,
		// omnisens rotates counter-clockwise for positive values, Raw Accel clockwise.
		// Negating the integer keeps "no rotation" a plain 0 (not -0).
		RotationDeg: float64(-cfg.RotationCdeg) / 100,
	}, fit
}

func (f Factors) valid() error {
	for _, v := range []float64{f.Right, f.Left, f.Up, f.Down} {
		if !(v > 0) || math.IsInf(v, 0) {
			return fmt.Errorf("invalid Raw Accel factor %v (must be a positive number)", v)
		}
	}
	if math.IsNaN(f.RotationDeg) || math.Abs(f.RotationDeg) > 180 {
		return fmt.Errorf("invalid rotation %v degrees", f.RotationDeg)
	}
	return nil
}

// applyTo multiplies f into one profile's values. Raw Accel scales x by
// Output DPI (times L/R when moving left) and y by Output DPI times Y/X
// (times U/D when moving up), so right gets O*R, left O*LR*L, down O*YX*D
// and up O*YX*UD*U: every direction gets exactly its factor.
func (f Factors) applyTo(v [5]float64) [5]float64 {
	return [5]float64{
		v[0] * f.Right,
		v[1] * (f.Down / f.Right),
		v[2] * (f.Left / f.Right),
		v[3] * (f.Up / f.Down),
		v[4] + f.RotationDeg,
	}
}

func (f Factors) removeFrom(v [5]float64) [5]float64 {
	return [5]float64{
		v[0] / f.Right,
		v[1] * (f.Right / f.Down),
		v[2] * (f.Right / f.Left),
		v[3] * (f.Down / f.Up),
		v[4] - f.RotationDeg,
	}
}

// SettingsError is a settings.json that Raw Accel would reject or that is
// not in the v1.7 format.
type SettingsError struct{ Msg string }

func (e *SettingsError) Error() string { return "Raw Accel's settings.json " + e.Msg }

func settingsErr(format string, a ...any) error {
	return &SettingsError{Msg: fmt.Sprintf(format, a...)}
}

// ApplySettings returns settings.json with f multiplied into every profile
// (devices without their own entry use the first profile, the others their
// named one, so all of them get the correction), plus a record of the old
// and new values for an exact undo. Every other field is kept as it was.
func ApplySettings(data []byte, f Factors) ([]byte, []state.ProfileRecord, error) {
	if err := f.valid(); err != nil {
		return nil, nil, err
	}
	root, profiles, err := decodeChecked(data)
	if err != nil {
		return nil, nil, err
	}
	if len(profiles) == 0 {
		// Raw Accel uses a default profile when the list is empty; make it
		// explicit so the correction has somewhere to go.
		p, err := parseSettings([]byte(templateProfile))
		if err != nil {
			return nil, nil, err
		}
		profiles = []map[string]any{p}
		root["profiles"] = []any{p}
	}
	recs := make([]state.ProfileRecord, len(profiles))
	for i, p := range profiles {
		before, nums, err := readValues(p)
		if err != nil {
			return nil, nil, err
		}
		after := f.applyTo(before)
		recs[i] = state.ProfileRecord{Name: profileName(p), Before: nums, After: writeValues(p, after)}
	}
	out, err := finish(root, profiles)
	return out, recs, err
}

// RemoveSettings divides f back out of every profile. A field that still
// holds what omnisens wrote (per recs, which may be nil) gets its old text
// back exactly; a field already back at its old value is kept; any other
// field (changed since by the user) is divided. A profile that is back to
// its values from before the correction (Raw Accel's GUI rewrote the file
// from older settings) is left alone and reported in the warning.
func RemoveSettings(data []byte, f Factors, recs []state.ProfileRecord) ([]byte, string, error) {
	if err := f.valid(); err != nil {
		return nil, "", err
	}
	root, profiles, err := decodeChecked(data)
	if err != nil {
		return nil, "", err
	}
	var untouched []string
	for i, p := range profiles {
		cur, _, err := readValues(p)
		if err != nil {
			return nil, "", err
		}
		var rec *state.ProfileRecord
		if i < len(recs) && recs[i].Name == profileName(p) {
			rec = &recs[i]
		}
		if rec != nil && !sameValues(cur, rec.After) && sameValues(cur, rec.Before) {
			untouched = append(untouched, strconv.Quote(profileName(p)))
			continue
		}
		divided := f.removeFrom(cur)
		for k, key := range valueKeys {
			switch {
			case rec != nil && sameNumber(cur[k], rec.After[k]):
				p[key] = rec.Before[k]
			case rec != nil && sameNumber(cur[k], rec.Before[k]):
				// Already the value from before the correction (Raw Accel's
				// window wrote back what it had loaded): dividing it again
				// would apply the inverse correction.
			default:
				p[key] = number(divided[k], removedDigits)
			}
		}
	}
	out, err := finish(root, profiles)
	warning := ""
	switch len(untouched) {
	case 0:
	case 1:
		warning = fmt.Sprintf("Raw Accel profile %s no longer had the omnisens correction (was Apply pressed in Raw Accel's window?), so it was left as it is.", untouched[0])
	default:
		warning = fmt.Sprintf("Raw Accel profiles %s no longer had the omnisens correction (was Apply pressed in Raw Accel's window?), so they were left as they are.", joinNames(untouched))
	}
	return out, warning, err
}

// CheckSettings validates a settings.json the way omnisens needs it.
func CheckSettings(data []byte) error {
	_, profiles, err := decodeChecked(data)
	if err != nil {
		return err
	}
	return checkValues(profiles)
}

func finish(root map[string]any, profiles []map[string]any) ([]byte, error) {
	if err := checkValues(profiles); err != nil {
		return nil, err
	}
	return encodeSettings(root)
}

// checkValues applies Raw Accel's own validation (rawaccel-validate.hpp) to
// the fields omnisens changes, so writer.exe never gets values it rejects.
func checkValues(profiles []map[string]any) error {
	for _, p := range profiles {
		v, _, err := readValues(p)
		if err != nil {
			return err
		}
		name := strconv.Quote(profileName(p))
		for k, x := range v {
			if math.IsNaN(x) || math.IsInf(x, 0) {
				return settingsErr("profile %s: %q is not a finite number", name, valueKeys[k])
			}
		}
		switch {
		case v[0] == 0:
			return settingsErr("profile %s: output DPI is 0", name)
		case v[1] == 0:
			return settingsErr("profile %s: Y/X output DPI ratio is 0", name)
		case v[2] <= 0 || v[3] <= 0:
			return settingsErr("profile %s: output DPI ratios must be positive", name)
		}
	}
	return nil
}

func decodeChecked(data []byte) (map[string]any, []map[string]any, error) {
	root, err := parseSettings(data)
	if err != nil {
		return nil, nil, err
	}
	for _, k := range topKeys {
		if _, ok := root[k]; !ok {
			return nil, nil, settingsErr("has no %q (not a Raw Accel 1.7 settings file?)", k)
		}
	}
	list, ok := root["profiles"].([]any)
	if !ok {
		return nil, nil, settingsErr(`has a "profiles" entry that is not a list`)
	}
	profiles := make([]map[string]any, len(list))
	for i, item := range list {
		p, ok := item.(map[string]any)
		if !ok {
			return nil, nil, settingsErr("profile %d is not an object", i+1)
		}
		for _, k := range profileKeys {
			if _, ok := p[k]; !ok {
				return nil, nil, settingsErr("profile %d has no %q", i+1, k)
			}
		}
		profiles[i] = p
	}
	return root, profiles, nil
}

// parseSettings decodes a JSON object keeping numbers as their text.
func parseSettings(data []byte) (map[string]any, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")) // Notepad may add a BOM
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var root map[string]any
	if err := dec.Decode(&root); err != nil {
		return nil, settingsErr("is not valid JSON: %v", err)
	}
	if root == nil {
		return nil, settingsErr("is not a JSON object")
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, settingsErr("has data after the JSON object")
	}
	return root, nil
}

func encodeSettings(root map[string]any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(root); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func readValues(p map[string]any) ([5]float64, [5]json.Number, error) {
	var v [5]float64
	var nums [5]json.Number
	for k, key := range valueKeys {
		n, ok := p[key].(json.Number)
		if !ok {
			return v, nums, settingsErr("profile %q: %q is not a number", profileName(p), key)
		}
		x, err := n.Float64()
		if err != nil {
			return v, nums, settingsErr("profile %q: %q is not a number", profileName(p), key)
		}
		v[k], nums[k] = x, n
	}
	return v, nums, nil
}

func writeValues(p map[string]any, v [5]float64) [5]json.Number {
	var nums [5]json.Number
	for k, key := range valueKeys {
		nums[k] = number(v[k], appliedDigits)
		p[key] = nums[k]
	}
	return nums
}

// Applied values keep 15 significant digits, which only hides the float
// noise of the multiplication; removed values are rounded to 12, so dividing
// the factors back out lands exactly on the user's own numbers (they have
// far fewer digits) and repeated apply/remove never drifts.
const (
	appliedDigits = 15
	removedDigits = 12
)

func number(x float64, digits int) json.Number {
	r, err := strconv.ParseFloat(strconv.FormatFloat(x, 'g', digits, 64), 64)
	if err != nil || r == 0 {
		r = 0 // also turns -0 into 0
	}
	return json.Number(strconv.FormatFloat(r, 'f', -1, 64))
}

func sameNumber(x float64, n json.Number) bool {
	y, err := n.Float64()
	if err != nil {
		return false
	}
	return x == y || math.Abs(x-y) <= 1e-9*math.Max(math.Abs(x), math.Abs(y))
}

func sameValues(v [5]float64, nums [5]json.Number) bool {
	for k := range v {
		if !sameNumber(v[k], nums[k]) {
			return false
		}
	}
	return true
}

func profileName(p map[string]any) string {
	s, _ := p["name"].(string)
	return s
}

func joinNames(names []string) string {
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0]
	}
	out := names[0]
	for _, n := range names[1 : len(names)-1] {
		out += ", " + n
	}
	return out + " and " + names[len(names)-1]
}
