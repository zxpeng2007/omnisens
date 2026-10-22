//go:build windows

package rawaccel

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zxpeng2007/omnisens/desktop/internal/state"
)

// fakeWriter returns testdata/fakewriter built for Windows: from
// OMNISENS_FAKEWRITER (a prebuilt .exe, for running a cross-compiled test
// binary on a PC without Go) or built here with the go tool.
func fakeWriter(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("OMNISENS_FAKEWRITER"); p != "" {
		return p
	}
	goTool, err := exec.LookPath("go")
	if err != nil {
		t.Skip("set OMNISENS_FAKEWRITER to a fakewriter.exe built with GOOS=windows")
	}
	out := filepath.Join(t.TempDir(), "fakewriter.exe")
	if b, err := exec.Command(goTool, "build", "-o", out, "./testdata/fakewriter").CombinedOutput(); err != nil {
		t.Fatalf("building fakewriter: %v\n%s", err, b)
	}
	return out
}

// rawAccelFolder is a scratch Raw Accel folder: the fake writer as
// writer.exe and an empty rawaccel.exe.
func rawAccelFolder(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "Raw Accel")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	src, err := os.Open(fakeWriter(t))
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	dst, err := os.Create(filepath.Join(dir, "writer.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		t.Fatal(err)
	}
	dst.Close()
	if err := os.WriteFile(filepath.Join(dir, "rawaccel.exe"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func writerCalls(t *testing.T, dir string) [][]string {
	t.Helper()
	f, err := os.Open(filepath.Join(dir, "fakewriter-args.txt"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var calls [][]string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var args []string
		if err := json.Unmarshal(sc.Bytes(), &args); err != nil {
			t.Fatal(err)
		}
		calls = append(calls, args)
	}
	return calls
}

func TestWindowsRunWriter(t *testing.T) {
	dir := rawAccelFolder(t)
	sys := NewSystem()
	path := filepath.Join(dir, "settings.json")
	os.WriteFile(path, DefaultSettings(), 0o644)
	if err := sys.RunWriter(dir, path); err != nil {
		t.Fatal(err)
	}
	bad := strings.Replace(string(DefaultSettings()), `"L/R output DPI ratio (left sens multiplier)": 1`, `"L/R output DPI ratio (left sens multiplier)": 0`, 1)
	os.WriteFile(path, []byte(bad), 0o644)
	if err := sys.RunWriter(dir, path); err == nil || !strings.Contains(err.Error(), "ratio must be positive") {
		t.Fatalf("invalid settings: %v", err)
	}
	calls := writerCalls(t, dir)
	if len(calls) != 2 || len(calls[0]) != 1 || calls[0][0] != path {
		t.Fatalf("writer calls %q", calls)
	}
}

// The Run entry value contains quotes; reg.exe must receive it unchanged.
// Go quotes arguments the way the Microsoft C runtime parses them, which
// the fake writer (a Go program) reports back.
func TestWindowsRegArgsRoundTrip(t *testing.T) {
	dir := rawAccelFolder(t)
	cmdline := AutostartCommand(filepath.Join(dir, "writer.exe"), filepath.Join(dir, "settings.json"))
	args := RegAddArgs(cmdline)
	exec.Command(filepath.Join(dir, "writer.exe"), args...).Run() // fails validation, records its arguments
	calls := writerCalls(t, dir)
	if len(calls) != 1 || strings.Join(calls[0], "\x00") != strings.Join(args, "\x00") {
		t.Fatalf("arguments changed on the way: %q", calls)
	}
}

func TestWindowsManagerWithFakeWriter(t *testing.T) {
	dir := rawAccelFolder(t)
	sys := NewSystem()
	if !sys.VCRuntime() {
		t.Skip("the Visual C++ runtime is not installed on this PC")
	}
	t.Setenv(DevAssumeDriverEnv, "running")
	if st := sys.Driver(); !st.Installed || !st.Running {
		t.Fatalf("dev override: %+v", st)
	}
	store := state.NewStore(filepath.Join(t.TempDir(), "state"))
	m := NewManager(store, sys)
	m.Candidates = func() []string { return []string{dir} }
	path := filepath.Join(dir, "settings.json")

	res, err := m.Apply(codeA)
	if err != nil {
		t.Fatal(err)
	}
	if res["fit"] == nil {
		t.Fatalf("result %v", res)
	}
	b, _ := os.ReadFile(path)
	if err := CheckSettings(b); err != nil || !strings.Contains(string(b), "Output DPI") {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, backupName)); err != nil {
		t.Fatal("no backup")
	}
	applied := string(b)

	t.Setenv("FAKEWRITER_FAIL", "1")
	if _, err := m.Apply(codeB); err == nil || !strings.Contains(err.Error(), "asked to fail") {
		t.Fatalf("failing writer: %v", err)
	}
	if b, _ := os.ReadFile(path); string(b) != applied {
		t.Fatal("settings.json not rolled back after writer.exe failed")
	}
	t.Setenv("FAKEWRITER_FAIL", "")

	if _, err := m.Remove(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); string(b) != string(DefaultSettings()) {
		t.Fatalf("after remove:\n%s", b)
	}
	calls := writerCalls(t, dir)
	if len(calls) != 3 {
		t.Fatalf("writer calls %q", calls)
	}
	for _, c := range calls {
		if len(c) != 1 || c[0] != path {
			t.Fatalf("writer called with %q", c)
		}
	}
}

// Read-only probes of the real system: they must work (no driver, no Raw
// Accel window and no login entry are expected on a development PC, but
// the result is only logged).
func TestWindowsProbes(t *testing.T) {
	sys := NewSystem()
	t.Setenv(DevAssumeDriverEnv, "")
	t.Logf("driver %+v, vc runtime %v, gui %v", sys.Driver(), sys.VCRuntime(), sys.GUIRunning())
	on, err := sys.Autostart()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("autostart %v", on)
	if d := systemDir(); !strings.HasSuffix(strings.ToLower(d), `\system32`) {
		t.Fatalf("system dir %q", d)
	}
}
