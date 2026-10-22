//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"syscall"

	"github.com/zxpeng2007/omnisens/desktop/internal/linuxengine"
	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
	"github.com/zxpeng2007/omnisens/desktop/internal/server"
	"github.com/zxpeng2007/omnisens/desktop/internal/state"
)

const runningNote = "The correction runs while omnisens runs; keep this window open. Close it (or press Ctrl+C) to stop."

func newBackend(store *state.Store) (server.Backend, error) {
	return &engineBackend{store: store}, nil
}

// engineBackend serves the API with linuxengine (full-fidelity correction
// in user space while omnisens runs).
type engineBackend struct {
	store *state.Store
}

// engineInfo is the "engine" object of /api/info: the engine status plus
// whether the login entry exists (the Raw Accel object has the same field).
type engineInfo struct {
	linuxengine.Status
	Autostart bool `json:"autostart"`
}

func (b *engineBackend) Method() string { return "engine" }

func (b *engineBackend) Info() map[string]any {
	return map[string]any{"engine": engineInfo{Status: linuxengine.CurrentStatus(), Autostart: linuxengine.AutostartEnabled()}}
}

func (b *engineBackend) status() map[string]any {
	return map[string]any{"engine": linuxengine.CurrentStatus()}
}

func badRequest(err error) error {
	return &server.StatusError{Status: http.StatusBadRequest, Msg: "That profile code cannot be used: " + err.Error() + "."}
}

func (b *engineBackend) Apply(code string) (map[string]any, error) {
	cfg, err := omnicore.DecodeProfileCode(code)
	if err != nil {
		return nil, badRequest(err)
	}
	if err := linuxengine.Start(cfg); err != nil {
		return nil, &server.StatusError{Status: http.StatusConflict, Msg: err.Error()}
	}
	if err := b.store.Update(func(st *state.State) error { st.LastCode = omnicore.EncodeProfileCode(cfg); return nil }); err != nil {
		fmt.Fprintln(os.Stderr, "omnisens: could not save the last profile:", err)
	}
	res := b.status()
	res["message"] = "The correction is running."
	return res, nil
}

func (b *engineBackend) Remove() (map[string]any, error) {
	if err := linuxengine.Stop(); err != nil {
		return nil, err
	}
	res := b.status()
	res["message"] = "The correction is stopped; your mice work as before."
	return res, nil
}

func (b *engineBackend) Pause() (map[string]any, error) {
	linuxengine.SetPaused(true)
	res := b.status()
	res["paused"] = true
	return res, nil
}

func (b *engineBackend) Resume() (map[string]any, error) {
	linuxengine.SetPaused(false)
	res := b.status()
	res["paused"] = false
	return res, nil
}

var errWindowsOnly = &server.StatusError{Status: http.StatusNotFound, Msg: "Raw Accel is only used on Windows; on Linux omnisens applies the profile itself."}

func (b *engineBackend) SetRawAccelDir(string) (map[string]any, error) { return nil, errWindowsOnly }

func (b *engineBackend) InstallRawAccel(context.Context) (map[string]any, error) {
	return nil, errWindowsOnly
}

func (b *engineBackend) SetAutostart(enabled bool, code string) (map[string]any, error) {
	if enabled {
		if code == "" {
			code = linuxengine.CurrentStatus().Code
		}
		if code == "" {
			if st, err := b.store.Load(); err == nil {
				code = st.LastCode
			}
		}
		if code == "" {
			return nil, &server.StatusError{Status: http.StatusConflict, Msg: "Start the correction with a profile first, so omnisens knows which one to apply at login."}
		}
		if _, err := omnicore.DecodeProfileCode(code); err != nil {
			return nil, badRequest(err)
		}
	}
	if err := linuxengine.SetAutostart(enabled, code); err != nil {
		return nil, fmt.Errorf("could not change the login entry: %w", err)
	}
	return map[string]any{"autostart": linuxengine.AutostartEnabled()}, nil
}

func (b *engineBackend) Close() error { return linuxengine.Stop() }

// applyHere runs the engine in the foreground (also what the login entry
// does) until Ctrl+C or logout.
func applyHere(_ *state.Store, code string) error {
	cfg, err := omnicore.DecodeProfileCode(code)
	if err != nil {
		return fmt.Errorf("that profile code cannot be used: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	fmt.Println("omnisens: starting the correction (press Ctrl+C to stop)...")
	return linuxengine.RunForeground(ctx, cfg)
}

func removeHere(*state.Store) error {
	fmt.Println("Nothing to remove: on Linux the correction only runs while omnisens runs.")
	if linuxengine.AutostartEnabled() {
		fmt.Println("It is still set to start at login; turn that off on the This PC page or delete ~/.config/autostart/omnisens.desktop.")
	}
	return nil
}

func linuxSetup(install bool) error {
	if !install {
		fmt.Print(linuxengine.SetupInstructions())
		return nil
	}
	return linuxengine.InstallSetup()
}

func openBrowser(url string) error {
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return errors.New("no graphical session")
	}
	cmd := exec.Command("xdg-open", url)
	cmd.Stdout, cmd.Stderr = nil, nil
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
