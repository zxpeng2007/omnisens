// Command fakewriter stands in for Raw Accel's writer.exe in tests (build it
// for Windows and copy it as writer.exe). Like the real one it takes the
// path of a settings.json, exits 0 when Raw Accel would accept it and 1
// otherwise (printing the reason instead of showing a message box). Every
// call appends its arguments as a JSON array line to fakewriter-args.txt
// next to the executable. FAKEWRITER_FAIL=1 makes it fail regardless.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

var topKeys = []string{"version", "defaultDeviceConfig", "profiles", "devices"}

var deviceKeys = []string{
	"disable",
	"DPI (normalizes input speed unit: counts/ms -> in/s)",
	"Polling rate Hz (keep at 0 for automatic adjustment)",
}

var profileKeys = []string{
	"name",
	"Stretches domain for horizontal vs vertical inputs",
	"Stretches accel range for horizontal vs vertical inputs",
	"Whole or horizontal accel parameters",
	"Vertical accel parameters",
	"Input speed calculation parameters",
	"Output DPI",
	"Y/X output DPI ratio (vertical sens multiplier)",
	"L/R output DPI ratio (left sens multiplier)",
	"U/D output DPI ratio (up sens multiplier)",
	"Degrees of rotation",
	"Degrees of angle snapping",
	"Input Speed Cap",
}

func main() {
	record()
	if err := check(); err != nil {
		fmt.Fprintln(os.Stderr, "fakewriter:", err)
		os.Exit(1)
	}
}

func record() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	line, _ := json.Marshal(os.Args[1:])
	f, err := os.OpenFile(filepath.Join(filepath.Dir(exe), "fakewriter-args.txt"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	f.Write(append(line, '\n'))
}

func check() error {
	if os.Getenv("FAKEWRITER_FAIL") == "1" {
		return fmt.Errorf("asked to fail")
	}
	if len(os.Args) != 2 {
		return fmt.Errorf("usage: writer.exe <settings.json>")
	}
	b, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	var root map[string]any
	if err := json.Unmarshal(b, &root); err != nil {
		return fmt.Errorf("invalid JSON: %v", err)
	}
	if err := need(root, topKeys, "settings"); err != nil {
		return err
	}
	dev, ok := root["defaultDeviceConfig"].(map[string]any)
	if !ok {
		return fmt.Errorf("defaultDeviceConfig is not an object")
	}
	if err := need(dev, deviceKeys, "defaultDeviceConfig"); err != nil {
		return err
	}
	if _, ok := root["devices"].([]any); !ok {
		return fmt.Errorf("devices is not a list")
	}
	profiles, ok := root["profiles"].([]any)
	if !ok {
		return fmt.Errorf("profiles is not a list")
	}
	for i, item := range profiles {
		p, ok := item.(map[string]any)
		if !ok {
			return fmt.Errorf("profile %d is not an object", i)
		}
		if err := need(p, profileKeys, fmt.Sprintf("profile %d", i)); err != nil {
			return err
		}
		if name, _ := p["name"].(string); name == "" {
			return fmt.Errorf("profile name can not be empty")
		}
		num := func(k string) (float64, error) {
			v, ok := p[k].(float64)
			if !ok {
				return 0, fmt.Errorf("profile %d: %q is not a number", i, k)
			}
			return v, nil
		}
		vals := map[string]float64{}
		for _, k := range profileKeys[6:] {
			v, err := num(k)
			if err != nil {
				return err
			}
			vals[k] = v
		}
		switch {
		case vals["Output DPI"] == 0:
			return fmt.Errorf("output DPI is 0")
		case vals["Y/X output DPI ratio (vertical sens multiplier)"] == 0:
			return fmt.Errorf("Y/X output DPI ratio is 0")
		case vals["L/R output DPI ratio (left sens multiplier)"] <= 0 || vals["U/D output DPI ratio (up sens multiplier)"] <= 0:
			return fmt.Errorf("output DPI ratio must be positive")
		case vals["Degrees of angle snapping"] < 0 || vals["Degrees of angle snapping"] > 45:
			return fmt.Errorf("snap angle must be between 0 and 45 degrees")
		case vals["Input Speed Cap"] < 0:
			return fmt.Errorf("speed cap is negative")
		}
	}
	return nil
}

func need(obj map[string]any, keys []string, what string) error {
	for _, k := range keys {
		if _, ok := obj[k]; !ok {
			return fmt.Errorf("%s: required property %q not found", what, k)
		}
	}
	return nil
}
