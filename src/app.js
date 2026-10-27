import * as THREE from 'three';
import { createDome, setCapAngle, capShape } from './dome.js';
import { createCompositor, MODES, MODE_LABELS } from './compositor.js';
import { createCaption } from './caption.js';
import { createTestPattern } from './testpattern.js';
import { createFloor, createCeiling, loadVenue } from './venue.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createXR } from './xr.js';

const $ = id => document.getElementById(id);
const video = $('video');
const storage = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(`loon-dome:${key}`)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`loon-dome:${key}`, JSON.stringify(value)); } catch { /* private mode: settings just won't persist */ } },
};
function notify(message) { $('status').textContent = message; }

// Venue defaults are estimates from the SketchUp lobby view (shallow dome recessed into the ceiling)
// until the spec sheet arrives. Window/caption angles are as seen from the visitor's eye.
const DEFAULTS = {
  mode: 'window', winAz: 0, winEl: 65, winFov: 60, feather: 0.12, fillAmount: 0.7,
  captionOn: true, captionText: 'The information of the loon migration will display here with narrative',
  capAz: 0, capEl: 46, capSize: 3, guides: false,
  domeDiameter: 10, domeRise: 1.5, ceilingHeight: 5, eyeHeight: 1.6, moveBack: 0, layout: 'dome',
};
// v2: the venue changed from an inside-the-hemisphere model to a ceiling cap; older saved angles don't apply.
const settings = { ...DEFAULTS, ...storage.get('settings-v2', {}) };
const MODE_NOTES = {
  stretch: 'The flat frame is scaled to fill the whole dome. Shows why footage can’t simply be stretched: the horizon bends into a circle and the edges smear.',
  window: 'The footage sits on a flat “screen” on the dome, with correct perspective for a visitor standing where the figure is (set under Venue). Lowest effort; the rest of the dome stays dark.',
  fill: 'Same window, with the rest of the dome lit by a soft glow that continues the colours at the footage’s edges, like an ambient-light TV. Adds immersion with no extra footage.',
};
const RANGES = {
  winAz: v => `${v}°`, winEl: v => `${v}°`, winFov: v => `${v}°`, feather: v => v.toFixed(2), fillAmount: v => `${Math.round(v * 100)}%`,
  capAz: v => `${v}°`, capEl: v => `${v}°`, capSize: v => `${v}°`,
  domeDiameter: metres, domeRise: metres, ceilingHeight: metres, eyeHeight: metres, moveBack: metres,
};

function metres(v) { return `${v.toFixed(1)} m · ${Math.round(v / 0.3048)} ft`; }

// Renderer and scene
const renderer = new THREE.WebGLRenderer({ canvas: $('canvas'), antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setScissorTest(true);
renderer.xr.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x161b21);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.5)); // venue model only; the dome is unlit
// Headset camera: rides the rig at the viewer's seat.
const camera = new THREE.PerspectiveCamera(80, 1, 0.05, 200);
const rig = new THREE.Group();
rig.add(camera); scene.add(rig);

const compositor = createCompositor(renderer);
const dome = createDome(compositor.texture);
scene.add(dome);
const floor = createFloor();
scene.add(floor);
const ceiling = createCeiling();
scene.add(ceiling);
const view = { capAngle: Math.PI / 2, centreFromEye: new THREE.Vector3() };
let venue = null;

const outputScene = new THREE.Scene();
outputScene.background = null;
outputScene.add(new THREE.Mesh(new THREE.CircleGeometry(1, 192), new THREE.MeshBasicMaterial({ map: compositor.texture, toneMapped: false })));
const outputCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
outputCamera.position.z = 1;

// Flat source inset, drawn straight from the source texture.
const sourceScene = new THREE.Scene();
sourceScene.background = new THREE.Color(0x000000);
const sourceQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ toneMapped: false }));
sourceScene.add(sourceQuad);

const caption = createCaption();
const pattern = createTestPattern();
let source = { texture: pattern.texture, aspect: pattern.aspect, name: 'Test pattern', kind: 'pattern' };

