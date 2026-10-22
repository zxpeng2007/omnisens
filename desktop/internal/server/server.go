// Package server is omnisens' local web server: the embedded calibration
// tool plus the JSON API its "This PC" page uses. It only answers requests
// for its own 127.0.0.1 address (DNS-rebinding defence), the API needs the
// per-run token in a header (so other web pages, which cannot set it
// without a CORS preflight that is never granted, cannot use it), and POST
// bodies must be JSON.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// TokenHeader carries the per-run API token.
	TokenHeader  = "X-Omnisens-Token"
	maxBodyBytes = 64 << 10

	csp = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
)

// Backend applies profiles on this PC: Raw Accel on Windows, the evdev
// engine on Linux, nothing elsewhere. Results are merged into the JSON
// answer next to "ok": true; errors that implement HTTPStatus() int choose
// the status code, all others are 500. The message is shown to the user.
type Backend interface {
	// Method is "rawaccel", "engine" or "none".
	Method() string
	// Info adds the method's object ("rawAccel" or "engine") to /api/info.
	Info() map[string]any
	Apply(code string) (map[string]any, error)
	Remove() (map[string]any, error)
	Pause() (map[string]any, error)
	Resume() (map[string]any, error)
	SetRawAccelDir(dir string) (map[string]any, error)
	InstallRawAccel(ctx context.Context) (map[string]any, error)
	// SetAutostart turns applying at login on or off; code is the profile
	// for systems that need it ("" = the last applied one).
	SetAutostart(enabled bool, code string) (map[string]any, error)
	// Close runs when the app exits (stop the engine, undo a pause).
	Close() error
}

// Options configure a Server.
type Options struct {
	Port    int    // the port the listener is bound to
	Token   string // API token for this run
	Version string
	Static  fs.FS // the web tool, index.html at its root
	Backend Backend
	Logf    func(format string, args ...any) // server-side errors; may be nil
}

// Server is the omnisens HTTP handler.
type Server struct {
	opts     Options
	hosts    [2]string
	quit     chan struct{}
	quitOnce sync.Once
}

// New returns a Server for opts.
func New(opts Options) *Server {
	p := strconv.Itoa(opts.Port)
	return &Server{
		opts:  opts,
		hosts: [2]string{"127.0.0.1:" + p, "localhost:" + p},
		quit:  make(chan struct{}),
	}
}

// Quit is closed once POST /api/quit was answered.
func (s *Server) Quit() <-chan struct{} { return s.quit }

// StatusError is an error with an HTTP status and a message for the user.
type StatusError struct {
	Status int
	Msg    string
}

func (e *StatusError) Error() string   { return e.Msg }
func (e *StatusError) HTTPStatus() int { return e.Status }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", csp)
	isAPI := r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/")
	if isAPI {
		h.Set("Cache-Control", "no-store")
	}
	if !s.hostAllowed(r.Host) {
		writeError(w, http.StatusForbidden, "This address is not served here. Open the page the omnisens app opened (http://127.0.0.1:"+strconv.Itoa(s.opts.Port)+"/).")
		return
	}
	if isAPI {
		s.serveAPI(w, r)
		return
	}
	s.serveStatic(w, r)
}

func (s *Server) hostAllowed(host string) bool {
	for _, h := range s.hosts {
		if strings.EqualFold(host, h) {
			return true
		}
	}
	return false
}

func (s *Server) tokenOK(r *http.Request) bool {
	got := r.Header.Get(TokenHeader)
	return s.opts.Token != "" && subtle.ConstantTimeCompare([]byte(got), []byte(s.opts.Token)) == 1
}

type handler struct {
	method string
	serve  func(s *Server, r *http.Request, body []byte) (map[string]any, error)
}

