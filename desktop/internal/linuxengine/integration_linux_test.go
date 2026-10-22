//go:build linux && integration

package linuxengine

// The real thing, end to end: fake mice made through uinput, the engine
// grabbing them and the clones it creates. Needs root (or the input group
// and a writable /dev/uinput) and the evdev module:
//
//	sudo -E env PATH=$PATH go test -tags integration -run Integration -v ./internal/linuxengine/
//
// or, to keep root-owned files out of your Go cache, build as yourself and
// run only the binary as root:
//
//	go test -c -tags integration -o /tmp/linuxengine.test ./internal/linuxengine/
//	sudo /tmp/linuxengine.test -test.run Integration -test.v
//
// Only the fake mice are taken over (acceptDevice), never the real one.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
)

const fakeName = "Fake IT Mouse"

type fakeMouse struct {
	t    *testing.T
	f    *os.File
	name string
	node string
}

func newFakeMouse(t *testing.T, name string) *fakeMouse {
	t.Helper()
	return newFakeDevice(t, mouseInfo(name))
}

func newFakeDevice(t *testing.T, info devInfo) *fakeMouse {
	t.Helper()
	name := info.name
	f, err := createUinput(name, inputID{busUSB, 0x1234, 0x5678, 1}, &info.caps)
	if err != nil {
		t.Fatalf("creating %s: %v", name, err)
	}
	m := &fakeMouse{t: t, f: f, name: name}
	t.Cleanup(m.destroy)
	m.node = waitNode(t, name)
	return m
}

func (m *fakeMouse) destroy() {
	if m.f != nil {
		destroyUinput(m.f)
		m.f = nil
	}
}

func (m *fakeMouse) send(evs ...inputEvent) {
	m.t.Helper()
	if _, err := m.f.Write(encode(evs)); err != nil {
		m.t.Fatalf("writing to %s: %v", m.name, err)
	}
}

// move sends n frames of (dx, dy) about 1 ms apart, like a 1000 Hz mouse.
func (m *fakeMouse) move(n int, dx, dy int32) {
	m.t.Helper()
	for i := 0; i < n; i++ {
		var evs []inputEvent
		if dx != 0 {
			evs = append(evs, ev(0, evRel, relX, dx))
		}
		if dy != 0 {
			evs = append(evs, ev(0, evRel, relY, dy))
		}
		m.send(append(evs, syn(0))...)
		time.Sleep(time.Millisecond)
	}
}

func findNode(name string) string {
	paths, _ := filepath.Glob(inputGlob)
	for _, p := range paths {
		f, info, err := openSource(p)
		if err != nil {
			continue
		}
		f.Close()
		if info.name == name {
			return p
		}
	}
	return ""
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); !cond(); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func waitNode(t *testing.T, name string) string {
	t.Helper()
	var node string
	waitFor(t, fmt.Sprintf("an event node for %q (is the evdev module loaded?)", name), func() bool {
		node = findNode(name)
		return node != ""
	})
	return node
}

// nodeReader reads an event node in the background, like any other program.
type nodeReader struct {
	f    *os.File
	ch   chan inputEvent
	done chan struct{}
}

