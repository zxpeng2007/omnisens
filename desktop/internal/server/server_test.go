package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"
)

const (
	testPort  = 47123
	testToken = "0123456789abcdef0123456789abcdef"
	goodHost  = "127.0.0.1:47123"
)

type call struct {
	name string
	arg  any
}

type fakeBackend struct {
	calls []call
	err   error
}

func (f *fakeBackend) record(name string, arg any) (map[string]any, error) {
	f.calls = append(f.calls, call{name, arg})
	if f.err != nil {
		return nil, f.err
	}
	return map[string]any{"did": name}, nil
}

func (f *fakeBackend) Method() string { return "rawaccel" }
func (f *fakeBackend) Info() map[string]any {
	return map[string]any{"rawAccel": map[string]any{"found": true}}
}
func (f *fakeBackend) Apply(code string) (map[string]any, error) { return f.record("apply", code) }
func (f *fakeBackend) Remove() (map[string]any, error)           { return f.record("remove", nil) }
func (f *fakeBackend) Pause() (map[string]any, error)            { return f.record("pause", nil) }
func (f *fakeBackend) Resume() (map[string]any, error)           { return f.record("resume", nil) }
func (f *fakeBackend) SetRawAccelDir(dir string) (map[string]any, error) {
	return f.record("dir", dir)
}
func (f *fakeBackend) InstallRawAccel(ctx context.Context) (map[string]any, error) {
	if ctx == nil {
		return nil, errors.New("no context")
	}
	return f.record("install", nil)
}
func (f *fakeBackend) SetAutostart(enabled bool, code string) (map[string]any, error) {
	return f.record("autostart", [2]any{enabled, code})
}
func (f *fakeBackend) Close() error { return nil }

var static = fstest.MapFS{
	"index.html":                 {Data: []byte("<!doctype html><title>omnisens</title>")},
	"js/app.js":                  {Data: []byte("export {};")},
	"css/style.css":              {Data: []byte("body{}")},
	".keep":                      {Data: nil},
	"assets/sample-session.json": {Data: []byte("{}")},
}

func newTest() (*Server, *fakeBackend) {
	b := &fakeBackend{}
	return New(Options{Port: testPort, Token: testToken, Version: "1.2.3", Static: static, Backend: b}), b
}

type req struct {
	method, path, host, token, ctype, body string
	header                                 map[string]string
}

func do(s *Server, r req) *httptest.ResponseRecorder {
	if r.method == "" {
		r.method = http.MethodGet
	}
	if r.host == "" {
		r.host = goodHost
	}
	hr := httptest.NewRequest(r.method, "http://"+r.host+r.path, strings.NewReader(r.body))
	hr.Host = r.host
	if r.token != "" {
		hr.Header.Set(TokenHeader, r.token)
	}
	if r.ctype != "" {
		hr.Header.Set("Content-Type", r.ctype)
	}
	for k, v := range r.header {
		hr.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, hr)
	return w
}

func post(path, body string) req {
	return req{method: http.MethodPost, path: path, token: testToken, ctype: "application/json", body: body}
}

func jsonBody(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("content type %q for %s", ct, w.Body)
	}
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("not JSON: %s", w.Body)
	}
	return m
}

func TestHostCheck(t *testing.T) {
	s, _ := newTest()
	for _, host := range []string{"evil.example", "evil.example:47123", "127.0.0.1:1", "127.0.0.1", "localhost", "[::1]:47123", "127.0.0.2:47123", "0.0.0.0:47123"} {
		for _, path := range []string{"/", "/api/ping", "/js/app.js"} {
			w := do(s, req{path: path, host: host, token: testToken})
			if w.Code != http.StatusForbidden {
				t.Errorf("host %q path %s: %d", host, path, w.Code)
			}
			if _, ok := jsonBody(t, w)["error"]; !ok {
				t.Errorf("no error message")
			}
		}
	}
	for _, host := range []string{goodHost, "localhost:47123", "LocalHost:47123"} {
		if w := do(s, req{path: "/api/ping", host: host, token: testToken}); w.Code != http.StatusOK {
			t.Errorf("host %q: %d", host, w.Code)
		}
	}
}

