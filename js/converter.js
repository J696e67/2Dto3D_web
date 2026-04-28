/**
 * converter.js — Full offline port of sketch2stl.py + app.py /convert endpoint.
 *
 * Dependencies:
 *   - OpenCV.js (loaded globally as `cv`)
 *   - earcut (loaded globally as `earcut`)
 *
 * Usage:
 *   import { convertCanvasToSTL } from './converter.js';
 *   const stlBuffer = convertCanvasToSTL(canvas, options);
 */

import { buildSTL } from './stl-writer.js';

// =========================================================================
// Color Detection for Upload Mode
// =========================================================================

/**
 * Detect dominant colors in a canvas image using k-means clustering.
 * Background (white-ish) pixels are excluded via flood-fill from borders.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} maxColors - Maximum number of colors to return (default 5)
 * @returns {Array<{hex: string, rgb: [number,number,number], pixelCount: number}>}
 */
export function detectImageColors(canvas, maxColors = 5) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data; // RGBA

  // --- Flood-fill from borders to find background pixels ---
  const isBackground = new Uint8Array(w * h);
  const WHITE_DIST = 60;
  const queue = [];

  function isWhiteIsh(idx) {
    const r = data[idx * 4], g = data[idx * 4 + 1], b = data[idx * 4 + 2];
    const dist = Math.sqrt((r - 255) ** 2 + (g - 255) ** 2 + (b - 255) ** 2);
    return dist < WHITE_DIST;
  }

  // Seed border pixels
  for (let x = 0; x < w; x++) {
    if (isWhiteIsh(x)) { isBackground[x] = 1; queue.push(x); }
    const bot = (h - 1) * w + x;
    if (isWhiteIsh(bot)) { isBackground[bot] = 1; queue.push(bot); }
  }
  for (let y = 1; y < h - 1; y++) {
    const left = y * w;
    if (isWhiteIsh(left)) { isBackground[left] = 1; queue.push(left); }
    const right = y * w + w - 1;
    if (isWhiteIsh(right)) { isBackground[right] = 1; queue.push(right); }
  }

  // BFS flood-fill
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % w, y = (idx - x) / w;
    const neighbors = [];
    if (x > 0) neighbors.push(idx - 1);
    if (x < w - 1) neighbors.push(idx + 1);
    if (y > 0) neighbors.push(idx - w);
    if (y < h - 1) neighbors.push(idx + w);
    for (const n of neighbors) {
      if (!isBackground[n] && isWhiteIsh(n)) {
        isBackground[n] = 1;
        queue.push(n);
      }
    }
  }

  // --- Collect non-background pixels ---
  const pixels = [];
  for (let i = 0; i < w * h; i++) {
    if (!isBackground[i]) {
      pixels.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
    }
  }

  if (pixels.length === 0) {
    console.log('[detectImageColors] No non-background pixels found');
    return [];
  }

  // Count distinct colors (approximate — quantize to 4-bit)
  const distinctSet = new Set();
  for (const [r, g, b] of pixels) {
    distinctSet.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  const k = Math.min(maxColors, distinctSet.size, pixels.length);
  if (k === 0) return [];

  // --- K-means++ initialization ---
  const centroids = [];
  // Pick first centroid randomly
  centroids.push([...pixels[Math.floor(Math.random() * pixels.length)]]);

  for (let c = 1; c < k; c++) {
    // Compute squared distances to nearest centroid
    const dists = new Float64Array(pixels.length);
    let totalDist = 0;
    for (let i = 0; i < pixels.length; i++) {
      let minD = Infinity;
      for (const cent of centroids) {
        const d = (pixels[i][0] - cent[0]) ** 2 + (pixels[i][1] - cent[1]) ** 2 + (pixels[i][2] - cent[2]) ** 2;
        if (d < minD) minD = d;
      }
      dists[i] = minD;
      totalDist += minD;
    }
    // Weighted random selection
    let r = Math.random() * totalDist;
    for (let i = 0; i < pixels.length; i++) {
      r -= dists[i];
      if (r <= 0) {
        centroids.push([...pixels[i]]);
        break;
      }
    }
    if (centroids.length <= c) {
      centroids.push([...pixels[Math.floor(Math.random() * pixels.length)]]);
    }
  }

  // --- K-means iterations ---
  const assignments = new Int32Array(pixels.length);
  for (let iter = 0; iter < 20; iter++) {
    let changed = 0;

    // Assign pixels to nearest centroid
    for (let i = 0; i < pixels.length; i++) {
      let bestDist = Infinity, bestIdx = 0;
      for (let c = 0; c < k; c++) {
        const d = (pixels[i][0] - centroids[c][0]) ** 2 +
                  (pixels[i][1] - centroids[c][1]) ** 2 +
                  (pixels[i][2] - centroids[c][2]) ** 2;
        if (d < bestDist) { bestDist = d; bestIdx = c; }
      }
      if (assignments[i] !== bestIdx) { changed++; assignments[i] = bestIdx; }
    }

    if (changed === 0) break;

    // Recompute centroids
    const sums = Array.from({ length: k }, () => [0, 0, 0]);
    const counts = new Int32Array(k);
    for (let i = 0; i < pixels.length; i++) {
      const c = assignments[i];
      sums[c][0] += pixels[i][0];
      sums[c][1] += pixels[i][1];
      sums[c][2] += pixels[i][2];
      counts[c]++;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        centroids[c][0] = sums[c][0] / counts[c];
        centroids[c][1] = sums[c][1] / counts[c];
        centroids[c][2] = sums[c][2] / counts[c];
      }
    }
  }

  // --- Post-process: count pixels per cluster ---
  const clusterCounts = new Int32Array(k);
  for (let i = 0; i < pixels.length; i++) {
    clusterCounts[assignments[i]]++;
  }

  // Build result with merge and filter
  let results = [];
  for (let c = 0; c < k; c++) {
    results.push({
      rgb: [Math.round(centroids[c][0]), Math.round(centroids[c][1]), Math.round(centroids[c][2])],
      pixelCount: clusterCounts[c],
    });
  }

  // Remove clusters with < 0.5% of non-background pixels
  const minPixels = pixels.length * 0.005;
  results = results.filter(r => r.pixelCount >= minPixels);

  // Merge centroids that are very close (distance < 30)
  const MERGE_DIST = 30;
  const merged = [];
  const used = new Set();
  // Sort by pixel count descending first so larger clusters absorb smaller ones
  results.sort((a, b) => b.pixelCount - a.pixelCount);
  for (let i = 0; i < results.length; i++) {
    if (used.has(i)) continue;
    const current = { rgb: [...results[i].rgb], pixelCount: results[i].pixelCount };
    for (let j = i + 1; j < results.length; j++) {
      if (used.has(j)) continue;
      const dist = Math.sqrt(
        (results[i].rgb[0] - results[j].rgb[0]) ** 2 +
        (results[i].rgb[1] - results[j].rgb[1]) ** 2 +
        (results[i].rgb[2] - results[j].rgb[2]) ** 2
      );
      if (dist < MERGE_DIST) {
        current.pixelCount += results[j].pixelCount;
        used.add(j);
      }
    }
    merged.push(current);
  }

  // Sort by pixel count descending, limit to maxColors
  merged.sort((a, b) => b.pixelCount - a.pixelCount);
  const final = merged.slice(0, maxColors).map(r => {
    const [rr, gg, bb] = r.rgb;
    const hex = '#' + [rr, gg, bb].map(v => v.toString(16).padStart(2, '0')).join('');
    return { hex, rgb: r.rgb, pixelCount: r.pixelCount };
  });

  console.log('[detectImageColors] Detected colors:', final);
  return final;
}

