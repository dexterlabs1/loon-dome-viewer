import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// Adapted from dome-review-xr: same controller handling and recentring, with a small
// panel for the Loon viewer (play, mapping mode, caption, recentre).
const WIDTH = 1000;
const HEIGHT = 420;
const PANEL_WIDTH = 1.2;
const PANEL_HEIGHT = PANEL_WIDTH * HEIGHT / WIDTH;

// Standard WebXR gamepad slots, refined by the loaded controller profile when available.
export function inputMapping(source, components = {}) {
  const standard = source.gamepad?.mapping === 'xr-standard' || (source.profiles || []).length > 0;
  const mapping = { trigger: standard ? 0 : undefined, stick: standard ? 3 : undefined,
    primary: standard ? 4 : undefined, secondary: standard ? 5 : undefined };
  for (const [id, component] of Object.entries(components)) {
    const indices = component.gamepadIndices || {};
    if (component.type === 'trigger') mapping.trigger = indices.button;
    if (component.type === 'thumbstick') mapping.stick = indices.button;
    if (/^(a|x)-button$/.test(id)) mapping.primary = indices.button;
    if (/^(b|y)-button$/.test(id)) mapping.secondary = indices.button;
  }
  return mapping;
}

// Copy button state: XR gamepads are mutable objects reused by the browser.
export class ControllerInput {
  constructor() { this.previous = {}; }

  poll(source, mapping, api, togglePanel) {
    const pad = source.gamepad;
    if (!pad) return;
    const down = (name) => mapping[name] !== undefined && Boolean(pad.buttons[mapping[name]]?.pressed);
    const current = Object.fromEntries(['primary', 'secondary', 'stick'].map((key) => [key, down(key)]));
    const pressed = (name) => current[name] && !this.previous[name];
    if (source.handedness === 'right') {
      if (pressed('primary')) api.togglePlay();
      if (pressed('secondary')) api.cycleMode();
    } else if (pressed('primary') || pressed('stick') || pressed('secondary')) togglePanel();
    this.previous = current;
  }
}

// A local-floor reference pose includes physical head height and room offset.
// Cancel its yaw and translation so the eyes end up at the configured seat facing world -Z.
export function recenterTransform(headPosition, headQuaternion, target) {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(headQuaternion);
  const yaw = Math.atan2(-forward.x, -forward.z);
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  const position = target.clone().sub(headPosition.clone().applyQuaternion(quaternion));
  return { position, quaternion };
}

