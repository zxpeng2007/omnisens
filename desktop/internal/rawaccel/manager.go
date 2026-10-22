// Package rawaccel applies omnisens profiles on Windows through the official
// Raw Accel driver: it finds or installs Raw Accel, merges the 4-direction
// fit of a profile into Raw Accel's settings.json (reversibly, on top of the
// user's own settings), loads it with writer.exe and manages the optional
// apply-at-login entry. The merge maths and file handling are portable and
// tested on every OS; the Windows calls live in system_windows.go.
package rawaccel

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
	"github.com/zxpeng2007/omnisens/desktop/internal/state"
)

const (
	settingsName = "settings.json"
	backupName   = "settings.before-omnisens.json"

	// GUIWarning is returned when Raw Accel's window is open: its Apply
	// button rewrites settings.json from what it loaded at startup.
	GUIWarning = "Close Raw Accel's window without pressing Apply, or it may overwrite these settings."

	vcRedistURL = "https://aka.ms/vs/17/release/vc_redist.x64.exe"

	installMessage = "Raw Accel's installer is open (approve the Windows prompt, then press a key in its window). Restart your PC afterwards, then come back and press Apply."
)

// Error is a failure with a message meant for the user; the API answers
// with Status.
type Error struct {
	Status int
	Msg    string
}

func (e *Error) Error() string   { return e.Msg }
func (e *Error) HTTPStatus() int { return e.Status }

func userErr(status int, format string, a ...any) error {
	return &Error{Status: status, Msg: fmt.Sprintf(format, a...)}
}

// Manager implements the Raw Accel side of the omnisens API.
type Manager struct {
	Store   *state.Store
	Sys     System
	Release Release
	// InstallDir is where the official zip is unpacked
	// (%LOCALAPPDATA%\omnisens\RawAccel).
	InstallDir string
	// Candidates lists folders to look for an existing Raw Accel in.
	Candidates func() []string
	HTTP       *http.Client
	Now        func() time.Time

	mu sync.Mutex
}

// NewManager returns a Manager with the production defaults.
func NewManager(store *state.Store, sys System) *Manager {
	exeDir := ""
	if exe, err := os.Executable(); err == nil {
		exeDir = filepath.Dir(exe)
	}
	return &Manager{
		Store:      store,
		Sys:        sys,
		Release:    Official,
		InstallDir: filepath.Join(store.Dir(), "RawAccel"),
		Candidates: func() []string { return CandidateDirs(os.Getenv, exeDir) },
		HTTP:       &http.Client{Timeout: 5 * time.Minute},
		Now:        time.Now,
	}
}

// Info is the "rawAccel" object of GET /api/info.
type Info struct {
	Dir             string       `json:"dir"`
	Found           bool         `json:"found"`
	DriverInstalled bool         `json:"driverInstalled"`
	DriverRunning   bool         `json:"driverRunning"`
	RestartNeeded   bool         `json:"restartNeeded"`
	VCRuntime       bool         `json:"vcRuntime"`
	GUIRunning      bool         `json:"guiRunning"`
	SettingsFound   bool         `json:"settingsFound"`
	Applied         *AppliedInfo `json:"applied"`
	Paused          bool         `json:"paused"`
	Autostart       bool         `json:"autostart"`
	Download        Release      `json:"download"`
	Error           string       `json:"error,omitempty"`
}

// AppliedInfo is the applied correction as the API shows it.
type AppliedInfo struct {
	Code        string    `json:"code"`
	Right       float64   `json:"right"`
	Left        float64   `json:"left"`
	Up          float64   `json:"up"`
	Down        float64   `json:"down"`
	RotationDeg float64   `json:"rotationDeg"`
	At          time.Time `json:"at"`
}

// FitInfo is the "fit" object of POST /api/apply.
type FitInfo struct {
	Right       float64    `json:"right"`
	Left        float64    `json:"left"`
	Up          float64    `json:"up"`
	Down        float64    `json:"down"`
	Errors8     [8]float64 `json:"errors8"`
	MaxErrorPct float64    `json:"maxErrorPct"`
	RMSErrorPct float64    `json:"rmsErrorPct"`
	MaxSkewDeg  float64    `json:"maxSkewDeg"`
}

// Method is the API's name for this way of applying profiles.
func (m *Manager) Method() string { return "rawaccel" }

// Info is the API's view of the system and state.
func (m *Manager) Info() map[string]any { return map[string]any{"rawAccel": m.Status()} }

