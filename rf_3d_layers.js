/** Base maps and the canonical RF raster layer.
 *  The local palette is only a safe fallback for an unavailable manifest;
 *  normal 3D legends use the style returned by rf_service.py. */
(function () {
    'use strict';

    const RF_CLASSES = [
        { min: -80, color: '#16a34a', label: 'Excellent (≥ -80 dBm)' },
        { min: -90, color: '#84cc16', label: 'Bon (-90 à -80 dBm)' },
        { min: -100, color: '#eab308', label: 'Acceptable (-100 à -90 dBm)' },
        { min: -110, color: '#f97316', label: 'Faible (-110 à -100 dBm)' },
        { min: -140, color: '#dc2626', label: 'Très faible (< -110 dBm)' },
    ];
    // Operator colours follow the fixed project convention IAM → Orange → INWI.
    const OPERATOR_COLORS = { IAM: '#2563eb', ORANGE: '#f97316', INWI: '#7c3aed' };

    function baseProvider(kind, localEsriUrl = null) {
        if (kind === 'sat') {
            return new Cesium.UrlTemplateImageryProvider({
                url: localEsriUrl || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                credit: 'Esri, Maxar, Earthstar Geographics',
                maximumLevel: 19,
            });
        }
        return new Cesium.OpenStreetMapImageryProvider({
            url: 'https://tile.openstreetmap.org/',
            credit: '© OpenStreetMap contributors',
        });
    }

    function satelliteAoiProvider(imageUrl, bounds) {
        return new Cesium.SingleTileImageryProvider({
            url: imageUrl,
            rectangle: Cesium.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north),
            credit: 'Esri, Maxar, Earthstar Geographics',
        });
    }

    function rfRasterLayer(tileUrl, alpha) {
        const provider = new Cesium.UrlTemplateImageryProvider({
            url: tileUrl,
            credit: 'Optim Analyzer RF engine',
            maximumLevel: 20,
        });
        const layer = new Cesium.ImageryLayer(provider, { alpha: alpha ?? 0.72 });
        return layer;
    }

    function rfDrapeLayer(imageUrl, alpha, bounds) {
        // A completed RF study is small enough to use one immutable PNG at its
        // native raster resolution.  This avoids competing WebMercator tile
        // schemes while still letting Cesium drape the canonical values over
        // the local DTM geometry.
        const rectangle = Cesium.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north);
        const provider = new Cesium.SingleTileImageryProvider({
            url: imageUrl,
            rectangle,
            credit: 'Optim Analyzer RF engine',
        });
        return new Cesium.ImageryLayer(provider, { alpha: alpha ?? 0.72 });
    }

    function renderLegend(container, metric, style) {
        if (!container) return;
        if (metric !== 'rsrp' && !String(metric || '').startsWith('band_')) { container.hidden = true; return; }
        const classes = (style && Array.isArray(style.classes) && style.classes.length) ? style.classes : RF_CLASSES;
        container.hidden = false;
        container.innerHTML = '<b>RSRP simulé · résultat canonique</b>' + classes.map(c =>
            `<div class="row"><i class="swatch" style="background:${c.color}"></i>${c.label}</div>`).join('');
    }

    window.rf3dLayers = { RF_CLASSES, OPERATOR_COLORS, baseProvider, satelliteAoiProvider, rfRasterLayer, rfDrapeLayer, renderLegend };
})();