// Settings → scene
function applySettings() {
  // Keep the venue physically possible: a cap rises at most half its diameter; the ceiling is above the eye.
  settings.domeRise = Math.min(Number(settings.domeRise), Number(settings.domeDiameter) / 2);
  settings.ceilingHeight = Math.max(Number(settings.ceilingHeight), Number(settings.eyeHeight) + 0.5);
  $('domeRise').max = Number(settings.domeDiameter) / 2;
  for (const [key, format] of Object.entries(RANGES)) {
    settings[key] = Number(settings[key]);
    if (!Number.isFinite(settings[key])) settings[key] = DEFAULTS[key];
    $(key).value = settings[key];
    document.querySelector(`output[for=${key}]`).value = format(settings[key]);
  }
  if (!MODES.includes(settings.mode)) settings.mode = DEFAULTS.mode;
  for (const button of document.querySelectorAll('[data-mode]')) button.classList.toggle('active', button.dataset.mode === settings.mode);
  if (!['dome', 'split', 'output'].includes(settings.layout)) settings.layout = DEFAULTS.layout;
  for (const button of document.querySelectorAll('[data-view]')) button.classList.toggle('active', button.dataset.view === settings.layout);
  $('stage').dataset.view = settings.layout;
  $('mode-note').textContent = MODE_NOTES[settings.mode];
  toggleDisabled($('window-controls'), settings.mode === 'stretch');
  toggleDisabled($('fill-controls'), settings.mode !== 'fill');
  $('captionOn').checked = settings.captionOn;
  $('captionText').value = settings.captionText;
  toggleDisabled($('caption-controls'), !settings.captionOn);
  $('guides').checked = settings.guides;
  caption.set(settings.captionText);

  const cap = capShape(settings.domeDiameter, settings.domeRise);
  setCapAngle(dome, cap.capAngle);
  dome.scale.setScalar(cap.radius);
  dome.position.y = settings.ceilingHeight - cap.centreBelowRim;
  ceiling.position.y = settings.ceilingHeight;
  ceiling.userData.setOpening(settings.domeDiameter / 2);
  floor.scale.setScalar(settings.domeDiameter * 1.5);
  const eye = new THREE.Vector3(0, settings.eyeHeight, settings.moveBack);
  view.capAngle = cap.capAngle;
  view.centreFromEye.copy(dome.position).sub(eye).divideScalar(cap.radius);
  if (!renderer.xr.isPresenting) rig.position.copy(eye);
  viewer.position.set(0, (settings.eyeHeight + 0.1) / 2, settings.moveBack);
  viewer.scale.set(1, (settings.eyeHeight + 0.1) / 1.44, 1);
  orbit.maxDistance = settings.domeDiameter * 5;
  storage.set('settings-v2', settings);
}
function toggleDisabled(element, disabled) {
  if (disabled) element.setAttribute('data-disabled', ''); else element.removeAttribute('data-disabled');
}

// Desktop orbit camera: circles the dome. The dome is drawn inside-only, so seen from above or
// outside, the near side cuts away and the projection stays visible.
const orbitCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
const domeView = $('dome-view');
const orbit = new OrbitControls(orbitCamera, domeView);
orbit.enableDamping = true;
orbit.minDistance = 0.01;
orbit.maxPolarAngle = Math.PI * 0.95; // allow looking up from under the springline

// Simple figure at the seat for scale.
const viewer = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1, 4, 12), new THREE.MeshLambertMaterial({ color: 0xf2b544 }));
scene.add(viewer);

function recenter() {
  applySettings();
  // Like the SketchUp lobby view: from across the room, a little above head height, looking up into the dome.
  const az = THREE.MathUtils.degToRad(settings.winAz) + 0.45; // a little to the side so the figure doesn't block the view
  const d = settings.domeDiameter;
  orbit.target.set(0, settings.ceilingHeight, 0);
  orbitCamera.position.set(-Math.sin(az) * d * 1.1, settings.eyeHeight + 1.2, Math.cos(az) * d * 1.1);
  orbit.update();
  xr?.recenter();
}
// From the visitor's eyes, looking at the window: what the mapping is designed for.
function visitorView() {
  applySettings();
  const az = THREE.MathUtils.degToRad(settings.winAz), el = THREE.MathUtils.degToRad(settings.winEl);
  const eye = new THREE.Vector3(0, settings.eyeHeight, settings.moveBack);
  orbitCamera.position.copy(eye);
  orbit.target.copy(eye).add(new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).multiplyScalar(0.05));
  orbit.update();
}

