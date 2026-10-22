package linuxengine

import (
	"bytes"
	"errors"
	"io"
	"math"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf8"

	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
)

const (
	btnRight      = 0x111
	relHWheel     = 0x06
	relWheel      = 0x08
	relWheelHiRes = 0x0b
	mscScan       = 0x04
)

// rightLeft is an 8-point profile with the given right and left gains and
// 1.00 at the other six points.
func rightLeft(right, left float64) omnicore.Config {
	return omnicore.ConfigFromGains([]float64{right, 1, 1, 1, left, 1, 1, 1}, false)
}

func newSettings(cfg omnicore.Config, paused bool) *atomic.Pointer[profile] {
	s := &atomic.Pointer[profile]{}
	s.Store(&profile{cfg: cfg, code: omnicore.EncodeProfileCode(cfg), paused: paused})
	return s
}

// ev builds an event at t milliseconds.
func ev(tMs int64, typ, code uint16, value int32) inputEvent {
	return inputEvent{Sec: tMs / 1000, Usec: tMs % 1000 * 1000, Type: typ, Code: code, Value: value}
}

func syn(tMs int64) inputEvent { return ev(tMs, evSyn, synReport, 0) }

func encode(events []inputEvent) []byte {
	var b []byte
	for _, e := range events {
		b = e.appendTo(b)
	}
	return b
}

func decodeAll(t *testing.T, b []byte) []inputEvent {
	t.Helper()
	if len(b)%eventSize != 0 {
		t.Fatalf("output is %d bytes, not whole events", len(b))
	}
	var out []inputEvent
	for off := 0; off < len(b); off += eventSize {
		out = append(out, decodeEvent(b[off:]))
	}
	return out
}

// chunkReader returns at most n bytes per Read, to split events and frames.
type chunkReader struct {
	r io.Reader
	n int
}

func (c chunkReader) Read(p []byte) (int, error) {
	if len(p) > c.n {
		p = p[:c.n]
	}
	return c.r.Read(p)
}

func pumpAll(t *testing.T, p *frameProcessor, src io.Reader) []inputEvent {
	t.Helper()
	var out bytes.Buffer
	if err := p.pump(src, &out); err != io.EOF {
		t.Fatalf("pump: %v, want EOF", err)
	}
	return decodeAll(t, out.Bytes())
}

// motion makes n frames of (dx, dy), 1 ms apart, from t0 ms.
func motion(t0 int64, n int, dx, dy int32) []inputEvent {
	var evs []inputEvent
	for i := 0; i < n; i++ {
		t := t0 + int64(i)
		if dx != 0 {
			evs = append(evs, ev(t, evRel, relX, dx))
		}
		if dy != 0 {
			evs = append(evs, ev(t, evRel, relY, dy))
		}
		evs = append(evs, syn(t))
	}
	return evs
}

type totals struct {
	x, y, frames int
}

func sum(evs []inputEvent) totals {
	var s totals
	for _, e := range evs {
		switch {
		case e.Type == evRel && e.Code == relX:
			s.x += int(e.Value)
		case e.Type == evRel && e.Code == relY:
			s.y += int(e.Value)
		case e.Type == evSyn && e.Code == synReport:
			s.frames++
		}
	}
	return s
}

func near(a, b int) bool { return a-b <= 1 && b-a <= 1 }

func TestEventRoundTrip(t *testing.T) {
	e := inputEvent{Sec: 1700000000, Usec: 999999, Type: evRel, Code: relWheelHiRes, Value: -120}
	b := e.appendTo(nil)
	if len(b) != eventSize {
		t.Fatalf("encoded %d bytes, want %d", len(b), eventSize)
	}
	if got := decodeEvent(b); got != e {
		t.Fatalf("round trip %+v != %+v", got, e)
	}
	if longSize == 8 && eventSize != 24 {
		t.Fatalf("struct input_event is 24 bytes on 64-bit Linux, have %d", eventSize)
	}
	if got := e.micros(); got != 1700000000999999 {
		t.Fatalf("micros %d", got)
	}
}