var routes = map[string]handler{
	"/api/ping": {http.MethodGet, func(*Server, *http.Request, []byte) (map[string]any, error) {
		return map[string]any{}, nil
	}},
	"/api/info": {http.MethodGet, func(s *Server, _ *http.Request, _ []byte) (map[string]any, error) {
		return s.info(), nil
	}},
	"/api/apply": {http.MethodPost, func(s *Server, _ *http.Request, body []byte) (map[string]any, error) {
		var req struct {
			Code string `json:"code"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if strings.TrimSpace(req.Code) == "" {
			return nil, &StatusError{http.StatusBadRequest, `Send the profile to apply as {"code": "omni1...."}.`}
		}
		return s.opts.Backend.Apply(req.Code)
	}},
	"/api/remove": {http.MethodPost, func(s *Server, _ *http.Request, body []byte) (map[string]any, error) {
		if err := decode(body, &struct{}{}); err != nil {
			return nil, err
		}
		return s.opts.Backend.Remove()
	}},
	"/api/pause": {http.MethodPost, func(s *Server, _ *http.Request, body []byte) (map[string]any, error) {
		if err := decode(body, &struct{}{}); err != nil {
			return nil, err
		}
		return s.opts.Backend.Pause()
	}},
	"/api/resume": {http.MethodPost, func(s *Server, _ *http.Request, body []byte) (map[string]any, error) {
		if err := decode(body, &struct{}{}); err != nil {
			return nil, err
		}
		return s.opts.Backend.Resume()
	}},
	"/api/rawaccel/dir": {http.MethodPost, func(s *Server, _ *http.Request, body []byte) (map[string]any, error) {
		var req struct {
			Dir string `json:"dir"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		return s.opts.Backend.SetRawAccelDir(req.Dir)
	}},
	"/api/rawaccel/install": {http.MethodPost, func(s *Server, r *http.Request, body []byte) (map[string]any, error) {
		if err := decode(body, &struct{}{}); err != nil {
			return nil, err
		}
		return s.opts.Backend.InstallRawAccel(r.Context())
	}},
	"/api/autostart": {http.MethodPost, func(s *Server, _ *http.Request, body []byte) (map[string]any, error) {
		var req struct {
			Enabled *bool  `json:"enabled"`
			Code    string `json:"code"`
		}
		if err := decode(body, &req); err != nil {
			return nil, err
		}
		if req.Enabled == nil {
			return nil, &StatusError{http.StatusBadRequest, `Send {"enabled": true} or {"enabled": false}.`}
		}
		return s.opts.Backend.SetAutostart(*req.Enabled, req.Code)
	}},
	"/api/quit": {http.MethodPost, func(s *Server, _ *http.Request, body []byte) (map[string]any, error) {
		if err := decode(body, &struct{}{}); err != nil {
			return nil, err
		}
		return map[string]any{}, nil
	}},
}

func (s *Server) serveAPI(w http.ResponseWriter, r *http.Request) {
	if !s.tokenOK(r) {
		writeError(w, http.StatusUnauthorized, "This page is not authorised to use the omnisens app. Open it from the omnisens app (or start omnisens again).")
		return
	}
	route, ok := routes[r.URL.Path]
	if !ok {
		writeError(w, http.StatusNotFound, "Unknown API call "+r.URL.Path+".")
		return
	}
	if r.Method != route.method {
		w.Header().Set("Allow", route.method)
		writeError(w, http.StatusMethodNotAllowed, "Use "+route.method+" for "+r.URL.Path+".")
		return
	}
	var body []byte
	if r.Method == http.MethodPost {
		mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mt != "application/json" {
			writeError(w, http.StatusUnsupportedMediaType, "Send the request as Content-Type: application/json.")
			return
		}
		body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				writeError(w, http.StatusRequestEntityTooLarge, "The request is too large.")
				return
			}
			writeError(w, http.StatusBadRequest, "Could not read the request.")
			return
		}
	}
	res, err := route.serve(s, r, body)
	if err != nil {
		status := http.StatusInternalServerError
		var se interface{ HTTPStatus() int }
		if errors.As(err, &se) && se.HTTPStatus() >= 400 && se.HTTPStatus() <= 599 {
			status = se.HTTPStatus()
		}
		if status >= 500 && s.opts.Logf != nil {
			s.opts.Logf("%s: %v", r.URL.Path, err)
		}
		writeError(w, status, err.Error())
		return
	}
	out := make(map[string]any, len(res)+1)
	for k, v := range res {
		out[k] = v
	}
	out["ok"] = true
	writeJSON(w, http.StatusOK, out)
	if r.URL.Path == "/api/quit" {
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		s.quitOnce.Do(func() { close(s.quit) })
	}
}