// =========================================================================
// Custom error for missing closed outline
// =========================================================================
export class NotEnclosedError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'NotEnclosedError';
  }
}

// =========================================================================
// Step 1: Image Preprocessing
// =========================================================================

/**
 * Load a canvas element into an OpenCV Mat and binarize it (grayscale pipeline).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {number} opts.blurRadius - Gaussian blur kernel size (odd).
 * @param {boolean} opts.invert - Invert the binary image.
 * @param {number} opts.upsample - Integer upsampling factor (>=1).
 * @returns {cv.Mat} Binary image (0/255 uint8), caller must .delete()
 */
function loadAndPreprocess(canvas, { blurRadius = 5, invert = false, upsample = 2 } = {}) {
  // Read canvas into a Mat
  const src = cv.imread(canvas);
  // Convert to grayscale
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  src.delete();

  // Upsample
  let img = gray;
  upsample = Math.max(1, Math.round(upsample));
  if (upsample > 1) {
    const upsampled = new cv.Mat();
    const newSize = new cv.Size(img.cols * upsample, img.rows * upsample);
    cv.resize(img, upsampled, newSize, 0, 0, cv.INTER_LANCZOS4);
    img.delete();
    img = upsampled;
  }

  // Gaussian blur (kernel must be odd)
  blurRadius = Math.max(1, blurRadius | 1);
  const blurred = new cv.Mat();
  const ksize = new cv.Size(blurRadius, blurRadius);
  cv.GaussianBlur(img, blurred, ksize, 0);
  img.delete();

  // Otsu binarization
  const binary = new cv.Mat();
  cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  blurred.delete();

  // Invert so strokes are WHITE (255), background BLACK (0)
  cv.bitwise_not(binary, binary);

  if (invert) {
    cv.bitwise_not(binary, binary);
  }

  return binary;
}

