//go:build linux

package linuxengine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/zxpeng2007/omnisens/desktop/internal/omnicore"
)

var (
	inputGlob      = "/dev/input/event*"
	rescanInterval = 2 * time.Second
	// acceptDevice, when set, limits which mice are taken over. Tests use it
	// so they never grab the real mouse of the machine they run on.
	acceptDevice func(name string) bool
)

var (
	mu      sync.Mutex
	current *runner
)

type runner struct {
	settings atomic.Pointer[profile]
	logf     func(format string, args ...any)

	mu      sync.Mutex
	devices map[string]*device // by event node path
	errs    map[string]error   // current problem per event node path

	ignored map[string]nodeID // scanner only: nodes that are not usable mice
	quit    chan struct{}
	scanned chan struct{} // closed when the scanner goroutine exits
	wg      sync.WaitGroup
}

type device struct {
	path, name string
	src, clone *os.File
	stopping   atomic.Bool
}

// nodeID changes when a node is recreated or its permissions change, which
// is when an ignored node is worth probing again.
type nodeID struct {
	rdev, ino uint64
	ctime     int64
}

func statNode(path string) (nodeID, error) {
	var st syscall.Stat_t
	if err := syscall.Stat(path, &st); err != nil {
		return nodeID{}, err
	}
	return nodeID{uint64(st.Rdev), uint64(st.Ino), st.Ctim.Nano()}, nil
}

// Start takes over every relative mouse and applies cfg, or swaps the
// profile of the running engine without touching the devices. Either way
// the correction is on afterwards (a pause ends), like applying on Windows.
func Start(cfg omnicore.Config) error { return start(cfg, nil) }

func start(cfg omnicore.Config, logf func(string, ...any)) error {
	cfg.Sanitize()
	prof := &profile{cfg: cfg, code: omnicore.EncodeProfileCode(cfg)}
	mu.Lock()
	defer mu.Unlock()
	if current != nil {
		current.settings.Store(prof)
		return nil
	}
	f, err := openUinput()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("this kernel has no /dev/uinput (try: sudo modprobe uinput)")
		}
		return fmt.Errorf("omnisens cannot create its virtual mouse (%v). %s", err, setupHint())
	}
	f.Close()
	if logf == nil {
		logf = func(string, ...any) {}
	}
	r := &runner{
		logf:    logf,
		devices: map[string]*device{},
		errs:    map[string]error{},
		ignored: map[string]nodeID{},
		quit:    make(chan struct{}),
		scanned: make(chan struct{}),
	}
	r.settings.Store(prof)
	r.scan()
	if len(r.devices) == 0 && r.denied() > 0 {
		return fmt.Errorf("omnisens cannot read your mouse (permission denied). %s", setupHint())
	}
	go r.loop()
	current = r
	return nil
}

// Stop gives every mouse back and removes the clones. Safe to call any time.
func Stop() error {
	mu.Lock()
	defer mu.Unlock()
	if current == nil {
		return nil
	}
	current.stop()
	current = nil
	return nil
}

// SetPaused forwards input unchanged while paused (calibrating without the
// correction) and restores it when unpaused. Nothing to pause while stopped.
func SetPaused(paused bool) {
	mu.Lock()
	defer mu.Unlock()
	if current == nil {
		return
	}
	p := *current.settings.Load()
	if p.paused != paused {
		p.paused = paused
		current.settings.Store(&p)
	}
}

// CurrentStatus reports the engine and what the permissions allow.
func CurrentStatus() Status {
	st := Status{
		Supported:      true,
		Devices:        []string{},
		CanReadInput:   canReadInput(),
		CanWriteUinput: canWriteUinput(),
	}
	mu.Lock()
	defer mu.Unlock()
	r := current
	if r == nil {
		return st
	}
	p := r.settings.Load()
	st.Running, st.Paused, st.Code = true, p.paused, p.code
	r.mu.Lock()
	defer r.mu.Unlock()
	paths := make([]string, 0, len(r.devices))
	for path := range r.devices {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		st.Devices = append(st.Devices, r.devices[path].name)
	}
	st.Error = r.errorSummary()
	return st
}

// RunForeground runs the engine until ctx is cancelled (omnisens apply on
// Linux), logging devices as they come and go on stderr.
func RunForeground(ctx context.Context, cfg omnicore.Config) error {
	logf := func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "omnisens: "+format+"\n", args...)
	}
	if err := start(cfg, logf); err != nil {
		return err
	}
	if len(CurrentStatus().Devices) == 0 {
		logf("no mouse found yet; waiting for one")
	}
	<-ctx.Done()
	return Stop()
}

func (r *runner) loop() {
	defer close(r.scanned)
	t := time.NewTicker(rescanInterval)
	defer t.Stop()
	for {
		select {
		case <-r.quit:
			return
		case <-t.C:
			r.scan()
		}
	}
}

func (r *runner) stop() {
	close(r.quit)
	<-r.scanned
	r.mu.Lock()
	devs := make([]*device, 0, len(r.devices))
	for _, d := range r.devices {
		devs = append(devs, d)
	}
	r.mu.Unlock()
	for _, d := range devs {
		d.stopping.Store(true)
		// Wake the reader; it ungrabs, closes and destroys the clone itself.
		if err := d.src.SetReadDeadline(time.Unix(1, 0)); err != nil {
			d.src.Close()
		}
	}
	r.wg.Wait()
}

