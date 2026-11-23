import {
  DEG2RAD,
  INITIAL_VIEW_STATE,
  TILE_SIZE,
  latToMercY,
  lngToMercX,
  mercXToLng,
  mercYToLat,
} from '../constants/map';
import type { EarthquakeRecord, ViewState } from '../types/earthquake';

const MIN_ZOOM = 1.2;
const MAX_ZOOM = 13.5;
const MIN_PITCH = 0;
const MAX_PITCH = 75;
const ALTITUDE = 1.5;

export interface FlyTransition {
  startTime: number;
  duration: number;
  from: ViewState;
  to: ViewState;
}

export class MapCamera {
  public state: ViewState = { ...INITIAL_VIEW_STATE };
  public width = 1440;
  public height = 900;
  public vpMatrix = new Float32Array(16);
  public scale = TILE_SIZE * Math.pow(2, INITIAL_VIEW_STATE.zoom);
  public camDist = ALTITUDE * 900;
  public centerMercX = lngToMercX(INITIAL_VIEW_STATE.longitude);
  public centerMercY = latToMercY(INITIAL_VIEW_STATE.latitude);

  private transition: FlyTransition | null = null;
  private onChangeCallback: () => void;

  constructor(onChange: () => void) {
    this.onChangeCallback = onChange;
    this.updateMatrices();
  }

  public setViewport(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.updateMatrices();
  }

  public isAnimating(): boolean {
    return this.transition !== null;
  }

  public cancelTransition() {
    this.transition = null;
  }