/**
 * Load a canvas and segment it into per-color binary masks.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array<[number,number,number]>} paletteRGB - List of [r,g,b] tuples.
 * @param {object} opts
 * @param {number} opts.blurRadius
 * @param {number} opts.upsample
 * @returns {Map<string, cv.Mat>} Map from "r,g,b" key to binary mask Mat.
 *   Caller must .delete() each Mat.
 */
function loadAndPreprocessColor(canvas, paletteRGB, { blurRadius = 5, upsample = 2 } = {}) {
  const src = cv.imread(canvas); // RGBA
  // Convert to RGB (drop alpha)
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  src.delete();

  // Upsample
  let img = rgb;
  upsample = Math.max(1, Math.round(upsample));
  if (upsample > 1) {
    const upsampled = new cv.Mat();
    const newSize = new cv.Size(img.cols * upsample, img.rows * upsample);
    cv.resize(img, upsampled, newSize, 0, 0, cv.INTER_LANCZOS4);
    img.delete();
    img = upsampled;
  }

  const rows = img.rows, cols = img.cols;
  const data = img.data; // Uint8Array, RGB interleaved

  const whiteThreshold = 60.0;

  // For each pixel, determine nearest palette color (skip near-white)
  // Build raw mask arrays (Uint8 per color)
  const numColors = paletteRGB.length;
  const rawMasks = paletteRGB.map(() => new Uint8Array(rows * cols));

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = (r * cols + c) * 3;
      const pr = data[idx], pg = data[idx + 1], pb = data[idx + 2];

      // Distance to white
      const dw = Math.sqrt((pr - 255) ** 2 + (pg - 255) ** 2 + (pb - 255) ** 2);
      if (dw < whiteThreshold) continue; // background

      // Find nearest palette color
      let bestDist = Infinity, bestIdx = 0;
      for (let p = 0; p < numColors; p++) {
        const [cr, cg, cb] = paletteRGB[p];
        const d = Math.sqrt((pr - cr) ** 2 + (pg - cg) ** 2 + (pb - cb) ** 2);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = p;
        }
      }
      rawMasks[bestIdx][r * cols + c] = 255;
    }
  }
  img.delete();

  // Convert raw mask arrays to cv.Mat, apply blur+threshold cleanup
  blurRadius = Math.max(1, blurRadius | 1);
  const result = new Map();

  for (let p = 0; p < numColors; p++) {
    const mask = cv.matFromArray(rows, cols, cv.CV_8UC1, rawMasks[p]);

    // Check if mask has any pixels
    let hasPixels = false;
    for (let i = 0; i < rawMasks[p].length; i++) {
      if (rawMasks[p][i]) { hasPixels = true; break; }
    }
    if (!hasPixels) {
      mask.delete();
      continue;
    }

    if (blurRadius > 1) {
      const blurred = new cv.Mat();
      const ksize = new cv.Size(blurRadius, blurRadius);
      cv.GaussianBlur(mask, blurred, ksize, 0);
      const cleaned = new cv.Mat();
      cv.threshold(blurred, cleaned, 127, 255, cv.THRESH_BINARY);
      blurred.delete();
      mask.delete();
      const key = paletteRGB[p].join(',');
      result.set(key, cleaned);
    } else {
      const key = paletteRGB[p].join(',');
      result.set(key, mask);
    }
  }

  return result;
}

// =========================================================================
// Step 2: Contour Extraction
// =========================================================================

/**
 * Apply circular Gaussian smoothing to a closed contour.
 * Port of _smooth_contour in sketch2stl.py.
 *
 * @param {Float64Array[]} pts - Array of [x,y] pairs (N×2 as array of arrays).
 * @param {number} sigma
 * @returns {Array<[number,number]>} Smoothed points.
 */
function smoothContour(pts, sigma) {
  const n = pts.length;
  if (n < 5 || sigma <= 0) return pts.map(p => [p[0], p[1]]);

  const radius = Math.max(2, Math.ceil(3.0 * sigma));

  // Build Gaussian kernel
  const kernelLen = 2 * radius + 1;
  const kernel = new Float64Array(kernelLen);
  let kSum = 0;
  for (let i = 0; i < kernelLen; i++) {
    const x = i - radius;
    const v = Math.exp(-0.5 * (x / sigma) ** 2);
    kernel[i] = v;
    kSum += v;
  }
  for (let i = 0; i < kernelLen; i++) kernel[i] /= kSum;

  const result = new Array(n);
  for (let col = 0; col < 2; col++) {
    // Wrap-around padding
    const padLen = n + 2 * radius;
    const padded = new Float64Array(padLen);
    // Left padding: last `radius` points
    for (let i = 0; i < radius; i++) {
      padded[i] = pts[(n - radius + i) % n][col];
    }
    // Main data
    for (let i = 0; i < n; i++) {
      padded[radius + i] = pts[i][col];
    }
    // Right padding: first `radius` points
    for (let i = 0; i < radius; i++) {
      padded[radius + n + i] = pts[i][col];
    }

    // Convolution (mode='valid')
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = 0; k < kernelLen; k++) {
        sum += padded[i + k] * kernel[k];
      }
      if (!result[i]) result[i] = [0, 0];
      result[i][col] = sum;
    }
  }

  return result;
}

