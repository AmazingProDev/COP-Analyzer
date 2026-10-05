/**
 * RF 3D viewer.
 *
 * The 3D view is a viewer only: values, winners, styles and band rasters
 * remain owned by the RF backend. The manifest is the contract shared by the
 * 2D and 3D views; no RF value is derived in WebGL.
 */
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const params = new URLSearchParams(location.search);
    const simId = params.get('id');
    let viewer = null;
    let baseLayer = null;
    let hdIdleResolutionScale = 1;
    let hdMovingResolutionScale = 1;
    let resolutionRestoreTimer = null;
    let rfLayer = null;
    let clickHandler = null;
    let currentManifest = null;
    let sectorEntities = [];
    let patternEntities = [];
    let traceEntityIds = [];
    let buildingEntities = [];
    let buildingPrimitives = [];
    let osmBuildingTileset = null;
    let buildingTileCache = new Map();
    let activeBuildingTileKeys = new Set();
    let buildingTileCacheVersion = 0;
    let buildingLabelEntities = [];
    let renderedBuildingFeatures = [];
    let buildingLabelOverrides = {};
    let selectedBuildingForLabel = null;
    let buildingLabelEditMode = false;
    let freeLabelEntities = [];
    let freeLabels = [];
    let selectedFreeLabelId = null;
    let freeLabelMode = false;
    // OpenStreetMap landmarks are a separate presentation layer. They are
    // deliberately never passed into the RF engine or the identify endpoint.
    let placeEntities = [];
    let placeItems = [];
    let placesLoadVersion = 0;
    let placesReloadTimer = null;
    let lastPlacesBoundsKey = '';
    let rtlBidiEngine = null;
    let subZoneEntity = null;
    let subZoneVertexEntities = [];
    let subZoneVertices = [];
    let subZoneGeometry = null;
    let subZoneName = 'Zone de réclamation';
    let subZoneMode = false;
    let siteViewRestore = null;
    let siteViewAnchor = null;
    let siteViewSiteKey = null;
    let siteViewTx = null;
    let siteSightEntity = null;
    let hudDragState = null;
    let rfSurfacePrimitive = null;
    let surfaceLoadVersion = 0;
    let buildingsLoadVersion = 0;
    let buildingsReloadTimer = null;
    // The first visible set is intentionally bounded. Camera movements reload
    // the visible footprint, while source volumes are batched by spatial tile.
    const BUILDING_TILE_RENDER_BATCH = 2;
    const BUILDING_TILE_LON_DEG = 0.004;
    const BUILDING_TILE_LAT_DEG = 0.003;
    const BUILDING_TILE_FEATURE_LIMIT = 400;
    const BUILDING_TILE_CACHE_LIMIT = 48;
    let pivotEntity = null;
    let pivotCartesian = null;
    let pivotMode = false;
    let localTerrainAttached = false;
    let sceneDiagnostics = null;
    let terrainTileState = null;
    let presentationMode = false;
    let savedPresentationViews = [];
    let presentationTourTimer = null;
    let presentationTourToken = 0;
    let presentationTourActive = false;
    // Satellite imagery remains sharp on a Retina screen without forcing the
    // same GPU cost while the camera is moving.  Cesium reloads native tiles
    // for the new camera footprint; no stretched AOI JPEG is used here.
    const HD_IDLE_RESOLUTION_MAX = 2;
    const HD_MOVING_RESOLUTION_MAX = 1.25;
    const HD_RESTORE_DELAY_MS = 180;

    function bootError(detail) {
        $('boot-error').hidden = false;
        $('boot-error-detail').textContent = detail;
        $('hud-top').style.display = 'none';
    }

    async function fetchCesiumConfig() {
        const response = await fetch('/api/cesium/config', { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`configuration Cesium (${response.status})`);
        const payload = await response.json();
        if (!payload.enabled || !payload.accessToken) throw new Error('token ion indisponible');
        Cesium.Ion.defaultAccessToken = payload.accessToken;
        return payload;
    }

    async function enableOsmBuildings() {
        if (!viewer) return false;
        try {
            await fetchCesiumConfig();
            if (!osmBuildingTileset) {
                osmBuildingTileset = await Cesium.createOsmBuildingsAsync({
                    // 96188 contains OSM geometry, not photorealistic facade
                    // textures. A light, deliberately neutral presentation lets
                    // the satellite layer, RF overlay and technical antennas stay
                    // readable while preserving the richer OSM footprints.
                    // `height` is optional in OSM.  A conditional style on
                    // that attribute aborts the whole Cesium render as soon
                    // as a valid footprint has no recorded height.
                    style: new Cesium.Cesium3DTileStyle({
                        color: "color('#b8c4d4', 0.88)",
                    }),
                });
                // Presentation quality close to the camera, with adaptive LOD
                // farther away so a dense city stays fluid.
                osmBuildingTileset.maximumScreenSpaceError = 6;
                osmBuildingTileset.dynamicScreenSpaceError = true;
                osmBuildingTileset.dynamicScreenSpaceErrorDensity = 0.002;
                osmBuildingTileset.dynamicScreenSpaceErrorFactor = 4;
                osmBuildingTileset.foveatedScreenSpaceError = true;
                osmBuildingTileset.skipLevelOfDetail = false;
                osmBuildingTileset.preloadFlightDestinations = true;
                osmBuildingTileset.cullRequestsWhileMoving = true;
                viewer.scene.primitives.add(osmBuildingTileset);
            }
            osmBuildingTileset.shadows = $('hud-building-shadows')?.checked === false
                ? Cesium.ShadowMode.DISABLED : Cesium.ShadowMode.ENABLED;
            osmBuildingTileset.show = true;
            $('hud-building-status').textContent = 'Bâtiments : Cesium OSM global (asset 96188) — présentation uniquement';
            viewer.scene.requestRender();
            return true;
        } catch (error) {
            $('hud-building-status').textContent = `Bâtiments OSM indisponibles : ${error.message || error}`;
            return false;
        }
    }

    function disableOsmBuildings() {
        if (osmBuildingTileset) osmBuildingTileset.show = false;
    }

    async function setBuildingSource() {
        const source = $('hud-building-source')?.value || 'osm';
        if (source === 'local') {
            disableOsmBuildings();
            configureBuildingControl(true);
            if ($('hud-buildings')?.checked) await loadBuildings(subZoneGeoJson() || subZoneGeometry);
            return;
        }
        if ($('hud-buildings')) {
            $('hud-buildings').checked = false;
            // Keep the two building sources mutually exclusive.  GeoData can
            // still be restored by selecting its explicit technical source.
            $('hud-buildings').disabled = true;
        }
        clearDisplayedBuildings('Bâtiments locaux masqués — source OSM sélectionnée');
        const available = await enableOsmBuildings();
        if (!available && $('hud-building-source')) {
            $('hud-building-source').value = 'local';
            configureBuildingControl(true);
            if ($('hud-buildings')?.checked) await loadBuildings(subZoneGeoJson() || subZoneGeometry);
        }
    }

    function cssColor(value, alpha) {
        const color = Cesium.Color.fromCssColorString(value || '#38bdf8');
        return Number.isFinite(alpha) ? color.withAlpha(alpha) : color;
    }

    const BUILDING_PRESENTATION_PALETTE = [
        { facade: '#d6d3cd', roof: '#a8a29e' },
        { facade: '#d9d2c3', roof: '#aaa093' },
        { facade: '#cbd5d9', roof: '#89959c' },
        { facade: '#d7d9d5', roof: '#9aa39e' },
    ];

    function buildingHash(value) {
        return [...String(value || '')].reduce((hash, char) => ((hash * 31) + char.charCodeAt(0)) >>> 0, 0);
    }

    function buildingAppearance(feature) {
        const technical = $('hud-building-style')?.value === 'technical';
        if (technical) {
            return {
                facade: '#64748b', roof: '#64748b', facadeAlpha: 0.96,
                outline: true, outlineColor: '#cbd5e1', shadows: Cesium.ShadowMode.DISABLED,
            };
        }
        const palette = BUILDING_PRESENTATION_PALETTE[buildingHash(feature?.id) % BUILDING_PRESENTATION_PALETTE.length];
        return {
            facade: palette.facade, roof: palette.roof, facadeAlpha: 1,
            outline: false, outlineColor: '#0f172a',
            shadows: $('hud-building-shadows')?.checked === false
                ? Cesium.ShadowMode.DISABLED : Cesium.ShadowMode.ENABLED,
        };
    }

    function updateBasemapStatus(text) {
        const node = $('hud-basemap-status');
        if (node) node.textContent = text;
    }

    function setViewerResolutionScale(scale) {
        if (!viewer || viewer.isDestroyed()) return;
        const target = Math.min(HD_IDLE_RESOLUTION_MAX, Math.max(1, Number(scale) || 1));
        if (Math.abs(viewer.resolutionScale - target) < 0.01) return;
        viewer.resolutionScale = target;
        viewer.resize();
        viewer.scene.requestRender();
    }

    function configureAdaptiveHdRendering() {
        const deviceScale = Math.max(1, Number(window.devicePixelRatio) || 1);
        hdIdleResolutionScale = Math.min(HD_IDLE_RESOLUTION_MAX, deviceScale);
        hdMovingResolutionScale = Math.min(hdIdleResolutionScale, Math.min(HD_MOVING_RESOLUTION_MAX, deviceScale));
        setViewerResolutionScale(hdIdleResolutionScale);
    }

    function beginAdaptiveCameraRendering() {
        clearTimeout(resolutionRestoreTimer);
        resolutionRestoreTimer = null;
        setViewerResolutionScale(hdMovingResolutionScale);
    }

    function restoreAdaptiveHdRendering() {
        clearTimeout(resolutionRestoreTimer);
        resolutionRestoreTimer = window.setTimeout(() => {
            resolutionRestoreTimer = null;
            setViewerResolutionScale(hdIdleResolutionScale);
        }, HD_RESTORE_DELAY_MS);
    }

    async function setBaseMap(kind, force = false) {
        if (!viewer) return null;
        const requested = kind === 'osm' ? 'osm' : 'sat';
        if (!force && baseLayer && viewer.imageryLayers.contains(baseLayer) && baseLayer._rf3dBaseKind === requested) {
            baseLayer.show = true;
            baseLayer.alpha = 1;
            return baseLayer;
        }
        if (baseLayer && viewer.imageryLayers.contains(baseLayer)) {
            try { viewer.imageryLayers.remove(baseLayer, true); } catch (_) {}
        }
        // Native Esri tiles are the only interactive satellite background.
        // They stream with the camera through z19, so a close oblique view is
        // not limited by the old 2048 px AOI JPEG export.
        const provider = window.rf3dLayers.baseProvider(
            requested, requested === 'sat' ? window.rf3dApi.esriBaseTileUrl() : null);
        const imageryOptions = requested === 'sat'
            ? {
                maximumAnisotropy: 16,
                // The bundled Cesium build produces black imagery when it
                // generates mipmaps for remote JPEG tiles. Linear sampling
                // keeps native z19 tiles visible; the 16× anisotropy still
                // improves close oblique views on supported GPUs.
                minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
                magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
            }
            : { maximumAnisotropy: 1 };
        baseLayer = new Cesium.ImageryLayer(provider, imageryOptions);
        viewer.imageryLayers.add(baseLayer, 0);
        baseLayer._rf3dBaseKind = requested;
        baseLayer.show = true;
        baseLayer.alpha = 1;
        // Surface a recoverable base-map problem instead of leaving a blank
        // globe which users could mistake for a hidden RF simulation.
        provider.errorEvent?.addEventListener(() => {
            if (baseLayer?.imageryProvider !== provider) return;
            updateBasemapStatus(requested === 'sat'
                ? 'Fond Satellite Esri indisponible — réessayez ou choisissez Plan OSM'
                : 'Fond Plan OSM indisponible — réessayez ou choisissez Satellite Esri');
        });
        updateBasemapStatus(requested === 'osm' ? 'Fond Plan OSM' : 'Satellite Esri tuilé HD · z0–z19');
        viewer.scene.requestRender();
        return baseLayer;
    }

    function transmitterPosition(tx, height) {
        return Cesium.Cartesian3.fromDegrees(Number(tx.lon), Number(tx.lat), Number(height || 0));
    }

    function groundHeight(lon, lat) {
        if (!viewer || !Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat))) return 0;
        const height = viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(Number(lon), Number(lat)));
        return Number.isFinite(height) ? height : 0;
    }

    function transmitterGroundHeight(tx) {
        const fromManifest = Number(tx?.groundElevationM);
        return Number.isFinite(fromManifest) ? fromManifest : groundHeight(tx?.lon, tx?.lat);
    }

    function manifestBounds() {
        const raw = currentManifest?.boundsWgs84;
        const bounds = Array.isArray(raw)
            ? { west: Number(raw[0]), south: Number(raw[1]), east: Number(raw[2]), north: Number(raw[3]) }
            : raw;
        return bounds && [bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)
            && bounds.west < bounds.east && bounds.south < bounds.north ? bounds : null;
    }

    function attachLocalTerrain() {
        const bounds = manifestBounds();
        if (!viewer || !bounds || !window.rf3dApi?.terrain) return false;
        // Use Esri's global Web Mercator tile grid, not an AOI-only grid.
        // Cesium can then bind each native Esri texture to the terrain tile
        // with identical z/x/y coordinates.  The height values themselves
        // still come solely from the local RF DTM below.
        const tilingScheme = new Cesium.WebMercatorTilingScheme();
        // Keep the one canonical DTM read from the RF backend, then subdivide
        // that grid locally.  Returning only level zero prevented Cesium's
        // globe from refining, which in turn kept Esri imagery at world zoom
        // despite a close camera.  This is display interpolation of the same
        // DTM source, never a new elevation or RF calculation.
        const sourceSampleSize = 129;
        const tileSampleSize = 33;
        const maximumTerrainLevel = 19;
        const tileCache = new Map();
        let sourceHeightsPromise = null;

        function sourceHeights() {
            if (!sourceHeightsPromise) {
                sourceHeightsPromise = window.rf3dApi.terrain(currentManifest.id, bounds, sourceSampleSize)
                    .then(data => {
                        terrainTileState = data || null;
                        updateSceneDiagnosticStatus();
                        if (!data?.available || !Array.isArray(data.heights)
                            || data.heights.length !== sourceSampleSize * sourceSampleSize) return null;
                        return new Float32Array(data.heights);
                    })
                    .catch(() => null);
            }
            return sourceHeightsPromise;
        }

        function sampleSourceHeight(heights, sourceX, sourceY) {
            const last = sourceSampleSize - 1;
            const x = Math.min(last, Math.max(0, sourceX));
            const y = Math.min(last, Math.max(0, sourceY));
            const x0 = Math.floor(x);
            const y0 = Math.floor(y);
            const x1 = Math.min(last, x0 + 1);
            const y1 = Math.min(last, y0 + 1);
            const xRatio = x - x0;
            const yRatio = y - y0;
            const top = heights[y0 * sourceSampleSize + x0] * (1 - xRatio)
                + heights[y0 * sourceSampleSize + x1] * xRatio;
            const bottom = heights[y1 * sourceSampleSize + x0] * (1 - xRatio)
                + heights[y1 * sourceSampleSize + x1] * xRatio;
            return top * (1 - yRatio) + bottom * yRatio;
        }

        function refinedHeightmap(x, y, level) {
            if (level > maximumTerrainLevel) return undefined;
            const key = `${level}:${x}:${y}`;
            if (tileCache.has(key)) return tileCache.get(key);
            const promise = sourceHeights().then(heights => {
                if (!heights) return undefined;
                const tile = tilingScheme.tileXYToRectangle(x, y, level);
                const values = new Float32Array(tileSampleSize * tileSampleSize);
                const width = Math.max(Number.EPSILON, bounds.east - bounds.west);
                const height = Math.max(Number.EPSILON, bounds.north - bounds.south);
                for (let row = 0; row < tileSampleSize; row += 1) {
                    const fractionY = row / (tileSampleSize - 1);
                    const latitude = Cesium.Math.toDegrees(tile.north - (tile.north - tile.south) * fractionY);
                    const sourceY = ((bounds.north - latitude) / height) * (sourceSampleSize - 1);
                    for (let column = 0; column < tileSampleSize; column += 1) {
                        const fractionX = column / (tileSampleSize - 1);
                        const longitude = Cesium.Math.toDegrees(tile.west + (tile.east - tile.west) * fractionX);
                        const sourceX = ((longitude - bounds.west) / width) * (sourceSampleSize - 1);
                        values[row * tileSampleSize + column] = sampleSourceHeight(heights, sourceX, sourceY);
                    }
                }
                return values;
            });
            tileCache.set(key, promise);
            // Bound the presentation cache while retaining the most recently
            // requested terrain tiles during close camera movements.
            if (tileCache.size > 512) tileCache.delete(tileCache.keys().next().value);
            return promise;
        }

        const terrain = new Cesium.CustomHeightmapTerrainProvider({
            tilingScheme,
            width: tileSampleSize,
            height: tileSampleSize,
            credit: 'DTM local — GeoData RF',
            callback: refinedHeightmap,
        });
        viewer.terrainProvider = terrain;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
        viewer.scene.screenSpaceCameraController.minimumZoomDistance = 8;
        localTerrainAttached = true;
        return true;
    }

    function keepCameraAboveTerrain() {
        if (!viewer || !localTerrainAttached) return;
        const camera = viewer.camera;
        const cartographic = camera.positionCartographic;
        const terrainHeight = viewer.scene.globe.getHeight(cartographic);
        if (!Number.isFinite(terrainHeight) || cartographic.height >= terrainHeight + 8) return;
        const destination = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, terrainHeight + 8);
        camera.setView({
            destination,
            orientation: {
                heading: camera.heading,
                pitch: Math.min(camera.pitch, Cesium.Math.toRadians(-3)),
                roll: 0,
            },
        });
    }

    function updateSceneDiagnosticStatus() {
        const target = $('hud-scene-status');
        if (!target) return;
        if (!sceneDiagnostics) {
            target.textContent = 'Scène : audit DTM/RF en attente…';
            return;
        }
        const rf = sceneDiagnostics.rf || {};
        const terrain = sceneDiagnostics.terrain || {};
        const buildingText = sceneDiagnostics.buildings?.available ? 'bâtiments source prêts' : 'sans bâtiments source';
        const terrainText = terrain.state === 'ready'
            ? `DTM ${terrain.coveragePercent}%`
            : terrain.state === 'partial'
                ? `DTM partiel ${terrain.coveragePercent}% — overlay conseillé`
                : 'DTM indisponible — overlay conseillé';
        const tileNote = terrainTileState?.partial ? ' · tuile terrain partielle' : '';
        const zoneText = Number(rf.coveragePercent) < 99.99
            ? `zone simulée ${rf.coveragePercent}% du rectangle technique`
            : 'zone simulée : rectangle technique complet';
        target.textContent = `Scène : ${zoneText} · NoData transparents · ${terrainText} · ${buildingText}${tileNote}`;
    }

    async function loadSceneDiagnostics() {
        updateSceneDiagnosticStatus();
        try {
            sceneDiagnostics = await window.rf3dApi.sceneDiagnostics(currentManifest.id);
        } catch (error) {
            sceneDiagnostics = null;
            const target = $('hud-scene-status');
            if (target) target.textContent = `Scène : audit indisponible — ${error.message}`;
            return;
        }
        updateSceneDiagnosticStatus();
    }

    // This is deliberately a technical symbol, not a CAD model of the installed
    // equipment. Direction and height come from the RF inventory; panel shape is
    // only there to make the site readable in 3D. A measured MSI remains an
    // optional outline, never a generic beam made to look measured.
    const BAND_PANEL_COLORS = {
        L800: '#06b6d4', L1800: '#2563eb', L2100: '#f59e0b', L2600: '#ef4444',
        N1: '#8b5cf6', N28: '#a855f7', N78: '#d946ef',
    };

    function panelColor(tx) {
        const band = String(tx.band || '').trim().toUpperCase();
        return BAND_PANEL_COLORS[band]
            || tx.color
            || window.rf3dLayers.OPERATOR_COLORS[String(tx.operator || '').toUpperCase()]
            || '#38bdf8';
    }

    function offsetPosition(lon, lat, azimuthDeg, offsetM, height) {
        // Keep co-located panels visually separate on a mast. Offset is across
        // the panel face (90 degrees to its pointing azimuth), not a change in
        // the sector's radio position or propagation calculation.
        const bearing = Cesium.Math.toRadians(Number(azimuthDeg || 0) + 90);
        const dLat = offsetM * Math.cos(bearing) / 111320;
        const dLon = offsetM * Math.sin(bearing) /
            (111320 * Math.max(0.2, Math.cos(Cesium.Math.toRadians(lat))));
        return Cesium.Cartesian3.fromDegrees(Number(lon) + dLon, Number(lat) + dLat, Number(height));
    }

    function sectorPanel(tx, baseHeight, slot) {
        const azimuth = Number(tx.azimuthDeg ?? 0);
        const agl = Math.max(3, Number(tx.antennaHeightAglM ?? 25));
        const column = (slot % 3) - 1;
        const tier = Math.floor(slot / 3);
        const position = offsetPosition(tx.lon, tx.lat, azimuth, column * 0.75, baseHeight + agl + tier * 0.22);
        const color = cssColor(panelColor(tx), 0.96);
        const isNr = String(tx.technology || '').toUpperCase() === 'NR' || /^N\d+/i.test(String(tx.band || ''));
        const panelHeight = isNr ? 1.55 : 2.05;
        const orientation = Cesium.Transforms.headingPitchRollQuaternion(
            position, new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(azimuth + 90), 0, 0));
        return viewer.entities.add({
            position,
            orientation,
            box: {
                // Vertical rectangular panel. Its symbolic dimensions are not
                // antenna manufacturer dimensions and are stated as such below.
                dimensions: new Cesium.Cartesian3(isNr ? 0.48 : 0.6, 0.16, panelHeight),
                material: color,
                outline: true,
                outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
                shadows: Cesium.ShadowMode.DISABLED,
            },
            properties: {
                type: 'Panneau d’antenne symbolique',
                cell: tx.cell || '—', site: tx.site || '—', band: tx.band || '—',
                technology: tx.technology || '—', azimuthDeg: azimuth,
                antennaHeightAglM: agl,
                presentation: 'Panneau 3D orienté BDD — dimensions symboliques, non CAD',
                patternPresentation: tx.patternPresentation === 'measured-msi'
                    ? 'MSI mesuré disponible (affichage via indicateur optionnel)'
                    : 'Aucun MSI mesuré — panneau symbolique uniquement',
            },
        });
    }

    function groupedTransmitters() {
        const groups = new Map();
        (currentManifest?.transmitters || []).forEach(tx => {
            if (tx.active === false || !Number.isFinite(Number(tx.lat)) || !Number.isFinite(Number(tx.lon))) return;
            const key = `${tx.site || 'Site'}|${Number(tx.lat).toFixed(6)}|${Number(tx.lon).toFixed(6)}`;
            const group = groups.get(key) || { key, site: tx.site || 'Site', lat: Number(tx.lat), lon: Number(tx.lon), txs: [] };
            group.txs.push(tx);
            groups.set(key, group);
        });
        return [...groups.values()];
    }

    function populateSites() {
        const select = $('hud-site');
        if (!select) return;
        const previous = select.value;
        select.innerHTML = '<option value="">Choisir…</option>';
        groupedTransmitters().sort((a, b) => a.site.localeCompare(b.site, 'fr')).forEach((group, index) => {
            const tx = group.txs[0];
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = `${group.site} · ${tx.band || tx.technology || 'secteur'}`;
            select.appendChild(option);
        });
        select.value = [...select.options].some(option => option.value === previous) ? previous : '';
        $('hud-site-view').disabled = !select.value;
    }

    function cameraAtSelectedSite() {
        const index = Number($('hud-site').value);
        const group = groupedTransmitters().sort((a, b) => a.site.localeCompare(b.site, 'fr'))[index];
        const tx = group?.txs?.[0];
        if (!viewer || !tx) return;
        // Preserve the user’s original inspection camera, even if they switch
        // between several sites before choosing “Retour vue”.
        if (!siteViewRestore) {
            siteViewRestore = {
                position: Cesium.Cartesian3.clone(viewer.camera.positionWC),
                direction: Cesium.Cartesian3.clone(viewer.camera.directionWC),
                up: Cesium.Cartesian3.clone(viewer.camera.upWC),
            };
        }
        const ground = transmitterGroundHeight(tx);
        const antennaAgl = Math.max(3, Number(tx.antennaHeightAglM || 25));
        // This is an on-site point of view, not an orbit inferred from the
        // RF raster.  Arrow keys below only change heading/pitch; the camera
        // always stays on this physical antenna anchor.
        siteViewAnchor = Cesium.Cartesian3.fromDegrees(Number(tx.lon), Number(tx.lat), ground + antennaAgl + 0.8);
        siteViewSiteKey = group.key;
        siteViewTx = tx;
        // The camera sits at the physical antenna. Hide only this site's
        // symbolic mast/panels so a presentation object never blocks the
        // real site-level view; all other sites remain visible.
        applySectorVisibility();
        viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        viewer.camera.flyTo({
            destination: siteViewAnchor,
            orientation: {
                heading: Cesium.Math.toRadians(Number(tx.azimuthDeg || 0)),
                pitch: Cesium.Math.toRadians(-4), roll: 0,
            },
            duration: 0.9,
            complete: () => {
                updateSiteViewStatus();
                updateSiteSightLine();
            },
        });
        $('hud-site-return').hidden = false;
        $('hud-site-status').hidden = false;
        $('site-camera-readout').hidden = false;
        $('site-camera-name').textContent = tx.site || tx.cell || 'Site sélectionné';
        $('hud-site-view').textContent = 'Vue active';
        updateSiteViewStatus(Cesium.Math.toRadians(Number(tx.azimuthDeg || 0)), Cesium.Math.toRadians(-4));
    }

    function clearSiteSightLine() {
        if (siteSightEntity) {
            try { viewer?.entities.remove(siteSightEntity); } catch (_) {}
        }
        siteSightEntity = null;
    }

    // The line is a presentation aid: it follows the exact camera ray and
    // ends where that ray reaches the terrain. It never changes any RF value,
    // antenna azimuth or BDD configuration.
    function updateSiteSightLine() {
        if (!viewer || !siteViewAnchor) return clearSiteSightLine();
        const origin = Cesium.Cartesian3.clone(viewer.camera.positionWC);
        const direction = Cesium.Cartesian3.clone(viewer.camera.directionWC);
        const ray = new Cesium.Ray(origin, direction);
        let impact = null;
        try { impact = viewer.scene.globe.pick(ray, viewer.scene); } catch (_) {}
        if (!impact) {
            // A fall-back ellipsoid intersection keeps the helper useful while
            // a terrain tile is still streaming. It is hidden when looking at
            // the sky, where no forward ground intersection exists.
            const interval = Cesium.IntersectionTests.rayEllipsoid(ray, viewer.scene.globe.ellipsoid);
            if (interval) impact = Cesium.Ray.getPoint(ray, Math.max(0, interval.start));
        }
        if (!impact) {
            if (siteSightEntity) siteSightEntity.show = false;
            return;
        }
        const distance = Cesium.Cartesian3.distance(origin, impact);
        if (!Number.isFinite(distance) || distance < 1) return;
        if (!siteSightEntity) {
            siteSightEntity = viewer.entities.add({
                polyline: {
                    positions: [origin, impact], width: 3,
                    material: new Cesium.PolylineArrowMaterialProperty(cssColor('#38bdf8', 0.96)),
                    clampToGround: false,
                },
                position: impact,
                point: { pixelSize: 9, color: cssColor('#f59e0b'), outlineColor: Cesium.Color.WHITE, outlineWidth: 2,
                    disableDepthTestDistance: 5000 },
                label: {
                    text: '', font: '800 11px system-ui', fillColor: cssColor('#e0f2fe'),
                    outlineColor: cssColor('#071323', 0.98), outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    showBackground: true, backgroundColor: cssColor('#071323', 0.85),
                    backgroundPadding: new Cesium.Cartesian2(6, 3), pixelOffset: new Cesium.Cartesian2(0, -15),
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM, disableDepthTestDistance: 5000,
                },
                properties: { type: 'Visée caméra', source: 'Caméra → sol' },
            });
        }
        siteSightEntity.show = true;
        siteSightEntity.polyline.positions = [origin, impact];
        siteSightEntity.position = impact;
        siteSightEntity.label.text = `Impact visée · ${Math.round(distance).toLocaleString('fr-FR')} m`;
        viewer.scene.requestRender();
    }

    function returnFromSiteView() {
        if (!viewer || !siteViewRestore) return;
        viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        viewer.camera.setView({
            destination: siteViewRestore.position,
            orientation: { direction: siteViewRestore.direction, up: siteViewRestore.up },
        });
        siteViewRestore = null;
        siteViewAnchor = null;
        siteViewSiteKey = null;
        siteViewTx = null;
        clearSiteSightLine();
        if ($('hud-base')?.value === 'sat') updateBasemapStatus('Satellite Esri tuilé HD · z0–z19');
        applySectorVisibility();
        $('hud-site-return').hidden = true;
        $('hud-site-status').hidden = true;
        $('site-camera-readout').hidden = true;
        $('hud-site-view').textContent = 'Vue antenne';
    }

    function updateSiteViewStatus(heading = viewer?.camera.heading, pitch = viewer?.camera.pitch) {
        if (!siteViewTx || !Number.isFinite(heading) || !Number.isFinite(pitch)) return;
        const azimuth = Math.round(Cesium.Math.zeroToTwoPi(heading) * 180 / Math.PI);
        const viewTilt = Math.round((pitch * 180 / Math.PI) * 10) / 10;
        const bddTilt = Number(siteViewTx.totalTiltDeg ?? siteViewTx.electricalTiltDeg ?? siteViewTx.mechanicalTiltDeg);
        const bddText = Number.isFinite(bddTilt) ? ` · tilt antenne BDD ${bddTilt.toFixed(1)}°` : '';
        $('hud-site-status').textContent = `Visée : azimut ${azimuth}° · tilt ${viewTilt.toFixed(1)}°${bddText} · ← → ↑ ↓ : pas 1°`;
        if (document.activeElement !== $('site-camera-azimuth')) $('site-camera-azimuth').value = String(azimuth);
        if (document.activeElement !== $('site-camera-tilt')) $('site-camera-tilt').value = String(viewTilt);
    }

    function applySiteCameraOrientation(heading, pitch) {
        if (!viewer || !siteViewAnchor) return;
        const safeHeading = Cesium.Math.zeroToTwoPi(heading);
        const safePitch = Cesium.Math.clamp(pitch, Cesium.Math.toRadians(-85), Cesium.Math.toRadians(85));
        viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        viewer.camera.setView({ destination: siteViewAnchor, orientation: { heading: safeHeading, pitch: safePitch, roll: 0 } });
        updateSiteViewStatus(safeHeading, safePitch);
        updateSiteSightLine();
        viewer.scene.requestRender();
    }

    function applyManualSiteView() {
        if (!siteViewAnchor) return;
        const azimuth = Number($('site-camera-azimuth').value);
        const tilt = Number($('site-camera-tilt').value);
        if (!Number.isFinite(azimuth) || !Number.isFinite(tilt)) return;
        applySiteCameraOrientation(Cesium.Math.toRadians(azimuth), Cesium.Math.toRadians(tilt));
    }

    function onKeyDown(event) {
        if (event.key === 'Escape' && presentationMode) {
            event.preventDefault();
            setPresentationMode(false);
            return;
        }
        if (!viewer || !siteViewAnchor || event.altKey || event.ctrlKey || event.metaKey) return;
        const target = event.target;
        if (target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/i.test(target.tagName)) return;
        const increments = {
            ArrowLeft: { heading: -1, pitch: 0 }, ArrowRight: { heading: 1, pitch: 0 },
            ArrowUp: { heading: 0, pitch: 1 }, ArrowDown: { heading: 0, pitch: -1 },
        };
        const increment = increments[event.key];
        if (!increment) return;
        event.preventDefault();
        const heading = Cesium.Math.zeroToTwoPi(viewer.camera.heading + Cesium.Math.toRadians(increment.heading));
        const pitch = viewer.camera.pitch + Cesium.Math.toRadians(increment.pitch);
        // Reassert the antenna anchor on every key press so arrow controls
        // cannot drift after a mouse gesture or terrain update.
        applySiteCameraOrientation(heading, pitch);
    }

    function presentationStorageKey() {
        return simId ? 'optim-analyzer:rf-3d-presentation-views:' + simId : null;
    }

    function cameraSnapshot() {
        if (!viewer) return null;
        const cartographic = viewer.camera.positionCartographic;
        if (!cartographic || !Number.isFinite(cartographic.longitude) || !Number.isFinite(cartographic.latitude)) return null;
        return {
            lon: Cesium.Math.toDegrees(cartographic.longitude), lat: Cesium.Math.toDegrees(cartographic.latitude),
            height: Math.max(1, Number(cartographic.height)), heading: Number(viewer.camera.heading),
            pitch: Number(viewer.camera.pitch), roll: Number(viewer.camera.roll),
        };
    }

    function updateSavedPresentationViews() {
        const select = $('hud-saved-views');
        if (!select) return;
        const previous = select.value;
        select.innerHTML = '<option value="">Vues enregistrées…</option>';
        savedPresentationViews.forEach(view => {
            const option = document.createElement('option');
            option.value = view.id;
            option.textContent = view.name;
            select.appendChild(option);
        });
        select.value = savedPresentationViews.some(view => view.id === previous) ? previous : '';
    }

    function restorePresentationViews() {
        try {
            const saved = JSON.parse(localStorage.getItem(presentationStorageKey()) || '[]');
            savedPresentationViews = Array.isArray(saved) ? saved.filter(view => view && view.id && view.camera
                && [view.camera.lon, view.camera.lat, view.camera.height, view.camera.heading, view.camera.pitch]
                    .every(Number.isFinite)).slice(-20) : [];
        } catch (_) {
            savedPresentationViews = [];
        }
        updateSavedPresentationViews();
    }

    function savePresentationViews() {
        try { localStorage.setItem(presentationStorageKey(), JSON.stringify(savedPresentationViews)); } catch (_) {}
    }

    function savePresentationView() {
        const camera = cameraSnapshot();
        if (!camera) return;
        const input = $('hud-presentation-name');
        const proposed = String(input.value || '').trim().slice(0, 60);
        const name = proposed || ('Vue ' + (savedPresentationViews.length + 1));
        const id = 'view-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        savedPresentationViews.push({ id, name, camera, createdAt: new Date().toISOString() });
        savedPresentationViews = savedPresentationViews.slice(-20);
        savePresentationViews();
        updateSavedPresentationViews();
        $('hud-saved-views').value = id;
        input.value = '';
        $('hud-presentation-status').textContent = 'Présentation : vue « ' + name + ' » enregistrée.';
    }

    function loadPresentationView() {
        const id = $('hud-saved-views').value;
        const selected = savedPresentationViews.find(view => view.id === id);
        if (!viewer || !selected) {
            $('hud-presentation-status').textContent = 'Présentation : choisissez une vue enregistrée.';
            return;
        }
        stopPresentationTour(false);
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(selected.camera.lon, selected.camera.lat, selected.camera.height),
            orientation: { heading: selected.camera.heading, pitch: selected.camera.pitch, roll: selected.camera.roll || 0 },
            duration: 1.1,
        });
        $('hud-presentation-status').textContent = 'Présentation : ouverture de « ' + selected.name + ' ».';
    }

    function setPresentationMode(enabled) {
        presentationMode = Boolean(enabled);
        document.body.classList.toggle('presentation-mode', presentationMode);
        $('presentation-exit').hidden = !presentationMode;
        $('presentation-caption').hidden = !presentationMode;
        $('hud-presentation').textContent = presentationMode ? '◀ Quitter présentation' : '▶ Mode présentation';
        $('hud-presentation-status').textContent = presentationMode
            ? 'Présentation : panneaux masqués — échap. pour quitter.'
            : 'Présentation : prête';
        viewer?.resize();
        viewer?.scene.requestRender();
    }

    function updatePresentationCaption() {
        const caption = $('presentation-caption');
        if (!caption || !currentManifest) return;
        const transmitters = currentManifest.transmitters || [];
        const operators = [...new Set(transmitters.map(tx => String(tx.operator || '').trim()).filter(Boolean))].join(' · ') || 'Opérateur non renseigné';
        const bands = [...new Set(transmitters.map(tx => String(tx.band || '').trim()).filter(Boolean))].sort().join(', ') || 'Bandes non renseignées';
        const dataQuality = currentManifest.qualityContext?.label || currentManifest.quality || 'Qualité non renseignée';
        const geoData = currentManifest.dataset?.name || 'GeoData non renseigné';
        caption.replaceChildren();
        const title = document.createElement('b');
        title.textContent = currentManifest.name || 'RF Coverage';
        const details = document.createElement('span');
        details.textContent = operators + ' · ' + bands + ' · ' + geoData + ' · ' + dataQuality;
        caption.append(title, details);
    }

    async function toggleFullscreen() {
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await document.documentElement.requestFullscreen();
        } catch (error) {
            $('hud-presentation-status').textContent = 'Présentation : plein écran indisponible — ' + error.message;
        }
    }

    function exportPresentationPng() {
        if (!viewer) return;
        const status = $('hud-presentation-status');
        status.textContent = 'Présentation : préparation du PNG…';
        const originalScale = viewer.resolutionScale;
        viewer.resolutionScale = Math.min(2, Math.max(originalScale, window.devicePixelRatio || 1));
        viewer.resize();
        viewer.scene.requestRender();
        requestAnimationFrame(() => {
            try {
                viewer.render();
                viewer.canvas.toBlob(blob => {
                    viewer.resolutionScale = originalScale;
                    viewer.resize();
                    if (!blob) {
                        status.textContent = 'Présentation : export PNG indisponible avec le fond courant.';
                        return;
                    }
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(blob);
                    link.download = 'optim-analyzer-rf-3d-' + (currentManifest?.id || 'scene') + '.png';
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
                    status.textContent = 'Présentation : PNG exporté.';
                }, 'image/png');
            } catch (error) {
                viewer.resolutionScale = originalScale;
                viewer.resize();
                status.textContent = 'Présentation : export PNG impossible — ' + error.message;
            }
        });
    }

    function stopPresentationTour(announce = true) {
        presentationTourToken += 1;
        presentationTourActive = false;
        if (presentationTourTimer) window.clearTimeout(presentationTourTimer);
        presentationTourTimer = null;
        viewer?.camera.cancelFlight();
        const button = $('hud-tour');
        if (button) button.textContent = '🧭 Tour sites';
        if (announce && $('hud-presentation-status')) $('hud-presentation-status').textContent = 'Présentation : tour arrêté.';
    }

    function startPresentationTour() {
        if (!viewer) return;
        if (presentationTourActive) return stopPresentationTour();
        if (siteViewAnchor) returnFromSiteView();
        const sites = groupedTransmitters().sort((left, right) => left.site.localeCompare(right.site, 'fr')).slice(0, 8);
        if (!sites.length) {
            $('hud-presentation-status').textContent = 'Présentation : aucun site disponible pour le tour.';
            return;
        }
        const token = ++presentationTourToken;
        presentationTourActive = true;
        let index = 0;
        $('hud-tour').textContent = '■ Arrêter le tour';
        const visit = () => {
            if (token !== presentationTourToken) return;
            const group = sites[index % sites.length];
            const tx = group.txs[0];
            const ground = transmitterGroundHeight(tx);
            $('hud-presentation-status').textContent = 'Présentation : site ' + (index + 1) + '/' + sites.length + ' — ' + group.site;
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(group.lon, group.lat, ground + 340),
                orientation: { heading: Cesium.Math.toRadians(Number(tx.azimuthDeg || 0)), pitch: Cesium.Math.toRadians(-34), roll: 0 },
                duration: 1.1,
                complete: () => {
                    if (token !== presentationTourToken) return;
                    index += 1;
                    if (index >= sites.length) return stopPresentationTour(false);
                    presentationTourTimer = window.setTimeout(visit, 1800);
                },
            });
        };
        visit();
    }

    function hudStorageKey() {
        return simId ? `optim-analyzer:rf-3d-hud:${simId}` : null;
    }

    function setHudCollapsed(collapsed, persist = true) {
        const panel = $('hud-top');
        const button = $('hud-collapse');
        panel.classList.toggle('is-collapsed', collapsed);
        button.textContent = collapsed ? '▸' : '▾';
        button.setAttribute('aria-expanded', String(!collapsed));
        button.title = collapsed ? 'Afficher les réglages RF 3D' : 'Masquer les réglages RF 3D';
        if (persist) saveHudState();
    }

    function saveHudState() {
        const panel = $('hud-top');
        if (!panel || !hudStorageKey()) return;
        const rect = panel.getBoundingClientRect();
        try {
            localStorage.setItem(hudStorageKey(), JSON.stringify({
                left: Math.round(rect.left), top: Math.round(rect.top),
                collapsed: panel.classList.contains('is-collapsed'),
            }));
        } catch (_) {}
    }

    function restoreHudState() {
        try {
            const saved = JSON.parse(localStorage.getItem(hudStorageKey()) || 'null');
            if (!saved) return;
            if (window.innerWidth > 720 && Number.isFinite(Number(saved.left)) && Number.isFinite(Number(saved.top))) {
                const panel = $('hud-top');
                const rect = panel.getBoundingClientRect();
                panel.style.left = `${Math.max(8, Math.min(window.innerWidth - rect.width - 8, Number(saved.left)))}px`;
                panel.style.top = `${Math.max(8, Math.min(window.innerHeight - 54, Number(saved.top)))}px`;
                panel.style.right = 'auto';
            }
            setHudCollapsed(saved.collapsed === true, false);
        } catch (_) {}
    }

    function onHudPointerDown(event) {
        if (event.button !== 0 || event.target.closest('button, input, select, label')) return;
        const panel = $('hud-top');
        const rect = panel.getBoundingClientRect();
        hudDragState = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    }

    function onHudPointerMove(event) {
        if (!hudDragState || window.innerWidth <= 720) return;
        const panel = $('hud-top');
        const rect = panel.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, event.clientX - hudDragState.offsetX));
        const top = Math.max(8, Math.min(window.innerHeight - 54, event.clientY - hudDragState.offsetY));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = 'auto';
    }

    function onHudPointerUp(event) {
        if (!hudDragState) return;
        hudDragState = null;
        try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch (_) {}
        saveHudState();
    }

    function removeEntities(list) {
        list.forEach(entity => { try { viewer?.entities.remove(entity); } catch (_) {} });
        return [];
    }

    function clearBuildingTileCache() {
        buildingTileCacheVersion += 1;
        buildingTileCache.forEach(tile => {
            (tile.primitives || []).forEach(primitive => { try { viewer?.scene.primitives.remove(primitive); } catch (_) {} });
        });
        buildingTileCache.clear();
        activeBuildingTileKeys.clear();
        buildingPrimitives = [];
    }

    function subZoneStorageKey() {
        return simId ? `optim-analyzer:rf-3d-subzone:${simId}` : null;
    }

    function clearBuildingLabels() {
        buildingLabelEntities = removeEntities(buildingLabelEntities);
    }

    function buildingLabelStorageKey() {
        return simId ? `optim-analyzer:rf-3d-building-labels:${simId}` : null;
    }

    function restoreBuildingLabelOverrides() {
        try {
            const saved = JSON.parse(localStorage.getItem(buildingLabelStorageKey()) || '{}');
            buildingLabelOverrides = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
        } catch (_) {
            buildingLabelOverrides = {};
        }
    }

    function saveBuildingLabelOverrides() {
        try { localStorage.setItem(buildingLabelStorageKey(), JSON.stringify(buildingLabelOverrides)); } catch (_) {}
    }

    // Free labels are presentation annotations only. They are stored per
    // simulation in the browser; GeoData and the RF result remain immutable.
    function freeLabelStorageKey() {
        return simId ? `optim-analyzer:rf-3d-free-labels:${simId}` : null;
    }

    function restoreFreeLabels() {
        try {
            const saved = JSON.parse(localStorage.getItem(freeLabelStorageKey()) || '[]');
            freeLabels = Array.isArray(saved) ? saved.filter(item => item && item.id
                && Number.isFinite(Number(item.lon)) && Number.isFinite(Number(item.lat))) : [];
        } catch (_) {
            freeLabels = [];
        }
    }

    function saveFreeLabels() {
        try { localStorage.setItem(freeLabelStorageKey(), JSON.stringify(freeLabels)); } catch (_) {}
    }

    function clearFreeLabels() {
        freeLabelEntities = removeEntities(freeLabelEntities);
    }

    function clearPlaces(status = 'Lieux OSM : masqués') {
        placesLoadVersion += 1;
        clearTimeout(placesReloadTimer);
        placesReloadTimer = null;
        placeEntities = removeEntities(placeEntities);
        placeItems = [];
        lastPlacesBoundsKey = '';
        const statusNode = $('hud-place-status');
        if (statusNode) statusNode.textContent = status;
        const attribution = $('osm-attribution');
        if (attribution) attribution.hidden = true;
    }

    function placeScopeBounds() {
        return geometryBounds(subZoneGeoJson() || subZoneGeometry)
            || visibleBuildingBounds() || manifestBounds();
    }

    function placeBoundsKey(bounds) {
        return bounds ? [bounds.west, bounds.south, bounds.east, bounds.north]
            .map(value => Number(value).toFixed(4)).join(':') : '';
    }

    function placeColor(category) {
        return ({ health: '#ef4444', education: '#a855f7', 'public service': '#38bdf8',
            transport: '#f59e0b', notable: '#f97316', leisure: '#22c55e', quartier: '#60a5fa', commerce: '#eab308' })[category]
            || '#94a3b8';
    }

    function placeDisplayName(value) {
        const text = String(value || 'Lieu').trim().slice(0, 100) || 'Lieu';
        // Cesium labels are packed into a glyph atlas. On certain browser /
        // canvas combinations Arabic glyphs reach that atlas unshaped and in
        // logical order, so they appear as disconnected or reversed letters.
        // Convert only RTL labels to presentation forms then apply UAX #9 bidi
        // ordering; the stored OpenStreetMap name remains untouched.
        if (!/[\u0600-\u08ff]/u.test(text)) return text;
        try {
            const reshaped = window.ArabicReshaper?.convertArabic?.(text);
            if (!reshaped || typeof window.bidi_js !== 'function') return text;
            rtlBidiEngine ||= window.bidi_js();
            const levels = rtlBidiEngine.getEmbeddingLevels(reshaped, 'ltr');
            return rtlBidiEngine.getReorderedString(reshaped, levels);
        } catch (_) {
            return text;
        }
    }

    function filteredPlaces() {
        const filter = $('hud-place-filter')?.value || 'all';
        if (filter === 'transport') return placeItems.filter(item => item.category === 'transport');
        if (filter === 'services') return placeItems.filter(item => item.category === 'health' || item.category === 'education' || item.category === 'public service');
        if (filter === 'landmarks') return placeItems.filter(item => ['health', 'education', 'public service', 'transport', 'notable', 'leisure', 'quartier'].includes(item.category));
        return placeItems;
    }

    function renderPlaces() {
        placeEntities = removeEntities(placeEntities);
        if (!viewer || !$('hud-places')?.checked) return;
        // A hard client-side limit remains even if a source happens to contain
        // many businesses with the same zoom level. At small scales labels
        // would become noise, not analysis context.
        const places = filteredPlaces().slice(0, 80);
        places.forEach(place => {
            const lon = Number(place.lon), lat = Number(place.lat);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            const color = placeColor(place.category);
            const category = String(place.category || 'lieu');
            const displayName = placeDisplayName(place.name);
            const hasArabic = /[\u0600-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/u.test(displayName);
            placeEntities.push(viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(lon, lat, 1),
                point: { pixelSize: 7, color: cssColor(color), outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: 1800 },
                label: {
                    text: displayName, font: hasArabic
                        ? '700 13px "Geeza Pro", "Noto Sans Arabic", Arial, sans-serif'
                        : '700 12px system-ui',
                    fillColor: cssColor('#f8fafc'), outlineColor: cssColor('#071323', .98), outlineWidth: 3,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE, showBackground: true,
                    backgroundColor: cssColor(color, .88), backgroundPadding: new Cesium.Cartesian2(6, 3),
                    pixelOffset: new Cesium.Cartesian2(0, -13), verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6000),
                    scaleByDistance: new Cesium.NearFarScalar(180, 1, 6000, .55),
                    translucencyByDistance: new Cesium.NearFarScalar(3500, 1, 6000, 0), disableDepthTestDistance: 1600,
                },
                properties: { type: 'Lieu OpenStreetMap', name: place.name, category, source: 'OpenStreetMap' },
            }));
        });
        const status = $('hud-place-status');
        if (status) status.textContent = `Lieux OSM : ${placeEntities.length} repère(s) affiché(s)`;
        viewer.scene.requestRender();
    }

    async function loadPlaces(force = false) {
        if (!viewer || !currentManifest || !$('hud-places')?.checked) return;
        const bounds = placeScopeBounds();
        const status = $('hud-place-status');
        if (!bounds) {
            if (status) status.textContent = 'Lieux OSM : emprise de la vue indisponible';
            return;
        }
        const key = placeBoundsKey(bounds);
        if (!force && key === lastPlacesBoundsKey && placeItems.length) return renderPlaces();
        const version = ++placesLoadVersion;
        if (status) status.textContent = 'Lieux OSM : chargement…';
        try {
            const data = await window.rf3dApi.places(currentManifest.id, bounds);
            if (version !== placesLoadVersion || !$('hud-places')?.checked) return;
            placeItems = Array.isArray(data.items) ? data.items : [];
            lastPlacesBoundsKey = key;
            const attribution = $('osm-attribution');
            if (attribution) {
                attribution.textContent = data.attribution || '© OpenStreetMap contributors';
                attribution.hidden = false;
            }
            renderPlaces();
        } catch (error) {
            if (version !== placesLoadVersion || !$('hud-places')?.checked) return;
            if (status) status.textContent = `Lieux OSM : ${error.message || 'indisponibles'}`;
        }
    }

    function queuePlacesReload() {
        if (!$('hud-places')?.checked || subZoneGeometry || subZoneMode) return;
        clearTimeout(placesReloadTimer);
        placesReloadTimer = setTimeout(() => loadPlaces(), 500);
    }

    function freeLabelAppearance(label) {
        const text = String(label?.text || 'Étiquette').trim().slice(0, 80) || 'Étiquette';
        const color = /^#[0-9a-f]{6}$/i.test(String(label?.color || '')) ? label.color : '#38bdf8';
        const size = Cesium.Math.clamp(Number(label?.size) || 14, 9, 32);
        return { text, color, size };
    }

    function renderFreeLabels() {
        clearFreeLabels();
        if (!$('hud-free-labels')?.checked || !viewer) return;
        freeLabels.forEach(item => {
            const appearance = freeLabelAppearance(item);
            const height = Math.max(0, Number(item.height) || 0) + 0.8;
            const entity = viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(Number(item.lon), Number(item.lat), height),
                point: { pixelSize: 7, color: cssColor(appearance.color), outlineColor: cssColor('#ffffff'), outlineWidth: 2,
                    disableDepthTestDistance: 1800 },
                label: {
                    text: appearance.text, font: `800 ${appearance.size}px system-ui`,
                    fillColor: cssColor(appearance.color), outlineColor: cssColor('#071323', 0.98), outlineWidth: 3,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    showBackground: true, backgroundColor: cssColor('#071323', 0.86),
                    backgroundPadding: new Cesium.Cartesian2(7, 4),
                    pixelOffset: new Cesium.Cartesian2(0, -14), verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8000),
                    scaleByDistance: new Cesium.NearFarScalar(250, 1, 8000, 0.58),
                    disableDepthTestDistance: 1800,
                },
                properties: { type: 'Étiquette libre', labelId: item.id },
            });
            entity._rf3dFreeLabelId = item.id;
            freeLabelEntities.push(entity);
        });
        viewer.scene.requestRender();
    }

    function selectedFreeLabel() {
        return freeLabels.find(item => item.id === selectedFreeLabelId) || null;
    }

    function selectFreeLabel(entity) {
        const id = entity?._rf3dFreeLabelId;
        if (!id || !freeLabels.some(item => item.id === id)) return false;
        selectedFreeLabelId = id;
        updateFreeLabelEditor();
        $('hud-free-label-status').textContent = 'Étiquette sélectionnée : modifiez-la puis appliquez.';
        return true;
    }

    function updateFreeLabelEditor() {
        const editor = $('hud-free-label-editor');
        const label = selectedFreeLabel();
        editor.hidden = !label;
        if (!label) return;
        const appearance = freeLabelAppearance(label);
        $('hud-free-label-target').textContent = `Étiquette : ${appearance.text}`;
        $('hud-free-label-text').value = appearance.text;
        $('hud-free-label-color').value = appearance.color;
        $('hud-free-label-size').value = String(appearance.size);
    }

    function setFreeLabelMode(enabled) {
        freeLabelMode = Boolean(enabled);
        if (freeLabelMode && buildingLabelEditMode) setBuildingLabelEditMode(false);
        const button = $('hud-free-label-add');
        button.classList.toggle('is-active', freeLabelMode);
        button.textContent = freeLabelMode ? '✛ Cliquez sur la carte' : '＋ Nouvelle étiquette';
        $('hud-free-label-status').textContent = freeLabelMode
            ? 'Ajout : cliquez l’emplacement de l’étiquette.'
            : 'Annotations : ajoutez un repère libre sur la carte 3D.';
    }

    function addFreeLabelAt(clicked) {
        const id = `label-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const label = {
            id, lon: Number(clicked.longitudeDegrees), lat: Number(clicked.latitudeDegrees),
            height: Math.max(0, Number(clicked.height) || 0), text: `Étiquette ${freeLabels.length + 1}`,
            color: '#38bdf8', size: 14,
        };
        freeLabels.push(label);
        selectedFreeLabelId = id;
        saveFreeLabels();
        $('hud-free-labels').checked = true;
        setFreeLabelMode(false);
        renderFreeLabels();
        updateFreeLabelEditor();
        $('hud-free-label-status').textContent = 'Nouvelle étiquette créée. Modifiez son contenu puis appliquez.';
    }

    function applyFreeLabelEditor() {
        const label = selectedFreeLabel();
        if (!label) return;
        label.text = String($('hud-free-label-text').value || '').trim().slice(0, 80) || 'Étiquette';
        const color = $('hud-free-label-color').value;
        label.color = /^#[0-9a-f]{6}$/i.test(color) ? color : '#38bdf8';
        label.size = Cesium.Math.clamp(Number($('hud-free-label-size').value) || 14, 9, 32);
        saveFreeLabels();
        renderFreeLabels();
        updateFreeLabelEditor();
        $('hud-free-label-status').textContent = 'Étiquette mise à jour.';
    }

    function deleteFreeLabel() {
        const label = selectedFreeLabel();
        if (!label) return;
        freeLabels = freeLabels.filter(item => item.id !== label.id);
        selectedFreeLabelId = null;
        saveFreeLabels();
        renderFreeLabels();
        updateFreeLabelEditor();
        $('hud-free-label-status').textContent = 'Étiquette supprimée.';
    }

    function buildingDisplayName(feature) {
        const id = String(feature?.id || '—');
        const sourceName = String(feature?.name || '').trim();
        // Most GeoData footprints only carry a Polygon_ID.  Present it as a
        // clear building identifier instead of suggesting it is a real-world
        // postal/building name. Genuine Name attributes remain untouched.
        return sourceName && sourceName !== id ? sourceName : `Bâtiment #${id}`;
    }

    function labelAppearance(feature) {
        const saved = buildingLabelOverrides[String(feature?.id)] || {};
        const text = String(saved.text || buildingDisplayName(feature)).trim().slice(0, 80) || buildingDisplayName(feature);
        const color = /^#[0-9a-f]{6}$/i.test(String(saved.color || '')) ? saved.color : '#ffffff';
        const size = Cesium.Math.clamp(Number(saved.size) || 11, 9, 28);
        return { text, color, size };
    }

    function renderBuildingLabels() {
        clearBuildingLabels();
        if (!$('hud-building-labels')?.checked) return;
        // Labels are useful for an inspection sub-zone. A high ceiling avoids
        // turning a territorial study into unreadable text and GPU work.
        const maximum = (subZoneGeometry || subZoneGeoJson()) ? 500 : 120;
        renderedBuildingFeatures.slice(0, maximum).forEach(feature => {
            const center = feature.center || [];
            if (!Number.isFinite(Number(center[0])) || !Number.isFinite(Number(center[1]))) return;
            const top = Number(feature.baseHeightM) + Number(feature.heightAglM) + 1;
            const appearance = labelAppearance(feature);
            buildingLabelEntities.push(viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(Number(center[0]), Number(center[1]), top),
                label: {
                    text: appearance.text, font: `700 ${appearance.size}px system-ui`,
                    fillColor: cssColor(appearance.color), outlineColor: cssColor('#071323', 0.98), outlineWidth: 3,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    showBackground: true, backgroundColor: cssColor('#071323', 0.8),
                    backgroundPadding: new Cesium.Cartesian2(6, 3),
                    pixelOffset: new Cesium.Cartesian2(0, -13),
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1600),
                    scaleByDistance: new Cesium.NearFarScalar(120, 1, 1600, 0.52),
                    translucencyByDistance: new Cesium.NearFarScalar(900, 1, 1600, 0.18),
                    // Keep labels readable above source-backed volumes while
                    // still allowing the buildings themselves to occlude RF.
                    disableDepthTestDistance: 1800,
                },
                properties: { type: 'Nom bâtiment', buildingId: feature.id },
            }));
        });
    }

    function removeSurface() {
        if (!rfSurfacePrimitive || !viewer) return;
        try { viewer.scene.primitives.remove(rfSurfacePrimitive); } catch (_) {}
        rfSurfacePrimitive = null;
    }

    function configureBuildingControl(defaultVisible = false) {
        const input = $('hud-buildings');
        const status = $('hud-building-status');
        const layer = currentManifest?.visualLayers?.buildings || {};
        const available = layer.available === true;
        input.disabled = !available;
        if (defaultVisible) input.checked = available;
        if (available) {
            status.textContent = 'Bâtiments : prêts';
            return;
        }
        buildingsLoadVersion += 1;
        buildingEntities = removeEntities(buildingEntities);
        clearBuildingTileCache();
        status.textContent = 'Bâtiments : absents du GeoData de cette simulation';
    }

    function surfacePrimitive(surface, textureUrl, opacity) {
        const rows = Number(surface?.rows);
        const cols = Number(surface?.cols);
        const raw = surface?.positions || [];
        if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2 || raw.length !== rows * cols * 3) {
            throw new Error('Maillage RF 3D incomplet.');
        }
        const vertexCount = rows * cols;
        const positions = new Float64Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);
        const st = new Float32Array(vertexCount * 2);
        const valid = new Uint8Array(vertexCount);
        const rfMask = Array.isArray(surface?.rfValidMask) && surface.rfValidMask.length === vertexCount
            ? surface.rfValidMask : null;
        const offset = Number(surface.verticalOffsetM || 0);
        for (let index = 0; index < vertexCount; index += 1) {
            // A NoData DTM sample is intentionally sent as null.  Number(null)
            // would turn it into zero and would incorrectly draw the RF surface
            // at sea level, creating artificial triangles at the dataset edge.
            const rawLon = raw[index * 3];
            const rawLat = raw[index * 3 + 1];
            const rawHeight = raw[index * 3 + 2];
            const lon = rawLon == null ? NaN : Number(rawLon);
            const lat = rawLat == null ? NaN : Number(rawLat);
            const height = rawHeight == null ? NaN : Number(rawHeight);
            // A mesh triangle is permitted only where the saved RF raster has
            // a real value.  This clips a user-drawn AOI at its true raster
            // boundary instead of drawing a large square of transparent
            // texels over the satellite / terrain layer.
            if (Number.isFinite(lon) && Number.isFinite(lat) && Number.isFinite(height)
                && (!rfMask || Number(rfMask[index]) === 1)) {
                const cartesian = Cesium.Cartesian3.fromDegrees(lon, lat, height + offset);
                positions[index * 3] = cartesian.x;
                positions[index * 3 + 1] = cartesian.y;
                positions[index * 3 + 2] = cartesian.z;
                valid[index] = 1;
            }
            // MaterialAppearance requires a normal attribute even though this
            // draped map material is rendered flat.
            normals[index * 3 + 2] = 1;
            const row = Math.floor(index / cols);
            const col = index % cols;
            st[index * 2] = col / Math.max(1, cols - 1);
            st[index * 2 + 1] = 1 - row / Math.max(1, rows - 1);
        }
        const indices = [];
        for (let row = 0; row < rows - 1; row += 1) {
            for (let col = 0; col < cols - 1; col += 1) {
                const nw = row * cols + col;
                const ne = nw + 1;
                const sw = nw + cols;
                const se = sw + 1;
                if (valid[nw] && valid[ne] && valid[sw] && valid[se]) {
                    indices.push(nw, sw, ne, ne, sw, se);
                }
            }
        }
        if (!indices.length) throw new Error('Le DTM ne contient aucun sommet valide dans cette zone.');
        const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
        const geometry = new Cesium.Geometry({
            attributes: {
                position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
                normal: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: normals }),
                st: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st }),
            },
            indices: new IndexArray(indices),
            primitiveType: Cesium.PrimitiveType.TRIANGLES,
            boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
        });
        const material = new Cesium.Material({
            fabric: { type: 'Image', uniforms: { image: textureUrl, color: new Cesium.Color(1, 1, 1, opacity) } },
        });
        return new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({ geometry }),
            // The RF map is a ground drape. Rendering its back face made it
            // look like an opaque ceiling whenever a camera reached a low
            // angle; the terrain collision guard keeps the camera above it.
            appearance: new Cesium.MaterialAppearance({ material, flat: true, faceForward: false, translucent: true, closed: false }),
            asynchronous: true,
        });
    }

    function setSurfaceOpacity(value) {
        if (rfLayer) rfLayer.alpha = value;
        const color = rfSurfacePrimitive?.appearance?.material?.uniforms?.color;
        if (color) {
            color.alpha = value;
            viewer?.scene.requestRender();
        }
    }

    function setSurfaceVisibility(announce = true) {
        const visible = $('hud-simulation')?.checked !== false;
        // Re-create the independent base provider when RF is hidden.  Earlier
        // code addressed imagery layer 0 directly; after RF replacement that
        // could remove/leave a stale base layer and expose only the terrain
        // colour.  The background remains an explicit, persistent layer.
        if (!visible) setBaseMap($('hud-base')?.value, true);
        if (rfLayer) rfLayer.show = visible;
        if (rfSurfacePrimitive) rfSurfacePrimitive.show = visible;
        $('legend').hidden = !visible;
        if (announce) {
            $('hud-surface-status').textContent = visible
                ? (localTerrainAttached ? 'Surface : DTM local' : 'Surface : globe de secours')
                : 'Simulation RF : masquée — fond de carte visible';
        }
        viewer?.scene.requestRender();
    }

    function buildingHierarchy(geometry, baseHeight) {
        const rings = geometry?.coordinates || [];
        if (!rings.length) return null;
        const ring = coordinates => coordinates.map(point => Cesium.Cartesian3.fromDegrees(Number(point[0]), Number(point[1]), baseHeight + 0.15));
        const outer = ring(rings[0]);
        if (outer.length < 3) return null;
        const holes = rings.slice(1).map(coords => new Cesium.PolygonHierarchy(ring(coords))).filter(Boolean);
        return new Cesium.PolygonHierarchy(outer, holes);
    }

    function addBuildingPrimitive(instances, shadows) {
        if (!instances.length) return null;
        const primitive = viewer.scene.primitives.add(new Cesium.Primitive({
            geometryInstances: instances,
            appearance: new Cesium.PerInstanceColorAppearance({
                translucent: false, closed: true, flat: false,
            }),
            asynchronous: true,
            // Pick identifiers remain available after initialization, while
            // releasing source geometry avoids retaining a second copy of a
            // dense urban tile in browser memory.
            releaseGeometryInstances: true,
            shadows,
        }));
        buildingPrimitives.push(primitive);
        return primitive;
    }

    function addBuildingTile(features) {
        const facades = [];
        const roofs = [];
        features.forEach(feature => {
            const base = Number(feature.baseHeightM);
            const agl = Number(feature.heightAglM);
            if (!Number.isFinite(base) || !Number.isFinite(agl) || agl <= 0) return;
            const appearance = buildingAppearance(feature);
            const top = base + agl;
            const parts = feature.geometry?.type === 'MultiPolygon'
                ? feature.geometry.coordinates.map(coordinates => ({ type: 'Polygon', coordinates }))
                : [feature.geometry];
            parts.forEach(geometry => {
                const hierarchy = buildingHierarchy(geometry, base);
                if (!hierarchy) return;
                // Picking the primitive returns this small source reference;
                // labels and editors keep working without one Entity per wall.
                const source = { _rf3dBuildingFeature: feature };
                facades.push(new Cesium.GeometryInstance({
                    geometry: new Cesium.PolygonGeometry({
                        polygonHierarchy: hierarchy, height: base + 0.15,
                        extrudedHeight: top + 0.15,
                        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                    }),
                    attributes: {
                        color: Cesium.ColorGeometryInstanceAttribute.fromColor(cssColor(appearance.facade, appearance.facadeAlpha)),
                    },
                    id: source,
                }));
                // buildingHierarchy applies the shared 0.15 m anti-flicker
                // offset; add only another 5 cm for the roof plane.
                const roofHierarchy = buildingHierarchy(geometry, top + 0.05);
                if (!roofHierarchy) return;
                roofs.push(new Cesium.GeometryInstance({
                    geometry: new Cesium.PolygonGeometry({
                        polygonHierarchy: roofHierarchy, perPositionHeight: true,
                        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                    }),
                    attributes: {
                        color: Cesium.ColorGeometryInstanceAttribute.fromColor(cssColor(appearance.roof, 1)),
                    },
                    id: source,
                }));
            });
        });
        const presentation = $('hud-building-style')?.value !== 'technical';
        const shadows = presentation && $('hud-building-shadows')?.checked !== false
            ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
        return [addBuildingPrimitive(facades, shadows), addBuildingPrimitive(roofs, shadows)].filter(Boolean);
    }

    function updateBuildingLabelEditor() {
        const editor = $('hud-building-label-editor');
        const selected = selectedBuildingForLabel;
        editor.hidden = !selected;
        if (!selected) return;
        const appearance = labelAppearance(selected);
        $('hud-building-label-target').textContent = `Bâtiment #${selected.id}`;
        $('hud-building-label-text').value = appearance.text;
        $('hud-building-label-color').value = appearance.color;
        $('hud-building-label-size').value = String(appearance.size);
    }

    function setBuildingLabelEditMode(enabled) {
        buildingLabelEditMode = Boolean(enabled);
        if (buildingLabelEditMode && freeLabelMode) setFreeLabelMode(false);
        const button = $('hud-building-label-edit');
        button.classList.toggle('is-active', buildingLabelEditMode);
        button.textContent = buildingLabelEditMode ? '✛ Cliquez un bâtiment' : '✎ Éditer étiquette';
        $('hud-building-label-edit-status').textContent = buildingLabelEditMode
            ? 'Édition : cliquez sur un bâtiment 3D.'
            : 'Étiquettes : utilisez le mode édition pour personnaliser un bâtiment.';
    }

    function selectBuildingForLabel(entity) {
        const feature = entity?._rf3dBuildingFeature;
        if (!feature) {
            $('hud-building-label-edit-status').textContent = 'Édition : cliquez directement sur un bâtiment 3D.';
            return false;
        }
        selectedBuildingForLabel = feature;
        buildingLabelEditMode = false;
        setBuildingLabelEditMode(false);
        $('hud-building-labels').checked = true;
        updateBuildingLabelEditor();
        renderBuildingLabels();
        return true;
    }

    function applyBuildingLabelEditor() {
        const feature = selectedBuildingForLabel;
        if (!feature) return;
        const text = String($('hud-building-label-text').value || '').trim().slice(0, 80);
        const color = $('hud-building-label-color').value;
        const size = Cesium.Math.clamp(Number($('hud-building-label-size').value) || 11, 9, 28);
        buildingLabelOverrides[String(feature.id)] = {
            text: text || buildingDisplayName(feature), color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff', size,
        };
        saveBuildingLabelOverrides();
        $('hud-building-labels').checked = true;
        renderBuildingLabels();
        updateBuildingLabelEditor();
        $('hud-building-label-edit-status').textContent = `Étiquette appliquée à Bâtiment #${feature.id}.`;
    }

    function resetBuildingLabelEditor() {
        const feature = selectedBuildingForLabel;
        if (!feature) return;
        delete buildingLabelOverrides[String(feature.id)];
        saveBuildingLabelOverrides();
        renderBuildingLabels();
        updateBuildingLabelEditor();
        $('hud-building-label-edit-status').textContent = `Étiquette source restaurée pour Bâtiment #${feature.id}.`;
    }

    function geometryBounds(geometry) {
        const values = [];
        const visit = coordinate => {
            if (!Array.isArray(coordinate)) return;
            if (typeof coordinate[0] === 'number' && typeof coordinate[1] === 'number') values.push(coordinate);
            else coordinate.forEach(visit);
        };
        visit(geometry?.coordinates);
        if (!values.length) return null;
        const xs = values.map(point => Number(point[0]));
        const ys = values.map(point => Number(point[1]));
        return { west: Math.min(...xs), south: Math.min(...ys), east: Math.max(...xs), north: Math.max(...ys) };
    }

    function buildingScopeKey(selectionGeometry) {
        return selectionGeometry ? `zone:${buildingHash(JSON.stringify(selectionGeometry)).toString(36)}` : 'view';
    }

    function activeBuildingTileDescriptors(selectionGeometry) {
        const source = selectionGeometry ? geometryBounds(selectionGeometry) : (visibleBuildingBounds() || manifestBounds());
        if (!source) return [];
        const margin = selectionGeometry ? 0 : 1;
        const xStart = Math.floor(source.west / BUILDING_TILE_LON_DEG) - margin;
        const xEnd = Math.floor((source.east - Number.EPSILON) / BUILDING_TILE_LON_DEG) + margin;
        const yStart = Math.floor(source.south / BUILDING_TILE_LAT_DEG) - margin;
        const yEnd = Math.floor((source.north - Number.EPSILON) / BUILDING_TILE_LAT_DEG) + margin;
        const scope = buildingScopeKey(selectionGeometry);
        const maximum = selectionGeometry ? BUILDING_TILE_CACHE_LIMIT : 24;
        const xCount = Math.max(0, xEnd - xStart + 1);
        const yCount = Math.max(0, yEnd - yStart + 1);
        if (!xCount || !yCount) return [];
        // At initial Cesium startup an oblique camera can temporarily report
        // the whole globe. Never materialise a world-sized descriptor array:
        // select a bounded grid around the saved RF study instead.
        const allTileCount = xCount * yCount;
        const focus = allTileCount > maximum
            ? (manifestBounds() || source)
            : source;
        const ratio = xCount / Math.max(1, yCount);
        const columns = allTileCount > maximum
            ? Math.min(xCount, Math.max(1, Math.floor(Math.sqrt(maximum * ratio)))) : xCount;
        const rows = allTileCount > maximum
            ? Math.min(yCount, Math.max(1, Math.floor(maximum / columns))) : yCount;
        const centerX = Math.floor(((focus.west + focus.east) / 2) / BUILDING_TILE_LON_DEG);
        const centerY = Math.floor(((focus.south + focus.north) / 2) / BUILDING_TILE_LAT_DEG);
        const fromX = Math.max(xStart, Math.min(xEnd - columns + 1, centerX - Math.floor(columns / 2)));
        const fromY = Math.max(yStart, Math.min(yEnd - rows + 1, centerY - Math.floor(rows / 2)));
        const descriptors = [];
        for (let x = fromX; x < fromX + columns; x += 1) {
            for (let y = fromY; y < fromY + rows; y += 1) {
                descriptors.push({
                    key: `${scope}:${x}:${y}`,
                    bounds: { west: x * BUILDING_TILE_LON_DEG, south: y * BUILDING_TILE_LAT_DEG,
                        east: (x + 1) * BUILDING_TILE_LON_DEG, north: (y + 1) * BUILDING_TILE_LAT_DEG },
                });
            }
        }
        return descriptors;
    }

    function setBuildingTileVisible(tile, visible) {
        tile.visible = visible;
        (tile.primitives || []).forEach(primitive => { primitive.show = visible; });
    }

    function rebuildRenderedBuildingFeatures() {
        const byId = new Map();
        activeBuildingTileKeys.forEach(key => {
            (buildingTileCache.get(key)?.features || []).forEach(feature => byId.set(String(feature.id), feature));
        });
        renderedBuildingFeatures = [...byId.values()];
    }

    function evictOldBuildingTiles() {
        if (buildingTileCache.size <= BUILDING_TILE_CACHE_LIMIT) return;
        const candidates = [...buildingTileCache.values()]
            .filter(tile => !activeBuildingTileKeys.has(tile.key) && !tile.loading)
            .sort((left, right) => left.lastUsed - right.lastUsed);
        while (buildingTileCache.size > BUILDING_TILE_CACHE_LIMIT && candidates.length) {
            const tile = candidates.shift();
            (tile.primitives || []).forEach(primitive => { try { viewer?.scene.primitives.remove(primitive); } catch (_) {} });
            buildingPrimitives = buildingPrimitives.filter(primitive => !(tile.primitives || []).includes(primitive));
            buildingTileCache.delete(tile.key);
        }
    }

    async function requestBuildingTile(descriptor, selectionGeometry, cacheVersion) {
        const cached = buildingTileCache.get(descriptor.key);
        if (cached && !cached.error) {
            cached.lastUsed = Date.now();
            setBuildingTileVisible(cached, true);
            return cached;
        }
        if (cached?.error) buildingTileCache.delete(descriptor.key);
        const tile = { ...descriptor, features: [], primitives: [], loading: true, visible: true, lastUsed: Date.now() };
        buildingTileCache.set(descriptor.key, tile);
        try {
            const data = selectionGeometry
                ? await window.rf3dApi.buildingsInZone(currentManifest.id, selectionGeometry, BUILDING_TILE_FEATURE_LIMIT, descriptor.bounds)
                : await window.rf3dApi.buildings(currentManifest.id, BUILDING_TILE_FEATURE_LIMIT, descriptor.bounds);
            if (cacheVersion !== buildingTileCacheVersion || !buildingTileCache.has(descriptor.key)) return tile;
            if (!data.available) throw new Error(data.reason || 'GeoData bâtiments indisponible');
            tile.features = data.items || [];
            tile.unrenderable = Number(data.unrenderable || 0);
            tile.truncated = Boolean(data.truncated);
            tile.primitives = addBuildingTile(tile.features);
            setBuildingTileVisible(tile, activeBuildingTileKeys.has(descriptor.key));
        } catch (error) {
            tile.error = error;
        } finally {
            tile.loading = false;
            viewer?.scene.requestRender();
        }
        return tile;
    }

    async function loadBuildings(selectionGeometry = null) {
        if (!viewer || !currentManifest || !$('hud-buildings').checked) return;
        const requestVersion = ++buildingsLoadVersion;
        const cacheVersion = buildingTileCacheVersion;
        const descriptors = activeBuildingTileDescriptors(selectionGeometry);
        if (!descriptors.length) return clearDisplayedBuildings('Bâtiments : aucune tuile visible');
        activeBuildingTileKeys = new Set(descriptors.map(item => item.key));
        buildingTileCache.forEach(tile => setBuildingTileVisible(tile, activeBuildingTileKeys.has(tile.key)));
        const cachedCount = descriptors.filter(item => buildingTileCache.has(item.key)).length;
        $('hud-building-status').textContent = `Bâtiments : ${cachedCount}/${descriptors.length} tuiles en cache…`;
        for (let start = 0; start < descriptors.length; start += BUILDING_TILE_RENDER_BATCH) {
            if (requestVersion !== buildingsLoadVersion || cacheVersion !== buildingTileCacheVersion || !$('hud-buildings').checked) return;
            await Promise.all(descriptors.slice(start, start + BUILDING_TILE_RENDER_BATCH)
                .map(descriptor => requestBuildingTile(descriptor, selectionGeometry, cacheVersion)));
            const ready = descriptors.filter(item => buildingTileCache.get(item.key)?.loading === false).length;
            $('hud-building-status').textContent = `Bâtiments : ${ready}/${descriptors.length} tuiles 3D…`;
        }
        if (requestVersion !== buildingsLoadVersion || cacheVersion !== buildingTileCacheVersion || !$('hud-buildings').checked) return;
        rebuildRenderedBuildingFeatures();
        const visibleTiles = descriptors.map(item => buildingTileCache.get(item.key)).filter(Boolean);
        const unavailable = visibleTiles.reduce((sum, tile) => sum + Number(tile.unrenderable || 0), 0);
        const truncated = visibleTiles.some(tile => tile.truncated);
        const errors = visibleTiles.filter(tile => tile.error).length;
        const scope = selectionGeometry ? 'dans la sous-zone' : 'dans la vue';
        $('hud-building-status').textContent = `Bâtiments : ${renderedBuildingFeatures.length.toLocaleString('fr-FR')} · ${descriptors.length} tuiles ${scope}${unavailable ? ` · ${unavailable} sans hauteur AGL/terrain` : ''}${truncated ? ' · tuile à zoomer' : ''}${errors ? ` · ${errors} tuile(s) indisponible(s)` : ''}`;
        renderBuildingLabels();
        evictOldBuildingTiles();
        viewer.scene.requestRender();
    }

    function visibleBuildingBounds() {
        if (!viewer) return null;
        const rectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
        if (!rectangle) return null;
        const west = Cesium.Math.toDegrees(rectangle.west);
        const south = Cesium.Math.toDegrees(rectangle.south);
        const east = Cesium.Math.toDegrees(rectangle.east);
        const north = Cesium.Math.toDegrees(rectangle.north);
        // Local Morocco studies never cross the anti-meridian. Avoid making
        // an invalid unbounded request while the camera is at the horizon.
        return [west, south, east, north].every(Number.isFinite) && east > west && north > south
            ? { west, south, east, north }
            : null;
    }

    function queueVisibleBuildingsReload() {
        if (!$('hud-buildings')?.checked) return;
        clearTimeout(buildingsReloadTimer);
        buildingsReloadTimer = setTimeout(() => loadBuildings(), 250);
    }

    function subZoneGeoJson() {
        if (subZoneVertices.length < 3) return null;
        const ring = subZoneVertices.map(point => [point.longitudeDegrees, point.latitudeDegrees]);
        ring.push([...ring[0]]);
        return { type: 'Polygon', coordinates: [ring] };
    }

    function renderSubZone() {
        if (!viewer) return;
        if (subZoneEntity) viewer.entities.remove(subZoneEntity);
        subZoneVertexEntities = removeEntities(subZoneVertexEntities);
        const draftPositions = subZoneVertices.map(point => Cesium.Cartesian3.fromDegrees(point.longitudeDegrees, point.latitudeDegrees));
        // Show every click immediately.  A visible draft line makes it clear
        // which exact area will be queried, before the third vertex closes it.
        subZoneVertexEntities = draftPositions.map((position, index) => viewer.entities.add({
            position,
            point: { pixelSize: 9, color: cssColor('#fbbf24'), outlineColor: cssColor('#071323'), outlineWidth: 2,
                     heightReference: Cesium.HeightReference.CLAMP_TO_GROUND },
            label: index === 0 && subZoneMode ? {
                text: 'Début sous-zone', font: '600 11px system-ui', fillColor: Cesium.Color.WHITE,
                outlineColor: cssColor('#071323'), outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -16), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            } : undefined,
        }));
        if (draftPositions.length >= 2 && subZoneVertices.length < 3) {
            subZoneEntity = viewer.entities.add({
                polyline: { positions: draftPositions, width: 3, material: cssColor('#fbbf24', 0.95), clampToGround: true },
            });
            viewer.scene.requestRender();
            return;
        }
        const geometry = subZoneGeoJson() || subZoneGeometry;
        if (!geometry) { subZoneEntity = null; return; }
        const ring = geometry.coordinates[0].map(point => Cesium.Cartesian3.fromDegrees(Number(point[0]), Number(point[1])));
        const centre = ring.slice(0, -1).reduce((sum, point) => Cesium.Cartesian3.add(sum, point, sum), new Cesium.Cartesian3());
        Cesium.Cartesian3.divideByScalar(centre, Math.max(1, ring.length - 1), centre);
        subZoneEntity = viewer.entities.add({
            polygon: {
                hierarchy: new Cesium.PolygonHierarchy(ring), material: cssColor('#f59e0b', 0.17),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                outline: true, outlineColor: cssColor('#fbbf24', 0.95),
            },
            polyline: { positions: ring, width: 3, material: cssColor('#fbbf24', 0.95), clampToGround: true },
            position: centre,
            label: {
                text: `ZONE DE RÉCLAMATION\n${subZoneName}`, font: '800 13px system-ui', fillColor: Cesium.Color.WHITE,
                outlineColor: cssColor('#071323', 0.98), outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                showBackground: true, backgroundColor: cssColor('#713f12', 0.92), backgroundPadding: new Cesium.Cartesian2(9, 6),
                pixelOffset: new Cesium.Cartesian2(0, -18), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM, disableDepthTestDistance: 8000,
                show: $('hud-zone-label')?.checked !== false,
            },
            properties: { type: 'Zone de réclamation', name: subZoneName },
        });
        viewer.scene.requestRender();
    }

    function clearDisplayedBuildings(status) {
        buildingsLoadVersion += 1;
        buildingEntities = removeEntities(buildingEntities);
        clearBuildingTileCache();
        clearBuildingLabels();
        renderedBuildingFeatures = [];
        $('hud-building-status').textContent = status;
        viewer?.scene.requestRender();
    }

    function previewSubZoneBuildings() {
        const geometry = subZoneGeoJson();
        if (!geometry) {
            clearDisplayedBuildings('Sous-zone : placez au moins 3 points');
            return;
        }
        clearTimeout(buildingsReloadTimer);
        buildingsReloadTimer = setTimeout(() => loadBuildings(geometry), 180);
    }

    function updateSubZoneControls() {
        $('hud-zone').classList.toggle('is-active', subZoneMode);
        $('hud-zone').textContent = subZoneMode ? '✛ Cliquez la carte' : (subZoneGeometry ? '▱ Nouvelle zone' : '▱ Sous-zone');
        $('hud-zone-save').hidden = !subZoneMode;
        $('hud-zone-clear').hidden = !subZoneGeometry && !subZoneVertices.length;
    }

    function beginSubZone() {
        subZoneMode = !subZoneMode;
        if (subZoneMode) {
            subZoneVertices = [];
            subZoneGeometry = null;
            // Do not leave volumes from a previous view visible while the
            // user draws a new claim area.  From now on this screen shows
            // only buildings intersecting the draft/validated sub-zone.
            clearDisplayedBuildings('Sous-zone : placez au moins 3 points');
            if ($('hud-places')?.checked) clearPlaces('Lieux OSM : validez la sous-zone pour charger les repères');
            applyCameraPreset('top');
            $('hud-pivot').disabled = true;
        } else {
            $('hud-pivot').disabled = false;
            previewSubZoneBuildings();
        }
        updateSubZoneControls();
        renderSubZone();
    }

    async function saveSubZone() {
        const geometry = subZoneGeoJson();
        if (!geometry) return;
        const candidate = window.prompt('Nom de la sous-zone', subZoneName);
        if (candidate === null) return;
        subZoneName = candidate.trim() || 'Zone de réclamation';
        subZoneGeometry = geometry;
        subZoneVertices = [];
        subZoneMode = false;
        clearTimeout(buildingsReloadTimer);
        buildingsReloadTimer = null;
        $('hud-pivot').disabled = false;
        try { localStorage.setItem(subZoneStorageKey(), JSON.stringify({ name: subZoneName, geometry: subZoneGeometry })); } catch (_) {}
        updateSubZoneControls();
        renderSubZone();
        await loadBuildings(subZoneGeometry);
        await loadPlaces(true);
    }

    function clearSubZone() {
        subZoneMode = false;
        subZoneVertices = [];
        subZoneGeometry = null;
        $('hud-pivot').disabled = false;
        try { localStorage.removeItem(subZoneStorageKey()); } catch (_) {}
        updateSubZoneControls();
        renderSubZone();
        loadBuildings();
        loadPlaces(true);
    }

    function restoreSubZone() {
        try {
            const saved = JSON.parse(localStorage.getItem(subZoneStorageKey()) || 'null');
            if (!saved?.geometry || saved.geometry.type !== 'Polygon') return false;
            subZoneGeometry = saved.geometry;
            subZoneName = String(saved.name || 'Zone de réclamation');
            renderSubZone(); updateSubZoneControls();
            loadBuildings(subZoneGeometry);
            loadPlaces(true);
            return true;
        } catch (_) { return false; }
    }

    function antennaOutline(tx, altitude, color) {
        const lat = Number(tx.lat);
        const lon = Number(tx.lon);
        const azimuth = Number(tx.azimuthDeg ?? 0);
        const beamwidth = Math.min(120, Math.max(10, Number(tx.horizontalBeamwidthDeg ?? 65)));
        const rangeM = 250;
        const positions = [transmitterPosition(tx, altitude)];
        for (let offset = -beamwidth / 2; offset <= beamwidth / 2 + 0.01; offset += 4) {
            const bearing = Cesium.Math.toRadians(azimuth + offset);
            const dLat = rangeM * Math.cos(bearing) / 111320;
            const dLon = rangeM * Math.sin(bearing) / (111320 * Math.max(0.2, Math.cos(Cesium.Math.toRadians(lat))));
            positions.push(Cesium.Cartesian3.fromDegrees(lon + dLon, lat + dLat, altitude));
        }
        positions.push(transmitterPosition(tx, altitude));
        const measured = tx.patternPresentation === 'measured-msi';
        return viewer.entities.add({
            polyline: {
                positions,
                width: measured ? 2.5 : 1.25,
                material: measured
                    ? new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.18, color: cssColor('#22d3ee', 0.88) })
                    : cssColor(color, 0.6),
            },
            properties: {
                patternPresentation: measured ? 'MSI mesuré' : 'Indicateur générique — non mesuré',
                antennaPatternId: tx.antennaPatternId || '—',
            },
            show: false,
        });
    }

    function addSectors() {
        sectorEntities = removeEntities(sectorEntities);
        patternEntities = removeEntities(patternEntities);
        groupedTransmitters().forEach(group => {
            const first = group.txs[0];
            const base = transmitterGroundHeight(first);
            const maximumAgl = Math.max(...group.txs.map(tx => Math.max(3, Number(tx.antennaHeightAglM ?? 25))));
            const color = cssColor(first.color || window.rf3dLayers.OPERATOR_COLORS[String(first.operator || '').toUpperCase()] || '#38bdf8');
            const mast = viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(group.lon, group.lat, base + maximumAgl / 2),
                cylinder: {
                    length: maximumAgl, topRadius: 0.18, bottomRadius: 0.52,
                    material: cssColor('#64748b', 0.84), outline: true,
                    outlineColor: cssColor('#cbd5e1', 0.72), shadows: Cesium.ShadowMode.DISABLED,
                },
                properties: { type: 'Pylône symbolique', site: group.site, sectorCount: group.txs.length },
            });
            mast._rf3dSiteKey = group.key;
            sectorEntities.push(mast);
            const marker = viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(group.lon, group.lat, base + maximumAgl),
                point: { pixelSize: 5, color, outlineColor: Cesium.Color.WHITE.withAlpha(0.8), outlineWidth: 1.2 },
                label: {
                    text: `${group.site}\n${group.txs.length} secteur${group.txs.length > 1 ? 's' : ''}`,
                    font: '600 12px system-ui', fillColor: Cesium.Color.WHITE,
                    showBackground: true, backgroundColor: cssColor('#071323', 0.84),
                    backgroundPadding: new Cesium.Cartesian2(7, 4), pixelOffset: new Cesium.Cartesian2(0, -20),
                    // One label per physical site only. Limiting labels at
                    // distance keeps the 3D view legible on dense urban maps.
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4500),
                    scaleByDistance: new Cesium.NearFarScalar(500, 0.95, 4500, 0.45),
                },
                properties: { site: group.site, sectorCount: group.txs.length },
            });
            marker._rf3dSiteKey = group.key;
            sectorEntities.push(marker);
            group.txs.forEach((tx, index) => {
                const txAgl = Math.max(3, Number(tx.antennaHeightAglM ?? 25));
                const panel = sectorPanel(tx, base, index, group.txs.length);
                panel._rf3dSiteKey = group.key;
                sectorEntities.push(panel);
                const pattern = antennaOutline(tx, base + txAgl, panelColor(tx));
                pattern._rf3dSiteKey = group.key;
                patternEntities.push(pattern);
            });
        });
    }

    function applySectorVisibility() {
        const visible = $('hud-sectors').checked;
        sectorEntities.forEach(entity => { entity.show = visible && entity._rf3dSiteKey !== siteViewSiteKey; });
        const patternsVisible = visible && $('hud-patterns').checked;
        patternEntities.forEach(entity => { entity.show = patternsVisible && entity._rf3dSiteKey !== siteViewSiteKey; });
    }

    function focusOnManifest() {
        const bounds = manifestBounds();
        if (bounds) {
            const corners = [
                Cesium.Cartesian3.fromDegrees(bounds.west, bounds.south),
                Cesium.Cartesian3.fromDegrees(bounds.east, bounds.south),
                Cesium.Cartesian3.fromDegrees(bounds.east, bounds.north),
                Cesium.Cartesian3.fromDegrees(bounds.west, bounds.north),
            ];
            const sphere = Cesium.BoundingSphere.fromPoints(corners);
            viewer.camera.flyToBoundingSphere(sphere, {
                offset: new Cesium.HeadingPitchRange(
                    Cesium.Math.toRadians(25), Cesium.Math.toRadians(-58), Math.max(1000, sphere.radius * 2.8)),
                duration: 1.6,
            });
            return;
        }
        viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(-6.8, 33.9, 900000) });
    }

    function applyCameraPreset(mode) {
        const bounds = manifestBounds();
        if (!viewer || !bounds) return;
        const corners = [
            Cesium.Cartesian3.fromDegrees(bounds.west, bounds.south),
            Cesium.Cartesian3.fromDegrees(bounds.east, bounds.south),
            Cesium.Cartesian3.fromDegrees(bounds.east, bounds.north),
            Cesium.Cartesian3.fromDegrees(bounds.west, bounds.north),
        ];
        const sphere = Cesium.BoundingSphere.fromPoints(corners);
        const presets = {
            overview: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(25), Cesium.Math.toRadians(-58), Math.max(1000, sphere.radius * 2.8)),
            oblique: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(35), Cesium.Math.toRadians(-32), Math.max(350, sphere.radius * 1.55)),
            top: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-89), Math.max(350, sphere.radius * 1.45)),
        };
        const offset = presets[mode] || presets.overview;
        if (pivotCartesian && mode !== 'overview') {
            viewer.camera.lookAt(pivotCartesian, offset);
            viewer.scene.requestRender();
            return;
        }
        viewer.camera.flyToBoundingSphere(sphere, { offset, duration: 0.7 });
    }

    function clearTrace() {
        traceEntityIds.forEach(id => { try { viewer?.entities.removeById(id); } catch (_) {} });
        traceEntityIds = [];
    }

    function pivotStorageKey() {
        return simId ? `optim-analyzer:rf-3d-pivot:${simId}` : null;
    }

    function pivotStatus(text) {
        $('hud-pivot-status').textContent = text;
    }

    function updatePivotMode() {
        const button = $('hud-pivot');
        button.classList.toggle('is-active', pivotMode);
        button.textContent = pivotMode ? '✛ Cliquez la carte' : '📍 Poser pivot';
        button.setAttribute('aria-pressed', String(pivotMode));
        viewer?.scene.requestRender();
    }

    function cameraAroundPivot() {
        if (!viewer || !pivotCartesian) return;
        // Cesium's lookAt establishes an ENU reference frame at the clicked
        // point. Subsequent drag rotation then orbits this reference frame,
        // rather than an implicit centre of the globe or RF AOI.
        const range = Math.max(25, Cesium.Cartesian3.distance(viewer.camera.positionWC, pivotCartesian));
        const heading = viewer.camera.heading;
        const pitch = Cesium.Math.clamp(viewer.camera.pitch, Cesium.Math.toRadians(-89), Cesium.Math.toRadians(-4));
        viewer.camera.lookAt(pivotCartesian, new Cesium.HeadingPitchRange(heading, pitch, range));
        viewer.scene.requestRender();
    }

    function setPivot(clicked, persist = true) {
        if (!viewer || !clicked?.cartesian) return;
        if (pivotEntity) viewer.entities.remove(pivotEntity);
        pivotCartesian = Cesium.Cartesian3.clone(clicked.cartesian);
        pivotEntity = viewer.entities.add({
            position: pivotCartesian,
            point: { pixelSize: 13, color: cssColor('#f59e0b'), outlineColor: Cesium.Color.WHITE, outlineWidth: 2.5 },
            label: {
                text: 'Pivot caméra', font: '700 12px system-ui', fillColor: Cesium.Color.WHITE,
                showBackground: true, backgroundColor: cssColor('#071323', 0.88),
                backgroundPadding: new Cesium.Cartesian2(7, 4), pixelOffset: new Cesium.Cartesian2(0, -23),
                distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 12000),
            },
            properties: { type: 'Pivot caméra RF 3D' },
        });
        if (persist) {
            try {
                localStorage.setItem(pivotStorageKey(), JSON.stringify({
                    lon: clicked.longitudeDegrees, lat: clicked.latitudeDegrees, height: Math.max(0, Number(clicked.height) || 0),
                }));
            } catch (_) {}
        }
        pivotMode = false;
        updatePivotMode();
        $('hud-clear-pivot').hidden = false;
        pivotStatus(`Pivot : ${clicked.latitudeDegrees.toFixed(5)}, ${clicked.longitudeDegrees.toFixed(5)}`);
        cameraAroundPivot();
    }

    function clearPivot() {
        if (!viewer) return;
        // Keep the exact world camera pose while returning to Cesium's normal
        // globe reference frame.
        const position = Cesium.Cartesian3.clone(viewer.camera.positionWC);
        const direction = Cesium.Cartesian3.clone(viewer.camera.directionWC);
        const up = Cesium.Cartesian3.clone(viewer.camera.upWC);
        if (pivotEntity) viewer.entities.remove(pivotEntity);
        pivotEntity = null;
        pivotCartesian = null;
        pivotMode = false;
        viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        viewer.camera.setView({ destination: position, orientation: { direction, up } });
        try { localStorage.removeItem(pivotStorageKey()); } catch (_) {}
        $('hud-clear-pivot').hidden = true;
        pivotStatus('Pivot : automatique');
        updatePivotMode();
    }

    function restorePivot() {
        try {
            const saved = JSON.parse(localStorage.getItem(pivotStorageKey()) || 'null');
            if (!saved || !Number.isFinite(Number(saved.lon)) || !Number.isFinite(Number(saved.lat))) return;
            const cartesian = Cesium.Cartesian3.fromDegrees(Number(saved.lon), Number(saved.lat), Math.max(0, Number(saved.height) || 0));
            setPivot({ cartesian, longitudeDegrees: Number(saved.lon), latitudeDegrees: Number(saved.lat), height: Number(saved.height) || 0 }, false);
        } catch (_) {}
    }

    function mapPoint(movement) {
        if (!viewer) return null;
        let cartesian = null;
        try {
            if (viewer.scene.pickPositionSupported) cartesian = viewer.scene.pickPosition(movement.position);
        } catch (_) {}
        if (!cartesian) {
            const ray = viewer.camera.getPickRay(movement.position);
            if (ray) cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        }
        if (!cartesian) cartesian = viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
        if (!cartesian) return null;
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        return {
            cartesian,
            longitudeDegrees: Cesium.Math.toDegrees(carto.longitude),
            latitudeDegrees: Cesium.Math.toDegrees(carto.latitude),
            height: carto.height,
        };
    }

    function activeMetric() {
        const baseMetric = $('hud-metric').value;
        const band = (currentManifest?.bands || []).find(item => item.band === $('hud-band').value);
        if (!band || baseMetric === 'margin') return baseMetric;
        return baseMetric === 'best_server' && band.bestServerMetric ? band.bestServerMetric : band.metric;
    }

    async function runParityCheck() {
        if (!currentManifest || !$('hud-parity')) return;
        const active = activeMetric();
        const isRsrpMetric = active === 'rsrp' || (currentManifest.bands || []).some(item => item.metric === active);
        const metric = isRsrpMetric ? active : 'rsrp';
        const button = $('hud-parity');
        button.disabled = true;
        $('hud-parity-status').textContent = `Parité : vérification de ${metric === 'rsrp' ? 'RSRP composite' : metric}…`;
        try {
            const report = await window.rf3dApi.parity(currentManifest.id, metric, 25);
            const maxDelta = Number(report?.rsrp?.maxAbsoluteDeltaDb || 0).toFixed(3);
            const winnerText = report?.bestServer?.checked
                ? ` · serveur ${report.bestServer.mismatches ? 'écart' : 'identique'}` : '';
            $('hud-parity-status').textContent = report?.status === 'passed'
                ? `Parité : conforme · ${report.samplesChecked} pixels · Δ max ${maxDelta} dB${winnerText}`
                : `Parité : écart détecté · ${report?.rsrp?.mismatches || 0} RSRP · ${report?.bestServer?.mismatches || 0} serveurs`;
        } catch (error) {
            $('hud-parity-status').textContent = `Parité : impossible — ${error.message}`;
        } finally {
            button.disabled = false;
        }
    }

    function rsrpColor(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return '#e2e8f0';
        const classes = currentManifest?.style?.classes || window.rf3dLayers.RF_CLASSES;
        const item = classes.find(entry => number >= Number(entry.min));
        return item?.color || classes.at(-1)?.color || '#dc2626';
    }

    function showPixelCard(point, clicked) {
        const winner = point.winningSector || point.winner || {};
        const rsrp = point.rsrp ?? point.value;
        $('pixel-card').innerHTML = `
            <h3>${winner.cell || 'Pixel RF'} <small>${winner.site ? `· ${winner.site}` : ''}</small></h3>
            <div class="rsrp-big" style="color:${rsrpColor(rsrp)}">${Number.isFinite(Number(rsrp)) ? `${Number(rsrp).toFixed(1)} dBm` : 'N/D'}</div>
            <div class="kpi"><small>Bande</small><b>${winner.band || '—'}</b></div>
            <div class="kpi"><small>Distance</small><b>${point.distanceM != null ? `${Math.round(point.distanceM).toLocaleString('fr-FR')} m` : '—'}</b></div>
            <div class="kpi"><small>Source</small><b>Raster RF canonique</b></div>
            <button id="pc-close">Fermer</button>`;
        $('pixel-card').hidden = false;
        $('pc-close').onclick = () => { $('pixel-card').hidden = true; clearTrace(); };

        clearTrace();
        // Prefer the exact transmitter snapshot in the canonical manifest.
        // The legacy identify endpoint may expose a short display endpoint
        // (useful in 2D); a 3D trace must end at the actual antenna position.
        const manifestTx = (currentManifest?.transmitters || []).find(tx =>
            (winner.id && tx.id === winner.id) || (winner.cell && tx.cell === winner.cell));
        const tip = manifestTx || point.servingSectorLineEnd || (winner.lat != null ? winner : null);
        if (!clicked || !tip || !Number.isFinite(Number(tip.lat)) || !Number.isFinite(Number(tip.lon))) return;
        const agl = Math.max(3, Number(tip.heightM ?? tip.antennaHeightAglM ?? winner.antennaHeightAglM ?? 25));
        const sectorHeight = transmitterGroundHeight(tip) + agl;
        traceEntityIds.push(viewer.entities.add({
            polyline: {
                positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                    Number(tip.lon), Number(tip.lat), sectorHeight,
                    clicked.longitudeDegrees, clicked.latitudeDegrees, Math.max(0, clicked.height),
                ]),
                width: 2, material: new Cesium.PolylineDashMaterialProperty({ color: cssColor('#38bdf8'), dashLength: 12 }),
            },
        }).id);
        traceEntityIds.push(viewer.entities.add({
            position: clicked.cartesian,
            point: { pixelSize: 9, color: Cesium.Color.WHITE, outlineColor: cssColor('#f59e0b'), outlineWidth: 3 },
        }).id);
    }

    async function onLeftClick(movement) {
        if (!viewer || !currentManifest) return;
        if (buildingLabelEditMode) {
            const picked = viewer.scene.pick(movement.position);
            if (selectBuildingForLabel(picked?.id)) return;
            return;
        }
        if (freeLabelMode) {
            const clicked = mapPoint(movement);
            if (clicked) addFreeLabelAt(clicked);
            return;
        }
        const picked = viewer.scene.pick(movement.position);
        if (selectFreeLabel(picked?.id)) return;
        const clicked = mapPoint(movement);
        if (!clicked) return;
        if (subZoneMode) {
            subZoneVertices.push(clicked);
            renderSubZone();
            updateSubZoneControls();
            previewSubZoneBuildings();
            return;
        }
        if (pivotMode) {
            setPivot(clicked);
            return;
        }
        try {
            const point = await window.rf3dApi.identify(currentManifest.id, clicked.latitudeDegrees, clicked.longitudeDegrees, activeMetric());
            showPixelCard(point, clicked);
        } catch (error) {
            $('pixel-card').hidden = false;
            $('pixel-card').innerHTML = `<h3>Pixel hors résultat</h3><div class="muted">${error.message}</div><button id="pc-close">Fermer</button>`;
            $('pc-close').onclick = () => { $('pixel-card').hidden = true; clearTrace(); };
        }
    }

    function populateBands() {
        const select = $('hud-band');
        const oldValue = select.value;
        select.innerHTML = '<option value="">Composite</option>';
        (currentManifest?.bands || []).forEach(item => {
            const option = document.createElement('option');
            option.value = item.band;
            option.textContent = `${item.band} · ${item.sectorCount} secteur${item.sectorCount > 1 ? 's' : ''}`;
            select.appendChild(option);
        });
        select.value = [...select.options].some(option => option.value === oldValue) ? oldValue : '';
    }

    async function setMetric() {
        if (!viewer || !currentManifest) return;
        if ($('hud-metric').value === 'margin' && $('hud-band').value) $('hud-band').value = '';
        const metric = activeMetric();
        const opacity = Number($('hud-opacity').value);
        const requestVersion = ++surfaceLoadVersion;
        if (rfLayer) { try { viewer.imageryLayers.remove(rfLayer, true); } catch (_) {} }
        rfLayer = null;
        removeSurface();
        window.rf3dLayers.renderLegend($('legend'), metric, currentManifest.style);
        // One immutable, full-resolution RF image is draped by Cesium on the
        // same terrain that anchors sites and buildings. This removes the
        // competing mesh which produced white slivers at oblique angles.
        if (requestVersion !== surfaceLoadVersion || !viewer) return;
        const bounds = manifestBounds();
        if (!bounds) throw new Error('Emprise RF introuvable.');
        rfLayer = window.rf3dLayers.rfDrapeLayer(
            window.rf3dApi.surfaceTextureUrl(currentManifest.id, metric, 512, currentManifest.styleRevision || 0), opacity, bounds);
        viewer.imageryLayers.add(rfLayer);
        setSurfaceVisibility(true);
    }

    async function refreshManifest() {
        const updated = await window.rf3dApi.manifest(simId);
        const changed = !currentManifest || updated.styleRevision !== currentManifest.styleRevision
            || JSON.stringify(updated.bands) !== JSON.stringify(currentManifest.bands);
        currentManifest = updated;
        window.currentRf3dManifest = updated;
        configureBuildingControl();
        if (changed) {
            populateBands();
            await setMetric();
        }
    }

    function dispose() {
        clearTimeout(resolutionRestoreTimer);
        resolutionRestoreTimer = null;
        clearTimeout(buildingsReloadTimer);
        buildingsReloadTimer = null;
        stopPresentationTour(false);
        clearTrace();
        removeSurface();
        buildingEntities = removeEntities(buildingEntities);
        clearBuildingTileCache();
        clearBuildingLabels();
        clearFreeLabels();
        clearPlaces();
        clearSiteSightLine();
        if (subZoneEntity) viewer?.entities.remove(subZoneEntity);
        subZoneVertexEntities = removeEntities(subZoneVertexEntities);
        window.removeEventListener('keydown', onKeyDown);
        const dragHandle = $('hud-drag-handle');
        dragHandle?.removeEventListener('pointerdown', onHudPointerDown);
        dragHandle?.removeEventListener('pointermove', onHudPointerMove);
        dragHandle?.removeEventListener('pointerup', onHudPointerUp);
        dragHandle?.removeEventListener('pointercancel', onHudPointerUp);
        if (clickHandler && !clickHandler.isDestroyed()) clickHandler.destroy();
        clickHandler = null;
        if (viewer && !viewer.isDestroyed()) viewer.destroy();
        viewer = null;
        osmBuildingTileset = null;
    }

    async function init() {
        if (typeof Cesium === 'undefined') return bootError('CesiumJS est introuvable sous /vendor/cesium/.');
        if (!simId) return bootError('Paramètre manquant : ouvrez la vue depuis une simulation RF terminée.');
        viewer = new Cesium.Viewer('globeContainer', {
            imageryProvider: false, baseLayerPicker: false, geocoder: false, homeButton: false,
            sceneModePicker: true, navigationHelpButton: false, fullscreenButton: false,
            animation: false, timeline: false, infoBox: false, selectionIndicator: false,
            terrainProvider: new Cesium.EllipsoidTerrainProvider(),
            msaaSamples: 4,
        });
        configureAdaptiveHdRendering();
        viewer.scene.fxaa = true;
        viewer.shadows = true;
        viewer.scene.shadowMap.softShadows = true;
        viewer.scene.shadowMap.maximumDistance = 1800;
        viewer.scene.globe.tileCacheSize = 512;
        viewer.scene.globe.baseColor = cssColor('#0a1a2e');
        setBaseMap('sat').catch(() => {});
        try {
            currentManifest = await window.rf3dApi.manifest(simId);
        } catch (error) {
            return bootError(`Simulation introuvable : ${error.message}`);
        }
        if (currentManifest.status !== 'ready') return bootError(`Cette simulation est en état « ${currentManifest.status} ».`);
        if (String(currentManifest.scenarioType || '').toLowerCase().includes('indoor')) {
            return bootError('La visualisation 3D Indoor sera ajoutée avec ses plans par étage. Cette vue couvre actuellement les simulations outdoor.');
        }
        window.currentRf3dManifest = currentManifest;
        restoreBuildingLabelOverrides();
        restoreFreeLabels();
        restorePresentationViews();
        loadSceneDiagnostics().catch(() => {});
        await setBaseMap($('hud-base').value, true);
        restoreHudState();
        $('hud-sim-name').textContent = currentManifest.name || currentManifest.id;
        updatePresentationCaption();
        populateBands();
        configureBuildingControl(false);
        const hasLocalTerrain = attachLocalTerrain();
        $('hud-surface-status').textContent = hasLocalTerrain ? 'Surface : DTM local' : 'Surface : globe de secours';
        addSectors();
        populateSites();
        applySectorVisibility();
        renderFreeLabels();
        await setMetric();
        focusOnManifest();
        // Let the initial AOI fly-to finish before turning the persisted point
        // into the camera reference frame; otherwise it would inherit Cesium's
        // temporary globe-wide start position as its orbit range.
        window.setTimeout(() => { if (!pivotCartesian) restorePivot(); }, 1750);
        // OSM is the visual default for every new RF 3D opening.  GeoData
        // remains one explicit selection away for RF/engineering inspection.
        if ($('hud-building-source')) $('hud-building-source').value = 'osm';
        window.setTimeout(() => { setBuildingSource().catch(() => {}); }, 500);

        $('hud-metric').onchange = () => { setMetric().catch(() => {}); };
        $('hud-band').onchange = () => { setMetric().catch(() => {}); };
        $('hud-view').onchange = () => applyCameraPreset($('hud-view').value);
        $('hud-opacity').oninput = () => { setSurfaceOpacity(Number($('hud-opacity').value)); };
        $('hud-simulation').onchange = () => setSurfaceVisibility(true);
        $('hud-parity').onclick = () => { runParityCheck().catch(() => {}); };
        $('hud-presentation').onclick = () => setPresentationMode(!presentationMode);
        $('presentation-exit').onclick = () => setPresentationMode(false);
        $('hud-fullscreen').onclick = () => { toggleFullscreen().catch(() => {}); };
        $('hud-snapshot').onclick = exportPresentationPng;
        $('hud-view-save').onclick = savePresentationView;
        $('hud-view-load').onclick = loadPresentationView;
        $('hud-tour').onclick = startPresentationTour;
        $('hud-sectors').onchange = applySectorVisibility;
        $('hud-patterns').onchange = applySectorVisibility;
        $('hud-buildings').onchange = () => {
            if ($('hud-building-source')?.value !== 'local') return;
            if ($('hud-buildings').checked) loadBuildings(subZoneGeoJson() || subZoneGeometry);
            else {
                clearDisplayedBuildings('Bâtiments : masqués');
            }
        };
        $('hud-building-source').onchange = () => { setBuildingSource().catch(() => {}); };
        $('hud-building-style').onchange = () => {
            clearBuildingTileCache();
            if ($('hud-buildings').checked) loadBuildings(subZoneGeoJson() || subZoneGeometry);
        };
        $('hud-building-shadows').onchange = () => {
            if ($('hud-building-source')?.value === 'osm') {
                if (osmBuildingTileset) {
                    osmBuildingTileset.shadows = $('hud-building-shadows').checked
                        ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
                    viewer?.scene.requestRender();
                }
                return;
            }
            clearBuildingTileCache();
            if ($('hud-buildings').checked) loadBuildings(subZoneGeoJson() || subZoneGeometry);
        };
        $('hud-building-labels').onchange = renderBuildingLabels;
        $('hud-building-label-edit').onclick = () => setBuildingLabelEditMode(!buildingLabelEditMode);
        $('hud-building-label-apply').onclick = applyBuildingLabelEditor;
        $('hud-building-label-reset').onclick = resetBuildingLabelEditor;
        $('hud-free-labels').onchange = renderFreeLabels;
        $('hud-places').onchange = () => {
            if ($('hud-places').checked) loadPlaces(true);
            else clearPlaces();
        };
        $('hud-place-filter').onchange = renderPlaces;
        $('hud-free-label-add').onclick = () => setFreeLabelMode(!freeLabelMode);
        $('hud-free-label-apply').onclick = applyFreeLabelEditor;
        $('hud-free-label-delete').onclick = deleteFreeLabel;
        $('hud-zone-label').onchange = () => {
            if (subZoneEntity?.label) subZoneEntity.label.show = $('hud-zone-label').checked;
            viewer?.scene.requestRender();
        };
        $('hud-zone').onclick = beginSubZone;
        $('hud-zone-save').onclick = () => { saveSubZone().catch(() => {}); };
        $('hud-zone-clear').onclick = clearSubZone;
        $('hud-site').onchange = () => { $('hud-site-view').disabled = !$('hud-site').value; };
        $('hud-site-view').onclick = cameraAtSelectedSite;
        $('hud-site-return').onclick = returnFromSiteView;
        $('site-camera-apply').onclick = applyManualSiteView;
        $('site-camera-azimuth').onchange = applyManualSiteView;
        $('site-camera-tilt').onchange = applyManualSiteView;
        $('hud-collapse').onclick = () => setHudCollapsed(!$('hud-top').classList.contains('is-collapsed'));
        const dragHandle = $('hud-drag-handle');
        dragHandle.addEventListener('pointerdown', onHudPointerDown);
        dragHandle.addEventListener('pointermove', onHudPointerMove);
        dragHandle.addEventListener('pointerup', onHudPointerUp);
        dragHandle.addEventListener('pointercancel', onHudPointerUp);
        $('hud-pivot').onclick = () => {
            pivotMode = !pivotMode;
            updatePivotMode();
            pivotStatus(pivotMode ? 'Pivot : cliquez un point sur la carte' : (pivotCartesian ? 'Pivot : actif' : 'Pivot : automatique'));
        };
        $('hud-clear-pivot').onclick = clearPivot;
        viewer.camera.moveStart.addEventListener(beginAdaptiveCameraRendering);
        viewer.camera.moveEnd.addEventListener(() => {
            restoreAdaptiveHdRendering();
            keepCameraAboveTerrain();
            if (siteViewAnchor) updateSiteSightLine();
            if (!subZoneGeometry && !subZoneMode && !siteViewAnchor) queueVisibleBuildingsReload();
            queuePlacesReload();
        });
        $('hud-base').onchange = () => { setBaseMap($('hud-base').value, true).catch(() => {}); };
        $('hud-close').onclick = () => { dispose(); window.close(); if (!window.closed) history.back(); };
        clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        clickHandler.setInputAction(onLeftClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('focus', () => refreshManifest().catch(() => {}));
        window.addEventListener('pagehide', dispose, { once: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