func (s *Server) info() map[string]any {
	info := map[string]any{
		"app":     "omnisens",
		"version": s.opts.Version,
		"os":      runtime.GOOS,
		"arch":    runtime.GOARCH,
		"method":  s.opts.Backend.Method(),
	}
	for k, v := range s.opts.Backend.Info() {
		info[k] = v
	}
	return info
}

// decode reads a JSON object body; an empty body counts as {}.
func decode(body []byte, v any) error {
	if len(strings.TrimSpace(string(body))) == 0 {
		return nil
	}
	if trimmed := strings.TrimSpace(string(body)); !strings.HasPrefix(trimmed, "{") {
		return &StatusError{http.StatusBadRequest, "The request body must be a JSON object."}
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	if err := dec.Decode(v); err != nil {
		return &StatusError{http.StatusBadRequest, "The request body is not valid JSON for this call: " + err.Error()}
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return &StatusError{http.StatusBadRequest, "The request body has data after the JSON object."}
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		status = http.StatusInternalServerError
		b = []byte(`{"error":"The answer could not be encoded."}`)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(append(b, '\n'))
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// contentTypes is explicit because Go's mime package reads the Windows
// registry, where .js is sometimes text/plain (then module scripts fail).
var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".ico":   "image/x-icon",
	".webp":  "image/webp",
	".woff2": "font/woff2",
	".txt":   "text/plain; charset=utf-8",
	".md":    "text/plain; charset=utf-8",
}

const notEmbedded = "This omnisens build has no web tool embedded. Run `go generate ./...` in desktop/ and build again.\n"

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if !fs.ValidPath(name) || hidden(name) || s.opts.Static == nil {
		s.notFound(w, name)
		return
	}
	f, err := s.opts.Static.Open(name)
	if err != nil {
		s.notFound(w, name)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		s.notFound(w, name) // no directory listings
		return
	}
	ctype, ok := contentTypes[strings.ToLower(path.Ext(name))]
	if !ok {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "no-cache")
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		b, err := io.ReadAll(f)
		if err != nil {
			http.Error(w, "read error", http.StatusInternalServerError)
			return
		}
		rs = strings.NewReader(string(b))
	}
	http.ServeContent(w, r, name, time.Time{}, rs)
}

func (s *Server) notFound(w http.ResponseWriter, name string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if name == "index.html" {
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, notEmbedded)
		return
	}
	http.Error(w, "404 page not found", http.StatusNotFound)
}

// hidden reports dotfiles such as dist/.keep.
func hidden(name string) bool {
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") {
			return true
		}
	}
	return false
}

// Unsupported is the Backend for systems where omnisens cannot apply
// profiles itself; every action answers 501 with Message.
type Unsupported struct{ Message string }

func (u Unsupported) Method() string                       { return "none" }
func (u Unsupported) Info() map[string]any                 { return nil }
func (u Unsupported) err() error                           { return &StatusError{http.StatusNotImplemented, u.Message} }
func (u Unsupported) Apply(string) (map[string]any, error) { return nil, u.err() }
func (u Unsupported) Remove() (map[string]any, error)      { return nil, u.err() }
func (u Unsupported) Pause() (map[string]any, error)       { return nil, u.err() }
func (u Unsupported) Resume() (map[string]any, error)      { return nil, u.err() }
func (u Unsupported) SetRawAccelDir(string) (map[string]any, error) {
	return nil, u.err()
}
func (u Unsupported) InstallRawAccel(context.Context) (map[string]any, error) {
	return nil, u.err()
}
func (u Unsupported) SetAutostart(bool, string) (map[string]any, error) { return nil, u.err() }
func (u Unsupported) Close() error                                      { return nil }