func TestBitmaps(t *testing.T) {
	if longSize == 8 && (evBytes != 8 || keyBytes != 96 || relBytes != 8 || mscBytes != 8 || propBytes != 8) {
		t.Fatalf("bitmap sizes %d %d %d %d %d", evBytes, keyBytes, relBytes, mscBytes, propBytes)
	}
	var b [keyBytes]byte
	for _, n := range []int{0, 1, 63, 64, btnLeft, keyMax} {
		setBit(b[:], n)
	}
	for n := 0; n <= keyMax; n++ {
		want := n == 0 || n == 1 || n == 63 || n == 64 || n == btnLeft || n == keyMax
		if testBit(b[:], n) != want {
			t.Fatalf("bit %d = %v", n, !want)
		}
	}
	if testBit(b[:], keyMax+1) || testBit(b[:], -1) {
		t.Fatal("out of range bit reported set")
	}
}

func mouseInfo(name string) devInfo {
	d := devInfo{name: name}
	for _, e := range []int{evKey, evRel, evMsc} {
		setBit(d.caps.ev[:], e)
	}
	for _, k := range []int{btnLeft, btnRight} {
		setBit(d.caps.key[:], k)
	}
	for _, r := range []int{relX, relY, relWheel, relHWheel, relWheelHiRes} {
		setBit(d.caps.rel[:], r)
	}
	setBit(d.caps.msc[:], mscScan)
	return d
}

func TestDeviceClassification(t *testing.T) {
	m := mouseInfo("Logitech G Pro")
	if !m.isMouse() || m.isOmnisens() {
		t.Fatal("a plain mouse must be taken over")
	}
	pad := mouseInfo("Touchpad")
	setBit(pad.caps.ev[:], evAbs)
	if pad.isMouse() {
		t.Fatal("a device with absolute axes is not a mouse")
	}
	kbd := devInfo{name: "Keyboard"}
	setBit(kbd.caps.ev[:], evKey)
	setBit(kbd.caps.key[:], 30)
	if kbd.isMouse() {
		t.Fatal("a keyboard is not a mouse")
	}
	nobtn := mouseInfo("Trackball without buttons")
	nobtn.caps.key = [keyBytes]byte{}
	if nobtn.isMouse() {
		t.Fatal("a mouse needs BTN_LEFT")
	}
	stick := mouseInfo("TPPS/2 Elan TrackPoint")
	setBit(stick.caps.prop[:], propPointingStick)
	if stick.isMouse() {
		t.Fatal("a pointing stick is not a mouse")
	}
	for _, name := range []string{"omnisens: Logitech G Pro", "omnisens omnisens adapter Mouse", "OmniSens thing"} {
		if d := mouseInfo(name); !d.isOmnisens() {
			t.Fatalf("%q must be skipped", name)
		}
	}
}

func TestCloneName(t *testing.T) {
	if got := cloneName("Logitech G Pro"); got != "omnisens: Logitech G Pro" {
		t.Fatal(got)
	}
	long := cloneName(strings.Repeat("x", 100))
	if len(long) != maxNameBytes || !strings.HasPrefix(long, clonePrefix) {
		t.Fatalf("%d bytes: %q", len(long), long)
	}
	// 68 ASCII bytes + "é" (2 bytes) at offsets 78-79: cutting at 79 would split it.
	u := cloneName(strings.Repeat("a", 68) + "éé")
	if !utf8.ValidString(u) || len(u) > maxNameBytes {
		t.Fatalf("%d bytes, valid=%v", len(u), utf8.ValidString(u))
	}
}

func TestFrameScalesRightAndLeft(t *testing.T) {
	p := &frameProcessor{settings: newSettings(rightLeft(1.20, 0.80), false)}
	in := motion(1000, 50, 10, 0)
	in = append(in, motion(2000, 50, -10, 0)...) // after a pause: new stroke
	out := pumpAll(t, p, bytes.NewReader(encode(in)))
	right := sum(out[:len(out)/2])
	left := sum(out[len(out)/2:])
	if !near(right.x, 600) || right.y != 0 || right.frames != 50 {
		t.Fatalf("right: %+v, want x=600 y=0 in 50 frames", right)
	}
	if !near(left.x, -400) || left.y != 0 || left.frames != 50 {
		t.Fatalf("left: %+v, want x=-400 y=0 in 50 frames", left)
	}
}

