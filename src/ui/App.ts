import { DEFAULT_MIN_MAGNITUDE, INITIAL_VIEW_STATE } from '../constants/map';
import { decodeBasemap, type DecodedBasemap } from '../data/binaryCodec';
import { QuakeStore, type PickHit } from '../data/quakeStore';
import { MapCamera, attachMapController } from '../engine/camera';
import { OverlayDomRenderer, toOverlayQuake, type OverlayQuake } from '../engine/overlayDom';
import { pickEarthquakeAt } from '../engine/picker';
import { WebGL3DRenderer } from '../engine/webglRenderer';
import type { ActivePanel, EarthquakeRecord } from '../types/earthquake';
import {
  ICON_CODE,
  ICON_COMPASS,
  ICON_EARTHQUAKE,
  ICON_FILTER,
  ICON_FULLSCREEN_ENTER,
  ICON_FULLSCREEN_EXIT,
  ICON_INFO,
  ICON_LIST,
  ICON_ZOOM_IN,
  ICON_ZOOM_OUT,
} from './icons';

declare global {
  interface Window {
    __APP_READY_MS?: number;
    __PREFETCH__?: {
      basemap?: Promise<ArrayBuffer> | null;
      core?: Promise<ArrayBuffer>;
    };
  }
}

const BM_IDB_NAME = 'ph-equake-basemap-v4';
const BM_IDB_STORE = 'mesh';
const BM_IDB_KEY = 'bm4';
const BM_LS_KEY = 'bm4_cached';

function isBasemapCachedSync(): boolean {
  try { return localStorage.getItem(BM_LS_KEY) === '1'; } catch { return false; }
}

