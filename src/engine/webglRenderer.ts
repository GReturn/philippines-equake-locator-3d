import type { DecodedBasemap } from '../data/binaryCodec';
import type { QuakeBuffer } from '../data/quakeStore';
import type { MapCamera } from './camera';

// ONLY 3 ULTRA-LEAN SHADER PROGRAMS IN THE ENTIRE ENGINE!
// Explicit layout(location = ...) eliminates all gl.getAttribLocation() calls!

// 1. Branchless Ocean Water Fill (zero uniforms in FS for 1.1M ocean pixels!)
const WATER_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
uniform mat4 uVP;
void main() {
  gl_Position = uVP * vec4(aPos, 0.0, 1.0);
}`;

const WATER_FS = `#version 300 es
precision lowp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.17255, 0.20784, 0.23529, 1.0);
}`;

// 2. Unified Solid + Dashed Line Shader (coastlines, country borders, dashed provincial borders)
const LINE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in float aDist;
uniform mat4 uVP;
out float vDist;
out float vClipW;
void main() {
  gl_Position = uVP * vec4(aPos, 0.0, 1.0);
  vDist = aDist;
  vClipW = gl_Position.w;
}`;

const LINE_FS = `#version 300 es
precision mediump float;
in float vDist;
in float vClipW;
uniform vec4 uColor;
uniform float uScale;   // > 0 enables screen-space [4px on, 2px off] dash
uniform float uCamDist;
out vec4 fragColor;
void main() {
  if (uScale > 0.0 && mod(vDist * uScale, 6.0) > 4.0) discard;
  float fade = 1.0 - smoothstep(uCamDist * 2.5, uCamDist * 8.5, vClipW);
  fragColor = vec4(uColor.rgb, uColor.a * fade);
}`;

// 3. Unified 3D Earthquake Point Cloud Shader (pre-packed RGB attribute -> ZERO shader LUT math!)
const POINT_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aRadiusMerc;
layout(location = 2) in vec3 aColor;

uniform mat4 uVP;
uniform float uScaleCam;
uniform float uDpr;
uniform float uMaxPointSize;

out vec3 vColor;

