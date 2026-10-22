//go:build !linux

package linuxengine

import (
	"context"
	"errors"

	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
)

var errUnsupported = errors.New("the omnisens engine only runs on Linux")

func Start(omnicore.Config) error { return errUnsupported }

func Stop() error { return nil }

func SetPaused(bool) {}

func CurrentStatus() Status {
	return Status{Devices: []string{}, Error: errUnsupported.Error()}
}

func RunForeground(context.Context, omnicore.Config) error { return errUnsupported }

func SetupInstructions() string {
	return "This setup is only needed on Linux.\n"
}

func InstallSetup() error { return errUnsupported }

func SetAutostart(enabled bool, code string) error {
	if !enabled {
		return nil
	}
	return errUnsupported
}

func AutostartEnabled() bool { return false }
