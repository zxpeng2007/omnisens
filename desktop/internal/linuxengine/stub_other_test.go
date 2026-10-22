//go:build !linux

package linuxengine

import (
	"context"
	"testing"

	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
)

func TestStub(t *testing.T) {
	if err := Start(omnicore.DefaultConfig()); err == nil {
		t.Fatal("Start must fail off Linux")
	}
	if err := RunForeground(context.Background(), omnicore.DefaultConfig()); err == nil {
		t.Fatal("RunForeground must fail off Linux")
	}
	if err := Stop(); err != nil {
		t.Fatal(err)
	}
	SetPaused(true)
	st := CurrentStatus()
	if st.Supported || st.Running || st.Paused || st.Devices == nil || st.Error == "" {
		t.Fatalf("%+v", st)
	}
	if InstallSetup() == nil || SetAutostart(true, "omni1.x") == nil || SetAutostart(false, "") != nil || AutostartEnabled() {
		t.Fatal("setup and autostart are Linux only")
	}
	if SetupInstructions() == "" {
		t.Fatal("no instructions")
	}
}
