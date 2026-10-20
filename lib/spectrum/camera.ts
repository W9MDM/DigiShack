// The 3D waterfall's camera: column-major 4x4 matrices (WebGL's layout) and an orbit camera.
// Everything writes into caller-owned arrays so the render loop allocates nothing.

export type Mat4 = Float32Array;

export function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function perspective(out: Mat4, fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

export function lookAt(
  out: Mat4,
  ex: number,
  ey: number,
  ez: number,
  cx: number,
  cy: number,
  cz: number,
  ux = 0,
  uy = 1,
  uz = 0,
): Mat4 {
  let zx = ex - cx;
  let zy = ey - cy;
  let zz = ez - cz;
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;
  let xx = uy * zz - uz * zy;
  let xy = uz * zx - ux * zz;
  let xz = ux * zy - uy * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len;
  xy /= len;
  xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
  return out;
}

/** out = a * b. `out` may not alias `a` or `b`. */
export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!;
    const b1 = b[c * 4 + 1]!;
    const b2 = b[c * 4 + 2]!;
    const b3 = b[c * 4 + 3]!;
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r]! * b0 + a[4 + r]! * b1 + a[8 + r]! * b2 + a[12 + r]! * b3;
    }
  }
  return out;
}

/**
 * World point to CSS pixels (origin top-left) through `mvp`. Writes [x, y] into `out` and
 * returns false when the point is behind the camera or outside the view.
 */
export function project(
  out: Float32Array,
  mvp: Mat4,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
): boolean {
  const cx = mvp[0]! * x + mvp[4]! * y + mvp[8]! * z + mvp[12]!;
  const cy = mvp[1]! * x + mvp[5]! * y + mvp[9]! * z + mvp[13]!;
  const cw = mvp[3]! * x + mvp[7]! * y + mvp[11]! * z + mvp[15]!;
  if (cw <= 1e-6) return false;
  const nx = cx / cw;
  const ny = cy / cw;
  out[0] = ((nx + 1) / 2) * width;
  out[1] = ((1 - ny) / 2) * height;
  return nx >= -1 && nx <= 1 && ny >= -1 && ny <= 1;
}

export interface OrbitCamera {
  /** Around the vertical axis; 0 looks from the front (newest row nearest). */
  yaw: number;
  /** Elevation above the surface plane. */
  pitch: number;
  distance: number;
  tx: number;
  ty: number;
  tz: number;
}

export const DEFAULT_CAMERA: Readonly<OrbitCamera> = {
  yaw: 0,
  pitch: 0.52,
  distance: 2.7,
  tx: 0,
  ty: 0.1,
  tz: 0.1,
};

export const MIN_PITCH = 0.06;
export const MAX_PITCH = 1.5;
export const MIN_DISTANCE = 0.6;
export const MAX_DISTANCE = 10;
export const FOV_Y = (40 * Math.PI) / 180;

export function resetCamera(cam: OrbitCamera): void {
  Object.assign(cam, DEFAULT_CAMERA);
}

/** Eye position for the camera, into `out` [x, y, z]. */
export function cameraEye(cam: OrbitCamera, out: Float32Array): Float32Array {
  const cp = Math.cos(cam.pitch);
  out[0] = cam.tx + cam.distance * Math.sin(cam.yaw) * cp;
  out[1] = cam.ty + cam.distance * Math.sin(cam.pitch);
  out[2] = cam.tz + cam.distance * Math.cos(cam.yaw) * cp;
  return out;
}

export function orbitBy(cam: OrbitCamera, dYaw: number, dPitch: number): void {
  let yaw = cam.yaw + dYaw;
  // Wrap to (-pi, pi] so a long drag never loses precision.
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  cam.yaw = yaw;
  cam.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, cam.pitch + dPitch));
}

export function zoomBy(cam: OrbitCamera, factor: number): void {
  if (!(factor > 0)) return;
  cam.distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, cam.distance * factor));
}

/** Drag the scene by screen pixels: the point under the cursor follows it at the target's depth. */
export function panBy(cam: OrbitCamera, dxPx: number, dyPx: number, viewportHeightPx: number): void {
  if (!(viewportHeightPx > 0)) return;
  const s = (2 * cam.distance * Math.tan(FOV_Y / 2)) / viewportHeightPx;
  const sy = Math.sin(cam.yaw);
  const cy = Math.cos(cam.yaw);
  const sp = Math.sin(cam.pitch);
  const cp = Math.cos(cam.pitch);
  // Camera right (cy, 0, -sy) and up (-sy*sp, cp, -cy*sp).
  cam.tx += -cy * dxPx * s + -sy * sp * dyPx * s;
  cam.ty += cp * dyPx * s;
  cam.tz += sy * dxPx * s + -cy * sp * dyPx * s;
  cam.tx = Math.max(-2.5, Math.min(2.5, cam.tx));
  cam.ty = Math.max(-1, Math.min(1.5, cam.ty));
  cam.tz = Math.max(-2.5, Math.min(2.5, cam.tz));
}