/**
 * Process a single raw contour: smooth, simplify, filter by area.
 * Port of _process_one_contour.
 *
 * @param {cv.Mat} cnt - Raw contour from findContours
 * @param {number} minArea
 * @param {number} epsilonFactor
 * @param {number} smoothSigma
 * @returns {Array<[number,number]>|null} Processed points or null
 */
function processOneContour(cnt, minArea, epsilonFactor, smoothSigma) {
  const area = cv.contourArea(cnt);
  if (area < minArea) return null;

  // Extract points from Nx1x2 Mat to array of [x,y]
  const n = cnt.rows;
  const data = cnt.data32S;
  let pts = [];
  for (let i = 0; i < n; i++) {
    pts.push([data[i * 2], data[i * 2 + 1]]);
  }

  // Smooth
  pts = smoothContour(pts, smoothSigma);

  // Simplify with approxPolyDP
  if (epsilonFactor > 0) {
    const perimeter = cv.arcLength(cnt, true);
    const epsilon = epsilonFactor * perimeter;
    // Build a Mat from smoothed points for approxPolyDP
    const smoothMat = cv.matFromArray(pts.length, 1, cv.CV_32SC2,
      pts.flatMap(p => [Math.round(p[0]), Math.round(p[1])]));
    const approx = new cv.Mat();
    cv.approxPolyDP(smoothMat, approx, epsilon, true);
    smoothMat.delete();

    const approxN = approx.rows;
    const approxData = approx.data32S;
    pts = [];
    for (let i = 0; i < approxN; i++) {
      pts.push([approxData[i * 2], approxData[i * 2 + 1]]);
    }
    approx.delete();
  }

  if (pts.length < 3) return null;
  return pts;
}

/**
 * Extract contours preserving parent/hole hierarchy.
 * Port of extract_contour_groups.
 *
 * @param {cv.Mat} binary - Binary image (0/255 uint8)
 * @param {number} minArea
 * @param {number} epsilonFactor
 * @param {number} smoothSigma
 * @returns {Array<{outer: Array<[number,number]>, holes: Array<Array<[number,number]>>}>}
 */
function extractContourGroups(binary, minArea = 50.0, epsilonFactor = 0.0005, smoothSigma = 1.5) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  cv.findContours(binary, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_NONE);

  const numContours = contours.size();
  if (numContours === 0) {
    contours.delete();
    hierarchy.delete();
    return [];
  }

  // hierarchy: shape (1, N, 4) - [next, prev, child, parent]
  const hier = hierarchy.data32S;
  const groups = [];

  // Walk top-level (outer) contours — those with parent == -1
  let idx = 0;
  while (idx >= 0 && idx < numContours) {
    const parent = hier[idx * 4 + 3];
    if (parent !== -1) {
      idx = hier[idx * 4]; // next sibling
      continue;
    }

    const cnt = contours.get(idx);
    const outer = processOneContour(cnt, minArea, epsilonFactor, smoothSigma);

    if (outer !== null) {
      const holes = [];
      let childIdx = hier[idx * 4 + 2]; // first child (hole)
      while (childIdx >= 0 && childIdx < numContours) {
        const childCnt = contours.get(childIdx);
        const hole = processOneContour(childCnt, minArea, epsilonFactor, smoothSigma);
        if (hole !== null) {
          holes.push(hole);
        }
        childIdx = hier[childIdx * 4]; // next sibling hole
      }
      groups.push({ outer, holes });
    }

    idx = hier[idx * 4]; // next sibling at top level
  }

  contours.delete();
  hierarchy.delete();
  return groups;
}

// =========================================================================
// Step 3: Triangulation
// =========================================================================

/**
 * 2D cross product: (a-o) × (b-o)
 */