func TestFrameKeepsOtherEventsInOrder(t *testing.T) {
	p := &frameProcessor{settings: newSettings(rightLeft(2, 2), false)}
	in := []inputEvent{
		ev(0, evMsc, mscScan, 0x90001),
		ev(0, evKey, btnLeft, 1),
		ev(0, evRel, relX, 3),
		ev(0, evRel, relWheel, -1),
		ev(0, evRel, relWheelHiRes, -120),
		ev(0, evRel, relHWheel, 1),
		syn(0),
		ev(5, evKey, btnLeft, 0),
		syn(5),
	}
	out := pumpAll(t, p, bytes.NewReader(encode(in)))
	want := []inputEvent{
		ev(0, evMsc, mscScan, 0x90001),
		ev(0, evKey, btnLeft, 1),
		ev(0, evRel, relX, 6),
		ev(0, evRel, relWheel, -1),
		ev(0, evRel, relWheelHiRes, -120),
		ev(0, evRel, relHWheel, 1),
		syn(0),
		ev(5, evKey, btnLeft, 0),
		syn(5),
	}
	if len(out) != len(want) {
		t.Fatalf("got %d events %+v, want %d", len(out), out, len(want))
	}
	for i := range want {
		if out[i] != want[i] {
			t.Fatalf("event %d: %+v, want %+v", i, out[i], want[i])
		}
	}
}

func TestFrameRotationAddsY(t *testing.T) {
	cfg := omnicore.DefaultConfig()
	cfg.RotationCdeg = 4500
	p := &frameProcessor{settings: newSettings(cfg, false)}
	out := pumpAll(t, p, bytes.NewReader(encode(motion(0, 20, 10, 0))))
	s := sum(out)
	// 45 degrees counter-clockwise: 200 counts right come out as ~141 right
	// and ~141 up (negative y).
	want := int(math.Round(200 / math.Sqrt2))
	if !near(s.x, want) || !near(s.y, -want) {
		t.Fatalf("rotated totals %+v, want x=%d y=%d", s, want, -want)
	}
}

func TestFramePausedAndHotSwap(t *testing.T) {
	settings := newSettings(rightLeft(1.5, 1), true)
	p := &frameProcessor{settings: settings}
	var out bytes.Buffer
	run := func(evs []inputEvent) totals {
		out.Reset()
		if err := p.pump(bytes.NewReader(encode(evs)), &out); err != io.EOF {
			t.Fatal(err)
		}
		return sum(decodeAll(t, out.Bytes()))
	}
	if s := run(motion(0, 10, 10, 0)); s.x != 100 {
		t.Fatalf("paused: x=%d, want the input unchanged (100)", s.x)
	}
	cfg := rightLeft(1.5, 1)
	settings.Store(&profile{cfg: cfg})
	if s := run(motion(100, 10, 10, 0)); s.x != 150 {
		t.Fatalf("running: x=%d, want 150", s.x)
	}
	settings.Store(&profile{cfg: rightLeft(0.5, 1)})
	if s := run(motion(200, 10, 10, 0)); s.x != 50 {
		t.Fatalf("after the swap: x=%d, want 50", s.x)
	}
}

