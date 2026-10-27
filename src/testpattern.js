import * as THREE from 'three';

// Animated 16:9 stand-in for flat footage: labelled edges and grid, plus water, swimming loons
// and a flock in flight,
// so mapping and orientation can be read before any real clip is loaded.
export function createTestPattern(width = 1920, height = 1080) {
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const horizon = height * 0.66;

  function drawWater(time) {
    ctx.fillStyle = 'rgba(10,24,34,0.55)';
    ctx.fillRect(0, horizon, width, height - horizon);
    ctx.strokeStyle = 'rgba(160,210,240,0.35)';
    ctx.lineWidth = 3;
    for (let row = 0; row < 7; row++) {
      const y = horizon + 24 + row * 44;
      const amplitude = 4 + row * 2, speed = 1.2 + row * 0.35;
      ctx.beginPath();
      for (let x = 0; x <= width; x += 24) {
        const wave = y + Math.sin(x * 0.012 + time * speed + row) * amplitude;
        if (x === 0) ctx.moveTo(x, wave); else ctx.lineTo(x, wave);
      }
      ctx.stroke();
    }
  }

  function loon(x, y, scale, facing, bob) {
    ctx.save();
    ctx.translate(x, y + bob);
    ctx.scale(scale * facing, scale);
    ctx.fillStyle = '#f2b544';
    ctx.beginPath(); ctx.ellipse(0, 0, 46, 16, 0, 0, Math.PI * 2); ctx.fill();          // body
    ctx.beginPath(); ctx.moveTo(26, -6); ctx.quadraticCurveTo(34, -30, 40, -34); ctx.lineTo(48, -30); ctx.quadraticCurveTo(40, -20, 36, -4); ctx.fill(); // neck
    ctx.beginPath(); ctx.arc(44, -34, 10, 0, Math.PI * 2); ctx.fill();                  // head
    ctx.beginPath(); ctx.moveTo(52, -36); ctx.lineTo(72, -32); ctx.lineTo(52, -30); ctx.fill(); // bill
    ctx.restore();
  }

  function drawLoons(time) {
    // [speed px/s, row y, scale, direction, phase]
    for (const [speed, y, scale, dir, phase] of [[90, 0.74, 1.3, 1, 0], [55, 0.83, 1.7, -1, 0.4], [130, 0.7, 0.9, 1, 0.75]]) {
      const span = width + 300;
      const travel = (phase * span + time * speed) % span;
      const x = dir > 0 ? travel - 150 : width + 150 - travel;
      loon(x, height * y, scale, dir, Math.sin(time * 2.2 + phase * 9) * 5);
    }
  }

  function drawFlock(time) {
    const span = width + 600;
    const lead = (time * 160) % span - 300;
    ctx.strokeStyle = '#f7f3e8';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      const side = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2);
      const x = lead - Math.abs(side) * 70;
      const y = height * 0.3 + side * 46 + Math.sin(time * 1.5 + i) * 10 - (lead / width) * 120;
      const flap = Math.sin(time * 9 + i * 0.8) * 16;
      ctx.beginPath();
      ctx.moveTo(x - 30, y - flap); ctx.quadraticCurveTo(x - 12, y - 6, x, y);
      ctx.quadraticCurveTo(x + 12, y - 6, x + 30, y - flap);
      ctx.stroke();
    }
  }

  function draw(time) {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#2b4a63');
    gradient.addColorStop(1, '#0f1d26');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= width; x += 120) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let y = 0; y <= height; y += 120) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
    drawWater(time);
    drawLoons(time);
    drawFlock(time);
    ctx.strokeStyle = '#f2b544';
    ctx.lineWidth = 12;
    ctx.strokeRect(6, 6, width - 12, height - 12);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 64px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('FLAT 16:9 SOURCE', width / 2, height / 2 - 40);
    ctx.font = '40px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('Load a video to replace this pattern', width / 2, height / 2 + 30);
    ctx.font = '600 44px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('TOP', width / 2, 60);
    ctx.fillText('BOTTOM', width / 2, height - 60);
    ctx.save(); ctx.translate(60, height / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('LEFT', 0, 0); ctx.restore();
    ctx.save(); ctx.translate(width - 60, height / 2); ctx.rotate(Math.PI / 2); ctx.fillText('RIGHT', 0, 0); ctx.restore();
    // Sweep line: shows motion and frame edges as it wraps.
    const sweep = ((time * 0.15) % 1) * width;
    ctx.fillStyle = 'rgba(242,181,68,0.35)';
    ctx.fillRect(sweep - 3, 0, 6, height);
    texture.needsUpdate = true;
  }
  draw(0);
  return { texture, aspect: width / height, draw };
}