function cross2d(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * Check if point p is inside triangle (a, b, c).
 */
function pointInTriangle(p, a, b, c) {
  const d1 = cross2d(p, a, b);
  const d2 = cross2d(p, b, c);
  const d3 = cross2d(p, c, a);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation for a simple polygon (no holes).
 * Port of _ear_clip_triangulate.
 *
 * @param {Array<[number,number]>} polygon
 * @returns {Array<[number,number,number]>} Triangle index triples.
 */
function earClipTriangulate(polygon) {
  const n = polygon.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  const indices = Array.from({ length: n }, (_, i) => i);
  const triangles = [];

  // Ensure CCW winding
  let signedArea = 0;
  for (let i = 1; i < indices.length - 1; i++) {
    signedArea += cross2d(polygon[indices[0]], polygon[indices[i]], polygon[indices[i + 1]]);
  }
  if (signedArea < 0) indices.reverse();

  const maxIter = n * n + 10;
  let iters = 0;

  while (indices.length > 3 && iters < maxIter) {
    iters++;
    let earFound = false;
    const m = indices.length;

    for (let i = 0; i < m; i++) {
      const prevI = indices[(i - 1 + m) % m];
      const currI = indices[i];
      const nextI = indices[(i + 1) % m];

      const a = polygon[prevI], b = polygon[currI], c = polygon[nextI];
      const cp = cross2d(a, b, c);
      if (cp <= 0) continue; // reflex vertex

      // Check no other vertex inside triangle
      let isEar = true;
      for (let j = 0; j < m; j++) {
        const idx = indices[j];
        if (idx === prevI || idx === currI || idx === nextI) continue;
        if (pointInTriangle(polygon[idx], a, b, c)) {
          isEar = false;
          break;
        }
      }

      if (isEar) {
        triangles.push([prevI, currI, nextI]);
        indices.splice(i, 1);
        earFound = true;
        break;
      }
    }

    if (!earFound) break; // Fall back to fan
  }

  // Remaining indices (3 or fallback fan)
  if (indices.length >= 3) {
    for (let i = 1; i < indices.length - 1; i++) {
      triangles.push([indices[0], indices[i], indices[i + 1]]);
    }
  }

  return triangles;
}

/**
 * Triangulate a polygon with holes using earcut.
 * Port of _triangulate_with_holes.
 *
 * @param {Array<[number,number]>} outer
 * @param {Array<Array<[number,number]>>} holes
 * @returns {{vertices: Array<[number,number]>, triangles: Array<[number,number,number]>}}
 */
function triangulateWithHoles(outer, holes) {
  // Flatten all ring vertices into a single array
  const coords = [];
  const holeIndices = [];

  for (const p of outer) {
    coords.push(p[0], p[1]);
  }

  let offset = outer.length;
  for (const hole of holes) {
    holeIndices.push(offset);
    for (const p of hole) {
      coords.push(p[0], p[1]);
    }
    offset += hole.length;
  }

  const triFlatArr = earcut(coords, holeIndices.length > 0 ? holeIndices : undefined, 2);

  // Reconstruct vertices list
  const vertices = [];
  for (let i = 0; i < coords.length; i += 2) {
    vertices.push([coords[i], coords[i + 1]]);
  }

  const triangles = [];
  for (let i = 0; i < triFlatArr.length; i += 3) {
    triangles.push([triFlatArr[i], triFlatArr[i + 1], triFlatArr[i + 2]]);
  }

  return { vertices, triangles };
}

// =========================================================================
// Step 4: 3D Extrusion helpers
// =========================================================================

/**
 * Compute triangle normal.
 */
function normal(v0, v1, v2) {
  const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
  const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return [0, 0, 1];
  return [nx / len, ny / len, nz / len];
}

/**
 * Extrude a simple 2D polygon (no holes) between two Z levels.
 * Port of _extrude_solid_polygon.
 *
 * @param {Array<[number,number]>} verts2d
 * @param {number} zBottom
 * @param {number} zTop
 * @param {Array} allTriangles - mutated, appended to
 */
function extrudeSolidPolygon(verts2d, zBottom, zTop, allTriangles) {
  const n = verts2d.length;
  if (n < 3) return;

  const top = verts2d.map(v => [v[0], v[1], zTop]);
  const bot = verts2d.map(v => [v[0], v[1], zBottom]);

  // Side walls
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    allTriangles.push([top[i], bot[i], bot[j]]);
    allTriangles.push([top[i], bot[j], top[j]]);
  }

  // Top cap (normal +Z)
  for (const [a, b, c] of earClipTriangulate(verts2d)) {
    let v0 = top[a], v1 = top[b], v2 = top[c];
    if (normal(v0, v1, v2)[2] < 0) {
      [v0, v2] = [v2, v0];
    }
    allTriangles.push([v0, v1, v2]);
  }

  // Bottom cap (normal -Z)
  for (const [a, b, c] of earClipTriangulate(verts2d)) {
    let v0 = bot[a], v1 = bot[b], v2 = bot[c];
    if (normal(v0, v1, v2)[2] > 0) {
      [v0, v2] = [v2, v0];
    }
    allTriangles.push([v0, v1, v2]);
  }
}

/**
 * Compute contour area from an array of [x,y] points.
 * Uses the shoelace formula (same sign convention as cv.contourArea).
 */
function contourArea(pts) {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i][0] * pts[j][1];
    area -= pts[j][0] * pts[i][1];
  }
  return Math.abs(area) / 2;
}

