/**
 * svg-importer.js — Parse and render SVG files onto a canvas.
 * Uses the browser's native SVG renderer via Image + drawImage for
 * correct handling of transforms, groups, styles, etc.
 */

export const MAX_SVG_SIZE = 3 * 1024 * 1024; // 3MB

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

/**
 * Render SVG onto canvas using the browser's native SVG renderer.
 * Returns a Promise that resolves when rendering is complete.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} svgText
 * @returns {Promise<void>}
 */
export function renderSVGToCanvas(canvas, svgText) {
  const prepared = validateAndPrepareSVG(svgText);

  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const ctx = canvas.getContext('2d');
      const cw = canvas.width, ch = canvas.height;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);

      // Fit to canvas, centered, 5% margin
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      const scale = Math.min(cw / iw, ch / ih) * 0.95;
      const dw = iw * scale, dh = ih * scale;
      const dx = (cw - dw) / 2, dy = (ch - dh) / 2;

      ctx.drawImage(img, dx, dy, dw, dh);
      resolve();
    };

    img.onerror = () => {
      reject(new Error('Failed to render SVG file.'));
    };

    // Use data URI — works reliably in WKWebView
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(prepared)));
  });
}
