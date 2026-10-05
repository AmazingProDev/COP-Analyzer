/** Lightweight client for the local RF Coverage service (FastAPI / port 8001). */
(function () {
    'use strict';
    const base = () => window.LOS_BASE || `${location.protocol}//${location.hostname}:8001`;
    async function request(path, options = {}) {
        const res = await fetch(`${base()}${path}`, options);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.detail || `${res.status} ${res.statusText}`);
        }
        return res.status === 204 ? null : res.json();
    }
    const post = (path, data) => request(path, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
    window.rfApi = {
        health: () => request('/api/rf/health'),
        catalog: () => request('/api/rf/geodata/catalog'),
        indoorBuildings: (datasetId, bounds, q = '', limit = 250) => request(`/api/rf/indoor/buildings?${new URLSearchParams({datasetId, west:bounds.west, south:bounds.south, east:bounds.east, north:bounds.north, q, limit})}`),
        indoorBuildingsAudit: datasetId => request(`/api/rf/indoor/buildings/audit?${new URLSearchParams({datasetId})}`),
        indoorBuildingAt: (datasetId, lat, lon) => request(`/api/rf/indoor/buildings/at?${new URLSearchParams({datasetId, lat, lon})}`),
        indoorBuilding: id => request(`/api/rf/indoor/buildings/${encodeURIComponent(id)}`),
        updateIndoorBuilding: (id, data) => request(`/api/rf/indoor/buildings/${encodeURIComponent(id)}/override`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)}),
        moroccoPackStatus: () => request('/api/los/geodata/morocco-pack/status'),
        prepareMoroccoPack: data => post('/api/los/geodata/morocco-pack/prepare', data),
        prepareMoroccoProvince: data => post('/api/los/geodata/morocco-pack/prepare-province', data),
        repairMoroccoPack: name => post('/api/los/geodata/morocco-pack/repair', {name}),
        sectors: (q = '', filters = {}, limit = 30) => request(`/api/rf/sectors?q=${encodeURIComponent(q)}&${new URLSearchParams({...filters, limit})}`),
        bands: () => request('/api/rf/bands'),
        antennaPatterns: () => request('/api/rf/antenna-patterns'),
        importAntennaPattern: data => post('/api/rf/antenna-patterns', data),
        msiLibrary: () => request('/api/rf/msi-library'),
        msiModels: () => request('/api/rf/msi-library/models'),
        msiPattern: (id, frequencyMHz, electricalTiltDeg, polarization) => request(`/api/rf/msi-library/pattern?id=${encodeURIComponent(id)}${frequencyMHz != null ? `&frequencyMHz=${Number(frequencyMHz)}` : ''}${electricalTiltDeg != null ? `&electricalTiltDeg=${Number(electricalTiltDeg)}` : ''}${polarization ? `&polarization=${encodeURIComponent(polarization)}` : ''}`),
        rescanMsiLibrary: () => post('/api/rf/msi-library/rescan', {}),
        calibrationSources: () => request('/api/rf/calibration/sources'),
        calibrationProfiles: () => request('/api/rf/calibration/profiles'),
        createCalibrationProfile: data => post('/api/rf/calibration/profiles', data),
        scanCarrierCalibrationFolder: folderPath => post('/api/rf/calibration/local/scan', {folderPath}),
        importCarrierCalibrationDataset: data => post('/api/rf/calibration/datasets', data),
        carrierCalibrationDatasets: () => request('/api/rf/calibration/datasets'),
        carrierCalibrationDataset: id => request(`/api/rf/calibration/datasets/${encodeURIComponent(id)}`),
        carrierCalibrationExcluded: (id, reason = '', limit = 500) => request(`/api/rf/calibration/datasets/${encodeURIComponent(id)}/excluded?reason=${encodeURIComponent(reason)}&limit=${encodeURIComponent(limit)}`),
        createCarrierCalibrationJob: data => post('/api/rf/calibration/jobs', data),
        carrierCalibrationJob: id => request(`/api/rf/calibration/jobs/${encodeURIComponent(id)}`),
        cancelCarrierCalibrationJob: id => post(`/api/rf/calibration/jobs/${encodeURIComponent(id)}/cancel`, {}),
        carrierCalibrationRun: id => request(`/api/rf/calibration/runs/${encodeURIComponent(id)}`),
        carrierCalibrationResiduals: id => request(`/api/rf/calibration/runs/${encodeURIComponent(id)}/residuals`),
        createCarrierCalibrationProfile: (runId, name) => post(`/api/rf/calibration/runs/${encodeURIComponent(runId)}/profiles`, {name}),
        setCarrierCalibrationProfile: (id, data) => request(`/api/rf/calibration/carrier-profiles/${encodeURIComponent(id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)}),
        compatibleCalibrationProfiles: params => request(`/api/rf/calibration/compatible-profiles?${new URLSearchParams(params || {})}`),
        adminAreas: (level, q = '', limit = 50) => request(`/api/rf/admin/areas?level=${encodeURIComponent(level)}&q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`),
        adminAreaSectors: (level, areaId, bands = []) => request(`/api/rf/admin/areas/${encodeURIComponent(level)}/${encodeURIComponent(areaId)}/sectors?bands=${encodeURIComponent((bands || []).join(','))}`),
        siteGroups: (q = '', filters = {}, limit = 30) => request(`/api/rf/site-groups?q=${encodeURIComponent(q)}&${new URLSearchParams({...filters, limit})}`),
        recommendation: data => post('/api/rf/recommendation', data),
        preflight: data => post('/api/rf/preflight', data),
        create: data => post('/api/rf/simulations', data),
        get: id => request(`/api/rf/simulations/${encodeURIComponent(id)}`),
        list: () => request('/api/rf/simulations'),
        cancel: id => post(`/api/rf/simulations/${encodeURIComponent(id)}/cancel`, {}),
        remove: id => request(`/api/rf/simulations/${encodeURIComponent(id)}`, {method:'DELETE'}),
        rename: (id, name) => request(`/api/rf/simulations/${encodeURIComponent(id)}/name`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})}),
        clone: (id, data = {}) => post(`/api/rf/simulations/${encodeURIComponent(id)}/clone`, data),
        statistics: id => request(`/api/rf/simulations/${encodeURIComponent(id)}/statistics`),
        validate: (id, data) => post(`/api/rf/simulations/${encodeURIComponent(id)}/validate`, data),
        validationPoints: (id, runId) => request(`/api/rf/simulations/${encodeURIComponent(id)}/validation/${encodeURIComponent(runId)}/points`),
        style: (id, style) => request(`/api/rf/simulations/${encodeURIComponent(id)}/style`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({style})}),
        // Render generation is part of the URL so a server-side style/renderer
        // fix cannot be hidden by the browser's one-hour raster tile cache.
        tileUrl: (id, metric = 'rsrp', options = {}) => `${base()}/api/rf/simulations/${encodeURIComponent(id)}/tiles/${metric}/{z}/{x}/{y}.png?${new URLSearchParams({render:'v5', ...(options.floor ? {floor:options.floor} : {}), ...(options.band ? {band:options.band} : {})})}`,
        identify: (id, lat, lon, metric = 'rsrp', options = {}) => request(`/api/rf/simulations/${encodeURIComponent(id)}/identify?${new URLSearchParams({lat, lon, metric, ...(options.floor ? {floor:options.floor} : {}), ...(options.band ? {band:options.band} : {})})}`),
        exportUrl: (id, format = 'json', options = {}) => `${base()}/api/rf/simulations/${encodeURIComponent(id)}/export?${new URLSearchParams({format, ...(options.floor ? {floor:options.floor} : {}), ...(options.band ? {band:options.band} : {})})}`,
    };
})();
