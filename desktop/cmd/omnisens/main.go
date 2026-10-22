// Command omnisens is the desktop app: it serves the calibration tool on
// http://127.0.0.1 from an embedded copy (works offline) and applies the
// calibrated profile to this PC (Windows: Raw Accel; Linux: the built-in
// evdev engine; elsewhere calibration only).
//
//	omnisens [--no-browser] [--port N]   start the app (or open the running one)
//	omnisens apply <profile-code>        apply a profile without the browser
//	omnisens remove                      remove it again
//	omnisens linux-setup [--install]     one-time Linux permission setup
//	omnisens --version
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/zxpeng2007/omnisens/desktop/internal/server"
	"github.com/zxpeng2007/omnisens/desktop/internal/state"
	"github.com/zxpeng2007/omnisens/desktop/internal/webui"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const usage = `omnisens %s - per-direction mouse sensitivity, calibrated and applied on this PC

Usage:
  omnisens [--no-browser] [--port N]   start the app and open it in your browser
  omnisens apply <profile-code>        apply a profile code (omni1....)
  omnisens remove                      remove the applied profile
  omnisens linux-setup [--install]     Linux: show (or, as root, do) the one-time permission setup
  omnisens --version                   print the version

Options:
`

func main() {
	log.SetFlags(0)
	log.SetPrefix("omnisens: ")
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	fl := flag.NewFlagSet("omnisens", flag.ContinueOnError)
	fl.SetOutput(os.Stderr)
	noBrowser := fl.Bool("no-browser", false, "do not open the browser")
	port := fl.Int("port", 0, "port on 127.0.0.1 (0 = a free random port)")
	showVersion := fl.Bool("version", false, "print the version and exit")
	fl.Usage = func() {
		fmt.Fprintf(fl.Output(), usage, version)
		fl.PrintDefaults()
	}
	if err := fl.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if *showVersion {
		fmt.Println("omnisens", version)
		return 0
	}
	if *port < 0 || *port > 65535 {
		fmt.Fprintln(os.Stderr, "omnisens: --port must be between 0 and 65535")
		return 2
	}
	rest := fl.Args()
	if len(rest) == 0 {
		return report(serve(*port, *noBrowser))
	}
	switch cmd, cmdArgs := rest[0], rest[1:]; cmd {
	case "apply":
		if len(cmdArgs) != 1 {
			fmt.Fprintln(os.Stderr, "usage: omnisens apply <profile-code>")
			return 2
		}
		return report(apply(cmdArgs[0]))
	case "remove":
		if len(cmdArgs) != 0 {
			fmt.Fprintln(os.Stderr, "usage: omnisens remove")
			return 2
		}
		return report(remove())
	case "linux-setup":
		sub := flag.NewFlagSet("linux-setup", flag.ContinueOnError)
		install := sub.Bool("install", false, "do the setup (run as root, e.g. with sudo)")
		if err := sub.Parse(cmdArgs); err != nil || sub.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "usage: omnisens linux-setup [--install]")
			return 2
		}
		return report(linuxSetup(*install))
	default:
		fl.Usage()
		return 2
	}
}

func report(err error) int {
	if err != nil {
		fmt.Fprintln(os.Stderr, "omnisens:", err)
		return 1
	}
	return 0
}

func openStore() (*state.Store, error) {
	dir, err := state.DefaultDir()
	if err != nil {
		return nil, fmt.Errorf("cannot find a folder for omnisens' settings: %w", err)
	}
	return state.NewStore(dir), nil
}

func pageURL(port int, token string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/?t=%s#/pc", port, token)
}

func newToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// serve runs the app until the page asks it to quit or the console is
// closed or interrupted.
func serve(port int, noBrowser bool) error {
	store, err := openStore()
	if err != nil {
		return err
	}
	if in, ok := liveInstance(store); ok {
		url := pageURL(in.Port, in.Token)
		fmt.Println("omnisens is already running at", url)
		if !noBrowser {
			if err := openBrowser(url); err != nil {
				fmt.Println("Open that address in your browser.")
			}
		}
		return nil
	}
	token, err := newToken()
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return fmt.Errorf("cannot listen on 127.0.0.1:%d: %w", port, err)
	}
	port = ln.Addr().(*net.TCPAddr).Port
	backend, err := newBackend(store)
	if err != nil {
		ln.Close()
		return err
	}
	srv := server.New(server.Options{
		Port: port, Token: token, Version: version,
		Static: webui.FS(), Backend: backend, Logf: log.Printf,
	})
	httpSrv := &http.Server{Handler: srv, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	if err := store.WriteInstance(state.Instance{Port: port, Token: token, PID: os.Getpid()}); err != nil {
		log.Printf("could not write the instance file (a second start will not find this one): %v", err)
	}
	defer store.RemoveInstance(token)

	served := make(chan error, 1)
	go func() { served <- httpSrv.Serve(ln) }()

	url := pageURL(port, token)
	fmt.Printf("omnisens %s is running at %s\n", version, url)
	if !webui.Available() {
		fmt.Println("(This build has no web tool embedded; run `go generate ./...` in desktop/ and build again.)")
	}
	fmt.Println(runningNote)
	if !noBrowser {
		if err := openBrowser(url); err != nil {
			fmt.Println("Could not open your browser; open the address above yourself.")
		}
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-srv.Quit():
	case <-sig:
	case err := <-served:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server stopped: %v", err)
		}
	}
	signal.Stop(sig)
	fmt.Println("omnisens is closing.")
	if err := backend.Close(); err != nil {
		log.Printf("while closing: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	httpSrv.Shutdown(ctx)
	return nil
}

// liveInstance finds an omnisens that is already serving (its instance file
// exists and it answers /api/ping with its token).
func liveInstance(store *state.Store) (state.Instance, bool) {
	in, err := store.ReadInstance()
	if err != nil {
		return in, false
	}
	var res struct {
		OK bool `json:"ok"`
	}
	if err := call(in, http.MethodGet, "/api/ping", nil, &res); err != nil || !res.OK {
		return in, false
	}
	return in, true
}

// call talks to a running instance's API.
func call(in state.Instance, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", in.Port, path), rd)
	if err != nil {
		return err
	}
	req.Header.Set(server.TokenHeader, in.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	timeout := 3 * time.Second
	if method == http.MethodPost {
		timeout = 3 * time.Minute // writer.exe may wait on a message box
	}
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(b, &e) == nil && e.Error != "" {
			return errors.New(e.Error)
		}
		return fmt.Errorf("the running omnisens answered %s", resp.Status)
	}
	return json.Unmarshal(b, out)
}

// apply hands the profile to a running omnisens if there is one, so two
// processes never fight over the same settings, else applies it here.
func apply(code string) error {
	store, err := openStore()
	if err != nil {
		return err
	}
	if in, ok := liveInstance(store); ok {
		var res map[string]any
		if err := call(in, http.MethodPost, "/api/apply", map[string]string{"code": code}, &res); err != nil {
			return err
		}
		printResult(res)
		return nil
	}
	return applyHere(store, code)
}

func remove() error {
	store, err := openStore()
	if err != nil {
		return err
	}
	if in, ok := liveInstance(store); ok {
		var res map[string]any
		if err := call(in, http.MethodPost, "/api/remove", struct{}{}, &res); err != nil {
			return err
		}
		printResult(res)
		return nil
	}
	return removeHere(store)
}

func printResult(res map[string]any) {
	if fit, ok := res["fit"].(map[string]any); ok {
		fmt.Printf("Raw Accel approximation: max error %.1f%%, diagonals bend up to %.1f degrees.\n", num(fit["maxErrorPct"]), num(fit["maxSkewDeg"]))
	}
	if msg, ok := res["message"].(string); ok && msg != "" {
		fmt.Println(msg)
	}
	if w, ok := res["warning"].(string); ok && w != "" {
		fmt.Println("Warning:", w)
	}
}

// jsonMap gives a local result the shape the API would send.
func jsonMap(res map[string]any) map[string]any {
	var out map[string]any
	if b, err := json.Marshal(res); err == nil {
		json.Unmarshal(b, &out)
	}
	return out
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}
