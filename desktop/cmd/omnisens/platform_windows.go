//go:build windows

package main

import (
	"errors"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/zxpeng2007/omnisens/desktop/internal/rawaccel"
	"github.com/zxpeng2007/omnisens/desktop/internal/server"
	"github.com/zxpeng2007/omnisens/desktop/internal/state"
)

const runningNote = "Keep this window open while you calibrate; close it when you are done. " +
	"Raw Accel keeps the settings until you restart, unless 'Apply at every login' is on."

func newManager(store *state.Store) *rawaccel.Manager {
	return rawaccel.NewManager(store, rawaccel.NewSystem())
}

func newBackend(store *state.Store) (server.Backend, error) {
	m := newManager(store)
	// A correction paused for a calibration when omnisens last stopped
	// (crash, killed) is put back.
	if st, err := store.Load(); err == nil && st.Applied != nil && st.Paused {
		if _, err := m.Resume(); err != nil {
			log.Printf("could not put the paused correction back: %v", err)
		}
	}
	return m, nil
}

func applyHere(store *state.Store, code string) error {
	res, err := newManager(store).Apply(code)
	if err != nil {
		return err
	}
	printResult(jsonMap(res))
	return nil
}

func removeHere(store *state.Store) error {
	res, err := newManager(store).Remove()
	if err != nil {
		return err
	}
	printResult(jsonMap(res))
	return nil
}

func linuxSetup(bool) error {
	return errors.New("linux-setup is only needed on Linux")
}

// openBrowser opens the default browser through the URL protocol handler.
func openBrowser(url string) error {
	sys32 := filepath.Join(os.Getenv("SystemRoot"), "System32")
	if os.Getenv("SystemRoot") == "" {
		sys32 = `C:\Windows\System32`
	}
	cmd := exec.Command(filepath.Join(sys32, "rundll32.exe"), "url.dll,FileProtocolHandler", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Start()
}
