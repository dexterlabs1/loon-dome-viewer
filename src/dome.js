import * as THREE from 'three';

// The projection surface is a spherical cap recessed into the ceiling (a 180° hemisphere is the
// special case rise = diameter / 2). Built at unit radius; app.js scales and positions it.
//
// Domemaster: equidistant over the cap, in the usual fulldome orientation as seen from below:
// image bottom (v=0) is front (-Z), image right is right (+X), centre is the zenith (+Y),
// and the image circle's edge is the cap's rim (polar angle capAngle).

// Cap size → sphere radius, polar half-angle of the rim, and sphere centre height below the rim.
export function capShape(diameter, rise) {
  const half = diameter / 2;
  rise = THREE.MathUtils.clamp(rise, 0.05, half);
  const radius = (half * half + rise * rise) / (2 * rise);
  return { radius, capAngle: 2 * Math.atan(rise / half), centreBelowRim: radius - rise };
}

export function directionToUV(direction, capAngle = Math.PI / 2) {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  const theta = Math.acos(THREE.MathUtils.clamp(direction.y / length, -1, 1));
  const radial = theta / capAngle;
  const azimuth = Math.atan2(direction.x, -direction.z);
  return { u: 0.5 + radial * Math.sin(azimuth) / 2, v: 0.5 - radial * Math.cos(azimuth) / 2 };
}

export function uvToDirection(u, v, capAngle = Math.PI / 2) {
  const x = 2 * (u - 0.5), z = 2 * (0.5 - v);
  const radius = Math.hypot(x, z), theta = radius * capAngle;
  return new THREE.Vector3(radius ? Math.sin(theta) * x / radius : 0,
    Math.cos(theta), radius ? -Math.sin(theta) * z / radius : 0);
}

// The dome shows whatever domemaster texture it is given (here: the compositor output).
export function createDome(texture) {
  const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide, toneMapped: false });
  const dome = new THREE.Mesh(new THREE.BufferGeometry(), material);
  dome.name = 'Projection dome';
  return dome;
}

// Rebuild the unit-radius cap (and its outline) for a new rim angle.
export function setCapAngle(dome, capAngle) {
  if (dome.userData.capAngle === capAngle) return;
  dome.userData.capAngle = capAngle;
  const geometry = new THREE.SphereGeometry(1, 192, 48, 0, Math.PI * 2, 0, capAngle);
  const positions = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let index = 0; index < positions.count; index++) {
    const mapped = directionToUV({ x: positions.getX(index), y: positions.getY(index), z: positions.getZ(index) }, capAngle);
    uv.setXY(index, mapped.u, mapped.v);
  }
  dome.geometry.dispose();
  dome.geometry = geometry;
  for (const child of [...dome.children]) { dome.remove(child); child.geometry.dispose(); }
  dome.add(createOutline(capAngle));
}

// Faint rim, rings and meridians so the dome's shape reads when orbiting.
function createOutline(capAngle) {
  const points = [];
  const at = (theta, az) => new THREE.Vector3(Math.sin(theta) * Math.sin(az), Math.cos(theta), -Math.sin(theta) * Math.cos(az));
  const steps = 96;
  for (const fraction of [1, 2 / 3, 1 / 3]) {
    for (let i = 0; i < steps; i++) points.push(at(capAngle * fraction, i / steps * Math.PI * 2), at(capAngle * fraction, (i + 1) / steps * Math.PI * 2));
  }
  for (let m = 0; m < 12; m++) {
    const az = m / 12 * Math.PI * 2;
    for (let i = 0; i < 16; i++) points.push(at(capAngle * i / 16, az), at(capAngle * (i + 1) / 16, az));
  }
  const outline = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0x4a5866, transparent: true, opacity: 0.55 }));
  outline.scale.setScalar(0.995); // just inside the surface so it isn't hidden by it
  outline.name = 'Dome outline';
  return outline;
}