// Status checks Raw Accel's folder, driver, runtime, window and autostart.
func (m *Manager) Status() Info {
	info := Info{Download: m.Release}
	st, err := m.Store.Load()
	if err != nil {
		info.Error = err.Error()
	}
	var wg sync.WaitGroup
	var drv DriverStatus
	wg.Add(4)
	go func() { defer wg.Done(); drv = m.Sys.Driver() }()
	go func() { defer wg.Done(); info.VCRuntime = m.Sys.VCRuntime() }()
	go func() { defer wg.Done(); info.GUIRunning = m.Sys.GUIRunning() }()
	go func() { defer wg.Done(); info.Autostart, _ = m.Sys.Autostart() }()
	info.Dir = m.findDir(st)
	wg.Wait()
	info.Found = info.Dir != ""
	info.DriverInstalled, info.DriverRunning = drv.Installed, drv.Running
	info.RestartNeeded = drv.Installed && !drv.Running
	if info.Found {
		_, err := os.Stat(filepath.Join(info.Dir, settingsName))
		info.SettingsFound = err == nil
	}
	info.Applied = publicApplied(st.Applied)
	info.Paused = st.Applied != nil && st.Paused
	return info
}

func publicApplied(a *state.Applied) *AppliedInfo {
	if a == nil {
		return nil
	}
	return &AppliedInfo{Code: a.Code, Right: a.Right, Left: a.Left, Up: a.Up, Down: a.Down, RotationDeg: a.RotationDeg, At: a.At}
}

func factorsOf(a *state.Applied) Factors {
	return Factors{Right: a.Right, Left: a.Left, Up: a.Up, Down: a.Down, RotationDeg: a.RotationDeg}
}

// findDir is the remembered folder if it is still valid, else the first
// candidate that holds Raw Accel.
func (m *Manager) findDir(st state.State) string {
	if IsRawAccelDir(st.RawAccelDir) {
		return st.RawAccelDir
	}
	if m.Candidates != nil {
		for _, d := range m.Candidates() {
			if IsRawAccelDir(d) {
				return d
			}
		}
	}
	return ""
}

// Apply merges a profile's Raw Accel fit into settings.json and loads it.
func (m *Manager) Apply(code string) (map[string]any, error) {
	code = strings.TrimSpace(code)
	cfg, err := omnicore.DecodeProfileCode(code)
	if err != nil {
		return nil, userErr(http.StatusBadRequest, "That profile code cannot be used: %v.", err)
	}
	if cfg.Flags&omnicore.FlagEnabled == 0 {
		return nil, userErr(http.StatusBadRequest, "This profile is switched off, so there is nothing to apply.")
	}
	f, fit := FactorsFor(cfg)

	m.mu.Lock()
	defer m.mu.Unlock()
	st, err := m.Store.Load()
	if err != nil {
		return nil, userErr(http.StatusInternalServerError, "%v", err)
	}
	dir := m.findDir(st)
	if dir == "" {
		return nil, userErr(http.StatusConflict, "omnisens cannot find Raw Accel on this PC. Press Install Raw Accel, or choose the folder where you unzipped it.")
	}
	drv := m.Sys.Driver()
	switch {
	case !drv.Installed:
		return nil, userErr(http.StatusConflict, "Raw Accel's driver is not installed yet. Press Install Raw Accel (it asks for administrator rights), restart your PC, then apply the profile.")
	case !drv.Running:
		return nil, userErr(http.StatusConflict, "Raw Accel's driver is installed but not running yet. Restart your PC, then press Apply again.")
	case !m.Sys.VCRuntime():
		return nil, userErr(http.StatusConflict, "Raw Accel needs the Microsoft Visual C++ runtime (x64). Install it from %s, then press Apply again.", vcRedistURL)
	}

	path := filepath.Join(dir, settingsName)
	cur, created, err := readSettings(path)
	if err != nil {
		return nil, err
	}
	var warnings []string
	base := cur
	prev := ""
	if st.Applied != nil && !st.Paused {
		prev = settingsFileOf(st, path)
		// A settings.json created just now from the defaults never had the
		// old correction, so there is nothing to divide out of it.
		if samePath(prev, path) && !created {
			// Take the previous correction out first so factors never compound.
			var w string
			base, w, err = RemoveSettings(cur, factorsOf(st.Applied), st.Applied.Profiles)
			if err != nil {
				return nil, settingsUserErr(err)
			}
			warnings = appendNonEmpty(warnings, w)
		}
	}
	out, recs, err := ApplySettings(base, f)
	if err != nil {
		return nil, settingsUserErr(err)
	}
	if err := m.commit(dir, path, cur, created, out, true); err != nil {
		return nil, err
	}
	if prev != "" && !samePath(prev, path) {
		// The old correction is in another folder's settings.json.
		w, err := m.undoFile(prev, st.Applied, false)
		if err != nil {
			w = fmt.Sprintf("The previous correction in %s could not be removed: %v", prev, err)
		}
		warnings = appendNonEmpty(warnings, w)
	}
	a := &state.Applied{
		Code: code, Right: f.Right, Left: f.Left, Up: f.Up, Down: f.Down, RotationDeg: f.RotationDeg,
		At: m.Now().UTC().Truncate(time.Second), SettingsFile: path, Profiles: recs,
	}
	st.Applied, st.Paused, st.LastCode, st.RawAccelDir = a, false, code, dir
	if err := m.Store.Save(st); err != nil {
		m.restore(dir, path, cur, created, true)
		return nil, userErr(http.StatusInternalServerError, "Could not save omnisens' state, so Raw Accel was left as it was: %v", err)
	}
	if m.Sys.GUIRunning() {
		warnings = append(warnings, GUIWarning)
	}
	res := map[string]any{
		"fit": FitInfo{
			Right: fit.Right, Left: fit.Left, Up: fit.Up, Down: fit.Down, Errors8: fit.Errors8,
			MaxErrorPct: fit.MaxErrorPct, RMSErrorPct: fit.RMSErrorPct, MaxSkewDeg: fit.MaxSkewDeg,
		},
		"applied": publicApplied(a),
		"message": appliedMessage(f, len(recs), path),
	}
	if len(warnings) > 0 {
		res["warning"] = strings.Join(warnings, " ")
	}
	return res, nil
}

