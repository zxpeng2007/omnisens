package rawaccel

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
	"github.com/zxpeng2007/omnisens/desktop/internal/state"
)

type fakeSystem struct {
	drv          DriverStatus
	vc, gui      bool
	writerErr    error
	writes       []string
	installer    []string
	installerErr error
	auto         bool
	autoDir      string
}

func (f *fakeSystem) Driver() DriverStatus { return f.drv }
func (f *fakeSystem) VCRuntime() bool      { return f.vc }
func (f *fakeSystem) GUIRunning() bool     { return f.gui }

// RunWriter checks the file like writer.exe would.
func (f *fakeSystem) RunWriter(dir, path string) error {
	f.writes = append(f.writes, path)
	if f.writerErr != nil {
		return f.writerErr
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return CheckSettings(b)
}

func (f *fakeSystem) LaunchInstaller(dir string) error {
	f.installer = append(f.installer, dir)
	return f.installerErr
}
func (f *fakeSystem) Autostart() (bool, error) { return f.auto, nil }
func (f *fakeSystem) SetAutostart(on bool, dir string) error {
	f.auto, f.autoDir = on, dir
	return nil
}

type harness struct {
	m     *Manager
	sys   *fakeSystem
	dir   string // the Raw Accel folder
	store *state.Store
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "Raw Accel v1.7")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"writer.exe", "rawaccel.exe"} {
		if err := os.WriteFile(filepath.Join(dir, f), nil, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	sys := &fakeSystem{drv: DriverStatus{Installed: true, Running: true}, vc: true}
	store := state.NewStore(filepath.Join(root, "state"))
	m := NewManager(store, sys)
	m.Candidates = func() []string { return []string{filepath.Join(root, "missing"), dir} }
	m.Now = func() time.Time { return time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC) }
	return &harness{m: m, sys: sys, dir: dir, store: store}
}

func (h *harness) settings() string { return filepath.Join(h.dir, "settings.json") }

