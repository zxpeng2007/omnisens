//go:build linux

package linuxengine

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// ioctl request numbers from linux/input.h and linux/uinput.h. The kernel
// encodes them as (asm-generic/ioctl.h, used by x86, arm, arm64, riscv,
// loongarch and s390; mips, powerpc, sparc and alpha differ):
//
//	_IOC(dir, type, nr, size) = dir<<30 | size<<16 | type<<8 | nr
//	_IOC_NONE = 0, _IOC_WRITE = 1, _IOC_READ = 2
//	_IO(t, nr) = _IOC(0, t, nr, 0); _IOW(t, nr, T) = _IOC(1, t, nr, sizeof(T));
//	_IOR(t, nr, T) = _IOC(2, t, nr, sizeof(T))
//
// with type 'E' = 0x45 for evdev and 'U' = 0x55 for uinput. Every value
// below was checked against a C program printing the macros from the
// linux-libc-dev 6.8 headers (Ubuntu 24.04, amd64); TestIoctlNumbers
// recomputes them from the formula.
const (
	iocWrite = 1
	iocRead  = 2

	// EVIOCGID = _IOR('E', 0x02, struct input_id): 2<<30 | 8<<16 | 0x45<<8 | 0x02.
	evIOCGID = 0x80084502
	// EVIOCGRAB = _IOW('E', 0x90, int): 1<<30 | 4<<16 | 0x45<<8 | 0x90.
	evIOCGrab = 0x40044590
	// EVIOCSCLOCKID = _IOW('E', 0xa0, int): 1<<30 | 4<<16 | 0x45<<8 | 0xa0.
	evIOCSClockID = 0x400445a0

	// UI_SET_EVBIT = _IOW('U', 100, int): 1<<30 | 4<<16 | 0x55<<8 | 0x64.
	uiSetEvBit = 0x40045564
	// UI_SET_KEYBIT = _IOW('U', 101, int), nr 0x65.
	uiSetKeyBit = 0x40045565
	// UI_SET_RELBIT = _IOW('U', 102, int), nr 0x66.
	uiSetRelBit = 0x40045566
	// UI_SET_MSCBIT = _IOW('U', 104, int), nr 0x68.
	uiSetMscBit = 0x40045568
	// UI_SET_PROPBIT = _IOW('U', 110, int), nr 0x6e.
	uiSetPropBit = 0x4004556e
	// UI_DEV_SETUP = _IOW('U', 3, struct uinput_setup), sizeof = 92 = 0x5c:
	// 1<<30 | 0x5c<<16 | 0x55<<8 | 3.
	uiDevSetup = 0x405c5503
	// UI_DEV_CREATE = _IO('U', 1), UI_DEV_DESTROY = _IO('U', 2).
	uiDevCreate  = 0x5501
	uiDevDestroy = 0x5502

	clockMonotonic = 1 // CLOCK_MONOTONIC, linux/time.h
)

func ioc(dir, typ, nr, size uintptr) uintptr {
	return dir<<30 | size<<16 | typ<<8 | nr
}

// EVIOCGNAME(len) = _IOC(_IOC_READ, 'E', 0x06, len), e.g. 0x81004506 for 256.
func evIOCGName(n int) uintptr { return ioc(iocRead, 'E', 0x06, uintptr(n)) }

// EVIOCGPROP(len) = _IOC(_IOC_READ, 'E', 0x09, len), e.g. 0x80084509 for 8.
func evIOCGProp(n int) uintptr { return ioc(iocRead, 'E', 0x09, uintptr(n)) }

// EVIOCGKEY(len) = _IOC(_IOC_READ, 'E', 0x18, len), e.g. 0x80604518 for 96.
func evIOCGKey(n int) uintptr { return ioc(iocRead, 'E', 0x18, uintptr(n)) }

// EVIOCGBIT(ev, len) = _IOC(_IOC_READ, 'E', 0x20 + ev, len), e.g. 0x80604521
// for EV_KEY with 96 bytes.
func evIOCGBit(ev, n int) uintptr { return ioc(iocRead, 'E', 0x20+uintptr(ev), uintptr(n)) }

// uinputSetup is struct uinput_setup: struct input_id (4 x u16),
// char name[UINPUT_MAX_NAME_SIZE = 80], u32 ff_effects_max; 92 bytes.
type uinputSetup struct {
	ID           inputID
	Name         [maxNameBytes + 1]byte
	FFEffectsMax uint32
}

func ioctl(fd, req, arg uintptr) error {
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, req, arg); e != 0 {
		return e
	}
	return nil
}

// ioctlPtr keeps the pointer an unsafe.Pointer until the syscall itself, as
// the unsafe rules require.
func ioctlPtr(fd, req uintptr, p unsafe.Pointer) error {
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, req, uintptr(p)); e != 0 {
		return e
	}
	return nil
}

// control runs fn on f's descriptor without taking it out of the runtime
// poller (f.Fd() would switch it to blocking mode and break deadlines).
func control(f *os.File, fn func(fd uintptr) error) error {
	rc, err := f.SyscallConn()
	if err != nil {
		return err
	}
	var ferr error
	if err := rc.Control(func(fd uintptr) { ferr = fn(fd) }); err != nil {
		return err
	}
	return ferr
}

