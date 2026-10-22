// Package state keeps omnisens' small persistent data: the remembered Raw
// Accel folder, the correction that is applied, and the instance file of the
// running app. Every file is written atomically.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

const (
	stateFile    = "state.json"
	instanceFile = "instance.json"
)

// State is state.json.
type State struct {
	RawAccelDir string   `json:"rawAccelDir,omitempty"`
	Applied     *Applied `json:"applied"`
	Paused      bool     `json:"paused"`
	LastCode    string   `json:"lastCode,omitempty"`
}

// Applied is the Raw Accel correction omnisens put into a settings.json.
type Applied struct {
	Code        string    `json:"code"`
	Right       float64   `json:"right"`
	Left        float64   `json:"left"`
	Up          float64   `json:"up"`
	Down        float64   `json:"down"`
	RotationDeg float64   `json:"rotationDeg"`
	At          time.Time `json:"at"`
	// SettingsFile is the settings.json that carries the factors, so they
	// can be removed even after the remembered folder changes.
	SettingsFile string `json:"settingsFile,omitempty"`
	// Profiles records, per Raw Accel profile, the values omnisens replaced
	// and the values it wrote, so a removal can restore them exactly. Empty
	// while paused.
	Profiles []ProfileRecord `json:"profiles,omitempty"`
}

// ProfileRecord holds the five fields omnisens changes in one Raw Accel
// profile (Output DPI, Y/X, L/R, U/D ratios, rotation) as JSON number text.
type ProfileRecord struct {
	Name   string         `json:"name"`
	Before [5]json.Number `json:"before"`
	After  [5]json.Number `json:"after"`
}

// Instance is instance.json, present while an omnisens app is serving.
type Instance struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

// Store reads and writes the files in one directory.
type Store struct {
	dir string
	mu  sync.Mutex
}

// DefaultDir is %LOCALAPPDATA%\omnisens on Windows and
// $XDG_CONFIG_HOME/omnisens (default ~/.config/omnisens) elsewhere.
func DefaultDir() (string, error) {
	if runtime.GOOS == "windows" {
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "omnisens"), nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "AppData", "Local", "omnisens"), nil
	}
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" && filepath.IsAbs(d) {
		return filepath.Join(d, "omnisens"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "omnisens"), nil
}

// NewStore returns a store for dir; the directory is created on first write.
func NewStore(dir string) *Store { return &Store{dir: dir} }

// Dir is the store's directory.
func (s *Store) Dir() string { return s.dir }

// Load reads state.json. A missing file is the zero State.
func (s *Store) Load() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

func (s *Store) load() (State, error) {
	var st State
	b, err := os.ReadFile(filepath.Join(s.dir, stateFile))
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return State{}, fmt.Errorf("omnisens' state file %s is damaged (%v); delete it to start over", filepath.Join(s.dir, stateFile), err)
	}
	return st, nil
}

// Save writes state.json.
func (s *Store) Save(st State) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.save(st)
}

func (s *Store) save(st State) error {
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	return WriteFileAtomic(filepath.Join(s.dir, stateFile), append(b, '\n'), 0o600)
}

// Update loads, modifies and saves state.json under the store's lock.
func (s *Store) Update(fn func(*State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	if err != nil {
		return err
	}
	if err := fn(&st); err != nil {
		return err
	}
	return s.save(st)
}

// WriteInstance writes instance.json (it holds the API token: owner only).
func (s *Store) WriteInstance(in Instance) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	return WriteFileAtomic(filepath.Join(s.dir, instanceFile), append(b, '\n'), 0o600)
}

// ReadInstance reads instance.json; fs.ErrNotExist when there is none.
func (s *Store) ReadInstance() (Instance, error) {
	var in Instance
	b, err := os.ReadFile(filepath.Join(s.dir, instanceFile))
	if err != nil {
		return in, err
	}
	if err := json.Unmarshal(b, &in); err != nil {
		return Instance{}, err
	}
	if in.Port <= 0 || in.Port > 65535 || in.Token == "" {
		return Instance{}, errors.New("instance file is incomplete")
	}
	return in, nil
}

// RemoveInstance deletes instance.json if it still describes the instance
// with this token (a newer instance may have replaced it).
func (s *Store) RemoveInstance(token string) error {
	in, err := s.ReadInstance()
	if err != nil || in.Token != token {
		return nil
	}
	err = os.Remove(filepath.Join(s.dir, instanceFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// WriteFileAtomic writes data to a temporary file next to path and renames
// it over path, so readers see either the old or the new content.
func WriteFileAtomic(path string, data []byte, perm fs.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() {
		if tmp != "" {
			os.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp, perm); err != nil {
		return err
	}
	if err := rename(tmp, path); err != nil {
		return err
	}
	tmp = ""
	return nil
}

// rename retries briefly on Windows, where a virus scanner or indexer that
// has the target open makes the replace fail for a moment.
func rename(from, to string) error {
	err := os.Rename(from, to)
	for i := 0; err != nil && runtime.GOOS == "windows" && i < 10; i++ {
		time.Sleep(50 * time.Millisecond)
		err = os.Rename(from, to)
	}
	return err
}