func TestTokenRequired(t *testing.T) {
	s, b := newTest()
	for _, tok := range []string{"", "wrong", testToken[:31], testToken + "0", strings.ToUpper(testToken)} {
		w := do(s, req{path: "/api/info", token: tok})
		if w.Code != http.StatusUnauthorized {
			t.Errorf("token %q: %d", tok, w.Code)
		}
		w = do(s, req{method: http.MethodPost, path: "/api/apply", token: tok, ctype: "application/json", body: `{"code":"omni1.x"}`})
		if w.Code != http.StatusUnauthorized {
			t.Errorf("post with token %q: %d", tok, w.Code)
		}
	}
	// The token in the page URL is not enough for the API.
	if w := do(s, req{path: "/api/info?t=" + testToken}); w.Code != http.StatusUnauthorized {
		t.Errorf("query token accepted: %d", w.Code)
	}
	if len(b.calls) != 0 {
		t.Fatalf("backend called: %v", b.calls)
	}
	// An empty configured token never matches.
	s2 := New(Options{Port: testPort, Backend: b, Static: static})
	if w := do(s2, req{path: "/api/ping"}); w.Code != http.StatusUnauthorized {
		t.Fatalf("empty token: %d", w.Code)
	}
}

func TestPostNeedsJSON(t *testing.T) {
	s, b := newTest()
	for _, ct := range []string{"", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx", "text/json"} {
		r := post("/api/apply", `{"code":"omni1.x"}`)
		r.ctype = ct
		if w := do(s, r); w.Code != http.StatusUnsupportedMediaType {
			t.Errorf("content type %q: %d", ct, w.Code)
		}
	}
	if len(b.calls) != 0 {
		t.Fatal("backend called")
	}
	r := post("/api/apply", `{"code":"omni1.x"}`)
	r.ctype = "application/json; charset=UTF-8"
	if w := do(s, r); w.Code != http.StatusOK {
		t.Fatalf("charset parameter: %d %s", w.Code, w.Body)
	}
}

func TestNoCORS(t *testing.T) {
	s, b := newTest()
	pre := req{method: http.MethodOptions, path: "/api/apply", header: map[string]string{
		"Origin":                         "https://evil.example",
		"Access-Control-Request-Method":  "POST",
		"Access-Control-Request-Headers": "content-type,x-omnisens-token",
	}}
	w := do(s, pre)
	if w.Code < 400 {
		t.Fatalf("preflight answered %d", w.Code)
	}
	pre.host = "localhost:47123"
	pre.header["Origin"] = "http://localhost:47123"
	responses := []*httptest.ResponseRecorder{w, do(s, pre),
		do(s, req{path: "/api/info", token: testToken, header: map[string]string{"Origin": "https://evil.example"}}),
		do(s, req{path: "/", header: map[string]string{"Origin": "https://evil.example"}}),
	}
	for i, w := range responses {
		for k := range w.Header() {
			if strings.HasPrefix(strings.ToLower(k), "access-control-") {
				t.Errorf("response %d has %s", i, k)
			}
		}
	}
	if len(b.calls) != 0 {
		t.Fatal("backend called by a preflight")
	}
}

func TestSecurityHeaders(t *testing.T) {
	s, _ := newTest()
	for _, r := range []req{{path: "/"}, {path: "/js/app.js"}, {path: "/missing"}, {path: "/api/ping", token: testToken}, {path: "/api/ping"}, {path: "/", host: "evil.example"}} {
		w := do(s, r)
		h := w.Header()
		if h.Get("Content-Security-Policy") != "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" {
			t.Errorf("%s: CSP %q", r.path, h.Get("Content-Security-Policy"))
		}
		if h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Referrer-Policy") != "no-referrer" {
			t.Errorf("%s: headers %v", r.path, h)
		}
		if strings.HasPrefix(r.path, "/api/") && h.Get("Cache-Control") != "no-store" {
			t.Errorf("%s: cache %q", r.path, h.Get("Cache-Control"))
		}
	}
}