// Sources: test pattern, video file, still image
function useSource(next) {
  if (source.kind === 'video' && next.kind !== 'video') { video.pause(); URL.revokeObjectURL(video.src); video.removeAttribute('src'); video.load(); }
  if (source.kind !== 'pattern' && source.texture !== next.texture) source.texture.dispose();
  source = next;
  sourceQuad.material.map = next.texture;
  sourceQuad.material.needsUpdate = true;
  $('source-view').style.aspectRatio = String(next.aspect);
  $('transport').hidden = next.kind !== 'video';
  notify(`${next.name} · ${next.kind === 'pattern' ? '16:9' : `${next.width}×${next.height}`}`);
}
function loadFile(file) {
  if (!file) return;
  if (file.type.startsWith('image/')) {
    const url = URL.createObjectURL(file);
    new THREE.TextureLoader().load(url, texture => {
      URL.revokeObjectURL(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      const { width, height } = texture.image;
      useSource({ texture, aspect: width / height, name: file.name, kind: 'image', width, height });
    }, undefined, () => notify(`Could not open ${file.name}.`));
    return;
  }
  if (source.kind === 'video') URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  video.onloadedmetadata = () => {
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    useSource({ texture, aspect: video.videoWidth / video.videoHeight, name: file.name, kind: 'video', width: video.videoWidth, height: video.videoHeight });
    video.play().catch(() => {});
  };
  video.onerror = () => notify(`This browser can’t play ${file.name}. Use an H.264 MP4.`);
}
$('file').addEventListener('change', event => { loadFile(event.target.files[0]); event.target.value = ''; });
$('pattern').addEventListener('click', () => useSource({ texture: pattern.texture, aspect: pattern.aspect, name: 'Test pattern', kind: 'pattern' }));
const stage = $('stage');
stage.addEventListener('dragover', event => { event.preventDefault(); $('drop').hidden = false; });
stage.addEventListener('dragleave', event => { if (!stage.contains(event.relatedTarget)) $('drop').hidden = true; });
stage.addEventListener('drop', event => { event.preventDefault(); $('drop').hidden = true; loadFile(event.dataTransfer.files[0]); });

// Transport (video only)
function togglePlay() { if (source.kind !== 'video') return; if (video.paused) video.play(); else video.pause(); }
function formatTime(s) { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
$('play').addEventListener('click', togglePlay);
$('mute').addEventListener('click', () => { video.muted = !video.muted; });
$('scrub').addEventListener('input', event => { if (video.duration) video.currentTime = event.target.value * video.duration; });
function updateTransport() {
  if (source.kind !== 'video') return;
  $('play').textContent = video.paused ? 'Play' : 'Pause';
  $('mute').textContent = video.muted ? 'Unmute' : 'Mute';
  if (document.activeElement !== $('scrub') && video.duration) $('scrub').value = video.currentTime / video.duration;
  $('time').textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
}

// Panel controls
for (const key of Object.keys(RANGES)) $(key).addEventListener('input', event => { settings[key] = Number(event.target.value); applySettings(); });
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => { settings.mode = button.dataset.mode; applySettings(); });
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => { settings.layout = button.dataset.view; applySettings(); });
$('captionOn').addEventListener('change', event => { settings.captionOn = event.target.checked; applySettings(); });
$('captionText').addEventListener('input', event => { settings.captionText = event.target.value; applySettings(); });
$('guides').addEventListener('change', event => { settings.guides = event.target.checked; applySettings(); });
$('recenter').addEventListener('click', recenter);
$('visitor').addEventListener('click', visitorView);
$('reset').addEventListener('click', () => { Object.assign(settings, DEFAULTS); recenter(); notify('Settings reset.'); });
$('download').addEventListener('click', async () => {
  const blob = await compositor.snapshot();
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `domemaster-${settings.mode}.png` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
$('venue-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (venue) scene.remove(venue);
    venue = await loadVenue(file, Number($('venue-units').value));
    scene.add(venue);
    notify(`Loaded venue model ${file.name}.`);
  } catch (error) { notify(`Could not load ${file.name}: ${error.message}`); }
});
$('venue-units').addEventListener('change', event => venue?.scale.setScalar(Number(event.target.value)));