func appliedMessage(f Factors, profiles int, path string) string {
	s := fmt.Sprintf("Raw Accel now scales right x%.4f, left x%.4f, up x%.4f, down x%.4f", f.Right, f.Left, f.Up, f.Down)
	if f.RotationDeg != 0 {
		s += fmt.Sprintf(" and rotates %+.2f degrees", f.RotationDeg)
	}
	plural := "s"
	if profiles == 1 {
		plural = ""
	}
	return fmt.Sprintf("%s on top of your own settings (%d profile%s in %s). It stays until you restart, unless Apply at every login is on.", s, profiles, plural, path)
}

// Remove takes the correction out of settings.json and reloads it.
func (m *Manager) Remove() (map[string]any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, err := m.Store.Load()
	if err != nil {
		return nil, userErr(http.StatusInternalServerError, "%v", err)
	}
	if st.Applied == nil {
		return map[string]any{"message": "No omnisens correction is applied."}, nil
	}
	var warnings []string
	if !st.Paused {
		w, err := m.undoFile(settingsFileOf(st, ""), st.Applied, true)
		if err != nil {
			return nil, err
		}
		warnings = appendNonEmpty(warnings, w)
	}
	st.Applied, st.Paused = nil, false
	if err := m.Store.Save(st); err != nil {
		return nil, userErr(http.StatusInternalServerError, "The correction was removed from Raw Accel, but omnisens could not save its state: %v", err)
	}
	return m.result(map[string]any{"message": "The omnisens correction was removed from Raw Accel; your own settings are back."}, warnings), nil
}

// Pause takes the correction out for a calibration session but remembers it.
func (m *Manager) Pause() (map[string]any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, err := m.Store.Load()
	if err != nil {
		return nil, userErr(http.StatusInternalServerError, "%v", err)
	}
	if st.Applied == nil || st.Paused {
		return map[string]any{"paused": st.Applied != nil && st.Paused, "message": "Nothing to pause."}, nil
	}
	w, err := m.undoFile(settingsFileOf(st, ""), st.Applied, true)
	if err != nil {
		return nil, err
	}
	st.Paused = true
	st.Applied.Profiles = nil
	if err := m.Store.Save(st); err != nil {
		return nil, userErr(http.StatusInternalServerError, "Could not save omnisens' state: %v", err)
	}
	return m.result(map[string]any{"paused": true, "message": "The omnisens correction is paused."}, appendNonEmpty(nil, w)), nil
}