func TestFrameSynDropped(t *testing.T) {
	keys := make([]byte, keyBytes) // the source's state after the gap: nothing held
	p := &frameProcessor{
		settings: newSettings(rightLeft(1, 1), false),
		readKeys: func(b []byte) error { copy(b, keys); return nil },
	}
	in := []inputEvent{
		ev(0, evKey, btnLeft, 1), syn(0),
		ev(1, evRel, relX, 5), // part of the frame interrupted by the overflow
		ev(1, evSyn, synDropped, 0),
		ev(2, evRel, relX, 7), ev(2, evKey, btnLeft, 0), syn(2), // lost
		ev(3, evRel, relX, 1), syn(3),
	}
	setBit(keys, btnRight) // right button went down during the gap
	out := pumpAll(t, p, bytes.NewReader(encode(in)))
	want := []inputEvent{
		ev(0, evKey, btnLeft, 1), syn(0),
		ev(2, evKey, btnLeft, 0), ev(2, evKey, btnRight, 1), syn(2),
		ev(3, evRel, relX, 1), syn(3),
	}
	if len(out) != len(want) {
		t.Fatalf("got %+v, want %+v", out, want)
	}
	for i := range want {
		if out[i] != want[i] {
			t.Fatalf("event %d: %+v, want %+v", i, out[i], want[i])
		}
	}
}

func TestFramePartialReads(t *testing.T) {
	in := encode(append(motion(0, 30, 7, -3), motion(500, 30, -4, 9)...))
	whole := pumpAll(t, &frameProcessor{settings: newSettings(rightLeft(1.3, 0.7), false)}, bytes.NewReader(in))
	split := pumpAll(t, &frameProcessor{settings: newSettings(rightLeft(1.3, 0.7), false)}, chunkReader{bytes.NewReader(in), 5})
	if len(whole) != len(split) {
		t.Fatalf("%d events vs %d", len(whole), len(split))
	}
	for i := range whole {
		if whole[i] != split[i] {
			t.Fatalf("event %d differs: %+v vs %+v", i, whole[i], split[i])
		}
	}
}

func TestFrameWithoutSynIsBounded(t *testing.T) {
	var in []inputEvent
	for i := 0; i < maxFrameEvents+10; i++ {
		in = append(in, ev(0, evMsc, mscScan, int32(i)))
	}
	out := pumpAll(t, &frameProcessor{settings: newSettings(rightLeft(1, 1), false)}, bytes.NewReader(encode(in)))
	if len(out) != maxFrameEvents+1 || out[maxFrameEvents] != syn(0) {
		t.Fatalf("got %d events, want one flushed frame of %d + SYN_REPORT", len(out), maxFrameEvents)
	}
}

func TestFrameClockNeverRunsBackwards(t *testing.T) {
	// x1.5 on 1-count moves alternates 2, 1, 2, 1 while the stroke lasts. If
	// time running backwards looked like a long pause, every move would
	// start a new stroke and come out as 2.
	p := &frameProcessor{settings: newSettings(rightLeft(1.5, 1), false)}
	in := []inputEvent{
		ev(5000, evRel, relX, 1), syn(5000),
		ev(4999, evRel, relX, 1), syn(4999),
		ev(4998, evRel, relX, 1), syn(4998),
		ev(4997, evRel, relX, 1), syn(4997),
	}
	if s := sum(pumpAll(t, p, bytes.NewReader(encode(in)))); s.x != 6 {
		t.Fatalf("x=%d, want 6", s.x)
	}
}

func TestFrameMotionRoundedAwayIsNotEmitted(t *testing.T) {
	// x0.4 on 1-count moves: 0, 1, 0, 1, ... Empty frames are not written.
	p := &frameProcessor{settings: newSettings(rightLeft(0.4, 1), false)}
	out := pumpAll(t, p, bytes.NewReader(encode(motion(0, 10, 1, 0))))
	s := sum(out)
	if s.x != 4 || s.frames != 4 {
		t.Fatalf("%+v, want x=4 in 4 frames", s)
	}
}

type failWriter struct{}

func (failWriter) Write([]byte) (int, error) { return 0, errors.New("gone") }

func TestPumpReturnsWriteError(t *testing.T) {
	p := &frameProcessor{settings: newSettings(rightLeft(1, 1), false)}
	err := p.pump(bytes.NewReader(encode(motion(0, 1, 1, 0))), failWriter{})
	if err == nil || err.Error() != "gone" {
		t.Fatalf("pump: %v", err)
	}
}
