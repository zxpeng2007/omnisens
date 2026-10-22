//go:build linux

package linuxengine

import (
	"bytes"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
)

func TestIoctlNumbers(t *testing.T) {
	// Expected values were printed by a C program from the kernel headers.
	for _, c := range []struct {
		name      string
		got, want uintptr
	}{
		{"EVIOCGRAB", evIOCGrab, 0x40044590},
		{"EVIOCGRAB formula", ioc(iocWrite, 'E', 0x90, 4), 0x40044590},
		{"EVIOCGID", evIOCGID, 0x80084502},
		{"EVIOCGID formula", ioc(iocRead, 'E', 0x02, unsafe.Sizeof(inputID{})), 0x80084502},
		{"EVIOCSCLOCKID", evIOCSClockID, 0x400445a0},
		{"EVIOCSCLOCKID formula", ioc(iocWrite, 'E', 0xa0, 4), 0x400445a0},
		{"EVIOCGNAME(256)", evIOCGName(256), 0x81004506},
		{"EVIOCGPROP(8)", evIOCGProp(8), 0x80084509},
		{"UI_SET_PROPBIT", uiSetPropBit, 0x4004556e},
		{"UI_SET_PROPBIT formula", ioc(iocWrite, 'U', 110, 4), 0x4004556e},
		{"EVIOCGKEY(96)", evIOCGKey(96), 0x80604518},
		{"EVIOCGBIT(0,4)", evIOCGBit(0, 4), 0x80044520},
		{"EVIOCGBIT(EV_KEY,96)", evIOCGBit(evKey, 96), 0x80604521},
		{"EVIOCGBIT(EV_REL,2)", evIOCGBit(evRel, 2), 0x80024522},
		{"EVIOCGBIT(EV_ABS,8)", evIOCGBit(evAbs, 8), 0x80084523},
		{"EVIOCGBIT(EV_MSC,1)", evIOCGBit(evMsc, 1), 0x80014524},
		{"UI_SET_EVBIT", uiSetEvBit, 0x40045564},
		{"UI_SET_EVBIT formula", ioc(iocWrite, 'U', 100, 4), 0x40045564},
		{"UI_SET_KEYBIT", uiSetKeyBit, ioc(iocWrite, 'U', 101, 4)},
		{"UI_SET_RELBIT", uiSetRelBit, ioc(iocWrite, 'U', 102, 4)},
		{"UI_SET_MSCBIT", uiSetMscBit, ioc(iocWrite, 'U', 104, 4)},
		{"UI_DEV_SETUP", uiDevSetup, 0x405c5503},
		{"UI_DEV_SETUP formula", ioc(iocWrite, 'U', 3, unsafe.Sizeof(uinputSetup{})), 0x405c5503},
		{"UI_DEV_CREATE", uiDevCreate, ioc(0, 'U', 1, 0)},
		{"UI_DEV_DESTROY", uiDevDestroy, ioc(0, 'U', 2, 0)},
	} {
		if c.got != c.want {
			t.Errorf("%s = %#x, want %#x", c.name, c.got, c.want)
		}
	}
	if s := unsafe.Sizeof(uinputSetup{}); s != 92 {
		t.Errorf("struct uinput_setup is %d bytes, want 92", s)
	}
	if o := unsafe.Offsetof(uinputSetup{}.FFEffectsMax); o != 88 {
		t.Errorf("ff_effects_max at offset %d, want 88", o)
	}
}

func TestStatusWhenStopped(t *testing.T) {
	if err := Stop(); err != nil {
		t.Fatal(err)
	}
	st := CurrentStatus()
	if !st.Supported || st.Running || st.Devices == nil || len(st.Devices) != 0 || st.Code != "" {
		t.Fatalf("%+v", st)
	}
	SetPaused(true)
	if CurrentStatus().Paused {
		t.Fatal("there is nothing to pause while stopped")
	}
}