// Resume puts a paused correction back.
func (m *Manager) Resume() (map[string]any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, err := m.Store.Load()
	if err != nil {
		return nil, userErr(http.StatusInternalServerError, "%v", err)
	}
	if st.Applied == nil || !st.Paused {
		return map[string]any{"paused": false, "message": "Nothing to resume."}, nil
	}
	fallback := ""
	if dir := m.findDir(st); dir != "" {
		fallback = filepath.Join(dir, settingsName)
	}
	path := settingsFileOf(st, fallback)
	if path == "" {
		return nil, userErr(http.StatusConflict, "omnisens cannot find Raw Accel's folder to put the correction back.")
	}
	cur, created, err := readSettings(path)
	if err != nil {
		return nil, err
	}
	out, recs, err := ApplySettings(cur, factorsOf(st.Applied))
	if err != nil {
		return nil, settingsUserErr(err)
	}
	run := m.Sys.Driver().Running
	if err := m.commit(filepath.Dir(path), path, cur, created, out, run); err != nil {
		return nil, err
	}
	st.Paused = false
	st.Applied.SettingsFile = path
	st.Applied.Profiles = recs
	if err := m.Store.Save(st); err != nil {
		m.restore(filepath.Dir(path), path, cur, created, run)
		return nil, userErr(http.StatusInternalServerError, "Could not save omnisens' state, so Raw Accel was left as it was: %v", err)
	}
	return m.result(map[string]any{"paused": false, "message": "The omnisens correction is back on."}, nil), nil
}

// result adds the warnings (and the open-window warning) to a response.
func (m *Manager) result(res map[string]any, warnings []string) map[string]any {
	if m.Sys.GUIRunning() {
		warnings = append(warnings, GUIWarning)
	}
	if len(warnings) > 0 {
		res["warning"] = strings.Join(warnings, " ")
	}
	return res
}

// SetRawAccelDir remembers a Raw Accel folder chosen by the user.
func (m *Manager) SetRawAccelDir(input string) (map[string]any, error) {
	dir, err := NormalizeDir(input)
	if err != nil {
		return nil, userErr(http.StatusBadRequest, "%v", err)
	}
	if !IsRawAccelDir(dir) {
		return nil, userErr(http.StatusBadRequest, "%s does not contain Raw Accel's rawaccel.exe and writer.exe. Choose the folder you unzipped Raw Accel into.", dir)
	}
	if err := m.Store.Update(func(st *state.State) error { st.RawAccelDir = dir; return nil }); err != nil {
		return nil, userErr(http.StatusInternalServerError, "Could not save omnisens' state: %v", err)
	}
	return map[string]any{"dir": dir, "message": "omnisens will use Raw Accel in " + dir + "."}, nil
}

// InstallRawAccel downloads and verifies the pinned Raw Accel release into
// InstallDir (or reuses an identical copy there) and starts its installer
// elevated.
func (m *Manager) InstallRawAccel(ctx context.Context) (map[string]any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	dir := m.InstallDir
	if m.Release.VerifyDir(dir) != nil {
		data, err := m.Release.Fetch(ctx, m.HTTP)
		if err != nil {
			return nil, userErr(http.StatusBadGateway, "%v", err)
		}
		if err := ExtractZip(data, m.Release.Root, dir); err != nil {
			return nil, userErr(http.StatusInternalServerError, "Could not unpack Raw Accel: %v", err)
		}
	}
	// Checked right before the installer runs with administrator rights.
	if err := m.Release.VerifyDir(dir); err != nil {
		return nil, userErr(http.StatusInternalServerError, "The Raw Accel files in %s cannot be verified (%v), so the installer was not started.", dir, err)
	}
	if err := m.Store.Update(func(st *state.State) error { st.RawAccelDir = dir; return nil }); err != nil {
		return nil, userErr(http.StatusInternalServerError, "Could not save omnisens' state: %v", err)
	}
	if err := m.Sys.LaunchInstaller(dir); err != nil {
		return nil, userErr(http.StatusInternalServerError, "Windows did not start Raw Accel's installer: %v. If you declined the administrator prompt, press Install Raw Accel again.", err)
	}
	return map[string]any{"dir": dir, "message": installMessage}, nil
}

// SetAutostart adds or removes the apply-at-login entry, which runs
// writer.exe with the folder's settings.json (the profile code is not
// needed on Windows).
func (m *Manager) SetAutostart(enabled bool, _ string) (map[string]any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if enabled {
		st, err := m.Store.Load()
		if err != nil {
			return nil, userErr(http.StatusInternalServerError, "%v", err)
		}
		dir := m.findDir(st)
		if st.Applied != nil && IsRawAccelDir(filepath.Dir(st.Applied.SettingsFile)) {
			dir = filepath.Dir(st.Applied.SettingsFile)
		}
		if dir == "" {
			return nil, userErr(http.StatusConflict, "Install Raw Accel or choose its folder first.")
		}
		if !m.Sys.Driver().Installed {
			return nil, userErr(http.StatusConflict, "Install Raw Accel's driver first; without it the login entry would only show an error.")
		}
		if _, err := os.Stat(filepath.Join(dir, settingsName)); err != nil {
			return nil, userErr(http.StatusConflict, "Apply a profile first, so Raw Accel has settings to load at login.")
		}
		if err := m.Sys.SetAutostart(true, dir); err != nil {
			return nil, userErr(http.StatusInternalServerError, "Could not add the login entry: %v", err)
		}
	} else if err := m.Sys.SetAutostart(false, ""); err != nil {
		return nil, userErr(http.StatusInternalServerError, "Could not remove the login entry: %v", err)
	}
	on, err := m.Sys.Autostart()
	if err != nil {
		return nil, userErr(http.StatusInternalServerError, "Could not read the login entry: %v", err)
	}
	return map[string]any{"autostart": on}, nil
}

