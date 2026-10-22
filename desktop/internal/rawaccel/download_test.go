package rawaccel

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type zipEntry struct {
	name string
	data string
	mode fs.FileMode
}

func makeZip(t *testing.T, entries ...zipEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.mode != 0 {
			h.SetMode(e.mode)
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e.data)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// fakeRelease is a small zip laid out like the official one.
func fakeRelease(t *testing.T) ([]byte, Release) {
	files := map[string]string{
		"installer.exe":       "installer",
		"writer.exe":          "writer",
		"rawaccel.exe":        "gui",
		"driver/rawaccel.sys": "driver",
	}
	entries := []zipEntry{{name: "RawAccel/"}, {name: "RawAccel/driver/"}, {name: "RawAccel/doc/FAQ.md", data: "faq"}}
	hashes := map[string]string{}
	for name, data := range files {
		entries = append(entries, zipEntry{name: "RawAccel/" + name, data: data})
		hashes[name] = sha([]byte(data))
	}
	data := makeZip(t, entries...)
	return data, Release{Version: "test", SHA256: sha(data), SizeBytes: int64(len(data)), Root: "RawAccel", Files: hashes}
}

func TestExtractZip(t *testing.T) {
	data, rel := fakeRelease(t)
	dest := filepath.Join(t.TempDir(), "omnisens", "RawAccel")
	if err := ExtractZip(data, "RawAccel", dest); err != nil {
		t.Fatal(err)
	}
	if err := rel.VerifyDir(dest); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(dest, "doc", "FAQ.md")); err != nil || string(b) != "faq" {
		t.Fatalf("doc: %q %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(dest, "RawAccel")); err == nil {
		t.Fatal("root folder not stripped")
	}
	// A tampered file is detected, and extracting again repairs it.
	os.WriteFile(filepath.Join(dest, "installer.exe"), []byte("evil"), 0o644)
	if err := rel.VerifyDir(dest); err == nil {
		t.Fatal("tampered installer accepted")
	}
	if err := ExtractZip(data, "RawAccel", dest); err != nil {
		t.Fatal(err)
	}
	if err := rel.VerifyDir(dest); err != nil {
		t.Fatal(err)
	}
	if err := (Release{}).VerifyDir(dest); err == nil {
		t.Fatal("empty manifest verified")
	}
}

func TestExtractZipRefusesUnsafeEntries(t *testing.T) {
	cases := map[string]zipEntry{
		"dot-dot":          {name: "RawAccel/../evil.txt", data: "x"},
		"leading dot-dot":  {name: "../evil.txt", data: "x"},
		"nested escape":    {name: "RawAccel/a/../../evil.txt", data: "x"},
		"absolute":         {name: "/tmp/evil.txt", data: "x"},
		"drive letter":     {name: "RawAccel/C:/evil.txt", data: "x"},
		"backslash":        {name: `RawAccel\..\evil.txt`, data: "x"},
		"outside root":     {name: "Other/evil.txt", data: "x"},
		"dot segment":      {name: "RawAccel/./evil.txt", data: "x"},
		"empty segment":    {name: "RawAccel/a//evil.txt", data: "x"},
		"symlink":          {name: "RawAccel/link", data: "../../etc/passwd", mode: fs.ModeSymlink | 0o777},
		"nul":              {name: "RawAccel/evil\x00.txt", data: "x"},
		"root traversal":   {name: "RawAccel/..", data: "x"},
		"dot-dot with dir": {name: "RawAccel/../", data: ""},
	}
	for name, e := range cases {
		t.Run(name, func(t *testing.T) {
			base := t.TempDir()
			dest := filepath.Join(base, "out")
			data := makeZip(t, zipEntry{name: "RawAccel/ok.txt", data: "ok"}, e)
			if err := ExtractZip(data, "RawAccel", dest); err == nil {
				t.Fatalf("%q was extracted", e.name)
			}
			// Nothing at all is written when any entry is unsafe.
			entries, _ := os.ReadDir(base)
			if len(entries) != 0 {
				t.Fatalf("wrote %v", entries)
			}
		})
	}
}

func TestExtractZipLimits(t *testing.T) {
	big := strings.Repeat("\x00", maxEntryBytes+1)
	data := makeZip(t, zipEntry{name: "RawAccel/big.bin", data: big})
	if err := ExtractZip(data, "RawAccel", t.TempDir()); err == nil {
		t.Fatal("oversized entry extracted")
	}
	if err := ExtractZip([]byte("not a zip"), "RawAccel", t.TempDir()); err == nil {
		t.Fatal("garbage extracted")
	}
}

func TestFetchChecksSizeAndHash(t *testing.T) {
	data, rel := fakeRelease(t)
	body := data
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		w.Write(body)
	}))
	defer srv.Close()
	rel.URL = srv.URL + "/RawAccel.zip"
	ctx := context.Background()

	got, err := rel.Fetch(ctx, srv.Client())
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("fetch: %v", err)
	}

	tampered := bytes.Clone(data)
	tampered[len(tampered)/2] ^= 0xff
	body = tampered
	if _, err := rel.Fetch(ctx, srv.Client()); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("same-size tampered zip: %v", err)
	}

	body = append(bytes.Clone(data), 0)
	if _, err := rel.Fetch(ctx, srv.Client()); err == nil || !strings.Contains(err.Error(), "size") {
		t.Fatalf("longer zip: %v", err)
	}
	body = data[:len(data)-1]
	if _, err := rel.Fetch(ctx, srv.Client()); err == nil || !strings.Contains(err.Error(), "size") {
		t.Fatalf("shorter zip: %v", err)
	}

	body, status = data, http.StatusNotFound
	if _, err := rel.Fetch(ctx, srv.Client()); err == nil {
		t.Fatal("404 accepted")
	}
}

func TestOfficialRelease(t *testing.T) {
	if Official.SizeBytes != 1542808 || Official.SHA256 != "770fe3ae0919ca3c4d412f58c985eb27f5434decad809f7e8206de4e8852eec4" ||
		Official.URL != "https://github.com/RawAccelOfficial/rawaccel/releases/download/v1.7.1/RawAccel_v1.7.1.zip" || Official.Root != "RawAccel" {
		t.Fatalf("pinned release changed: %+v", Official)
	}
	for _, f := range []string{"installer.exe", "writer.exe", "rawaccel.exe", "driver/rawaccel.sys"} {
		if len(Official.Files[f]) != 64 {
			t.Errorf("no hash for %s", f)
		}
	}
}
