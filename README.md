# COP Analyzer (Lite)

Static-only drive-test viewer. Same UI shell as Optim Analyzer, trimmed to:

- **DT import:** csv / xlsx / xls / ods / txt / kml / kmz (no `.nmf` / `.nmfs` / `.trp`)
- **Sites:** current format (xlsx / xls / ods / csv / kml / kmz) + manual Add Site + KML export + Workspace
- **Left sidebar per log:** Coverage (RSRP, RSCP, RxLev) · Quality (SINR, EcNo, RxQual, RSRQ) · MOS (any MOS column) · Throughput DL+UL
- **Auto-analysis kept:** `Radio candidates to review` (4G/5G, engine v15) + `Voice candidates to review`, incl. radio layers/RCA view
  - Radio review customized: cards renamed (Nombre de problème, Problème de couverture, Problème de la Qualité, Problème couverture & qualité, Passage de la 5G vers LTE; P1/P2, Worst P10, Distance max, Confiance globale removed), no Executive Summary / Incidents prioritaires / Macro zones tables, Segments filters (Population, Bande, Priorité, Type, RCA, Confiance) and XLSX validation export hidden, Diagnostic column shows short direct summary (issue + serving PCI/ARFCN + degraded metric + distance + neighbor note) with collapsed RCA détaillée
- **Removed:** Benchmark, Tools (LOS / RF Simulation / Local AI / Spider / polygon), Analysis (Benchmark / Statistics / Theme settings), SmartCare, GeoData, BDD, NMFS/TRP decoders

## Run (no backend)

```bash
cd COP_Analyzer
python3 -m http.server 8000
# open http://localhost:8000
```

No `server.py`, no LOS backend, no Python deps. Any static host works.

## Access gate

`index.html` opens on a login screen (inline gate script + background `landing-bg.jpg`). Scripts load with `defer` so the gate paints instantly; the 200k-sector BDD loads only after login.
Default credentials: **admin / cop2026**. The gate shows on every page load (no session persistence). Logout via File > Logout.

- Place the background image next to `index.html` as `landing-bg.jpg` (a dark-red gradient is used if missing).
- To change the password, hash it with `node -e "console.log(require('crypto').createHash('sha256').update('NEW').digest('hex'))"` and replace the value in the inline gate script in `index.html`.
- Note: static login is a deterrent, not hardened security (no backend to verify against).

## Analyse Optim (v15 + local BDD)

Radio engine upgraded to `lte-nr-radio-v15` with `optim-deep-bdd-v6`: serving dwell, Top 3 polluters, classification, executive summary + full text per incident (new `Analyse Optim` table column, kept alongside the short Diagnostic).

- New modules: `radio_profiles.js`, `radio_mos_analyzer.js`, `radio_throughput_analyzer.js`, `radio_scoring.js`, `radio_rca_engine.js`, `radio_neighbor_mobility_rca.js`, `radio_scan_fusion.js`, `route_scan_analyzer.js`, `radio_optim_analysis.js` (script order in `index.html` follows the package spec).
- `bdd_matcher.js` is a faithful JS port of `bdd_matcher.py` (verified byte-identical output vs Python on a fuzz case + mirrored unit tests). `/api/bdd/match` is served locally from the loaded BDD sectors, so the static app gets full Class/géométrie/recommandations enrichment without backend.
- Without scan neighbors or BDD, Optim degrades gracefully (measured narratives, explicit unavailable statuses).

## Files

- `index.html` — lite menus (`window.COP_LITE = true`, allowlist + cleanup helpers inline)
- `parser.js` — synced with reference (neighbor-tab v2/v3 schemas for new Nemo exports: measured LTE/NR neighbors, 8976 pts on Export EMA.txt)
- `app.js` — same core, plus lite guards: sidebar allowlist filter, blocked `.nmf/.nmfs/.trp`, hidden neighbors/signaling/events sections
- `map_renderer.js`, `parser.js`, `metric_registry.js`, `theme_config.js`, `theme_v2.js`, `window_manager.js`, `site_match_utils.js`
- `voice_incident_analyzer.js`, `radio_degradation_analyzer.js`, `radio_degradation_ui.js`, `radio_professional_report.js`, `radio_dt_cop_export.js`
- COP export (`radio_dt_cop_export.js`): no `Description` column — `Analyse Optim` holds the executive summary only; download is a styled SpreadsheetML `.xls` (dark-red headers, banded rows, wrap, freeze, autofilter), generated locally without server
- `style.css`, `additional_styles.css`, `grid_styles.css`, `site_editor_modal.html`, `icons/`, `Site.png`, `site_tower.png`
- Reference-only (loaded, UI hidden): `benchmark_nemo_*_state.js`, `cesium_map_adapter.js`, `analyze_stats.js`, `nmf*.js`, `lte_ho_analysis.js`