func (h *harness) read(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(h.dir, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func profileCode(gains ...float64) string {
	return omnicore.EncodeProfileCode(omnicore.ConfigFromGains(gains, false))
}

var (
	codeA = profileCode(0.93, 0.95, 1.05, 1.03, 1.07, 1, 0.98, 0.95)
	codeB = profileCode(1.1, 1, 0.9, 1, 1.1, 1, 0.9, 1)
)

func statusOf(err error) int {
	var e *Error
	if errors.As(err, &e) {
		return e.Status
	}
	return 0
}

func TestApplyPreconditions(t *testing.T) {
	h := newHarness(t)
	if _, err := h.m.Apply("nonsense"); statusOf(err) != http.StatusBadRequest {
		t.Fatalf("bad code: %v", err)
	}
	off := omnicore.DefaultConfig()
	off.Flags = 0
	if _, err := h.m.Apply(omnicore.EncodeProfileCode(off)); statusOf(err) != http.StatusBadRequest {
		t.Fatalf("disabled profile: %v", err)
	}
	h.sys.vc = false
	if _, err := h.m.Apply(codeA); statusOf(err) != http.StatusConflict || !strings.Contains(err.Error(), "vc_redist") {
		t.Fatalf("no runtime: %v", err)
	}
	h.sys.drv.Running = false
	if _, err := h.m.Apply(codeA); statusOf(err) != http.StatusConflict || !strings.Contains(err.Error(), "Restart") {
		t.Fatalf("not running: %v", err)
	}
	h.sys.drv.Installed = false
	if _, err := h.m.Apply(codeA); statusOf(err) != http.StatusConflict || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("not installed: %v", err)
	}
	h.m.Candidates = func() []string { return nil }
	if _, err := h.m.Apply(codeA); statusOf(err) != http.StatusConflict || !strings.Contains(err.Error(), "cannot find Raw Accel") {
		t.Fatalf("no folder: %v", err)
	}
	if len(h.sys.writes) != 0 {
		t.Fatal("writer.exe ran although a precondition failed")
	}
	if _, err := os.Stat(h.settings()); err == nil {
		t.Fatal("settings.json written although a precondition failed")
	}
}

func TestApplyCycle(t *testing.T) {
	h := newHarness(t)
	if err := os.WriteFile(h.settings(), []byte(userSettings), 0o644); err != nil {
		t.Fatal(err)
	}
	orig := reencode(t, []byte(userSettings))

	res, err := h.m.Apply(codeA)
	if err != nil {
		t.Fatal(err)
	}
	fA, fitA := FactorsFor(mustDecode(t, codeA))
	wantA, _, _ := ApplySettings([]byte(userSettings), fA)
	if got := h.read(t, "settings.json"); got != string(wantA) {
		t.Fatalf("applied settings differ:\n%s", got)
	}
	if fit, ok := res["fit"].(FitInfo); !ok || fit.Right != fitA.Right || fit.MaxSkewDeg != fitA.MaxSkewDeg {
		t.Fatalf("fit %#v", res["fit"])
	}
	if res["warning"] != nil || !strings.Contains(res["message"].(string), "2 profiles") {
		t.Fatalf("result %v", res)
	}
	if len(h.sys.writes) != 1 || h.sys.writes[0] != h.settings() {
		t.Fatalf("writer runs %v", h.sys.writes)
	}
	if b := h.read(t, backupName); b != userSettings {
		t.Fatal("backup is not the original file")
	}
	info := h.m.Status()
	if !info.Found || info.Dir != h.dir || !info.SettingsFound || info.Applied == nil || info.Applied.Code != codeA ||
		info.Paused || info.Applied.Right != fA.Right || !info.Applied.At.Equal(h.m.Now()) || info.Download.SHA256 != Official.SHA256 {
		t.Fatalf("info %+v", info)
	}

	// Applying another profile replaces the factors instead of compounding.
	if _, err := h.m.Apply(codeB); err != nil {
		t.Fatal(err)
	}
	fB, _ := FactorsFor(mustDecode(t, codeB))
	wantB, _, _ := ApplySettings([]byte(userSettings), fB)
	if got := h.read(t, "settings.json"); got != string(wantB) {
		t.Fatalf("re-applied settings compounded:\n%s", got)
	}
	if b := h.read(t, backupName); b != userSettings {
		t.Fatal("backup was overwritten")
	}

	// Pause restores the user's own settings but remembers the profile.
	res, err = h.m.Pause()
	if err != nil || res["paused"] != true {
		t.Fatal(res, err)
	}
	if got := h.read(t, "settings.json"); got != orig {
		t.Fatalf("paused settings:\n%s", got)
	}
	if info := h.m.Status(); !info.Paused || info.Applied == nil || info.Applied.Code != codeB {
		t.Fatalf("paused info %+v", info)
	}
	if res, _ := h.m.Pause(); res["paused"] != true {
		t.Fatal("second pause")
	}
	if _, err := h.m.Resume(); err != nil {
		t.Fatal(err)
	}
	if got := h.read(t, "settings.json"); got != string(wantB) {
		t.Fatalf("resumed settings:\n%s", got)
	}

	// Remove puts everything back and forgets the profile.
	if _, err := h.m.Remove(); err != nil {
		t.Fatal(err)
	}
	if got := h.read(t, "settings.json"); got != orig {
		t.Fatalf("removed settings:\n%s", got)
	}
	st, _ := h.store.Load()
	if st.Applied != nil || st.Paused || st.LastCode != codeB || st.RawAccelDir != h.dir {
		t.Fatalf("state %+v", st)
	}
	if res, err := h.m.Remove(); err != nil || !strings.Contains(res["message"].(string), "No omnisens correction") {
		t.Fatal(res, err)
	}
	if n := len(h.sys.writes); n != 5 {
		t.Fatalf("writer ran %d times, want 5", n)
	}
}

func mustDecode(t *testing.T, code string) omnicore.Config {
	t.Helper()
	cfg, err := omnicore.DecodeProfileCode(code)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestApplyCreatesSettingsAndWarnsAboutGUI(t *testing.T) {
	h := newHarness(t)
	h.sys.gui = true
	res, err := h.m.Apply(codeA)
	if err != nil {
		t.Fatal(err)
	}
	if res["warning"] != GUIWarning {
		t.Fatalf("warning %v", res["warning"])
	}
	if b := h.read(t, backupName); b != string(DefaultSettings()) {
		t.Fatal("backup of a created file is not Raw Accel's defaults")
	}
	if err := CheckSettings([]byte(h.read(t, "settings.json"))); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.Remove(); err != nil {
		t.Fatal(err)
	}
	if got := h.read(t, "settings.json"); got != string(DefaultSettings()) {
		t.Fatalf("after remove:\n%s", got)
	}
}

// When settings.json disappeared after an apply, the next apply starts from
// Raw Accel's defaults: the old factors were never in that file.
func TestApplyAfterSettingsDeleted(t *testing.T) {
	h := newHarness(t)
	os.WriteFile(h.settings(), []byte(userSettings), 0o644)
	if _, err := h.m.Apply(codeA); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(h.settings()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.Apply(codeB); err != nil {
		t.Fatal(err)
	}
	fB, _ := FactorsFor(mustDecode(t, codeB))
	want, _, _ := ApplySettings(DefaultSettings(), fB)
	if got := h.read(t, "settings.json"); got != string(want) {
		t.Fatalf("defaults with the old correction divided out:\n%s", got)
	}
	if _, err := h.m.Remove(); err != nil {
		t.Fatal(err)
	}
	if got := h.read(t, "settings.json"); got != string(DefaultSettings()) {
		t.Fatalf("after remove:\n%s", got)
	}
}

func TestWriterFailureRollsBack(t *testing.T) {
	h := newHarness(t)
	os.WriteFile(h.settings(), []byte(userSettings), 0o644)
	h.sys.writerErr = errors.New("exit code 1")
	if _, err := h.m.Apply(codeA); err == nil || !strings.Contains(err.Error(), "put back") {
		t.Fatalf("apply: %v", err)
	}
	if got := h.read(t, "settings.json"); got != userSettings {
		t.Fatal("settings.json not restored")
	}
	if st, _ := h.store.Load(); st.Applied != nil {
		t.Fatal("state records a failed apply")
	}

	// A created settings.json is deleted again.
	h2 := newHarness(t)
	h2.sys.writerErr = errors.New("exit code 1")
	if _, err := h2.m.Apply(codeA); err == nil {
		t.Fatal("apply succeeded")
	}
	if _, err := os.Stat(h2.settings()); err == nil {
		t.Fatal("created settings.json left behind")
	}

	// Invalid settings are refused before anything is written.
	h3 := newHarness(t)
	bad := strings.Replace(userSettings, `"L/R output DPI ratio (left sens multiplier)": 0.9`, `"L/R output DPI ratio (left sens multiplier)": 0`, 1)
	os.WriteFile(h3.settings(), []byte(bad), 0o644)
	if _, err := h3.m.Apply(codeA); statusOf(err) != http.StatusConflict {
		t.Fatalf("invalid settings: %v", err)
	}
	if got := h3.read(t, "settings.json"); got != bad || len(h3.sys.writes) != 0 {
		t.Fatal("invalid settings were touched")
	}
	if _, err := os.Stat(filepath.Join(h3.dir, backupName)); err == nil {
		t.Fatal("backup written for a refused apply")
	}
}

func TestPauseWithoutDriverAndClose(t *testing.T) {
	h := newHarness(t)
	os.WriteFile(h.settings(), []byte(userSettings), 0o644)
	if _, err := h.m.Apply(codeA); err != nil {
		t.Fatal(err)
	}
	h.sys.drv.Running = false
	if _, err := h.m.Pause(); err != nil {
		t.Fatal(err)
	}
	if len(h.sys.writes) != 1 {
		t.Fatal("writer.exe ran without a running driver")
	}
	h.sys.drv.Running = true
	if err := h.m.Close(); err != nil {
		t.Fatal(err)
	}
	if st, _ := h.store.Load(); st.Paused || st.Applied == nil {
		t.Fatalf("close did not resume: %+v", st)
	}
	fA, _ := FactorsFor(mustDecode(t, codeA))
	want, _, _ := ApplySettings([]byte(userSettings), fA)
	if got := h.read(t, "settings.json"); got != string(want) {
		t.Fatal("resumed settings differ")
	}
	if res, err := h.m.Resume(); err != nil || res["paused"] != false {
		t.Fatal(res, err)
	}
}

func TestApplyMovesBetweenFolders(t *testing.T) {
	h := newHarness(t)
	os.WriteFile(h.settings(), []byte(userSettings), 0o644)
	if _, err := h.m.Apply(codeA); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "RawAccel")
	os.MkdirAll(other, 0o755)
	for _, f := range []string{"writer.exe", "rawaccel.exe"} {
		os.WriteFile(filepath.Join(other, f), nil, 0o755)
	}
	if _, err := h.m.SetRawAccelDir(`"` + filepath.Join(other, "rawaccel.exe") + `"`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.Apply(codeB); err != nil {
		t.Fatal(err)
	}
	if got := h.read(t, "settings.json"); got != reencode(t, []byte(userSettings)) {
		t.Fatal("the old folder still has the correction")
	}
	st, _ := h.store.Load()
	if st.RawAccelDir != other || st.Applied.SettingsFile != filepath.Join(other, "settings.json") {
		t.Fatalf("state %+v", st)
	}
}

func TestSetRawAccelDir(t *testing.T) {
	h := newHarness(t)
	for _, bad := range []string{"", "   ", "relative/RawAccel", t.TempDir()} {
		if _, err := h.m.SetRawAccelDir(bad); statusOf(err) != http.StatusBadRequest {
			t.Errorf("%q: %v", bad, err)
		}
	}
	for _, in := range []string{h.dir, " '" + h.dir + "' ", filepath.Join(h.dir, "writer.exe"), filepath.Join(h.dir, "settings.json")} {
		res, err := h.m.SetRawAccelDir(in)
		if err != nil || res["dir"] != h.dir {
			t.Errorf("%q: %v %v", in, res, err)
		}
	}
	h.m.Candidates = nil
	if info := h.m.Status(); info.Dir != h.dir {
		t.Fatalf("remembered folder not used: %+v", info)
	}
}

func TestInstall(t *testing.T) {
	h := newHarness(t)
	data, rel := fakeRelease(t)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Write(data)
	}))
	defer srv.Close()
	rel.URL = srv.URL
	h.m.Release = rel
	h.m.HTTP = srv.Client()
	h.m.InstallDir = filepath.Join(t.TempDir(), "omnisens", "RawAccel")

	res, err := h.m.InstallRawAccel(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res["dir"] != h.m.InstallDir || res["message"] != installMessage || len(h.sys.installer) != 1 || h.sys.installer[0] != h.m.InstallDir {
		t.Fatalf("install: %v %v", res, h.sys.installer)
	}
	if st, _ := h.store.Load(); st.RawAccelDir != h.m.InstallDir {
		t.Fatal("install folder not remembered")
	}
	if info := h.m.Status(); info.Dir != h.m.InstallDir {
		t.Fatalf("info dir %q", info.Dir)
	}

	// An identical folder is reused without downloading.
	if _, err := h.m.InstallRawAccel(context.Background()); err != nil || hits.Load() != 1 {
		t.Fatalf("reuse: %v, %d downloads", err, hits.Load())
	}
	// A modified one is downloaded and unpacked again.
	os.WriteFile(filepath.Join(h.m.InstallDir, "installer.exe"), []byte("evil"), 0o644)
	if _, err := h.m.InstallRawAccel(context.Background()); err != nil || hits.Load() != 2 {
		t.Fatalf("repair: %v, %d downloads", err, hits.Load())
	}

	// A download that does not match the pinned hash is never run.
	h2 := newHarness(t)
	rel2 := rel
	rel2.SHA256 = strings.Repeat("0", 64)
	h2.m.Release, h2.m.HTTP = rel2, srv.Client()
	h2.m.InstallDir = filepath.Join(t.TempDir(), "RawAccel")
	if _, err := h2.m.InstallRawAccel(context.Background()); statusOf(err) != http.StatusBadGateway || len(h2.sys.installer) != 0 {
		t.Fatalf("bad hash: %v %v", err, h2.sys.installer)
	}
	if _, err := os.Stat(h2.m.InstallDir); err == nil {
		t.Fatal("unverified download was unpacked")
	}
	// Declining the UAC prompt is reported.
	h.sys.installerErr = errors.New("the administrator prompt was declined")
	if _, err := h.m.InstallRawAccel(context.Background()); err == nil || !strings.Contains(err.Error(), "declined") {
		t.Fatalf("declined: %v", err)
	}
}

func TestAutostart(t *testing.T) {
	h := newHarness(t)
	if _, err := h.m.SetAutostart(true, ""); statusOf(err) != http.StatusConflict {
		t.Fatalf("without settings: %v", err)
	}
	os.WriteFile(h.settings(), []byte(userSettings), 0o644)
	h.sys.drv.Installed = false
	if _, err := h.m.SetAutostart(true, ""); statusOf(err) != http.StatusConflict {
		t.Fatalf("without driver: %v", err)
	}
	h.sys.drv.Installed = true
	res, err := h.m.SetAutostart(true, "")
	if err != nil || res["autostart"] != true || h.sys.autoDir != h.dir {
		t.Fatalf("enable: %v %v %q", res, err, h.sys.autoDir)
	}
	if !h.m.Status().Autostart {
		t.Fatal("status")
	}
	res, err = h.m.SetAutostart(false, "")
	if err != nil || res["autostart"] != false {
		t.Fatalf("disable: %v %v", res, err)
	}
	h.m.Candidates = func() []string { return nil }
	if _, err := h.m.SetAutostart(true, ""); statusOf(err) != http.StatusConflict {
		t.Fatalf("no folder: %v", err)
	}
}

func TestParsers(t *testing.T) {
	running := "\r\nSERVICE_NAME: rawaccel \r\n        TYPE               : 1  KERNEL_DRIVER  \r\n        STATE              : 4  RUNNING \r\n                                (STOPPABLE, NOT_PAUSABLE, IGNORES_SHUTDOWN)\r\n"
	stopped := strings.Replace(running, "4  RUNNING", "1  STOPPED", 1)
	if st := ParseSCQuery(running, 0); !st.Installed || !st.Running {
		t.Fatalf("running: %+v", st)
	}
	if st := ParseSCQuery(stopped, 0); !st.Installed || st.Running {
		t.Fatalf("stopped: %+v", st)
	}
	if st := ParseSCQuery("[SC] EnumQueryServicesStatus:OpenService FAILED 1060:", 1060); st.Installed || st.Running {
		t.Fatalf("missing: %+v", st)
	}
	if !ParseTasklist(`"rawaccel.exe","4242","Console","1","45,000 K"`+"\r\n") || !ParseTasklist(`"RawAccel.exe","1","Console","1","1 K"`) {
		t.Fatal("tasklist row not found")
	}
	if ParseTasklist("INFO: No tasks are running which match the specified criteria.\r\n") || ParseTasklist(`"rawaccel.exe.bak","1"`) {
		t.Fatal("tasklist false positive")
	}
	cmd := AutostartCommand(`C:\Users\A B\RawAccel\writer.exe`, `C:\Users\A B\RawAccel\settings.json`)
	if cmd != `"C:\Users\A B\RawAccel\writer.exe" "C:\Users\A B\RawAccel\settings.json"` {
		t.Fatal(cmd)
	}
	args := RegAddArgs(cmd)
	want := []string{"add", `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "/v", "omnisens Raw Accel", "/t", "REG_SZ", "/d", cmd, "/f"}
	if strings.Join(args, "|") != strings.Join(want, "|") {
		t.Fatalf("reg args %q", args)
	}
}

func TestCandidateDirs(t *testing.T) {
	home := t.TempDir()
	env := map[string]string{
		"LOCALAPPDATA": filepath.Join(home, "AppData", "Local"),
		"USERPROFILE":  home,
	}
	unzipped := filepath.Join(home, "Downloads", "RawAccel_v1.7.1", "RawAccel")
	os.MkdirAll(unzipped, 0o755)
	dirs := CandidateDirs(func(k string) string { return env[k] }, filepath.Join(home, "bin"))
	if dirs[0] != filepath.Join(env["LOCALAPPDATA"], "omnisens", "RawAccel") {
		t.Fatalf("first candidate %q", dirs[0])
	}
	found := false
	seen := map[string]bool{}
	for _, d := range dirs {
		if seen[d] {
			t.Fatalf("duplicate %q", d)
		}
		seen[d] = true
		found = found || d == unzipped
	}
	if !found {
		t.Fatalf("unzipped folder not a candidate: %v", dirs)
	}
}
