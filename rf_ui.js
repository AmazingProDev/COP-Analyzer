/** RF Coverage Simulation panel — local, persistent and map-native. */
(function () {
    'use strict';
    const state = { datasets: [], selectedDataset: '', candidates: [], siteCandidates: [], transmitters: [], bandOptions: [], selectedBands: new Set(), selectedOperators: new Set(), bandSelectionInitialized: false, studyMode: 'sites', scenarioType: 'urban_sites', recommendation: null, recommendationToken: 0, territory: null, territoryCandidates: [], provinceOptions: [], territoryLayer: null, aoiPolygon: null, aoiPolygonLayer: null, aoiDrawPreview: null, aoiDrawVertices: [], aoiDrawing: false, aoiDrawHandlers: null, mapSiteCandidate: null, mapSiteResolvedGroup: null, mapSiteLookupToken: 0, mapSiteError: '', indoorBuildings: [], indoorOperator: 'IAM', indoorFloor: 1, indoorBand: '', indoorSelectionBusy: false, indoorPickMode: false, indoorBuildingPreview: null, simulation: null, layer: null, visibleLayers: new Map(), winnerLine: null, winnerMarker: null, activeMetric: 'rsrp', busy: false, moroccoPack: null, calibrationRuns: {}, calibrationProfileOverride: false, autoCalibrationProfile: null, autoPreflightToken: 0 };
    const $ = id => document.getElementById(id);
    const esc = text => String(text == null ? '' : text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const map = () => window.mapRenderer && window.mapRenderer.map;

    function geometryBoundsWgs84(geometry) {
        const ring = geometry?.type === 'Polygon' ? geometry.coordinates?.[0] : null;
        const points = Array.isArray(ring) ? ring.filter(point => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))) : [];
        if (points.length < 3) return null;
        return [Math.min(...points.map(point => Number(point[0]))), Math.min(...points.map(point => Number(point[1]))), Math.max(...points.map(point => Number(point[0]))), Math.max(...points.map(point => Number(point[1])))];
    }

    function polygonStatus() {
        const target = $('rf-manual-aoi-status'); const draw = $('rf-aoi-draw'); const clear = $('rf-aoi-clear');
        if (!target || !draw || !clear) return;
        const territoryMode = state.studyMode === 'territory';
        draw.disabled = territoryMode;
        clear.disabled = territoryMode;
        if (territoryMode) {
            target.textContent = 'La limite administrative définit déjà la zone de calcul.';
            draw.textContent = 'Zone administrative active'; clear.hidden = true;
        } else if (state.aoiDrawing) {
            target.textContent = `${state.aoiDrawVertices.length} point(s) : cliquez sur la carte, puis double-cliquez pour fermer le polygone.`;
            draw.textContent = 'Annuler le tracé'; clear.hidden = true;
        } else if (state.aoiPolygon) {
            target.textContent = `${Math.max(0, state.aoiPolygon.geometry.coordinates[0].length - 1)} sommets — seules les zones à l’intérieur seront calculées.`;
            draw.textContent = 'Redessiner'; clear.hidden = false;
        } else {
            target.textContent = 'Optionnel : dessinez un polygone pour limiter strictement la simulation.';
            draw.textContent = 'Dessiner sur la carte'; clear.hidden = true;
        }
    }

    function renderAoiDrawing() {
        const m = map(); if (!m || !window.L) return;
        const points = state.aoiDrawVertices;
        if (state.aoiDrawPreview) { m.removeLayer(state.aoiDrawPreview); state.aoiDrawPreview = null; }
        if (!points.length) return;
        const style = {color:'#38bdf8', weight:3, opacity:.95, dashArray:'7 5', fillColor:'#0ea5e9', fillOpacity:.12, interactive:false};
        state.aoiDrawPreview = points.length >= 3 ? window.L.polygon(points, style).addTo(m) : window.L.polyline(points, style).addTo(m);
    }

    function clearAoiDrawHandlers() {
        const m = map(); const handlers = state.aoiDrawHandlers;
        if (m && handlers) {
            m.off('click', handlers.click);
            m.off('dblclick', handlers.dblclick);
            if (handlers.keydown) document.removeEventListener('keydown', handlers.keydown);
            if (handlers.doubleClickZoom && m.doubleClickZoom) m.doubleClickZoom.enable();
        }
        state.aoiDrawHandlers = null;
        state.aoiDrawing = false;
        if (m?.getContainer) m.getContainer().style.cursor = '';
    }

    function cancelAoiDrawing() {
        clearAoiDrawHandlers();
        state.aoiDrawVertices = [];
        const m = map(); if (m && state.aoiDrawPreview) m.removeLayer(state.aoiDrawPreview);
        state.aoiDrawPreview = null;
        polygonStatus();
    }

    function finalizeAoiDrawing() {
        const m = map(); const points = state.aoiDrawVertices;
        if (!m || points.length < 3 || !window.L) { cancelAoiDrawing(); return; }
        const ring = points.map(point => [Number(point.lng), Number(point.lat)]);
        ring.push([...ring[0]]);
        clearAoiDrawHandlers();
        if (state.aoiDrawPreview) m.removeLayer(state.aoiDrawPreview);
        if (state.aoiPolygonLayer) m.removeLayer(state.aoiPolygonLayer);
        state.aoiDrawPreview = null;
        state.aoiPolygon = {geometry: {type:'Polygon', coordinates:[ring]}};
        state.aoiPolygonLayer = window.L.geoJSON(state.aoiPolygon.geometry, {style:{color:'#22d3ee', weight:3, opacity:1, fillColor:'#0ea5e9', fillOpacity:.08, dashArray:'8 5'}, interactive:false}).addTo(m);
        state.aoiDrawVertices = [];
        if ($('rf-current-view')) { $('rf-current-view').checked = false; $('rf-current-view').disabled = true; }
        polygonStatus(); renderConfigSummary();
        autoConfigureStudy();
        void refreshRecommendation().then(() => automaticPreflight({announceReady:true}));
    }

    function startAoiDrawing() {
        const m = map();
        if (state.studyMode === 'territory') { updateQuickGuide('La zone est déjà définie par le territoire.'); return; }
        if (!m || !window.L) { updateQuickGuide('La carte doit être ouverte pour dessiner la zone.'); return; }
        cancelAoiDrawing();
        if (state.aoiPolygonLayer) { m.removeLayer(state.aoiPolygonLayer); state.aoiPolygonLayer = null; }
        state.aoiPolygon = null; state.aoiDrawVertices = [];
        const click = event => {
            if (!state.aoiDrawing || !event?.latlng) return;
            const last = state.aoiDrawVertices.at(-1);
            if (!last || Math.abs(last.lat - event.latlng.lat) > 1e-9 || Math.abs(last.lng - event.latlng.lng) > 1e-9) state.aoiDrawVertices.push(event.latlng);
            renderAoiDrawing(); polygonStatus();
            event.originalEvent?.preventDefault?.(); event.originalEvent?.stopPropagation?.();
        };
        const dblclick = event => { event.originalEvent?.preventDefault?.(); event.originalEvent?.stopPropagation?.(); finalizeAoiDrawing(); };
        const keydown = event => { if (event.key === 'Escape') cancelAoiDrawing(); };
        state.aoiDrawing = true;
        state.aoiDrawHandlers = {click, dblclick, keydown, doubleClickZoom: Boolean(m.doubleClickZoom?.enabled?.())};
        m.on('click', click); m.on('dblclick', dblclick); document.addEventListener('keydown', keydown);
        if (m.doubleClickZoom) m.doubleClickZoom.disable();
        m.getContainer().style.cursor = 'crosshair';
        polygonStatus(); renderConfigSummary();
    }

    function clearManualAoi() {
        cancelAoiDrawing();
        const m = map(); if (m && state.aoiPolygonLayer) m.removeLayer(state.aoiPolygonLayer);
        state.aoiPolygon = null; state.aoiPolygonLayer = null;
        if ($('rf-current-view')) $('rf-current-view').disabled = state.studyMode === 'territory';
        polygonStatus(); renderConfigSummary(); autoConfigureStudy();
        void refreshRecommendation({silent:true});
    }

    function enableCollapsibleSteps(root) {
        root.querySelectorAll('.rf-step').forEach(step => {
            const heading = step.querySelector(':scope > h3');
            // Only the numbered workflow steps are collapsible. The saved
            // simulation library remains immediately available below them.
            if (!heading || !heading.querySelector('b')) return;
            step.classList.add('rf-step-collapsible');
            heading.tabIndex = 0;
            heading.setAttribute('role', 'button');
            heading.setAttribute('aria-expanded', 'true');
            heading.title = 'Cliquer pour replier ou développer cette étape';
            const toggle = () => {
                const collapsed = step.classList.toggle('rf-step-collapsed');
                heading.setAttribute('aria-expanded', String(!collapsed));
            };
            heading.addEventListener('click', toggle);
            heading.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
            });
        });
    }

    function panel() {
        if ($('rf-panel')) return;
        const root = document.createElement('aside');
        root.id = 'rf-panel'; root.className = 'rf-panel';
        root.innerHTML = `
          <div class="rf-head"><div><span class="rf-kicker">OUTDOOR RSRP · LOCAL GEODATA</span><h2>📡 RF Simulation — Coverage</h2></div><button id="rf-close" class="rf-icon" title="Fermer">×</button></div>
          <div class="rf-quality" id="rf-engine-status">Initialisation du moteur…</div>
          <button id="rf-open-carrier-calibration" type="button" class="rf-calibration-launch">🎯 Calibration SmartCare LTE</button>
          <section class="rf-quick-start" aria-label="Choix du scénario RF"><b>Choisissez votre étude</b><div class="rf-scenario-grid"><button type="button" data-rf-scenario="urban_sites"><strong>🏙 Sites urbains</strong><small>3D local · exact · 5–10 m</small></button><button type="button" data-rf-scenario="rural_sites"><strong>🌄 Sites ruraux</strong><small>Terrain + clutter · 25–50 m</small></button><button type="button" data-rf-scenario="commune"><strong>🏘 Commune</strong><small>Hybride · tous les sites opérateur</small></button><button type="button" data-rf-scenario="province"><strong>🗺 Province</strong><small>Territorial tuilé · résolution adaptée</small></button><button type="button" data-rf-scenario="indoor_macro"><strong>🏢 Indoor</strong><small>Macro → bâtiment · par étage</small></button></div><small id="rf-quick-guide">Ajoutez les sites : Optim Analyzer choisira automatiquement les données et le calcul.</small></section>
          <section id="rf-config-summary" class="rf-config-summary"><div><b>Configuration automatique</b><span>Choisissez un scénario puis des sites ou un territoire.</span></div></section>
          <section id="rf-indoor-guide" class="rf-indoor-guide" hidden><header><div><b>🏢 Couverture intérieure</b><small id="rf-indoor-pick-hint">🎯 Mode sélection actif : cliquez dans ou près du bâtiment.</small></div><label>Opérateur<select id="rf-indoor-operator"><option>IAM</option><option>ORANGE</option><option>INWI</option></select></label></header><div class="rf-indoor-pick-actions"><button id="rf-indoor-show-nearby" type="button">⌗ Afficher les contours autour de la vue</button><button id="rf-indoor-clear-nearby" type="button" hidden>Masquer contours</button></div><small class="rf-muted">Astuce : zoomez, affichez les contours, puis cliquez directement le bâtiment voulu. Le clic à moins de 30 m choisit le bâtiment le plus proche et l’indique clairement.</small><div id="rf-indoor-buildings" class="rf-indoor-buildings"><span class="rf-muted">Aucun bâtiment sélectionné.</span></div><button id="rf-indoor-clear" type="button" hidden>Effacer la sélection</button></section>
          <section id="rf-manual-aoi" class="rf-manual-aoi"><div><b>✏️ Zone personnalisée</b><small id="rf-manual-aoi-status">Optionnel : dessinez un polygone pour limiter strictement la simulation.</small></div><div class="rf-manual-aoi-actions"><button id="rf-aoi-draw" type="button">Dessiner sur la carte</button><button id="rf-aoi-clear" type="button" hidden>Effacer</button></div></section>
          <button id="rf-advanced-toggle" type="button" class="rf-advanced-toggle" aria-expanded="false">⚙ Réglages avancés</button>
          <section class="rf-step rf-advanced-step"><h3><b>1</b> Données GeoData</h3><select id="rf-dataset"></select><div id="rf-dataset-info" class="rf-muted"></div><label>Environnement <select id="rf-environment-mode"><option value="auto">Auto — toutes les couches disponibles</option><option value="urban">Urbain — DTM + clutter + données 3D</option><option value="rural">Rural — DTM + clutter (sans bâtiments)</option><option value="hybrid">Hybride — base régionale + overlays urbains</option></select></label><div class="rf-muted">Le moteur de recommandation choisit ce réglage. Une modification manuelle est enregistrée comme override.</div><button id="rf-rural-quick" type="button" class="rf-rural-quick">🌍 Préparer le terrain rural des sites sélectionnés</button><div class="rf-muted">Crée un nouveau DTM UTM + clutter autour du groupe, sans modifier l'étude rurale existante.</div><details class="rf-pack" id="rf-pack"><summary>Options avancées — étude rurale depuis le pack Maroc</summary><div id="rf-pack-status" class="rf-muted">Vérification du pack Maroc…</div><label>Chemin local du MNT (GeoTIFF/ASC/IMG)<input id="rf-pack-dem" placeholder="/Volumes/.../Maroc_MNT_30m.tif" autocomplete="off"></label><div class="rf-grid"><label>Nom du dataset<input id="rf-pack-name" value="Morocco_Rural_Study"></label><label>Rayon à extraire (m)<input id="rf-pack-radius" type="number" min="500" max="50000" value="10000"></label></div><div class="rf-muted">Centre : secteurs sélectionnés, sinon vue actuelle. Le pack fournit le clutter ; aucun bâtiment 3D n’est inventé sans hauteur mesurée.</div><div class="rf-pack-actions"><button id="rf-pack-prepare" class="rf-pack-prepare">Préparer DTM + clutter rural</button><button id="rf-pack-repair" class="rf-pack-repair" type="button">Réparer Morocco_Rural_Study en UTM</button></div></details></section>
          <section class="rf-step"><h3><b>2</b> Émetteurs</h3><div class="rf-band-control"><div class="rf-band-control-head"><b>Bandes utilisées pour le calcul</b><button id="rf-bands-all" type="button">Toutes</button><button id="rf-bands-none" type="button">Aucune</button></div><div id="rf-band-filter" class="rf-band-filter"><span class="rf-muted">Chargement des bandes BDD…</span></div><div class="rf-muted">Seules les bandes cochées sont envoyées au précontrôle et à la simulation.</div></div><div class="rf-operator-control"><div class="rf-band-control-head"><b>Opérateurs utilisés</b><button id="rf-operators-all" type="button">Tous</button><button id="rf-operators-none" type="button">Aucun</button></div><div id="rf-operator-filter" class="rf-band-filter"><span class="rf-muted">Sélectionnez un territoire ou un site.</span></div><div class="rf-muted">Pour une province, commencez par <b>un opérateur et une bande</b>; le moteur complet calcule terrain, Fresnel et diffraction pour chaque secteur actif.</div></div><div id="rf-map-site-action" class="rf-map-site-action" hidden></div><div class="rf-search"><input id="rf-sector-search" placeholder="Cellule, site, opérateur ou bande"><button id="rf-sector-find">Rechercher / ajouter</button></div><div class="rf-muted">Chaque ajout de site conserve <b>uniquement les secteurs des bandes cochées</b>. Cliquez aussi un site sur la carte puis ajoutez-le directement ici.</div><div id="rf-sector-results" class="rf-results"></div><div id="rf-transmitters" class="rf-transmitters"></div><details class="rf-msi-library" id="rf-msi-details"><summary>Bibliothèque antennes mesurées (MSI Huawei / Nokia / Ericsson)</summary><p class="rf-muted">Motifs fabricant dédupliqués (71 000 fichiers, 58 modèles). Le modèle choisi remplace l'enveloppe exploratoire : atténuation H+V mesurée et EIRP recalculée avec le gain réel au lancement.</p><div class="rf-msi-controls"><select id="rf-msi-model"><option value="">Chargement…</option></select><button id="rf-msi-preview" type="button">Aperçu</button><button id="rf-msi-apply" type="button">Appliquer aux secteurs sélectionnés</button></div><div id="rf-msi-status" class="rf-muted"></div><div class="rf-msi-canvases"><canvas id="rf-msi-h" width="240" height="240"></canvas><canvas id="rf-msi-v" width="240" height="150"></canvas></div><div id="rf-msi-meta" class="rf-msi-meta"></div></details></section>
          <section class="rf-step"><h3><b>3</b> Système RF</h3><div class="rf-note">Pour LTE, la BDD fournit hauteur, azimut, EARFCN et <b>RS_Power</b> (décodé depuis 0,1 dBm). Le profil Kathrein 65° par défaut est appliqué à tous les secteurs LTE, y compris hors Huawei, uniquement comme hypothèse exploratoire. Lorsqu’il est rapproché sans ambiguïté, le <b>RET Huawei</b> remplace le tilt électrique BDD et affiche le numéro de série. Un MSI/ADF et les gains/pertes réellement installés restent requis pour un résultat professionnel.</div><details class="rf-propagation" id="rf-huawei-n78-aau"><summary>📶 Huawei 5G n78 — AAU 32T32R / 64T64R</summary><div class="rf-note">Template de planification uniquement : il cible les secteurs NR n78 actifs et renseigne une enveloppe d’antenne, l’EIRP SSB/SS-RS et le tilt choisis ci-dessous. Les valeurs proposées sont des hypothèses modifiables, pas des paramètres Huawei ni une validation de couverture.</div><label>Template AAU<select id="rf-huawei-aau-model"><option value="32T32R">Huawei AAU 32T32R — hypothèse n78</option><option value="64T64R">Huawei AAU 64T64R — hypothèse n78</option></select></label><div class="rf-grid"><label>EIRP SSB/SS-RS (dBm)<input id="rf-huawei-aau-eirp" type="number" min="30" max="90" step=".1" value="55"></label><label>Tilt électrique (°)<input id="rf-huawei-aau-tilt" type="number" min="0" max="20" step=".1" value="6"></label></div><div class="rf-grid"><label>HPBW horizontal (°)<input id="rf-huawei-aau-hbw" type="number" min="10" max="180" step=".1" value="65"></label><label>HPBW vertical (°)<input id="rf-huawei-aau-vbw" type="number" min="1" max="40" step=".1" value="6.5"></label></div><button id="rf-huawei-aau-apply" type="button">Appliquer aux secteurs NR n78 actifs</button><small id="rf-huawei-aau-status" class="rf-muted">La hauteur et l’azimut restent ceux de la BDD. Fournissez ensuite modèle AAU, port/beam, MSI, tilt et EIRP réels pour une simulation validable.</small></details><label>Profil récepteur <select id="rf-receiver"><option>Outdoor UE 1.5 m · 0 dBi</option></select></label><details class="rf-propagation"><summary>🧭 Propagation & calibration</summary><div class="rf-grid"><label>Climat ITM<select id="rf-itm-climate"><option value="5">5 · Continental tempéré</option><option value="4">4 · Désert</option><option value="7">7 · Maritime tempéré</option></select></label><label>Facteur K<input id="rf-earth-k" type="number" step=".01" min=".5" max="2" value="1.33"></label></div><div class="rf-grid"><label>Permittivité sol<input id="rf-ground-epsilon" type="number" step=".1" value="15"></label><label>Conductivité sol (S/m)<input id="rf-ground-sigma" type="number" step=".001" value=".005"></label></div><label>Profil calibration<select id="rf-calibration-profile"><option value="">Aucun — modèle non calibré</option></select></label><div class="rf-pattern-import"><input id="rf-pattern-path" placeholder="Chemin local MSI / ADF / CSV"><button id="rf-pattern-import" type="button">Importer pattern</button></div><small id="rf-pattern-status" class="rf-muted">Le pattern importé reste à associer au modèle/SN et au port confirmés.</small></details></section>
          <section class="rf-step"><h3><b>4</b> Zone et sortie</h3><details class="rf-territory" id="rf-territory"><summary>🗺 Couverture territoriale — commune, province ou région</summary><div class="rf-muted">Charge tous les secteurs BDD situés dans la limite administrative. Vous pouvez ensuite ajouter un site extérieur : il participe au meilleur serveur, tandis que la carte reste strictement limitée au territoire. Le filtre de bandes appliqué à l'étape 2 reste obligatoire avant calcul.</div><div class="rf-grid"><label>Niveau administratif<select id="rf-territory-level"><option value="commune">Commune</option><option value="province">Province / préfecture</option><option value="region">Région</option></select></label><label id="rf-territory-search-wrap">Nom du territoire<input id="rf-territory-search" placeholder="Ex. Beni Mellal, Rabat…"></label><label id="rf-territory-province-wrap" hidden>Choisir une province / préfecture<select id="rf-territory-province-list"><option value="">Chargement…</option></select></label></div><button id="rf-territory-find" type="button" class="rf-territory-find">Rechercher le territoire</button><div id="rf-territory-results" class="rf-territory-results"></div><div id="rf-territory-summary" class="rf-territory-summary"></div></details><div class="rf-execution-mode"><label>Mode de calcul<select id="rf-execution-mode"><option value="exact">Exact local — secteur, site ou petit groupe</option><option value="territorial_tiled">Territorial tuilé — commune, province, région</option></select></label><small id="rf-execution-help">Le mode exact évalue tous les secteurs contre tous les pixels : il convient aux études locales.</small></div><div class="rf-grid"><label>Rayon (m)<input id="rf-radius" type="number" min="100" max="25000" value="5000"></label><label>Résolution (m)<select id="rf-resolution"><option value="10">10 m</option><option value="25">25 m</option><option value="50">50 m</option><option value="100">100 m</option><option value="250">250 m</option><option value="500">500 m</option><option value="5">5 m</option><option value="1">1 m</option></select></label></div><label class="rf-check"><input id="rf-current-view" type="checkbox"> Utiliser la vue courante comme zone</label><div class="rf-legend"><span>RSRP</span><span class="rf-swatch g"></span> ≥ -80 <span class="rf-swatch l"></span> ≥ -90 <span class="rf-swatch y"></span> ≥ -100 <span class="rf-swatch r"></span> &lt; -100 dBm</div><details class="rf-style"><summary>🎨 Légende éditable</summary><div class="rf-style-grid"><label>Excellent<input id="rf-t0" type="number" value="-80"><input id="rf-c0" type="color" value="#16a34a"></label><label>Bon<input id="rf-t1" type="number" value="-90"><input id="rf-c1" type="color" value="#84cc16"></label><label>Acceptable<input id="rf-t2" type="number" value="-100"><input id="rf-c2" type="color" value="#eab308"></label><label>Faible<input id="rf-t3" type="number" value="-110"><input id="rf-c3" type="color" value="#f97316"></label><label>Très faible<input id="rf-t4" type="number" value="-140"><input id="rf-c4" type="color" value="#dc2626"></label><label>Opacité<input id="rf-opacity" type="range" min=".1" max="1" step=".05" value=".72"></label></div><button id="rf-style-save">Appliquer sans recalcul</button></details></section>
          <section class="rf-step rf-control"><h3><b>5</b> Contrôle et exécution</h3><div id="rf-preflight" class="rf-preflight">Ajoutez un site : le précontrôle et les paramètres seront configurés automatiquement.</div><div class="rf-actions"><button id="rf-check">Précontrôle (optionnel)</button><button id="rf-run" class="rf-run">Calculer la couverture</button><button id="rf-cancel" class="rf-danger" disabled>Annuler</button></div><div id="rf-result-views" class="rf-result-views"></div><div id="rf-progress" class="rf-progress"></div></section>
          <section class="rf-step"><h3>Bibliothèque</h3><div id="rf-library" class="rf-library"></div></section><div class="rf-resize-handle" title="Redimensionner"></div>`;
        document.body.appendChild(root);
        enableCollapsibleSteps(root);
        restorePanelLayout(root);
        enablePanelInteraction(root);
        $('rf-close').onclick = close;
        $('rf-open-carrier-calibration').onclick = openCarrierCalibration;
        root.querySelectorAll('[data-rf-scenario]').forEach(button => button.onclick = () => setScenarioType(button.dataset.rfScenario));
        $('rf-advanced-toggle').onclick = () => {
            const visible = root.classList.toggle('rf-show-advanced');
            $('rf-advanced-toggle').setAttribute('aria-expanded', String(visible));
            $('rf-advanced-toggle').textContent = visible ? '⚙ Masquer les réglages avancés' : '⚙ Réglages avancés';
        };
        $('rf-sector-find').onclick = search;
        $('rf-sector-search').addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
        $('rf-msi-preview')?.addEventListener('click', previewMsiModel);
        $('rf-msi-apply')?.addEventListener('click', applyMsiModel);
        $('rf-huawei-aau-model')?.addEventListener('change', setHuaweiAauTemplateDefaults);
        $('rf-huawei-aau-apply')?.addEventListener('click', applyHuaweiN78AauTemplate);
        $('rf-msi-model')?.addEventListener('change', () => { if ($('rf-msi-details')?.open) void previewMsiModel(); });
        $('rf-msi-details')?.addEventListener('toggle', () => {
            if ($('rf-msi-details').open && msiState.models.length) void previewMsiModel();
        });
        void initMsiLibrary();
        $('rf-bands-all').onclick = () => { state.selectedBands = new Set(state.bandOptions.map(item => bandKey(item.band, item.technology))); renderBandFilter(); renderTransmitters(); autoConfigureStudy(); renderTerritorySummary(); };
        $('rf-bands-none').onclick = () => { state.selectedBands.clear(); renderBandFilter(); renderTransmitters(); renderTerritorySummary(); updateQuickGuide('Choisissez au moins une bande.'); };
        $('rf-operators-all').onclick = () => {
            const first = ['IAM', 'ORANGE', 'INWI'].find(operator => state.transmitters.some(tx => String(tx.operator || '').toUpperCase() === operator));
            state.selectedOperators = new Set(first ? [first] : []);
            renderOperatorFilter(); renderTransmitters(); autoConfigureStudy(); renderTerritorySummary(); void refreshRecommendation({silent:true});
        };
        $('rf-operators-none').onclick = () => { state.selectedOperators.clear(); renderOperatorFilter(); renderTransmitters(); renderTerritorySummary(); updateQuickGuide('Choisissez au moins un opérateur.'); };
        $('rf-dataset').onchange = () => { state.selectedDataset = $('rf-dataset').value; state.recommendation = null; renderDataset(); renderConfigSummary(); updateQuickGuide('GeoData choisi manuellement.'); };
        $('rf-environment-mode').onchange = () => {
            if ($('rf-environment-mode').value !== 'rural') return;
            if (Number($('rf-resolution').value) < 25) $('rf-resolution').value = '25';
            // Morocco_Rural_Study is the rural reference only when it truly
            // covers the selected group; never switch datasets blindly.
            const ruralBase = state.datasets.find(ds => ds.name === 'Morocco_Rural_Study' && ds.rfReady !== false);
            const active = simulationTransmitters();
            const bounds = ruralBase?.wgs84Bounds;
            const covers = bounds && active.every(tx => Number(tx.lon) >= bounds[0] && Number(tx.lon) <= bounds[2] && Number(tx.lat) >= bounds[1] && Number(tx.lat) <= bounds[3]);
            if (ruralBase && covers) {
                state.selectedDataset = ruralBase.datasetId;
                $('rf-dataset').value = ruralBase.datasetId;
                renderDataset();
            }
        };
        $('rf-calibration-profile').onchange = () => {
            state.calibrationProfileOverride = true;
            state.autoCalibrationProfile = null;
            renderConfigSummary();
        };
        $('rf-pack-prepare').onclick = prepareMoroccoPack;
        $('rf-rural-quick').onclick = quickPrepareRural;
        $('rf-pack-repair').onclick = repairMoroccoRuralStudy;
        $('rf-territory-find').onclick = searchTerritory;
        $('rf-territory-search').addEventListener('keydown', e => { if (e.key === 'Enter') searchTerritory(); });
        $('rf-territory-level').onchange = updateTerritoryChooser;
        $('rf-execution-mode').onchange = renderExecutionMode;
        $('rf-territory-province-list').onchange = () => {
            const raw = $('rf-territory-province-list').value;
            if (raw === '') return;
            const index = Number(raw);
            if (Number.isInteger(index) && state.provinceOptions[index]) selectTerritory(state.provinceOptions[index]);
        };
        $('rf-check').onclick = check;
        $('rf-run').onclick = run;
        $('rf-cancel').onclick = cancel;
        $('rf-style-save').onclick = applyStyle;
        $('rf-pattern-import').onclick = importPattern;
        $('rf-current-view').onchange = () => { if ($('rf-current-view').checked) setViewAoi(); };
        $('rf-aoi-draw').onclick = () => state.aoiDrawing ? cancelAoiDrawing() : startAoiDrawing();
        $('rf-aoi-clear').onclick = () => clearManualAoi();
        $('rf-indoor-operator').onchange = () => {
            state.indoorOperator = $('rf-indoor-operator').value;
            state.recommendation = null;
            renderConfigSummary();
            void refreshRecommendation().then(() => automaticPreflight({announceReady:true}));
        };
        $('rf-indoor-clear').onclick = clearIndoorBuildings;
        $('rf-indoor-show-nearby').onclick = showIndoorBuildingsNearMap;
        $('rf-indoor-clear-nearby').onclick = clearIndoorBuildingPreview;
        renderExecutionMode();
    }

    async function importPattern() {
        const sourcePath = $('rf-pattern-path').value.trim();
        if (!sourcePath) { $('rf-pattern-status').textContent = 'Indiquez le chemin local d’un fichier MSI, ADF ou CSV.'; return; }
        try {
            const imported = await window.rfApi.importAntennaPattern({sourcePath});
            $('rf-pattern-status').textContent = `✓ ${imported.name} importé : ${imported.horizontalSamples} échantillons H, ${imported.verticalSamples} V. Associez-le explicitement au secteur dans un scénario proposé.`;
        } catch (err) { $('rf-pattern-status').textContent = `Import pattern impossible : ${err.message}`; }
    }

    function calibrationPercent(value) {
        const number = Number(value);
        return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : 'N/D';
    }

    async function pollCarrierCalibrationJob(jobId, statusNode, onReady) {
        while (document.getElementById('rf-carrier-calibration-modal')) {
            const job = await window.rfApi.carrierCalibrationJob(jobId);
            statusNode.innerHTML = `<b>${esc(job.phase || job.status)}</b><span>${Number(job.progress || 0).toFixed(1)}%</span>`;
            if (job.status === 'ready') { await onReady(job); return; }
            if (job.status === 'failed' || job.status === 'cancelled') throw new Error(job.error || `Job ${job.status}`);
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
    }

    function renderCarrierAudit(dataset, target) {
        const audit = dataset.audit || {};
        const cards = (dataset.files || []).map(file => {
            const item = file.audit || {};
            return `<article class="rf-calibration-band"><header><b>${esc(file.band)}</b><span>EARFCN ${file.earfcn}</span></header>
              <strong>${Number(item.source || file.source_rows || 0).toLocaleString('fr-FR')} grilles</strong>
              <small>BDD ${calibrationPercent(item.bddMatchRate)} · acceptées ${Number(item.accepted || file.accepted_rows || 0).toLocaleString('fr-FR')}</small>
              ${Number(item.unresolvedCellCount || 0) ? `<details><summary>${Number(item.unresolvedCellCount).toLocaleString('fr-FR')} cellule(s) BDD non résolue(s) · ${Number((item.unresolvedCells || []).reduce((sum, value) => sum + Number(value.rows || 0), 0)).toLocaleString('fr-FR')} lignes</summary><div class="rf-calibration-unresolved">${(item.unresolvedCells || []).map(value => `<span>${esc(value.cell || value.enbCell || 'Cellule inconnue')} <b>${Number(value.rows || 0).toLocaleString('fr-FR')}</b></span>`).join('')}</div></details>` : '<em class="good">Toutes les cellules sont résolues.</em>'}
              ${item.worksheetNameMismatch ? '<em>Nom d’onglet contradictoire détecté; le nom du fichier fait foi.</em>' : ''}</article>`;
        }).join('');
        const split = audit.split || {};
        target.innerHTML = `<div class="rf-calibration-kpis"><div><small>Observations</small><b>${Number(audit.sourceRows || 0).toLocaleString('fr-FR')}</b></div><div><small>Positions uniques</small><b>${Number(audit.uniquePositions || 0).toLocaleString('fr-FR')}</b></div><div><small>Acceptées</small><b>${Number(audit.acceptedRows || 0).toLocaleString('fr-FR')}</b></div><div><small>Qualité</small><b>${esc(dataset.quality || 'caution')}</b></div></div>
          <div class="rf-calibration-bands">${cards}</div>
          <div class="rf-calibration-check ${Number(split.leakingBlocks || 0) || Number(split.leakingSites || 0) ? 'bad' : 'good'}">Blocs en fuite: ${Number(split.leakingBlocks || 0)} · sites en fuite: ${Number(split.leakingSites || 0)} · découpage 60/20/20 par blocs site UTM 2 km.</div>`;
    }

    function renderCarrierCalibrationResults(run, target) {
        const results = run.results || run.result || run;
        const bandCards = Object.entries(results.bands || {}).map(([earfcn, band]) => {
            const baseline = band.baseline || {}, calibrated = band.calibrated || {}, winner = band.bestServer?.calibrated || {};
            return `<article class="rf-calibration-result ${band.criteriaMet ? 'pass' : 'fail'}"><header><b>${esc(band.band)}</b><span>EARFCN ${esc(earfcn)}</span></header>
              <div><small>RMSE</small><strong>${baseline.rmseDb ?? '—'} → ${calibrated.rmseDb ?? '—'} dB</strong></div>
              <div><small>MAE / biais</small><strong>${calibrated.maeDb ?? '—'} / ${calibrated.biasDb ?? '—'} dB</strong></div>
              <div><small>P90 / test</small><strong>${calibrated.p90AbsDb ?? '—'} dB · ${Number(band.test || 0).toLocaleString('fr-FR')}</strong></div>
              <div><small>Best secteur / site / top-2</small><strong>${winner.exactSectorAccuracyPct ?? '—'}% / ${winner.siteAccuracyPct ?? '—'}% / ${winner.topTwoAccuracyPct ?? '—'}%</strong></div>
              <em>${band.criteriaMet ? 'Critères terrain atteints; statut caution tant que le raster reste hybride.' : 'Critères de promotion non atteints.'}</em></article>`;
        }).join('');
        target.innerHTML = `<div class="rf-calibration-decision ${results.quality === 'rejected' ? 'bad' : 'good'}"><b>${esc(results.quality || 'caution')}</b><span>${esc((results.limitations || [])[0] || '')}</span></div><div class="rf-calibration-results">${bandCards}</div>`;
    }

    async function openCarrierCalibration() {
        document.getElementById('rf-carrier-calibration-modal')?.remove();
        const modal = document.createElement('section');
        modal.id = 'rf-carrier-calibration-modal'; modal.className = 'rf-carrier-calibration-modal';
        modal.innerHTML = `<header><div><span>SMARTCARE → RF COVERAGE</span><h2>🎯 Calibration SmartCare LTE</h2><p>Calibration observée par porteuse, puis validation best-server indépendante.</p></div><button type="button" data-action="close">×</button></header>
          <div class="rf-calibration-body">
            <nav><span class="active">1 · Sources</span><span>2 · Audit</span><span>3 · Baseline & ajustement</span><span>4 · Validation</span></nav>
            <section class="rf-calibration-source"><label>Dossier local des exports<input id="rf-cal-folder" value="/Users/abdelilah/Desktop/EMA Solution/Optim_Analyzer/SmartCare Export/SmartCare calibration"></label><button id="rf-cal-scan" type="button">Scanner les 4 porteuses</button></section>
            <div id="rf-cal-scan-result" class="rf-calibration-panel">Choisissez le dossier contenant les exports 525, 1320, 3050 et 6300.</div>
            <section class="rf-calibration-window"><label>Début de la période<input id="rf-cal-start" type="date"></label><label>Fin de la période<input id="rf-cal-end" type="date"></label><label class="rf-check"><input id="rf-cal-window-unknown" type="checkbox"> Période inconnue (profil limité à caution)</label></section>
            <div class="rf-calibration-actions"><button id="rf-cal-import" type="button" disabled>Importer et auditer</button><button id="rf-cal-run" type="button" disabled>Lancer calibration + validation</button><button id="rf-cal-promote" type="button" disabled>Créer et promouvoir le bundle</button></div>
            <div id="rf-cal-job" class="rf-calibration-job"></div><div id="rf-cal-audit"></div><div id="rf-cal-results"></div>
          </div>`;
        document.body.appendChild(modal);
        modal.querySelector('[data-action="close"]').onclick = () => modal.remove();
        const scanButton = modal.querySelector('#rf-cal-scan'); const importButton = modal.querySelector('#rf-cal-import');
        const runButton = modal.querySelector('#rf-cal-run'); const promoteButton = modal.querySelector('#rf-cal-promote');
        const scanResult = modal.querySelector('#rf-cal-scan-result'); const jobNode = modal.querySelector('#rf-cal-job');
        let scan = null, datasetId = null, runId = null;
        scanButton.onclick = async () => {
            scanButton.disabled = true; scanResult.textContent = 'Lecture des en-têtes et empreintes…';
            try {
                scan = await window.rfApi.scanCarrierCalibrationFolder(modal.querySelector('#rf-cal-folder').value.trim());
                scanResult.innerHTML = `<div class="rf-calibration-files">${(scan.files || []).map(file => `<div><b>${esc(file.band)}</b><span>EARFCN ${file.earfcn}</span><small>${esc(file.name)}</small>${file.worksheetNameMismatch ? '<em>Onglet contradictoire — filename prioritaire</em>' : ''}</div>`).join('')}</div>${scan.ready ? '<strong class="good">✓ Quatre porteuses détectées sans fusion.</strong>' : `<strong class="bad">Porteuses manquantes: ${esc((scan.missingEarfcn || []).join(', '))}</strong>`}`;
                importButton.disabled = !scan.ready;
            } catch (error) { scanResult.innerHTML = `<strong class="bad">${esc(error.message)}</strong>`; }
            finally { scanButton.disabled = false; }
        };
        importButton.onclick = async () => {
            const unknown = modal.querySelector('#rf-cal-window-unknown').checked;
            const start = modal.querySelector('#rf-cal-start').value, end = modal.querySelector('#rf-cal-end').value;
            if (!unknown && (!start || !end)) { jobNode.textContent = 'Indiquez la période SmartCare ou cochez « période inconnue ».'; return; }
            importButton.disabled = true;
            try {
                const created = await window.rfApi.importCarrierCalibrationDataset({folderPath:scan.folderPath, name:'IAM Rabat LTE SmartCare calibration', measurementStart:unknown ? null : start, measurementEnd:unknown ? null : end, region:'Rabat-Salé-Témara', environment:'urban'});
                datasetId = created.datasetId;
                if (created.cached) {
                    jobNode.innerHTML = '<strong class="good">✓ Dataset immuable inchangé : cache validé et réutilisé.</strong>';
                    const dataset = await window.rfApi.carrierCalibrationDataset(datasetId);
                    renderCarrierAudit(dataset, modal.querySelector('#rf-cal-audit')); runButton.disabled = false;
                    return;
                }
                await pollCarrierCalibrationJob(created.jobId, jobNode, async () => {
                    const dataset = await window.rfApi.carrierCalibrationDataset(datasetId);
                    renderCarrierAudit(dataset, modal.querySelector('#rf-cal-audit')); runButton.disabled = false;
                });
            } catch (error) { jobNode.innerHTML = `<strong class="bad">${esc(error.message)}</strong>`; importButton.disabled = false; }
        };
        runButton.onclick = async () => {
            runButton.disabled = true;
            try {
                const created = await window.rfApi.createCarrierCalibrationJob({datasetId, maxPointsPerBand:30000, bestServerPointsPerBand:500, ridge:10});
                await pollCarrierCalibrationJob(created.jobId, jobNode, async job => {
                    runId = job.result?.runId;
                    const run = await window.rfApi.carrierCalibrationRun(runId);
                    renderCarrierCalibrationResults(run, modal.querySelector('#rf-cal-results'));
                    promoteButton.disabled = run.results?.quality === 'rejected';
                });
            } catch (error) { jobNode.innerHTML = `<strong class="bad">${esc(error.message)}</strong>`; runButton.disabled = false; }
        };
        promoteButton.onclick = async () => {
            promoteButton.disabled = true;
            try {
                const profile = await window.rfApi.createCarrierCalibrationProfile(runId, 'IAM Rabat LTE — 4 porteuses');
                await window.rfApi.setCarrierCalibrationProfile(profile.id, {promoted:true, active:true});
                jobNode.innerHTML = '<strong class="good">✓ Bundle versionné promu. Il sera proposé uniquement aux simulations compatibles.</strong>';
                await loadCalibrationProfiles();
            } catch (error) { jobNode.innerHTML = `<strong class="bad">${esc(error.message)}</strong>`; promoteButton.disabled = false; }
        };
        scanButton.click();
    }

    async function loadCalibrationProfiles() {
        const select = $('rf-calibration-profile'); if (!select) return;
        try {
            const response = await window.rfApi.calibrationProfiles();
            select.innerHTML = '<option value="">Aucun — modèle non calibré</option>' + (response.items || []).map(profile =>
                `<option value="${esc(profile.id)}">${esc(profile.name)} · ${esc(profile.quality)}${profile.profileType === 'carrier-aware-smartcare' ? ' · porteuses 525/1320/3050/6300' : ` · ${Number(profile.correctionDb || 0).toFixed(2)} dB`}</option>`).join('');
        } catch (_) { /* RF remains usable without a calibration library. */ }
    }

    async function autoSelectCompatibleCalibration(recommendation, active) {
        const select = $('rf-calibration-profile');
        if (!select || state.calibrationProfileOverride) return;
        const operators = [...new Set(active.map(tx => String(tx.operator || '').toUpperCase()).filter(Boolean))];
        const lte = active.filter(tx => String(tx.technology || '').toUpperCase() === 'LTE' && Number.isFinite(Number(tx.earfcnDl)));
        if (operators.length !== 1 || !lte.length || recommendation?.environmentMode !== 'urban') {
            select.value = '';
            state.autoCalibrationProfile = null;
            return;
        }
        try {
            const response = await window.rfApi.compatibleCalibrationProfiles({operator:operators[0], rat:'LTE', earfcn:Math.round(Number(lte[0].earfcnDl)), environment:'urban', datasetId:recommendation.datasetId || state.selectedDataset});
            const profile = (response.items || [])[0] || null;
            if (profile && [...select.options].some(option => option.value === profile.id)) select.value = profile.id;
            else select.value = '';
            state.autoCalibrationProfile = profile;
        } catch (_) {
            select.value = '';
            state.autoCalibrationProfile = null;
        }
    }

    function renderExecutionMode() {
        const mode = $('rf-execution-mode')?.value || 'exact';
        const help = $('rf-execution-help');
        const territorial = mode === 'territorial_tiled';
        if (territorial && Number($('rf-resolution').value) < 50) $('rf-resolution').value = '50';
        if (help) help.textContent = territorial
            ? (state.territory
                ? 'Tuiles de 6,4 km à 50 m : candidats radio locaux sélectionnés de façon conservative puis affinés avec terrain, Fresnel et diffraction. Recommandé pour toute une province et toutes les bandes.'
                : 'Composite tuilé : pour 61 à 600 secteurs sélectionnés, les candidats locaux sont raffinés avec terrain, Fresnel et diffraction sans parcourir tous les secteurs pour chaque pixel.')
            : 'Le mode exact évalue tous les secteurs contre tous les pixels : il convient aux études locales limitées.';
    }
    function activeStudyAreaKm2() {
        const bounds = state.territory?.area?.bounds;
        if (!Array.isArray(bounds) || bounds.length !== 4) return 0;
        const [west, south, east, north] = bounds.map(Number);
        return Math.max(0, (east - west) * 111.32 * (north - south) * 111.32 * Math.cos((south + north) * Math.PI / 360));
    }
    function siteGroupSpanM(active = simulationTransmitters()) {
        const points = active.filter(tx => Number.isFinite(Number(tx.lat)) && Number.isFinite(Number(tx.lon)));
        if (points.length < 2) return 0;
        const lat = points.reduce((sum, tx) => sum + Number(tx.lat), 0) / points.length;
        const lon = points.reduce((sum, tx) => sum + Number(tx.lon), 0) / points.length;
        return Math.max(...points.map(tx => Math.hypot((Number(tx.lat) - lat) * 111320, (Number(tx.lon) - lon) * 111320 * Math.cos(lat * Math.PI / 180))));
    }
    function preferredTerritorialResolution() {
        const areaKm2 = activeStudyAreaKm2();
        if (areaKm2 > 1200) return '500';
        if (areaKm2 > 220) return '250';
        if (areaKm2 > 40) return '100';
        return '50';
    }
    function rfDatasetScore(dataset) {
        const layers = dataset.layers || {};
        const local3d = Number(Boolean(layers.dhm)) + Number(Boolean(layers.buildings)) + Number(Boolean(layers.vegetation));
        const resolution = Math.max(Number(dataset.resolution?.[0]) || 1000, Number(dataset.resolution?.[1]) || 1000);
        const bounds = dataset.wgs84Bounds || [];
        const extent = bounds.length === 4 ? Math.max(0, (Number(bounds[2]) - Number(bounds[0])) * (Number(bounds[3]) - Number(bounds[1]))) : 999;
        // Detailed local terrain wins over a larger regional dataset.  The
        // latter remains the automatic fallback when the requested AOI will
        // not fit in the local study.
        return local3d * 1000000 - resolution * 10 - extent;
    }
    function datasetCoversPoints(dataset, points) {
        const bounds = dataset?.wgs84Bounds;
        return Array.isArray(bounds) && bounds.length === 4 && points.every(point =>
            Number(point.lon) >= Number(bounds[0]) && Number(point.lon) <= Number(bounds[2]) &&
            Number(point.lat) >= Number(bounds[1]) && Number(point.lat) <= Number(bounds[3]));
    }
    function datasetCoversBounds(dataset, requestedBounds) {
        const bounds = dataset?.wgs84Bounds;
        return Array.isArray(bounds) && bounds.length === 4 && Array.isArray(requestedBounds) && requestedBounds.length === 4
            && Number(bounds[0]) <= Number(requestedBounds[0]) && Number(bounds[1]) <= Number(requestedBounds[1])
            && Number(bounds[2]) >= Number(requestedBounds[2]) && Number(bounds[3]) >= Number(requestedBounds[3]);
    }
    function autoSelectSiteDatasetAndRadius(active) {
        if (state.territory || !active.length) return;
        const polygonBounds = geometryBoundsWgs84(state.aoiPolygon?.geometry);
        const candidate = state.datasets.filter(dataset => dataset.rfReady !== false && (polygonBounds ? datasetCoversBounds(dataset, polygonBounds) : datasetCoversPoints(dataset, active)))
            .sort((left, right) => rfDatasetScore(right) - rfDatasetScore(left))[0];
        if (!candidate) return;
        state.selectedDataset = candidate.datasetId;
        $('rf-dataset').value = candidate.datasetId;
        if (polygonBounds) { renderDataset(); return; }
        const centerLat = active.reduce((sum, tx) => sum + Number(tx.lat), 0) / active.length;
        const centerLon = active.reduce((sum, tx) => sum + Number(tx.lon), 0) / active.length;
        const bounds = candidate.wgs84Bounds.map(Number);
        const metrePerLon = Math.max(111320 * Math.cos(centerLat * Math.PI / 180), 1);
        const boundaryRadiusM = Math.min((centerLon - bounds[0]) * metrePerLon, (bounds[2] - centerLon) * metrePerLon,
            (centerLat - bounds[1]) * 111320, (bounds[3] - centerLat) * 111320);
        const spanM = siteGroupSpanM(active);
        const detailed = Boolean(candidate.layers?.dhm || candidate.layers?.buildings || candidate.layers?.vegetation);
        const nominalRadiusM = Math.max(detailed ? 1500 : 5000, spanM + (active.length > 1 ? 1000 : 500));
        // Leave a small border for the complete terrain/Fresnel path.  If the
        // local study is too small, chooseDatasetForTransmitters() will move
        // to a broader compatible dataset below.
        const safeRadiusM = Math.max(100, Math.min(25000, Math.floor(Math.min(nominalRadiusM, Math.max(100, boundaryRadiusM - 150)) / 100) * 100));
        $('rf-radius').value = String(safeRadiusM);
        renderDataset();
    }
    function updateQuickGuide(extra = '') {
        const guide = $('rf-quick-guide');
        const selected = state.datasets.find(ds => ds.datasetId === state.selectedDataset);
        if (!guide) return;
        if (state.studyMode === 'territory') {
            guide.textContent = state.territory
                ? `${state.territory.area.name} · ${selected?.name || 'recherche GeoData…'} · mode territorial tuilé · ${$('rf-resolution')?.value || 50} m.${extra ? ` ${extra}` : ''}`
                : 'Choisissez une commune ou une province à l’étape 4 : ses sites, son GeoData et son mode tuilé seront configurés automatiquement.';
            return;
        }
        const active = simulationTransmitters();
        guide.textContent = active.length
            ? `${active.length} secteur(s) · ${state.aoiPolygon ? 'zone dessinée · ' : ''}${selected?.name || 'GeoData à rechercher…'} · ${$('rf-execution-mode')?.value === 'territorial_tiled' ? 'mode tuilé' : 'mode exact'} · ${$('rf-resolution')?.value || 10} m.${extra ? ` ${extra}` : ''}`
            : 'Ajoutez un ou plusieurs sites : le GeoData et les paramètres de calcul seront adaptés automatiquement.';
    }
    const scenarioLabels = {
        urban_sites: 'Sites urbains', rural_sites: 'Sites ruraux', commune: 'Commune', province: 'Province', indoor_macro: 'Indoor — Macro vers bâtiment',
    };
    function renderIndoorBuildings() {
        const target = $('rf-indoor-buildings');
        const clear = $('rf-indoor-clear');
        if (!target || !clear) return;
        clear.hidden = !state.indoorBuildings.length;
        target.innerHTML = state.indoorBuildings.length ? state.indoorBuildings.map((building, index) => `
          <article class="rf-indoor-building-card">
            <div><b>🏢 Bâtiment ${esc(building.rawId || building.id)}</b><small>${Number(building.heightAglM || 0).toFixed(1)} m AGL · ${Number(building.floorCount || 0)} étage(s) · ${Number(building.areaM2 || 0).toLocaleString('fr-FR')} m²</small></div>
            <span class="rf-config-badge ${esc(building.qualityStatus || 'caution')}">${esc(building.qualityStatus || 'caution')}</span>
            <button type="button" data-rf-edit-indoor="${index}" title="Corriger les étages">✎</button>
            <button type="button" data-rf-remove-indoor="${index}" title="Retirer ce bâtiment">×</button>
          </article>`).join('') : '<span class="rf-muted">Cliquez directement un bâtiment sur la carte.</span>';
        target.querySelectorAll('[data-rf-edit-indoor]').forEach(button => button.onclick = async () => {
            const index = Number(button.dataset.rfEditIndoor);
            const current = state.indoorBuildings[index];
            if (!current) return;
            const floorsText = window.prompt('Nombre d’étages (1–100)', String(current.floorCount || 1));
            if (floorsText === null) return;
            const heightText = window.prompt('Hauteur étage-à-étage en mètres (2–8)', String(current.defaultFloorHeightM || 3));
            if (heightText === null) return;
            const floorCount = Number(floorsText), defaultFloorHeightM = Number(heightText);
            if (!Number.isInteger(floorCount) || floorCount < 1 || floorCount > 100 || !Number.isFinite(defaultFloorHeightM) || defaultFloorHeightM < 2 || defaultFloorHeightM > 8) {
                window.alert('Valeurs invalides : étages 1–100 et hauteur 2–8 m.'); return;
            }
            button.disabled = true;
            try {
                state.indoorBuildings[index] = await window.rfApi.updateIndoorBuilding(current.id, {floorCount, defaultFloorHeightM});
                state.recommendation = null; renderIndoorBuildings(); renderConfigSummary();
                await refreshRecommendation(); await automaticPreflight({announceReady:true});
            } catch (error) { window.alert(`Correction impossible : ${error.message}`); }
        });
        target.querySelectorAll('[data-rf-remove-indoor]').forEach(button => button.onclick = () => {
            state.indoorBuildings.splice(Number(button.dataset.rfRemoveIndoor), 1);
            state.recommendation = null;
            renderIndoorBuildings(); renderConfigSummary();
            void refreshRecommendation().then(() => automaticPreflight({announceReady:true}));
        });
    }
    function clearIndoorBuildings() {
        state.indoorBuildings = [];
        state.recommendation = null;
        state.indoorPickMode = true;
        renderIndoorBuildings(); renderConfigSummary();
        showCheck({ok:false, quality:'blocked', issues:['Cliquez un bâtiment sur la carte.']});
    }
    function clearIndoorBuildingPreview() {
        if (state.indoorBuildingPreview && map()?.hasLayer(state.indoorBuildingPreview)) map().removeLayer(state.indoorBuildingPreview);
        state.indoorBuildingPreview = null;
        const clear = $('rf-indoor-clear-nearby');
        if (clear) clear.hidden = true;
    }
    async function showIndoorBuildingsNearMap() {
        const m = map();
        if (!m) return;
        const center = m.getCenter();
        const dataset = indoorDatasetAt(Number(center.lat), Number(center.lng));
        if (!dataset) {
            showCheck({ok:false, quality:'blocked', issues:['Aucun GeoData urbain avec bâtiments ne couvre la vue actuelle.']});
            return;
        }
        const bounds = m.getBounds();
        const hint = $('rf-indoor-pick-hint');
        if (hint) hint.textContent = 'Chargement des contours de bâtiments…';
        try {
            const response = await window.rfApi.indoorBuildings(dataset.datasetId, {
                west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth(),
            }, '', 250);
            clearIndoorBuildingPreview();
            const byId = new Map((response.items || []).map(item => [item.id, item]));
            const features = (response.items || []).map(item => ({type:'Feature', properties:{id:item.id}, geometry:item.geometry}));
            const layer = window.L.geoJSON({type:'FeatureCollection', features}, {
                style: {color:'#facc15', weight:2, fillColor:'#facc15', fillOpacity:.10},
                onEachFeature: (feature, featureLayer) => featureLayer.on('click', event => {
                    window.L.DomEvent.stopPropagation(event);
                    const building = byId.get(feature.properties.id);
                    if (building) void selectIndoorBuilding(building, 'contour sélectionné');
                }),
            }).addTo(m);
            state.indoorBuildingPreview = layer;
            $('rf-indoor-clear-nearby').hidden = false;
            if (hint) hint.textContent = `✓ ${Number(response.returned || 0)} contours affichés : cliquez le bâtiment voulu.`;
        } catch (error) {
            if (hint) hint.textContent = `Contours indisponibles : ${error.message}`;
        }
    }
    function indoorDatasetAt(lat, lon) {
        return state.datasets.filter(dataset => dataset.rfReady !== false && dataset.layers?.buildings && datasetCoversPoints(dataset, [{lat, lon}]))
            .sort((left, right) => rfDatasetScore(right) - rfDatasetScore(left))[0] || null;
    }
    async function selectIndoorAt(lat, lon) {
        if (state.indoorSelectionBusy) return;
        const dataset = indoorDatasetAt(lat, lon);
        if (!dataset) {
            showCheck({ok:false, quality:'blocked', issues:['Aucun GeoData avec bâtiments ne couvre ce point. Sélectionnez un bâtiment dans Rabat–Salé–Témara ou un dataset urbain compatible.']});
            return;
        }
        state.indoorSelectionBusy = true;
        $('rf-quick-guide').textContent = 'Recherche du bâtiment et audit des attributs indoor…';
        try {
            const building = await window.rfApi.indoorBuildingAt(dataset.datasetId, lat, lon);
            if (!building?.id) throw new Error('Aucun bâtiment vectoriel à ce point.');
            const mode = building.selectionMode === 'nearest-footprint' ? `bâtiment le plus proche (${Number(building.selectionDistanceM || 0).toFixed(1)} m)` : 'bâtiment sélectionné';
            await selectIndoorBuilding(building, mode);
        } catch (error) {
            showCheck({ok:false, quality:'blocked', issues:[error.message]});
        } finally { state.indoorSelectionBusy = false; updateQuickGuide(); }
    }
    async function selectIndoorBuilding(building, selectionMessage = 'bâtiment sélectionné') {
        if (!building?.id) return;
        if (!state.indoorBuildings.some(item => item.id === building.id)) state.indoorBuildings.push(building);
        state.selectedDataset = building.datasetId;
        $('rf-dataset').value = building.datasetId;
        renderDataset(); renderIndoorBuildings(); renderConfigSummary();
        if (building.geometry && window.L) window.L.geoJSON(building.geometry, {style:{color:'#22d3ee', weight:3, fillColor:'#38bdf8', fillOpacity:.16}, interactive:false}).addTo(map());
        const hint = $('rf-indoor-pick-hint');
        if (hint) hint.textContent = `✓ ${selectionMessage} : bâtiment ${building.rawId || building.id}.`;
        await refreshRecommendation();
        await automaticPreflight({announceReady:true});
    }
    function indoorMapClick(event) {
        if (!$('rf-panel')?.classList.contains('open') || state.scenarioType !== 'indoor_macro' || !state.indoorPickMode || state.aoiDrawing) return;
        void selectIndoorAt(Number(event.latlng.lat), Number(event.latlng.lng));
    }
    function setScenarioType(type, {preserveSelection = false} = {}) {
        if (!scenarioLabels[type]) return;
        const territorial = type === 'commune' || type === 'province';
        const indoor = type === 'indoor_macro';
        state.scenarioType = type;
        state.studyMode = territorial ? 'territory' : indoor ? 'indoor' : 'sites';
        state.indoorPickMode = indoor;
        state.recommendation = null;
        $('rf-panel').dataset.rfScenarioMode = type;
        document.querySelectorAll('#rf-panel [data-rf-scenario]').forEach(button => button.classList.toggle('active', button.dataset.rfScenario === type));
        $('rf-territory-level').value = type === 'province' ? 'province' : 'commune';
        $('rf-territory').open = territorial;
        $('rf-indoor-guide').hidden = !indoor;
        $('rf-manual-aoi').hidden = indoor;
        $('rf-open-carrier-calibration').hidden = indoor;
        $('rf-panel').querySelector('.rf-kicker').textContent = indoor ? 'INDOOR RSRP · MACRO → BÂTIMENT · 2.5D' : 'OUTDOOR RSRP · LOCAL GEODATA';
        $('rf-run').textContent = indoor ? 'Calculer la couverture intérieure' : 'Calculer la couverture';
        $('rf-check').textContent = indoor ? 'Vérifier le bâtiment' : 'Précontrôle';
        $('rf-current-view').checked = false;
        $('rf-current-view').disabled = territorial || Boolean(state.aoiPolygon);
        $('rf-execution-mode').value = territorial ? 'territorial_tiled' : 'exact';
        $('rf-environment-mode').value = territorial ? 'hybrid' : (type === 'urban_sites' || indoor) ? 'urban' : 'rural';
        if (territorial) {
            if (!preserveSelection && state.territory && state.territory.area.level !== $('rf-territory-level').value) clearTerritory();
            updateTerritoryChooser();
        } else if (!preserveSelection && state.territory) {
            clearTerritory();
            state.transmitters = [];
            state.selectedOperators.clear();
            renderOperatorFilter(); renderTransmitters();
        }
        renderExecutionMode(); polygonStatus();
        renderIndoorBuildings();
        renderConfigSummary();
        updateQuickGuide();
    }
    function recommendationRequest() {
        const request = payload();
        request.scenarioType = state.scenarioType;
        return request;
    }
    function applyRecommendation(result) {
        if (!result) return;
        state.recommendation = result;
        if (result.datasetId && state.datasets.some(dataset => dataset.datasetId === result.datasetId)) {
            state.selectedDataset = result.datasetId;
            $('rf-dataset').value = result.datasetId;
            renderDataset();
        }
        if (result.environmentMode) $('rf-environment-mode').value = result.environmentMode;
        if (result.executionMode) $('rf-execution-mode').value = result.executionMode;
        if (result.resolutionM) $('rf-resolution').value = String(result.resolutionM);
        renderExecutionMode();
        renderConfigSummary(result);
    }
    async function refreshRecommendation({silent = false} = {}) {
        // Indoor recommendations select their candidate sectors on the server.
        // Keep an empty local list here so the common calibration lookup never
        // references the site-selection variable from the outdoor branch.
        const active = state.scenarioType === 'indoor_macro' ? [] : simulationTransmitters();
        if (state.scenarioType === 'indoor_macro') {
            if (!state.indoorBuildings.length) { renderConfigSummary(); return null; }
        } else {
        if (!active.length) { renderConfigSummary(); return null; }
        if ((state.scenarioType === 'commune' || state.scenarioType === 'province') && !state.territory) { renderConfigSummary(); return null; }
        }
        const token = ++state.recommendationToken;
        if (!silent) $('rf-config-summary').classList.add('loading');
        try {
            const result = await window.rfApi.recommendation(recommendationRequest());
            if (token !== state.recommendationToken) return null;
            applyRecommendation(result);
            await autoSelectCompatibleCalibration(result, result.transmitters || active);
            if (token !== state.recommendationToken) return null;
            renderConfigSummary(result);
            return result;
        } catch (err) {
            if (token === state.recommendationToken) renderConfigSummary(null, err.message);
            return null;
        } finally { if (token === state.recommendationToken) $('rf-config-summary')?.classList.remove('loading'); }
    }
    function renderConfigSummary(recommendation = state.recommendation, error = '') {
        const target = $('rf-config-summary'); if (!target) return;
        if (state.scenarioType === 'indoor_macro') {
            const buildings = recommendation?.buildings || state.indoorBuildings;
            const quality = recommendation?.quality || (buildings.length ? 'caution' : 'waiting');
            const qualityLabel = quality === 'professional-ready' ? 'Professionnelle' : quality === 'caution' ? 'Caution' : quality === 'exploratory' ? 'Exploratoire' : quality === 'blocked' ? 'Bloquée' : 'À configurer';
            const bands = recommendation?.selectedBands || [];
            target.innerHTML = `<div class="rf-config-head"><b>Configuration Indoor automatique</b><span class="rf-config-badge ${esc(quality)}">${esc(qualityLabel)}</span></div>${error ? `<div class="rf-error">${esc(error)}</div>` : !buildings.length ? '<span>Cliquez un bâtiment sur la carte pour commencer.</span>' : `<div class="rf-config-grid"><span><small>Scénario</small>Macro → bâtiment · 2.5D</span><span><small>Sélection</small>${buildings.length} bâtiment(s) · ${Number(recommendation?.floorCount || buildings[0]?.floorCount || 0)} étage(s)</span><span><small>Réseau</small>${esc(state.indoorOperator)} · ${esc(bands.join(', ') || 'toutes les bandes')}</span><span><small>GeoData</small>${esc(recommendation?.dataset?.name || state.datasets.find(item => item.datasetId === state.selectedDataset)?.name || '—')}</span><span><small>Grille</small>${Number(recommendation?.resolutionM || 1).toFixed(1)} m · UE 1,5 m par étage</span><span><small>Modèle pertes</small>Attributs GeoData puis P.2109/P.1238</span></div>${recommendation?.estimatedReceiverPoints ? `<small>${Number(recommendation.estimatedReceiverPoints).toLocaleString('fr-FR')} points récepteurs · ≈ ${Number(recommendation.estimatedSeconds || 0).toFixed(1)} s</small>` : ''}`}`;
            return;
        }
        const active = simulationTransmitters();
        const sites = new Set(active.map(siteKey)).size;
        const operators = [...new Set(active.map(tx => String(tx.operator || 'UNKNOWN').toUpperCase()))];
        const bands = [...new Set(active.map(tx => bandKey(tx.band, tx.technology)))];
        const selected = state.datasets.find(dataset => dataset.datasetId === (recommendation?.datasetId || state.selectedDataset));
        const waiting = !active.length ? (state.studyMode === 'territory' ? 'Choisissez un territoire et un opérateur.' : 'Recherchez un site ou cliquez-le sur la carte.') : '';
        const quality = recommendation?.quality || (waiting ? 'waiting' : 'caution');
        const qualityLabel = quality === 'professional-ready' ? 'Professionnelle' : quality === 'caution' ? 'Caution' : quality === 'exploratory' ? 'Exploratoire' : 'À configurer';
        const env = recommendation?.fallback ? 'Urbain — données 3D partielles / fallback rural' : ({urban:'Urbain 3D', rural:'Rural DTM + clutter', hybrid:'Hybride urbain/rural'}[recommendation?.environmentMode || $('rf-environment-mode')?.value] || 'Automatique');
        const tiledLabel = state.territory ? 'Territorial tuilé' : 'Composite tuilé';
        const calibration = state.autoCalibrationProfile
            ? `SmartCare ${esc(state.autoCalibrationProfile.name)} · ${esc(state.autoCalibrationProfile.quality)}`
            : ($('rf-calibration-profile')?.value ? 'Profil choisi manuellement' : 'Aucun profil compatible — modèle non calibré');
        target.innerHTML = `<div class="rf-config-head"><b>Configuration automatique</b><span class="rf-config-badge ${esc(quality)}">${esc(qualityLabel)}</span></div>${error ? `<div class="rf-error">${esc(error)}</div>` : waiting ? `<span>${esc(waiting)}</span>` : `<div class="rf-config-grid"><span><small>Scénario</small>${esc(scenarioLabels[state.scenarioType])}</span><span><small>Sélection</small>${sites} site(s) · ${active.length} secteurs</span><span><small>Réseau</small>${esc(operators.join(', ') || '—')} · ${esc(bands.join(', ') || '—')}</span><span><small>Zone</small>${state.aoiPolygon ? 'Polygone dessiné' : state.territory ? esc(state.territory.area.name) : 'Rayon autour des sites'}</span><span><small>GeoData</small>${esc(selected?.name || 'Préparation automatique')}</span><span><small>Environnement</small>${esc(env)}</span><span><small>Calcul</small>${esc(recommendation?.executionMode === 'territorial_tiled' ? tiledLabel : 'Exact')} · ${Number(recommendation?.resolutionM || $('rf-resolution')?.value || 0)} m</span><span><small>Calibration</small>${calibration}</span></div>${recommendation?.estimatedPixels ? `<small>${Number(recommendation.estimatedPixels).toLocaleString('fr-FR')} pixels estimés${recommendation.reasons?.length ? ` · ${esc(recommendation.reasons[0])}` : ''}</small>` : ''}`}`;
    }
    function setStudyMode(mode, {preserveSelection = false} = {}) {
        const next = mode === 'territory' ? 'territory' : 'sites';
        state.studyMode = next;
        $('rf-study-sites')?.classList.toggle('active', next === 'sites');
        $('rf-study-territory')?.classList.toggle('active', next === 'territory');
        if (next === 'territory') {
            $('rf-territory').open = true;
            $('rf-execution-mode').value = 'territorial_tiled';
            if (Number($('rf-resolution').value) < 50) $('rf-resolution').value = '50';
            $('rf-current-view').checked = false;
            $('rf-current-view').disabled = true;
            renderExecutionMode();
        } else {
            if (state.territory && !preserveSelection) {
                clearTerritory();
                state.transmitters = [];
                state.selectedOperators.clear();
                renderOperatorFilter(); renderTransmitters();
            }
            $('rf-current-view').disabled = Boolean(state.aoiPolygon);
            autoConfigureStudy();
        }
        polygonStatus(); updateQuickGuide();
    }
    function autoConfigureStudy() {
        const active = simulationTransmitters();
        if (!state.territory) autoSelectSiteDatasetAndRadius(active);
        const selected = chooseDatasetForTransmitters();
        if (!selected || !active.length) { updateQuickGuide(); return; }
        const hasLocal3d = Boolean(selected.layers?.dhm || selected.layers?.buildings || selected.layers?.vegetation);
        const rural = !hasLocal3d && (selected.coverageType === 'regional' || String(selected.name || '').startsWith('Morocco_Rural'));
        $('rf-environment-mode').value = rural ? 'rural' : 'auto';
        if (state.studyMode === 'territory' || state.territory) {
            $('rf-execution-mode').value = 'territorial_tiled';
            $('rf-resolution').value = preferredTerritorialResolution();
        } else {
            const spanM = siteGroupSpanM(active);
            // A focused composite uses the exact reference engine up to 60
            // sectors.  Larger selected-site studies use the same bounded,
            // band-aware tiled engine as territorial studies; this supports
            // up to 600 sectors without an impractical sector × pixel loop.
            const sectorCount = active.length;
            const tiledComposite = sectorCount > 60;
            $('rf-execution-mode').value = tiledComposite ? 'territorial_tiled' : 'exact';
            $('rf-resolution').value = tiledComposite
                ? (sectorCount > 300 || spanM > 20000 ? '100' : '50')
                : (hasLocal3d && spanM <= 5000 ? '10' : spanM > 12000 ? '50' : '25');
        }
        renderExecutionMode(); renderDataset(); updateQuickGuide();
    }

    function savePanelLayout(root) {
        try {
            const r = root.getBoundingClientRect();
            localStorage.setItem('optim-rf-panel-layout-v1', JSON.stringify({left:r.left, top:r.top, width:r.width, height:r.height}));
        } catch (_) { /* A private browser window may deny localStorage. */ }
    }
    function restorePanelLayout(root) {
        try {
            const saved = JSON.parse(localStorage.getItem('optim-rf-panel-layout-v1') || 'null');
            if (!saved) return;
            const width = Math.max(360, Math.min(saved.width || 450, window.innerWidth - 20));
            const height = Math.max(360, Math.min(saved.height || 650, window.innerHeight - 20));
            root.style.width = `${width}px`; root.style.height = `${height}px`; root.style.maxHeight = 'none';
            root.style.left = `${Math.max(8, Math.min(saved.left || 20, window.innerWidth - width - 8))}px`;
            root.style.top = `${Math.max(8, Math.min(saved.top || 84, window.innerHeight - height - 8))}px`;
            root.style.right = 'auto';
        } catch (_) { /* Use the responsive default position. */ }
    }
    function enablePanelInteraction(root) {
        const head = root.querySelector('.rf-head');
        const resize = root.querySelector('.rf-resize-handle');
        const begin = (event, mode) => {
            if (event.button !== 0 || (mode === 'move' && event.target.closest('button,input,select'))) return;
            event.preventDefault();
            const rect = root.getBoundingClientRect();
            // Convert the initial responsive right position to explicit pixels.
            root.style.left = `${rect.left}px`; root.style.top = `${rect.top}px`; root.style.right = 'auto';
            if (mode === 'resize') root.style.maxHeight = 'none';
            const initial = {x:event.clientX, y:event.clientY, left:rect.left, top:rect.top, width:rect.width, height:rect.height};
            root.classList.add(mode === 'move' ? 'rf-dragging' : 'rf-resizing');
            const move = e => {
                if (mode === 'move') {
                    const left = Math.max(8, Math.min(initial.left + e.clientX - initial.x, window.innerWidth - rect.width - 8));
                    const top = Math.max(8, Math.min(initial.top + e.clientY - initial.y, window.innerHeight - rect.height - 8));
                    root.style.left = `${left}px`; root.style.top = `${top}px`;
                } else {
                    const width = Math.max(360, Math.min(initial.width + e.clientX - initial.x, window.innerWidth - initial.left - 8));
                    const height = Math.max(360, Math.min(initial.height + e.clientY - initial.y, window.innerHeight - initial.top - 8));
                    root.style.width = `${width}px`; root.style.height = `${height}px`;
                }
            };
            const end = () => {
                root.classList.remove('rf-dragging', 'rf-resizing');
                window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end);
                savePanelLayout(root);
            };
            window.addEventListener('pointermove', move); window.addEventListener('pointerup', end, {once:true});
        };
        head.addEventListener('pointerdown', e => begin(e, 'move'));
        resize.addEventListener('pointerdown', e => begin(e, 'resize'));
    }

    function renderDataset() {
        const selected = state.datasets.find(d => d.datasetId === state.selectedDataset);
        const bounds = selected?.wgs84Bounds;
        const extent = Array.isArray(bounds) && bounds.length === 4
            ? ` · emprise lon ${Number(bounds[0]).toFixed(3)} → ${Number(bounds[2]).toFixed(3)}, lat ${Number(bounds[1]).toFixed(3)} → ${Number(bounds[3]).toFixed(3)}` : '';
        if (!selected) {
            $('rf-dataset-info').textContent = 'Aucun GeoData disponible';
            return;
        }
        const label = `${selected.name} · ${selected.coverageType === 'regional' ? 'emprise régionale' : 'étude locale'} · ${selected.resolution ? selected.resolution.join(' × ') + ' m' : 'résolution en préparation'} · ${selected.crs || 'CRS inconnu'}${extent}`;
        $('rf-dataset-info').innerHTML = selected.rfReady === false
            ? `${esc(label)}<br><span class="rf-error">⚠ Ce MNT est en coordonnées géographiques. Préparez ou sélectionnez un dataset UTM métrique avant le calcul RF.</span>`
            : `${esc(label)}${selected.name === 'Morocco_Rural_Study' ? '<br><span class="rf-rural-base">✓ Étude rurale UTM prête pour son emprise. Préparez une nouvelle étude pour une zone éloignée.</span>' : ''}`;
    }
    function renderMoroccoPack() {
        const status = state.moroccoPack;
        const target = $('rf-pack-status');
        if (!target) return;
        if (!status?.available) {
            target.innerHTML = '<span class="rf-error">Pack Maroc introuvable. Vérifiez GeoData/morocco_geodata_pack.</span>';
            return;
        }
        const layers = Object.entries(status.layers || {}).filter(([, available]) => available).map(([name]) => name).join(', ');
        const base = status.ruralBase;
        if (!$('rf-pack-dem').value && base?.sourceExists) $('rf-pack-dem').value = base.sourceDem;
        target.innerHTML = `<b>Pack Maroc détecté</b> · couches : ${esc(layers || 'aucune')}.<br>${esc(status.message || 'MNT requis.')}`;
    }
    async function refreshDatasets(preferredPath = '') {
        const cat = await window.rfApi.catalog();
        state.datasets = cat.datasets || [];
        $('rf-dataset').innerHTML = state.datasets.map(ds => {
            const readiness = ds.rfReady === false ? ' · ⚠ UTM requis' : '';
            return `<option value="${esc(ds.datasetId)}">${esc(ds.name)} · ${esc(ds.coverageType || '')}${readiness}</option>`;
        }).join('');
        const preferred = state.datasets.find(ds => ds.path === preferredPath);
        if (preferred) state.selectedDataset = preferred.datasetId;
        const current = state.datasets.find(ds => ds.datasetId === state.selectedDataset);
        if (!current || current.rfReady === false) {
            state.selectedDataset = state.datasets.find(ds => ds.rfReady !== false)?.datasetId || state.datasets[0]?.datasetId || '';
        }
        $('rf-dataset').value = state.selectedDataset;
        renderDataset();
    }
    async function prepareMoroccoPack() {
        const m = map();
        const demPath = $('rf-pack-dem').value.trim();
        if (!m) { $('rf-pack-status').innerHTML = '<span class="rf-error">Carte indisponible : choisissez le centre de l’étude plus tard.</span>'; return; }
        if (!demPath) { $('rf-pack-status').innerHTML = '<span class="rf-error">Indiquez le chemin absolu de votre MNT GeoTIFF/ASC/IMG.</span>'; return; }
        // A simulation is about its selected transmitters.  Prefer their
        // centroid so a user does not accidentally prepare Rabat GeoData while
        // inspecting a Beni Mellal sector in a different map viewport.
        const selected = simulationTransmitters().filter(tx => Number.isFinite(Number(tx.lat)) && Number.isFinite(Number(tx.lon)));
        const center = selected.length
            ? {lat:selected.reduce((sum, tx) => sum + Number(tx.lat), 0) / selected.length, lng:selected.reduce((sum, tx) => sum + Number(tx.lon), 0) / selected.length}
            : m.getCenter();
        const centerSource = selected.length ? `${selected.length} secteur(s) sélectionné(s)` : 'vue actuelle de la carte';
        const button = $('rf-pack-prepare'); button.disabled = true;
        $('rf-pack-status').textContent = `Préparation autour de ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)} (${centerSource})…`;
        try {
            let name = $('rf-pack-name').value.trim() || 'Morocco_Rural_Study';
            // The original base is intentionally AOI-scoped.  Creating a
            // study around another group must never overwrite that reference.
            if (name === 'Morocco_Rural_Study') {
                name = `Morocco_Rural_${center.lat.toFixed(3).replace('.', '_')}_${center.lng.toFixed(3).replace('-', 'm').replace('.', '_')}`;
                $('rf-pack-name').value = name;
            }
            const response = await window.rfApi.prepareMoroccoPack({
                demPath,
                name,
                centerLat: center.lat,
                centerLon: center.lng,
                radiusM: Number($('rf-pack-radius').value || 10000),
            });
            await refreshDatasets(response.dataset?.path || '');
            $('rf-environment-mode').value = 'rural';
            $('rf-pack-status').innerHTML = `<b>✓ Dataset prêt :</b> ${esc(response.dataset?.name || 'Morocco Rural')} · DTM + clutter. Sélectionnez vos secteurs puis lancez le précontrôle.`;
            return true;
        } catch (err) {
            $('rf-pack-status').innerHTML = `<span class="rf-error">${esc(err.message)}</span>`;
            return false;
        } finally { button.disabled = false; }
    }
    async function quickPrepareRural() {
        const selected = simulationTransmitters().filter(tx => Number.isFinite(Number(tx.lat)) && Number.isFinite(Number(tx.lon)));
        if (!selected.length) {
            $('rf-pack').open = true;
            $('rf-pack-status').innerHTML = '<span class="rf-error">Sélectionnez d’abord au moins un site ou secteur à l’étape 2.</span>';
            return;
        }
        const button = $('rf-rural-quick');
        button.disabled = true;
        try {
            prepareRuralForSelectedGroup();
            // The standard national DEM is pre-filled from the repaired rural
            // base.  Start immediately: the action is a local derived-cache
            // write scoped to the currently selected transmitters.
            const prepared = await prepareMoroccoPack();
            if (prepared) await check();
        } finally { button.disabled = false; }
    }
    async function prepareAutomaticRuralDataset() {
        // This is deliberately only called after the user presses Calculate.
        // It avoids unexpected disk work while the user is still building a
        // composite, but keeps the normal execution workflow to one action.
        prepareRuralForSelectedGroup();
        $('rf-progress').textContent = 'Préparation automatique du terrain rural UTM couvrant tous les sites…';
        const prepared = await prepareMoroccoPack();
        if (prepared) {
            $('rf-environment-mode').value = 'rural';
            autoConfigureStudy();
        }
        return prepared;
    }
    function prepareRuralForSelectedGroup() {
        const pack = $('rf-pack');
        if (pack) pack.open = true;
        const base = state.moroccoPack?.ruralBase;
        if (base?.sourceExists && !$('rf-pack-dem').value) $('rf-pack-dem').value = base.sourceDem;
        $('rf-pack-name').value = 'Morocco_Rural_Study';
        const points = simulationTransmitters().filter(tx => Number.isFinite(Number(tx.lat)) && Number.isFinite(Number(tx.lon)));
        if (points.length) {
            const lat = points.reduce((total, tx) => total + Number(tx.lat), 0) / points.length;
            const lon = points.reduce((total, tx) => total + Number(tx.lon), 0) / points.length;
            const farthestM = Math.max(0, ...points.map(tx => Math.hypot((Number(tx.lat) - lat) * 111320, (Number(tx.lon) - lon) * 111320 * Math.cos(lat * Math.PI / 180))));
            // The prepared DTM must cover the complete *output* AOI, not only
            // the selected sites.  The local simulation uses a circle around
            // the group centroid whose radius is at least the user's study
            // radius.  Keep 3 km around it for path/Fresnel sampling.
            const requestedRadius = Number($('rf-radius').value || 5000);
            const simulationRadius = Math.max(requestedRadius, Math.ceil(farthestM + (points.length > 1 ? 500 : 0)));
            const suggestedRadius = Math.min(50000, Math.max(Number($('rf-pack-radius').value || 10000), simulationRadius + 3000));
            $('rf-pack-radius').value = suggestedRadius;
            $('rf-pack-status').innerHTML = `<b>Préparation proposée :</b> nouvelle étude rurale UTM autour de ${points.length} secteur(s), centre ${lat.toFixed(4)}, ${lon.toFixed(4)}, rayon ${suggestedRadius.toLocaleString()} m (AOI simulation ${simulationRadius.toLocaleString()} m + marge RF 3 km). Cliquez « Préparer DTM + clutter rural ».`;
        }
    }
    async function repairMoroccoRuralStudy() {
        const button = $('rf-pack-repair');
        button.disabled = true;
        $('rf-pack-status').textContent = 'Reprojection de Morocco_Rural_Study en UTM métrique et reconstruction du clutter…';
        try {
            const response = await window.rfApi.repairMoroccoPack('Morocco_Rural_Study');
            await refreshDatasets(response.dataset?.path || '');
            $('rf-environment-mode').value = 'rural';
            $('rf-pack-status').innerHTML = '<b>✓ Morocco_Rural_Study est maintenant RF-ready :</b> DTM UTM métrique + clutter rural.';
        } catch (err) {
            $('rf-pack-status').innerHTML = `<span class="rf-error">${esc(err.message)}</span>`;
        } finally { button.disabled = false; }
    }
    function bandKey(value, technology = '') {
        const raw = String(value || '').trim().toUpperCase().replace(/[\[\]]/g, '');
        const digits = raw.replace(/\D/g, '');
        return String(technology || '').toUpperCase() === 'NR' && digits ? `N${digits}` : raw;
    }
    function selectedBandLabel() {
        return [...state.selectedBands].filter(Boolean).join(', ');
    }
    // A site is a convenient BDD grouping, but it must never override the
    // user's active band filter.  Keep this rule in one place because sites
    // can be added through search results or directly from the map.
    function transmittersForSelectedBands(items) {
        return (items || []).filter(tx => tx && state.selectedBands.has(bandKey(tx.band, tx.technology)));
    }
    function simulationTransmitters() {
        return state.transmitters.filter(tx => state.selectedBands.has(bandKey(tx.band, tx.technology)) && state.selectedOperators.has(String(tx.operator || 'UNKNOWN').toUpperCase()));
    }
    // Recover a stale operator selection, but never broaden the band filter.
    // Choosing L1800 must stay L1800 when a complete site is added.
    function ensureGuidedSelection() {
        if (!state.transmitters.length || simulationTransmitters().length) return false;
        const bandMatched = transmittersForSelectedBands(state.transmitters);
        if (!bandMatched.length) return false;
        const operators = [...new Set(bandMatched.map(tx => String(tx.operator || 'UNKNOWN').toUpperCase()))];
        const currentOperator = [...state.selectedOperators].find(operator => operators.includes(operator));
        const operator = currentOperator || ['IAM', 'ORANGE', 'INWI'].find(item => operators.includes(item)) || operators[0];
        if (!operator) return false;
        state.selectedOperators = new Set([operator]);
        renderOperatorFilter();
        renderTransmitters();
        updateQuickGuide('Opérateur corrigé automatiquement pour les secteurs compatibles avec les bandes cochées.');
        return simulationTransmitters().length > 0;
    }
    function renderOperatorFilter() {
        const target = $('rf-operator-filter');
        if (!target) return;
        const fixed = ['IAM', 'ORANGE', 'INWI'];
        const operators = [...new Set(state.transmitters.map(tx => String(tx.operator || 'UNKNOWN').toUpperCase()))]
            .sort((left, right) => (fixed.indexOf(left) < 0 ? 99 : fixed.indexOf(left)) - (fixed.indexOf(right) < 0 ? 99 : fixed.indexOf(right)) || left.localeCompare(right));
        if (!operators.length) { target.innerHTML = '<span class="rf-muted">Sélectionnez un territoire ou un site.</span>'; return; }
        target.innerHTML = operators.map(operator => {
            const count = state.transmitters.filter(tx => String(tx.operator || 'UNKNOWN').toUpperCase() === operator).length;
            return `<label class="rf-operator-chip"><input type="radio" name="rf-operator" value="${esc(operator)}"${state.selectedOperators.has(operator) ? ' checked' : ''}><span>${esc(operator)}</span><small>${count} secteurs</small></label>`;
        }).join('');
        target.querySelectorAll('input[type=radio]').forEach(input => input.onchange = () => {
            state.selectedOperators = new Set(input.checked ? [input.value] : []);
            renderOperatorFilter(); renderTransmitters(); autoConfigureStudy(); renderTerritorySummary(); void refreshRecommendation({silent:true});
        });
    }
    function renderBandFilter() {
        const target = $('rf-band-filter');
        if (!target) return;
        if (!state.bandOptions.length) {
            target.innerHTML = '<span class="rf-muted">Aucune bande RF disponible dans la BDD.</span>';
            return;
        }
        target.innerHTML = state.bandOptions.map(item => {
            const key = bandKey(item.band, item.technology);
            const checked = state.selectedBands.has(key) ? ' checked' : '';
            const tech = item.technology === 'NR' ? ' nr' : ' lte';
            return `<label class="rf-band-chip${tech}"><input type="checkbox" value="${esc(key)}"${checked}><span>${esc(item.band)}</span><small>${item.siteCount} sites</small></label>`;
        }).join('');
        target.querySelectorAll('input[type=checkbox]').forEach(input => {
            input.onchange = () => {
                if (input.checked) state.selectedBands.add(input.value); else state.selectedBands.delete(input.value);
                renderOperatorFilter(); renderTransmitters(); renderMapSiteAction();
                autoConfigureStudy();
                renderTerritorySummary();
            };
        });
    }
    function renderTerritorySummary() {
        const summary = $('rf-territory-summary');
        if (!summary || !state.territory) return;
        const active = simulationTransmitters();
        const external = state.transmitters.filter(tx => !state.territory.memberIds?.has(tx.id));
        const externalText = external.length ? ` · ${external.length} secteur${external.length > 1 ? 's' : ''} extérieur${external.length > 1 ? 's' : ''} ajouté${external.length > 1 ? 's' : ''}` : '';
        const isProvince = state.territory.area.level === 'province';
        const provinceName = isProvince ? provinceDatasetName(state.territory.area) : '';
        const prepared = isProvince && state.datasets.some(ds => ds.name === provinceName && ds.rfReady !== false);
        const provinceAction = isProvince
            ? `<button id="rf-territory-prepare-province" type="button" class="rf-province-prepare">${prepared ? '✓ Terrain rural UTM prêt — réutiliser' : '🌍 Préparer le terrain rural UTM de cette province'}</button><small class="rf-province-help">Préparation persistante unique : MNT + clutter pour toute la province, avec 3 km de marge RF.</small>`
            : '';
        const execution = $('rf-execution-mode')?.value === 'territorial_tiled'
            ? 'Mode tuilé territorial · 50 m minimum · candidats locaux + raffinement terrain/Fresnel/diffraction'
            : 'Mode exact local · limites strictes secteur/site';
        summary.innerHTML = `<div class="rf-territory-active"><b>✓ ${esc(state.territory.area.name)}</b><small>${state.territory.siteCount} sites · ${state.territory.sectorCount} secteurs BDD dans la limite${externalText} · ${active.length} actifs avec les bandes/opérateurs cochés</small><small class="rf-territory-mode">${execution}</small>${provinceAction}<button id="rf-territory-clear" type="button">Quitter le mode territorial</button></div>`;
        $('rf-territory-clear').onclick = () => {
            clearTerritory();
            $('rf-territory-results').innerHTML = '';
            setScenarioType('rural_sites', {preserveSelection:true});
            renderTransmitters();
        };
        $('rf-territory-prepare-province')?.addEventListener('click', prepareRuralProvince);
    }
    function provinceDatasetName(area) {
        return `Morocco_Rural_Province_${String(area?.id || area?.name || 'unknown').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 55)}`;
    }
    async function prepareRuralProvince() {
        const territory = state.territory;
        const area = territory?.area;
        const base = state.moroccoPack?.ruralBase;
        if (!area || area.level !== 'province') return false;
        if (!Array.isArray(area.bounds) || area.bounds.length !== 4) {
            $('rf-progress').textContent = 'Limite provinciale indisponible : rechargez la province avant préparation.';
            return false;
        }
        if (!base?.sourceExists) {
            const pack = $('rf-pack'); if (pack) pack.open = true;
            $('rf-pack-status').innerHTML = '<span class="rf-error">Le MNT Maroc source est introuvable. Indiquez son chemin local dans les options avancées.</span>';
            return false;
        }
        const button = $('rf-territory-prepare-province');
        if (button) button.disabled = true;
        const name = provinceDatasetName(area);
        $('rf-progress').textContent = `Préparation UTM persistante de ${area.name} : extraction du MNT et du clutter provincial…`;
        try {
            const response = await window.rfApi.prepareMoroccoProvince({
                demPath: base.sourceDem,
                name,
                bounds: area.bounds,
                provinceId: area.id,
                provinceName: area.name,
            });
            await refreshDatasets(response.dataset?.path || '');
            $('rf-environment-mode').value = 'rural';
            const preparation = response.metadata?.preparation || {};
            const terrainDetail = preparation.targetResolutionM
                ? ` · relief préparé à ${Number(preparation.targetResolutionM).toLocaleString('fr-FR')} m${preparation.sourceResampled ? ' depuis le MNT source' : ''}`
                : '';
            $('rf-progress').textContent = response.reused
                ? `✓ Terrain rural UTM existant réutilisé : ${response.dataset?.name || name}.`
                : `✓ Terrain rural UTM prêt pour toute la province : ${response.dataset?.name || name}${terrainDetail}.`;
            renderTerritorySummary();
            autoConfigureStudy();
            return true;
        } catch (err) {
            $('rf-progress').textContent = `Préparation provinciale impossible : ${err.message}`;
            if (button) button.disabled = false;
            return false;
        }
    }
    async function prepareAutomaticTerritoryDataset() {
        const area = state.territory?.area;
        const base = state.moroccoPack?.ruralBase;
        const bounds = area?.bounds;
        if (!area || !Array.isArray(bounds) || bounds.length !== 4 || !base?.sourceExists) return false;
        if (area.level === 'province') return prepareRuralProvince();
        const [west, south, east, north] = bounds.map(Number);
        const centerLat = (south + north) / 2;
        const centerLon = (west + east) / 2;
        const radiusM = Math.min(50000, Math.ceil(Math.hypot((north - south) * 111320, (east - west) * 111320 * Math.cos(centerLat * Math.PI / 180)) / 2 + 3000));
        const safeId = String(area.id || area.name || 'territory').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 55);
        $('rf-progress').textContent = `Préparation automatique du terrain UTM de ${area.name}…`;
        try {
            const response = await window.rfApi.prepareMoroccoPack({
                demPath: base.sourceDem,
                name: `Morocco_Rural_${safeId}`,
                centerLat, centerLon, radiusM,
            });
            await refreshDatasets(response.dataset?.path || '');
            autoConfigureStudy();
            return true;
        } catch (err) {
            $('rf-progress').textContent = `Préparation automatique impossible : ${err.message}`;
            return false;
        }
    }
    function clearTerritory({keepTransmitters = false} = {}) {
        if (state.territoryLayer && map()) map().removeLayer(state.territoryLayer);
        state.territoryLayer = null;
        state.territory = null;
        if (!keepTransmitters) { state.transmitters = []; state.selectedOperators.clear(); }
        const summary = $('rf-territory-summary');
        if (summary) summary.innerHTML = '';
        const view = $('rf-current-view');
        if (view) view.disabled = Boolean(state.aoiPolygon);
    }
    function showTerritoryBoundary(geometry) {
        const m = map();
        if (!m || !window.L || !geometry) return;
        if (state.territoryLayer) m.removeLayer(state.territoryLayer);
        state.territoryLayer = L.geoJSON(geometry, {
            interactive: false,
            style: {color:'#38bdf8', weight:2, opacity:.95, fillColor:'#0ea5e9', fillOpacity:.06, dashArray:'6 5'},
        }).addTo(m);
        const bounds = state.territoryLayer.getBounds();
        if (bounds.isValid()) m.fitBounds(bounds.pad(.08));
    }
    async function updateTerritoryChooser() {
        const level = $('rf-territory-level').value;
        const provinceWrap = $('rf-territory-province-wrap');
        const searchWrap = $('rf-territory-search-wrap');
        const find = $('rf-territory-find');
        const results = $('rf-territory-results');
        const provinceList = $('rf-territory-province-list');
        const isProvince = level === 'province';
        provinceWrap.hidden = !isProvince;
        searchWrap.hidden = isProvince;
        find.hidden = isProvince;
        results.innerHTML = '';
        if (!isProvince) return;
        provinceList.innerHTML = '<option value="">Chargement de la liste des provinces…</option>';
        try {
            const response = await window.rfApi.adminAreas('province', '', 100);
            state.provinceOptions = response.items || [];
            provinceList.innerHTML = '<option value="">— Choisir une province / préfecture —</option>' + state.provinceOptions.map((area, index) =>
                `<option value="${index}">${esc(area.name)} · ${esc(area.id)}</option>`
            ).join('');
        } catch (err) {
            provinceList.innerHTML = '<option value="">Liste indisponible</option>';
            results.innerHTML = `<div class="rf-error">${esc(err.message)}</div>`;
        }
    }
    async function searchTerritory() {
        const level = $('rf-territory-level').value;
        const q = $('rf-territory-search').value.trim();
        const target = $('rf-territory-results');
        target.innerHTML = '<div class="rf-muted">Recherche des limites administratives locales…</div>';
        try {
            const response = await window.rfApi.adminAreas(level, q, 30);
            state.territoryCandidates = response.items || [];
            target.innerHTML = state.territoryCandidates.length ? state.territoryCandidates.map((area, index) =>
                `<button type="button" class="rf-territory-candidate" data-rf-territory="${index}"><b>${esc(area.name)}</b><small>${esc(area.level)} · ${esc(area.id)}</small></button>`
            ).join('') : '<div class="rf-muted">Aucun territoire trouvé. Essayez un autre nom.</div>';
            target.querySelectorAll('[data-rf-territory]').forEach(button => {
                button.onclick = () => selectTerritory(state.territoryCandidates[Number(button.dataset.rfTerritory)]);
            });
        } catch (err) { target.innerHTML = `<div class="rf-error">${esc(err.message)}</div>`; }
    }
    function mapSiteLabel(detail) {
        return detail?.siteName || detail?.cellName || detail?.cellId || 'Site sélectionné sur la carte';
    }
    function renderMapSiteAction() {
        const target = $('rf-map-site-action');
        if (!target) return;
        const detail = state.mapSiteCandidate;
        if (!detail) { target.hidden = true; target.innerHTML = ''; return; }
        const label = mapSiteLabel(detail);
        target.hidden = false;
        const group = state.mapSiteResolvedGroup;
        const resolving = !group && !state.mapSiteError;
        const matching = group ? transmittersForSelectedBands(groupTransmitters(group)) : [];
        const noBandMatch = Boolean(group) && !matching.length;
        const actionLabel = group
            ? noBandMatch
                ? 'Aucun secteur dans les bandes cochées'
                : `＋ Ajouter ${group.site || label} · ${matching.length} secteur${matching.length > 1 ? 's' : ''}`
            : resolving ? 'Recherche du site BDD…' : '＋ Ajouter ce site au groupe';
        const bandHint = group ? `<small class="${noBandMatch ? 'rf-error' : 'rf-muted'}">${noBandMatch ? `Aucune porteuse ${esc(selectedBandLabel() || 'sélectionnée')} sur ce site.` : `Bandes retenues : ${esc(selectedBandLabel())}.`}</small>` : '';
        target.innerHTML = `<b>📍 Site sélectionné sur la carte</b><small>${esc(label)}${detail.cellName && detail.cellName !== label ? ` · ${esc(detail.cellName)}` : ''}</small><button id="rf-add-map-site" type="button" ${(resolving || noBandMatch) ? 'disabled' : ''}>${esc(actionLabel)}</button>${bandHint}${state.mapSiteError ? `<small class="rf-error">${esc(state.mapSiteError)}</small>` : ''}`;
        $('rf-add-map-site').onclick = addMapSiteToSimulation;
    }
    function normalizedMapSiteText(value) { return String(value || '').trim().toLocaleLowerCase(); }
    function mapSiteScore(group, detail) {
        const groupSite = normalizedMapSiteText(group.site);
        const names = [detail.siteName, detail.cellName, detail.cellId, detail.rawEnodebCellId].map(normalizedMapSiteText).filter(Boolean);
        let score = names.reduce((best, name) => Math.max(best, groupSite === name ? 1000 : groupSite.includes(name) || name.includes(groupSite) ? 300 : 0), 0);
        for (const tx of group.transmitters || []) {
            const cell = normalizedMapSiteText(tx.cell);
            if (names.includes(cell)) score = Math.max(score, 900);
            const dLat = Number(tx.lat) - Number(detail.lat);
            const dLon = Number(tx.lon) - Number(detail.lng);
            if (Number.isFinite(dLat) && Number.isFinite(dLon)) score = Math.max(score, 100 - Math.hypot(dLat, dLon) * 10000);
        }
        return score;
    }
    function mapSiteQueries(detail) {
        return [...new Set([
            detail?.siteName, detail?.cellName, detail?.cellId, detail?.rawEnodebCellId,
            detail?.calculatedEci,
        ].map(value => String(value || '').trim()).filter(Boolean))];
    }
    async function resolveMapSiteGroup(detail) {
        const queries = mapSiteQueries(detail);
        let groups = [];
        for (const query of queries) {
            const response = await window.rfApi.siteGroups(query, {}, 100);
            groups.push(...(response.items || []));
        }
        const uniqueGroups = [...new Map(groups.map(group => [group.key || `${group.operator}|${group.site}`, group])).values()];
        let ranked = uniqueGroups.map(item => ({item, score: mapSiteScore(item, detail)})).sort((a, b) => b.score - a.score);
        if (ranked[0]?.item) return ranked[0].item;

        // Some map layers expose a display label rather than the exact BDD
        // site name. Resolve the sector first, then recover its physical site.
        const sectors = [];
        for (const query of queries) {
            const response = await window.rfApi.sectors(query, {}, 100);
            sectors.push(...(response.items || []));
        }
        const bestSector = sectors.map(item => ({item, score: mapSiteScore({site:item.site, transmitters:[item]}, detail)}))
            .sort((a, b) => b.score - a.score)[0]?.item;
        if (!bestSector) return null;
        const response = await window.rfApi.siteGroups(bestSector.site || bestSector.cell || '', {}, 100);
        ranked = (response.items || []).map(item => ({item, score: mapSiteScore(item, detail)})).sort((a, b) => b.score - a.score);
        return ranked[0]?.item || null;
    }
    // The 5G BDD can legitimately omit the operator while the colocated LTE
    // records identify the physical site (for example IAM LTE + NR cells at
    // the same 4G site).  A site-group result is already the authoritative
    // grouping from the backend, so inherit its operator only for blank child
    // records.  Do not overwrite an explicitly populated operator.
    function groupTransmitters(group) {
        const inheritedOperator = String(group?.operator || '').trim();
        return (group?.transmitters || []).map(tx => ({
            ...tx,
            operator: String(tx?.operator || '').trim() || inheritedOperator,
        }));
    }
    async function primeMapSiteGroup(detail) {
        const token = ++state.mapSiteLookupToken;
        state.mapSiteResolvedGroup = null;
        state.mapSiteError = '';
        renderMapSiteAction();
        try {
            const group = await resolveMapSiteGroup(detail);
            if (token !== state.mapSiteLookupToken || state.mapSiteCandidate !== detail) return;
            if (!group) throw new Error(`Aucun site RF BDD ne correspond à « ${mapSiteLabel(detail)} ».`);
            state.mapSiteResolvedGroup = group;
            const matching = transmittersForSelectedBands(groupTransmitters(group));
            $('rf-progress').textContent = matching.length
                ? `Site carte prêt : ${group.site} · ${matching.length} secteur${matching.length > 1 ? 's' : ''} compatible${matching.length > 1 ? 's' : ''} avec ${selectedBandLabel()}. Cliquez « Ajouter ». `
                : `Le site carte ${group.site} ne possède aucun secteur dans les bandes cochées (${selectedBandLabel() || 'aucune'}).`;
        } catch (err) {
            if (token !== state.mapSiteLookupToken || state.mapSiteCandidate !== detail) return;
            state.mapSiteError = err.message;
        }
        renderMapSiteAction();
    }
    async function addMapSiteToSimulation() {
        const detail = state.mapSiteCandidate;
        const button = $('rf-add-map-site');
        if (!detail || !button) return;
        button.disabled = true;
        button.textContent = 'Recherche du site BDD…';
        try {
            // The lookup normally runs immediately after the map click. Keep a
            // retry here for a temporary API failure, but never discard the
            // resolved physical BDD site while the user is deciding to add it.
            const group = state.mapSiteResolvedGroup || await resolveMapSiteGroup(detail);
            if (!group) throw new Error(`Aucun site RF BDD ne correspond à « ${mapSiteLabel(detail)} ».`);
            state.mapSiteError = '';
            const added = addTransmitters(groupTransmitters(group), `Le site carte ${group.site}`);
            if (added) {
                state.mapSiteCandidate = null;
                state.mapSiteResolvedGroup = null;
                renderMapSiteAction();
            } else {
                button.disabled = false;
                button.textContent = '＋ Ajouter ce site au groupe';
            }
        } catch (err) {
            state.mapSiteError = err.message;
            button.disabled = false;
            button.textContent = '＋ Ajouter ce site au groupe';
            renderMapSiteAction();
            $('rf-progress').textContent = `Site non ajouté : ${err.message} Recherchez-le manuellement à l’étape 2.`;
        }
    }
    async function selectTerritory(area) {
        if (!area) return;
        // Administrative and manually drawn AOIs are mutually exclusive.
        if (state.aoiPolygon) clearManualAoi();
        const summary = $('rf-territory-summary');
        summary.innerHTML = '<div class="rf-muted">Chargement des secteurs BDD situés dans le territoire…</div>';
        try {
            // Fetch every sector once.  Band checkboxes then remain instant and
            // can be adjusted before the expensive propagation calculation.
            const response = await window.rfApi.adminAreaSectors(area.level, area.id);
            state.studyMode = 'territory';
            state.scenarioType = area.level === 'province' ? 'province' : 'commune';
            clearTerritory({keepTransmitters:true});
            state.transmitters = (response.transmitters || []).map(tx => ({...tx}));
            const defaultOperator = ['IAM', 'ORANGE', 'INWI'].find(operator => state.transmitters.some(tx => String(tx.operator || '').toUpperCase() === operator));
            state.selectedOperators = new Set(defaultOperator ? [defaultOperator] : []);
            state.transmitters.forEach(tx => state.selectedBands.add(bandKey(tx.band, tx.technology)));
            state.territory = {area: response.area, geometry: response.geometry, sectorCount: response.sectorCount, siteCount: response.siteCount, memberIds: new Set(state.transmitters.map(tx => tx.id))};
            $('rf-current-view').checked = false;
            $('rf-current-view').disabled = true;
            setStudyMode('territory', {preserveSelection:true});
            showTerritoryBoundary(response.geometry);
            renderTerritorySummary();
            renderOperatorFilter();
            renderTransmitters();
            autoConfigureStudy();
            await refreshRecommendation();
        } catch (err) { summary.innerHTML = `<div class="rf-error">${esc(err.message)}</div>`; }
    }
    function renderTransmitters() {
        const target = $('rf-transmitters');
        const sites = new Set(state.transmitters.map(tx => siteKey(tx)));
        const active = simulationTransmitters();
        const territoryTitle = state.territory ? ` · <span class="rf-territory-tag">${esc(state.territory.area.name)}</span>` : '';
        const heading = state.transmitters.length ? `<div class="rf-selection-summary"><b>${active.length} secteur${active.length > 1 ? 's' : ''} actif${active.length > 1 ? 's' : ''} / ${state.transmitters.length} · ${sites.size} site${sites.size > 1 ? 's' : ''}${territoryTitle}</b><button id="rf-clear-tx">Vider</button></div>` : '';
        const grouped = [...state.transmitters.reduce((map, tx) => {
            const key = siteKey(tx);
            if (!map.has(key)) map.set(key, {key, name:tx.site || tx.cell || 'Site', operator:String(tx.operator || 'UNKNOWN').toUpperCase(), items:[]});
            map.get(key).items.push(tx); return map;
        }, new Map()).values()];
        const siteCards = grouped.map((site, index) => {
            const bands = [...new Set(site.items.map(tx => bandKey(tx.band, tx.technology)))].join(', ');
            return `<div class="rf-site-selection"><div><b>${esc(site.name)}</b><small>${esc(site.operator)} · ${site.items.length} secteur(s) · ${esc(bands)}</small></div><button type="button" data-rf-remove-site="${index}" title="Retirer ce site">×</button></div>`;
        }).join('');
        // A commune can legitimately contain hundreds of BDD sectors.  Keep
        // the full selection in memory for the band filter and preflight, but
        // do not freeze the panel by rendering hundreds of DOM cards.
        const displayed = state.transmitters.slice(0, 100);
        const overflow = state.transmitters.length > displayed.length ? `<div class="rf-muted">Affichage des ${displayed.length} premiers secteurs sur ${state.transmitters.length}. Utilisez les bandes pour réduire le calcul.</div>` : '';
        const sectorCards = displayed.map((tx, i) => {
            const isActive = state.selectedBands.has(bandKey(tx.band, tx.technology));
            const bddRs = tx.referenceSignalPowerDbm == null ? '' : ` · RS ${Number(tx.referenceSignalPowerDbm).toFixed(1)} dBm BDD`;
            const eirp = tx.referenceSignalEirpDbm == null ? '⚠ EIRP exploratoire 46 dBm'
                : tx.eirpDerivation?.rule === 'operator-input_huawei_n78_aau_exploratory_template'
                    ? `EIRP scénario ${Number(tx.referenceSignalEirpDbm).toFixed(1)} dBm`
                    : `EIRP dérivée ${Number(tx.referenceSignalEirpDbm).toFixed(1)} dBm`;
            const frequency = Number(tx.frequencyMHz || 0).toFixed(1);
            const ret = tx.retMatchStatus === 'matched' && tx.antennaSerialNumber
                ? ` · RET Huawei ✓ SN ${esc(tx.antennaSerialNumber)}`
                : tx.retMatchStatus === 'ambiguous-port'
                    ? ` · RET Huawei ⚠ ${Number(tx.antennaSerialNumbers?.length || 0)} ports, SN à confirmer`
                    : '';
            const pattern = tx.antennaPatternId && String(tx.antennaPatternId).startsWith('msi:')
                ? ` · 📡 Antenne MSI mesurée ${esc(String(tx.antennaPatternId).slice(4))} (EIRP recalculée au lancement)`
                : tx.antennaPatternId && tx.eirpDerivation?.profile
                    ? tx.eirpDerivation?.rule === 'operator-input_huawei_n78_aau_exploratory_template'
                        ? ` · ${esc(tx.eirpDerivation.profile)} (enveloppe exploratoire)`
                        : ` · ${esc(tx.eirpDerivation.profile)} (enveloppe fiche technique)`
                    : '';
            const assumption = tx.rfAssumption ? `<small class="rf-warning">⚠ ${esc(tx.rfAssumption)}</small>` : '';
            return `<div class="rf-tx${isActive ? '' : ' rf-tx-excluded'}"><span class="rf-tech ${tx.technology === 'NR' ? 'nr' : ''}">${esc(tx.technology || 'LTE')}</span><div><b>${esc(tx.cell || 'Cellule')}</b><small>${esc(tx.site || '—')} · ${esc(tx.band || '—')} · ${frequency} MHz${isActive ? '' : ' · exclue par filtre bande'}</small><small>${eirp}${bddRs} · H ${tx.antennaHeightAglM ?? '—'} m · tilt ${tx.totalTiltDeg ?? '—'}°${ret}${pattern}</small>${assumption}</div><button data-rf-remove="${i}" title="Retirer">×</button></div>`;
        }).join('');
        target.innerHTML = state.transmitters.length ? `${heading}<div class="rf-site-selection-list">${siteCards}</div>${overflow}<details class="rf-sector-detail-list"><summary>Détail des ${state.transmitters.length} secteurs</summary>${sectorCards}</details>` : '<div class="rf-muted">Aucun émetteur sélectionné.</div>';
        $('rf-clear-tx')?.addEventListener('click', () => {
            clearTerritory();
            state.studyMode = 'sites';
            renderOperatorFilter();
            renderTransmitters();
            setStudyMode('sites', {preserveSelection:true});
        });
        target.querySelectorAll('[data-rf-remove-site]').forEach(button => button.onclick = () => {
            const site = grouped[Number(button.dataset.rfRemoveSite)];
            if (!site) return;
            state.transmitters = state.transmitters.filter(tx => siteKey(tx) !== site.key);
            if (!state.transmitters.some(tx => String(tx.operator || 'UNKNOWN').toUpperCase() === [...state.selectedOperators][0])) state.selectedOperators.clear();
            renderOperatorFilter(); renderTransmitters(); autoConfigureStudy(); renderTerritorySummary(); void refreshRecommendation({silent:true});
        });
        target.querySelectorAll('[data-rf-remove]').forEach(btn => btn.onclick = () => {
            state.transmitters.splice(Number(btn.dataset.rfRemove), 1);
            if (!state.transmitters.length && !state.territory) state.selectedOperators.clear();
            renderOperatorFilter(); renderTransmitters(); autoConfigureStudy(); renderTerritorySummary();
        });
    }
    function siteKey(tx) { return `${String(tx.operator || 'UNKNOWN').toUpperCase()}|${String(tx.site || tx.cell || tx.id || 'UNKNOWN').toUpperCase()}`; }
    // ---- Bibliothèque MSI mesurée (Huawei / Nokia / Ericsson) -------------
    const msiState = { models: [], byId: new Map(), lastPreviewId: '' };
    async function initMsiLibrary() {
        const select = $('rf-msi-model');
        if (!select) return;
        try {
            const data = await window.rfApi.msiModels();
            msiState.models = data.items || [];
            msiState.byId = new Map(msiState.models.map(m => [m.id, m]));
            if (!msiState.models.length) {
                select.innerHTML = '<option value="">Bibliothèque indisponible</option>';
                $('rf-msi-status').textContent = 'Bibliothèque MSI introuvable (Antenna_Library).';
                return;
            }
            const groups = new Map();
            for (const model of msiState.models) {
                const vendor = model.vendor || 'Autre';
                if (!groups.has(vendor)) groups.set(vendor, []);
                groups.get(vendor).push(model);
            }
            select.innerHTML = [...groups.entries()].map(([vendor, list]) =>
                `<optgroup label="${esc(vendor)}">${list.map(m => {
                    const span = m.frequencyRangeMHz || [null, null];
                    const gain = m.gainDbiRange ? ` · ${Number(m.gainDbiRange[0]).toFixed(1)}–${Number(m.gainDbiRange[1]).toFixed(1)} dBi` : '';
                    return `<option value="${esc(m.id)}">${esc(m.model)} (${span[0] ?? '?'}–${span[1] ?? '?'} MHz${gain})</option>`;
                }).join('')}</optgroup>`).join('');
        } catch (err) {
            select.innerHTML = '<option value="">Erreur</option>';
            $('rf-msi-status').textContent = `Bibliothèque MSI : ${err.message}`;
        }
    }
    function pickReferenceSector(model) {
        const active = simulationTransmitters();
        const inRange = model?.frequencyRangeMHz
            ? active.filter(tx => Number(tx.frequencyMHz || 0) >= model.frequencyRangeMHz[0] - 1 && Number(tx.frequencyMHz || 0) <= model.frequencyRangeMHz[1] + 1)
            : [];
        return inRange[0] || active[0] || null;
    }
    async function previewMsiModel() {
        const id = $('rf-msi-model')?.value;
        if (!id) return;
        const model = msiState.byId.get(id);
        const sector = pickReferenceSector(model);
        const frequency = sector ? sector.frequencyMHz : (model?.frequencyRangeMHz ? (model.frequencyRangeMHz[0] + model.frequencyRangeMHz[1]) / 2 : null);
        const tilt = sector && sector.electricalTiltDeg != null ? sector.electricalTiltDeg : null;
        msiState.lastPreviewId = id;
        $('rf-msi-status').innerHTML = 'Chargement du motif…';
        try {
            const detail = await window.rfApi.msiPattern(id, frequency, tilt);
            drawMsiPreview(detail);
            const files = (detail.tiltFiles || []).map(f => `${String(f.path).split('/').pop()} ×${f.weight}`).join(' + ');
            $('rf-msi-meta').innerHTML =
                `<b>${esc(detail.modelId)}</b> — ${esc(detail.sourceVendor || '')} · porteuse ${Number(detail.carrierMHz)} MHz · pol ${esc(detail.polarization || '—')}` +
                ` · tilt demandé ${detail.electricalTiltRequestedDeg ?? '—'}° → fichiers ${esc(files)}` +
                `<br>Gain ${detail.gainDbi != null ? Number(detail.gainDbi).toFixed(2) + ' dBi' : 'n/d'} · HPBW fiche ${detail.horizontalBeamwidthDegHeader ?? '—'}°` +
                ` · plafond arrière ${Number(detail.frontToBackDb).toFixed(1)} dB`;
            $('rf-msi-status').innerHTML = sector
                ? `Aperçu calculé pour ${esc(sector.cell || sector.site || 'secteur')} à ${Number(sector.frequencyMHz).toFixed(1)} MHz.`
                : 'Aperçu au centre de bande (aucun secteur sélectionné).';
        } catch (err) {
            $('rf-msi-status').innerHTML = `<span class="rf-error">${esc(err.message)}</span>`;
        }
    }
    function drawMsiPreview(detail) {
        drawMsiPolar($('rf-msi-h'), detail.horizontalAngles, detail.horizontalAttenuationDb);
        drawMsiVertical($('rf-msi-v'), detail.verticalAngles, detail.verticalAttenuationDb, detail.electricalTiltResolvedDeg);
    }
    function drawMsiPolar(canvas, angles, values) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2;
        const rMax = Math.min(cx, cy) - 12;
        const maxDb = Math.max(20, Math.ceil(Math.max(...values, 10) / 10) * 10);
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(125,211,252,.25)';
        ctx.fillStyle = 'rgba(148,163,184,.9)';
        ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
        for (let db = maxDb; db > 0; db -= maxDb / 4) {
            ctx.beginPath(); ctx.arc(cx, cy, rMax * (1 - db / maxDb), 0, Math.PI * 2); ctx.stroke();
            ctx.fillText(`${db}`, cx + 3, cy - rMax * (1 - db / maxDb) + 9);
        }
        [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']].forEach(([deg, label]) => {
            const a = deg * Math.PI / 180;
            ctx.fillText(label, cx + (rMax + 8) * Math.sin(a), cy - (rMax + 4) * Math.cos(a) + 3);
        });
        ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 1.6; ctx.beginPath();
        for (let i = 0; i < angles.length; i++) {
            const a = angles[i] * Math.PI / 180, rr = rMax * (1 - Math.min(values[i], maxDb) / maxDb);
            const x = cx + rr * Math.sin(a), y = cy - rr * Math.cos(a);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        for (let i = angles.length - 1; i >= 0; i--) {
            const a = angles[i] * Math.PI / 180, rr = rMax * (1 - Math.min(values[i], maxDb) / maxDb);
            ctx.lineTo(cx - rr * Math.sin(a), cy - rr * Math.cos(a));
        }
        ctx.closePath(); ctx.stroke();
        ctx.fillStyle = 'rgba(226,232,240,.95)'; ctx.fillText('Coupe H (dB)', cx, h - 3);
    }
    function drawMsiVertical(canvas, angles, values, tiltDeg) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height, padL = 24, padR = 8, padT = 10, padB = 16;
        // Depression index -> elevation above horizon: eps = -theta.
        const pts = angles.map((theta, i) => {
            let eps = (-theta) % 360; if (eps < -180) eps += 360;
            return { eps, db: values[i] };
        }).filter(p => p.eps >= -30 && p.eps <= 60).sort((a, b) => a.eps - b.eps);
        if (pts.length < 2) return;
        const epsMin = -30, epsMax = 60;
        const maxDb = Math.max(20, Math.ceil(Math.max(...pts.map(p => p.db)) / 10) * 10);
        const x = eps => padL + (eps - epsMin) / (epsMax - epsMin) * (w - padL - padR);
        const y = db => padT + db / maxDb * (h - padT - padB);
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(125,211,252,.2)';
        for (let db = 0; db <= maxDb; db += maxDb / 4) { ctx.beginPath(); ctx.moveTo(padL, y(db)); ctx.lineTo(w - padR, y(db)); ctx.stroke(); }
        ctx.fillStyle = 'rgba(148,163,184,.9)'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
        for (let db = 0; db <= maxDb; db += maxDb / 4) ctx.fillText(`${db}`, padL - 3, y(db) + 3);
        ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 1.6; ctx.beginPath();
        pts.forEach((p, i) => i ? ctx.lineTo(x(p.eps), y(p.db)) : ctx.moveTo(x(p.eps), y(p.db)));
        ctx.stroke();
        if (tiltDeg != null && tiltDeg >= epsMin && tiltDeg <= epsMax) {
            ctx.strokeStyle = '#f97316'; ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(x(tiltDeg), padT); ctx.lineTo(x(tiltDeg), h - padB); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = '#f97316'; ctx.textAlign = 'center'; ctx.fillText(`tilt ${Number(tiltDeg).toFixed(1)}°`, x(tiltDeg), h - 5);
        }
        ctx.fillStyle = 'rgba(226,232,240,.95)'; ctx.textAlign = 'center';
        ctx.fillText('Coupe V — élévation (dB)', padL + (w - padL - padR) / 2, h - 1);
    }
    function applyMsiModel() {
        const id = $('rf-msi-model')?.value;
        if (!id) return;
        const model = msiState.byId.get(id);
        let applied = 0, skipped = 0;
        const activeIds = new Set(simulationTransmitters().map(tx => tx.id));
        for (const tx of state.transmitters) {
            if (!activeIds.has(tx.id)) continue;
            const freq = Number(tx.frequencyMHz || 0);
            const inRange = !model?.frequencyRangeMHz || (freq >= model.frequencyRangeMHz[0] - 1 && freq <= model.frequencyRangeMHz[1] + 1);
            if (!inRange) { skipped++; continue; }
            tx.antennaPatternId = id;
            tx.antennaPatternQuality = 'measured-msi';
            applied++;
        }
        renderTransmitters();
        $('rf-msi-status').innerHTML = applied
            ? `✓ ${applied} secteur(s) basculés sur <b>${esc(id)}</b>${skipped ? ` · ${skipped} hors bande ignoré(s)` : ''}. EIRP et atténuations recalculées par le moteur au lancement.`
            : 'Aucun secteur sélectionné dans la plage de fréquences de ce modèle.';
    }

    // These profiles are deliberately scenario templates, not vendor claims.
    // A 32T32R/64T64R label alone does not define the installed AAU, port/beam,
    // SSB power, gain, or a certified MSI pattern.  Keep every assumption
    // attached to the transmitter so preflight/export can remain auditable.
    const huaweiN78AauTemplates = Object.freeze({
        '32T32R': Object.freeze({
            profileId: 'huawei-n78-aau-32t32r-exploratory-v1',
            label: 'Huawei AAU 32T32R',
            defaultEirpDbm: 55,
            defaultTiltDeg: 6,
            defaultHorizontalBeamwidthDeg: 65,
            defaultVerticalBeamwidthDeg: 6.5,
        }),
        '64T64R': Object.freeze({
            profileId: 'huawei-n78-aau-64t64r-exploratory-v1',
            label: 'Huawei AAU 64T64R',
            defaultEirpDbm: 58,
            defaultTiltDeg: 6,
            defaultHorizontalBeamwidthDeg: 65,
            defaultVerticalBeamwidthDeg: 6.5,
        }),
    });
    function selectedHuaweiN78AauTemplate() {
        return huaweiN78AauTemplates[$('rf-huawei-aau-model')?.value] || huaweiN78AauTemplates['32T32R'];
    }
    function activeN78Transmitters() {
        return simulationTransmitters().filter(tx => {
            const band = String(tx.band || '').toUpperCase().replace(/[ _-]/g, '');
            const frequency = Number(tx.frequencyMHz || 0);
            return String(tx.technology || '').toUpperCase() === 'NR'
                && (band === 'N78' || (frequency >= 3300 && frequency <= 3800));
        });
    }
    function huaweiAauNumber(id, label, min, max) {
        const value = Number($(id)?.value);
        if (!Number.isFinite(value) || value < min || value > max) {
            throw new Error(`${label} doit être compris entre ${min} et ${max}.`);
        }
        return value;
    }
    function setHuaweiAauTemplateDefaults() {
        const template = selectedHuaweiN78AauTemplate();
        $('rf-huawei-aau-eirp').value = String(template.defaultEirpDbm);
        $('rf-huawei-aau-tilt').value = String(template.defaultTiltDeg);
        $('rf-huawei-aau-hbw').value = String(template.defaultHorizontalBeamwidthDeg);
        $('rf-huawei-aau-vbw').value = String(template.defaultVerticalBeamwidthDeg);
        $('rf-huawei-aau-status').textContent = `${template.label} : valeurs de scénario réinitialisées. Elles restent modifiables et exploratoires jusqu'à association d'un MSI/ADF, du port/beam et des paramètres réels.`;
    }
    function applyHuaweiN78AauTemplate() {
        const template = selectedHuaweiN78AauTemplate();
        const target = activeN78Transmitters();
        if (!target.length) {
            $('rf-huawei-aau-status').textContent = 'Aucun secteur NR n78 actif. Ajoutez ou cochez au moins un secteur n78 avant d’appliquer le template.';
            return;
        }
        let eirpDbm, electricalTiltDeg, horizontalBeamwidthDeg, verticalBeamwidthDeg;
        try {
            eirpDbm = huaweiAauNumber('rf-huawei-aau-eirp', 'EIRP SSB/SS-RS', 30, 90);
            electricalTiltDeg = huaweiAauNumber('rf-huawei-aau-tilt', 'Tilt électrique', 0, 20);
            horizontalBeamwidthDeg = huaweiAauNumber('rf-huawei-aau-hbw', 'HPBW horizontal', 10, 180);
            verticalBeamwidthDeg = huaweiAauNumber('rf-huawei-aau-vbw', 'HPBW vertical', 1, 40);
        } catch (error) {
            $('rf-huawei-aau-status').textContent = error.message;
            return;
        }
        for (const tx of target) {
            tx.antennaModel = `${template.label} (hypothèse)`;
            tx.antennaPatternId = template.profileId;
            tx.antennaPatternQuality = 'exploratory-default';
            tx.referenceSignalEirpDbm = eirpDbm;
            tx.electricalTiltDeg = electricalTiltDeg;
            // The inventory lacks a mechanical tilt for these NR sectors.
            // Record the selected electrical tilt as the total scenario tilt;
            // the text below prevents interpreting it as an audited RET value.
            tx.totalTiltDeg = electricalTiltDeg;
            tx.horizontalBeamwidthDeg = horizontalBeamwidthDeg;
            tx.verticalBeamwidthDeg = verticalBeamwidthDeg;
            tx.eirpDerivation = {
                rule: 'operator-input_huawei_n78_aau_exploratory_template',
                profile: template.label,
                assumedEirpDbm: eirpDbm,
                electricalTiltDeg,
                horizontalBeamwidthDeg,
                verticalBeamwidthDeg,
                patternQuality: 'exploratory-default',
            };
            tx.rfAssumption = `${template.label} n78 : scénario avec EIRP SSB/SS-RS ${eirpDbm.toFixed(1)} dBm, tilt électrique ${electricalTiltDeg.toFixed(1)}°, HPBW ${horizontalBeamwidthDeg.toFixed(1)}°/${verticalBeamwidthDeg.toFixed(1)}°. Hypothèses à confirmer par MSI/ADF, port/beam et paramètres AAU réels.`;
            tx.qualityStatus = 'exploratory';
        }
        renderTransmitters();
        $('rf-huawei-aau-status').textContent = `✓ ${target.length} secteur(s) NR n78 configuré(s) avec ${template.label}. Simulation exploratoire : aucun MSI Huawei ni paramètre réseau réel n’a été inféré.`;
        void refreshRecommendation({silent:true}).then(() => automaticPreflight({announceReady:true}));
    }

    function addTransmitters(items, label) {
        const selectedBands = selectedBandLabel();
        if (!selectedBands) {
            const message = 'Choisissez au moins une bande avant d’ajouter un site à la simulation.';
            $('rf-progress').textContent = message;
            $('rf-sector-results').innerHTML = `<div class="rf-error">${message}</div>`;
            return false;
        }
        const bandMatched = transmittersForSelectedBands(items);
        if (!bandMatched.length) {
            const message = `${label} ne contient aucun secteur dans les bandes cochées (${selectedBands}).`;
            $('rf-progress').textContent = message;
            $('rf-sector-results').innerHTML = `<div class="rf-error">${esc(message)}</div>`;
            return false;
        }
        const unique = bandMatched.filter(tx => !state.transmitters.some(selected => selected.id === tx.id));
        if (!unique.length) { $('rf-progress').textContent = `${label} est déjà sélectionné pour les bandes cochées (${selectedBands}).`; return false; }
        // Clearing a study removes its transmitters but older panels could
        // retain the previous operator chip.  A visually empty group must
        // always accept the first site clicked on the map.
        if (!state.transmitters.length && state.territory && state.studyMode === 'sites') clearTerritory();
        if (!state.transmitters.length && !state.territory) state.selectedOperators.clear();
        const incomingOperators = new Set(unique.map(tx => String(tx.operator || 'UNKNOWN').toUpperCase()));
        const currentOperator = state.transmitters.length ? [...state.selectedOperators][0] : null;
        if (incomingOperators.size > 1 || (currentOperator && [...incomingOperators].some(operator => operator !== currentOperator))) {
            $('rf-progress').textContent = 'Un seul opérateur est autorisé par simulation. Retirez la sélection actuelle avant d’ajouter ce site.';
            return false;
        }
        if (!state.territory && state.transmitters.length + unique.length > 600) {
            $('rf-sector-results').innerHTML = '<div class="rf-error">600 secteurs maximum pour un composite. Découpez le groupe ou réduisez la sélection.</div>';
            return false;
        }
        state.transmitters.push(...unique.map(tx => ({...tx})));
        const operator = [...incomingOperators][0];
        state.selectedOperators = new Set(operator ? [operator] : []);
        if (!state.territory) setStudyMode('sites', {preserveSelection:true});
        renderOperatorFilter(); renderTransmitters(); autoConfigureStudy(); renderTerritorySummary();
        const scope = state.territory ? ` La zone calculée reste ${state.territory.area.name}.` : '';
        $('rf-progress').textContent = `✓ ${unique.length} secteur${unique.length > 1 ? 's' : ''} ajouté${unique.length > 1 ? 's' : ''} : ${label} · bandes ${selectedBands}.${scope} Recherchez un autre site pour compléter le composite.`;
        // The manual preflight remains available for engineering review, but
        // a normal site workflow is now ready immediately after Add.
        void refreshRecommendation().then(() => automaticPreflight({announceReady:true}));
        return true;
    }
    function chooseDatasetForTransmitters() {
        const active = simulationTransmitters();
        const tx = active[0];
        if (!tx || tx.lat == null || tx.lon == null) return null;
        // Territorial output is bounded by the administrative polygon, not
        // by the selected sectors (an external site can legitimately improve
        // best-server coverage).  Prefer the dataset prepared explicitly for
        // this province before considering compact studies that only cover
        // the current transmitter group.
        const area = state.territory?.area;
        if (area) {
            const territoryDataset = state.datasets.find(ds => ds.rfReady !== false
                && String(ds.scope?.level || '').toLowerCase() === String(area.level || '').toLowerCase()
                && String(ds.scope?.id || '') === String(area.id || ''));
            const territoryBounds = Array.isArray(area.bounds) && area.bounds.length === 4 ? area.bounds.map(Number) : null;
            const coveringTerritory = territoryBounds ? state.datasets.filter(ds => {
                const b = ds.wgs84Bounds;
                return ds.rfReady !== false && b
                    && Number(b[0]) <= territoryBounds[0] && Number(b[1]) <= territoryBounds[1]
                    && Number(b[2]) >= territoryBounds[2] && Number(b[3]) >= territoryBounds[3];
            }).sort((left, right) => rfDatasetScore(right) - rfDatasetScore(left))[0] : null;
            const selectedTerritoryDataset = territoryDataset || coveringTerritory;
            if (selectedTerritoryDataset) {
                state.selectedDataset = selectedTerritoryDataset.datasetId;
                $('rf-dataset').value = selectedTerritoryDataset.datasetId;
                renderDataset();
                return selectedTerritoryDataset;
            }
        }
        const localStudyBounds = (() => {
            if (area) return null;
            const polygonBounds = geometryBoundsWgs84(state.aoiPolygon?.geometry);
            if (polygonBounds) return polygonBounds;
            const points = active.filter(candidate => Number.isFinite(Number(candidate.lat)) && Number.isFinite(Number(candidate.lon)));
            if (!points.length) return null;
            const lat = points.reduce((sum, candidate) => sum + Number(candidate.lat), 0) / points.length;
            const lon = points.reduce((sum, candidate) => sum + Number(candidate.lon), 0) / points.length;
            const farthestM = Math.max(0, ...points.map(candidate => Math.hypot((Number(candidate.lat) - lat) * 111320, (Number(candidate.lon) - lon) * 111320 * Math.cos(lat * Math.PI / 180))));
            const requestedRadius = Number($('rf-radius')?.value || 5000);
            const radiusM = Math.min(25000, Math.max(requestedRadius, Math.ceil(farthestM + (points.length > 1 ? 500 : 0))));
            const latDelta = radiusM / 111320;
            const lonDelta = radiusM / Math.max(111320 * Math.cos(lat * Math.PI / 180), 1);
            return [lon - lonDelta, lat - latDelta, lon + lonDelta, lat + latDelta];
        })();
        const coversAll = ds => {
            const b = ds.wgs84Bounds;
            if (!b) return false;
            if (localStudyBounds) return Number(b[0]) <= localStudyBounds[0] && Number(b[1]) <= localStudyBounds[1]
                && Number(b[2]) >= localStudyBounds[2] && Number(b[3]) >= localStudyBounds[3];
            return active.every(candidate => Number(candidate.lon) >= b[0] && Number(candidate.lon) <= b[2] && Number(candidate.lat) >= b[1] && Number(candidate.lat) <= b[3]);
        };
        // A geographic DTM may visually cover the group, but it cannot provide
        // metre-based distances, Fresnel clearance or diffraction. Never pick it
        // when a UTM-prepared companion (for example *_UTM29) is available.
        const matching = state.datasets.filter(ds => ds.rfReady !== false && coversAll(ds))
            .sort((left, right) => rfDatasetScore(right) - rfDatasetScore(left))[0];
        if (matching) {
            state.selectedDataset = matching.datasetId;
            $('rf-dataset').value = matching.datasetId;
            renderDataset();
            return matching;
        }
        const geographicMatch = state.datasets.find(coversAll);
        if (geographicMatch) {
            $('rf-dataset-info').innerHTML = `<span class="rf-error">${esc(geographicMatch.name)} couvre le groupe mais son MNT n’est pas métrique. Préparez-le en UTM avec le pack Maroc, ou sélectionnez son dataset UTM préparé.</span>`;
            return null;
        }
        const polygonBounds = geometryBoundsWgs84(state.aoiPolygon?.geometry);
        const outside = polygonBounds ? null : active.find(candidate => !state.datasets.some(ds => { const b = ds.wgs84Bounds; return b && Number(candidate.lon) >= b[0] && Number(candidate.lon) <= b[2] && Number(candidate.lat) >= b[1] && Number(candidate.lat) <= b[3]; }));
        const selected = state.datasets.find(ds => ds.datasetId === state.selectedDataset);
        const bounds = selected?.wgs84Bounds;
        const selectedExtent = Array.isArray(bounds) && bounds.length === 4
            ? ` Emprise ${esc(selected?.name || 'GeoData')} : lon ${Number(bounds[0]).toFixed(3)} → ${Number(bounds[2]).toFixed(3)}, lat ${Number(bounds[1]).toFixed(3)} → ${Number(bounds[3]).toFixed(3)}.` : '';
        const point = outside && Number.isFinite(Number(outside.lat)) && Number.isFinite(Number(outside.lon))
            ? ` Coordonnées secteur : ${Number(outside.lat).toFixed(4)}, ${Number(outside.lon).toFixed(4)}.` : '';
        $('rf-dataset-info').innerHTML = `<span class="rf-error">Aucun GeoData unique ne couvre ${polygonBounds ? 'tout le polygone dessiné' : `tout le groupe${outside ? ` (notamment ${esc(outside.cell || outside.site)})` : ''}`}.${point}${selectedExtent} Importez un DTM couvrant la zone complète.</span>`;
        return null;
    }
    async function search() {
        const q = $('rf-sector-search').value.trim();
        $('rf-sector-results').innerHTML = '<div class="rf-muted">Recherche…</div>';
        try {
            const [sites, sectors] = await Promise.all([window.rfApi.siteGroups(q, {limit: 20}), window.rfApi.sectors(q, {limit: 20})]);
            state.siteCandidates = sites.items || []; state.candidates = sectors.items || [];
            const selectedBands = selectedBandLabel();
            const siteHtml = state.siteCandidates.map((site, i) => {
                const all = groupTransmitters(site);
                const matching = transmittersForSelectedBands(all);
                const disabled = matching.length ? '' : ' disabled';
                const count = `${matching.length}/${all.length || Number(site.sectorCount || 0)} secteurs`;
                const hint = matching.length ? `bandes cochées : ${selectedBands}` : `aucun secteur dans ${selectedBands || 'les bandes cochées'}`;
                return `<button class="rf-candidate rf-site-candidate" data-rf-add-site="${i}"${disabled}><span>＋ Ajouter le site</span><b>${esc(site.site || 'Site sans nom')} <em>${esc(count)}</em></b><small>${esc(site.operator || 'Opérateur N/D')} · ${esc((site.technologies || []).join('/'))} · ${esc(hint)}</small></button>`;
            }).join('');
            const sectorHtml = state.candidates.map((tx, i) => {
                const active = state.selectedBands.has(bandKey(tx.band, tx.technology));
                return `<button class="rf-candidate" data-rf-add="${i}"${active ? '' : ' disabled'}><span>＋ Ajouter · ${esc(tx.technology)} ${esc(tx.band || '—')}</span><b>${esc(tx.cell || tx.site || 'Cellule sans nom')}</b><small>${esc(tx.site || '')} · ${esc(tx.operator || 'Opérateur N/D')}${active ? '' : ' · hors filtre bande'}</small></button>`;
            }).join('');
            $('rf-sector-results').innerHTML = siteHtml ? `<div class="rf-result-label">Sites complets</div>${siteHtml}<div class="rf-result-label">Secteurs individuels</div>${sectorHtml}` : (sectorHtml || '<div class="rf-muted">Aucun secteur trouvé.</div>');
            $('rf-sector-results').querySelectorAll('[data-rf-add-site]').forEach(btn => btn.onclick = () => { const site = state.siteCandidates[Number(btn.dataset.rfAddSite)]; addTransmitters(groupTransmitters(site), `Le site ${site.site}`); });
            $('rf-sector-results').querySelectorAll('[data-rf-add]').forEach(btn => btn.onclick = () => addTransmitters([state.candidates[Number(btn.dataset.rfAdd)]], 'Ce secteur'));
        } catch (err) { $('rf-sector-results').innerHTML = `<div class="rf-error">${esc(err.message)}</div>`; }
    }
    function setViewAoi() {
        const m = map(); if (!m) return;
        const b = m.getBounds();
        state.viewBounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    }
    function payload() {
        if (state.scenarioType === 'indoor_macro') {
            return {
                name:`Indoor Coverage — ${state.indoorOperator} — ${new Date().toLocaleString()}`,
                scenarioType:'indoor_macro', datasetId:state.indoorBuildings[0]?.datasetId || state.selectedDataset,
                buildingIds:state.indoorBuildings.map(building => building.id), operator:state.indoorOperator,
                selectedBands:'all', transmitters:state.recommendation?.transmitters || [],
                floorModel:{defaultFloorHeightM:3, ueHeightM:1.5, floorOverrides:{}},
                lossModel:{entry:'auto', indoor:'auto', percentile:50},
                style:{thresholds:[Number($('rf-t0').value), Number($('rf-t1').value), Number($('rf-t2').value), Number($('rf-t3').value), Number($('rf-t4').value)], colors:[$('rf-c0').value,$('rf-c1').value,$('rf-c2').value,$('rf-c3').value,$('rf-c4').value], opacity:Number($('rf-opacity').value)},
            };
        }
        if ($('rf-current-view').checked) setViewAoi();
        const active = simulationTransmitters();
        const points = active.filter(tx => Number.isFinite(Number(tx.lat)) && Number.isFinite(Number(tx.lon)));
        const center = points.length ? {lat: points.reduce((sum, tx) => sum + Number(tx.lat), 0) / points.length, lon: points.reduce((sum, tx) => sum + Number(tx.lon), 0) / points.length} : null;
        const requestedRadius = Number($('rf-radius').value || 5000);
        // A grouped site AOI is centred on the group and enlarged enough to
        // contain every selected site plus the user's requested study radius.
        const farthestM = center ? Math.max(0, ...points.map(tx => Math.hypot((Number(tx.lat) - center.lat) * 111320, (Number(tx.lon) - center.lon) * 111320 * Math.cos(center.lat * Math.PI / 180)))) : 0;
        const radiusM = Math.min(25000, Math.max(requestedRadius, Math.ceil(farthestM + (points.length > 1 ? 500 : 0))));
        const polygonGeometry = state.territory?.geometry || state.aoiPolygon?.geometry;
        const aoi = polygonGeometry
            ? {type:'polygon', geometry:polygonGeometry}
            : ($('rf-current-view').checked && state.viewBounds ? {type:'bounds', bounds:state.viewBounds} : {type:'radius', center, radiusM});
        const territory = state.territory ? {enabled:true, level:state.territory.area.level, id:state.territory.area.id, name:state.territory.area.name} : null;
        return {name:`RF Coverage — ${scenarioLabels[state.scenarioType]} ${state.territory?.area?.name ? `— ${state.territory.area.name} ` : state.aoiPolygon ? '— zone dessinée ' : ''}— ${new Date().toLocaleString()}`, scenarioType:state.scenarioType, recommendationVersion:state.recommendation?.version || null, datasetId:state.selectedDataset, geoDataStack:state.recommendation?.geoDataStack || [], requestedEnvironmentMode:state.recommendation?.requestedEnvironmentMode || $('rf-environment-mode').value, environmentMode:$('rf-environment-mode').value, executionMode:$('rf-execution-mode').value, transmitters:active, selectedBands:[...state.selectedBands], territory, aoi, resolutionM:Number($('rf-resolution').value), calibrationProfileId:$('rf-calibration-profile')?.value || null, propagationSettings:{model:'hybrid', climate:Number($('rf-itm-climate').value), effectiveEarthK:Number($('rf-earth-k').value), groundPermittivity:Number($('rf-ground-epsilon').value), groundConductivity:Number($('rf-ground-sigma').value)}, receiverProfile:{name:$('rf-receiver').value, heightAglM:1.5, gainDbi:0}};
    }
    function showCheck(result) {
        const el = $('rf-preflight');
        el.className = `rf-preflight ${result.quality || ''}`;
        if (state.scenarioType === 'indoor_macro' || result.scenarioType === 'indoor_macro') {
            const qualityLabel = result.quality === 'professional-ready' ? '✓ Professionnel' : result.quality === 'caution' ? '⚠ Caution' : result.quality === 'exploratory' ? '⚠ Exploratoire' : '⛔ Bloqué';
            const issues = result.issues || [];
            el.innerHTML = `<b>${qualityLabel}${result.ok ? ` · ${Number(result.buildings?.length || state.indoorBuildings.length)} bâtiment(s) · ${Number(result.floorCount || 0)} étage(s) · ${Number(result.estimatedReceiverPoints || 0).toLocaleString('fr-FR')} points · ≈ ${Number(result.estimatedSeconds || 0).toFixed(1)} s` : ''}</b><small>Macro-to-indoor 2.5D · grille ${Number(result.resolutionM || 1).toFixed(1)} m · pertes par bande · aucun pixel hors empreinte.</small>${issues.length ? `<ul>${issues.map(issue => `<li>${esc(issue)}</li>`).join('')}</ul>` : '<small>Empreinte, étages, secteurs candidats et pertes vérifiés.</small>'}`;
            return;
        }
        const tiled = result.executionMode === 'territorial_tiled';
        const tilePlan = result.tilePlan;
        const qualityLabel = result.quality === 'professional-ready' ? '✓ Professionnel' : result.quality === 'caution' ? '⚠ Prudence' : '⚠ Exploratoire';
        const bits = result.ok ? [qualityLabel, `${result.siteCount || 0} site(s) · ${result.sectorCount || 0} secteurs`, `${result.width} × ${result.height} px · ${Number(result.pixels).toLocaleString()} pixels · ≈ ${result.estimatedSeconds}s`, tiled ? `🧩 ${tilePlan?.tileCount || 0} tuiles${state.territory ? '' : ' · composite'}` : 'Exact local'] : ['⛔ Bloqué'];
        const env = result.environment || {};
        const fullPath = result.fullPathObstruction;
        const rural = result.environmentMode === 'rural';
        const layers = env.dtm ? `<small>${rural ? 'Environnement rural : DTM terrain' : 'Environnement : DTM'}${env.clutter ? ' · clutter' : ''}${!rural && env.dhm ? ' · DHM' : ''}${!rural && env.buildings ? ' · bâtiments 3D' : ''}${!rural && env.vegetation ? ' · végétation 3D' : ''} · ${rural ? 'sans obstacle local 3D' : 'profil complet'} + Fresnel/diffraction${fullPath ? ` · pas ${Number(fullPath.samplingM).toFixed(1)} m` : ''}</small>` : '';
        const outside = result.quality === 'out-of-coverage';
        const action = outside && state.moroccoPack?.ruralBase?.sourceExists
            ? '<button type="button" class="rf-preflight-action" id="rf-prepare-rural-here">Préparer une étude rurale UTM pour ce groupe</button>' : '';
        const suggestedResolution = Number(result.recommendedResolutionM || tilePlan?.recommendedResolutionM || 0);
        const resolutionAction = tiled && suggestedResolution > Number($('rf-resolution').value || 0)
            ? `<button type="button" class="rf-preflight-action" id="rf-use-recommended-resolution">Passer à ${suggestedResolution.toLocaleString('fr-FR')} m et relancer le précontrôle</button>` : '';
        const tiledInfo = tiled && tilePlan ? `<small class="rf-tiled-info">${state.territory ? 'Mode territorial tuilé' : 'Mode composite tuilé'} : ${Number(tilePlan.tileSizeM || 0).toLocaleString()} m par tuile · jusqu’à ${tilePlan.maxCandidatesPerTile} secteurs candidats/tile · ${esc(tilePlan.candidateSelection || '')}.</small>` : '';
        const issues = result.issues || [];
        const issueSummary = issues.length ? `<ul>${issues.slice(0, 2).map(esc).map(text => `<li>${text}</li>`).join('')}</ul>${issues.length > 2 ? `<details class="rf-warning-details"><summary>${issues.length - 2} avertissement(s) supplémentaire(s)</summary><ul>${issues.slice(2).map(esc).map(text => `<li>${text}</li>`).join('')}</ul></details>` : ''}` : '<small>Terrain, emprise et paramètres vérifiés.</small>';
        el.innerHTML = `<b>${bits.join(' · ')}</b>${layers}${tiledInfo}${issueSummary}${resolutionAction}${action}`;
        $('rf-use-recommended-resolution')?.addEventListener('click', () => {
            $('rf-resolution').value = String(suggestedResolution);
            check();
        });
        $('rf-prepare-rural-here')?.addEventListener('click', quickPrepareRural);
    }
    async function automaticPreflight({announceReady = false, allowRuralPrepare = false} = {}) {
        const token = ++state.autoPreflightToken;
        if (state.scenarioType === 'indoor_macro') {
            if (!state.indoorBuildings.length) {
                showCheck({ok:false, quality:'blocked', scenarioType:'indoor_macro', issues:['Cliquez un bâtiment sur la carte.']});
                return null;
            }
            await refreshRecommendation({silent:true});
            try {
                const result = await window.rfApi.preflight(payload());
                if (token !== state.autoPreflightToken) return null;
                showCheck(result);
                if (announceReady && result.ok) $('rf-progress').textContent = '✓ Configuration Indoor prête. Cliquez « Calculer la couverture intérieure ».';
                return result;
            } catch (error) {
                const result = {ok:false, quality:'blocked', scenarioType:'indoor_macro', issues:[error.message]};
                showCheck(result); return result;
            }
        }
        // Guided flows repair a stale empty band/operator filter before they
        // present a blocking message.  This is particularly important after
        // reopening the panel, when selections from a prior study persist.
        ensureGuidedSelection();
        if (!simulationTransmitters().length) {
            showCheck({ok:false,quality:'blocked',issues:[state.transmitters.length
                ? 'Aucun secteur actif après correction automatique. Vérifiez les bandes disponibles de ce site.'
                : 'Ajoutez au moins un site ou sélectionnez un territoire.']});
            return null;
        }
        const recommended = await refreshRecommendation({silent:true});
        if (!recommended) autoConfigureStudy();
        try {
            let result = await window.rfApi.preflight(payload());
            if (token !== state.autoPreflightToken) return null;
            // Territorial studies have a server-calculated safe resolution.
            // Apply it transparently instead of asking the user to repeat a
            // preflight just because the first default was too fine.
            const suggested = Number(result.recommendedResolutionM || result.tilePlan?.recommendedResolutionM || 0);
            if (!result.ok && $('rf-execution-mode').value === 'territorial_tiled' && suggested > Number($('rf-resolution').value || 0)) {
                $('rf-resolution').value = String(suggested);
                renderExecutionMode();
                result = await window.rfApi.preflight(payload());
                if (token !== state.autoPreflightToken) return null;
            }
            if (!result.ok && allowRuralPrepare
                && result.quality === 'out-of-coverage' && state.moroccoPack?.ruralBase?.sourceExists) {
                // The selected local urban DTM can have a NoData hole even
                // inside its advertised rectangle.  Do the promised one-click
                // fallback visibly, rather than leaving a stale red “blocked”
                // card while the bounded rural study is being prepared.
                const status = $('rf-preflight');
                status.className = 'rf-preflight caution';
                status.innerHTML = '<b>⏳ Préparation automatique</b><small>Le MNT urbain est incomplet pour cette zone. Création d’un terrain UTM valide (DTM + clutter) puis relance automatique du calcul.</small>';
                const prepared = state.studyMode === 'territory'
                    ? await prepareAutomaticTerritoryDataset()
                    : await prepareAutomaticRuralDataset();
                if (token !== state.autoPreflightToken) return null;
                if (prepared) return automaticPreflight({announceReady, allowRuralPrepare:false});
            }
            showCheck(result);
            renderConfigSummary({...state.recommendation, quality:result.quality, resolutionM:result.resolutionM, estimatedPixels:result.pixels, executionMode:result.executionMode});
            if (result.ok && announceReady) updateQuickGuide('Configuration automatique prête — cliquez « Calculer la couverture ».');
            return result;
        } catch (err) {
            if (token === state.autoPreflightToken) showCheck({ok:false,quality:'blocked',issues:[err.message]});
            return null;
        }
    }
    async function check() {
        await automaticPreflight();
    }
    async function run() {
        const runButton = $('rf-run');
        runButton.disabled = true;
        const preflight = await automaticPreflight({allowRuralPrepare:true});
        if (!preflight?.ok) { runButton.disabled = false; return; }
        try {
            const created = await window.rfApi.create(payload()); state.simulation = created.simulationId;
            showCheck(created.preflight); $('rf-run').disabled = true; $('rf-cancel').disabled = false; poll();
        } catch(err) { showCheck({ok:false,quality:'blocked',issues:[err.message]}); runButton.disabled = false; }
    }
    async function cancel() { if (state.simulation) await window.rfApi.cancel(state.simulation); }
    async function applyStyle() {
        if (!state.simulation) { $('rf-progress').textContent = 'Calculez ou ouvrez d’abord une simulation.'; return; }
        const names = ['Excellent', 'Bon', 'Acceptable', 'Faible', 'Très faible'];
        const classes = names.map((label, i) => ({label, min:Number($(`rf-t${i}`).value), color:$(`rf-c${i}`).value}));
        try { const sim = await window.rfApi.style(state.simulation, {classes, opacity:Number($('rf-opacity').value)}); showLayer(sim); $('rf-progress').textContent = '✓ Style de légende enregistré sans recalcul RF.'; }
        catch (err) { $('rf-progress').textContent = `Erreur style: ${err.message}`; }
    }
    async function poll() {
        if (!state.simulation) return;
        try {
            const sim = await window.rfApi.get(state.simulation);
            const phase = String(sim.phase || '').replace('computing_tiles', 'Calcul des tuiles').replace('preparing_tiles', 'Préparation des tuiles').replace('building_tiles', 'Assemblage des tuiles');
            $('rf-progress').textContent = `${phase} · ${Math.round(sim.progress || 0)}%${sim.error ? ' · ' + sim.error : ''}`;
            if (sim.status === 'ready') { $('rf-run').disabled = false; $('rf-cancel').disabled = true; showLayer(sim); await loadLibrary(); return; }
            if (['failed','cancelled'].includes(sim.status)) { $('rf-run').disabled = false; $('rf-cancel').disabled = true; return; }
            setTimeout(poll, 700);
        } catch (err) { $('rf-progress').textContent = `Erreur: ${err.message}`; $('rf-run').disabled = false; }
    }
    function clearServingSectorTrace() {
        if (state.winnerLine) { state.winnerLine.remove(); state.winnerLine = null; }
        if (state.winnerMarker) { state.winnerMarker.remove(); state.winnerMarker = null; }
    }
    function layerKey(simulationId, metric = 'rsrp') { return `${simulationId}:${metric}`; }
    function isMetricVisible(simulationId, metric = 'rsrp') { return state.visibleLayers.has(layerKey(simulationId, metric)); }
    function hasVisibleSimulation(simulationId) {
        return [...state.visibleLayers.keys()].some(key => key.startsWith(`${simulationId}:`));
    }
    function removeMapLegend() { document.getElementById('rf-map-legend')?.remove(); }
    function removeLayer(simulationId = state.simulation, metric = null) {
        const keys = metric ? [layerKey(simulationId, metric)] : [...state.visibleLayers.keys()].filter(key => key.startsWith(`${simulationId}:`));
        keys.forEach(key => {
            const layer = state.visibleLayers.get(key);
            if (layer) layer.remove();
            state.visibleLayers.delete(key);
            if (state.layer === layer) state.layer = null;
        });
        if (simulationId === state.simulation && (!metric || state.activeMetric === metric)) {
            clearServingSectorTrace();
            removeMapLegend();
        }
    }
    function renderMapLegend(sim, metric = 'rsrp') {
        removeMapLegend();
        const host = map()?.getContainer?.();
        if (!host) return;
        const style = sim.metadata?.style || {};
        const classes = [...(style.classes || [])].sort((a, b) => Number(b.min) - Number(a.min));
        const bandEntry = (sim.metadata?.result?.bandRasters || []).find(entry => entry.metric === metric || entry.bestServerMetric === metric);
        const band = bandEntry?.band;
        const isBandBestServer = Boolean(bandEntry?.bestServerMetric === metric);
        const coChannelOverlap = sim.metadata?.result?.overlapDefinition?.mode === 'winning_carrier' || sim.metadata?.result?.diagnostics?.overlapDefinition?.mode === 'winning_carrier';
        const title = metric === 'rsrp' ? 'RSRP composite' : band ? (isBandBestServer ? `Meilleur serveur ${band}` : `RSRP ${band}`) : ({best_server:'Meilleur secteur', best_site:'Meilleur site', margin:'Marge inter-site', sector_margin:'Marge secteur', server_count_ge_100: coChannelOverlap ? 'Overlap co-canal' : 'Overlap héritée', environment_quality:'Qualité environnementale', indoor_quality:'Qualité des pertes Indoor'}[metric] || metric);
        // Must remain byte-for-byte aligned with the palette in rf_service.py
        // (_rgba): raster value 1 uses the first colour, value 2 the second,
        // then repeats.  The legend takes its index from the immutable
        // transmitter snapshot, so it remains correct after BDD updates.
        const servingPalette = ['#2563eb', '#f97316', '#7c3aed', '#14b8a6', '#ec4899'];
        const servingSectors = (sim.metadata?.result?.transmitters || [])
            .map((sector, index) => ({sector, index}))
            .filter(({sector}) => !isBandBestServer || String(sector.band || '').trim().toLowerCase() === String(band || '').trim().toLowerCase());
        const servingSectorColors = style.sectorColors || {};
        const servingSectorList = (metric === 'best_server' || isBandBestServer) && servingSectors.length
            ? `<details class="rf-serving-sector-legend" open><summary><i class="rf-map-legend-multi"></i>${servingSectors.length} secteur${servingSectors.length > 1 ? 's' : ''} serveur${servingSectors.length > 1 ? 's' : ''}</summary><div class="rf-serving-sector-list">${servingSectors.map(({sector, index}) => {
                const name = sector.cell || sector.id || `Secteur ${index + 1}`;
                const descriptor = [sector.technology, sector.band, sector.site].filter(Boolean).join(' · ');
                const sectorId = index + 1;
                const stored = String(servingSectorColors[sectorId] || '');
                const color = /^#[0-9a-f]{6}$/i.test(stored) ? stored : servingPalette[index % servingPalette.length];
                return `<div title="${esc([name, descriptor].filter(Boolean).join(' — '))}"><input class="rf-serving-sector-color" type="color" value="${color}" data-rf-sector-color="${sectorId}" aria-label="Couleur du secteur ${esc(name)}" title="Changer la couleur de ce secteur"><i style="background:${color}"></i><span><b>${esc(name)}</b><small>${esc(descriptor || 'Secteur simulé')}</small></span></div>`;
            }).join('')}</div></details>`
            : '';
        let body = '';
        if (metric === 'rsrp' || (band && !isBandBestServer)) {
            const qualityNames = ['Excellent', 'Bon', 'Acceptable', 'Faible', 'Très faible'];
            body = classes.slice(0, qualityNames.length).map((entry, index) => {
                const upper = index ? Number(classes[index - 1].min) : null;
                const range = index === 0
                    ? `≥ ${Number(entry.min)} dBm`
                    : index === Math.min(classes.length, qualityNames.length) - 1
                        ? `< ${upper} dBm`
                        : `${Number(entry.min)} à ${upper} dBm`;
                return `<div><i style="background:${esc(entry.color || '#64748b')}"></i>${qualityNames[index]} · ${range}</div>`;
            }).join('');
        } else if (metric === 'best_server' || metric === 'best_site' || isBandBestServer) {
            body = metric === 'best_site'
                ? '<div><i class="rf-map-legend-multi"></i>Une couleur représente le site gagnant.</div>'
                : `${servingSectorList}<div class="rf-serving-sector-help">Chaque couleur correspond au secteur gagnant affiché sur la carte.</div>`;
        } else if (metric === 'environment_quality') {
            body = '<div><i style="background:#16a34a"></i>Urbain complet</div><div><i style="background:#eab308"></i>Urbain partiel</div><div><i style="background:#d97706"></i>Terrain rural</div>';
        } else if (metric === 'indoor_quality') {
            body = '<div><i style="background:#eab308"></i>Attributs GeoData Out_In/In_In (unité à valider)</div><div><i style="background:#d97706"></i>Fallback statistique P.2109/P.1238</div>';
        } else if (metric === 'server_count_ge_100') {
            body = coChannelOverlap
                ? '<div><i class="rf-map-legend-multi"></i>Secteurs de même RAT, bande et porteuse que le serveur gagnant, ≥ −100 dBm.</div>'
                : '<div><i class="rf-map-legend-multi"></i>Ancien résultat multi-bandes. Relancez pour un overlap co-canal.</div>';
        } else {
            body = '<div><i class="rf-map-legend-multi"></i>Valeur continue en dB.</div>';
        }
        const legend = document.createElement('aside');
        legend.id = 'rf-map-legend';
        legend.className = 'rf-map-legend';
        legend.innerHTML = `<div class="rf-map-legend-head" data-rf-legend-drag title="Glisser la légende"><span>⠿ Simulation RF</span><small>glisser</small></div><strong>${esc(title)}</strong>${body}<small>${band ? (isBandBestServer ? 'Cliquez la carte : tracé vers le secteur gagnant de cette bande.' : 'Couche par bande — cliquez la carte pour le secteur gagnant.') : 'Couche active'}</small>`;
        L.DomEvent.disableClickPropagation(legend);
        L.DomEvent.disableScrollPropagation(legend);
        host.appendChild(legend);
        window.makeMapOverlayDraggable?.(legend, '[data-rf-legend-drag]');
        legend.querySelectorAll('[data-rf-sector-color]').forEach(input => {
            input.addEventListener('input', () => {
                const swatch = input.parentElement?.querySelector('i');
                if (swatch) swatch.style.background = input.value;
            });
            input.addEventListener('change', async () => {
                const sectorId = String(input.dataset.rfSectorColor || '');
                const color = String(input.value || '').toLowerCase();
                if (!sectorId || !/^#[0-9a-f]{6}$/i.test(color)) return;
                try {
                    const nextStyle = {...style, sectorColors: {...servingSectorColors, [sectorId]: color}};
                    const updated = await window.rfApi.style(sim.id, nextStyle);
                    // Recreate the tile URL with the returned style revision;
                    // Leaflet must not retain the former cached PNG colours.
                    showLayer(updated, metric, {preserveLayers:true});
                    const progress = $('rf-progress');
                    if (progress) progress.textContent = '✓ Couleur du secteur enregistrée et appliquée sur la carte.';
                } catch (err) {
                    const progress = $('rf-progress');
                    if (progress) progress.textContent = `Couleur non enregistrée : ${err.message}`;
                }
            });
        });
    }
    function renderIndoorResultViews(sim, el) {
        const result = sim.metadata?.result || {};
        const floors = Array.isArray(result.floors) ? result.floors : [];
        if (!floors.length) { el.innerHTML = '<div class="rf-muted">Résultat Indoor sans étage calculé.</div>'; return; }
        if (!floors.some(entry => Number(entry.floor) === Number(state.indoorFloor))) state.indoorFloor = Number(floors[0].floor || 1);
        const bands = [...new Set((result.bandRasters || []).filter(entry => Number(entry.floor) === Number(state.indoorFloor)).map(entry => entry.band))];
        if (state.indoorBand && !bands.includes(state.indoorBand)) state.indoorBand = '';
        const floor = floors.find(entry => Number(entry.floor) === Number(state.indoorFloor)) || floors[0];
        const options = {floor:state.indoorFloor, band:state.indoorBand};
        el.innerHTML = `<div class="rf-result-label">🏢 Indoor · ${Number(result.buildings?.length || 0)} bâtiment(s) · ${floors.length} étage(s)</div>
          <div class="rf-indoor-result-selectors"><label>Étage<select data-rf-indoor-floor>${floors.map(entry => `<option value="${entry.floor}" ${Number(entry.floor) === Number(state.indoorFloor) ? 'selected' : ''}>Étage ${entry.floor} · UE ${Number(entry.receiverHeightAglM || 0).toFixed(1)} m</option>`).join('')}</select></label><label>Bande<select data-rf-indoor-band><option value="">Composite — toutes bandes</option>${bands.map(band => `<option value="${esc(band)}" ${state.indoorBand === band ? 'selected' : ''}>${esc(band)}</option>`).join('')}</select></label></div>
          <div class="rf-layer-buttons"><button data-rf-indoor-metric="rsrp" class="${state.activeMetric === 'rsrp' ? 'active' : ''}">RSRP</button><button data-rf-indoor-metric="best_server" class="${state.activeMetric === 'best_server' ? 'active' : ''}">Meilleur serveur</button>${state.indoorBand ? '' : `<button data-rf-indoor-metric="second_server_rsrp" class="${state.activeMetric === 'second_server_rsrp' ? 'active' : ''}">2e serveur</button><button data-rf-indoor-metric="margin" class="${state.activeMetric === 'margin' ? 'active' : ''}">Marge dominance</button><button data-rf-indoor-metric="server_count_ge_100" class="${state.activeMetric === 'server_count_ge_100' ? 'active' : ''}">Serveurs ≥−100</button><button data-rf-indoor-metric="indoor_quality" class="${state.activeMetric === 'indoor_quality' ? 'active' : ''}">Qualité Indoor</button>`}</div>
          <div class="rf-indoor-floor-stats"><span><small>RSRP médian</small><b>${floor.medianRsrpDbm ?? '—'} dBm</b></span><span><small>Couverture ≥−100</small><b>${floor.coveragePercentGeMinus100 ?? '—'}%</b></span><span><small>Pixels intérieurs</small><b>${Number(floor.validPixels || 0).toLocaleString('fr-FR')}</b></span><span><small>Qualité</small><b>${esc(sim.quality || 'caution')}</b></span></div>
          <div class="rf-layer-buttons"><a class="rf-export-link" href="${window.rfApi.exportUrl(sim.id, 'xlsx', options)}" target="_blank">XLSX</a><a class="rf-export-link" href="${window.rfApi.exportUrl(sim.id, 'pdf', options)}" target="_blank">PDF</a><a class="rf-export-link" href="${window.rfApi.exportUrl(sim.id, 'png', options)}" target="_blank">PNG étage</a><a class="rf-export-link" href="${window.rfApi.exportUrl(sim.id, 'geotiff', options)}" target="_blank">GeoTIFF étage</a><a class="rf-export-link" href="${window.rfApi.exportUrl(sim.id, 'json', options)}" target="_blank">Métadonnées JSON</a></div>
          <div class="rf-muted">Cliquez un pixel intérieur : le trajet est affiché du point vers la façade, puis vers la pointe du secteur gagnant.</div>`;
        el.querySelector('[data-rf-indoor-floor]').onchange = event => { state.indoorFloor = Number(event.target.value); state.activeMetric = 'rsrp'; showLayer(sim, 'rsrp'); };
        el.querySelector('[data-rf-indoor-band]').onchange = event => { state.indoorBand = event.target.value; state.activeMetric = 'rsrp'; showLayer(sim, 'rsrp'); };
        el.querySelectorAll('[data-rf-indoor-metric]').forEach(button => button.onclick = () => { state.activeMetric = button.dataset.rfIndoorMetric; showLayer(sim, state.activeMetric); });
    }
    function renderResultViews(sim) {
        const sites = Number(sim.metadata?.result?.siteDominance?.siteCount || 0);
        const el = $('rf-result-views');
        if (!el) return;
        if (sim.metadata?.result?.scenarioType === 'indoor_macro' || sim.request?.scenarioType === 'indoor_macro') {
            if (sim.status !== 'ready') { el.innerHTML = ''; return; }
            renderIndoorResultViews(sim, el); return;
        }
        const hasSiteComposite = Boolean(sim.metadata?.result?.siteDominance);
        if (!hasSiteComposite && state.activeMetric === 'best_site') state.activeMetric = 'rsrp';
        const bestServerHelp = state.activeMetric === 'best_server' ? '<div class="rf-muted">Chaque couleur représente le secteur gagnant. Cliquez un pixel pour obtenir la cellule et son tracé.</div>' : '';
        const diagnostics = sim.metadata?.result?.diagnostics || {};
        const coChannelOverlap = sim.metadata?.result?.overlapDefinition?.mode === 'winning_carrier' || diagnostics.overlapDefinition?.mode === 'winning_carrier';
        const bandRasters = Array.isArray(sim.metadata?.result?.bandRasters) ? sim.metadata.result.bandRasters : [];
        const bandControls = bandRasters.length ? `<div class="rf-band-layer-control"><b>Couverture actuelle par bande</b><span>RSRP affiche la couverture. Meilleur serveur colore le secteur gagnant : un clic trace sa liaison.</span><div>${bandRasters.map(entry => `<label><strong>${esc(entry.band)}</strong><small>${Number(entry.sectorCount || 0)} secteurs</small><span><input type="checkbox" data-rf-band-visible="${esc(entry.metric)}" ${isMetricVisible(sim.id, entry.metric) ? 'checked' : ''}> RSRP</span>${entry.bestServerMetric ? `<span><input type="checkbox" data-rf-band-serving="${esc(entry.bestServerMetric)}" ${isMetricVisible(sim.id, entry.bestServerMetric) ? 'checked' : ''}> Meilleur serveur</span>` : '<small>Relancez pour le meilleur serveur</small>'}</label>`).join('')}</div></div>` : '<div class="rf-muted">RSRP par bande : relancez cette simulation pour générer les couches individuelles.</div>';
        const diagnosticText = diagnostics.coverageHoleKm2 == null ? '' : `<div class="rf-muted">Trous <b>${diagnostics.coverageHoleKm2} km²</b> · dominance faible <b>${diagnostics.weakDominanceKm2} km²</b> · ${coChannelOverlap ? 'overlap co-canal' : 'overlap héritée'} ≥2 <b>${diagnostics.overlapGe2Km2} km²</b>. Indicateurs RSRP, pas du SINR.</div>`;
        const calibration = state.calibrationRuns[sim.id] || {};
        const profileReady = calibration.trainRunId && calibration.validationRunId;
        if (sim.status !== 'ready') { el.innerHTML = ''; return; }
        const hasEnvironmentQuality = Boolean(sim.metadata?.result?.environmentQuality);
        const metricButtons = `<div class="rf-layer-buttons"><button data-rf-metric="rsrp" class="${state.activeMetric === 'rsrp' ? 'active' : ''}">RSRP composite</button><button data-rf-metric="best_server" class="${state.activeMetric === 'best_server' ? 'active' : ''}">Meilleur secteur</button>${hasSiteComposite ? `<button data-rf-metric="best_site" class="${state.activeMetric === 'best_site' ? 'active' : ''}">Meilleur site</button>` : ''}<button data-rf-metric="margin" class="${state.activeMetric === 'margin' ? 'active' : ''}">Marge inter-site</button><button data-rf-metric="sector_margin" class="${state.activeMetric === 'sector_margin' ? 'active' : ''}">Marge secteur</button><button data-rf-metric="server_count_ge_100" class="${state.activeMetric === 'server_count_ge_100' ? 'active' : ''}">${coChannelOverlap ? 'Overlap co-canal' : 'Overlap — relancer'}</button>${hasEnvironmentQuality ? `<button data-rf-metric="environment_quality" class="${state.activeMetric === 'environment_quality' ? 'active' : ''}">Qualité environnement</button>` : ''}</div>`;
        const actionButtons = `<div class="rf-layer-buttons"><button data-rf-clone>Dupliquer comme scénario proposé</button><button data-rf-stats>Statistiques</button><button data-rf-validate="train">SmartCare 50 m · train</button><button data-rf-validate="validation">SmartCare 50 m · validation</button><button data-rf-create-profile ${profileReady ? '' : 'disabled'}>Créer profil calibré</button><a class="rf-export-link" href="${window.rfApi.exportUrl(sim.id, 'xlsx')}" target="_blank">XLSX</a><a class="rf-export-link" href="${window.rfApi.exportUrl(sim.id, 'pdf')}" target="_blank">PDF</a><a class="rf-export-link" href="rf_3d.html?id=${encodeURIComponent(sim.id)}" target="_blank" title="Vue 3D immersive — visualisation du résultat existant">🌐 3D</a></div>`;
        el.innerHTML = `<div class="rf-result-label">Affichage composite${sites ? ` · ${sites} site${sites > 1 ? 's' : ''}` : ''}</div>${metricButtons}${bandControls}${actionButtons}${diagnosticText}${bestServerHelp}${hasSiteComposite ? '' : '<div class="rf-muted">Résultat antérieur : relancez-le pour la dominance inter-site v1.7.</div>'}`;
        el.querySelectorAll('[data-rf-metric]').forEach(button => button.onclick = () => { state.activeMetric = button.dataset.rfMetric; showLayer(sim, state.activeMetric); });
        el.querySelectorAll('[data-rf-band-visible]').forEach(box => box.onchange = () => {
            const metric = box.dataset.rfBandVisible;
            if (box.checked) showLayer(sim, metric, {preserveLayers:true});
            else {
                removeLayer(sim.id, metric);
                const remaining = [...state.visibleLayers.keys()].find(key => key.startsWith(`${sim.id}:`));
                if (remaining) {
                    state.activeMetric = remaining.slice(`${sim.id}:`.length);
                    renderMapLegend(sim, state.activeMetric);
                }
                renderResultViews(sim);
            }
        });
        el.querySelectorAll('[data-rf-band-serving]').forEach(box => box.onchange = () => {
            const metric = box.dataset.rfBandServing;
            if (box.checked) showLayer(sim, metric, {preserveLayers:true});
            else {
                removeLayer(sim.id, metric);
                const remaining = [...state.visibleLayers.keys()].find(key => key.startsWith(`${sim.id}:`));
                if (remaining) {
                    state.activeMetric = remaining.slice(`${sim.id}:`.length);
                    renderMapLegend(sim, state.activeMetric);
                }
                renderResultViews(sim);
            }
        });
        el.querySelector('[data-rf-clone]')?.addEventListener('click', () => cloneScenario(sim));
        el.querySelector('[data-rf-stats]')?.addEventListener('click', () => showStatistics(sim));
        el.querySelectorAll('[data-rf-validate]').forEach(button => button.addEventListener('click', () => validateSmartCare(sim, button.dataset.rfValidate)));
        el.querySelector('[data-rf-create-profile]')?.addEventListener('click', () => createCalibrationProfile(sim));
    }

    async function cloneScenario(sim) {
        try {
            const created = await window.rfApi.clone(sim.id, {name:`Proposé — ${sim.name}`});
            state.simulation = created.simulationId;
            $('rf-progress').textContent = '✓ Scénario proposé distinct créé. Ajoutez ensuite des overrides RF par secteur avant validation.';
            await loadLibrary(); if (!created.cached) poll();
        } catch (err) { $('rf-progress').textContent = `Duplication impossible : ${err.message}`; }
    }
    async function showStatistics(sim) {
        try {
            const stats = await window.rfApi.statistics(sim.id);
            $('rf-progress').textContent = `Statistiques : ${stats.areaKm2} km² · ≥−100 dBm ${stats.coverageByThresholdKm2['-100'] ?? '—'} km² · bandes ${Object.entries(stats.bestServerAreaByBandKm2 || {}).map(([band, area]) => `${band} ${area} km²`).join(', ')}`;
        } catch (err) { $('rf-progress').textContent = `Statistiques indisponibles : ${err.message}`; }
    }
    async function chooseSmartcareSource() {
        const sources = (await window.rfApi.calibrationSources()).smartcare || [];
        if (!sources.length) throw new Error('Aucune campagne SmartCare prête contenant du RSRP dominant.');
        if (sources.length === 1) return sources[0];
        const choices = sources.map((source, index) => `${index + 1}. ${source.name} (${Number(source.point_count).toLocaleString()} grilles)`).join('\n');
        const answer = window.prompt(`Choisissez la campagne SmartCare :\n${choices}`, '1');
        const index = Number(answer) - 1;
        if (!Number.isInteger(index) || !sources[index]) throw new Error('Campagne SmartCare non sélectionnée.');
        return sources[index];
    }
    async function validateSmartCare(sim, split = 'validation') {
        try {
            const source = await chooseSmartcareSource();
            const existing = state.calibrationRuns[sim.id];
            if (existing?.sourceId && existing.sourceId !== source.id) throw new Error('Utilisez la même campagne SmartCare pour train et validation du même profil.');
            $('rf-progress').textContent = `SmartCare 50 m ${split} · ${source.name} en cours…`;
            const result = await window.rfApi.validate(sim.id, {sourceType:'smartcare', sourceId:source.id, split, maxPoints:10000});
            const stats = result.stats || {};
            state.calibrationRuns[sim.id] = {...(state.calibrationRuns[sim.id] || {}), sourceId:source.id, [split === 'train' ? 'trainRunId' : 'validationRunId']:result.id};
            $('rf-progress').textContent = `SmartCare ${split} ${source.name} : n=${stats.count} · biais ${stats.biasDb} dB · MAE ${stats.maeDb} dB · RMSE ${stats.rmseDb} dB · P90 ${stats.p90AbsDb} dB · ${result.unmatchedServingCell} cellules non jointes.`;
            renderResultViews(sim);
        } catch (err) { $('rf-progress').textContent = `Validation SmartCare impossible : ${err.message}`; }
    }
    async function createCalibrationProfile(sim) {
        try {
            const runs = state.calibrationRuns[sim.id] || {};
            if (!runs.trainRunId || !runs.validationRunId || !runs.sourceId) throw new Error('Exécutez d’abord SmartCare train puis SmartCare validation pour cette simulation.');
            const name = window.prompt('Nom du profil de calibration', `SmartCare — ${sim.name}`);
            if (!name?.trim()) return;
            const profile = await window.rfApi.createCalibrationProfile({name:name.trim(), sourceType:'smartcare', sourceId:runs.sourceId, scope:{simulationId:sim.id, dataset:sim.metadata?.dataset?.name || null}, trainRunId:runs.trainRunId, validationRunId:runs.validationRunId});
            await loadCalibrationProfiles();
            $('rf-calibration-profile').value = profile.id;
            $('rf-progress').textContent = `✓ Profil ${profile.quality} créé : correction ${Number(profile.correctionDb || 0).toFixed(2)} dB. Il est appliqué uniquement aux prochaines simulations sélectionnant ce profil.`;
        } catch (err) { $('rf-progress').textContent = `Création du profil impossible : ${err.message}`; }
    }
    function showLayer(sim, metric = state.activeMetric || 'rsrp', {preserveLayers = false} = {}) {
        const m = map(); if (!m || !window.L) return;
        const indoor = sim.metadata?.result?.scenarioType === 'indoor_macro' || sim.request?.scenarioType === 'indoor_macro';
        if (indoor && state.scenarioType !== 'indoor_macro') setScenarioType('indoor_macro', {preserveSelection:true});
        if (metric === 'best_site' && !sim.metadata?.result?.siteDominance) metric = 'rsrp';
        // Keep previously checked simulations on the map.  Reopening the
        // active simulation only replaces its own tile layer (for example
        // after a metric or legend change), never clears another comparison.
        if (preserveLayers) removeLayer(sim.id, metric); else removeLayer(sim.id);
        state.simulation = sim.id; state.activeMetric = metric;
        const styleRevision = Number(sim.metadata?.style?.styleRevision || 0);
        const indoorOptions = indoor ? {floor:state.indoorFloor, band:state.indoorBand} : {};
        state.layer = L.tileLayer(`${window.rfApi.tileUrl(sim.id, metric, indoorOptions)}&style=${encodeURIComponent(styleRevision)}`, {opacity: Number(sim.metadata?.style?.opacity ?? .72), maxZoom: 22, zIndex: 460, crossOrigin: true, attribution:indoor ? 'Indoor RF Coverage' : 'RF Coverage'}).addTo(m);
        state.visibleLayers.set(layerKey(sim.id, metric), state.layer);
        const result = sim.metadata?.result || {};
        const building = result.buildings?.[0];
        if (indoor && building?.centroid) {
            // Indoor rasters are clipped to a building and may not expose the
            // legacy outdoor `bounds` field.  Always focus the building when
            // reopening a cached result so its 1–2 m cells are immediately
            // visible instead of leaving the map at the national extent.
            m.setView([building.centroid.lat, building.centroid.lon], Math.max(m.getZoom(), 18));
        } else if (result.bounds && sim.metadata?.dataset?.crs) {
            // Outdoor result bounds are in dataset CRS; transmitter location
            // remains the safe WGS84 map focus.
            const first = result.transmitters?.[0];
            if (first) m.setView([first.lat, first.lon], Math.min(m.getZoom(), 13));
        }
        m.off('click', identify); m.on('click', identify);
        renderResultViews(sim);
        renderMapLegend(sim, metric);
        state.indoorPickMode = !indoor;
        const legacy = !indoor && !sim.metadata?.result?.siteDominance ? ' · résultat antérieur : relancez pour la marge inter-site v1.7.' : '';
        $('rf-progress').textContent = `✓ Résultat ${indoor ? 'Indoor ' : ''}prêt · ${sim.metadata?.result?.resolutionM || ''} m · cliquez la couverture pour inspecter un pixel.${legacy}`;
    }
    function renderedServingSectorTip(winner, fallback) {
        const renderer = window.mapRenderer;
        const keys = [winner?.cell, winner?.id, winner?.site].filter(Boolean);
        let polygon = null;
        for (const key of keys) {
            try {
                polygon = renderer?._getSitePolygon?.(key) || null;
            } catch (_) { polygon = null; }
            if (polygon) break;
        }
        const sector = polygon?.__sectorData;
        const tipLat = Number(sector?.tipLat);
        const tipLon = Number(sector?.tipLng);
        if (Number.isFinite(tipLat) && Number.isFinite(tipLon)) {
            return {
                lat: tipLat, lon: tipLon,
                azimuthDeg: Number(sector?.azimuth ?? winner?.azimuthDeg ?? fallback?.azimuthDeg),
                offsetM: Number(sector?.currentRadius ?? polygon?.__sectorRange ?? fallback?.offsetM),
                renderedTip: true,
            };
        }
        // A rendered triangular sector stores [site centre, left edge, right
        // edge].  Their outer-edge midpoint is the visible top of the sector.
        try {
            const raw = polygon?.getLatLngs?.();
            const points = Array.isArray(raw?.[0]) ? raw[0] : raw;
            if (Array.isArray(points) && points.length >= 3) {
                const lat = (Number(points[1].lat) + Number(points[2].lat)) / 2;
                const lon = (Number(points[1].lng) + Number(points[2].lng)) / 2;
                if (Number.isFinite(lat) && Number.isFinite(lon)) {
                    return {lat, lon, azimuthDeg: Number(winner?.azimuthDeg), renderedTip: true};
                }
            }
        } catch (_) { /* Use the RF-service fallback below. */ }
        return fallback;
    }
    function renderIndoorIdentify(point, event) {
        const winner = point.winningSector;
        const sectorEnd = renderedServingSectorTip(winner, point.servingSectorLineEnd);
        const facade = point.facadeEntryPoint;
        clearServingSectorTrace();
        if (winner && sectorEnd) {
            const endpoint = [Number(sectorEnd.lat), Number(sectorEnd.lon)];
            const path = [[event.latlng.lat, event.latlng.lng]];
            if (facade && Number.isFinite(Number(facade.lat)) && Number.isFinite(Number(facade.lon))) path.push([Number(facade.lat), Number(facade.lon)]);
            path.push(endpoint);
            state.winnerLine = L.polyline(path, {color:'#38bdf8', weight:3, dashArray:'7 5'}).addTo(map());
            if (facade) L.circleMarker([facade.lat, facade.lon], {radius:5, color:'#f8fafc', fillColor:'#f59e0b', fillOpacity:1, weight:2}).bindTooltip('Entrée façade').addTo(map());
            state.winnerMarker = L.circleMarker(endpoint, {radius:6, color:'#e0f2fe', weight:2, fillColor:'#0284c7', fillOpacity:1}).bindTooltip(winner.cell || 'Secteur gagnant').addTo(map());
        }
        const dbm = value => Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} dBm` : 'N/D';
        const metres = value => Number.isFinite(Number(value)) ? `${Math.round(Number(value)).toLocaleString('fr-FR')} m` : 'N/D';
        const ranked = Array.isArray(point.rankedSectors) ? point.rankedSectors : [];
        const serving = ranked[0] || winner || {};
        const neighbours = ranked.slice(1, 10).map(row => `<article class="rf-details-cell-row"><span class="rf-details-rank">#${row.rank}</span><div class="rf-details-cell-main"><b>${esc(row.cell || 'Cellule inconnue')}</b><small>${esc(`${row.technology || ''} ${row.band || ''}`.trim())}</small></div><div class="rf-details-cell-kpi"><b>${dbm(row.rsrp)}</b><small>RSRP indoor</small></div><div class="rf-details-cell-distance"><b>${metres(row.distanceM)}</b><small>au point · ${metres(row.distanceToServingM)} du serveur</small></div></article>`).join('');
        const summary = `<section class="rf-details-serving"><span class="rf-details-section-kicker">SERVEUR INDOOR · ÉTAGE ${Number(point.floor || 1)}</span><h3>${esc(serving.cell || 'Cellule non identifiée')}</h3><div class="rf-details-serving-grid"><span><small>Bande</small><b>${esc(`${serving.technology || ''} ${serving.band || point.band || '—'}`.trim())}</b></span><span><small>RSRP intérieur</small><b>${dbm(serving.rsrp ?? point.rsrp)}</b></span><span><small>Distance</small><b>${metres(serving.distanceM ?? point.distanceM)}</b></span></div></section>`;
        const other = `<section class="rf-details-neighbours"><div class="rf-details-neighbours-head"><b>Autres cellules</b><small>${Math.max(0, ranked.length - 1)} candidat(s) · ${esc(point.rankedSectorsScope || '')}</small></div><div class="rf-details-cell-list">${neighbours || '<small>Aucun autre secteur crédible.</small>'}</div></section>`;
        const provenance = point.lossProvenance || serving.lossProvenance || 'statistical fallback';
        const details = `<details class="rf-details-more"><summary>Plus de détails Indoor</summary><div><b>Point d’entrée façade :</b> ${facade ? `${Number(facade.lat).toFixed(6)}, ${Number(facade.lon).toFixed(6)}` : 'N/D'}<br><b>RSRP incident extérieur :</b> ${dbm(point.outdoorIncidentRsrp)}<br><b>Perte d’entrée bâtiment :</b> ${Number(point.buildingEntryLossDb ?? 0).toFixed(1)} dB<br><b>Profondeur intérieure :</b> ${metres(point.indoorDepthM)} · perte ${Number(point.indoorDepthLossDb ?? 0).toFixed(1)} dB<br><b>Hauteur UE :</b> ${Number(point.receiverHeightAglM || 0).toFixed(1)} m AGL<br><b>Source des pertes :</b> ${esc(provenance)}<br><b>Qualité :</b> ${esc(point.quality || 'caution')}<br><small>Modèle macro-to-indoor 2.5D : sans pièces, murs internes, réflexions ni DAS.</small></div></details>`;
        showRfDetailsPanel(summary + other + details);
    }
    function renderedServingSectorTip(winner, fallback) {
        const renderer = window.mapRenderer;
        const keys = [winner?.cell, winner?.id, winner?.site].filter(Boolean);
        let polygon = null;
        for (const key of keys) {
            try {
                polygon = renderer?._getSitePolygon?.(key) || null;
            } catch (_) { polygon = null; }
            if (polygon) break;
        }
        const sector = polygon?.__sectorData;
        const tipLat = Number(sector?.tipLat);
        const tipLon = Number(sector?.tipLng);
        if (Number.isFinite(tipLat) && Number.isFinite(tipLon)) {
            return {
                lat: tipLat, lon: tipLon,
                azimuthDeg: Number(sector?.azimuth ?? winner?.azimuthDeg ?? fallback?.azimuthDeg),
                offsetM: Number(sector?.currentRadius ?? polygon?.__sectorRange ?? fallback?.offsetM),
                renderedTip: true,
            };
        }
        // A rendered triangular sector stores [site centre, left edge, right
        // edge].  Their outer-edge midpoint is the visible top of the sector.
        try {
            const raw = polygon?.getLatLngs?.();
            const points = Array.isArray(raw?.[0]) ? raw[0] : raw;
            if (Array.isArray(points) && points.length >= 3) {
                const lat = (Number(points[1].lat) + Number(points[2].lat)) / 2;
                const lon = (Number(points[1].lng) + Number(points[2].lng)) / 2;
                if (Number.isFinite(lat) && Number.isFinite(lon)) {
                    return {lat, lon, azimuthDeg: Number(winner?.azimuthDeg), renderedTip: true};
                }
            }
        } catch (_) { /* Use the RF-service fallback below. */ }
        return fallback;
    }
    async function identify(event) {
        if (!state.simulation) return;
        try {
            const point = await window.rfApi.identify(state.simulation, event.latlng.lat, event.latlng.lng, state.activeMetric, state.scenarioType === 'indoor_macro' || String(state.simulation).startsWith('in_') ? {floor:state.indoorFloor, band:state.indoorBand} : {});
            if (point.scenarioType === 'indoor_macro') { renderIndoorIdentify(point, event); return; }
            const winner = point.winningSector;
            const sectorEnd = renderedServingSectorTip(winner, point.servingSectorLineEnd);
            clearServingSectorTrace();
            if (winner && winner.lat != null) {
                const endpoint = sectorEnd && Number.isFinite(Number(sectorEnd.lat)) && Number.isFinite(Number(sectorEnd.lon))
                    ? [Number(sectorEnd.lat), Number(sectorEnd.lon)] : [winner.lat, winner.lon];
                state.winnerLine = L.polyline([[event.latlng.lat, event.latlng.lng], endpoint], {color:'#38bdf8', weight:2, dashArray:'6 6'}).addTo(map());
                state.winnerMarker = L.circleMarker(endpoint, {radius:6, color:'#e0f2fe', weight:2, fillColor:'#0284c7', fillOpacity:1})
                    .bindTooltip(`${esc(winner.cell || 'Secteur')} · ${sectorEnd?.azimuthDeg ?? winner.azimuthDeg ?? '—'}°`, {direction:'top', opacity:.92}).addTo(map());
            }
            const title = winner ? `<b>${esc(winner.cell)}</b> · ${esc(winner.technology)} ${esc(winner.band)}${point.selectedBand ? ' · meilleur serveur de la bande sélectionnée' : ''}` : 'Aucun serveur';
            const winningSite = point.winningSite;
            const env = point.environment || {};
            const structure = point.obstacleHeightM == null ? '' : `<br>Obstacle local: ${point.obstacleHeightM.toFixed(1)} m${env.buildings?.pixels ? ' · bâtiments' : ''}${env.vegetation?.pixels ? ' · végétation' : ''}`;
            const path = point.pathObstructionLossDb == null ? '' : `<br>Trajet complet: ${point.pathBlocked ? 'masqué' : 'LOS'} · diffraction ${point.pathObstructionLossDb.toFixed(1)} dB · Fresnel ${point.fresnelClearance?.toFixed?.(2) ?? '—'} F1`;
            const site = winningSite ? `<br>Meilleur site: <b>${esc(winningSite.site || '—')}</b> · ${Number(winningSite.sectorCount || 0)} secteurs` : '';
            const marginName = winningSite && Number(point.bestSite || 0) ? 'Marge inter-site' : 'Marge';
            const sectorTrace = sectorEnd ? `<br><small>Tracé vers la pointe du secteur ${Number(sectorEnd.azimuthDeg).toFixed(0)}°${Number.isFinite(Number(sectorEnd.offsetM)) ? ` · portée visuelle ${Number(sectorEnd.offsetM).toFixed(0)} m` : ''}.</small>` : '';
            const sectorMargin = point.sectorMargin == null ? '' : `<br>Marge secteur: <b>${point.sectorMargin.toFixed(1)} dB</b> · second secteur ${point.secondServerRsrp?.toFixed?.(1) ?? '—'} dBm`;
            const coChannelOverlap = point.overlapDefinition?.mode === 'winning_carrier';
            const overlap = point.serverCountGeMinus100 == null ? '' : `<br>${coChannelOverlap ? 'Serveurs co-canal' : 'Serveurs (résultat hérité)'}${coChannelOverlap && point.overlapCarrier ? ` · ${esc(point.overlapCarrier)}` : ''} ≥ −100 dBm: <b>${point.serverCountGeMinus100}</b>${coChannelOverlap && point.serverCountGeMinus100 >= 3 && Number(point.sectorMargin ?? point.margin) < 3 ? ' · candidat overlap co-canal (à confirmer SINR)' : ''}`;
            const itm = point.nativeItm?.available ? `<br>ITM natif P2P: <b>${point.nativeItm.basicTransmissionLossDb} dB</b> · ${point.nativeItm.samples} échantillons · vérification seulement` : '';
            const environmentQuality = point.environmentQualityLabel ? `<br>Données environnementales : <b>${esc(point.environmentQualityLabel)}</b>` : '';
            const fmtDbm = value => Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} dBm` : 'N/D';
            const fmtDistance = value => Number.isFinite(Number(value)) ? `${Math.round(Number(value)).toLocaleString('fr-FR')} m` : 'N/D';
            const ranked = Array.isArray(point.rankedSectors) ? point.rankedSectors : [];
            const serving = ranked.find(row => row?.isServing) || (winner ? {
                rank: 1, isServing: true, cell: winner.cell, band: winner.band,
                technology: winner.technology, rsrp: point.rsrp, distanceM: point.distanceM, distanceToServingM: 0,
            } : null);
            const neighbourRows = ranked.filter(row => !row?.isServing);
            const cellRow = row => `<article class="rf-details-cell-row">
                <span class="rf-details-rank">#${Number(row.rank || '—')}</span>
                <div class="rf-details-cell-main"><b>${esc(row.cell || 'Cellule non identifiée')}</b><small>${esc(row.technology || '')} ${esc(row.band || 'Bande inconnue')}</small></div>
                <div class="rf-details-cell-kpi"><b>${fmtDbm(row.rsrp)}</b><small>${row.rsrpSource === 'exact calculated raster' ? 'RSRP exact' : 'RSRP recalculé'}</small></div>
                <div class="rf-details-cell-distance"><b>${fmtDistance(row.distanceM)}</b><small>au point${row.distanceToServingM != null ? ` · ${fmtDistance(row.distanceToServingM)} du serveur` : ''}</small></div>
            </article>`;
            const servingSummary = serving ? `<section class="rf-details-serving">
                <span class="rf-details-section-kicker">SERVEUR</span>
                <h3>${esc(serving.cell || 'Cellule non identifiée')}</h3>
                <div class="rf-details-serving-grid">
                    <span><small>Bande</small><b>${esc(`${serving.technology || ''} ${serving.band || '—'}`.trim())}</b></span>
                    <span><small>RSRP</small><b>${fmtDbm(serving.rsrp)}</b></span>
                    <span><small>Distance au point</small><b>${fmtDistance(serving.distanceM)}</b></span>
                </div>
            </section>` : `<section class="rf-details-serving rf-details-empty">Aucun serveur calculé à cet emplacement.</section>`;
            const neighbours = neighbourRows.length ? `<section class="rf-details-neighbours">
                <div class="rf-details-neighbours-head"><b>Autres cellules au point</b><small>${neighbourRows.length} secteur${neighbourRows.length > 1 ? 's' : ''} · ${esc(point.rankedSectorsScope || 'simulation')}</small></div>
                <div class="rf-details-cell-list">${neighbourRows.map(cellRow).join('')}</div>
            </section>` : `<section class="rf-details-neighbours rf-details-empty"><b>Autres cellules au point</b><small>Aucun autre secteur actif dans la portée de cette simulation.</small></section>`;
            const technicalDetails = `${title}${site}<br>Path loss: <b>${point.pathLoss?.toFixed?.(1) ?? '—'} dB</b><br>${marginName}: <b>${point.margin?.toFixed?.(1) ?? 'N/D'} dB</b>${sectorMargin}${overlap}${environmentQuality}${structure}${path}${itm}${sectorTrace}<br><small>${esc(point.propagationMode || '')} · ${esc(point.quality || '')}</small>`;
            showRfDetailsPanel(`${servingSummary}${neighbours}<details class="rf-details-more"><summary>Plus de détails</summary><div>${technicalDetails}</div></details>`);
        } catch (_) { /* Clicks outside a simulation must stay harmless. */ }
    }
    function showRfDetailsPanel(content) {
        document.getElementById('rf-details-panel')?.remove();
        const panel = document.createElement('section');
        panel.id = 'rf-details-panel';
        panel.className = 'rf-details-panel';
        panel.innerHTML = `<header class="rf-details-head" title="Glisser pour déplacer"><span>⠿ Détails RF · glisser</span><button type="button" aria-label="Fermer les détails RF">×</button></header><div class="rf-details-body">${content}</div>`;
        document.body.appendChild(panel);
        panel.querySelector('button').onclick = () => panel.remove();
        const handle = panel.querySelector('.rf-details-head');
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.target.closest('button')) return;
            event.preventDefault();
            const rect = panel.getBoundingClientRect();
            const initial = {x:event.clientX, y:event.clientY, left:rect.left, top:rect.top};
            panel.classList.add('rf-details-dragging');
            panel.style.right = 'auto';
            try { handle.setPointerCapture?.(event.pointerId); } catch (_) { /* Pointer capture is optional. */ }
            const move = e => {
                const width = panel.getBoundingClientRect().width;
                const height = panel.getBoundingClientRect().height;
                panel.style.left = `${Math.max(8, Math.min(initial.left + e.clientX - initial.x, window.innerWidth - width - 8))}px`;
                panel.style.top = `${Math.max(8, Math.min(initial.top + e.clientY - initial.y, window.innerHeight - height - 8))}px`;
            };
            const end = e => {
                panel.classList.remove('rf-details-dragging');
                try { handle.releasePointerCapture?.(e?.pointerId); } catch (_) { /* Pointer already released. */ }
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', end);
                window.removeEventListener('pointercancel', end);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', end, {once:true});
            window.addEventListener('pointercancel', end, {once:true});
        });
    }
    async function loadLibrary() {
        try {
            const response = await window.rfApi.list();
            const items = response.items || [];
            const target = $('rf-library');
            target.innerHTML = items.length ? items.map(sim => {
                const isReady = sim.status === 'ready';
                const visible = hasVisibleSimulation(sim.id);
                const removable = ['ready', 'failed', 'cancelled'].includes(sim.status);
                return `<div class="rf-library-row ${esc(sim.status)}" data-rf-library-row="${esc(sim.id)}">
                    <label class="rf-library-visibility" title="Afficher ou masquer cette simulation sur la carte"><input type="checkbox" data-rf-visible="${esc(sim.id)}" ${visible ? 'checked' : ''} ${isReady ? '' : 'disabled'}><span>${isReady ? '●' : '○'}</span></label>
                    <button type="button" class="rf-library-open" data-rf-open="${esc(sim.id)}" title="Ouvrir et inspecter cette simulation"><b>${esc(sim.name || sim.id)}</b><small>${esc(sim.quality)} · ${esc(sim.status)}</small></button>
                    ${isReady ? `<a class="rf-library-3d" href="rf_3d.html?id=${encodeURIComponent(sim.id)}" target="_blank" title="Vue 3D — visualisation du résultat">🌐</a>` : ''}
                    <button type="button" class="rf-library-rename" data-rf-rename="${esc(sim.id)}" data-rf-current-name="${esc(sim.name || '')}" title="Renommer">✎</button>
                    <button type="button" class="rf-library-remove" data-rf-remove="${esc(sim.id)}" data-rf-current-name="${esc(sim.name || sim.id)}" title="${removable ? 'Supprimer définitivement cette simulation' : 'Annulez le calcul avant de supprimer'}" ${removable ? '' : 'disabled'} aria-label="Supprimer ${esc(sim.name || sim.id)}">×</button>
                </div>`;
            }).join('') : '<div class="rf-muted">Aucune simulation enregistrée.</div>';
            target.querySelectorAll('[data-rf-open]').forEach(btn => btn.onclick = async () => {
                const sim = await window.rfApi.get(btn.dataset.rfOpen);
                if (sim.status === 'ready') { showLayer(sim); await loadLibrary(); }
                else { state.simulation = sim.id; poll(); }
            });
            target.querySelectorAll('[data-rf-visible]').forEach(box => box.onchange = async () => {
                const sim = await window.rfApi.get(box.dataset.rfVisible);
                if (!box.checked) {
                    removeLayer(sim.id);
                    if (state.simulation === sim.id) {
                        state.simulation = null;
                        map()?.off('click', identify);
                        $('rf-result-views').innerHTML = '';
                    }
                    await loadLibrary();
                    return;
                }
                if (sim.status === 'ready') { showLayer(sim); await loadLibrary(); }
            });
            target.querySelectorAll('[data-rf-rename]').forEach(button => button.onclick = async () => {
                const current = button.dataset.rfCurrentName || '';
                const name = window.prompt('Nom de la simulation RF', current);
                if (name == null || name.trim() === current.trim()) return;
                try {
                    await window.rfApi.rename(button.dataset.rfRename, name.trim());
                    await loadLibrary();
                    $('rf-progress').textContent = '✓ Nom de la simulation enregistré.';
                } catch (err) { $('rf-progress').textContent = `Renommage impossible : ${err.message}`; }
            });
            target.querySelectorAll('[data-rf-remove]').forEach(button => button.onclick = async () => {
                const id = button.dataset.rfRemove;
                const name = button.dataset.rfCurrentName || id;
                if (!window.confirm(`Supprimer définitivement la simulation « ${name} » ?\n\nSes rasters, tuiles et résultats locaux seront supprimés. Cette action est irréversible.`)) return;
                button.disabled = true;
                try {
                    await window.rfApi.remove(id);
                    removeLayer(id);
                    if (state.simulation === id) {
                        state.simulation = null;
                        state.activeMetric = 'rsrp';
                        map()?.off('click', identify);
                        $('rf-result-views').innerHTML = '';
                    }
                    await loadLibrary();
                    $('rf-progress').textContent = `✓ Simulation supprimée : ${name}.`;
                } catch (err) {
                    button.disabled = false;
                    $('rf-progress').textContent = `Suppression impossible : ${err.message}`;
                }
            });
        } catch(err) { $('rf-library').innerHTML = `<div class="rf-error">${esc(err.message)}</div>`; }
    }
    async function open() {
        panel(); $('rf-panel').classList.add('open'); polygonStatus();
        map()?.off('click', indoorMapClick); map()?.on('click', indoorMapClick);
        try {
            const [health, pack, bands] = await Promise.all([window.rfApi.health(), window.rfApi.moroccoPackStatus(), window.rfApi.bands()]);
            $('rf-engine-status').innerHTML = `<b>${health.engine}</b> · ${health.nativeItm ? 'NTIA ITM disponible' : 'moteur terrain/clutter exploratoire'} · ${health.queueDepth} job(s) en attente`;
            state.moroccoPack = pack;
            state.bandOptions = bands.items || [];
            if (!state.bandSelectionInitialized) {
                state.selectedBands = new Set(state.bandOptions.map(item => bandKey(item.band, item.technology)));
                state.bandSelectionInitialized = true;
            }
            renderMoroccoPack(); renderBandFilter(); await refreshDatasets(); renderOperatorFilter(); renderTransmitters(); setScenarioType(state.scenarioType, {preserveSelection:true}); loadCalibrationProfiles(); loadLibrary();
        } catch(err) { $('rf-engine-status').innerHTML = `<span class="rf-error">Moteur RF indisponible : ${esc(err.message)}. Lancez los_backend/start.sh.</span>`; }
    }
    function close() { $('rf-panel')?.classList.remove('open'); map()?.off('click', indoorMapClick); }
    window.addEventListener('site-sector-clicked', event => {
        if (!$('rf-panel')?.classList.contains('open')) return;
        if (state.scenarioType === 'indoor_macro') return;
        const detail = event.detail || {};
        if (!mapSiteLabel(detail) || !Number.isFinite(Number(detail.lat)) || !Number.isFinite(Number(detail.lng))) return;
        state.mapSiteCandidate = {...detail};
        state.mapSiteResolvedGroup = null;
        state.mapSiteError = '';
        void primeMapSiteGroup(state.mapSiteCandidate);
        $('rf-progress').textContent = `Site carte sélectionné : ${mapSiteLabel(detail)}. Ajoutez-le au groupe à l’étape 2.`;
        // The RF panel may already be scrolled in its advanced settings. Move
        // the explicit Add action into view, rather than expecting the user to
        // hunt for it above the search field after a map click.
        requestAnimationFrame(() => {
            const action = $('rf-map-site-action');
            action?.scrollIntoView?.({block:'center', behavior:'smooth'});
            $('rf-add-map-site')?.focus?.({preventScroll:true});
        });
    });
    document.addEventListener('DOMContentLoaded', () => $('rf-open-btn')?.addEventListener('click', open));
    window.rfSimulationOpen = open; window.rfSimulationClose = close;
})();
