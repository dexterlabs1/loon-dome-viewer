import * as THREE from 'three';

// Caption text rendered to a canvas; the compositor places it on the dome as a flat patch,
// so it reads straight from the centre seat and appears curved in the domemaster.
const HEIGHT = 128;

export function createCaption() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const caption = { texture, aspect: 8, text: null };

  caption.set = (text) => {
    text = text.trim() || ' ';
    if (text === caption.text) return;
    caption.text = text;
    const font = `600 ${HEIGHT * 0.42}px Montserrat, "Helvetica Neue", Arial, sans-serif`;
    ctx.font = font;
    const pad = HEIGHT * 0.45;
    canvas.width = Math.ceil(ctx.measureText(text).width + pad * 2);
    canvas.height = HEIGHT;
    ctx.font = font; // resizing resets context state
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.roundRect(0, HEIGHT * 0.12, canvas.width, HEIGHT * 0.76, HEIGHT * 0.12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad, HEIGHT / 2 + 2);
    caption.aspect = canvas.width / canvas.height;
    texture.dispose(); // canvas size changed; reallocate on the GPU
    texture.needsUpdate = true;
  };
  return caption;
}
