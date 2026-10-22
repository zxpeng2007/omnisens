//go:build !windows && !linux

package main

import (
	"errors"
	"os/exec"
	"runtime"

	"github.com/zxpeng2007/omnisens/desktop/internal/server"
	"github.com/zxpeng2007/omnisens/desktop/internal/state"
)

const runningNote = "Calibration works here; applying the profile on this computer is not supported, so export it or use the omnisens USB adapter. Close this window when you are done."

var errUnsupported = errors.New("applying a profile is not supported on " + runtime.GOOS + "; export it or use the omnisens USB adapter")

func newBackend(*state.Store) (server.Backend, error) {
	return server.Unsupported{Message: "omnisens cannot apply profiles on " + osName() + " yet. Calibration works; to use the profile, export it or use the omnisens USB adapter."}, nil
}

func osName() string {
	if runtime.GOOS == "darwin" {
		return "macOS"
	}
	return runtime.GOOS
}

func applyHere(*state.Store, string) error { return errUnsupported }

func removeHere(*state.Store) error { return errUnsupported }

func linuxSetup(bool) error { return errors.New("linux-setup is only needed on Linux") }

func openBrowser(url string) error {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	cmd := exec.Command(name, url)
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
