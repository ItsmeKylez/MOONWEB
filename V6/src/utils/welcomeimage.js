'use strict';
/* Renders the welcome image as PNG with @napi-rs/canvas (optionalDependency, loaded lazily).
   If the package is missing, available() is false and callers show a clear message — nothing is faked. */
const { imageLayout, render } = require('./welcomefmt');

let canvasLib; let loadError = null;
function lib() {
  if (canvasLib !== undefined) return canvasLib;
  try { canvasLib = require('@napi-rs/canvas'); } catch (e) { canvasLib = null; loadError = e.message; }
  return canvasLib;
}
const available = () => !!lib();
const unavailableReason = () => 'Image rendering needs the optional package @napi-rs/canvas. Run “npm install” (it is listed under optionalDependencies) and restart the bot.';

/** Magic-byte check so only real PNG/JPEG files are accepted as backgrounds. */
function isImageBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  return png || jpg;
}

function fit(ctx2d, text, maxWidth, start, weight = 'bold') {
  let size = start;
  while (size > 18) { ctx2d.font = `${weight} ${size}px sans-serif`; if (ctx2d.measureText(text).width <= maxWidth) break; size -= 2; }
  ctx2d.font = `${weight} ${size}px sans-serif`;
}

/** img = settings.welcome.image; ctx = variable context; avatarUrl optional; bg = Buffer|null -> PNG Buffer */
async function renderWelcomeImage(img, ctx, { avatarUrl = null, bg = null } = {}) {
  const c = lib();
  if (!c) throw new Error(unavailableReason());
  const L = imageLayout(img);
  const canvas = c.createCanvas(L.W, L.H);
  const g = canvas.getContext('2d');

  if (bg) {
    try { // cover-fit the custom background
      const im = await c.loadImage(bg);
      const k = Math.max(L.W / im.width, L.H / im.height);
      g.drawImage(im, (L.W - im.width * k) / 2, (L.H - im.height * k) / 2, im.width * k, im.height * k);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, L.W, L.H); // keeps text readable
    } catch { bg = null; }
  }
  if (!bg) {
    const grad = g.createLinearGradient(0, 0, L.W, L.H);
    grad.addColorStop(0, img.bgColor); grad.addColorStop(1, img.bgColor2);
    g.fillStyle = grad; g.fillRect(0, 0, L.W, L.H);
  }
  g.fillStyle = img.accentColor; g.fillRect(0, L.H - 8, L.W, 8);

  if (L.avatar && avatarUrl) {
    try {
      const av = await c.loadImage(avatarUrl);
      g.save(); g.beginPath(); g.arc(L.avatar.x, L.avatar.y, L.avatar.r, 0, Math.PI * 2); g.closePath(); g.clip();
      g.drawImage(av, L.avatar.x - L.avatar.r, L.avatar.y - L.avatar.r, L.avatar.r * 2, L.avatar.r * 2); g.restore();
      g.lineWidth = 6; g.strokeStyle = img.accentColor; g.beginPath(); g.arc(L.avatar.x, L.avatar.y, L.avatar.r, 0, Math.PI * 2); g.stroke();
    } catch { /* avatar unavailable: leave the ring empty */ }
  }

  g.textAlign = L.textAlign; g.textBaseline = 'alphabetic';
  const title = render(img.title, ctx, { plain: true }); const sub = render(img.subtitle, ctx, { plain: true });
  g.fillStyle = img.textColor; fit(g, title, L.maxTextWidth, 54); g.fillText(title, L.textX, L.titleY);
  g.fillStyle = img.accentColor; fit(g, sub, L.maxTextWidth, 30, 'normal'); g.fillText(sub, L.textX, L.subtitleY);
  return canvas.toBuffer('image/png');
}

module.exports = { available, unavailableReason, isImageBuffer, renderWelcomeImage, get loadError() { return loadError; } };
