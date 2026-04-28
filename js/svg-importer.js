/**
 * svg-importer.js — Parse and render SVG / raster image files onto a canvas.
 * Uses the browser's native rendering via Image + drawImage.
 */

export const MAX_SVG_SIZE = 3 * 1024 * 1024;     // 3MB
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;  // 10MB

export const ACCEPTED_IMAGE_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
export const ACCEPTED_IMAGE_ACCEPT_ATTR =
  'image/svg+xml,image/png,image/jpeg,image/webp,image/gif,image/bmp';

export function isSVGFile(file) {
  if (!file) return false;
  return file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml';
}

export function isRasterImageFile(file) {
  if (!file || isSVGFile(file)) return false;
  const name = (file.name || '').toLowerCase();
  if (ACCEPTED_IMAGE_EXTS.some(ext => ext !== '.svg' && name.endsWith(ext))) return true;
  if (file.type && file.type.startsWith('image/') && file.type !== 'image/svg+xml') return true;
  return false;
}

export function isAcceptedImageFile(file) {
  return isSVGFile(file) || isRasterImageFile(file);
}

/**
 * Validate SVG text and ensure it contains <path> data.
 * Also ensures the SVG has explicit width/height for rasterization.
 *
 * @param {string} svgText
 * @returns {string} SVG text with explicit width/height set
 */
export function validateAndPrepareSVG(svgText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Unable to parse this SVG file. Please make sure it is a valid SVG format.');
  }

  const svgEl = doc.querySelector('svg');
  if (!svgEl) {
    throw new Error('No SVG element found in the file.');
  }

  const pathEls = doc.querySelectorAll('path');
  if (pathEls.length === 0) {
    throw new Error('No usable path (<path>) data found in the SVG file.');
  }

  // Ensure explicit width/height for correct Image rasterization
  const viewBox = svgEl.getAttribute('viewBox');
  const hasWidth = svgEl.getAttribute('width') && !svgEl.getAttribute('width').includes('%');
  const hasHeight = svgEl.getAttribute('height') && !svgEl.getAttribute('height').includes('%');

  if (!hasWidth || !hasHeight) {
    if (viewBox) {
      const parts = viewBox.trim().split(/[\s,]+/);
      svgEl.setAttribute('width', parts[2]);
      svgEl.setAttribute('height', parts[3]);
    } else {
      svgEl.setAttribute('width', '800');
      svgEl.setAttribute('height', '600');
    }
    return new XMLSerializer().serializeToString(doc);
  }

  return svgText;
}

function drawImageFitted(canvas, img) {
  const ctx = canvas.getContext('2d');
  const cw = canvas.width, ch = canvas.height;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);

  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.min(cw / iw, ch / ih) * 0.95;
  const dw = iw * scale, dh = ih * scale;
  const dx = (cw - dw) / 2, dy = (ch - dh) / 2;

  ctx.drawImage(img, dx, dy, dw, dh);
}

/**
 * Render SVG onto canvas using the browser's native SVG renderer.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} svgText
 * @returns {Promise<void>}
 */
export function renderSVGToCanvas(canvas, svgText) {
  const prepared = validateAndPrepareSVG(svgText);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { drawImageFitted(canvas, img); resolve(); };
    img.onerror = () => reject(new Error('Failed to render SVG file.'));
    // Use data URI — works reliably in WKWebView
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(prepared)));
  });
}

/**
 * Render a raster image data URL (PNG/JPG/WebP/GIF/BMP) onto canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} dataUrl
 * @returns {Promise<void>}
 */
export function renderRasterDataURLToCanvas(canvas, dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { drawImageFitted(canvas, img); resolve(); };
    img.onerror = () => reject(new Error('Failed to render image file.'));
    img.src = dataUrl;
  });
}

/**
 * Render any accepted image File onto canvas. Routes SVG to the SVG path,
 * everything else to the raster path.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {File|Blob} file
 * @returns {Promise<void>}
 */
export async function renderImageFileToCanvas(canvas, file) {
  if (isSVGFile(file)) {
    const text = await file.text();
    await renderSVGToCanvas(canvas, text);
    return;
  }
  if (!isRasterImageFile(file)) {
    throw new Error('Unsupported image format.');
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(ev.target.result);
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
  await renderRasterDataURLToCanvas(canvas, dataUrl);
}
