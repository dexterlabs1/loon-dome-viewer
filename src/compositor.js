import * as THREE from 'three';

// Renders a flat (16:9 etc.) source into a square equidistant domemaster.
// The output texture is linear; the dome mesh and the projector-output panel both sample it.
export const MODES = ['stretch', 'window', 'fill'];
export const MODE_LABELS = { stretch: 'Stretch', window: 'Window', fill: 'Window + fill' };

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Shared GLSL: domemaster uv → direction on the cap, and a gnomonic (flat screen) patch facing azimuth/elevation.
const common = /* glsl */`
  #define PI 3.141592653589793
  uniform float capAngle; // polar angle of the rim; the image circle's edge
  vec3 uvToDirection(vec2 uv) {
    vec2 p = 2.0 * (uv - 0.5);
    float r = length(p);
    float theta = r * capAngle;
    vec2 n = r > 0.0 ? p / r : vec2(0.0);
    return vec3(sin(theta) * n.x, cos(theta), sin(theta) * n.y); // v=0 is front (-Z)
  }
  // Azimuth from front (-Z) toward right (+X); elevation above the springline.
  void patchBasis(float az, float el, out vec3 c, out vec3 right, out vec3 up) {
    c = vec3(cos(el) * sin(az), sin(el), -cos(el) * cos(az));
    right = vec3(cos(az), 0.0, sin(az));
    up = cross(right, c);
  }
  // Returns patch uv (0..1 inside), or -1 when the direction faces away from the patch.
  vec2 gnomonic(vec3 d, vec3 c, vec3 right, vec3 up, float halfW, float halfH) {
    float k = dot(d, c);
    if (k <= 0.01) return vec2(-1.0);
    vec3 p = d / k;
    return vec2(dot(p, right) / (2.0 * halfW) + 0.5, dot(p, up) / (2.0 * halfH) + 0.5);
  }
  float inside(vec2 uv) { return step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0); }
`;

// three uploads video frames as plain RGBA8 and decodes sRGB only inside its built-in materials.
const decode = /* glsl */`
  uniform bool decodeSource;
  vec4 sourceTexel(sampler2D map, vec2 uv) {
    vec4 c = texture2D(map, uv);
    if (decodeSource) c.rgb = mix(c.rgb / 12.92, pow((c.rgb + 0.055) / 1.055, vec3(2.4)), step(0.04045, c.rgb));
    return c;
  }
`;

const blurShader = /* glsl */`
  ${decode}
  uniform sampler2D source;
  uniform vec2 texel;
  uniform float spread, inset;
  varying vec2 vUv;
  void main() {
    vec4 sum = vec4(0.0);
    vec2 uv = mix(vec2(inset), vec2(1.0 - inset), vUv); // ignore frame borders / letterbox bars
    for (int x = -2; x <= 2; x++) for (int y = -2; y <= 2; y++)
      sum += sourceTexel(source, clamp(uv + vec2(float(x), float(y)) * texel * spread, inset, 1.0 - inset));
    gl_FragColor = sum / 25.0;
  }
`;

