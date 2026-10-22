package linuxengine

import (
	"io"
	"math"
	"sync/atomic"

	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
)

// profile is an immutable snapshot of what the readers apply. Start, a hot
// swap and SetPaused publish a new one; every reader picks it up at its next
// frame and starts a fresh engine.
type profile struct {
	cfg    omnicore.Config
	code   string
	paused bool
}

// A device that never sends SYN_REPORT must not make us buffer forever.
const maxFrameEvents = 256

// frameProcessor turns one source device's event stream into its clone's.
// Events are buffered until SYN_REPORT; the frame's REL_X/REL_Y go through
// the engine and everything else (buttons, wheels, hi-res wheels, MSC_SCAN)
// passes through unchanged and in order.
type frameProcessor struct {
	settings *atomic.Pointer[profile]
	// readKeys fills a kernel key bitmap with the source's current button
	// state (EVIOCGKEY); used to resynchronise after SYN_DROPPED. May be nil.
	readKeys func(b []byte) error

	prof     *profile
	eng      *omnicore.Engine // nil while paused
	frame    []inputEvent
	dropping bool
	lastUs   uint64
	down     [keyMax + 1]bool // button state as forwarded to the clone
}

// push handles one source event and appends whatever the clone should get.
func (p *frameProcessor) push(ev inputEvent, out []byte) []byte {
	if ev.Type == evSyn {
		switch ev.Code {
		case synDropped:
			// The kernel's queue overflowed: ignore everything up to and
			// including the next SYN_REPORT, then resync (evdev protocol).
			p.dropping = true
			p.frame = p.frame[:0]
			return out
		case synReport:
			if p.dropping {
				p.dropping = false
				p.frame = p.frame[:0]
				if p.eng != nil {
					p.eng.Reset()
				}
				return p.resync(ev, out)
			}
			return p.flush(ev, out)
		}
	}
	if p.dropping {
		return out
	}
	p.frame = append(p.frame, ev)
	if len(p.frame) >= maxFrameEvents {
		return p.flush(inputEvent{Sec: ev.Sec, Usec: ev.Usec, Type: evSyn, Code: synReport}, out)
	}
	return out
}

func (p *frameProcessor) flush(syn inputEvent, out []byte) []byte {
	p.refresh()
	start := len(out)
	first := -1
	var dx, dy int64
	for i, ev := range p.frame {
		if !isMotion(ev) {
			continue
		}
		if first < 0 {
			first = i
		}
		if ev.Code == relX {
			dx += int64(ev.Value)
		} else {
			dy += int64(ev.Value)
		}
	}
	if p.eng == nil || (dx == 0 && dy == 0) {
		first = -1 // forward the frame unchanged
	}
	var ox, oy int32
	if first >= 0 {
		// Event times are CLOCK_MONOTONIC when EVIOCSCLOCKID worked, but
		// never let a clock step make the engine see time run backwards.
		us := p.frame[first].micros()
		if us < p.lastUs {
			us = p.lastUs
		}
		p.lastUs = us
		ox, oy = p.eng.Process(clamp32(dx), clamp32(dy), us)
	}
	for i, ev := range p.frame {
		if first >= 0 {
			if i == first {
				// Rotation can turn pure x motion into x and y, so both
				// axes are written where the motion was, when non-zero.
				if ox != 0 {
					out = inputEvent{Sec: ev.Sec, Usec: ev.Usec, Type: evRel, Code: relX, Value: ox}.appendTo(out)
				}
				if oy != 0 {
					out = inputEvent{Sec: ev.Sec, Usec: ev.Usec, Type: evRel, Code: relY, Value: oy}.appendTo(out)
				}
			}
			if isMotion(ev) {
				continue
			}
		}
		out = p.emit(ev, out)
	}
	p.frame = p.frame[:0]
	if len(out) == start {
		return out // nothing left (the kernel would drop an empty frame anyway)
	}
	return syn.appendTo(out)
}

func isMotion(ev inputEvent) bool {
	return ev.Type == evRel && (ev.Code == relX || ev.Code == relY)
}

func (p *frameProcessor) emit(ev inputEvent, out []byte) []byte {
	if ev.Type == evKey && int(ev.Code) <= keyMax {
		p.down[ev.Code] = ev.Value != 0
	}
	return ev.appendTo(out)
}

// resync sends the button changes missed during a SYN_DROPPED gap, so no
// button stays stuck down (or up) on the clone.
func (p *frameProcessor) resync(syn inputEvent, out []byte) []byte {
	if p.readKeys == nil {
		return out
	}
	var now [keyBytes]byte
	if p.readKeys(now[:]) != nil {
		return out
	}
	start := len(out)
	for code, was := range p.down {
		if is := testBit(now[:], code); is != was {
			v := int32(0)
			if is {
				v = 1
			}
			out = p.emit(inputEvent{Sec: syn.Sec, Usec: syn.Usec, Type: evKey, Code: uint16(code), Value: v}, out)
		}
	}
	if len(out) == start {
		return out
	}
	return syn.appendTo(out)
}

func (p *frameProcessor) refresh() {
	cur := p.settings.Load()
	if cur == p.prof {
		return
	}
	p.prof, p.eng = cur, nil
	if cur != nil && !cur.paused {
		p.eng = omnicore.NewEngine(cur.cfg)
	}
}

// pump forwards src to dst until one of them fails and returns that error.
// A frame's output is produced at its SYN_REPORT, so it is always written
// to the clone in a single write.
func (p *frameProcessor) pump(src io.Reader, dst io.Writer) error {
	buf := make([]byte, 64*eventSize)
	var out []byte
	have := 0
	for {
		n, err := src.Read(buf[have:])
		have += n
		whole := have - have%eventSize
		out = out[:0]
		for off := 0; off < whole; off += eventSize {
			out = p.push(decodeEvent(buf[off:off+eventSize]), out)
		}
		have = copy(buf, buf[whole:have])
		if len(out) > 0 {
			if _, werr := dst.Write(out); werr != nil {
				return werr
			}
		}
		if err != nil {
			return err
		}
	}
}

func clamp32(v int64) int32 {
	return int32(max(math.MinInt32, min(math.MaxInt32, v)))
}
