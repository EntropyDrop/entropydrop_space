extends RefCounted

const SIZE_X := 16384.0
const SIZE_Z := 2048.0
const R := SIZE_X / TAU
const TUBE := SIZE_Z / TAU
const GROUND := 16.0
const ANGLE_FACTOR := sqrt((R / TUBE + 1.0) / (R / TUBE - 1.0))

static func tube_angle(z: float) -> float:
	var half_angle := z * PI / SIZE_Z
	return 2.0 * atan2(ANGLE_FACTOR * sin(half_angle), cos(half_angle))

static func bend(point: Vector3) -> Vector3:
	var theta := point.x * TAU / SIZE_X
	var phi := tube_angle(point.z)
	var cp := cos(phi)
	var scale_value := (R + TUBE * cp) / R
	var rho := minf(TUBE + (point.y - GROUND) * scale_value, R - 1.0)
	var radial := R + rho * cp
	return Vector3(radial * cos(theta), rho * sin(phi), radial * sin(theta))

static func frame(point: Vector3) -> Basis:
	var theta := point.x * TAU / SIZE_X
	var phi := tube_angle(point.z)
	var ct := cos(theta)
	var st := sin(theta)
	var cp := cos(phi)
	var sp := sin(phi)
	return Basis(Vector3(-st, 0, ct), Vector3(cp * ct, sp, cp * st), Vector3(-sp * ct, cp, -sp * st))

static func wrapped(point: Vector3) -> Vector3:
	return Vector3(fposmod(point.x, SIZE_X), clampf(point.y, 2.0, 1900.0), fposmod(point.z, SIZE_Z))

static func sector_distance(x: int, z: int, point: Vector3) -> float:
	var dx := absf(fposmod(x * 128.0 + 64.0 - point.x + SIZE_X / 2, SIZE_X) - SIZE_X / 2)
	var dz := absf(fposmod(z * 128.0 + 64.0 - point.z + SIZE_Z / 2, SIZE_Z) - SIZE_Z / 2)
	return Vector2(dx, dz).length()