function loadCachedBasemap(): Promise<DecodedBasemap | null> {
  if (!isBasemapCachedSync()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(BM_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(BM_IDB_STORE)) {
          req.result.createObjectStore(BM_IDB_STORE);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(BM_IDB_STORE, 'readonly');
        const g = tx.objectStore(BM_IDB_STORE).get(BM_IDB_KEY);
        g.onsuccess = () => { db.close(); resolve((g.result as DecodedBasemap) ?? null); };
        g.onerror = () => { db.close(); resolve(null); };
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function saveCachedBasemap(bm: DecodedBasemap): void {
  try {
    const req = indexedDB.open(BM_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(BM_IDB_STORE)) {
        req.result.createObjectStore(BM_IDB_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(BM_IDB_STORE, 'readwrite');
      tx.objectStore(BM_IDB_STORE).put(bm, BM_IDB_KEY);
      tx.oncomplete = () => {
        db.close();
        try { localStorage.setItem(BM_LS_KEY, '1'); } catch { /* ignore */ }
      };
      tx.onerror = () => db.close();
    };
  } catch {
    // ignore storage errors
  }
}

export class EarthquakeApp {
  private root: HTMLElement;
  private container: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private camera: MapCamera;
  private renderer: WebGL3DRenderer | null = null;
  private pendingBasemap: DecodedBasemap | null = null;
  private dataLoaded = false;
  private overlay: OverlayDomRenderer;
  private store: QuakeStore;

  private magnitudeRange: [number, number] = [DEFAULT_MIN_MAGNITUDE, 10];
  private primarySlice: [number, number] = [0, 0];
  private minorSlice: [number, number] = [0, 0];

  private activePanel: ActivePanel = null;
  private selectedQuake: EarthquakeRecord | null = null;
  private selectedOverlay: OverlayQuake | null = null;
  private hoveredHit: PickHit | null = null;
  private hoveredOverlay: OverlayQuake | null = null;

  private isDragging = false;
  private sceneDirty = true;
  private overlayDirty = false;
  private rafId = 0;
  private lastFrameMs = 16;
  private lastFrameTime = 0;
  private lastRenderCount = 0;
  private lastMinorStride: 1 | 4 | 8 | 12 = 1;
  private heavyGpu = false;
  private hoverCheckScheduled = false;
  private pendingHoverX = 0;
  private pendingHoverY = 0;
  private hasMarkedReady = false;
  private settleTimer = 0;

  private compassSvg!: SVGSVGElement;
  private fullscreenBtn!: HTMLButtonElement;
  private filterBtn!: HTMLButtonElement;
  private historyBtn!: HTMLButtonElement;
  private majorBtn!: HTMLButtonElement;
  private aboutBtn!: HTMLButtonElement;
  private tooltipEl!: HTMLDivElement;
  private loaderEl!: HTMLDivElement;
  private errorEl!: HTMLDivElement;
  private errorMsgEl!: HTMLParagraphElement;
  private detailsEl!: HTMLDivElement;
  private detailsFields!: {
    mag: HTMLElement;
    loc: HTMLElement;
    date: HTMLElement;
    depth: HTMLElement;
    lat: HTMLElement;
    lon: HTMLElement;
    id: HTMLElement;
  };
  private masterPanelEl!: HTMLDivElement;
  private masterTitleEl!: HTMLHeadingElement;
  private masterContentEl!: HTMLDivElement;

  constructor(root: HTMLElement, baseUrl: string) {
    this.root = root;
    this.store = new QuakeStore(baseUrl);

    this.container = document.createElement('div');
    this.container.className = 'app-root';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.container.appendChild(this.canvas);

    this.overlay = new OverlayDomRenderer(this.container);
    this.buildControls();
    this.buildDetailsPanel();
    this.buildMasterPanel();
    this.buildOverlays();

    this.root.appendChild(this.container);

    this.camera = new MapCamera(() => {
      this.updateCompass();
      this.scheduleRender(true);
    });
    this.camera.setViewport(
      this.container.clientWidth || window.innerWidth,
      this.container.clientHeight || window.innerHeight,
    );

    window.addEventListener('resize', () => this.handleResize(), { passive: true });
    document.addEventListener('fullscreenchange', () => this.updateFullscreenIcon());
    document.addEventListener('mousedown', (ev) => this.handleDocumentMouseDown(ev));

    attachMapController(this.canvas, this.camera, {
      onHover: (x, y) => this.queueHoverCheck(x, y),
      onClick: (x, y) => this.handleCanvasClick(x, y),
      onLeave: () => this.clearHover(),
      onInteractionStateChange: (dragging) => {
        this.isDragging = dragging;
        if (dragging) {
          this.hideTooltip();
        } else if (this.renderer && (this.renderer.getResolutionScale() < 1 || this.lastMinorStride > 1)) {
          this.renderer.applyResolutionScale(1);
          this.scheduleRender(true);
        }
      },
    });

    this.store.onChange(() => this.handleStoreChange());
    this.updateCompass();
    this.startDataLoad(baseUrl);

    // Defer synchronous canvas.getContext('webgl2') until immediately after First Contentful Paint
    // so controls + loading state commit in <100 ms while binary assets download in parallel!
    requestAnimationFrame(() => setTimeout(() => this.initRenderer(), 0));
  }

  private initRenderer() {
    if (this.renderer) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.setViewport(w, h);
    const renderer = new WebGL3DRenderer(this.canvas, w, h);
    this.renderer = renderer;
    if (this.pendingBasemap) {
      renderer.uploadBasemap(this.pendingBasemap);
      this.pendingBasemap = null;
    }
    this.scheduleRender(true);
  }

  private createBtn(title: string, iconHtml: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'widget-btn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = iconHtml;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private buildControls() {
    const topStack = document.createElement('div');
    topStack.className = 'widget-stack widget-stack-top';

    const zoomGroup = document.createElement('div');
    zoomGroup.className = 'widget-group';
    zoomGroup.appendChild(
      this.createBtn('Zoom In', ICON_ZOOM_IN, () => {
        this.camera.flyTo({ zoom: this.camera.state.zoom + 1 }, 250);
      }),
    );
    zoomGroup.appendChild(
      this.createBtn('Zoom Out', ICON_ZOOM_OUT, () => {
        this.camera.flyTo({ zoom: this.camera.state.zoom - 1 }, 250);
      }),
    );
    topStack.appendChild(zoomGroup);

    const compassGroup = document.createElement('div');
    compassGroup.className = 'widget-group';
    const compassBtn = this.createBtn('Reset Compass', `<span class="compass-wrap">${ICON_COMPASS}</span>`, () => {
      const resetPitch = this.camera.state.bearing === 0 ? 0 : INITIAL_VIEW_STATE.pitch;
      this.camera.flyTo({ bearing: 0, pitch: resetPitch }, 350);
    });
    this.compassSvg = compassBtn.querySelector('svg') as SVGSVGElement;
    compassGroup.appendChild(compassBtn);
    topStack.appendChild(compassGroup);

    const fsGroup = document.createElement('div');
    fsGroup.className = 'widget-group';
    this.fullscreenBtn = this.createBtn('Toggle Fullscreen', ICON_FULLSCREEN_ENTER, () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else this.container.requestFullscreen?.().catch(() => {});
    });
    fsGroup.appendChild(this.fullscreenBtn);
    topStack.appendChild(fsGroup);

    const toolsGroup = document.createElement('div');
    toolsGroup.className = 'widget-group';
    this.filterBtn = this.createBtn('Add Filters', ICON_FILTER, () => this.togglePanel('filter'));
    this.historyBtn = this.createBtn('Recent 100 Earthquakes', ICON_LIST, () => this.togglePanel('history'));
    this.majorBtn = this.createBtn('30 Major Earthquakes', ICON_EARTHQUAKE, () => this.togglePanel('major-quakes'));
    toolsGroup.append(this.filterBtn, this.historyBtn, this.majorBtn);
    topStack.appendChild(toolsGroup);

    const bottomStack = document.createElement('div');
    bottomStack.className = 'widget-stack widget-stack-bottom';

    const aboutGroup = document.createElement('div');
    aboutGroup.className = 'widget-group';
    this.aboutBtn = this.createBtn('About', ICON_INFO, () => this.togglePanel('about'));
    aboutGroup.appendChild(this.aboutBtn);

    const codeGroup = document.createElement('div');
    codeGroup.className = 'widget-group';
    codeGroup.appendChild(
      this.createBtn('Source Code', ICON_CODE, () => {
        window.open('https://github.com/GReturn/philippines-equake-locator-3d', '_blank', 'noopener');
      }),
    );

    bottomStack.append(aboutGroup, codeGroup);
    this.container.append(topStack, bottomStack);

    const attr = document.createElement('div');
    attr.className = 'attribution';
    attr.innerHTML = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · PHIVOLCS';
    this.container.appendChild(attr);
  }

  private buildDetailsPanel() {
    this.detailsEl = document.createElement('div');
    this.detailsEl.className = 'details-panel';
    this.detailsEl.innerHTML = `
      <div class="details-header">
        <h3>Earthquake Details</h3>
        <button type="button" class="close-btn" aria-label="Close panel">&times;</button>
      </div>
      <div class="details-body">
        <p><strong>Magnitude:</strong> <span data-f="mag"></span></p>
        <p><strong>Location:</strong> <span data-f="loc"></span></p>
        <p><strong>Date:</strong> <span data-f="date"></span></p>
        <p><strong>Depth:</strong> <span data-f="depth"></span> km</p>
        <p><strong>Latitude:</strong> <span data-f="lat"></span></p>
        <p><strong>Longitude:</strong> <span data-f="lon"></span></p>
        <p><strong>ID:</strong> <span data-f="id"></span></p>
      </div>
    `;
    this.detailsEl.querySelector('.close-btn')!.addEventListener('click', () => this.clearSelection());
    this.detailsFields = {
      mag: this.detailsEl.querySelector('[data-f="mag"]')!,
      loc: this.detailsEl.querySelector('[data-f="loc"]')!,
      date: this.detailsEl.querySelector('[data-f="date"]')!,
      depth: this.detailsEl.querySelector('[data-f="depth"]')!,
      lat: this.detailsEl.querySelector('[data-f="lat"]')!,
      lon: this.detailsEl.querySelector('[data-f="lon"]')!,
      id: this.detailsEl.querySelector('[data-f="id"]')!,
    };
    this.container.appendChild(this.detailsEl);
  }

  private buildMasterPanel() {
    this.masterPanelEl = document.createElement('div');
    this.masterPanelEl.className = 'master-panel';
    this.masterPanelEl.hidden = true;
    this.masterPanelEl.innerHTML = `
      <div class="master-header">
        <h4></h4>
        <button type="button" class="close-btn" aria-label="Close panel">&times;</button>
      </div>
      <div class="master-content"></div>
    `;
    this.masterTitleEl = this.masterPanelEl.querySelector('h4')!;
    this.masterContentEl = this.masterPanelEl.querySelector('.master-content')!;
    this.masterPanelEl.querySelector('.close-btn')!.addEventListener('click', () => this.setActivePanel(null));
    this.container.appendChild(this.masterPanelEl);
  }

  private buildOverlays() {
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'map-tooltip';
    this.container.appendChild(this.tooltipEl);

    const existingLoader = document.getElementById('init-loader') as HTMLDivElement | null;
    if (existingLoader) {
      this.loaderEl = existingLoader;
      this.container.appendChild(this.loaderEl);
    } else {
      this.loaderEl = document.createElement('div');
      this.loaderEl.className = 'loading-overlay';
      this.loaderEl.innerHTML = '<div class="spinner"></div>';
      this.container.appendChild(this.loaderEl);
    }

    this.errorEl = document.createElement('div');
    this.errorEl.className = 'loading-overlay';
    this.errorEl.hidden = true;
    this.errorEl.innerHTML = '<div class="error-box"><p style="font-size:2rem;margin:0 0 0.5rem">⚠️</p><p class="error-msg"></p></div>';
    this.errorMsgEl = this.errorEl.querySelector('.error-msg')!;
    this.container.appendChild(this.errorEl);
  }

  private async startDataLoad(baseUrl: string) {
    const prefetched = window.__PREFETCH__;

    const attachBasemap = (bm: DecodedBasemap) => {
      if (this.renderer) {
        this.renderer.uploadBasemap(bm);
        this.scheduleRender(true);
      } else {
        this.pendingBasemap = bm;
      }
    };

    const basemapPromise = (async () => {
      // On warm reloads, read pre-triangulated basemap straight from IndexedDB (0 ms earcut!)
      const cached = await loadCachedBasemap();
      if (cached) {
        attachBasemap(cached);
        return;
      }
      const buf = await (
        prefetched?.basemap ??
        fetch(`${baseUrl}data/basemap.bin`).then((r) => {
          if (!r.ok) throw new Error(`Basemap HTTP ${r.status}`);
          return r.arrayBuffer();
        })
      );
      const bm = decodeBasemap(buf);
      attachBasemap(bm);
      setTimeout(() => saveCachedBasemap(bm), 2500);
    })();

    const corePromise = this.store.loadCore(prefetched?.core);

    try {
      await Promise.all([basemapPromise, corePromise]);
      this.dataLoaded = true;
      this.scheduleRender(true);
    } catch (err) {
      console.error('Failed to load data:', err);
      this.loaderEl.hidden = true;
      this.errorMsgEl.textContent = 'Failed to load earthquake data. Please try refreshing the page.';
      this.errorEl.hidden = false;
    }
  }

  private handleStoreChange() {
    const maxMag = this.store.maxMag;
    if (this.magnitudeRange[1] === 10 || this.magnitudeRange[1] > maxMag) {
      this.magnitudeRange = [Math.min(this.magnitudeRange[0], maxMag), maxMag];
    }
    this.updateVisibleSlices();
    if (this.activePanel === 'history' || this.activePanel === 'major-quakes') {
      this.renderActivePanel();
    }
    this.scheduleRender(true);
  }

  private updateVisibleSlices() {
    const { primary, minor } = this.store.getVisibleSlices(this.magnitudeRange[0], this.magnitudeRange[1]);
    this.primarySlice = primary;
    this.minorSlice = minor;
  }

  private setMagnitudeRange(minMag: number, maxMag: number) {
    this.magnitudeRange = [minMag, maxMag];
    this.updateVisibleSlices();
    this.scheduleRender(true);

    if (this.store.needsMinorForMinMag(minMag)) {
      this.store.ensureMinorGeo().catch((err) => console.error('Failed to load minor earthquakes:', err));
    }
  }

  private handleResize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.setViewport(w, h);
    if (this.renderer) {
      this.renderer.resize(w, h);
      this.scheduleRender(true);
    }
  }

  private updateCompass() {
    if (!this.compassSvg) return;
    const { pitch, bearing } = this.camera.state;
    this.compassSvg.style.transform = `rotateX(${pitch.toFixed(1)}deg) rotateZ(${(-bearing).toFixed(1)}deg)`;
  }

  private updateFullscreenIcon() {
    this.fullscreenBtn.innerHTML = document.fullscreenElement ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN_ENTER;
  }

  private handleDocumentMouseDown(ev: MouseEvent) {
    if (!this.activePanel) return;
    const target = ev.target as Node;
    if (this.masterPanelEl.contains(target)) return;
    if (
      this.filterBtn.contains(target) ||
      this.historyBtn.contains(target) ||
      this.majorBtn.contains(target) ||
      this.aboutBtn.contains(target)
    ) {
      return;
    }
    this.setActivePanel(null);
  }

  private togglePanel(panel: Exclude<ActivePanel, null>) {
    this.setActivePanel(this.activePanel === panel ? null : panel);
  }

  private setActivePanel(panel: ActivePanel) {
    this.activePanel = panel;
    this.filterBtn.classList.toggle('active', panel === 'filter');
    this.historyBtn.classList.toggle('active', panel === 'history');
    this.majorBtn.classList.toggle('active', panel === 'major-quakes');
    this.aboutBtn.classList.toggle('active', panel === 'about');

    if (!panel) {
      this.masterPanelEl.hidden = true;
      return;
    }
    this.renderActivePanel();
    this.masterPanelEl.hidden = false;
  }

  private renderActivePanel() {
    const panel = this.activePanel;
    if (!panel) return;

    if (panel === 'filter') {
      this.masterTitleEl.textContent = 'Filter by Magnitude';
      const [minVal, maxVal] = this.magnitudeRange;
      const dMin = this.store.minMag;
      const dMax = this.store.maxMag;
      this.masterContentEl.innerHTML = `
        <div class="filter-group">
          <label for="minMag">Min: <span id="minMagVal">${minVal.toFixed(1)}</span></label>
          <input type="range" id="minMag" min="${dMin}" max="${dMax}" step="0.1" value="${minVal}" />
        </div>
        <div class="filter-group">
          <label for="maxMag">Max: <span id="maxMagVal">${maxVal.toFixed(1)}</span></label>
          <input type="range" id="maxMag" min="${dMin}" max="${dMax}" step="0.1" value="${maxVal}" />
        </div>
      `;
      const minInput = this.masterContentEl.querySelector('#minMag') as HTMLInputElement;
      const maxInput = this.masterContentEl.querySelector('#maxMag') as HTMLInputElement;
      const minSpan = this.masterContentEl.querySelector('#minMagVal') as HTMLSpanElement;
      const maxSpan = this.masterContentEl.querySelector('#maxMagVal') as HTMLSpanElement;

      const onMin = () => {
        const nextMin = parseFloat(minInput.value);
        const nextMax = Math.max(nextMin, this.magnitudeRange[1]);
        if (nextMax !== this.magnitudeRange[1]) {
          maxInput.value = String(nextMax);
          maxSpan.textContent = nextMax.toFixed(1);
        }
        minSpan.textContent = nextMin.toFixed(1);
        this.setMagnitudeRange(nextMin, nextMax);
      };
      const onMax = () => {
        const nextMax = parseFloat(maxInput.value);
        const nextMin = Math.min(this.magnitudeRange[0], nextMax);
        if (nextMin !== this.magnitudeRange[0]) {
          minInput.value = String(nextMin);
          minSpan.textContent = nextMin.toFixed(1);
        }
        maxSpan.textContent = nextMax.toFixed(1);
        this.setMagnitudeRange(nextMin, nextMax);
      };
      minInput.addEventListener('input', onMin);
      maxInput.addEventListener('input', onMax);
      return;
    }

    if (panel === 'history' || panel === 'major-quakes') {
      const list = panel === 'history' ? this.store.recentRecords : this.store.majorRecords;
      this.masterTitleEl.textContent = panel === 'history' ? 'Recent 100 Earthquakes' : '30 Major Earthquakes';

      if (list.length === 0) {
        this.masterContentEl.innerHTML = '<p style="color:#aaa;text-align:center">No earthquakes found.</p>';
        return;
      }

      const ul = document.createElement('ul');
      ul.className = 'quake-list';
      const frag = document.createDocumentFragment();
      for (let i = 0; i < list.length; i++) {
        const q = list[i];
        const li = document.createElement('li');
        li.className = 'earthquake-list-item';
        li.tabIndex = 0;
        li.setAttribute('role', 'button');

        const strong = document.createElement('strong');
        strong.textContent = `Mag ${q.magnitude}`;
        const locSpan = document.createElement('span');
        locSpan.className = 'quake-item-loc';
        locSpan.textContent = q.location;
        const dateSpan = document.createElement('span');
        dateSpan.className = 'quake-item-date';
        dateSpan.textContent = new Date(q.timestampMs).toLocaleString();

        li.append(strong, locSpan, dateSpan);
        li.addEventListener('click', () => this.selectFromList(q));
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.selectFromList(q);
          }
        });
        frag.appendChild(li);
      }
      ul.appendChild(frag);
      this.masterContentEl.replaceChildren(ul);
      return;
    }

    if (panel === 'about') {
      this.masterTitleEl.textContent = 'About';
      this.masterContentEl.innerHTML = `
        <p>Check historical earthquakes in the Philippine region dating as far back as 2018.</p>
        <p>Data obtained from <strong>PHIVOLCS</strong>. Refreshed every day at 10 AM PHT / UTC+8.</p>
        <p style="color:#aaa;font-size:0.85rem;margin-top:1rem">Made by Rafael Mendoza.</p>
      `;
    }
  }

  private selectFromList(quake: EarthquakeRecord) {
    let [min, max] = this.magnitudeRange;
    let changed = false;
    if (quake.magnitude < min) { min = quake.magnitude; changed = true; }
    if (quake.magnitude > max) { max = quake.magnitude; changed = true; }
    if (changed) this.setMagnitudeRange(min, max);

    this.selectQuake(quake);
    this.setActivePanel(null);
    this.camera.flyToEarthquake(quake);
  }

  private selectQuake(quake: EarthquakeRecord) {
    this.selectedQuake = quake;
    this.selectedOverlay = toOverlayQuake(quake);
    this.updateDetailsPanel(quake);
    this.detailsEl.classList.add('open');
    this.overlay.update(this.camera, this.selectedOverlay, true);
    this.overlay.restartRipple();
  }

  private updateDetailsPanel(quake: EarthquakeRecord) {
    const f = this.detailsFields;
    f.mag.textContent = String(quake.magnitude);
    f.loc.textContent = quake.location;
    f.date.textContent = quake.timestampMs ? new Date(quake.timestampMs).toLocaleString() : '';
    f.depth.textContent = String(quake.depth_km);
    f.lat.textContent = String(quake.latitude);
    f.lon.textContent = String(quake.longitude);
    f.id.textContent = quake.id;
  }

  private clearSelection() {
    this.selectedQuake = null;
    this.selectedOverlay = null;
    this.hoveredHit = null;
    this.hoveredOverlay = null;
    this.detailsEl.classList.remove('open');
    this.overlay.clear();
  }

  private queueHoverCheck(x: number, y: number) {
    this.pendingHoverX = x;
    this.pendingHoverY = y;
    if (this.hoverCheckScheduled || this.isDragging || this.camera.isAnimating()) return;
    this.hoverCheckScheduled = true;
    requestAnimationFrame(() => {
      this.hoverCheckScheduled = false;
      if (this.isDragging || this.camera.isAnimating()) return;
      this.performHoverPick(this.pendingHoverX, this.pendingHoverY);
    });
  }

  private performHoverPick(x: number, y: number) {
    const hit = pickEarthquakeAt(
      x, y, this.camera,
      this.store.primary, this.primarySlice,
      this.store.minor, this.minorSlice,
    );
    if (hit) {
      const tip = this.store.getTooltipInfo(hit);
      if (tip) {
        this.tooltipEl.textContent = `Mag ${tip.magnitude} Earthquake\n- Depth: ${tip.depth_km} km`;
        this.tooltipEl.style.display = 'block';
        this.tooltipEl.style.transform = `translate3d(${Math.min(this.camera.width - 180, x + 14)}px, ${Math.max(8, y - 12)}px, 0)`;
      }
      this.canvas.style.cursor = 'pointer';

      if (
        !this.selectedQuake &&
        (!this.hoveredHit || this.hoveredHit.bufKind !== hit.bufKind || this.hoveredHit.index !== hit.index)
      ) {
        this.hoveredHit = hit;
        const rec = this.store.getRecordSync(hit);
        if (rec) {
          this.hoveredOverlay = toOverlayQuake(rec);
          this.overlay.update(this.camera, this.hoveredOverlay, false);
          this.overlay.restartRipple();
        }
      }
    } else {
      this.hideTooltip();
      if (!this.isDragging) this.canvas.style.cursor = 'grab';
      if (!this.selectedQuake && this.hoveredHit !== null) {
        this.hoveredHit = null;
        this.hoveredOverlay = null;
        this.overlay.clear();
      }
    }
  }

  private clearHover() {
    this.hideTooltip();
    if (!this.selectedQuake && this.hoveredHit !== null) {
      this.hoveredHit = null;
      this.hoveredOverlay = null;
      this.overlay.clear();
    }
  }

  private hideTooltip() {
    if (this.tooltipEl.style.display !== 'none') {
      this.tooltipEl.style.display = 'none';
    }
  }

  private handleCanvasClick(x: number, y: number) {
    const hit = pickEarthquakeAt(
      x, y, this.camera,
      this.store.primary, this.primarySlice,
      this.store.minor, this.minorSlice,
    );
    if (!hit) {
      this.clearSelection();
      return;
    }

    const immediate = this.store.getRecordSync(hit);
    if (immediate) {
      this.setActivePanel(null);
      this.selectQuake(immediate);
      this.camera.flyToEarthquake(immediate);

      if (immediate.timestampMs === 0) {
        this.store.getRecordFull(hit).then((full) => {
          if (full && this.selectedQuake === immediate) {
            this.selectedQuake = full;
            this.updateDetailsPanel(full);
          }
        }).catch(() => {});
      }
    }
  }

  private scheduleRender(markSceneDirty: boolean) {
    if (markSceneDirty) this.sceneDirty = true;
    this.overlayDirty = true;
    if (!this.renderer) return;
    if (!this.rafId) {
      this.rafId = requestAnimationFrame((now) => this.tick(now));
    }
  }

  private tick(now: number) {
    this.rafId = 0;

    if (this.lastFrameTime > 0) {
      const dt = now - this.lastFrameTime;
      if (dt < 500) {
        this.lastFrameMs = this.lastFrameMs * 0.7 + dt * 0.3;
        if (this.lastRenderCount > 16000 && dt > 34) {
          this.heavyGpu = true;
        }
      }
    }
    this.lastFrameTime = now;

    const animatingCamera = this.camera.stepTransition(now);
    if (animatingCamera) {
      this.updateCompass();
      this.sceneDirty = true;
      this.overlayDirty = true;
    }

    const stillMoving = this.isDragging || this.camera.isAnimating();

    // Non-oscillating Adaptive DRS + Zero-Copy Strided Motion LOD:
    // - Primary significant earthquakes (mag >= 4.3) ALWAYS render 100% (stride 1).
    // - When dense minor points (>16k) move, stratified Morton-order striding (4x or 8x)
    //   cuts vertex load 4x-8x with zero extra VRAM, then snaps IMMEDIATELY back to 100%
    //   full 133k points at crisp 1.0x native resolution on the resting frame!
    if (this.sceneDirty && this.renderer) {
      const renderer = this.renderer;
      const pCount = this.primarySlice[1] - this.primarySlice[0];
      const mCount = this.minorSlice[1] - this.minorSlice[0];
      const visCount = pCount + mCount;
      const curScale = renderer.getResolutionScale();
      let minorStride: 1 | 4 | 8 | 12 = 1;

      if (stillMoving) {
        if (mCount > 16000) {
          if (this.heavyGpu || this.lastFrameMs > 30) {
            minorStride = mCount > 40000 ? 12 : 8;
          } else {
            minorStride = 4;
          }
        }
        if (curScale === 1 && (visCount > 15000 || this.lastFrameMs > 48)) {
          renderer.applyResolutionScale(0.5);
        }
        clearTimeout(this.settleTimer);
        this.settleTimer = window.setTimeout(() => {
          if (
            !this.isDragging &&
            !this.camera.isAnimating() &&
            this.renderer &&
            (this.renderer.getResolutionScale() < 1 || this.lastMinorStride > 1)
          ) {
            this.renderer.applyResolutionScale(1);
            this.scheduleRender(true);
          }
        }, 120);
      } else if (curScale < 1) {
        clearTimeout(this.settleTimer);
        renderer.applyResolutionScale(1);
      }

      this.sceneDirty = false;
      this.lastRenderCount = visCount;
      this.lastMinorStride = minorStride;
      renderer.renderScene(
        this.camera,
        this.store.primary,
        this.primarySlice,
        this.store.minor,
        this.minorSlice,
        minorStride,
      );

      if (!this.hasMarkedReady && this.dataLoaded && this.store.primary.count > 0) {
        this.loaderEl.hidden = true;
        this.hasMarkedReady = true;
        window.__APP_READY_MS = Math.round(performance.now());
      }
    }

    if (this.overlayDirty) {
      this.overlayDirty = false;
      const active = this.selectedOverlay ?? this.hoveredOverlay;
      this.overlay.update(this.camera, active, this.selectedOverlay !== null);
    }

    if (this.renderer && (this.camera.isAnimating() || this.sceneDirty)) {
      this.rafId = requestAnimationFrame((t) => this.tick(t));
    } else {
      this.lastFrameTime = 0;
    }
  }
}
