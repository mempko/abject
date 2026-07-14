/**
 * The scene camera — one definition, shared by the renderer that uses it and by
 * the objects that must TELL an author how it behaves.
 *
 * The Compositor builds its projection from these; WidgetManager reports them
 * through `getSceneParams` so a generated object can ask what the perspective
 * actually is instead of guessing. Changing the camera here changes both, and
 * no prompt anywhere has to be edited to match.
 *
 * Geometry: a perspective camera looking down -z, positioned over the viewport
 * centre at `cameraDistance(viewportHeight)`. That distance is chosen so the
 * z=0 plane maps 1:1 to CSS pixels — which is what lets 2D window content and
 * 3D scene nodes share one coordinate space.
 */

/** Vertical field of view, radians. */
export const CAMERA_FOV_Y = (30 * Math.PI) / 180;

/** Near/far plane placement, as multiples of the camera distance. */
export const NEAR_PLANE_FACTOR = 1 / 10;
export const FAR_PLANE_FACTOR = 4;

/**
 * Distance from the eye to the z=0 plane, in px. Derived so that a viewport of
 * `viewportHeight` px exactly fills the vertical FOV at z=0 (the 1:1 mapping).
 * Roughly 1.87 x the viewport height for the current FOV.
 */
export function cameraDistance(viewportHeight: number): number {
  return (Math.max(1, viewportHeight) / 2) / Math.tan(CAMERA_FOV_Y / 2);
}

/**
 * How much larger or smaller a mesh at depth `z` renders than the same mesh at
 * z=0. This is the whole of perspective foreshortening, and the reason a scene
 * laid out across a small z range looks flat no matter how 3D its geometry is.
 */
export function apparentScale(z: number, distance: number): number {
  return distance / Math.max(1e-3, distance - z);
}

/** Nearest z that still renders (anything closer to the viewer is clipped). */
export function nearPlaneZ(distance: number): number {
  return distance - distance * NEAR_PLANE_FACTOR;
}

/** Farthest z that still renders (anything beyond is clipped). */
export function farPlaneZ(distance: number): number {
  return distance - distance * FAR_PLANE_FACTOR;
}
