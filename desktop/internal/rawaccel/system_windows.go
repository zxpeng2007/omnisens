//go:build windows

package rawaccel

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	createNoWindow           = 0x08000000
	swShowNormal             = 1
	coinitApartmentThreaded  = 0x2
	coinitDisableOLE1DDE     = 0x4
	errorCancelled           = 1223
	probeTimeout             = 10 * time.Second
	writerTimeout            = 2 * time.Minute
	shellExecuteSuccessAbove = 32
)

var procGetSystemDirectoryW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetSystemDirectoryW")

type windowsSystem struct {
	sys32 string
}

// NewSystem is the real Windows implementation.
func NewSystem() System { return &windowsSystem{sys32: systemDir()} }

// systemDir is %SystemRoot%\System32, asked from Windows so that every
// helper program and DLL is loaded by absolute path.
func systemDir() string {
	buf := make([]uint16, syscall.MAX_PATH)
	n, _, _ := procGetSystemDirectoryW.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n > 0 && int(n) < len(buf) {
		return syscall.UTF16ToString(buf[:n])
	}
	if root := os.Getenv("SystemRoot"); root != "" {
		return filepath.Join(root, "System32")
	}
	return `C:\Windows\System32`
}

// hidden runs a console tool from System32 without flashing a window.
func (w *windowsSystem) hidden(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, filepath.Join(w.sys32, name), args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}

func (w *windowsSystem) Driver() DriverStatus {
	if os.Getenv(DevAssumeDriverEnv) == "running" {
		return DriverStatus{Installed: true, Running: true}
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	out, err := w.hidden(ctx, "sc.exe", "query", "rawaccel").Output()
	st := ParseSCQuery(string(out), exitCode(err))
	if !st.Installed {
		if _, err := os.Stat(filepath.Join(w.sys32, "drivers", "rawaccel.sys")); err == nil {
			st.Installed = true
		}
	}
	return st
}

func (w *windowsSystem) VCRuntime() bool {
	for _, f := range []string{"vcruntime140.dll", "msvcp140.dll"} {
		if _, err := os.Stat(filepath.Join(w.sys32, f)); err != nil {
			return false
		}
	}
	return true
}

func (w *windowsSystem) GUIRunning() bool {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	out, err := w.hidden(ctx, "tasklist.exe", "/FI", "IMAGENAME eq rawaccel.exe", "/FO", "CSV", "/NH").Output()
	return err == nil && ParseTasklist(string(out))
}

// RunWriter runs writer.exe without hiding it: it has no console, and when
// it fails its message box has to be seen (it waits for OK).
func (w *windowsSystem) RunWriter(dir, settingsPath string) error {
	ctx, cancel := context.WithTimeout(context.Background(), writerTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, filepath.Join(dir, "writer.exe"), settingsPath)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return errors.New("writer.exe did not finish within 2 minutes; is its error message still open?")
	}
	if err == nil {
		return nil
	}
	code := exitCode(err)
	if code < 0 {
		return fmt.Errorf("could not run writer.exe: %v", err)
	}
	if msg := strings.TrimSpace(string(out)); msg != "" {
		return fmt.Errorf("writer.exe exit code %d: %s", code, msg)
	}
	return fmt.Errorf("writer.exe exit code %d; its message box says why", code)
}

// LaunchInstaller starts installer.exe with the "runas" verb (UAC prompt)
// and its own folder as working directory, where it finds driver\rawaccel.sys.
func (w *windowsSystem) LaunchInstaller(dir string) error {
	return shellExecute(w.sys32, "runas", filepath.Join(dir, "installer.exe"), dir)
}

func shellExecute(sys32, verb, file, dir string) error {
	pVerb, err := syscall.UTF16PtrFromString(verb)
	if err != nil {
		return err
	}
	pFile, err := syscall.UTF16PtrFromString(file)
	if err != nil {
		return err
	}
	pDir, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	// COM is per thread and ShellExecute may use it, so keep this goroutine
	// on one thread and initialise COM as Microsoft documents for ShellExecute.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	ole32 := syscall.NewLazyDLL(filepath.Join(sys32, "ole32.dll"))
	if hr, _, _ := ole32.NewProc("CoInitializeEx").Call(0, coinitApartmentThreaded|coinitDisableOLE1DDE); hr == 0 || hr == 1 {
		defer ole32.NewProc("CoUninitialize").Call()
	}
	shell32 := syscall.NewLazyDLL(filepath.Join(sys32, "shell32.dll"))
	r, _, callErr := shell32.NewProc("ShellExecuteW").Call(0,
		uintptr(unsafe.Pointer(pVerb)), uintptr(unsafe.Pointer(pFile)), 0, uintptr(unsafe.Pointer(pDir)), swShowNormal)
	if r > shellExecuteSuccessAbove {
		return nil
	}
	if errno, ok := callErr.(syscall.Errno); ok && errno == errorCancelled {
		return errors.New("the administrator prompt was declined")
	}
	return fmt.Errorf("ShellExecute error %d", r)
}

func (w *windowsSystem) Autostart() (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	err := w.hidden(ctx, "reg.exe", "query", RunKey, "/v", RunValue).Run()
	switch exitCode(err) {
	case 0:
		return true, nil
	case 1:
		return false, nil
	}
	return false, err
}

func (w *windowsSystem) SetAutostart(enabled bool, dir string) error {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	if enabled {
		command := AutostartCommand(filepath.Join(dir, "writer.exe"), filepath.Join(dir, settingsName))
		if out, err := w.hidden(ctx, "reg.exe", RegAddArgs(command)...).CombinedOutput(); err != nil {
			return fmt.Errorf("reg.exe: %v %s", err, strings.TrimSpace(string(out)))
		}
		return nil
	}
	on, err := w.Autostart()
	if err != nil || !on {
		return err
	}
	if out, err := w.hidden(ctx, "reg.exe", "delete", RunKey, "/v", RunValue, "/f").CombinedOutput(); err != nil {
		return fmt.Errorf("reg.exe: %v %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
