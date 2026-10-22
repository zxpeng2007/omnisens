package rawaccel

import (
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
)

// userSettings is a settings.json as Raw Accel's GUI writes it (number text
// like 1.0 and 0.0050 must survive), with two profiles and a device bound
// to the second one.
const userSettings = `{
  "### Accel modes ###": "classic | jump | natural | synchronous | power | lut | noaccel",
  "### Cap modes ###": "in_out | input | output",
  "version": "1.7.0",
  "defaultDeviceConfig": {
    "disable": false,
    "DPI (normalizes input speed unit: counts/ms -> in/s)": 1600,
    "Polling rate Hz (keep at 0 for automatic adjustment)": 0
  },
  "profiles": [
    {
      "name": "Default & main",
      "Stretches domain for horizontal vs vertical inputs": {"x": 1.0, "y": 1.0},
      "Stretches accel range for horizontal vs vertical inputs": {"x": 1.0, "y": 1.0},
      "Whole or horizontal accel parameters": {"mode": "classic", "Gain / Velocity": true, "inputOffset": 0.0, "outputOffset": 0.0, "acceleration": 0.0050, "exponentClassic": 2.0, "Cap / Jump": {"x": 15.0, "y": 1.5}, "Cap mode": "output", "data": []},
      "Vertical accel parameters": {"mode": "noaccel", "acceleration": 0.0050, "data": []},
      "Input speed calculation parameters": {"Whole/combined accel (set false for 'by component' mode)": true, "lpNorm": 2.0},
      "Output DPI": 800.0,
      "Y/X output DPI ratio (vertical sens multiplier)": 1.1,
      "L/R output DPI ratio (left sens multiplier)": 0.9,
      "U/D output DPI ratio (up sens multiplier)": 1.05,
      "Degrees of rotation": 2.0,
      "Degrees of angle snapping": 0.0,
      "Input Speed Cap": 0.0
    },
    {
      "name": "tablet",
      "Stretches domain for horizontal vs vertical inputs": {"x": 1.0, "y": 1.0},
      "Stretches accel range for horizontal vs vertical inputs": {"x": 1.0, "y": 1.0},
      "Whole or horizontal accel parameters": {"mode": "noaccel", "data": []},
      "Vertical accel parameters": {"mode": "noaccel", "data": []},
      "Input speed calculation parameters": {"lpNorm": 2.0},
      "Output DPI": 1234.5678,
      "Y/X output DPI ratio (vertical sens multiplier)": -1.0,
      "L/R output DPI ratio (left sens multiplier)": 1.0,
      "U/D output DPI ratio (up sens multiplier)": 1.0,
      "Degrees of rotation": 0.0,
      "Degrees of angle snapping": 5.0,
      "Input Speed Cap": 0.0
    }
  ],
  "devices": [
    {"name": "Wacom <pen>", "profile": "tablet", "id": "HID\\VID_056A&PID_0001", "config": {"disable": false, "DPI (normalizes input speed unit: counts/ms -> in/s)": 0, "Polling rate Hz (keep at 0 for automatic adjustment)": 0}}
  ]
}`

var testFactors = Factors{Right: 0.97, Left: 1.02, Up: 1.04, Down: 0.98, RotationDeg: -1.5}

func profilesOf(t *testing.T, data []byte) []map[string]any {
	t.Helper()
	_, profiles, err := decodeChecked(data)
	if err != nil {
		t.Fatal(err)
	}
	return profiles
}

