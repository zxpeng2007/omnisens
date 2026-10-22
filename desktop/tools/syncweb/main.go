// Command syncweb copies the web tool into internal/webui/dist for embedding,
// in the same layout as the GitHub Pages site (.github/workflows/pages.yml):
// index.html, css/, js/, web/assets/ (if any) and the sample session as
// assets/sample-session.json. It is run by `go generate ./...`.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const module = "github.com/zxpeng2007/omnisens/desktop"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "syncweb:", err)
		os.Exit(1)
	}
}

func run() error {
	modDir, err := findModule()
	if err != nil {
		return err
	}
	web := filepath.Join(filepath.Dir(modDir), "web")
	dst := filepath.Join(modDir, "internal", "webui", "dist")
	if _, err := os.Stat(filepath.Join(web, "index.html")); err != nil {
		return fmt.Errorf("web tool not found next to the desktop module: %w", err)
	}
	if err := clean(dst); err != nil {
		return err
	}
	n := 0
	copies := [][2]string{
		{"index.html", "index.html"},
		{"css", "css"},
		{"js", "js"},
		{"assets", "assets"},
		{filepath.Join("test", "fixtures", "sample-session.json"), filepath.Join("assets", "sample-session.json")},
	}
	for _, c := range copies {
		src := filepath.Join(web, c[0])
		if _, err := os.Stat(src); errors.Is(err, fs.ErrNotExist) && c[0] == "assets" {
			continue
		}
		k, err := copyTree(src, filepath.Join(dst, c[1]))
		if err != nil {
			return err
		}
		n += k
	}
	fmt.Printf("syncweb: copied %d files from %s to %s\n", n, web, dst)
	return nil
}

// findModule walks up from the working directory to this module's go.mod.
func findModule() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if isModule(filepath.Join(dir, "go.mod")) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("run this inside the omnisens desktop module")
		}
		dir = parent
	}
}

func isModule(goMod string) bool {
	f, err := os.Open(goMod)
	if err != nil {
		return false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if fields := strings.Fields(sc.Text()); len(fields) == 2 && fields[0] == "module" {
			return fields[1] == module
		}
	}
	return false
}

// clean empties dst except the committed .keep placeholder.
func clean(dst string) error {
	entries, err := os.ReadDir(dst)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	for _, e := range entries {
		if e.Name() == ".keep" {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dst, e.Name())); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dst, ".keep"), nil, 0o644)
}

// copyTree copies a file or a directory of regular files; dotfiles and
// symlinks are skipped.
func copyTree(src, dst string) (int, error) {
	n := 0
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		if strings.HasPrefix(d.Name(), ".") && rel != "." {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		target := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			return os.MkdirAll(target, 0o755)
		case d.Type().IsRegular():
			n++
			return copyFile(p, target)
		}
		return nil
	})
	return n, err
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