func TestStatic(t *testing.T) {
	s, _ := newTest()
	cases := []struct {
		path, ctype string
		code        int
	}{
		{"/", "text/html; charset=utf-8", 200},
		{"/index.html", "text/html; charset=utf-8", 200},
		{"/?t=" + testToken, "text/html; charset=utf-8", 200},
		{"/js/app.js", "text/javascript; charset=utf-8", 200},
		{"/css/style.css", "text/css; charset=utf-8", 200},
		{"/assets/sample-session.json", "application/json; charset=utf-8", 200},
		{"/js/", "", 404},
		{"/js", "", 404},
		{"/.keep", "", 404},
		{"/missing.js", "", 404},
		{"/../../../etc/passwd", "", 404},
		{"/js/../../index.html", "text/html; charset=utf-8", 200},
	}
	for _, c := range cases {
		w := do(s, req{path: c.path})
		if w.Code != c.code || (c.ctype != "" && w.Header().Get("Content-Type") != c.ctype) {
			t.Errorf("%s: %d %q", c.path, w.Code, w.Header().Get("Content-Type"))
		}
	}
	if w := do(s, req{path: "/"}); !strings.Contains(w.Body.String(), "<title>omnisens</title>") {
		t.Fatal("index body")
	}
	if w := do(s, req{method: http.MethodPost, path: "/", ctype: "application/json", body: "{}"}); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /: %d", w.Code)
	}
	if w := do(s, req{method: http.MethodHead, path: "/js/app.js"}); w.Code != 200 || w.Body.Len() != 0 {
		t.Fatalf("HEAD: %d %q", w.Code, w.Body)
	}
	empty := New(Options{Port: testPort, Token: testToken, Static: fstest.MapFS{".keep": {}}, Backend: &fakeBackend{}})
	if w := do(empty, req{path: "/"}); w.Code != 404 || !strings.Contains(w.Body.String(), "go generate") {
		t.Fatalf("not embedded: %d %s", w.Code, w.Body)
	}
}

func TestAPI(t *testing.T) {
	s, b := newTest()
	if m := jsonBody(t, do(s, req{path: "/api/ping", token: testToken})); m["ok"] != true || len(m) != 1 {
		t.Fatalf("ping %v", m)
	}
	info := jsonBody(t, do(s, req{path: "/api/info", token: testToken}))
	if info["app"] != "omnisens" || info["version"] != "1.2.3" || info["os"] != runtime.GOOS || info["arch"] != runtime.GOARCH ||
		info["method"] != "rawaccel" || info["rawAccel"].(map[string]any)["found"] != true {
		t.Fatalf("info %v", info)
	}

	ok := []struct {
		r    req
		want call
	}{
		{post("/api/apply", `{"code":"omni1.abc"}`), call{"apply", "omni1.abc"}},
		{post("/api/remove", `{}`), call{"remove", nil}},
		{post("/api/remove", ``), call{"remove", nil}},
		{post("/api/pause", `{}`), call{"pause", nil}},
		{post("/api/resume", " {} \n"), call{"resume", nil}},
		{post("/api/rawaccel/dir", `{"dir":"C:\\Raw Accel"}`), call{"dir", `C:\Raw Accel`}},
		{post("/api/rawaccel/install", `{}`), call{"install", nil}},
		{post("/api/autostart", `{"enabled":true}`), call{"autostart", [2]any{true, ""}}},
		{post("/api/autostart", `{"enabled":false,"code":"omni1.x"}`), call{"autostart", [2]any{false, "omni1.x"}}},
	}
	for _, c := range ok {
		b.calls = nil
		w := do(s, c.r)
		m := jsonBody(t, w)
		if w.Code != 200 || m["ok"] != true || m["did"] != c.want.name {
			t.Errorf("%s: %d %v", c.r.path, w.Code, m)
		}
		if len(b.calls) != 1 || b.calls[0] != c.want {
			t.Errorf("%s: calls %v", c.r.path, b.calls)
		}
	}

	b.calls = nil
	bad := []struct {
		r    req
		code int
	}{
		{post("/api/apply", `{}`), 400},
		{post("/api/apply", `{"code":"  "}`), 400},
		{post("/api/apply", `{"code":`), 400},
		{post("/api/apply", `{"code":1}`), 400},
		{post("/api/apply", `["omni1.x"]`), 400},
		{post("/api/apply", `{"code":"a"}{"code":"b"}`), 400},
		{post("/api/apply", `{"code":"`+strings.Repeat("a", 70<<10)+`"}`), 413},
		{post("/api/autostart", `{}`), 400},
		{post("/api/autostart", `{"enabled":"yes"}`), 400},
		{post("/api/info", `{}`), 405},
		{req{path: "/api/apply", token: testToken}, 405},
		{req{path: "/api/nope", token: testToken}, 404},
		{req{path: "/api", token: testToken}, 404},
		{post("/api/rawaccel", `{}`), 404},
	}
	for _, c := range bad {
		w := do(s, c.r)
		if w.Code != c.code {
			t.Errorf("%s %q: %d, want %d (%s)", c.r.path, c.r.body, w.Code, c.code, w.Body)
		}
		if msg, _ := jsonBody(t, w)["error"].(string); msg == "" {
			t.Errorf("%s: no error message", c.r.path)
		}
	}
	if w := do(s, req{path: "/api/apply", token: testToken}); w.Header().Get("Allow") != "POST" {
		t.Error("405 without Allow")
	}
	if len(b.calls) != 0 {
		t.Fatalf("backend called for bad requests: %v", b.calls)
	}
}