func valuesOf(t *testing.T, p map[string]any) [5]float64 {
	t.Helper()
	v, _, err := readValues(p)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// gains is what Raw Accel does to each direction for a profile's values.
func gains(v [5]float64) (right, left, up, down float64) {
	return v[0], v[0] * v[2], v[0] * v[1] * v[3], v[0] * v[1]
}

func near(a, b float64) bool { return math.Abs(a-b) <= 1e-9*math.Max(1, math.Abs(b)) }

func reencode(t *testing.T, data []byte) string {
	t.Helper()
	root, err := parseSettings(data)
	if err != nil {
		t.Fatal(err)
	}
	b, err := encodeSettings(root)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestApplyGivesEveryDirectionItsFactor(t *testing.T) {
	out, recs, err := ApplySettings([]byte(userSettings), testFactors)
	if err != nil {
		t.Fatal(err)
	}
	before, after := profilesOf(t, []byte(userSettings)), profilesOf(t, out)
	if len(recs) != 2 || len(after) != 2 {
		t.Fatalf("records %d, profiles %d", len(recs), len(after))
	}
	for i := range before {
		b, a := valuesOf(t, before[i]), valuesOf(t, after[i])
		br, bl, bu, bd := gains(b)
		ar, al, au, ad := gains(a)
		for _, c := range []struct {
			name           string
			got, want, was float64
		}{
			{"right", ar, testFactors.Right, br}, {"left", al, testFactors.Left, bl},
			{"up", au, testFactors.Up, bu}, {"down", ad, testFactors.Down, bd},
		} {
			if !near(c.got/c.was, c.want) {
				t.Errorf("profile %d %s: factor %.12f, want %.12f", i, c.name, c.got/c.was, c.want)
			}
		}
		if !near(a[4], b[4]+testFactors.RotationDeg) {
			t.Errorf("profile %d rotation %v", i, a[4])
		}
		if recs[i].Name != profileName(before[i]) {
			t.Errorf("record name %q", recs[i].Name)
		}
	}
	// The fit of a real profile goes through the same path.
	cfg := omnicore.ConfigFromGains([]float64{0.93, 0.95, 1.05, 1.03, 1.07, 1, 0.98, 0.95}, false)
	cfg.RotationCdeg = 150
	f, fit := FactorsFor(cfg)
	if f.Right != fit.Right || f.Up != fit.Up || f.RotationDeg != -1.5 {
		t.Fatalf("factors %+v fit %+v", f, fit)
	}
	if f, _ := FactorsFor(omnicore.DefaultConfig()); math.Signbit(f.RotationDeg) {
		t.Fatal("no rotation is -0")
	}
}

func TestApplyKeepsEverythingElse(t *testing.T) {
	out, _, err := ApplySettings([]byte(userSettings), testFactors)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{
		`"acceleration": 0.0050`, `"exponentClassic": 2.0`, `"lpNorm": 2.0`, `"Degrees of angle snapping": 5.0`,
		`"DPI (normalizes input speed unit: counts/ms -> in/s)": 1600`, `"name": "Wacom <pen>"`,
		`"id": "HID\\VID_056A&PID_0001"`, `"### Accel modes ###"`, `"version": "1.7.0"`, `"data": []`,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("output lost %s", want)
		}
	}
	// Apart from the five fields every value is identical.
	strip := func(data []byte) []any {
		var root map[string]any
		dec := json.NewDecoder(strings.NewReader(string(data)))
		dec.UseNumber()
		if err := dec.Decode(&root); err != nil {
			t.Fatal(err)
		}
		for _, p := range root["profiles"].([]any) {
			for _, k := range valueKeys {
				delete(p.(map[string]any), k)
			}
		}
		return []any{root}
	}
	if !reflect.DeepEqual(strip([]byte(userSettings)), strip(out)) {
		t.Fatal("fields other than the five changed")
	}
	if !strings.HasPrefix(s, "{\n  \"") {
		t.Fatalf("not 2-space indented: %.20q", s)
	}
}

func TestRemoveRestoresExactly(t *testing.T) {
	orig := reencode(t, []byte(userSettings))
	out, recs, err := ApplySettings([]byte(userSettings), testFactors)
	if err != nil {
		t.Fatal(err)
	}
	back, warning, err := RemoveSettings(out, testFactors, recs)
	if err != nil || warning != "" {
		t.Fatal(err, warning)
	}
	if string(back) != orig {
		t.Fatalf("remove did not restore the file:\n%s", back)
	}
	// Without the record (or after the file was re-saved) dividing still
	// lands on the same values, with no drift over many rounds.
	cur := []byte(userSettings)
	for i := 0; i < 50; i++ {
		applied, _, err := ApplySettings(cur, testFactors)
		if err != nil {
			t.Fatal(err)
		}
		cur, _, err = RemoveSettings(applied, testFactors, nil)
		if err != nil {
			t.Fatal(err)
		}
	}
	want, got := profilesOf(t, []byte(userSettings)), profilesOf(t, cur)
	for i := range want {
		if valuesOf(t, want[i]) != valuesOf(t, got[i]) {
			t.Fatalf("profile %d drifted: %v -> %v", i, valuesOf(t, want[i]), valuesOf(t, got[i]))
		}
	}
}

func TestReapplyNeverCompounds(t *testing.T) {
	second := Factors{Right: 1.1, Left: 0.9, Up: 1.2, Down: 0.8, RotationDeg: 3}
	direct, _, err := ApplySettings([]byte(userSettings), second)
	if err != nil {
		t.Fatal(err)
	}
	for _, keepRecords := range []bool{true, false} {
		cur, recs, err := ApplySettings([]byte(userSettings), testFactors)
		if err != nil {
			t.Fatal(err)
		}
		prev := testFactors
		// Switch profiles a few times the way Manager.Apply does: the old
		// factors come out, then the new ones go in.
		for _, next := range []Factors{second, testFactors, second} {
			if !keepRecords {
				recs = nil
			}
			base, _, err := RemoveSettings(cur, prev, recs)
			if err != nil {
				t.Fatal(err)
			}
			if cur, recs, err = ApplySettings(base, next); err != nil {
				t.Fatal(err)
			}
			prev = next
		}
		if string(cur) != string(direct) {
			t.Fatalf("records %v: re-applying compounded:\n%s\nwant\n%s", keepRecords, cur, direct)
		}
	}
}

func TestRemoveAfterOutsideChanges(t *testing.T) {
	out, recs, err := ApplySettings([]byte(userSettings), testFactors)
	if err != nil {
		t.Fatal(err)
	}
	// The GUI wrote back the old values of profile 0 (Apply pressed in a
	// window opened before omnisens applied): it must not be divided again.
	profiles := profilesOf(t, []byte(userSettings))
	root, now, _ := decodeChecked(out)
	for _, k := range valueKeys {
		now[0][k] = profiles[0][k]
	}
	// The user changed the output DPI of profile 1 on top of the correction.
	now[1][keyOutputDPI] = json.Number("2000")
	edited, _ := encodeSettings(root)
	back, warning, err := RemoveSettings(edited, testFactors, recs)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(warning, `"Default & main"`) {
		t.Fatalf("warning %q", warning)
	}
	got := profilesOf(t, back)
	if valuesOf(t, got[0]) != valuesOf(t, profiles[0]) {
		t.Fatalf("restored profile was divided again: %v", valuesOf(t, got[0]))
	}
	v1, w1 := valuesOf(t, got[1]), valuesOf(t, profiles[1])
	if !near(v1[0], 2000/testFactors.Right) || v1[1] != w1[1] || v1[2] != w1[2] || v1[3] != w1[3] || v1[4] != w1[4] {
		t.Fatalf("profile 1 after remove: %v (was %v)", v1, w1)
	}

	// The window wrote back its pre-correction values with one of them
	// changed: the untouched four must not be divided again.
	root, now, _ = decodeChecked(out)
	for i := range now {
		for _, k := range valueKeys {
			now[i][k] = profiles[i][k]
		}
	}
	now[0][keyOutputDPI] = json.Number("900")
	edited, _ = encodeSettings(root)
	back, warning, err = RemoveSettings(edited, testFactors, recs)
	if err != nil {
		t.Fatal(err)
	}
	got = profilesOf(t, back)
	v0, w0 := valuesOf(t, got[0]), valuesOf(t, profiles[0])
	if !near(v0[0], 900/testFactors.Right) || v0[1] != w0[1] || v0[2] != w0[2] || v0[3] != w0[3] || v0[4] != w0[4] {
		t.Fatalf("partly rewritten profile after remove: %v (was %v)", v0, w0)
	}
	if valuesOf(t, got[1]) != valuesOf(t, profiles[1]) || !strings.Contains(warning, `profile "tablet" no longer`) {
		t.Fatalf("profile 1 %v, warning %q", valuesOf(t, got[1]), warning)
	}

	// Several reverted profiles are named together.
	_, warning, err = RemoveSettings([]byte(userSettings), testFactors, recs)
	if err != nil || !strings.Contains(warning, `profiles "Default & main" and "tablet" no longer`) || !strings.Contains(warning, "they were left") {
		t.Fatalf("warning %q %v", warning, err)
	}
}

func TestDefaultSettings(t *testing.T) {
	d := DefaultSettings()
	if err := CheckSettings(d); err != nil {
		t.Fatal(err)
	}
	p := profilesOf(t, d)
	if len(p) != 1 || profileName(p[0]) != "default" || valuesOf(t, p[0]) != [5]float64{1000, 1, 1, 1, 0} {
		t.Fatalf("template profile %v", p)
	}
	for _, k := range profileKeys {
		if _, ok := p[0][k]; !ok {
			t.Errorf("template misses %q", k)
		}
	}
	// An empty profile list gets an explicit default profile to carry the correction.
	root, _ := parseSettings(d)
	root["profiles"] = []any{}
	empty, _ := encodeSettings(root)
	out, recs, err := ApplySettings(empty, testFactors)
	if err != nil || len(recs) != 1 || len(profilesOf(t, out)) != 1 {
		t.Fatalf("empty profiles: %v %d", err, len(recs))
	}
}

func TestRejectsInvalid(t *testing.T) {
	for _, f := range []Factors{
		{Right: 0, Left: 1, Up: 1, Down: 1}, {Right: 1, Left: -1, Up: 1, Down: 1},
		{Right: 1, Left: 1, Up: math.NaN(), Down: 1}, {Right: 1, Left: 1, Up: 1, Down: math.Inf(1)},
		{Right: 1, Left: 1, Up: 1, Down: 1, RotationDeg: math.NaN()},
	} {
		if _, _, err := ApplySettings([]byte(userSettings), f); err == nil {
			t.Errorf("factors %+v accepted", f)
		}
		if _, _, err := RemoveSettings([]byte(userSettings), f, nil); err == nil {
			t.Errorf("remove with %+v accepted", f)
		}
	}
	bad := map[string]string{
		"not json":       `{"version": `,
		"trailing data":  userSettings + `{}`,
		"array":          `[]`,
		"no profiles":    strings.Replace(userSettings, `"profiles"`, `"profilez"`, 1),
		"profiles kind":  `{"version":"1.7.0","defaultDeviceConfig":{},"devices":[],"profiles":{}}`,
		"missing key":    strings.Replace(userSettings, `"Output DPI": 800.0,`, ``, 1),
		"string value":   strings.Replace(userSettings, `"Output DPI": 800.0`, `"Output DPI": "800"`, 1),
		"zero LR":        strings.Replace(userSettings, `"L/R output DPI ratio (left sens multiplier)": 0.9`, `"L/R output DPI ratio (left sens multiplier)": 0`, 1),
		"negative UD":    strings.Replace(userSettings, `"U/D output DPI ratio (up sens multiplier)": 1.05`, `"U/D output DPI ratio (up sens multiplier)": -1`, 1),
		"zero Y/X":       strings.Replace(userSettings, `"Y/X output DPI ratio (vertical sens multiplier)": 1.1`, `"Y/X output DPI ratio (vertical sens multiplier)": 0`, 1),
		"zero DPI":       strings.Replace(userSettings, `"Output DPI": 800.0`, `"Output DPI": 0`, 1),
		"profile kind":   strings.Replace(userSettings, `"profiles": [`, `"profiles": [1,`, 1),
		"huge number":    strings.Replace(userSettings, `"Output DPI": 800.0`, `"Output DPI": 1e999`, 1),
		"missing top":    strings.Replace(userSettings, `"devices"`, `"devicez"`, 1),
		"null document":  `null`,
		"string literal": `"x"`,
	}
	for name, s := range bad {
		_, _, err := ApplySettings([]byte(s), testFactors)
		var se *SettingsError
		if !errors.As(err, &se) {
			t.Errorf("%s: got %v, want a SettingsError", name, err)
		}
	}
	if err := CheckSettings([]byte(userSettings)); err != nil {
		t.Fatal(err)
	}
	if err := CheckSettings([]byte("\xef\xbb\xbf" + userSettings)); err != nil {
		t.Fatalf("BOM: %v", err)
	}
}

func TestNumberFormatting(t *testing.T) {
	for _, c := range []struct {
		in     float64
		digits int
		want   string
	}{
		{776.0000000000001, appliedDigits, "776"}, {800 * 0.97, appliedDigits, "776"},
		{0.98 / 0.97, appliedDigits, "1.01030927835052"}, {0.98 / 0.97, removedDigits, "1.01030927835"},
		{math.Copysign(0, -1), removedDigits, "0"}, {1e-20, appliedDigits, "0.00000000000000000001"}, {1000, removedDigits, "1000"},
	} {
		if got := number(c.in, c.digits); string(got) != c.want {
			t.Errorf("number(%v, %d) = %s, want %s", c.in, c.digits, got, c.want)
		}
	}
}