const fragmentShader = /* glsl */`
  ${common}
  ${decode}
  uniform sampler2D source;
  uniform sampler2D blurNear, blurFar;
  uniform sampler2D caption;
  uniform float sourceAspect;
  uniform int mode;
  uniform float winAz, winEl, winFov, feather, fillAmount;
  uniform vec3 background;
  uniform bool captionOn;
  uniform float capAz, capEl, capWidth, capAspect;
  uniform bool guides;
  uniform vec3 centreFromEye; // sphere centre minus the visitor's eye, in sphere radii
  varying vec2 vUv;

  // Soft edge extension ("ambilight"): every direction outside the window takes the colour of the
  // nearest part of the frame edge, blurring and dimming with angular distance from the window.
  vec3 fillColour(vec3 d, vec3 c, vec3 right, vec3 up, float halfW, float halfH) {
    float a = acos(clamp(dot(d, c), -1.0, 1.0));
    vec2 b = vec2(dot(d, right), dot(d, up));
    vec2 n = length(b) > 1e-5 ? normalize(b) : vec2(1.0, 0.0);
    // Distance to the frame edge along this bearing, on a rounded rectangle so corners don't crease.
    vec2 q = abs(n) / vec2(halfW, halfH);
    float tEdge = 1.0 / pow(pow(q.x, 4.0) + pow(q.y, 4.0), 0.25);
    float beyond = max(a - atan(tEdge), 0.0);
    // Sample just inside the edge (skips borders / letterbox bars), drifting inward further out.
    vec2 p = n * tEdge * mix(0.85, 0.5, smoothstep(0.0, 1.2, beyond));
    vec2 uv = clamp(p / vec2(2.0 * halfW, 2.0 * halfH) + 0.5, 0.0, 1.0);
    // Also blur sideways along the edge, wider further out, so bright details don't streak into rays.
    vec2 along = vec2(-n.y, n.x) * (0.04 + 0.2 * smoothstep(0.0, 1.0, beyond));
    vec3 nearColour = vec3(0.0), farColour = vec3(0.0);
    for (int i = -3; i <= 3; i++) {
      vec2 at = clamp(uv + along * float(i) / 3.0, 0.0, 1.0);
      nearColour += texture2D(blurNear, at).rgb;
      farColour += texture2D(blurFar, at).rgb;
    }
    vec3 colour = mix(nearColour, farColour, smoothstep(0.0, 0.5, beyond)) / 7.0;
    // Full strength at the window edge, easing down to the fill brightness and then fading out.
    float strength = mix(1.0, fillAmount, smoothstep(0.0, 0.4, beyond)) * mix(1.0, 0.25, smoothstep(0.3, 2.0, beyond));
    return mix(background, colour, strength);
  }

  void main() {
    float r = length(vUv - 0.5) * 2.0;
    if (r > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    // Point on the cap, then the visitor's line of sight to it: the window and caption are
    // flat screens as seen from where the visitor stands, not from the sphere's centre.
    vec3 d = normalize(centreFromEye + uvToDirection(vUv));
    vec3 colour = background;

    if (mode == 0) {
      // Naïve: scale the frame to cover the square master, crop to the circle.
      vec2 uv = vec2(0.5 + (vUv.x - 0.5) / sourceAspect, vUv.y);
      colour = sourceTexel(source, uv).rgb;
    } else {
      vec3 c, right, up;
      patchBasis(winAz, winEl, c, right, up);
      float halfW = tan(winFov * 0.5), halfH = halfW / sourceAspect;
      vec2 uv = gnomonic(d, c, right, up, halfW, halfH);
      float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y * sourceAspect, (1.0 - uv.y) * sourceAspect));
      float mask = uv.x < -0.5 ? 0.0 : inside(uv) * (mode == 2 ? smoothstep(0.0, max(feather, 0.0001), edge) : 1.0);
      if (mode == 2) colour = fillColour(d, c, right, up, halfW, halfH);
      colour = mix(colour, sourceTexel(source, clamp(uv, 0.0, 1.0)).rgb, mask);
    }

    if (captionOn) {
      vec3 c, right, up;
      patchBasis(capAz, capEl, c, right, up);
      float halfW = tan(capWidth * 0.5);
      vec2 uv = gnomonic(d, c, right, up, halfW, halfW / capAspect);
      if (uv.x >= 0.0) {
        vec4 text = texture2D(caption, uv);
        colour = mix(colour, text.rgb, text.a * inside(uv));
      }
    }

    if (guides) {
      // Rings at thirds of the cap and the front meridian, to read orientation.
      float ring = 1.0 - smoothstep(0.0, 0.004, abs(mod(r + 1.0 / 6.0, 1.0 / 3.0) - 1.0 / 6.0));
      float front = (1.0 - smoothstep(0.0, 0.004, abs(vUv.x - 0.5))) * step(vUv.y, 0.5);
      colour = mix(colour, vec3(0.35, 0.85, 1.0), max(ring * 0.45, front * 0.6));
    }
    gl_FragColor = vec4(colour, 1.0);
  }
`;