/**
 * Convert pixel coordinates to mm.
 * @param {Array<[number,number]>} pts - pixel [col, row]
 * @param {number} imageHeight - in pixels
 * @param {number} scale - mm per pixel
 * @returns {Array<[number,number]>} mm [x, y]
 */
function toMM(pts, imageHeight, scale) {
  return pts.map(([col, row]) => [col * scale, (imageHeight - row) * scale]);
}

// =========================================================================
// Step 5: Main extrusion functions
// =========================================================================

/**
 * Extrude contour groups (outer + holes) into a triangle list.
 * Port of extrude_contour_groups_to_stl.
 *
 * @param {Array<{outer, holes}>} contourGroups
 * @param {number} imageHeight
 * @param {number} scale
 * @param {number} extrudeHeight
 * @param {number} baseThickness
 * @param {number} baseMargin
 * @returns {Array} Triangle list for buildSTL
 */
function extrudeContourGroupsToTriangles(contourGroups, imageHeight, scale, extrudeHeight, baseThickness, baseMargin) {
  if (!contourGroups.length) {
    throw new Error('No contour groups to extrude. The image may be blank or all shapes were filtered out.');
  }

  // Find the base contour: largest group that has holes (= closed outline)
  let baseGroupIdx = -1;
  let maxArea = 0;
  for (let i = 0; i < contourGroups.length; i++) {
    const { outer, holes } = contourGroups[i];
    if (holes.length > 0) {
      const area = contourArea(outer);
      if (area > maxArea) {
        maxArea = area;
        baseGroupIdx = i;
      }
    }
  }

  if (baseGroupIdx === -1 && baseThickness > 0) {
    throw new NotEnclosedError(
      'Your drawing does not have a closed outline. ' +
      'Please draw a closed boundary around your design ' +
      'so it can be used as the base shape.'
    );
  }

  const zBaseBottom = 0;
  const zBaseTop = baseThickness;
  const zExtrudeBottom = baseThickness;
  const zExtrudeTop = baseThickness + extrudeHeight;

  // Convert all contour groups to mm
  const processed = contourGroups.map(({ outer, holes }) => ({
    outer2d: toMM(outer, imageHeight, scale),
    holes2d: holes.map(h => toMM(h, imageHeight, scale)),
  }));

  const allTriangles = [];

  // Shaped base plate
  if (baseGroupIdx >= 0 && baseThickness > 0) {
    const base2d = processed[baseGroupIdx].outer2d;
    extrudeSolidPolygon(base2d, zBaseBottom, zBaseTop, allTriangles);
  }

  // Extrude each stroke group
  for (const { outer2d, holes2d } of processed) {
    const nOuter = outer2d.length;
    if (nOuter < 3) continue;

    const topOuter = outer2d.map(v => [v[0], v[1], zExtrudeTop]);
    const botOuter = outer2d.map(v => [v[0], v[1], zExtrudeBottom]);

    // Side walls — outer boundary
    for (let i = 0; i < nOuter; i++) {
      const j = (i + 1) % nOuter;
      allTriangles.push([topOuter[i], botOuter[i], botOuter[j]]);
      allTriangles.push([topOuter[i], botOuter[j], topOuter[j]]);
    }

    // Side walls — each hole boundary (reversed winding)
    for (const h2d of holes2d) {
      const nh = h2d.length;
      if (nh < 3) continue;
      const topH = h2d.map(v => [v[0], v[1], zExtrudeTop]);
      const botH = h2d.map(v => [v[0], v[1], zExtrudeBottom]);
      for (let i = 0; i < nh; i++) {
        const j = (i + 1) % nh;
        allTriangles.push([topH[i], topH[j], botH[j]]);
        allTriangles.push([topH[i], botH[j], botH[i]]);
      }
    }

    // Top & bottom caps
    if (holes2d.length > 0) {
      const { vertices, triangles: triIdx } = triangulateWithHoles(outer2d, holes2d);
      const nAll = vertices.length;
      const topAll = vertices.map(v => [v[0], v[1], zExtrudeTop]);
      const botAll = vertices.map(v => [v[0], v[1], zExtrudeBottom]);

      for (const [a, b, c] of triIdx) {
        let v0 = topAll[a], v1 = topAll[b], v2 = topAll[c];
        if (normal(v0, v1, v2)[2] < 0) [v0, v2] = [v2, v0];
        allTriangles.push([v0, v1, v2]);
      }
      for (const [a, b, c] of triIdx) {
        let v0 = botAll[a], v1 = botAll[b], v2 = botAll[c];
        if (normal(v0, v1, v2)[2] > 0) [v0, v2] = [v2, v0];
        allTriangles.push([v0, v1, v2]);
      }
    } else {
      // No holes — simple ear-clip
      const topTris = earClipTriangulate(outer2d);
      for (const [a, b, c] of topTris) {
        let v0 = topOuter[a], v1 = topOuter[b], v2 = topOuter[c];
        if (normal(v0, v1, v2)[2] < 0) [v0, v2] = [v2, v0];
        allTriangles.push([v0, v1, v2]);
      }
      const botTris = earClipTriangulate(outer2d);
      for (const [a, b, c] of botTris) {
        let v0 = botOuter[a], v1 = botOuter[b], v2 = botOuter[c];
        if (normal(v0, v1, v2)[2] > 0) [v0, v2] = [v2, v0];
        allTriangles.push([v0, v1, v2]);
      }
    }
  }

  return allTriangles;
}

