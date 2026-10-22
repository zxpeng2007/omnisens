package linuxengine

import (
	"encoding/binary"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Event types and codes, from linux/input-event-codes.h.
const (
	evSyn = 0x00
	evKey = 0x01
	evRel = 0x02
	evAbs = 0x03
	evMsc = 0x04
	evMax = 0x1f

	synReport  = 0
	synDropped = 3

	relX   = 0x00
	relY   = 0x01
	relMax = 0x0f

	btnLeft = 0x110
	keyMax  = 0x2ff
	mscMax  = 0x07

	propPointingStick = 0x05 // INPUT_PROP_POINTING_STICK
	propMax           = 0x1f

	busUSB = 0x03
)

// struct input_event is {struct timeval time; __u16 type; __u16 code;
// __s32 value}. The kernel defines time as two longs (__kernel_ulong_t), so
// the struct is 24 bytes on 64-bit Linux and 16 on 32-bit, in native byte
// order. Go's int has the size of a C long on every Linux port.
const (
	longSize    = strconv.IntSize / 8
	bitsPerLong = 8 * longSize
	eventSize   = 2*longSize + 8
)

// Capability bitmaps as EVIOCGBIT fills them: arrays of unsigned long, so
// their sizes are rounded up to whole longs.
const (
	evBytes   = (evMax/bitsPerLong + 1) * longSize
	keyBytes  = (keyMax/bitsPerLong + 1) * longSize
	relBytes  = (relMax/bitsPerLong + 1) * longSize
	mscBytes  = (mscMax/bitsPerLong + 1) * longSize
	propBytes = (propMax/bitsPerLong + 1) * longSize
)

type inputEvent struct {
	Sec, Usec  int64
	Type, Code uint16
	Value      int32
}

func decodeEvent(b []byte) inputEvent {
	var e inputEvent
	if longSize == 8 {
		e.Sec = int64(binary.NativeEndian.Uint64(b[0:]))
		e.Usec = int64(binary.NativeEndian.Uint64(b[8:]))
	} else {
		e.Sec = int64(int32(binary.NativeEndian.Uint32(b[0:])))
		e.Usec = int64(int32(binary.NativeEndian.Uint32(b[4:])))
	}
	o := 2 * longSize
	e.Type = binary.NativeEndian.Uint16(b[o:])
	e.Code = binary.NativeEndian.Uint16(b[o+2:])
	e.Value = int32(binary.NativeEndian.Uint32(b[o+4:]))
	return e
}

func (e inputEvent) appendTo(b []byte) []byte {
	if longSize == 8 {
		b = binary.NativeEndian.AppendUint64(b, uint64(e.Sec))
		b = binary.NativeEndian.AppendUint64(b, uint64(e.Usec))
	} else {
		b = binary.NativeEndian.AppendUint32(b, uint32(e.Sec))
		b = binary.NativeEndian.AppendUint32(b, uint32(e.Usec))
	}
	b = binary.NativeEndian.AppendUint16(b, e.Type)
	b = binary.NativeEndian.AppendUint16(b, e.Code)
	return binary.NativeEndian.AppendUint32(b, uint32(e.Value))
}

func (e inputEvent) micros() uint64 {
	if e.Sec < 0 || e.Usec < 0 {
		return 0
	}
	return uint64(e.Sec)*1e6 + uint64(e.Usec)
}

// testBit reads bit n of a kernel bitmap (unsigned long words, native order).
func testBit(b []byte, n int) bool {
	i := n / bitsPerLong * longSize
	if n < 0 || i+longSize > len(b) {
		return false
	}
	var w uint64
	if longSize == 8 {
		w = binary.NativeEndian.Uint64(b[i:])
	} else {
		w = uint64(binary.NativeEndian.Uint32(b[i:]))
	}
	return w>>(uint(n)%bitsPerLong)&1 != 0
}

// setBit is the inverse of testBit.
func setBit(b []byte, n int) {
	i := n / bitsPerLong * longSize
	if n < 0 || i+longSize > len(b) {
		return
	}
	if longSize == 8 {
		binary.NativeEndian.PutUint64(b[i:], binary.NativeEndian.Uint64(b[i:])|1<<(uint(n)%bitsPerLong))
	} else {
		binary.NativeEndian.PutUint32(b[i:], binary.NativeEndian.Uint32(b[i:])|1<<(uint(n)%bitsPerLong))
	}
}

type inputID struct {
	Bustype, Vendor, Product, Version uint16
}

type devCaps struct {
	ev   [evBytes]byte
	key  [keyBytes]byte
	rel  [relBytes]byte
	msc  [mscBytes]byte
	prop [propBytes]byte // input properties (EVIOCGPROP)
}

type devInfo struct {
	name string
	id   inputID
	caps devCaps
}

// isMouse: a relative pointer with a left button and no absolute axes, so
// touchpads, tablets and touchscreens are left alone. Pointing sticks
// (TrackPoint) are too: the profile was not measured on one, and libinput
// gives them their own acceleration and middle-button scrolling.
func (d *devInfo) isMouse() bool {
	c := &d.caps
	return testBit(c.ev[:], evRel) && testBit(c.ev[:], evKey) && !testBit(c.ev[:], evAbs) &&
		testBit(c.rel[:], relX) && testBit(c.rel[:], relY) && testBit(c.key[:], btnLeft) &&
		!testBit(c.prop[:], propPointingStick)
}

// isOmnisens covers our own clones ("omnisens: ...") and the omnisens USB
// adapter (manufacturer string "omnisens"), which already applies the profile.
func (d *devInfo) isOmnisens() bool {
	return strings.HasPrefix(strings.ToLower(d.name), "omnisens")
}

const (
	clonePrefix = "omnisens: "
	// Clones use the pid.codes test vendor like the adapter (0x1209:0x0001)
	// but their own product id. Nothing matches on these ids.
	cloneVendor  = 0x1209
	cloneProduct = 0x0002
	maxNameBytes = 79 // UINPUT_MAX_NAME_SIZE (80) minus the NUL
)

func cloneName(original string) string {
	n := clonePrefix + original
	if len(n) <= maxNameBytes {
		return n
	}
	n = n[:maxNameBytes]
	for len(n) > 0 { // do not cut a UTF-8 sequence in half
		if r, size := utf8.DecodeLastRuneInString(n); r != utf8.RuneError || size > 1 {
			break
		}
		n = n[:len(n)-1]
	}
	return n
}
