package state

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStateRoundTrip(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "omnisens"))
	st, err := s.Load()
	if err != nil || st.Applied != nil || st.Paused || st.RawAccelDir != "" {
		t.Fatalf("missing file: %+v %v", st, err)
	}
	at := time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
	err = s.Update(func(st *State) error {
		st.RawAccelDir = `C:\RawAccel`
		st.Applied = &Applied{Code: "omni1.x", Right: 0.97, Left: 1.02, Up: 1.04, Down: 0.98, RotationDeg: -1.5, At: at}
		st.Paused = true
		st.LastCode = "omni1.x"
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.RawAccelDir != `C:\RawAccel` || !got.Paused || got.LastCode != "omni1.x" || got.Applied == nil ||
		got.Applied.Right != 0.97 || got.Applied.RotationDeg != -1.5 || !got.Applied.At.Equal(at) {
		t.Fatalf("round trip: %+v %+v", got, got.Applied)
	}
	entries, _ := os.ReadDir(s.Dir())
	if len(entries) != 1 || entries[0].Name() != "state.json" {
		t.Fatalf("leftover files: %v", entries)
	}

	if err := os.WriteFile(filepath.Join(s.Dir(), "state.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Load(); err == nil {
		t.Fatal("damaged state accepted")
	}
	if err := s.Update(func(*State) error { return nil }); err == nil {
		t.Fatal("update over damaged state")
	}
}

func TestInstanceFile(t *testing.T) {
	s := NewStore(t.TempDir())
	if _, err := s.ReadInstance(); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing: %v", err)
	}
	in := Instance{Port: 4242, Token: "abc", PID: 7}
	if err := s.WriteInstance(in); err != nil {
		t.Fatal(err)
	}
	got, err := s.ReadInstance()
	if err != nil || got != in {
		t.Fatalf("read %+v %v", got, err)
	}
	if err := s.RemoveInstance("other"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadInstance(); err != nil {
		t.Fatal("another instance's token removed the file")
	}
	if err := s.RemoveInstance("abc"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadInstance(); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("not removed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(s.Dir(), "instance.json"), []byte(`{"port":0,"token":""}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadInstance(); err == nil {
		t.Fatal("incomplete instance accepted")
	}
}

func TestWriteFileAtomicReplaces(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f.json")
	for _, s := range []string{"one", "two"} {
		if err := WriteFileAtomic(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(p); string(b) != s {
			t.Fatalf("got %q want %q", b, s)
		}
	}
	if entries, _ := os.ReadDir(filepath.Dir(p)); len(entries) != 1 {
		t.Fatalf("temp files left: %v", entries)
	}
	if err := WriteFileAtomic(filepath.Join(p, "nested"), nil, 0o644); err == nil {
		t.Fatal("write below a file succeeded")
	}
}

func TestDefaultDir(t *testing.T) {
	d, err := DefaultDir()
	if err != nil || filepath.Base(d) != "omnisens" || !filepath.IsAbs(d) {
		t.Fatalf("%q %v", d, err)
	}
}