  public setViewState(partial: Partial<ViewState>) {
    this.transition = null;
    if (partial.longitude !== undefined) {
      let lon = partial.longitude;
      while (lon > 180) lon -= 360;
      while (lon < -180) lon += 360;
      this.state.longitude = lon;
    }
    if (partial.latitude !== undefined) {
      this.state.latitude = Math.max(-80, Math.min(80, partial.latitude));
    }
    if (partial.zoom !== undefined) {
      this.state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, partial.zoom));
    }
    if (partial.pitch !== undefined) {
      this.state.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, partial.pitch));
    }
    if (partial.bearing !== undefined) {
      let b = partial.bearing % 360;
      if (b > 180) b -= 360;
      if (b < -180) b += 360;
      this.state.bearing = b;
    }
    this.updateMatrices();
    this.onChangeCallback();
  }

  public flyTo(target: Partial<ViewState>, duration = 1200) {
    const to: ViewState = {
      longitude: target.longitude ?? this.state.longitude,
      latitude: target.latitude ?? this.state.latitude,
      zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, target.zoom ?? this.state.zoom)),
      pitch: Math.max(MIN_PITCH, Math.min(MAX_PITCH, target.pitch ?? this.state.pitch)),
      bearing: target.bearing ?? this.state.bearing,
    };
    this.transition = {
      startTime: performance.now(),
      duration,
      from: { ...this.state },
      to,
    };
    this.onChangeCallback();
  }

  public flyToEarthquake(equake: EarthquakeRecord) {
    const pitch = 60;
    const pitchRadians = pitch * DEG2RAD;
    const depthMeters = equake.depth_km * 1000;
    const meterOffset = depthMeters * Math.tan(pitchRadians);
    const deltaLatitude = meterOffset / 111321;
    const targetLatitude = equake.latitude - deltaLatitude;

    this.flyTo(
      {
        longitude: equake.longitude,
        latitude: targetLatitude,
        zoom: 8,
        pitch: 60,
        bearing: 0,
      },
      1800,
    );
  }

  public stepTransition(now: number): boolean {
    const tr = this.transition;
    if (!tr) return false;
    const rawT = Math.min(1, (now - tr.startTime) / tr.duration);
    // Smooth ease-in-out cubic
    const t = rawT < 0.5 ? 4 * rawT * rawT * rawT : 1 - Math.pow(-2 * rawT + 2, 3) / 2;

    const { from, to } = tr;
    let dLon = to.longitude - from.longitude;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;

    let dBearing = to.bearing - from.bearing;
    if (dBearing > 180) dBearing -= 360;
    if (dBearing < -180) dBearing += 360;

    // Slight parabolic zoom-out arc on long flights for smooth FlyTo feel
    const distDeg = Math.hypot(dLon, to.latitude - from.latitude);
    const arcDip = distDeg > 3 ? Math.min(1.5, Math.log2(distDeg) * 0.35) * Math.sin(Math.PI * t) : 0;

    this.state.longitude = from.longitude + dLon * t;
    this.state.latitude = from.latitude + (to.latitude - from.latitude) * t;
    this.state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, from.zoom + (to.zoom - from.zoom) * t - arcDip));
    this.state.pitch = from.pitch + (to.pitch - from.pitch) * t;
    this.state.bearing = from.bearing + dBearing * t;

    if (rawT >= 1) {
      this.state = { ...to };
      this.transition = null;
    }
    this.updateMatrices();
    return true;
  }

  /**
   * Builds exact column-major WebGL 4x4 View-Projection matrix mapping
   * world normalized Mercator (mx, my, mz) -> WebGL clip space.
   */
  public updateMatrices() {
    const { longitude, latitude, zoom, pitch, bearing } = this.state;
    const scale = TILE_SIZE * Math.pow(2, zoom);
    const cx = lngToMercX(longitude);
    const cy = latToMercY(latitude);
    const camDist = ALTITUDE * this.height;

    this.scale = scale;
    this.centerMercX = cx;
    this.centerMercY = cy;
    this.camDist = camDist;

    const pRad = pitch * DEG2RAD;
    const bRad = bearing * DEG2RAD;
    const cosP = Math.cos(pRad);
    const sinP = Math.sin(pRad);
    const cosB = Math.cos(bRad);
    const sinB = Math.sin(bRad);

    const fx = (2 * camDist) / this.width;
    const fy = (2 * camDist) / this.height;
    const near = camDist * 0.02;
    const far = camDist * 45.0;
    const A = -(far + near) / (far - near);
    const B = -(2 * far * near) / (far - near);

    // Let:
    //   dx =  scale * wx - scale * cx
    //   dy = -scale * wy + scale * cy
    //   dz =  scale * wz
    //   rx =  cosB * dx - sinB * dy
    //   ry =  sinB * dx + cosB * dy
    //   vx = rx
    //   vy = cosP * ry + sinP * dz
    //   vz = -(camDist + sinP * ry - cosP * dz) = -sinP * ry + cosP * dz - camDist
    //   clipX = fx * vx
    //   clipY = fy * vy
    //   clipZ = A * vz + B
    //   clipW = -vz = sinP * ry - cosP * dz + camDist

    // Coefficients of (wx, wy, wz, 1) for rx, ry, dz:
    const rx_x = scale * cosB;
    const rx_y = scale * sinB; // -sinB * (-scale) = +scale * sinB
    const rx_c = -scale * (cosB * cx + sinB * cy);

    const ry_x = scale * sinB;
    const ry_y = -scale * cosB;
    const ry_c = scale * (-sinB * cx + cosB * cy);

    const dz_z = scale;

    // vy = cosP * ry + sinP * dz
    const vy_x = cosP * ry_x;
    const vy_y = cosP * ry_y;
    const vy_z = sinP * dz_z;
    const vy_c = cosP * ry_c;

    // w = clipW = sinP * ry - cosP * dz + camDist  (and vz = -w)
    const w_x = sinP * ry_x;
    const w_y = sinP * ry_y;
    const w_z = -cosP * dz_z;
    const w_c = sinP * ry_c + camDist;

    const m = this.vpMatrix;
    // Column 0 (wx)
    m[0] = fx * rx_x;
    m[1] = fy * vy_x;
    m[2] = -A * w_x;
    m[3] = w_x;

    // Column 1 (wy)
    m[4] = fx * rx_y;
    m[5] = fy * vy_y;
    m[6] = -A * w_y;
    m[7] = w_y;

    // Column 2 (wz)
    m[8] = 0;
    m[9] = fy * vy_z;
    m[10] = -A * w_z;
    m[11] = w_z;

    // Column 3 (constant)
    m[12] = fx * rx_c;
    m[13] = fy * vy_c;
    m[14] = -A * w_c + B;
    m[15] = w_c;
  }

  /**
   * Intersects screen pixel (sx, sy) with the z = 0 ground plane in normalized Mercator [0, 1].
   */
  public screenToGroundMercator(sx: number, sy: number): [number, number] | null {
    const ndcX = (sx / this.width) * 2 - 1;
    const ndcY = 1 - (sy / this.height) * 2;
    const vxRay = ndcX * (this.width * 0.5);
    const vyRay = ndcY * (this.height * 0.5);

    const pRad = this.state.pitch * DEG2RAD;
    const bRad = this.state.bearing * DEG2RAD;
    const cosP = Math.cos(pRad);
    const sinP = Math.sin(pRad);
    const cosB = Math.cos(bRad);
    const sinB = Math.sin(bRad);

    const denom = this.camDist * cosP - vyRay * sinP;
    if (denom <= 1e-3) return null; // Ray points above horizon
    const t = (this.camDist * cosP) / denom;
    if (t <= 0 || t > 30) return null;

    const rx = t * vxRay;
    const ry = -this.camDist * sinP + t * (vyRay * cosP + this.camDist * sinP);

    // Un-rotate by -bearing: dx = rx*cosB + ry*sinB, dy = -rx*sinB + ry*cosB
    const dx = rx * cosB + ry * sinB;
    const dy = -rx * sinB + ry * cosB;

    const wx = this.centerMercX + dx / this.scale;
    const wy = this.centerMercY - dy / this.scale;
    return [wx, wy];
  }

  public panByScreenDelta(prevX: number, prevY: number, currX: number, currY: number) {
    const p0 = this.screenToGroundMercator(prevX, prevY);
    const p1 = this.screenToGroundMercator(currX, currY);
    if (p0 && p1) {
      const newCx = this.centerMercX + (p0[0] - p1[0]);
      const newCy = Math.max(0.05, Math.min(0.95, this.centerMercY + (p0[1] - p1[1])));
      this.setViewState({
        longitude: mercXToLng(newCx),
        latitude: mercYToLat(newCy),
      });
    } else {
      // Fallback simple pixel delta near horizon
      const bRad = this.state.bearing * DEG2RAD;
      const dx = currX - prevX;
      const dy = currY - prevY;
      const cosB = Math.cos(bRad);
      const sinB = Math.sin(bRad);
      const wx = -(dx * cosB + dy * sinB) / this.scale;
      const wy = -(-dx * sinB + dy * cosB) / this.scale;
      const newCy = Math.max(0.05, Math.min(0.95, this.centerMercY + wy));
      this.setViewState({
        longitude: mercXToLng(this.centerMercX + wx),
        latitude: mercYToLat(newCy),
      });
    }
  }

  public zoomAroundScreenPoint(deltaZoom: number, sx: number, sy: number) {
    const anchor = this.screenToGroundMercator(sx, sy);
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.state.zoom + deltaZoom));
    if (nextZoom === this.state.zoom) return;

    this.transition = null;
    this.state.zoom = nextZoom;
    this.updateMatrices();

    if (anchor) {
      const after = this.screenToGroundMercator(sx, sy);
      if (after) {
        const newCx = this.centerMercX + (anchor[0] - after[0]);
        const newCy = Math.max(0.05, Math.min(0.95, this.centerMercY + (anchor[1] - after[1])));
        this.state.longitude = mercXToLng(newCx);
        this.state.latitude = mercYToLat(newCy);
        this.updateMatrices();
      }
    }
    this.onChangeCallback();
  }
}

