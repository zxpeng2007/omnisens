package omnicore

import "math"

// GainAt interpolates the gain table at angleDeg (any value; wrapped), the
// same periodic Catmull-Rom (or linear) spline as omni_engine_gain_at().
func GainAt(gains []float64, angleDeg float64, linear bool) float64 {
	n := len(gains)
	if n == 0 {
		return 1
	}
	if n == 1 {
		return gains[0]
	}
	u := math.Mod(angleDeg*float64(n)/360, float64(n))
	if u < 0 {
		u += float64(n)
	}
	k := int(math.Floor(u))
	if k >= n {
		k = n - 1
	}
	t := u - float64(k)
	p1, p2 := gains[k], gains[(k+1)%n]
	if linear {
		return p1 + (p2-p1)*t
	}
	p0, p3 := gains[(k+n-1)%n], gains[(k+2)%n]
	g := p1 + 0.5*t*(p2-p0+t*(2*p0-5*p1+4*p2-p3+t*(3*(p1-p2)+p3-p0)))
	lo, hi := gains[0], gains[0]
	for _, v := range gains {
		lo, hi = math.Min(lo, v), math.Max(hi, v)
	}
	return math.Max(lo, math.Min(hi, g))
}

// VecAngle is the direction of a HID-axes vector (+y down) in degrees,
// counter-clockwise from right: 0 right, 90 up, 180 left, 270 down.
func VecAngle(dx, dy float64) float64 {
	a := math.Atan2(-dy, dx) * 180 / math.Pi
	if a < 0 {
		a += 360
	}
	return a + 0
}

// Engine applies a profile to a stream of motion reports, like
// omni_engine_process(): smoothed direction estimate, scalar gain, optional
// rotation and sub-count remainders. Not safe for concurrent use.
type Engine struct {
	gains     []float64
	enabled   bool
	linear    bool
	smoothing float64
	resetUs   uint64
	rotate    bool
	rotC      float64
	rotS      float64

	sx, sy       float64
	remX, remY   float64
	lastMotionUs uint64
	active       bool

	LastAngle float64
	LastGain  float64
}

// NewEngine builds an engine for a (sanitized copy of a) profile.
func NewEngine(cfg Config) *Engine {
	cfg.Sanitize()
	rad := float64(cfg.RotationCdeg) * math.Pi / 18000
	return &Engine{
		gains:     cfg.Gains(),
		enabled:   cfg.Flags&FlagEnabled != 0,
		linear:    cfg.Linear(),
		smoothing: float64(cfg.SmoothingCounts),
		resetUs:   uint64(cfg.ResetMs) * 1000,
		rotate:    cfg.RotationCdeg != 0,
		rotC:      math.Cos(rad),
		rotS:      math.Sin(rad),
		LastGain:  1,
	}
}

// Reset forgets stroke history and remainders.
func (e *Engine) Reset() {
	e.sx, e.sy, e.remX, e.remY = 0, 0, 0, 0
	e.active = false
}

func roundAway(v float64) int32 {
	v = math.Max(-2e9, math.Min(2e9, v))
	if v >= 0 {
		return int32(math.Floor(v + 0.5))
	}
	return -int32(math.Floor(-v + 0.5))
}

// Process scales one report. nowUs is a monotonic microsecond clock.
func (e *Engine) Process(dx, dy int32, nowUs uint64) (int32, int32) {
	if !e.enabled {
		return dx, dy
	}
	if dx == 0 && dy == 0 {
		return 0, 0
	}
	if !e.active || nowUs-e.lastMotionUs > e.resetUs {
		e.Reset()
	}
	e.active = true
	e.lastMotionUs = nowUs

	fx, fy := float64(dx), float64(dy)
	if e.smoothing > 0 {
		keep := e.smoothing / (e.smoothing + math.Hypot(fx, fy))
		e.sx = e.sx*keep + fx
		e.sy = e.sy*keep + fy
	} else {
		e.sx, e.sy = fx, fy
	}
	ang := VecAngle(e.sx, e.sy)
	g := GainAt(e.gains, ang, e.linear)
	e.LastAngle, e.LastGain = ang, g

	vx, vy := fx*g, fy*g
	if e.rotate {
		vx, vy = vx*e.rotC+vy*e.rotS, -vx*e.rotS+vy*e.rotC
	}
	vx += e.remX
	vy += e.remY
	ix, iy := roundAway(vx), roundAway(vy)
	e.remX, e.remY = vx-float64(ix), vy-float64(iy)
	return ix, iy
}
