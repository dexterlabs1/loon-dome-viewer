import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

// Simple floor for scale, plus an optional architectural model (OBJ from SketchUp).
export function createFloor() {
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 96),
    new THREE.MeshBasicMaterial({ color: 0x14181c }));
  floor.rotation.x = -Math.PI / 2;
  const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
    Array.from({ length: 128 }, (_, i) => new THREE.Vector3(Math.cos(i / 128 * Math.PI * 2), Math.sin(i / 128 * Math.PI * 2), 0))),
  new THREE.LineBasicMaterial({ color: 0x3a4652 }));
  floor.add(ring);
  floor.name = 'Floor';
  return floor;
}

// Ceiling plane around the dome's rim, visible from below.
export function createCeiling() {
  const material = new THREE.MeshBasicMaterial({ color: 0x262d35 });
  const ceiling = new THREE.Mesh(new THREE.BufferGeometry(), material);
  ceiling.rotation.x = Math.PI / 2; // face down
  ceiling.name = 'Ceiling';
  ceiling.userData.setOpening = (radius) => {
    if (ceiling.userData.radius === radius) return;
    ceiling.userData.radius = radius;
    ceiling.geometry.dispose();
    ceiling.geometry = new THREE.RingGeometry(radius, radius * 3, 128, 1);
  };
  return ceiling;
}

export async function loadVenue(file, unitScale) {
  const model = new OBJLoader().parse(await file.text());
  const material = new THREE.MeshLambertMaterial({ color: 0x9aa4ad, side: THREE.DoubleSide });
  model.traverse(child => { if (child.isMesh) child.material = material; });
  model.scale.setScalar(unitScale);
  model.name = `Venue: ${file.name}`;
  return model;
}
