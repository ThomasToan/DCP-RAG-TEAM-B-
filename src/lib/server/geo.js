/**
 * Polygon area in square metres from WGS84 lon/lat rings.
 *
 * The lot layer's own `Shape__Area` is in degrees squared when geometry is returned in 4326, and
 * `planlotarea` is often null, so we compute it. Local equirectangular projection using the WGS84
 * meridional (M) and prime-vertical (N) radii of curvature at the polygon's mean latitude: at lot
 * scale the error is far below the precision of a survey plan.
 *
 * Works with Esri ring orientation (outer rings clockwise, holes counter-clockwise): signed
 * shoelace areas add up, holes subtract.
 *
 * @param {number[][][]} rings  [[ [lon, lat], ... ], ...]
 * @returns {number} area in m2
 */
export function ringsAreaM2(rings) {
	const a = 6378137;
	const e2 = 0.00669437999014;

	let latSum = 0;
	let n = 0;
	for (const ring of rings) {
		for (const [, lat] of ring) {
			latSum += lat;
			n++;
		}
	}
	if (n === 0) return 0;
	const phi = ((latSum / n) * Math.PI) / 180;
	const w = Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
	const N = a / w; // prime vertical radius
	const M = (a * (1 - e2)) / w ** 3; // meridional radius
	const kx = N * Math.cos(phi) * (Math.PI / 180); // metres per degree lon
	const ky = M * (Math.PI / 180); // metres per degree lat

	let signed = 0;
	for (const ring of rings) {
		let s = 0;
		for (let i = 0; i < ring.length - 1; i++) {
			const [x1, y1] = ring[i];
			const [x2, y2] = ring[i + 1];
			s += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky);
		}
		signed += s / 2;
	}
	return Math.abs(signed);
}

/** `DP246833` -> `DP 246833`; anything unrecognised is returned untouched. */
export function formatPlan(planlabel) {
	const m = /^([A-Z]+)\s*(\d+)$/i.exec(planlabel ?? '');
	return m ? `${m[1].toUpperCase()} ${m[2]}` : (planlabel ?? '');
}