function cycleMode() { settings.mode = MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length]; applySettings(); }
function toggleCaption() { settings.captionOn = !settings.captionOn; applySettings(); }
addEventListener('keydown', event => {
  if (event.target.matches('input[type=text], select')) return;
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  else if (['Digit1', 'Digit2', 'Digit3'].includes(event.code)) { settings.mode = MODES[Number(event.code.at(-1)) - 1]; applySettings(); }
  else if (event.key === 'r' || event.key === 'R') recenter();
  else if (event.key === 'v' || event.key === 'V') visitorView();
  else if (event.key === 'g' || event.key === 'G') { settings.guides = !settings.guides; applySettings(); }
});

// WebXR
const xr = createXR({ renderer, scene, camera, rig, api: {
  notify, togglePlay, cycleMode, toggleCaption, recenter,
  getState: () => ({ paused: video.paused, hasVideo: source.kind === 'video', mode: MODE_LABELS[settings.mode],
    captionOn: settings.captionOn, name: source.name }),
} });

// Render: one canvas, each visible panel drawn into its own rectangle.
function region(element) {
  if (element.offsetParent === null) return null;
  const canvasRect = renderer.domElement.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return { x: rect.left - canvasRect.left, y: canvasRect.bottom - rect.bottom, w: rect.width, h: rect.height };
}
function resize() {
  const { clientWidth: w, clientHeight: h } = renderer.domElement;
  const size = renderer.getSize(new THREE.Vector2());
  if (size.x !== w || size.y !== h) renderer.setSize(w, h, false);
}
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (source.kind === 'pattern') pattern.draw(clock.elapsedTime);
  compositor.update(settings, source.texture, source.aspect, caption, view);
  compositor.render();
  xr.update(dt);
  updateTransport();
  viewer.visible = !renderer.xr.isPresenting;
  if (renderer.xr.isPresenting) { renderer.setScissorTest(false); renderer.render(scene, camera); return; }
  resize();
  renderer.setScissorTest(true);
  const full = renderer.getSize(new THREE.Vector2());
  renderer.setViewport(0, 0, full.x, full.y); renderer.setScissor(0, 0, full.x, full.y);
  renderer.setClearColor(0x0b0e11, 1); renderer.clear();
  const domeRect = region(domeView);
  if (domeRect) {
    renderer.setViewport(domeRect.x, domeRect.y, domeRect.w, domeRect.h);
    renderer.setScissor(domeRect.x, domeRect.y, domeRect.w, domeRect.h);
    orbit.update();
    orbitCamera.aspect = domeRect.w / domeRect.h; orbitCamera.updateProjectionMatrix();
    renderer.render(scene, orbitCamera);
  }
  const sourceRect = region($('source-view'));
  if (sourceRect) {
    renderer.setViewport(sourceRect.x, sourceRect.y, sourceRect.w, sourceRect.h);
    renderer.setScissor(sourceRect.x, sourceRect.y, sourceRect.w, sourceRect.h);
    renderer.render(sourceScene, outputCamera);
  }
  const outRect = region($('output-view'));
  if (outRect) {
    const side = Math.min(outRect.w, outRect.h) - 48;
    const x = outRect.x + (outRect.w - side) / 2, y = outRect.y + (outRect.h - side) / 2;
    renderer.setViewport(x, y, side, side); renderer.setScissor(x, y, side, side);
    renderer.render(outputScene, outputCamera);
  }
});

useSource(source);
applySettings();
recenter();
notify('Test pattern loaded. Load a flat video or image to preview it on the dome.');