// openSource opens an event device and reads its name, id and capabilities.
func openSource(path string) (*os.File, devInfo, error) {
	var info devInfo
	f, err := os.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		return nil, info, err
	}
	err = control(f, func(fd uintptr) error {
		var name [256]byte
		if err := ioctlPtr(fd, evIOCGName(len(name)), unsafe.Pointer(&name[0])); err != nil {
			return fmt.Errorf("EVIOCGNAME: %w", err)
		}
		info.name = cString(name[:])
		if err := ioctlPtr(fd, evIOCGID, unsafe.Pointer(&info.id)); err != nil {
			return fmt.Errorf("EVIOCGID: %w", err)
		}
		c := &info.caps
		for _, b := range []struct {
			ev  int
			buf []byte
		}{{0, c.ev[:]}, {evKey, c.key[:]}, {evRel, c.rel[:]}, {evMsc, c.msc[:]}} {
			if err := ioctlPtr(fd, evIOCGBit(b.ev, len(b.buf)), unsafe.Pointer(&b.buf[0])); err != nil {
				return fmt.Errorf("EVIOCGBIT(%d): %w", b.ev, err)
			}
		}
		// Properties came with Linux 2.6.38; without them there are none.
		_ = ioctlPtr(fd, evIOCGProp(len(c.prop)), unsafe.Pointer(&c.prop[0]))
		return nil
	})
	if err != nil {
		f.Close()
		return nil, info, fmt.Errorf("%s: %w", path, err)
	}
	return f, info, nil
}

func cString(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}

func setGrab(f *os.File, on bool) error {
	var arg uintptr
	if on {
		arg = 1
	}
	return control(f, func(fd uintptr) error { return ioctl(fd, evIOCGrab, arg) })
}

// setMonotonic asks evdev for CLOCK_MONOTONIC event times instead of wall
// clock time, which can jump. Best effort.
func setMonotonic(f *os.File) error {
	id := int32(clockMonotonic)
	return control(f, func(fd uintptr) error { return ioctlPtr(fd, evIOCSClockID, unsafe.Pointer(&id)) })
}

func readKeyState(f *os.File, b []byte) error {
	return control(f, func(fd uintptr) error { return ioctlPtr(fd, evIOCGKey(len(b)), unsafe.Pointer(&b[0])) })
}

// drain discards events queued before the grab: other programs already got
// them, so forwarding them too would apply that motion twice.
func drain(f *os.File) error {
	rc, err := f.SyscallConn()
	if err != nil {
		return err
	}
	buf := make([]byte, 64*eventSize)
	return rc.Read(func(fd uintptr) bool {
		for i := 0; i < 64; i++ { // bounded, in case events keep arriving
			if _, err := syscall.Read(int(fd), buf); err != nil && err != syscall.EINTR {
				break // EAGAIN: the queue is empty
			}
		}
		return true
	})
}

var uinputPaths = []string{"/dev/uinput", "/dev/input/uinput"}

func openUinput() (*os.File, error) {
	var first error
	for _, p := range uinputPaths {
		f, err := os.OpenFile(p, os.O_WRONLY, 0)
		if err == nil {
			return f, nil
		}
		if first == nil || !errors.Is(err, os.ErrNotExist) {
			first = err
		}
	}
	return nil, first
}

// createUinput makes a virtual device with the EV_KEY, EV_REL and EV_MSC
// capabilities and the input properties of caps.
func createUinput(name string, id inputID, caps *devCaps) (*os.File, error) {
	f, err := openUinput()
	if err != nil {
		return nil, err
	}
	err = control(f, func(fd uintptr) error {
		for code := 0; code <= propMax; code++ {
			if testBit(caps.prop[:], code) {
				if err := ioctl(fd, uiSetPropBit, uintptr(code)); err != nil {
					return fmt.Errorf("UI_SET_PROPBIT %d: %w", code, err)
				}
			}
		}
		for _, t := range []struct {
			ev   int
			bits []byte
			max  int
			req  uintptr
		}{
			{evKey, caps.key[:], keyMax, uiSetKeyBit},
			{evRel, caps.rel[:], relMax, uiSetRelBit},
			{evMsc, caps.msc[:], mscMax, uiSetMscBit},
		} {
			if !testBit(caps.ev[:], t.ev) {
				continue
			}
			if err := ioctl(fd, uiSetEvBit, uintptr(t.ev)); err != nil {
				return fmt.Errorf("UI_SET_EVBIT: %w", err)
			}
			for code := 0; code <= t.max; code++ {
				if testBit(t.bits, code) {
					if err := ioctl(fd, t.req, uintptr(code)); err != nil {
						return fmt.Errorf("UI_SET_*BIT %d: %w", code, err)
					}
				}
			}
		}
		setup := uinputSetup{ID: id}
		copy(setup.Name[:maxNameBytes], name)
		if err := ioctlPtr(fd, uiDevSetup, unsafe.Pointer(&setup)); err != nil {
			return fmt.Errorf("UI_DEV_SETUP: %w", err)
		}
		if err := ioctl(fd, uiDevCreate, 0); err != nil {
			return fmt.Errorf("UI_DEV_CREATE: %w", err)
		}
		return nil
	})
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// destroyUinput removes the virtual device (closing /dev/uinput would too).
func destroyUinput(f *os.File) {
	_ = control(f, func(fd uintptr) error { return ioctl(fd, uiDevDestroy, 0) })
	f.Close()
}
