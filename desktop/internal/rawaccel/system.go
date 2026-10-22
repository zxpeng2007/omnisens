package rawaccel

import (
	"regexp"
	"strings"
)

// DriverStatus is what Windows reports about the rawaccel service.
type DriverStatus struct {
	Installed bool
	Running   bool
}

// System is everything the Manager needs from Windows; tests substitute it.
type System interface {
	// Driver reports whether the rawaccel driver is installed and running.
	Driver() DriverStatus
	// VCRuntime reports whether the Visual C++ runtime writer.exe needs is present.
	VCRuntime() bool
	// GUIRunning reports whether Raw Accel's window (rawaccel.exe) is open.
	GUIRunning() bool
	// RunWriter runs dir\writer.exe settingsPath and waits for it.
	RunWriter(dir, settingsPath string) error
	// LaunchInstaller starts dir\installer.exe elevated (UAC prompt) in dir.
	LaunchInstaller(dir string) error
	// Autostart reports whether the HKCU Run entry exists.
	Autostart() (bool, error)
	// SetAutostart adds (writer.exe of dir with its settings.json) or
	// deletes the HKCU Run entry.
	SetAutostart(enabled bool, dir string) error
}

// DevAssumeDriverEnv is a developer-only escape hatch for testing the whole
// app on a PC without the Raw Accel driver: with
// OMNISENS_DEV_ASSUME_RAWACCEL_DRIVER=running the Windows driver check
// reports the driver as installed and running, so writer.exe (normally a
// fake one in a scratch folder) is called. It is deliberately not exposed in
// the UI or the command line help.
const DevAssumeDriverEnv = "OMNISENS_DEV_ASSUME_RAWACCEL_DRIVER"

// RunKey and RunValue are the per-user autostart entry.
const (
	RunKey   = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	RunValue = "omnisens Raw Accel"
)

// AutostartCommand is the Run entry's command line; writer.exe is a windowed
// program, so no console flashes at login.
func AutostartCommand(writerExe, settingsPath string) string {
	return `"` + writerExe + `" "` + settingsPath + `"`
}

// RegAddArgs are reg.exe's arguments for creating the Run entry.
func RegAddArgs(command string) []string {
	return []string{"add", RunKey, "/v", RunValue, "/t", "REG_SZ", "/d", command, "/f"}
}

var scState = regexp.MustCompile(`(?m)^\s*STATE\s*:\s*(\d+)`)

// ParseSCQuery reads `sc query rawaccel` output: exists when sc succeeded,
// running when STATE is 4 (SERVICE_RUNNING). Only the numeric state is used
// because the words after it may be localized.
func ParseSCQuery(output string, exitCode int) DriverStatus {
	if exitCode != 0 {
		return DriverStatus{}
	}
	st := DriverStatus{Installed: true}
	if m := scState.FindStringSubmatch(output); m != nil {
		st.Running = m[1] == "4"
	} else {
		st.Running = strings.Contains(output, "RUNNING")
	}
	return st
}

// ParseTasklist reports whether `tasklist /FI "IMAGENAME eq rawaccel.exe"
// /FO CSV /NH` listed the process (the "no tasks" line is localized, the
// CSV row is not).
func ParseTasklist(output string) bool {
	return strings.Contains(strings.ToLower(output), `"rawaccel.exe"`)
}