// Close runs when the app exits: a correction paused for a calibration that
// never resumed is put back.
func (m *Manager) Close() error {
	st, err := m.Store.Load()
	if err != nil || st.Applied == nil || !st.Paused {
		return err
	}
	_, err = m.Resume()
	return err
}

// undoFile divides the correction back out of one settings.json and reloads
// it when the driver runs (and reload is set).
func (m *Manager) undoFile(path string, a *state.Applied, reload bool) (string, error) {
	if path == "" {
		return "omnisens does not know which settings.json has the correction, so nothing was changed.", nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Sprintf("%s no longer exists, so there was nothing to undo there.", path), nil
	}
	if err != nil {
		return "", userErr(http.StatusInternalServerError, "Could not read %s: %v", path, err)
	}
	out, w, err := RemoveSettings(data, factorsOf(a), a.Profiles)
	if err != nil {
		return "", settingsUserErr(err)
	}
	dir := filepath.Dir(path)
	run := reload && IsRawAccelDir(dir) && m.Sys.Driver().Running
	return w, m.commit(dir, path, data, false, out, run)
}

// commit backs up the original once, writes settings.json atomically and
// loads it with writer.exe; when writer.exe fails the old file is put back.
func (m *Manager) commit(dir, path string, orig []byte, created bool, out []byte, runWriter bool) error {
	if err := ensureBackup(dir, orig); err != nil {
		return userErr(http.StatusInternalServerError, "Could not back up Raw Accel's settings: %v", err)
	}
	if err := state.WriteFileAtomic(path, out, 0o644); err != nil {
		return userErr(http.StatusInternalServerError, "Could not write %s: %v", path, err)
	}
	if !runWriter {
		return nil
	}
	if err := m.Sys.RunWriter(dir, path); err != nil {
		m.restore(dir, path, orig, created, false)
		return userErr(http.StatusInternalServerError, "Raw Accel's writer.exe did not accept the settings (%v); settings.json was put back as it was.", err)
	}
	return nil
}

// restore puts settings.json back after a failure (best effort).
func (m *Manager) restore(dir, path string, orig []byte, created, reload bool) {
	if created {
		os.Remove(path)
		return
	}
	if state.WriteFileAtomic(path, orig, 0o644) == nil && reload {
		m.Sys.RunWriter(dir, path)
	}
}

// ensureBackup copies the original settings.json to
// settings.before-omnisens.json before the very first change and never
// overwrites it. When omnisens created settings.json, orig is Raw Accel's
// default settings, which is what the driver used before.
func ensureBackup(dir string, orig []byte) error {
	f, err := os.OpenFile(filepath.Join(dir, backupName), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if errors.Is(err, fs.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = f.Write(orig)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(f.Name())
	}
	return err
}

// readSettings returns settings.json, or the default settings (created =
// true) when Raw Accel has none yet.
func readSettings(path string) ([]byte, bool, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return DefaultSettings(), true, nil
	}
	if err != nil {
		return nil, false, userErr(http.StatusInternalServerError, "Could not read %s: %v", path, err)
	}
	return b, false, nil
}

// settingsFileOf is the settings.json that carries the correction ("" if
// none is known).
func settingsFileOf(st state.State, fallback string) string {
	switch {
	case st.Applied != nil && filepath.IsAbs(st.Applied.SettingsFile):
		return st.Applied.SettingsFile
	case filepath.IsAbs(fallback):
		return fallback
	case filepath.IsAbs(st.RawAccelDir):
		return filepath.Join(st.RawAccelDir, settingsName)
	}
	return ""
}

func settingsUserErr(err error) error {
	var se *SettingsError
	if errors.As(err, &se) {
		return userErr(http.StatusConflict, "%v. Fix it in Raw Accel (or restore %s) and try again.", err, backupName)
	}
	return userErr(http.StatusBadRequest, "%v", err)
}

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func appendNonEmpty(list []string, s string) []string {
	if s != "" {
		list = append(list, s)
	}
	return list
}