func TestStartWithoutUinput(t *testing.T) {
	saved := uinputPaths
	defer func() { uinputPaths = saved }()

	uinputPaths = []string{filepath.Join(t.TempDir(), "missing")}
	if err := Start(omnicore.DefaultConfig()); err == nil || !strings.Contains(err.Error(), "modprobe uinput") {
		Stop()
		t.Fatalf("missing uinput: %v", err)
	}
	uinputPaths = []string{t.TempDir()} // a directory cannot be opened for writing
	if err := Start(omnicore.DefaultConfig()); err == nil || !strings.Contains(err.Error(), "linux-setup --install") {
		Stop()
		t.Fatalf("unusable uinput: %v", err)
	}
	if CurrentStatus().Running {
		t.Fatal("a failed Start must not leave the engine running")
	}
}

func TestDesktopExec(t *testing.T) {
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"/usr/bin/omnisens", "apply", "omni1.AQMI"}, `/usr/bin/omnisens apply omni1.AQMI`},
		{[]string{"/home/a b/omnisens", "apply"}, `"/home/a b/omnisens" apply`},
		{[]string{`/opt/x"y$z` + "`" + `/omnisens`}, `"/opt/x\\"y\\$z\\` + "`" + `/omnisens"`},
		{[]string{`/opt/back\slash/omnisens`}, `"/opt/back\\\\slash/omnisens"`},
		{[]string{"/opt/100%/omnisens"}, `/opt/100%%/omnisens`},
		{[]string{""}, `""`},
	} {
		got, err := desktopExec(c.args...)
		if err != nil || got != c.want {
			t.Errorf("desktopExec(%q) = %s, %v; want %s", c.args, got, err, c.want)
		}
	}
	if _, err := desktopExec("/tmp/new\nline"); err == nil {
		t.Error("a newline must be rejected")
	}
}