func openReader(t *testing.T, path string) *nodeReader {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	r := &nodeReader{f: f, ch: make(chan inputEvent, 1<<14), done: make(chan struct{})}
	go func() {
		defer close(r.done)
		buf := make([]byte, 64*eventSize)
		for {
			n, err := f.Read(buf)
			for off := 0; off+eventSize <= n; off += eventSize {
				r.ch <- decodeEvent(buf[off:])
			}
			if err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() { f.Close(); <-r.done })
	return r
}

// collect returns what arrived until nothing came for 300 ms.
func (r *nodeReader) collect() []inputEvent {
	var evs []inputEvent
	for {
		select {
		case e := <-r.ch:
			evs = append(evs, e)
		case <-time.After(300 * time.Millisecond):
			return evs
		}
	}
}

// strip drops SYN_REPORTs and times, leaving what a program would act on.
func strip(evs []inputEvent) []string {
	var out []string
	for _, e := range evs {
		if e.Type != evSyn {
			out = append(out, fmt.Sprintf("%d/%#x/%d", e.Type, e.Code, e.Value))
		}
	}
	return out
}

func gone(path string) func() bool {
	return func() bool {
		_, err := os.Stat(path)
		return os.IsNotExist(err)
	}
}

func TestIntegration(t *testing.T) {
	if os.Geteuid() != 0 && !canWriteUinput() {
		t.Skip("needs root: sudo -E env PATH=$PATH go test -tags integration ./internal/linuxengine/")
	}
	acceptDevice = func(name string) bool { return strings.Contains(name, fakeName) }
	rescanInterval = 200 * time.Millisecond
	t.Cleanup(func() {
		Stop()
		acceptDevice = nil
		rescanInterval = 2 * time.Second
	})

	a := newFakeMouse(t, fakeName+" A")
	other := openReader(t, a.node) // another program reading the same mouse
	baseline := runtime.NumGoroutine()

	cfg := rightLeft(1.20, 0.80)
	if err := Start(cfg); err != nil {
		t.Fatal(err)
	}
	st := CurrentStatus()
	t.Logf("status after Start: %+v", st)
	if !st.Running || st.Paused || len(st.Devices) != 1 || st.Devices[0] != a.name || st.Code != omnicore.EncodeProfileCode(cfg) {
		t.Fatalf("status %+v", st)
	}
	cloneNode := waitNode(t, clonePrefix+a.name)
	t.Logf("source %s, clone %s", a.node, cloneNode)
	{
		srcF, src, err := openSource(a.node)
		if err != nil {
			t.Fatal(err)
		}
		srcF.Close()
		cf, clone, err := openSource(cloneNode)
		if err != nil {
			t.Fatal(err)
		}
		cf.Close()
		if clone.caps != src.caps {
			t.Fatalf("clone capabilities differ from the source's")
		}
		if clone.id != (inputID{busUSB, cloneVendor, cloneProduct, 1}) {
			t.Fatalf("clone id %+v", clone.id)
		}
	}
	clone := openReader(t, cloneNode)

	t.Run("right is scaled by 1.20", func(t *testing.T) {
		a.move(50, 10, 0)
		s := sum(clone.collect())
		t.Logf("in: x=+500, out: %+v", s)
		if !near(s.x, 600) || s.y != 0 {
			t.Fatalf("got x=%d y=%d, want x=600 y=0", s.x, s.y)
		}
	})
	t.Run("left is scaled by 0.80", func(t *testing.T) {
		a.move(50, -10, 0)
		s := sum(clone.collect())
		t.Logf("in: x=-500, out: %+v", s)
		if !near(s.x, -400) || s.y != 0 {
			t.Fatalf("got x=%d y=%d, want x=-400 y=0", s.x, s.y)
		}
	})
	t.Run("up is unchanged at 1.00", func(t *testing.T) {
		a.move(50, 0, -10)
		s := sum(clone.collect())
		t.Logf("in: y=-500, out: %+v", s)
		if s.x != 0 || !near(s.y, -500) {
			t.Fatalf("got x=%d y=%d, want x=0 y=-500", s.x, s.y)
		}
	})
	t.Run("buttons and wheels pass through", func(t *testing.T) {
		in := [][]inputEvent{
			{ev(0, evMsc, mscScan, 0x90001), ev(0, evKey, btnLeft, 1), syn(0)},
			{ev(0, evMsc, mscScan, 0x90001), ev(0, evKey, btnLeft, 0), syn(0)},
			{ev(0, evKey, btnRight, 1), syn(0)},
			{ev(0, evKey, btnRight, 0), syn(0)},
			{ev(0, evRel, relWheel, 1), ev(0, evRel, relWheelHiRes, 120), syn(0)},
			{ev(0, evRel, relWheel, -2), ev(0, evRel, relWheelHiRes, -240), syn(0)},
			{ev(0, evRel, relHWheel, 1), syn(0)},
		}
		var want []inputEvent
		for _, frame := range in {
			a.send(frame...)
			want = append(want, frame...)
			time.Sleep(time.Millisecond)
		}
		got, exp := strip(clone.collect()), strip(want)
		t.Logf("out: %v", got)
		if strings.Join(got, " ") != strings.Join(exp, " ") {
			t.Fatalf("got %v\nwant %v", got, exp)
		}
	})
	t.Run("the source is grabbed", func(t *testing.T) {
		if evs := other.collect(); len(evs) != 0 {
			t.Fatalf("another reader of the source got %d events while the engine ran", len(evs))
		}
	})
	t.Run("hot swap", func(t *testing.T) {
		cfg2 := rightLeft(0.5, 1)
		if err := Start(cfg2); err != nil {
			t.Fatal(err)
		}
		if st := CurrentStatus(); st.Code != omnicore.EncodeProfileCode(cfg2) || len(st.Devices) != 1 {
			t.Fatalf("status %+v", st)
		}
		a.move(20, 10, 0)
		if s := sum(clone.collect()); s.x != 100 {
			t.Fatalf("x=%d after swapping to 0.5, want 100", s.x)
		}
	})
	t.Run("paused passes input unchanged", func(t *testing.T) {
		SetPaused(true)
		if !CurrentStatus().Paused {
			t.Fatal("status not paused")
		}
		a.move(20, 10, 0)
		if s := sum(clone.collect()); s.x != 200 {
			t.Fatalf("x=%d while paused, want 200", s.x)
		}
		SetPaused(false)
		a.move(20, 10, 0)
		if s := sum(clone.collect()); s.x != 100 {
			t.Fatalf("x=%d after resuming, want 100", s.x)
		}
	})
	t.Run("applying a profile ends a pause", func(t *testing.T) {
		SetPaused(true)
		cfg3 := rightLeft(1.5, 1)
		if err := Start(cfg3); err != nil {
			t.Fatal(err)
		}
		if st := CurrentStatus(); st.Paused || st.Code != omnicore.EncodeProfileCode(cfg3) {
			t.Fatalf("status %+v", st)
		}
		a.move(20, 10, 0)
		if s := sum(clone.collect()); s.x != 300 {
			t.Fatalf("x=%d after applying x1.5 while paused, want 300", s.x)
		}
		if err := Start(rightLeft(0.5, 1)); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("a pointing stick is left alone", func(t *testing.T) {
		info := mouseInfo(fakeName + " TrackPoint")
		setBit(info.caps.prop[:], propPointingStick)
		stick := newFakeDevice(t, info)
		f, got, err := openSource(stick.node)
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
		if !testBit(got.caps.prop[:], propPointingStick) {
			t.Fatal("the fake stick lacks INPUT_PROP_POINTING_STICK")
		}
		r := openReader(t, stick.node)
		time.Sleep(3 * rescanInterval)
		if st := CurrentStatus(); len(st.Devices) != 1 || findNode(clonePrefix+stick.name) != "" {
			t.Fatalf("the stick was taken over: %+v", st)
		}
		stick.move(5, 10, 0)
		if s := sum(r.collect()); s.x != 50 {
			t.Fatalf("the stick's own reader got x=%d, want the raw 50", s.x)
		}
		stick.destroy()
	})
	t.Run("a mouse plugged in after Start is picked up", func(t *testing.T) {
		infoB := mouseInfo(fakeName + " B")
		setBit(infoB.caps.prop[:], 0) // INPUT_PROP_POINTER, to see properties copied
		b := newFakeDevice(t, infoB)
		waitFor(t, "the rescan to find mouse B", func() bool { return len(CurrentStatus().Devices) == 2 })
		cloneBPath := waitNode(t, clonePrefix+b.name)
		var caps [2]devCaps
		for i, path := range []string{b.node, cloneBPath} {
			f, got, err := openSource(path)
			if err != nil {
				t.Fatal(err)
			}
			f.Close()
			caps[i] = got.caps
		}
		if caps[0] != caps[1] || !testBit(caps[1].prop[:], 0) {
			t.Fatal("mouse B's clone does not have its capabilities and properties")
		}
		cloneB := openReader(t, cloneBPath)
		b.move(20, 10, 0)
		if s := sum(cloneB.collect()); s.x != 100 {
			t.Fatalf("mouse B: x=%d, want 100", s.x)
		}
		if evs := clone.collect(); len(evs) != 0 {
			t.Fatalf("mouse A's clone got %d events from mouse B", len(evs))
		}
		cloneBNode := findNode(clonePrefix + b.name)

		b.destroy() // unplugged
		waitFor(t, "mouse B to be dropped", func() bool {
			st := CurrentStatus()
			return len(st.Devices) == 1 && st.Devices[0] == a.name && st.Error == ""
		})
		waitFor(t, "mouse B's clone to be removed", gone(cloneBNode))
		a.move(10, 10, 0)
		if s := sum(clone.collect()); s.x != 50 {
			t.Fatalf("mouse A after B left: x=%d, want 50", s.x)
		}
	})
	t.Run("Stop gives the mouse back", func(t *testing.T) {
		if err := Stop(); err != nil {
			t.Fatal(err)
		}
		if st := CurrentStatus(); st.Running || len(st.Devices) != 0 || st.Paused {
			t.Fatalf("status after Stop %+v", st)
		}
		waitFor(t, "the clone to be removed", gone(cloneNode))
		if err := Stop(); err != nil {
			t.Fatalf("second Stop: %v", err)
		}
		a.move(5, 10, 0)
		if s := sum(other.collect()); s.x != 50 {
			t.Fatalf("another reader got x=%d after Stop, want the raw 50", s.x)
		}
		waitFor(t, "the engine's goroutines to exit", noEngineGoroutines)
		// +1: this subtest's own goroutine.
		if n := runtime.NumGoroutine(); n > baseline+1 {
			t.Fatalf("%d goroutines after Stop, %d before Start", n, baseline)
		}
	})
	t.Run("RunForeground until cancelled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- RunForeground(ctx, cfg) }()
		waitFor(t, "the engine to start", func() bool { return len(CurrentStatus().Devices) == 1 })
		node := waitNode(t, clonePrefix+a.name)
		r := openReader(t, node)
		a.move(10, 10, 0)
		if s := sum(r.collect()); !near(s.x, 120) {
			t.Fatalf("x=%d, want 120", s.x)
		}
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("RunForeground did not return")
		}
		if CurrentStatus().Running || !gone(node)() {
			t.Fatal("still running after RunForeground returned")
		}
		waitFor(t, "the engine's goroutines to exit", noEngineGoroutines)
	})
	t.Run("repeated Start and Stop with status polling", func(t *testing.T) {
		polling := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-polling:
					return
				default:
					CurrentStatus()
					SetPaused(false)
					time.Sleep(time.Millisecond)
				}
			}
		}()
		for i := 0; i < 5; i++ {
			if err := Start(cfg); err != nil {
				t.Fatal(err)
			}
			if err := Stop(); err != nil {
				t.Fatal(err)
			}
		}
		close(polling)
		wg.Wait()
		waitFor(t, "the engine's goroutines to exit", noEngineGoroutines)
		waitFor(t, "every clone to be removed", func() bool { return findNode(clonePrefix+a.name) == "" })
		a.move(5, 10, 0)
		if s := sum(other.collect()); s.x != 50 {
			t.Fatalf("another reader got x=%d after the last Stop, want the raw 50", s.x)
		}
	})
}

// noEngineGoroutines: no scanner or device reader is left.
func noEngineGoroutines() bool {
	buf := make([]byte, 1<<20)
	stacks := string(buf[:runtime.Stack(buf, true)])
	return !strings.Contains(stacks, "linuxengine.(*runner)")
}
