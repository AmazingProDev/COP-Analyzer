/** Minimal client for the local RF backend (FastAPI :8001), same LOS_BASE convention as rf_api.js. */
(function () {
    'use strict';
    const base = () => window.LOS_BASE || `${location.protocol}//${location.hostname}:8001`;

    async function request(path, options = {}) {
        const res = await fetch(`${base()}${path}`, options);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.detail || `${res.status} ${res.statusText}`);
        }
        return res.json();
    }

    window.rf3dApi = {
        base,
        esriBaseTileUrl: () => `${base()}/api/rf/basemap/esri/{z}/{y}/{x}`,
        esriAoiImageUrl: (id, maxPixels = 2048, bounds = null) => {
            const params = new URLSearchParams({ maxPixels: String(maxPixels) });
            if (bounds) ['west', 'south', 'east', 'north'].forEach(key => params.set(key, String(bounds[key])));
            return `${base()}/api/rf/simulations/${encodeURIComponent(id)}/basemap-3d.jpg?${params}`;
        },
        esriAoiImageMetadata: (id, maxPixels = 2048, bounds = null) => {
            const params = new URLSearchParams({ maxPixels: String(maxPixels) });
            if (bounds) ['west', 'south', 'east', 'north'].forEach(key => params.set(key, String(bounds[key])));
            return request(`/api/rf/simulations/${encodeURIComponent(id)}/basemap-3d.json?${params}`);
        },
        simulation: id => request(`/api/rf/simulations/${encodeURIComponent(id)}`),
        manifest: id => request(`/api/rf/simulations/${encodeURIComponent(id)}/manifest-3d`),
        parity: (id, metric = 'rsrp', samples = 25) =>
            request(`/api/rf/simulations/${encodeURIComponent(id)}/parity-3d?metric=${encodeURIComponent(metric)}&samples=${encodeURIComponent(samples)}`),
        sceneDiagnostics: id => request(`/api/rf/simulations/${encodeURIComponent(id)}/scene-3d-diagnostics`),
        surface: (id, metric = 'rsrp', maxVertices = 160) =>
            request(`/api/rf/simulations/${encodeURIComponent(id)}/surface-3d?metric=${encodeURIComponent(metric)}&maxVertices=${encodeURIComponent(maxVertices)}`),
        surfaceTextureUrl: (id, metric = 'rsrp', maxVertices = 160, revision = 0) =>
            `${base()}/api/rf/simulations/${encodeURIComponent(id)}/surface-3d.png?metric=${encodeURIComponent(metric)}&maxVertices=${encodeURIComponent(maxVertices)}&styleRevision=${encodeURIComponent(revision)}`,
        terrain: (id, bounds, size = 65) => {
            const params = new URLSearchParams({ size: String(size) });
            ['west', 'south', 'east', 'north'].forEach(key => params.set(key, String(bounds[key])));
            return request(`/api/rf/simulations/${encodeURIComponent(id)}/terrain-3d?${params}`);
        },
        buildings: (id, limit = 800, bounds = null) => {
            const params = new URLSearchParams({ limit: String(limit) });
            if (bounds && Number.isFinite(bounds.west) && Number.isFinite(bounds.south) && Number.isFinite(bounds.east) && Number.isFinite(bounds.north)) {
                params.set('west', String(bounds.west)); params.set('south', String(bounds.south));
                params.set('east', String(bounds.east)); params.set('north', String(bounds.north));
            }
            return request(`/api/rf/simulations/${encodeURIComponent(id)}/buildings-3d?${params}`);
        },
        buildingsInZone: (id, geometry, limit = 5000, bounds = null) => request(
            `/api/rf/simulations/${encodeURIComponent(id)}/buildings-3d/query`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                geometry, limit,
                bounds: bounds ? [bounds.west, bounds.south, bounds.east, bounds.north] : null,
            }) },
        ),
        places: (id, bounds = null) => {
            const params = new URLSearchParams();
            if (bounds && Number.isFinite(bounds.west) && Number.isFinite(bounds.south)
                && Number.isFinite(bounds.east) && Number.isFinite(bounds.north)) {
                params.set('west', String(bounds.west)); params.set('south', String(bounds.south));
                params.set('east', String(bounds.east)); params.set('north', String(bounds.north));
            }
            return request(`/api/rf/simulations/${encodeURIComponent(id)}/places-3d${params.size ? `?${params}` : ''}`);
        },
        identify: (id, lat, lon, metric = 'rsrp') =>
            request(`/api/rf/simulations/${encodeURIComponent(id)}/identify?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&metric=${encodeURIComponent(metric)}`),
        tileUrl: (id, metric = 'rsrp', revision = 0) =>
            `${base()}/api/rf/simulations/${encodeURIComponent(id)}/tiles/${encodeURIComponent(metric)}/{z}/{x}/{y}.png?render=3d&styleRevision=${encodeURIComponent(revision)}`,
    };
})();