/**
 * Extrude multiple color groups at different heights.
 * Port of extrude_multicolor_to_stl.
 *
 * @param {Array<{groups: Array<{outer, holes}>, height: number}>} colorGroups
 * @param {number} imageHeight
 * @param {number} scale
 * @param {number} baseThickness
 * @param {number} baseMargin
 * @param {Array<{outer, holes}>|null} baseContourGroups
 * @returns {Array} Triangle list
 */
function extrudeMulticolorToTriangles(colorGroups, imageHeight, scale, baseThickness, baseMargin, baseContourGroups) {
  // Determine base from combined contour groups or from individual groups
  let searchGroups;
  if (baseContourGroups) {
    searchGroups = baseContourGroups;
  } else {
    searchGroups = [];
    for (const { groups } of colorGroups) {
      searchGroups.push(...groups);
    }
  }

  if (!searchGroups.length && !colorGroups.some(cg => cg.groups.length > 0)) {
    throw new Error('No contour groups to extrude. The image may be blank or all shapes were filtered out.');
  }

  // Find base: largest group with holes
  let baseGroupIdx = -1;
  let maxArea = 0;
  for (let i = 0; i < searchGroups.length; i++) {
    const { outer, holes } = searchGroups[i];
    if (holes.length > 0) {
      const area = contourArea(outer);
      if (area > maxArea) {
        maxArea = area;
        baseGroupIdx = i;
      }
    }
  }

  if (baseGroupIdx === -1 && baseThickness > 0) {
    throw new NotEnclosedError(
      'Your drawing does not have a closed outline. ' +
      'Please draw a closed boundary around your design ' +
      'so it can be used as the base shape.'
    );
  }

  const allTriangles = [];

  // Shaped base plate
  if (baseGroupIdx >= 0 && baseThickness > 0) {
    const base2d = toMM(searchGroups[baseGroupIdx].outer, imageHeight, scale);
    extrudeSolidPolygon(base2d, 0.0, baseThickness, allTriangles);
  }

  // Extrude each color's groups at its height
  for (const { groups, height: extrudeHeight } of colorGroups) {
    const zExtrudeBottom = baseThickness;
    const zExtrudeTop = baseThickness + extrudeHeight;

    for (const { outer, holes } of groups) {
      const outer2d = toMM(outer, imageHeight, scale);
      const holes2d = holes.map(h => toMM(h, imageHeight, scale));

      const nOuter = outer2d.length;
      if (nOuter < 3) continue;

      const topOuter = outer2d.map(v => [v[0], v[1], zExtrudeTop]);
      const botOuter = outer2d.map(v => [v[0], v[1], zExtrudeBottom]);

      // Side walls — outer
      for (let i = 0; i < nOuter; i++) {
        const j = (i + 1) % nOuter;
        allTriangles.push([topOuter[i], botOuter[i], botOuter[j]]);
        allTriangles.push([topOuter[i], botOuter[j], topOuter[j]]);
      }

      // Side walls — holes
      for (const h2d of holes2d) {
        const nh = h2d.length;
        if (nh < 3) continue;
        const topH = h2d.map(v => [v[0], v[1], zExtrudeTop]);
        const botH = h2d.map(v => [v[0], v[1], zExtrudeBottom]);
        for (let i = 0; i < nh; i++) {
          const j = (i + 1) % nh;
          allTriangles.push([topH[i], topH[j], botH[j]]);
          allTriangles.push([topH[i], botH[j], botH[i]]);
        }
      }

      // Top & bottom caps
      if (holes2d.length > 0) {
        const { vertices, triangles: triIdx } = triangulateWithHoles(outer2d, holes2d);
        const topAll = vertices.map(v => [v[0], v[1], zExtrudeTop]);
        const botAll = vertices.map(v => [v[0], v[1], zExtrudeBottom]);

        for (const [a, b, c] of triIdx) {
          let v0 = topAll[a], v1 = topAll[b], v2 = topAll[c];
          if (normal(v0, v1, v2)[2] < 0) [v0, v2] = [v2, v0];
          allTriangles.push([v0, v1, v2]);
        }
        for (const [a, b, c] of triIdx) {
          let v0 = botAll[a], v1 = botAll[b], v2 = botAll[c];
          if (normal(v0, v1, v2)[2] > 0) [v0, v2] = [v2, v0];
          allTriangles.push([v0, v1, v2]);
        }
      } else {
        const topTris = earClipTriangulate(outer2d);
        for (const [a, b, c] of topTris) {
          let v0 = topOuter[a], v1 = topOuter[b], v2 = topOuter[c];
          if (normal(v0, v1, v2)[2] < 0) [v0, v2] = [v2, v0];
          allTriangles.push([v0, v1, v2]);
        }
        const botTris = earClipTriangulate(outer2d);
        for (const [a, b, c] of botTris) {
          let v0 = botOuter[a], v1 = botOuter[b], v2 = botOuter[c];
          if (normal(v0, v1, v2)[2] > 0) [v0, v2] = [v2, v0];
          allTriangles.push([v0, v1, v2]);
        }
      }
    }
  }

  return allTriangles;
}

