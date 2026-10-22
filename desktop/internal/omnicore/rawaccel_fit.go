package omnicore

import "math"

const raGrid = 72 // fit grid, every 5 degrees

// RawAccelFit is the best Raw Accel approximation of a profile; see
// rawAccelFit() in web/js/export.js, which this must match exactly.
//
// Raw Accel v1.7 scales x by one factor when moving right and another when
// moving left, and y likewise for down/up. A hand movement at angle t
// therefore comes out with gain sqrt(gx^2 cos^2 t + gy^2 sin^2 t), slightly
// bent. Fitting the squared gains is linear least squares in
// (R^2, L^2, U^2, D^2); the result is scaled so its geometric mean matches
// the profile's.
type RawAccelFit struct {
	Right, Left, Up, Down float64
	Errors8               [8]float64 // percent at 0, 45, ..., 315 degrees
	MaxErrorPct           float64
	RMSErrorPct           float64
	MaxSkewDeg            float64
}

// FitRawAccel computes the fit for a profile.
func FitRawAccel(cfg Config) RawAccelFit {
	cfg.Sanitize()
	gains, linear := cfg.Gains(), cfg.Linear()

	var A [4][4]float64
	var b [4]float64
	type point struct{ deg, t, target float64 }
	grid := make([]point, raGrid)
	for k := 0; k < raGrid; k++ {
		deg := float64(k) * 360 / raGrid
		t := deg * math.Pi / 180
		c2, s2 := math.Pow(math.Cos(t), 2), math.Pow(math.Sin(t), 2)
		target := GainAt(gains, deg, linear)
		var row [4]float64 // R^2, L^2, U^2, D^2
		switch {
		case deg < 90:
			row = [4]float64{c2, 0, s2, 0}
		case deg < 180:
			row = [4]float64{0, c2, s2, 0}
		case deg < 270:
			row = [4]float64{0, c2, 0, s2}
		default:
			row = [4]float64{c2, 0, 0, s2}
		}
		for i := 0; i < 4; i++ {
			b[i] += row[i] * target * target
			for j := 0; j < 4; j++ {
				A[i][j] += row[i] * row[j]
			}
		}
		grid[k] = point{deg, t, target}
	}
	x := solve4(A, b)
	var f [4]float64
	for i, v := range x {
		f[i] = math.Sqrt(math.Max(v, 1e-4))
	}

	eval := func(f [4]float64, p point) (gain, angle float64) {
		c, s := math.Cos(p.t), math.Sin(p.t)
		gx, gy := f[1], f[3]
		if c >= 0 {
			gx = f[0]
		}
		if s >= 0 {
			gy = f[2]
		}
		return math.Hypot(gx*c, gy*s), math.Atan2(gy*s, gx*c)
	}
	var sum float64
	for _, p := range grid {
		g, _ := eval(f, p)
		sum += math.Log(p.target) - math.Log(g)
	}
	shift := math.Exp(sum / raGrid)
	for i := range f {
		f[i] *= shift
	}

	r := RawAccelFit{Right: f[0], Left: f[1], Up: f[2], Down: f[3]}
	var sq float64
	for k, p := range grid {
		g, ang := eval(f, p)
		e := 100 * (g/p.target - 1)
		sq += e * e
		r.MaxErrorPct = math.Max(r.MaxErrorPct, math.Abs(e))
		if k%(raGrid/8) == 0 {
			r.Errors8[k/(raGrid/8)] = e
		}
		d := math.Mod(ang*180/math.Pi-p.deg+540, 360) - 180
		r.MaxSkewDeg = math.Max(r.MaxSkewDeg, math.Abs(d))
	}
	r.RMSErrorPct = math.Sqrt(sq / raGrid)
	return r
}

// solve4 is Gaussian elimination with partial pivoting (same order as JS).
func solve4(A [4][4]float64, b [4]float64) [4]float64 {
	var M [4][5]float64
	for i := 0; i < 4; i++ {
		copy(M[i][:4], A[i][:])
		M[i][4] = b[i]
	}
	for c := 0; c < 4; c++ {
		p := c
		for r := c + 1; r < 4; r++ {
			if math.Abs(M[r][c]) > math.Abs(M[p][c]) {
				p = r
			}
		}
		M[c], M[p] = M[p], M[c]
		for r := c + 1; r < 4; r++ {
			f := M[r][c] / M[c][c]
			for k := c; k <= 4; k++ {
				M[r][k] -= f * M[c][k]
			}
		}
	}
	var x [4]float64
	for r := 3; r >= 0; r-- {
		s := M[r][4]
		for k := r + 1; k < 4; k++ {
			s -= M[r][k] * x[k]
		}
		x[r] = s / M[r][r]
	}
	return x
}
