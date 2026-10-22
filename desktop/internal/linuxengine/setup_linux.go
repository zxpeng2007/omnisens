//go:build linux

package linuxengine

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"

	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
)

const udevRuleLine = `KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"`

const udevRuleFile = `# Written by "omnisens linux-setup --install": lets the input group create
# virtual input devices, which the omnisens mouse correction needs.
` + udevRuleLine + "\n"

// Replaced by tests.
var (
	udevRulePath           = "/etc/udev/rules.d/70-omnisens-uinput.rules"
	uinputSysfs            = "/sys/devices/virtual/misc/uinput"
	uinputDev              = "/dev/uinput"
	setupOut     io.Writer = os.Stdout
	geteuid                = os.Geteuid
	lookupGroup            = user.LookupGroup
	runCommand             = func(name string, args ...string) error {
		out, err := exec.Command(name, args...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, bytes.TrimSpace(out))
		}
		return nil
	}
)

// Login names as useradd accepts them; never starting with "-", so one
// cannot be mistaken for an option.
var validUser = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]*\$?$`)

// exePath is how to start this program again: the AppImage when running
// from one (its executable lives in a temporary mount), else this binary.
func exePath() string {
	if p := os.Getenv("APPIMAGE"); filepath.IsAbs(p) {
		return p
	}
	if p, err := os.Executable(); err == nil {
		return p
	}
	return "omnisens"
}

func shellQuote(s string) string {
	if s != "" && strings.Trim(s, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./+-") == "" {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func setupCommand() string {
	return "sudo " + shellQuote(exePath()) + " linux-setup --install"
}

func setupHint() string {
	return `One-time setup: run "` + setupCommand() + `", then log out and back in.`
}

// SetupInstructions explains the one-time permission setup and where this
// computer stands.
func SetupInstructions() string {
	yes := func(ok bool) string {
		if ok {
			return "yes"
		}
		return "not yet"
	}
	return fmt.Sprintf(`omnisens corrects your mouse on Linux by reading it (/dev/input/event*) and
sending the corrected movement from a virtual mouse (/dev/uinput). That needs a
one-time permission setup:

    %s

then log out and back in. It does exactly this, which you can also do by hand:

    echo '%s' | sudo tee %s
    sudo udevadm control --reload-rules
    sudo udevadm trigger --subsystem-match=misc --sysname-match=uinput
    sudo usermod -aG input "$USER"

Members of the "input" group can read every keyboard and mouse, so only do this
on a computer you trust.

Right now: reading mice: %s; creating the virtual mouse: %s.
`, setupCommand(), udevRuleLine, udevRulePath, yes(canReadInput()), yes(canWriteUinput()))
}

// InstallSetup does the one-time setup (must run as root, normally through
// sudo) and prints each step to stdout.
func InstallSetup() error {
	say := func(format string, args ...any) { fmt.Fprintf(setupOut, format+"\n", args...) }
	if geteuid() != 0 {
		return fmt.Errorf("the setup needs root; run: %s", setupCommand())
	}
	group, err := lookupGroup("input")
	if err != nil {
		var unknown user.UnknownGroupError
		if !errors.As(err, &unknown) {
			return err
		}
		if err := runCommand("groupadd", "--system", "input"); err != nil {
			return err
		}
		say("Created the input group.")
		if group, err = lookupGroup("input"); err != nil {
			return err
		}
	}
	if err := writeFileAtomic(udevRulePath, []byte(udevRuleFile), 0o644); err != nil {
		return err
	}
	say("Wrote %s.", udevRulePath)
	if _, err := os.Stat(uinputSysfs); err != nil {
		// Without the module loaded there is no device for the trigger to
		// update; the rule would only apply after a reboot.
		_ = runCommand("modprobe", "uinput")
	}
	if err := runCommand("udevadm", "control", "--reload-rules"); err != nil {
		return err
	}
	if err := runCommand("udevadm", "trigger", "--subsystem-match=misc", "--sysname-match=uinput"); err != nil {
		return err
	}
	_ = runCommand("udevadm", "settle", "--timeout=10")
	if fi, err := os.Stat(uinputDev); err == nil && fi.Mode().Perm()&0o060 == 0o060 &&
		strconv.FormatUint(uint64(fi.Sys().(*syscall.Stat_t).Gid), 10) == group.Gid {
		say("%s now belongs to the input group.", uinputDev)
	} else {
		say("The rule for %s takes effect after a restart.", uinputDev)
	}
	switch name := os.Getenv("SUDO_USER"); {
	case name == "" || name == "root":
		say(`Nobody was added to the input group (run this through sudo from your own account, or run: sudo usermod -aG input "$USER").`)
	case !validUser.MatchString(name):
		return fmt.Errorf("unexpected SUDO_USER %q", name)
	default:
		if err := runCommand("usermod", "-aG", "input", name); err != nil {
			return err
		}
		say("Added %s to the input group.", name)
	}
	say("Done. Log out and back in (or restart) so the new group takes effect, then start omnisens again.")
	return nil
}

func autostartFile() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "autostart", "omnisens.desktop"), nil
}

// SetAutostart adds or removes an XDG autostart entry that runs
// "omnisens apply <code>" at login.
func SetAutostart(enabled bool, code string) error {
	path, err := autostartFile()
	if err != nil {
		return err
	}
	if !enabled {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	cfg, err := omnicore.DecodeProfileCode(code)
	if err != nil {
		return err
	}
	line, err := desktopExec(exePath(), "apply", omnicore.EncodeProfileCode(cfg))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	entry := "[Desktop Entry]\n" +
		"Type=Application\n" +
		"Name=omnisens\n" +
		"Comment=Applies your omnisens mouse correction\n" +
		"Exec=" + line + "\n" +
		"Terminal=false\n" +
		"NoDisplay=true\n" +
		"X-GNOME-Autostart-enabled=true\n"
	return writeFileAtomic(path, []byte(entry), 0o644)
}

// AutostartEnabled reports whether the entry exists and has not been
// switched off by the desktop's startup settings.
func AutostartEnabled() bool {
	path, err := autostartFile()
	if err != nil {
		return false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		// The spec ignores spaces around "=".
		key, value, _ := strings.Cut(line, "=")
		switch strings.TrimSpace(key) + "=" + strings.TrimSpace(value) {
		case "Hidden=true", "X-GNOME-Autostart-enabled=false":
			return false
		}
	}
	return true
}

// desktopExec builds an Exec value per the Desktop Entry spec: arguments
// with reserved characters are double-quoted with ", `, $ and \ escaped,
// % is doubled, and then every backslash is escaped again because Exec is
// also a string value (so a literal \ ends up as \\\\).
func desktopExec(args ...string) (string, error) {
	quoter := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "`", "\\`", `$`, `\$`)
	parts := make([]string, len(args))
	for i, a := range args {
		if strings.ContainsFunc(a, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
			return "", fmt.Errorf("%q cannot be used in an autostart entry", a)
		}
		a = strings.ReplaceAll(a, "%", "%%")
		if a == "" || strings.ContainsAny(a, " \t\"'\\><~|&;$*?#()`") {
			a = `"` + quoter.Replace(a) + `"`
		}
		parts[i] = a
	}
	return strings.ReplaceAll(strings.Join(parts, " "), `\`, `\\`), nil
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp) // fails harmlessly after the rename
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(perm); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
