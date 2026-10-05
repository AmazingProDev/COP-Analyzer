/* Global Cesium overlay for the operational map.
 * It is intentionally a visual adapter: Leaflet remains canonical for the
 * loaded logs, the layer controls and all RF/RCA calculations. */
(function () {
  'use strict';

  const CESIUM_SCRIPT = '/vendor/cesium/Cesium.js';
  const safeNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const cssColor = (value, fallback = '#94a3b8') => {
    try { return Cesium.Color.fromCssColorString(value || fallback); } catch (_) { return Cesium.Color.fromCssColorString(fallback); }
  };
  // PolylineCollection expects a Cesium Material, not a Color.  Passing a
  // Color works only until Cesium compiles the collection shader, then leaves
  // the scene black with an internal `undefined.search` error.
  const polylineMaterial = (value, fallback = '#94a3b8', alpha = 1) =>
    Cesium.Material.fromType('Color', { color: cssColor(value, fallback).withAlpha(alpha) });

  class CesiumMapAdapter {
    constructor({ leafletRenderer, leafletMap, containerId = 'mapCesiumContainer', toggleId = 'map3dToggle' } = {}) {
      this.leafletRenderer = leafletRenderer;
      this.leafletMap = leafletMap;
      this.container = document.getElementById(containerId);
      this.toggle = document.getElementById(toggleId);
      this.viewer = null;
      this.config = null;
      this.active = false;
      this.buildings = null;
      this.pointCollection = null;
      this.trackCollection = null;
      this.eventCollection = null;
      this.segmentCollection = null;
      this.segmentBadgeCollection = null;
      this.siteCollection = null;
      this.siteSectorCollection = null;
      this.connectionCollection = null;
      this.refreshTimer = null;
      this.lastLeafletBounds = null;
      this.status = null;
      this.canvasHost = null;
      this.pickHandler = null;
    }

    install() {
      if (!this.container || !this.toggle || !this.leafletMap) return;
      this.status = document.createElement('div');
      this.status.className = 'cesium-map-status';
      this.container.appendChild(this.status);
      this.setStatus('Vue 3D prête à être chargée.');
      this.toggle.addEventListener('click', () => this.setActive(!this.active));
      this.leafletMap.on('moveend', () => { if (this.active) this.scheduleRefresh(); });
      window.addEventListener('metric-color-changed', () => this.scheduleRefresh());
      window.addEventListener('optim-map-3d-refresh', () => this.scheduleRefresh());
    }

    setStatus(message, error = false) {
      if (!this.status) return;
      this.status.textContent = message;
      this.status.classList.toggle('is-error', Boolean(error));
    }

    async setActive(active) {
      if (active) {
        try {
          this.lastLeafletBounds = this.leafletMap.getBounds();
          // Cesium must be constructed after its host has real dimensions.
          // Initialising a WebGL canvas inside display:none produces a zero-size,
          // black scene on Chromium even though the Viewer itself succeeds.
          this.container.classList.add('is-active');
          await this.ensureViewer();
          this.active = true;
          this.leafletMap.getContainer().style.visibility = 'hidden';
          this.toggle.setAttribute('aria-pressed', 'true');
          this.toggle.textContent = '2D';
          this.viewer.resize();
          this.flyToLeafletBounds(this.lastLeafletBounds);
          this.refresh();
          this.viewer.scene.requestRender();
        } catch (error) {
          this.active = false;
          this.container.classList.remove('is-active');
          this.leafletMap.getContainer().style.visibility = '';
          this.setStatus(`Vue 3D indisponible : ${error.message || error}`, true);
          // The Cesium container is intentionally hidden again on fallback, so
          // surface the reason through the normal non-blocking application UI.
          window.showToast?.(`Vue 3D indisponible — Leaflet 2D reste actif : ${error.message || error}`, 'warn');
          this.toggle.setAttribute('aria-pressed', 'false');
          this.toggle.textContent = '3D';
        }
      } else {
        this.syncLeafletBounds();
        this.active = false;
        this.container.classList.remove('is-active');
        this.leafletMap.getContainer().style.visibility = '';
        this.leafletMap.invalidateSize();
        this.toggle.setAttribute('aria-pressed', 'false');
        this.toggle.textContent = '3D';
      }
    }

    async fetchConfig() {
      const response = await fetch('/api/cesium/config', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`configuration Cesium (${response.status})`);
      const payload = await response.json();
      if (!payload.enabled || !payload.accessToken) {
        throw new Error('configurez OPTIM_CESIUM_ION_TOKEN et OPTIM_CESIUM_3D_ENABLED=1');
      }
      return payload;
    }

    async loadCesium() {
      if (window.Cesium) return window.Cesium;
      window.CESIUM_BASE_URL = '/vendor/cesium/';
      await new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-optim-cesium="${CESIUM_SCRIPT}"]`);
        if (existing) { existing.addEventListener('load', resolve, { once: true }); existing.addEventListener('error', reject, { once: true }); return; }
        const script = document.createElement('script');
        script.src = CESIUM_SCRIPT;
        script.async = true;
        script.dataset.optimCesium = CESIUM_SCRIPT;
        script.onload = resolve;
        script.onerror = () => reject(new Error('bibliothèque Cesium introuvable'));
        document.head.appendChild(script);
      });
      if (!window.Cesium) throw new Error('bibliothèque Cesium non chargée');
      return window.Cesium;
    }

    async ensureViewer() {
      if (this.viewer) return this.viewer;
      this.setStatus('Chargement de Cesium et des bâtiments OSM…');
      await this.loadCesium();
      this.config = await this.fetchConfig();
      Cesium.Ion.defaultAccessToken = this.config.accessToken;
      const options = {
        imageryProvider: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: true,
        navigationHelpButton: false,
        fullscreenButton: false,
        animation: false,
        timeline: false,
        infoBox: false,
        selectionIndicator: false,
        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
        msaaSamples: 4,
      };
      if (this.config.worldTerrainEnabled && Cesium.Terrain?.fromWorldTerrain) {
        options.terrain = Cesium.Terrain.fromWorldTerrain();
      } else {
        options.terrainProvider = new Cesium.EllipsoidTerrainProvider();
      }
      this.canvasHost = document.createElement('div');
      this.canvasHost.id = 'mapCesiumCanvasHost';
      this.container.insertBefore(this.canvasHost, this.status);
      this.viewer = new Cesium.Viewer(this.canvasHost, options);
      this.viewer.scene.renderError.addEventListener((_scene, error) => {
        console.error('[CesiumMapAdapter] render error', error);
        this.setStatus(`Rendu 3D indisponible : ${error?.message || error}`, true);
        // A WebGL/context failure must never strand the user on a black map.
        window.setTimeout(() => this.setActive(false), 0);
        window.showToast?.('Rendu Cesium indisponible — retour automatique à la carte 2D.', 'warn');
      });
      this.viewer.scene.canvas.addEventListener('webglcontextlost', () => {
        this.setStatus('Contexte WebGL perdu : retour à la carte 2D.', true);
        window.setTimeout(() => this.setActive(false), 0);
      }, { once: true });
      this.viewer.resolutionScale = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
      this.viewer.scene.fxaa = true;
      this.viewer.scene.globe.tileCacheSize = 512;
      this.viewer.scene.globe.baseColor = cssColor('#071323');
      const imagery = new Cesium.UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        credit: 'Esri, Maxar, Earthstar Geographics', maximumLevel: 19,
      });
      this.viewer.imageryLayers.addImageryProvider(imagery);
      await this.loadOsmBuildings();
      this.installPicking();
      this.setStatus('3D active · OSM Buildings visuels · les données RF restent inchangées.');
      return this.viewer;
    }

    async loadOsmBuildings() {
      try {
        this.buildings = await Cesium.createOsmBuildingsAsync({
          style: new Cesium.Cesium3DTileStyle({ color: "color('#cbd5e1', 0.72)" }),
        });
        this.buildings.maximumScreenSpaceError = 12;
        this.buildings.skipLevelOfDetail = true;
        this.buildings.id = { kind: 'osm-building' };
        this.viewer.scene.primitives.add(this.buildings);
      } catch (error) {
        this.setStatus(`Bâtiments OSM indisponibles : ${error.message || error}. Les données DT restent utilisables.`, true);
      }
    }

    installPicking() {
      this.pickHandler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
      this.pickHandler.setInputAction((movement) => {
        const picked = this.viewer.scene.pick(movement.position);
        const item = picked?.id;
        if (!item) return;
        if (item.kind === 'point') {
          if (typeof window.focusMapPointDetailsFromMap === 'function') {
            window.focusMapPointDetailsFromMap(item.logId, item.point, 'cesium-3d');
          } else {
            window.dispatchEvent(new CustomEvent('map-point-clicked', { detail: { logId: item.logId, point: item.point, source: 'cesium-3d' } }));
          }
        } else if (item.kind === 'segment') {
          item.onClick?.(item.segment);
        } else if (item.kind === 'site' && item.site?.cellId && this.leafletRenderer?.highlightCell) {
          this.leafletRenderer.highlightCell(item.site.cellId);
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    scheduleRefresh() {
      if (!this.active || !this.viewer) return;
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.refresh(), 100);
    }

    clearCollection(collection) {
      if (collection) this.viewer.scene.primitives.remove(collection);
    }

    visibleLogs() {
      const logs = Array.isArray(window.loadedLogs) ? window.loadedLogs : [];
      const visible = this.leafletRenderer?.logLayers || {};
      return logs.filter((log) => visible[log.id] && Array.isArray(log.points));
    }

    refresh() {
      if (!this.active || !this.viewer) return;
      this.renderPoints();
      this.renderTracks();
      this.renderEvents();
      this.renderSegments();
      this.renderSites();
      this.renderConnections();
      this.viewer.scene.requestRender();
    }

    renderPoints() {
      this.clearCollection(this.pointCollection);
      const collection = new Cesium.PointPrimitiveCollection();
      const renderer = this.leafletRenderer;
      this.visibleLogs().forEach((log) => {
        const metric = log.currentParam || renderer?.activeMetric || renderer?.currentMetric || 'level';
        log.points.forEach((point) => {
          const lat = safeNumber(point?.lat); const lng = safeNumber(point?.lng);
          if (lat === null || lng === null) return;
          const value = renderer?.getMetricValue ? renderer.getMetricValue(point, metric) : point?.[metric];
          const color = renderer?.getColor ? renderer.getColor(value, metric) : '#38bdf8';
          collection.add({
            position: Cesium.Cartesian3.fromDegrees(lng, lat, 2),
            color: cssColor(color), pixelSize: point.type === 'EVENT' ? 9 : 5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            id: { kind: 'point', logId: log.id, point },
          });
        });
      });
      this.pointCollection = collection;
      this.viewer.scene.primitives.add(collection);
    }

    // One polyline per loaded log keeps the route readable at a distance while
    // PointPrimitiveCollection preserves the metric colour of every sample.
    renderTracks() {
      this.clearCollection(this.trackCollection);
      const collection = new Cesium.PolylineCollection();
      this.visibleLogs().forEach((log) => {
        const positions = log.points.map((point) => {
          const lat = safeNumber(point?.lat); const lng = safeNumber(point?.lng);
          return lat === null || lng === null ? null : Cesium.Cartesian3.fromDegrees(lng, lat, 1);
        }).filter(Boolean);
        if (positions.length > 1) collection.add({ positions, width: 2, material: polylineMaterial('#cbd5e1', '#cbd5e1', 0.38) });
      });
      this.trackCollection = collection;
      this.viewer.scene.primitives.add(collection);
    }

    renderEvents() {
      this.clearCollection(this.eventCollection);
      const collection = new Cesium.PointPrimitiveCollection();
      const logs = Array.isArray(window.loadedLogs) ? window.loadedLogs : [];
      const visibleEvents = this.leafletRenderer?.eventLayers || {};
      const sources = this.leafletRenderer?.eventSourcePoints || {};
      Object.entries(sources).forEach(([layerId, points]) => {
        if (!visibleEvents[layerId] || !Array.isArray(points)) return;
        const matchingLog = logs.find((log) => layerId === log.id || layerId.startsWith(`${log.id}__`));
        points.forEach((point) => {
          const lat = safeNumber(point?.lat); const lng = safeNumber(point?.lng);
          if (lat === null || lng === null) return;
          collection.add({ position: Cesium.Cartesian3.fromDegrees(lng, lat, 5), color: Cesium.Color.RED,
            outlineColor: Cesium.Color.WHITE, outlineWidth: 2, pixelSize: 12, disableDepthTestDistance: Number.POSITIVE_INFINITY,
            id: { kind: 'point', logId: matchingLog?.id || layerId, point } });
        });
      });
      this.eventCollection = collection;
      this.viewer.scene.primitives.add(collection);
    }

    renderSegments() {
      this.clearCollection(this.segmentCollection);
      this.clearCollection(this.segmentBadgeCollection);
      const collection = new Cesium.PolylineCollection();
      const badges = new Cesium.BillboardCollection();
      const entries = Object.values(this.leafletRenderer?.voiceDegradationSegments || {});
      entries.forEach((entry) => (entry.segments || []).forEach((segment) => {
        const positions = (segment.points || []).map((point) => {
          const lat = safeNumber(point?.lat); const lng = safeNumber(point?.lng);
          return lat === null || lng === null ? null : Cesium.Cartesian3.fromDegrees(lng, lat, 5);
        }).filter(Boolean);
        if (positions.length < 2) return;
        const core = collection.add({ positions, width: Math.min(10, 3 + Math.sqrt(Number(segment.sampleCount) || positions.length)),
          material: polylineMaterial(segment.color || '#f97316', '#f97316'), id: { kind: 'segment', segment, onClick: entry.onSegmentClick } });
        core.id = { kind: 'segment', segment, onClick: entry.onSegmentClick };
        const rank = Number(segment.rank);
        if (Number.isFinite(rank) && rank > 0) {
          badges.add({
            position: positions[Math.floor(positions.length / 2)],
            image: this.segmentBadgeImage(`#${rank}`, segment.typeLabel || 'Dégradation', segment.color || '#f97316'),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(24, 0),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            id: { kind: 'segment', segment, onClick: entry.onSegmentClick },
          });
        }
      }));
      this.segmentCollection = collection;
      this.segmentBadgeCollection = badges;
      this.viewer.scene.primitives.add(collection);
      this.viewer.scene.primitives.add(badges);
    }

    segmentBadgeImage(rank, type, color) {
      const canvas = document.createElement('canvas');
      canvas.width = 136; canvas.height = 52;
      const context = canvas.getContext('2d');
      const normalized = String(type || '').slice(0, 18);
      context.globalAlpha = 0.74;
      context.fillStyle = color || '#f97316';
      context.strokeStyle = 'rgba(255,255,255,.88)';
      context.lineWidth = 2;
      context.beginPath();
      if (typeof context.roundRect === 'function') {
        context.roundRect(2, 2, 132, 48, 12);
      } else {
        context.rect(2, 2, 132, 48);
      }
      context.fill(); context.stroke();
      context.globalAlpha = 1;
      context.fillStyle = '#0f172a';
      context.font = '700 20px system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillText(rank, 68, 25);
      context.font = '600 11px system-ui, sans-serif';
      context.fillText(normalized, 68, 41);
      return canvas;
    }

    renderSites() {
      this.clearCollection(this.siteCollection);
      this.clearCollection(this.siteSectorCollection);
      const collection = new Cesium.PointPrimitiveCollection();
      const sectorLines = new Cesium.PolylineCollection();
      const sites = this.leafletRenderer?.siteIndex?.all || this.leafletRenderer?.siteData || [];
      sites.forEach((site) => {
        const lat = safeNumber(site?.lat ?? site?.latitude); const lng = safeNumber(site?.lng ?? site?.lon ?? site?.longitude);
        if (lat === null || lng === null) return;
        const tech = String(site?.tech || site?.technology || '').toUpperCase();
        const color = tech.includes('5') || tech.includes('NR') ? '#8b5cf6' : tech.includes('4') || tech.includes('LTE') ? '#ef4444' : tech.includes('3') || tech.includes('UMTS') ? '#f59e0b' : '#3b82f6';
        collection.add({ position: Cesium.Cartesian3.fromDegrees(lng, lat, 8), color: cssColor(color), pixelSize: 10,
          outlineColor: Cesium.Color.WHITE, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY,
          id: { kind: 'site', site } });

        // Lightweight outlines make each BDD sector legible without adding one
        // Cesium entity per sector.  They are presentation only, exactly like the
        // Leaflet sector wedge.
        const azimuth = safeNumber(site?.azimuth);
        if (azimuth !== null) {
          const beam = Math.max(10, Math.min(120, safeNumber(site?.beamwidth) ?? 35));
          const range = Math.max(40, Math.min(700, safeNumber(site?.range) ?? 180));
          const destination = (bearing) => {
            const radians = Math.PI / 180;
            const dLat = (Math.cos(bearing * radians) * range) / 111111;
            const dLng = (Math.sin(bearing * radians) * range) / (111111 * Math.cos(lat * radians));
            return Cesium.Cartesian3.fromDegrees(lng + dLng, lat + dLat, 7);
          };
          const origin = Cesium.Cartesian3.fromDegrees(lng, lat, 7);
          const left = destination(azimuth - beam / 2);
          const centre = destination(azimuth);
          const right = destination(azimuth + beam / 2);
          sectorLines.add({ positions: [origin, left, right, origin], width: 1.5, material: polylineMaterial(color, '#94a3b8', 0.72), id: { kind: 'site', site } });
          sectorLines.add({ positions: [origin, centre], width: 2, material: polylineMaterial(color, '#94a3b8', 0.8), id: { kind: 'site', site } });
        }
      });
      this.siteCollection = collection;
      this.siteSectorCollection = sectorLines;
      this.viewer.scene.primitives.add(collection);
      this.viewer.scene.primitives.add(sectorLines);
    }

    resolveTargetPosition(target) {
      const directLat = safeNumber(target?.tipLat ?? target?.lat);
      const directLng = safeNumber(target?.tipLng ?? target?.lng);
      if (directLat !== null && directLng !== null) return { lat: directLat, lng: directLng };
      const raw = String(target?.cellId || '').replace(/\s/g, '');
      if (!raw) return null;
      const index = this.leafletRenderer?.siteIndex?.byId;
      for (const key of [raw, raw.replace(/\//g, '-'), raw.replace(/-/g, '/')]) {
        const site = index?.get(key);
        const lat = safeNumber(site?.tipLat ?? site?.lat);
        const lng = safeNumber(site?.tipLng ?? site?.lng);
        if (lat !== null && lng !== null) return { lat, lng };
      }
      return null;
    }

    renderConnections() {
      this.clearCollection(this.connectionCollection);
      const collection = new Cesium.PolylineCollection();
      const start = this.leafletRenderer?._lastConnectionStartPt;
      const startLat = safeNumber(start?.lat); const startLng = safeNumber(start?.lng);
      if (startLat !== null && startLng !== null) {
        (this.leafletRenderer?._lastConnectionTargets || []).slice(0, 7).forEach((target) => {
          const end = this.resolveTargetPosition(target);
          if (!end) return;
          collection.add({
            positions: [Cesium.Cartesian3.fromDegrees(startLng, startLat, 10), Cesium.Cartesian3.fromDegrees(end.lng, end.lat, 10)],
            width: Math.max(2, Number(target?.weight) || 3), material: polylineMaterial(target?.color || '#22c55e', '#22c55e', 0.9),
          });
        });
      }
      this.connectionCollection = collection;
      this.viewer.scene.primitives.add(collection);
    }

    flyToLeafletBounds(bounds) {
      if (!bounds || !this.viewer) return;
      this.viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()), duration: 0 });
    }

    syncLeafletBounds() {
      if (!this.viewer || !this.leafletMap) return;
      const rectangle = this.viewer.camera.computeViewRectangle(this.viewer.scene.globe.ellipsoid);
      if (!rectangle) return;
      const west = Cesium.Math.toDegrees(rectangle.west); const south = Cesium.Math.toDegrees(rectangle.south);
      const east = Cesium.Math.toDegrees(rectangle.east); const north = Cesium.Math.toDegrees(rectangle.north);
      if ([west, south, east, north].every(Number.isFinite) && east > west && north > south) this.leafletMap.fitBounds([[south, west], [north, east]], { animate: false });
    }
  }

  window.CesiumMapAdapter = CesiumMapAdapter;
})();