func (r *runner) scan() {
	paths, _ := filepath.Glob(inputGlob)
	seen := make(map[string]bool, len(paths))
	for _, path := range paths {
		seen[path] = true
		r.mu.Lock()
		_, active := r.devices[path]
		r.mu.Unlock()
		if active {
			continue
		}
		id, err := statNode(path)
		if err != nil {
			continue
		}
		if old, ok := r.ignored[path]; ok && old == id {
			continue
		}
		ignore, err := r.attach(path)
		if ignore {
			r.ignored[path] = id
		}
		r.mu.Lock()
		prev := r.errs[path]
		if err != nil {
			r.errs[path] = err
		} else {
			delete(r.errs, path)
		}
		r.mu.Unlock()
		if err != nil && (prev == nil || prev.Error() != err.Error()) {
			r.logf("%v", err)
		}
	}
	for path := range r.ignored {
		if !seen[path] {
			delete(r.ignored, path)
		}
	}
	r.mu.Lock()
	for path := range r.errs {
		if !seen[path] {
			delete(r.errs, path)
		}
	}
	r.mu.Unlock()
}

// attach takes over one event node if it is a mouse. ignore means "do not
// look at this node again until it changes".
func (r *runner) attach(path string) (ignore bool, err error) {
	src, info, err := openSource(path)
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENODEV) {
		return false, nil // unplugged while we looked
	}
	if err != nil {
		return true, err
	}
	if !info.isMouse() || info.isOmnisens() || (acceptDevice != nil && !acceptDevice(info.name)) {
		src.Close()
		return true, nil
	}
	_ = setMonotonic(src)
	// Grab before creating the clone, so a mouse that another program holds
	// does not make a clone appear and vanish on every rescan.
	if err := setGrab(src, true); err != nil {
		src.Close()
		if errors.Is(err, syscall.EBUSY) {
			return false, fmt.Errorf("%q is in use by another program (is omnisens already running?)", info.name)
		}
		return false, fmt.Errorf("%q: grab: %w", info.name, err)
	}
	_ = drain(src)
	clone, err := createUinput(cloneName(info.name), inputID{busUSB, cloneVendor, cloneProduct, 1}, &info.caps)
	if err != nil {
		_ = setGrab(src, false)
		src.Close()
		return false, fmt.Errorf("%q: creating the virtual mouse: %w", info.name, err)
	}
	d := &device{path: path, name: info.name, src: src, clone: clone}
	r.mu.Lock()
	r.devices[path] = d
	r.mu.Unlock()
	r.wg.Add(1)
	go r.run(d)
	r.logf("correcting %q (%s)", info.name, path)
	return false, nil
}

func (r *runner) run(d *device) {
	defer r.wg.Done()
	p := &frameProcessor{
		settings: &r.settings,
		readKeys: func(b []byte) error { return readKeyState(d.src, b) },
	}
	err := p.pump(d.src, d.clone)
	_ = setGrab(d.src, false)
	d.src.Close()
	destroyUinput(d.clone)
	if d.stopping.Load() {
		return
	}
	gone := errors.Is(err, syscall.ENODEV)
	r.mu.Lock()
	delete(r.devices, d.path)
	if !gone {
		r.errs[d.path] = fmt.Errorf("%q stopped: %w", d.name, err)
	}
	r.mu.Unlock()
	if gone {
		r.logf("%q was disconnected", d.name)
	} else {
		r.logf("%q stopped: %v", d.name, err)
	}
}

func (r *runner) denied() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, err := range r.errs {
		if errors.Is(err, os.ErrPermission) {
			n++
		}
	}
	return n
}

// errorSummary needs r.mu held.
func (r *runner) errorSummary() string {
	paths := make([]string, 0, len(r.errs))
	denied := 0
	for path, err := range r.errs {
		if errors.Is(err, os.ErrPermission) {
			denied++
		} else {
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	var parts []string
	if denied > 0 {
		parts = append(parts, fmt.Sprintf("cannot read %d input device(s) (permission denied). %s", denied, setupHint()))
	}
	for _, path := range paths {
		parts = append(parts, r.errs[path].Error())
	}
	return strings.Join(parts, "; ")
}

const (
	accessW = 2 // W_OK
	accessR = 4 // R_OK
)

// canReadInput: every event node is readable (a joystick may be readable
// through a logind ACL while mice are not, so one is not enough).
func canReadInput() bool {
	paths, _ := filepath.Glob(inputGlob)
	if len(paths) == 0 {
		return os.Geteuid() == 0 || inInputGroup()
	}
	for _, p := range paths {
		if syscall.Access(p, accessR) != nil {
			return false
		}
	}
	return true
}

func canWriteUinput() bool {
	for _, p := range uinputPaths {
		if syscall.Access(p, accessW) == nil {
			return true
		}
	}
	return false
}

// inInputGroup checks this process's groups, so it stays false until the
// user logs in again after being added.
func inInputGroup() bool {
	g, err := user.LookupGroup("input")
	if err != nil {
		return false
	}
	gid, err := strconv.Atoi(g.Gid)
	if err != nil {
		return false
	}
	if os.Getegid() == gid {
		return true
	}
	groups, _ := os.Getgroups()
	for _, id := range groups {
		if id == gid {
			return true
		}
	}
	return false
}