func TestShellQuote(t *testing.T) {
	for in, want := range map[string]string{
		"/usr/local/bin/omnisens": "/usr/local/bin/omnisens",
		"/home/me/My Apps/omni":   "'/home/me/My Apps/omni'",
		"/tmp/it's":               `'/tmp/it'\''s'`,
		"":                        "''",
	} {
		if got := shellQuote(in); got != want {
			t.Errorf("shellQuote(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestAutostart(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("APPIMAGE", "/home/me/Apps/omnisens x86_64.AppImage")
	file := filepath.Join(dir, "autostart", "omnisens.desktop")

	if AutostartEnabled() {
		t.Fatal("enabled before anything was written")
	}
	if err := SetAutostart(true, "not a code"); err == nil {
		t.Fatal("an invalid profile code must be rejected")
	}
	code := omnicore.EncodeProfileCode(omnicore.ConfigFromGains([]float64{1.2, 1, 1, 1, 0.8, 1, 1, 1}, false))
	if err := SetAutostart(true, "  "+code+"\n"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	want := `Exec="/home/me/Apps/omnisens x86_64.AppImage" apply ` + code + "\n"
	if !strings.Contains(string(b), want) || !strings.HasPrefix(string(b), "[Desktop Entry]\n") {
		t.Fatalf("entry:\n%s\nwant a line %q", b, want)
	}
	if !AutostartEnabled() {
		t.Fatal("not reported as enabled")
	}
	for _, off := range []string{"Hidden=true\n", "Hidden = true\n", "X-GNOME-Autostart-enabled=false\n"} {
		if err := os.WriteFile(file, append(b, off...), 0o644); err != nil {
			t.Fatal(err)
		}
		if AutostartEnabled() {
			t.Fatalf("%q means the desktop switched it off", off)
		}
	}
	if err := SetAutostart(false, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("entry still there: %v", err)
	}
	if err := SetAutostart(false, ""); err != nil {
		t.Fatalf("disabling twice: %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(file)); len(entries) != 0 {
		t.Fatalf("left files behind: %v", entries)
	}
}

func TestInstallSetup(t *testing.T) {
	dir := t.TempDir()
	rule0, sysfs0, dev0, out0, euid0, lookup0, run0 := udevRulePath, uinputSysfs, uinputDev, setupOut, geteuid, lookupGroup, runCommand
	t.Cleanup(func() {
		udevRulePath, uinputSysfs, uinputDev, setupOut, geteuid, lookupGroup, runCommand = rule0, sysfs0, dev0, out0, euid0, lookup0, run0
	})
	udevRulePath = filepath.Join(dir, "70-omnisens-uinput.rules")
	uinputSysfs = dir
	// A stand-in for /dev/uinput that already has the rule's group and mode.
	uinputDev = filepath.Join(dir, "uinput")
	if err := os.WriteFile(uinputDev, nil, 0o660); err != nil {
		t.Fatal(err)
	}
	os.Chmod(uinputDev, 0o660)
	fi, err := os.Stat(uinputDev)
	if err != nil {
		t.Fatal(err)
	}
	gid := strconv.FormatUint(uint64(fi.Sys().(*syscall.Stat_t).Gid), 10)
	var out bytes.Buffer
	setupOut = &out
	var cmds []string
	groupExists := true
	runCommand = func(name string, args ...string) error {
		cmds = append(cmds, strings.Join(append([]string{name}, args...), " "))
		if name == "groupadd" {
			groupExists = true
		}
		return nil
	}
	lookupGroup = func(name string) (*user.Group, error) {
		if !groupExists {
			return nil, user.UnknownGroupError(name)
		}
		return &user.Group{Gid: gid, Name: name}, nil
	}

	geteuid = func() int { return 1000 }
	if err := InstallSetup(); err == nil || !strings.Contains(err.Error(), "sudo") {
		t.Fatalf("as a normal user: %v", err)
	}
	if len(cmds) != 0 {
		t.Fatalf("ran %v without root", cmds)
	}

	geteuid = func() int { return 0 }
	t.Setenv("SUDO_USER", "alice")
	if err := InstallSetup(); err != nil {
		t.Fatal(err)
	}
	rule, err := os.ReadFile(udevRulePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(rule), "\n"+udevRuleLine+"\n") {
		t.Fatalf("rule file:\n%s", rule)
	}
	if fi, _ := os.Stat(udevRulePath); fi.Mode().Perm() != 0o644 {
		t.Fatalf("rule file mode %v", fi.Mode())
	}
	wantCmds := []string{
		"udevadm control --reload-rules",
		"udevadm trigger --subsystem-match=misc --sysname-match=uinput",
		"udevadm settle --timeout=10",
		"usermod -aG input alice",
	}
	if strings.Join(cmds, "|") != strings.Join(wantCmds, "|") {
		t.Fatalf("commands %q, want %q", cmds, wantCmds)
	}
	for _, want := range []string{"now belongs to the input group", "Added alice", "Log out and back in"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("output lacks %q:\n%s", want, out.String())
		}
	}

	cmds = nil
	out.Reset()
	groupExists = false
	uinputSysfs = filepath.Join(dir, "missing")
	os.Chmod(uinputDev, 0o600)
	t.Setenv("SUDO_USER", "")
	if err := InstallSetup(); err != nil {
		t.Fatal(err)
	}
	if cmds[0] != "groupadd --system input" || cmds[1] != "modprobe uinput" || len(cmds) != 5 {
		t.Fatalf("commands %q", cmds)
	}
	if !strings.Contains(out.String(), "after a restart") || !strings.Contains(out.String(), "Nobody was added") {
		t.Fatalf("output:\n%s", out.String())
	}

	t.Setenv("SUDO_USER", "-oops")
	if err := InstallSetup(); err == nil {
		t.Fatal("a SUDO_USER that looks like an option must be refused")
	}
}

func TestSetupInstructions(t *testing.T) {
	s := SetupInstructions()
	for _, want := range []string{"linux-setup --install", udevRuleLine, "usermod -aG input", "log out"} {
		if !strings.Contains(s, want) {
			t.Errorf("instructions lack %q:\n%s", want, s)
		}
	}
}
