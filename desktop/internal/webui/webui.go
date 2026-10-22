// Package webui embeds the calibration web tool (web/) into the app.
// dist/ is filled by `go generate ./...` (tools/syncweb) with the same layout
// as the GitHub Pages site; only dist/.keep is committed, so the package also
// compiles before generation and then serves no pages.
package webui

import (
	"embed"
	"io/fs"
)

//go:generate go run ../../tools/syncweb

//go:embed all:dist
var dist embed.FS

// FS is the web tool, with index.html at its root.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // "dist" is a valid literal path
	}
	return sub
}

// Available reports whether the web tool was embedded (go generate ran).
func Available() bool {
	_, err := fs.Stat(FS(), "index.html")
	return err == nil
}
