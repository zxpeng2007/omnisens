// Package linuxengine applies an omnisens profile on Linux without the USB
// adapter. Each relative mouse is grabbed through evdev, its motion runs
// through omnicore.Engine (full 8-16 direction fidelity) and the result is
// sent from a uinput clone named "omnisens: <original name>". If the process
// dies, the kernel releases the grab and the mouse works as before.
//
// Other operating systems get a stub that reports Supported: false.
package linuxengine

// Status is what GET /api/info reports as "engine".
type Status struct {
	Supported      bool     `json:"supported"`
	Running        bool     `json:"running"`
	Paused         bool     `json:"paused"`
	Devices        []string `json:"devices"`
	CanReadInput   bool     `json:"canReadInput"`
	CanWriteUinput bool     `json:"canWriteUinput"`
	Error          string   `json:"error,omitempty"`
	Code           string   `json:"code,omitempty"`
}
