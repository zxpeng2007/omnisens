package main

import (
	"encoding/hex"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/zxpeng2007/omnisens/desktop/internal/server"
	"github.com/zxpeng2007/omnisens/desktop/internal/state"
)

func TestArgs(t *testing.T) {
	for _, c := range []struct {
		args []string
		code int
	}{
		{[]string{"--version"}, 0},
		{[]string{"-h"}, 0},
		{[]string{"--port", "-1"}, 2},
		{[]string{"--port", "70000"}, 2},
		{[]string{"--bogus"}, 2},
		{[]string{"frobnicate"}, 2},
		{[]string{"apply"}, 2},
		{[]string{"apply", "a", "b"}, 2},
		{[]string{"remove", "x"}, 2},
		{[]string{"linux-setup", "--nope"}, 2},
	} {
		if got := run(c.args); got != c.code {
			t.Errorf("%q: exit %d, want %d", c.args, got, c.code)
		}
	}
}

func TestTokenAndURL(t *testing.T) {
	a, err := newToken()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := newToken()
	if len(a) != 32 || a == b {
		t.Fatalf("tokens %q %q", a, b)
	}
	if _, err := hex.DecodeString(a); err != nil {
		t.Fatal(err)
	}
	if u := pageURL(4242, a); u != "http://127.0.0.1:4242/?t="+a+"#/pc" {
		t.Fatal(u)
	}
}

func TestLiveInstance(t *testing.T) {
	store := state.NewStore(filepath.Join(t.TempDir(), "omnisens"))
	if _, ok := liveInstance(store); ok {
		t.Fatal("no instance file, but found one")
	}
	ts := httptest.NewUnstartedServer(nil)
	port := ts.Listener.Addr().(*net.TCPAddr).Port
	srv := server.New(server.Options{Port: port, Token: "secret-token-0123", Static: fstest.MapFS{}, Backend: server.Unsupported{Message: "no"}})
	ts.Config.Handler = srv
	ts.Start()
	defer ts.Close()

	in := state.Instance{Port: port, Token: "secret-token-0123", PID: os.Getpid()}
	if err := store.WriteInstance(in); err != nil {
		t.Fatal(err)
	}
	if got, ok := liveInstance(store); !ok || got != in {
		t.Fatalf("running instance not found: %+v %v", got, ok)
	}
	var res map[string]any
	if err := call(in, http.MethodPost, "/api/apply", map[string]string{"code": "omni1.x"}, &res); err == nil || err.Error() != "no" {
		t.Fatalf("error not passed on: %v", err)
	}

	stale := in
	stale.Token = "another-token-000"
	store.WriteInstance(stale)
	if _, ok := liveInstance(store); ok {
		t.Fatal("instance with a wrong token accepted")
	}
	ts.Close()
	store.WriteInstance(in)
	if _, ok := liveInstance(store); ok {
		t.Fatal("stopped instance accepted")
	}
}