func TestBackendErrors(t *testing.T) {
	s, b := newTest()
	b.err = &StatusError{Status: http.StatusConflict, Msg: "Restart your PC first."}
	w := do(s, post("/api/apply", `{"code":"omni1.x"}`))
	if m := jsonBody(t, w); w.Code != 409 || m["error"] != "Restart your PC first." || m["ok"] != nil {
		t.Fatalf("status error: %d %v", w.Code, m)
	}
	var logged []string
	s.opts.Logf = func(f string, a ...any) { logged = append(logged, f) }
	b.err = errors.New("disk full")
	w = do(s, post("/api/remove", `{}`))
	if m := jsonBody(t, w); w.Code != 500 || m["error"] != "disk full" || len(logged) != 1 {
		t.Fatalf("plain error: %d %v %v", w.Code, m, logged)
	}
	b.err = &StatusError{Status: 200, Msg: "odd"}
	if w := do(s, post("/api/pause", `{}`)); w.Code != 500 {
		t.Fatalf("non-error status: %d", w.Code)
	}
}

func TestQuit(t *testing.T) {
	s, _ := newTest()
	select {
	case <-s.Quit():
		t.Fatal("closed early")
	default:
	}
	if w := do(s, req{path: "/api/quit", token: testToken}); w.Code != 405 {
		t.Fatalf("GET quit: %d", w.Code)
	}
	w := do(s, post("/api/quit", `{}`))
	if m := jsonBody(t, w); w.Code != 200 || m["ok"] != true {
		t.Fatalf("quit: %v", m)
	}
	select {
	case <-s.Quit():
	default:
		t.Fatal("quit channel not closed")
	}
	do(s, post("/api/quit", `{}`)) // a second quit must not panic
}

func TestUnsupported(t *testing.T) {
	u := Unsupported{Message: "not on this OS"}
	s := New(Options{Port: testPort, Token: testToken, Static: static, Backend: u})
	if m := jsonBody(t, do(s, req{path: "/api/info", token: testToken})); m["method"] != "none" {
		t.Fatalf("info %v", m)
	}
	for _, p := range []string{"/api/apply", "/api/remove", "/api/pause", "/api/resume", "/api/rawaccel/dir", "/api/rawaccel/install", "/api/autostart"} {
		w := do(s, post(p, `{"code":"omni1.x","dir":"x","enabled":true}`))
		if m := jsonBody(t, w); w.Code != http.StatusNotImplemented || m["error"] != "not on this OS" {
			t.Errorf("%s: %d %v", p, w.Code, m)
		}
	}
}