export interface PointerControllerCallbacks {
  onHover: (sx: number, sy: number) => void;
  onClick: (sx: number, sy: number) => void;
  onLeave: () => void;
  onInteractionStateChange?: (dragging: boolean) => void;
}

/**
 * Attaches smooth mouse, wheel, right-drag rotate/pitch, double-click, and multi-touch controls.
 */
export function attachMapController(
  el: HTMLElement,
  camera: MapCamera,
  callbacks: PointerControllerCallbacks,
): () => void {
  let dragging = false;
  let rotating = false;
  let movedDist = 0;
  let lastX = 0;
  let lastY = 0;

  // Multi-touch state
  const activePointers = new Map<number, { x: number; y: number }>();
  let prevPinchDist = 0;
  let prevPinchAngle = 0;
  let prevPinchMidY = 0;

  const getLocal = (ev: PointerEvent | WheelEvent | MouseEvent) => {
    const rect = el.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const onContextMenu = (ev: MouseEvent) => ev.preventDefault();

  const onPointerDown = (ev: PointerEvent) => {
    if (ev.target !== el) return;
    el.setPointerCapture(ev.pointerId);
    const pt = getLocal(ev);
    activePointers.set(ev.pointerId, pt);
    camera.cancelTransition();

    if (activePointers.size === 1) {
      dragging = true;
      rotating = ev.button === 2 || ev.shiftKey || ev.ctrlKey;
      movedDist = 0;
      lastX = pt.x;
      lastY = pt.y;
      el.style.cursor = rotating ? 'grabbing' : 'grabbing';
      callbacks.onInteractionStateChange?.(true);
    } else if (activePointers.size === 2) {
      dragging = false;
      const [a, b] = Array.from(activePointers.values());
      prevPinchDist = Math.hypot(b.x - a.x, b.y - a.y);
      prevPinchAngle = Math.atan2(b.y - a.y, b.x - a.x);
      prevPinchMidY = (a.y + b.y) * 0.5;
    }
  };

  const onPointerMove = (ev: PointerEvent) => {
    const pt = getLocal(ev);
    if (activePointers.has(ev.pointerId)) {
      activePointers.set(ev.pointerId, pt);
    }

    if (activePointers.size === 2) {
      const [a, b] = Array.from(activePointers.values());
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const midX = (a.x + b.x) * 0.5;
      const midY = (a.y + b.y) * 0.5;

      if (prevPinchDist > 10) {
        const dz = Math.log2(dist / prevPinchDist);
        camera.zoomAroundScreenPoint(dz, midX, midY);
      }
      const dAngle = ((angle - prevPinchAngle) * 180) / Math.PI;
      const dMidY = midY - prevPinchMidY;
      camera.setViewState({
        bearing: camera.state.bearing - dAngle,
        pitch: camera.state.pitch - dMidY * 0.3,
      });

      prevPinchDist = dist;
      prevPinchAngle = angle;
      prevPinchMidY = midY;
      return;
    }

    if (dragging) {
      const dx = pt.x - lastX;
      const dy = pt.y - lastY;
      movedDist += Math.hypot(dx, dy);

      if (rotating) {
        camera.setViewState({
          bearing: camera.state.bearing + dx * 0.35,
          pitch: camera.state.pitch - dy * 0.35,
        });
      } else {
        camera.panByScreenDelta(lastX, lastY, pt.x, pt.y);
      }
      lastX = pt.x;
      lastY = pt.y;
    } else if (ev.target === el) {
      callbacks.onHover(pt.x, pt.y);
    }
  };

  const onPointerUp = (ev: PointerEvent) => {
    const pt = getLocal(ev);
    const wasPrimaryDrag = dragging && activePointers.size === 1;
    activePointers.delete(ev.pointerId);
    if (el.hasPointerCapture(ev.pointerId)) {
      el.releasePointerCapture(ev.pointerId);
    }

    if (activePointers.size === 0) {
      dragging = false;
      rotating = false;
      el.style.cursor = 'grab';
      callbacks.onInteractionStateChange?.(false);
      if (wasPrimaryDrag && movedDist < 5 && ev.button === 0) {
        callbacks.onClick(pt.x, pt.y);
      }
    }
  };

  const onPointerLeave = () => {
    if (!dragging) callbacks.onLeave();
  };

  const onWheel = (ev: WheelEvent) => {
    if (ev.target !== el) return;
    ev.preventDefault();
    const pt = getLocal(ev);
    let delta = -ev.deltaY;
    if (ev.deltaMode === 1) delta *= 32;
    else if (ev.deltaMode === 2) delta *= 400;
    const zoomDelta = Math.max(-1.2, Math.min(1.2, delta * 0.0022));
    camera.zoomAroundScreenPoint(zoomDelta, pt.x, pt.y);
  };

  const onDblClick = (ev: MouseEvent) => {
    if (ev.target !== el) return;
    const pt = getLocal(ev);
    camera.zoomAroundScreenPoint(1.0, pt.x, pt.y);
  };

  el.style.cursor = 'grab';
  el.addEventListener('contextmenu', onContextMenu);
  el.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  el.addEventListener('pointerleave', onPointerLeave);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('dblclick', onDblClick);

  return () => {
    el.removeEventListener('contextmenu', onContextMenu);
    el.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    el.removeEventListener('pointerleave', onPointerLeave);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('dblclick', onDblClick);
  };
}