void main() {
  vec4 clip = uVP * vec4(aPos, 1.0);
  if (clip.w <= 0.0 || abs(clip.x) > clip.w * 1.15 || abs(clip.y) > clip.w * 1.15) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    return;
  }
  gl_Position = clip;
  float rPx = max(2.0, (aRadiusMerc * uScaleCam) / max(1.0, clip.w));
  gl_PointSize = min(uMaxPointSize, rPx * 2.0 * uDpr);
  vColor = aColor;
}`;

const POINT_FS = `#version 300 es
precision lowp float;
in vec3 vColor;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  fragColor = vec4(vColor, 1.0);
}`;

function createProgramAsync(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vs, vsSrc);
  gl.compileShader(vs);

  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, fsSrc);
  gl.compileShader(fs);

  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function createPointVao(gl: WebGL2RenderingContext, vbo: WebGLBuffer, strideFactor = 1): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  const stride = 20 * strideFactor;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, stride, 16);
  return vao;
}

export class WebGL3DRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private cssW = 1;
  private cssH = 1;
  private baseDpr = 1;
  private activeScale = 1;
  private maxPointSize = 1024;

  // Programs (compiled async in constructor; uniforms queried lazily on first draw!)
  private waterProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private pointProg: WebGLProgram;

  private uniformsBound = false;
  private waterVpLoc: WebGLUniformLocation | null = null;
  private lineVpLoc: WebGLUniformLocation | null = null;
  private lineColorLoc: WebGLUniformLocation | null = null;
  private lineScaleLoc: WebGLUniformLocation | null = null;
  private lineCamDistLoc: WebGLUniformLocation | null = null;
  private pointVpLoc: WebGLUniformLocation | null = null;
  private pointScaleCamLoc: WebGLUniformLocation | null = null;
  private pointDprLoc: WebGLUniformLocation | null = null;
  private pointMaxPsLoc: WebGLUniformLocation | null = null;

  // Basemap VAOs
  private waterVao: WebGLVertexArrayObject | null = null;
  private waterIndexCount = 0;
  private coastVao: WebGLVertexArrayObject | null = null;
  private coastIndexCount = 0;
  private countryVao: WebGLVertexArrayObject | null = null;
  private countryVertCount = 0;
  private provVao: WebGLVertexArrayObject | null = null;
  private provVertCount = 0;

  // Dual Zero-Merge Earthquake VBOs + zero-copy strided Motion LOD VAOs on minorVbo!
  private primaryVao: WebGLVertexArrayObject;
  private primaryVbo: WebGLBuffer;
  private primaryVersion = -1;

  private minorVao: WebGLVertexArrayObject;
  private minorLod4Vao: WebGLVertexArrayObject;
  private minorLod8Vao: WebGLVertexArrayObject;
  private minorLod12Vao: WebGLVertexArrayObject;
  private minorVbo: WebGLBuffer;
  private minorVersion = -1;

  constructor(canvas: HTMLCanvasElement, initialCssW: number, initialCssH: number) {
    this.canvas = canvas;
    this.cssW = Math.max(1, initialCssW);
    this.cssH = Math.max(1, initialCssH);
    this.baseDpr = Math.min(window.devicePixelRatio || 1, 2);

    // Pre-size canvas BEFORE getContext('webgl2') so the swapchain is allocated ONCE
    // (eliminates a ~240 ms synchronous 300x150 -> 1440x900 swapchain reallocation on startup!)
    const pw = Math.max(1, Math.round(this.cssW * this.baseDpr));
    const ph = Math.max(1, Math.round(this.cssH * this.baseDpr));
    canvas.width = pw;
    canvas.height = ph;

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    gl.viewport(0, 0, pw, ph);

    // Kick off async compilation of all 3 tiny shaders in parallel with network fetches!
    // IMPORTANT: Do NOT call getUniformLocation / getParameter here so constructor never stalls on GPU IPC!
    this.waterProg = createProgramAsync(gl, WATER_VS, WATER_FS);
    this.lineProg = createProgramAsync(gl, LINE_VS, LINE_FS);
    this.pointProg = createProgramAsync(gl, POINT_VS, POINT_FS);

    this.primaryVbo = gl.createBuffer()!;
    this.primaryVao = createPointVao(gl, this.primaryVbo, 1);
    this.minorVbo = gl.createBuffer()!;
    this.minorVao = createPointVao(gl, this.minorVbo, 1);
    this.minorLod4Vao = createPointVao(gl, this.minorVbo, 4);
    this.minorLod8Vao = createPointVao(gl, this.minorVbo, 8);
    // Max WebGL2 vertexAttribPointer stride is 255 bytes -> 12 * 20 = 240 bytes (100% spec-compliant!)
    this.minorLod12Vao = createPointVao(gl, this.minorVbo, 12);
    gl.bindVertexArray(null);

    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private ensureUniforms() {
    if (this.uniformsBound) return;
    const gl = this.gl;

    if (import.meta.env.DEV) {
      for (const p of [this.waterProg, this.lineProg, this.pointProg]) {
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
          throw new Error(`Link error: ${gl.getProgramInfoLog(p)}`);
        }
      }
    }

    this.waterVpLoc = gl.getUniformLocation(this.waterProg, 'uVP');

    this.lineVpLoc = gl.getUniformLocation(this.lineProg, 'uVP');
    this.lineColorLoc = gl.getUniformLocation(this.lineProg, 'uColor');
    this.lineScaleLoc = gl.getUniformLocation(this.lineProg, 'uScale');
    this.lineCamDistLoc = gl.getUniformLocation(this.lineProg, 'uCamDist');

    this.pointVpLoc = gl.getUniformLocation(this.pointProg, 'uVP');
    this.pointScaleCamLoc = gl.getUniformLocation(this.pointProg, 'uScaleCam');
    this.pointDprLoc = gl.getUniformLocation(this.pointProg, 'uDpr');
    this.pointMaxPsLoc = gl.getUniformLocation(this.pointProg, 'uMaxPointSize');

    const psRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
    this.maxPointSize = psRange ? Math.min(2048, psRange[1]) : 512;
    this.uniformsBound = true;
  }

  public resize(width: number, height: number) {
    this.cssW = Math.max(1, width);
    this.cssH = Math.max(1, height);
    this.baseDpr = Math.min(window.devicePixelRatio || 1, 2);
    this.applyResolutionScale(1);
  }

  /**
   * Adaptive Dynamic Resolution Scaling (DRS):
   * On fast GPUs stays at 1.0x always; on slow/software GPUs during active camera motion
   * with heavy overdraw, smoothly scales backing buffer to keep FPS silky, then snaps
   * back to crisp 1.0x native resolution immediately when motion stops!
   */
  public applyResolutionScale(scale: number) {
    const effDpr = this.baseDpr * scale;
    const pw = Math.max(1, Math.round(this.cssW * effDpr));
    const ph = Math.max(1, Math.round(this.cssH * effDpr));
    this.activeScale = scale;
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.gl.viewport(0, 0, pw, ph);
  }

  public getResolutionScale(): number {
    return this.activeScale;
  }

  public uploadBasemap(bm: DecodedBasemap) {
    const gl = this.gl;
    const sharedVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, sharedVbo);
    gl.bufferData(gl.ARRAY_BUFFER, bm.waterVerts, gl.STATIC_DRAW);

    // Water fill VAO (location 0 = aPos)
    this.waterVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.waterVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, sharedVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const wIbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, bm.waterIndices, gl.STATIC_DRAW);
    this.waterIndexCount = bm.waterIndices.length;

    // Coastline VAO (reuses exact same sharedVbo! location 0 = aPos, location 1 defaults to 0.0)
    this.coastVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.coastVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, sharedVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const cIbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, bm.coastIndices, gl.STATIC_DRAW);
    this.coastIndexCount = bm.coastIndices.length;

    // Country borders VAO (location 0 = aPos)
    if (bm.countryVerts.length > 0) {
      this.countryVao = gl.createVertexArray()!;
      gl.bindVertexArray(this.countryVao);
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, bm.countryVerts, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.countryVertCount = bm.countryVerts.length / 2;
    }

    // Provincial dashed borders VAO (interleaved [x, y, dist]: loc 0 = xy, loc 1 = dist)
    if (bm.provVerts.length > 0) {
      this.provVao = gl.createVertexArray()!;
      gl.bindVertexArray(this.provVao);
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, bm.provVerts, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
      this.provVertCount = bm.provVerts.length / 3;
    }

    gl.bindVertexArray(null);
  }

  private syncBuffers(primary: QuakeBuffer, minor: QuakeBuffer) {
    const gl = this.gl;
    if (primary.version !== this.primaryVersion) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.primaryVbo);
      gl.bufferData(gl.ARRAY_BUFFER, primary.gpuBuf, gl.STATIC_DRAW);
      this.primaryVersion = primary.version;
    }
    if (minor.count > 0 && minor.version !== this.minorVersion) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.minorVbo);
      gl.bufferData(gl.ARRAY_BUFFER, minor.gpuBuf, gl.STATIC_DRAW);
      this.minorVersion = minor.version;
    }
  }

  public renderScene(
    camera: MapCamera,
    primary: QuakeBuffer,
    primarySlice: [number, number],
    minor: QuakeBuffer,
    minorSlice: [number, number],
    minorStride: 1 | 4 | 8 | 12 = 1,
  ) {
    const gl = this.gl;
    this.ensureUniforms();
    this.syncBuffers(primary, minor);

    const vp = camera.vpMatrix;

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.clearColor(0.055, 0.055, 0.055, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 1. Branchless opaque water fill (#2C353C)
    if (this.waterVao && this.waterIndexCount > 0) {
      gl.useProgram(this.waterProg);
      gl.uniformMatrix4fv(this.waterVpLoc, false, vp);
      gl.bindVertexArray(this.waterVao);
      gl.drawElements(gl.TRIANGLES, this.waterIndexCount, gl.UNSIGNED_INT, 0);
    }

    // 2. Unified lines pass: country borders, white coastlines, dashed provincial borders
    gl.enable(gl.BLEND);
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(this.lineVpLoc, false, vp);
    gl.uniform1f(this.lineCamDistLoc, camera.camDist);
    gl.uniform1f(this.lineScaleLoc, 0.0); // solid

    if (this.countryVao && this.countryVertCount > 0) {
      gl.uniform4f(this.lineColorLoc, 96 / 255, 96 / 255, 96 / 255, 0.9);
      gl.bindVertexArray(this.countryVao);
      gl.drawArrays(gl.LINES, 0, this.countryVertCount);
    }

    if (this.coastVao && this.coastIndexCount > 0) {
      gl.uniform4f(this.lineColorLoc, 1.0, 1.0, 1.0, 0.56);
      gl.bindVertexArray(this.coastVao);
      gl.drawElements(gl.LINES, this.coastIndexCount, gl.UNSIGNED_INT, 0);
    }

    if (this.provVao && this.provVertCount > 0 && camera.state.zoom >= 3.8) {
      const provAlpha = Math.min(0.54, (camera.state.zoom - 3.8) * 0.54);
      gl.uniform1f(this.lineScaleLoc, camera.scale); // dashed
      gl.uniform4f(this.lineColorLoc, 1.0, 1.0, 1.0, provAlpha);
      gl.bindVertexArray(this.provVao);
      gl.drawArrays(gl.LINES, 0, this.provVertCount);
    }

    // 3. 3D Earthquakes (SINGLE point shader, dual zero-merge VBOs, opaque + depth test!)
    const pCount = primarySlice[1] - primarySlice[0];
    const mCount = minorSlice[1] - minorSlice[0];

    if ((pCount > 0 && primary.count > 0) || (mCount > 0 && minor.count > 0)) {
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);

      gl.useProgram(this.pointProg);
      gl.uniformMatrix4fv(this.pointVpLoc, false, vp);
      gl.uniform1f(this.pointScaleCamLoc, camera.scale * camera.camDist);
      gl.uniform1f(this.pointDprLoc, this.baseDpr * this.activeScale);
      gl.uniform1f(this.pointMaxPsLoc, this.maxPointSize);

      if (pCount > 0 && primary.count > 0) {
        gl.bindVertexArray(this.primaryVao);
        drawChunkedPoints(gl, primary, primarySlice[0], primarySlice[1], 1, vp);
      }
      if (mCount > 0 && minor.count > 0) {
        const effStride = mCount > 16000 ? minorStride : 1;
        gl.bindVertexArray(
          effStride === 12
            ? this.minorLod12Vao
            : effStride === 8
              ? this.minorLod8Vao
              : effStride === 4
                ? this.minorLod4Vao
                : this.minorVao,
        );
        drawChunkedPoints(gl, minor, minorSlice[0], minorSlice[1], effStride, vp);
      }
    }

    gl.bindVertexArray(null);
  }
}

const CULL_MARGIN = 1.16;

function emitStridedRun(gl: WebGL2RenderingContext, start: number, end: number, strideFactor: number) {
  if (strideFactor === 1) {
    gl.drawArrays(gl.POINTS, start, end - start);
    return;
  }
  const first = Math.ceil(start / strideFactor);
  const last = Math.floor((end - 1) / strideFactor);
  if (last >= first) {
    gl.drawArrays(gl.POINTS, first, last - first + 1);
  }
}

function drawChunkedPoints(
  gl: WebGL2RenderingContext,
  buf: QuakeBuffer,
  sliceStart: number,
  sliceEnd: number,
  strideFactor: number,
  vp: Float32Array,
) {
  const count = sliceEnd - sliceStart;
  const bounds = buf.chunkBounds;
  const shift = buf.chunkShift;
  if (!bounds || !shift || count <= (1 << shift)) {
    emitStridedRun(gl, sliceStart, sliceEnd, strideFactor);
    return;
  }

  // Exact 5-plane clip-space frustum extraction matching POINT_VS (immune to pitch/horizon!)
  const m0 = vp[0], m1 = vp[1], m3 = vp[3];
  const m4 = vp[4], m5 = vp[5], m7 = vp[7];
  const m8 = vp[8], m9 = vp[9], m11 = vp[11];
  const m12 = vp[12], m13 = vp[13], m15 = vp[15];

  const lx = m0 + CULL_MARGIN * m3, ly = m4 + CULL_MARGIN * m7, lz = m8 + CULL_MARGIN * m11, lw = m12 + CULL_MARGIN * m15;
  const rx = CULL_MARGIN * m3 - m0, ry = CULL_MARGIN * m7 - m4, rz = CULL_MARGIN * m11 - m8, rw = CULL_MARGIN * m15 - m12;
  const bx = m1 + CULL_MARGIN * m3, by = m5 + CULL_MARGIN * m7, bz = m9 + CULL_MARGIN * m11, bw = m13 + CULL_MARGIN * m15;
  const tx = CULL_MARGIN * m3 - m1, ty = CULL_MARGIN * m7 - m5, tz = CULL_MARGIN * m11 - m9, tw = CULL_MARGIN * m15 - m13;

  const firstC = sliceStart >>> shift;
  const lastC = (sliceEnd - 1) >>> shift;
  let runStart = -1;
  let runEnd = -1;

  for (let c = firstC; c <= lastC; c++) {
    const cb = c * 5;
    const minX = bounds[cb];
    const maxX = bounds[cb + 1];
    const minY = bounds[cb + 2];
    const maxY = bounds[cb + 3];
    const minZ = bounds[cb + 4]; // maxZ is always 0

    if (
      (m3 >= 0 ? maxX : minX) * m3 + (m7 >= 0 ? maxY : minY) * m7 + (m11 < 0 ? minZ * m11 : 0) + m15 <= 0 ||
      (lx >= 0 ? maxX : minX) * lx + (ly >= 0 ? maxY : minY) * ly + (lz < 0 ? minZ * lz : 0) + lw < 0 ||
      (rx >= 0 ? maxX : minX) * rx + (ry >= 0 ? maxY : minY) * ry + (rz < 0 ? minZ * rz : 0) + rw < 0 ||
      (bx >= 0 ? maxX : minX) * bx + (by >= 0 ? maxY : minY) * by + (bz < 0 ? minZ * bz : 0) + bw < 0 ||
      (tx >= 0 ? maxX : minX) * tx + (ty >= 0 ? maxY : minY) * ty + (tz < 0 ? minZ * tz : 0) + tw < 0
    ) {
      continue;
    }

    const cs = c << shift;
    const ce = (c + 1) << shift;
    const s = cs < sliceStart ? sliceStart : cs;
    const e = ce > sliceEnd ? sliceEnd : ce;
    if (runStart < 0) {
      runStart = s;
      runEnd = e;
    } else if (s === runEnd) {
      runEnd = e;
    } else {
      emitStridedRun(gl, runStart, runEnd, strideFactor);
      runStart = s;
      runEnd = e;
    }
  }
  if (runStart >= 0) {
    emitStridedRun(gl, runStart, runEnd, strideFactor);
  }
}