export function createCompositor(renderer, size = 2048) {
  const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: false });
  target.texture.minFilter = target.texture.magFilter = THREE.LinearFilter;
  target.texture.generateMipmaps = false;
  // Two blur levels: near the window keeps some shape, far away is a colour wash.
  const blurNear = new THREE.WebGLRenderTarget(64, 36, { type: THREE.HalfFloatType, depthBuffer: false });
  const blurFar = new THREE.WebGLRenderTarget(16, 9, { type: THREE.HalfFloatType, depthBuffer: false });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  const scene = new THREE.Scene().add(quad);
  const camera = new THREE.Camera();

  const blurMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader: blurShader,
    uniforms: { source: { value: null }, decodeSource: { value: false }, texel: { value: new THREE.Vector2() }, spread: { value: 1 }, inset: { value: 0 } }, depthTest: false });
  const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, depthTest: false, uniforms: {
    source: { value: null }, decodeSource: { value: false }, blurNear: { value: blurNear.texture }, blurFar: { value: blurFar.texture }, caption: { value: null },
    sourceAspect: { value: 16 / 9 }, mode: { value: 1 },
    winAz: { value: 0 }, winEl: { value: 0 }, winFov: { value: 1 }, feather: { value: 0.1 },
    fillAmount: { value: 0.6 }, background: { value: new THREE.Color(0x07090b) },
    captionOn: { value: true }, capAz: { value: 0 }, capEl: { value: 0 }, capWidth: { value: 1 }, capAspect: { value: 8 },
    guides: { value: false }, capAngle: { value: Math.PI / 2 }, centreFromEye: { value: new THREE.Vector3() },
  } });

  const deg = THREE.MathUtils.degToRad;
  // view: { capAngle, centreFromEye } from the venue geometry.
  function update(settings, source, aspect, caption, view) {
    const u = material.uniforms;
    u.capAngle.value = view.capAngle;
    u.centreFromEye.value.copy(view.centreFromEye);
    u.source.value = source;
    u.decodeSource.value = Boolean(source?.isVideoTexture);
    u.sourceAspect.value = aspect;
    u.mode.value = Math.max(0, MODES.indexOf(settings.mode));
    u.winAz.value = deg(settings.winAz);
    u.winEl.value = deg(settings.winEl);
    u.winFov.value = deg(settings.winFov);
    u.feather.value = settings.feather;
    u.fillAmount.value = settings.fillAmount;
    u.captionOn.value = settings.captionOn && Boolean(caption);
    u.caption.value = caption?.texture ?? null;
    u.capAspect.value = caption?.aspect ?? 8;
    u.capAz.value = deg(settings.capAz);
    u.capEl.value = deg(settings.capEl);
    // Caption size is its angular height; width follows the text's aspect.
    u.capWidth.value = 2 * Math.atan(Math.tan(deg(settings.capSize) / 2) * u.capAspect.value);
    u.guides.value = settings.guides;
  }

  function render() {
    if (!material.uniforms.source.value) return;
    const previous = renderer.getRenderTarget();
    const xr = renderer.xr.enabled;
    renderer.xr.enabled = false; // offscreen passes must not use the headset cameras
    if (material.uniforms.mode.value === 2) {
      quad.material = blurMaterial;
      const b = blurMaterial.uniforms;
      for (const [from, to, decodeFrom, spread, inset] of [[material.uniforms.source.value, blurNear, material.uniforms.decodeSource.value, 4, 0.04],
        [blurNear.texture, blurFar, false, 2, 0]]) {
        b.inset.value = inset;
        b.source.value = from;
        b.decodeSource.value = decodeFrom;
        b.texel.value.set(1 / to.width, 1 / to.height);
        b.spread.value = spread;
        renderer.setRenderTarget(to);
        renderer.render(scene, camera);
      }
    }
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
    renderer.xr.enabled = xr;
  }

  // 8-bit sRGB snapshot of the current domemaster, as a PNG blob.
  const encodeMaterial = new THREE.ShaderMaterial({ vertexShader, depthTest: false, uniforms: { map: { value: target.texture } },
    fragmentShader: `uniform sampler2D map; varying vec2 vUv;
      void main() {
        vec3 c = clamp(texture2D(map, vUv).rgb, 0.0, 1.0);
        gl_FragColor = vec4(mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)), 1.0);
      }` });
  async function snapshot() {
    const out = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false });
    const xr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    quad.material = encodeMaterial;
    renderer.setRenderTarget(out);
    renderer.render(scene, camera);
    const pixels = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(out, 0, 0, size, size, pixels);
    renderer.setRenderTarget(null);
    renderer.xr.enabled = xr;
    out.dispose();
    const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
    const image = canvas.getContext('2d').createImageData(size, size);
    for (let row = 0; row < size; row++) // WebGL rows are bottom-up
      image.data.set(pixels.subarray((size - 1 - row) * size * 4, (size - row) * size * 4), row * size * 4);
    canvas.getContext('2d').putImageData(image, 0, 0);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  return { texture: target.texture, update, render, snapshot };
}