// =========================================================================
// Main entry point — replaces the /convert API call
// =========================================================================

/**
 * Convert a canvas drawing to a binary STL ArrayBuffer, fully offline.
 *
 * @param {HTMLCanvasElement} canvas - The drawing canvas.
 * @param {object} opts
 * @param {object} opts.colorHeights - Map of hex color to height, e.g. {"#000000": 5, "#E94560": 8}
 * @param {number} opts.baseThickness
 * @param {number} opts.scale
 * @param {number} opts.upsample
 * @param {number} opts.blurRadius
 * @param {number} opts.minArea
 * @param {number} opts.baseMargin
 * @param {boolean} opts.invert
 * @returns {ArrayBuffer} Binary STL data
 */
export function convertCanvasToSTL(canvas, {
  colorHeights = {},
  baseThickness = 2.0,
  scale = 0.1,
  upsample = 2,
  blurRadius = 5,
  minArea = 200.0,
  baseMargin = 2.0,
  invert = false,
} = {}) {
  const effectiveScale = scale / upsample;

  const hasColorHeights = Object.keys(colorHeights).length > 0;
  let triangles;

  if (hasColorHeights) {
    // --- Multi-color pipeline ---
    const paletteRGB = [];
    const hexToRGB = {};
    for (const [hex, height] of Object.entries(colorHeights)) {
      const clean = hex.replace('#', '');
      const r = parseInt(clean.substring(0, 2), 16);
      const g = parseInt(clean.substring(2, 4), 16);
      const b = parseInt(clean.substring(4, 6), 16);
      const rgb = [r, g, b];
      hexToRGB[hex] = rgb;
      paletteRGB.push(rgb);
    }

    const colorMasks = loadAndPreprocessColor(canvas, paletteRGB, { blurRadius, upsample });

    // Combine all masks for base plate determination
    let combinedMask = null;
    for (const mask of colorMasks.values()) {
      if (combinedMask === null) {
        combinedMask = mask.clone();
      } else {
        cv.bitwise_or(combinedMask, mask, combinedMask);
      }
    }

    let baseContourGroups = [];
    if (combinedMask) {
      baseContourGroups = extractContourGroups(combinedMask, minArea);
      combinedMask.delete();
    }

    // Build per-color contour groups with heights
    const multiColorGroups = [];
    for (const [hex, height] of Object.entries(colorHeights)) {
      const rgb = hexToRGB[hex];
      const key = rgb.join(',');
      if (!colorMasks.has(key)) continue;
      const mask = colorMasks.get(key);
      const groups = extractContourGroups(mask, minArea);
      if (groups.length > 0) {
        multiColorGroups.push({ groups, height: parseFloat(height) });
      }
    }

    // Clean up masks
    for (const mask of colorMasks.values()) {
      mask.delete();
    }

    if (multiColorGroups.length === 0) {
      throw new Error('No contours found. Try drawing thicker lines, lowering min area, or toggling invert.');
    }

    // Get image height from the first mask's dimensions
    // We need it from the preprocessed (upsampled) image
    // Reconstruct from canvas dimensions × upsample
    const imageHeight = canvas.height * Math.max(1, Math.round(upsample));

    triangles = extrudeMulticolorToTriangles(
      multiColorGroups, imageHeight, effectiveScale,
      baseThickness, baseMargin, baseContourGroups
    );
  } else {
    // --- Single-color pipeline ---
    const binary = loadAndPreprocess(canvas, { blurRadius, invert, upsample });
    const imageHeight = binary.rows;

    const contourGroups = extractContourGroups(binary, minArea);
    binary.delete();

    if (contourGroups.length === 0) {
      throw new Error('No contours found. Try drawing thicker lines, lowering min area, or toggling invert.');
    }

    triangles = extrudeContourGroupsToTriangles(
      contourGroups, imageHeight, effectiveScale,
      5.0, // default extrude height for single-color
      baseThickness, baseMargin
    );
  }

  return buildSTL(triangles);
}