export function createXR({ renderer, scene, camera, rig, api }) {
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  const canvas = Object.assign(document.createElement('canvas'), { width: WIDTH, height: HEIGHT });
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  panel.name = 'XR controls';
  panel.visible = false;
  scene.add(panel);

  const raycaster = new THREE.Raycaster();
  const rotation = new THREE.Matrix4();
  const headPosition = new THREE.Vector3();
  const headQuaternion = new THREE.Quaternion();
  const controls = [];
  const hands = [];
  let hover = '';
  let clock = 0;
  let lastDraw = -Infinity;
  let pendingRecenter = null;
  let desktopPose = null;
  let panelWanted = true;
  let panelPlaced = false;

  function run(action) {
    try { action(); } catch (error) { api.notify(error.message || String(error)); }
    lastDraw = -Infinity;
  }

  function placePanel() {
    const xrCamera = renderer.xr.getCamera();
    xrCamera.getWorldPosition(headPosition);
    xrCamera.getWorldQuaternion(headQuaternion);
    // Keep the panel low and in front so it never covers the dome window.
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(headQuaternion);
    direction.y = 0;
    if (direction.lengthSq() < 0.001) direction.set(0, 0, -1);
    direction.normalize();
    panel.position.copy(headPosition).addScaledVector(direction, 1.4);
    panel.position.y -= 0.5;
    panel.lookAt(headPosition);
    panel.updateMatrixWorld(true);
    panelPlaced = true;
  }

  function togglePanel() {
    panelWanted = !panelWanted;
    panelPlaced = false;
  }

  function recenter() {
    if (renderer.xr.isPresenting) pendingRecenter = rig.position.clone();
    panelPlaced = false;
  }

  function button(id, text, x, y, w, h, action, active = false) {
    controls.push({ id, x, y, w, h, action });
    ctx.fillStyle = hover === id ? '#3a4652' : active ? '#f2b544' : '#1a2128';
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.fill();
    ctx.fillStyle = active && hover !== id ? '#1a1305' : '#e7ecef';
    ctx.font = '600 30px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, x + w / 2, y + h / 2 + 10, w - 20);
  }

  function draw() {
    const state = api.getState();
    controls.length = 0;
    ctx.fillStyle = '#0b0e11';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.textAlign = 'left';
    ctx.font = '600 26px "Helvetica Neue", Arial, sans-serif';
    ctx.fillStyle = '#f2b544';
    ctx.fillText('LOON DOME VIEWER', 36, 52);
    ctx.fillStyle = '#8b98a3';
    ctx.font = '24px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(state.name || '', 36, 92, WIDTH - 72);
    if (state.hasVideo) button('play', state.paused ? 'Play' : 'Pause', 36, 120, 220, 80, api.togglePlay, true);
    button('mode', `Mode: ${state.mode}`, state.hasVideo ? 276 : 36, 120, state.hasVideo ? 688 : 928, 80, api.cycleMode);
    button('caption', state.captionOn ? 'Caption on' : 'Caption off', 36, 220, 450, 80, api.toggleCaption, state.captionOn);
    button('recenter', 'Recentre', 514, 220, 450, 80, api.recenter);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8b98a3';
    ctx.font = '22px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('Right A  play / pause   ·   Right B  next mode   ·   Left X / Y  show / hide panel', 36, 370, WIDTH - 72);
    texture.needsUpdate = true;
    lastDraw = clock;
  }

  function aim(hand) {
    hand.controller.updateWorldMatrix(true, false);
    rotation.extractRotation(hand.controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(hand.controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(rotation);
    const hit = raycaster.intersectObject(panel, false)[0];
    hand.line.scale.z = hit ? hit.distance : 2;
    return hit ? { x: hit.uv.x * WIDTH, y: (1 - hit.uv.y) * HEIGHT } : null;
  }
  const hitControl = (point) => point && controls.findLast((c) => point.x >= c.x && point.x <= c.x + c.w && point.y >= c.y && point.y <= c.y + c.h);

  const factory = new XRControllerModelFactory(null, (modelScene) => {
    // Keep controller models visible without relying on scene lighting.
    modelScene.traverse((child) => {
      if (!child.isMesh) return;
      const unlit = (material) => new THREE.MeshBasicMaterial({ color: material.color, map: material.map,
        transparent: material.transparent, opacity: material.opacity });
      child.material = Array.isArray(child.material) ? child.material.map(unlit) : unlit(child.material);
    });
  });
  for (let index = 0; index < 2; index++) {
    const controller = renderer.xr.getController(index);
    const grip = renderer.xr.getControllerGrip(index);
    const model = factory.createControllerModel(grip);
    grip.add(model);
    rig.add(controller, grip);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: '#f2b544' }));
    line.scale.z = 2;
    controller.add(line);
    const hand = { controller, model, line, source: null, input: new ControllerInput() };
    hands.push(hand);
    controller.addEventListener('connected', (event) => { hand.source = event.data; hand.input = new ControllerInput(); });
    controller.addEventListener('disconnected', () => { hand.source = null; });
    controller.addEventListener('selectstart', () => {
      if (!panel.visible) return;
      const control = hitControl(aim(hand));
      if (control) run(control.action);
    });
  }

  const entry = Object.assign(document.createElement('button'), { type: 'button', id: 'enter-xr', textContent: 'Checking VR…', disabled: true });
  document.getElementById('xr-entry')?.append(entry);
  const xrSystem = globalThis.navigator?.xr;
  if (!xrSystem) entry.textContent = window.isSecureContext ? 'VR unavailable' : 'VR needs HTTPS';
  else xrSystem.isSessionSupported('immersive-vr').then((supported) => {
    entry.disabled = !supported;
    entry.textContent = supported ? 'Enter VR' : 'VR not available';
  }).catch(() => { entry.textContent = 'VR unavailable'; });
  entry.title = 'Open in a WebXR browser (Quest Browser, or Chrome with a PC headset)';
  entry.addEventListener('click', async () => {
    entry.disabled = true;
    try {
      if (renderer.xr.isPresenting) await renderer.xr.getSession().end();
      else {
        const session = await xrSystem.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
        try { await renderer.xr.setSession(session); } catch (error) { await session.end(); throw error; }
      }
    } catch (error) { api.notify(`Could not enter VR: ${error.message}`); }
    finally { entry.disabled = false; }
  });
  renderer.xr.addEventListener('sessionstart', () => {
    desktopPose = { position: rig.position.clone(), quaternion: rig.quaternion.clone(),
      cameraQuaternion: camera.quaternion.clone() };
    pendingRecenter = rig.position.clone();
    panelWanted = true;
    panelPlaced = false;
    entry.textContent = 'Exit VR';
    api.notify('VR ready. Left X / Y shows or hides the panel.');
  });
  renderer.xr.addEventListener('sessionend', () => {
    panel.visible = false;
    if (desktopPose) {
      rig.position.copy(desktopPose.position);
      rig.quaternion.copy(desktopPose.quaternion);
      camera.quaternion.copy(desktopPose.cameraQuaternion);
    }
    pendingRecenter = null;
    desktopPose = null;
    entry.textContent = 'Enter VR';
    api.notify('VR session ended.');
  });

  function update(dt) {
    clock += Math.max(0, dt || 0);
    if (!renderer.xr.isPresenting) return;
    if (pendingRecenter) {
      const frame = renderer.xr.getFrame();
      const referenceSpace = renderer.xr.getReferenceSpace();
      const pose = frame && referenceSpace ? frame.getViewerPose(referenceSpace) : null;
      if (pose) {
        const transform = recenterTransform(new THREE.Vector3().copy(pose.transform.position),
          new THREE.Quaternion().copy(pose.transform.orientation), pendingRecenter);
        rig.position.copy(transform.position);
        rig.quaternion.copy(transform.quaternion);
        rig.updateMatrixWorld(true);
        pendingRecenter = null;
        panelPlaced = false;
      }
    }
    panel.visible = panelWanted;
    if (panel.visible && !panelPlaced) placePanel();
    let nextHover = '';
    for (const hand of hands) {
      hand.line.visible = panel.visible;
      if (!hand.source) continue;
      hand.input.poll(hand.source, inputMapping(hand.source, hand.model.motionController?.components), api, togglePanel);
      if (panel.visible) nextHover = hitControl(aim(hand))?.id || nextHover;
    }
    if (nextHover !== hover) { hover = nextHover; lastDraw = -Infinity; }
    if (panel.visible && clock - lastDraw >= 0.2) draw();
  }

  draw();
  return { update, recenter };
}

