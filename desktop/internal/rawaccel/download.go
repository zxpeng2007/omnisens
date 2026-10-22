package rawaccel

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Release is a pinned Raw Accel download.
type Release struct {
	Version   string `json:"version"`
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes"`
	// Root is the folder every entry of the zip lives in.
	Root string `json:"-"`
	// Files are the SHA-256 of the files that matter inside the folder
	// (slash paths). An existing folder is reused only when they all match,
	// and they are checked again right before installer.exe runs elevated.
	Files map[string]string `json:"-"`
}

// Official is Raw Accel v1.7.1 from its official GitHub release. The file
// hashes were taken from that verified zip.
var Official = Release{
	Version:   "1.7.1",
	URL:       "https://github.com/RawAccelOfficial/rawaccel/releases/download/v1.7.1/RawAccel_v1.7.1.zip",
	SHA256:    "770fe3ae0919ca3c4d412f58c985eb27f5434decad809f7e8206de4e8852eec4",
	SizeBytes: 1542808,
	Root:      "RawAccel",
	Files: map[string]string{
		"installer.exe":       "b3b4948de9470a5727390ed016507b59d2c628463e42aaf1b75e906ee04f58a9",
		"uninstaller.exe":     "62090da1ecd73aa18c2119650a4384d80691fcbabb90716cf5f731ed084a51ca",
		"writer.exe":          "b53e29c7689b9d72838ffbfd1502b8d0407160d3f77b54eb15a7c632f689aa04",
		"rawaccel.exe":        "64cbf09cbb181b81abd3432e9184b896dd227ec258deda547074f5985cfad88d",
		"wrapper.dll":         "e17d540fb0bb5e47ba7c8e01aff39f1570bfb7ef673a1ddc0bccd2a26f9efb78",
		"Newtonsoft.Json.dll": "b624949df8b0e3a6153fdfb730a7c6f4990b6592ee0d922e1788433d276610f3",
		"driver/rawaccel.sys": "8a62c4deef2774b43a7363b352eda79897533a1080c9c26ffeff0559e43358d7",
	},
}

// Fetch downloads the release zip and checks its size and SHA-256.
func (r Release) Fetch(ctx context.Context, client *http.Client) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.URL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not download Raw Accel: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("could not download Raw Accel: the server answered %s", resp.Status)
	}
	if resp.ContentLength >= 0 && resp.ContentLength != r.SizeBytes {
		return nil, fmt.Errorf("the Raw Accel download has the wrong size (%d bytes, expected %d); nothing was installed", resp.ContentLength, r.SizeBytes)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, r.SizeBytes+1))
	if err != nil {
		return nil, fmt.Errorf("could not download Raw Accel: %w", err)
	}
	if int64(len(data)) != r.SizeBytes {
		return nil, fmt.Errorf("the Raw Accel download has the wrong size (%d bytes, expected %d); nothing was installed", len(data), r.SizeBytes)
	}
	sum := sha256.Sum256(data)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), r.SHA256) {
		return nil, errors.New("the Raw Accel download does not match the official release (SHA-256 differs); nothing was installed")
	}
	return data, nil
}

// VerifyDir reports whether dir holds every file of r.Files unchanged.
func (r Release) VerifyDir(dir string) error {
	if len(r.Files) == 0 {
		return errors.New("no file hashes to check against")
	}
	for name, want := range r.Files {
		got, err := fileSHA256(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil {
			return err
		}
		if !strings.EqualFold(got, want) {
			return fmt.Errorf("%s does not match the official Raw Accel %s", name, r.Version)
		}
	}
	return nil
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Extraction limits; the official zip is 2.9 MB unpacked.
const (
	maxEntryBytes = 32 << 20
	maxTotalBytes = 64 << 20
)

// ExtractZip writes the entries of a zip below root/ into dest (root itself
// is stripped). It refuses entries outside root/, paths that would escape
// dest (zip-slip), links and oversized files.
func ExtractZip(data []byte, root, dest string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil && !errors.Is(err, zip.ErrInsecurePath) {
		return fmt.Errorf("the Raw Accel zip is damaged: %w", err)
	}
	if zr == nil {
		return errors.New("the Raw Accel zip is damaged")
	}
	dest, err = filepath.Abs(dest)
	if err != nil {
		return err
	}
	type entry struct {
		f   *zip.File
		rel string
	}
	var entries []entry
	var total uint64
	for _, f := range zr.File {
		rel, err := entryPath(f.Name, root)
		if err != nil {
			return err
		}
		if rel == "" {
			continue
		}
		mode := f.Mode()
		if mode&fs.ModeSymlink != 0 || (!mode.IsDir() && !mode.IsRegular()) {
			return fmt.Errorf("the Raw Accel zip contains a link or special file (%q)", f.Name)
		}
		if f.UncompressedSize64 > maxEntryBytes {
			return fmt.Errorf("the Raw Accel zip contains an oversized file (%q)", f.Name)
		}
		total += f.UncompressedSize64
		if total > maxTotalBytes {
			return errors.New("the Raw Accel zip unpacks to too much data")
		}
		entries = append(entries, entry{f, rel})
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	for _, e := range entries {
		target := filepath.Join(dest, filepath.FromSlash(e.rel))
		if r, err := filepath.Rel(dest, target); err != nil || !filepath.IsLocal(r) {
			return fmt.Errorf("the Raw Accel zip has an unsafe path (%q)", e.f.Name)
		}
		if e.f.Mode().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := extractFile(e.f, target); err != nil {
			return err
		}
	}
	return nil
}

// entryPath checks a zip entry name and returns it relative to root ("" for
// the root folder itself).
func entryPath(name, root string) (string, error) {
	bad := func() (string, error) { return "", fmt.Errorf("the Raw Accel zip has an unsafe path (%q)", name) }
	if strings.ContainsAny(name, "\\:\x00") || strings.HasPrefix(name, "/") {
		return bad()
	}
	prefix := root + "/"
	if name == prefix {
		return "", nil
	}
	if !strings.HasPrefix(name, prefix) {
		return "", fmt.Errorf("the Raw Accel zip has an unexpected entry (%q)", name)
	}
	rel := strings.TrimSuffix(strings.TrimPrefix(name, prefix), "/")
	if rel == "" || path.Clean(rel) != rel || !filepath.IsLocal(filepath.FromSlash(rel)) {
		return bad()
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "." || part == ".." || part == "" {
			return bad()
		}
	}
	return rel, nil
}

func extractFile(f *zip.File, target string) error {
	rc, err := f.Open()
	if err != nil {
		return fmt.Errorf("the Raw Accel zip is damaged (%s): %w", f.Name, err)
	}
	defer rc.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("could not write %s (is Raw Accel running from that folder?): %w", target, err)
	}
	n, err := io.Copy(out, io.LimitReader(rc, maxEntryBytes+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("could not unpack %s: %w", f.Name, err)
	}
	if n > maxEntryBytes {
		return fmt.Errorf("the Raw Accel zip contains an oversized file (%q)", f.Name)
	}
	return nil
}
