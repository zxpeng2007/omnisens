package rawaccel

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// IsRawAccelDir reports whether dir holds Raw Accel's writer.exe and
// rawaccel.exe.
func IsRawAccelDir(dir string) bool {
	if dir == "" || !filepath.IsAbs(dir) {
		return false
	}
	for _, f := range []string{"writer.exe", "rawaccel.exe"} {
		st, err := os.Stat(filepath.Join(dir, f))
		if err != nil || !st.Mode().IsRegular() {
			return false
		}
	}
	return true
}

// NormalizeDir turns what a user pasted (a folder, possibly in quotes as
// Explorer's "Copy as path" gives it, or the path of one of Raw Accel's
// programs) into a clean absolute folder path.
func NormalizeDir(input string) (string, error) {
	s := strings.TrimSpace(input)
	s = strings.TrimSpace(strings.Trim(s, `"'`))
	if s == "" {
		return "", errors.New("enter the folder that contains Raw Accel's rawaccel.exe and writer.exe")
	}
	if !filepath.IsAbs(s) {
		return "", errors.New("enter the full path of the folder, for example C:\\Users\\you\\Downloads\\RawAccel")
	}
	s = filepath.Clean(s)
	if base := strings.ToLower(filepath.Base(s)); strings.HasSuffix(base, ".exe") || base == "settings.json" {
		s = filepath.Dir(s)
	}
	return s, nil
}

// CandidateDirs are the places a Raw Accel folder is looked for, in order:
// omnisens' own install folder, next to omnisens.exe, then the usual places
// people unzip it to. getenv is os.Getenv in production.
func CandidateDirs(getenv func(string) string, exeDir string) []string {
	var out []string
	add := func(parts ...string) {
		if parts[0] == "" {
			return
		}
		out = append(out, filepath.Join(parts...))
	}
	addGlob := func(pattern string) {
		if m, err := filepath.Glob(pattern); err == nil {
			out = append(out, m...)
		}
	}
	local, profile, oneDrive := getenv("LOCALAPPDATA"), getenv("USERPROFILE"), getenv("OneDrive")
	add(local, "omnisens", "RawAccel")
	if exeDir != "" {
		add(exeDir, "RawAccel")
		add(exeDir)
	}
	for _, base := range []string{profile, oneDrive} {
		if base == "" {
			continue
		}
		for _, sub := range []string{"Downloads", "Desktop", "Documents"} {
			add(base, sub, "RawAccel")
			addGlob(filepath.Join(base, sub, "RawAccel*", "RawAccel"))
			addGlob(filepath.Join(base, sub, "RawAccel*"))
		}
		add(base, "RawAccel")
	}
	add(local, "Programs", "RawAccel")
	add(getenv("ProgramFiles"), "RawAccel")
	if drive := getenv("SystemDrive"); drive != "" {
		add(drive+string(filepath.Separator), "RawAccel")
		add(drive+string(filepath.Separator), "Tools", "RawAccel")
	}
	return dedupe(out)
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := in[:0]
	for _, d := range in {
		k := strings.ToLower(filepath.Clean(d))
		if !seen[k] {
			seen[k] = true
			out = append(out, d)
		}
	}
	return out
}
