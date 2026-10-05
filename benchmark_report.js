/* Dedicated Benchmark Analysis Report workspace.  Data comes solely from the
   compact /api/benchmark-nemo/report projection, never from raw parser rows. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? "—" : value).replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[c]));
  const num = (value, digits = 1) => Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, {maximumFractionDigits: digits}) : "—";
  const statusClass = (value) => { const v = String(value || "").toLowerCase(); return v.includes("confirmed") || v === "valid" ? "br-status--good" : v.includes("deficit") || v.includes("blocked") || v.includes("contradicted") ? "br-status--bad" : v.includes("hypothesis") || v.includes("directional") || v.includes("caution") ? "br-status--warn" : ""; };
  let report = null;
  let filters = {direction: "DL", scope: "all", dtId: "", causeStatus: ""};
  const api = (path) => fetch(path).then(async (res) => { const data = await res.json(); if (data.status === "pending") throw new Error(data.message || "Benchmark import is still running."); if (!res.ok) throw new Error(data.message || "Report unavailable"); return data.report; });
  const chip = (status) => '<span class="br-status ' + statusClass(status) + '">' + esc(String(status || "NOT MEASURED").replaceAll("_", " ")) + "</span>";
  const card = (item) => '<article class="br-card br-card--click" tabindex="0" data-report-card="' + esc(item.id) + '"><div class="br-card-label">' + esc(item.label) + '</div><div class="br-card-value">' + esc(item.value) + '</div><div class="br-card-detail">' + esc(item.detail) + '</div>' + chip(item.status) + '</article>';
  const barRows = (rows, valueKey, variant) => {
    const max = Math.max(...rows.map((r) => Number(r[valueKey]) || 0), 1);
    return rows.map((r) => '<div class="br-bar-row"><strong>' + esc(r.operator || r.cell || r.site || "—") + '</strong><div class="br-bar-track"><div class="br-bar ' + (variant || "") + '" style="width:' + Math.max(2, (Number(r[valueKey]) || 0) / max * 100) + '%"></div></div><span>' + esc(num(r[valueKey])) + (valueKey.toLowerCase().includes("pct") ? "%" : " Mbps") + '</span></div>').join("");
  };
  const section = (id, title, subtitle, content) => '<section id="' + id + '" class="br-section"><div class="br-heading"><div><h2>' + esc(title) + '</h2><p>' + esc(subtitle || "") + '</p></div></div>' + content + '</section>';
  function radioSummaryTable(rows) {
    if (!rows || !rows.length) return '<div class="br-empty">No CA, modulation or RI evidence is available for this DT.</div>';
    return '<table class="br-matrix"><thead><tr><th>Operator</th><th>CA / bands observed</th><th>CQI</th><th>MCS</th><th>RI</th></tr></thead><tbody>' + rows.map((row) => {
      const modulation = row.modulation || {}, ri = row.ri || {}, bands = (row.bands || []).join(" + ") || "not measured";
      const ca = String(row.caStatus || "NOT_MEASURED").replaceAll("_", " ") + (row.carrierCount ? " · " + row.carrierCount + " bands" : "");
      const cqi = Number(modulation.cqiSampleCount) ? num(modulation.cqiMedian) + " · n=" + esc(modulation.cqiSampleCount) : "not measured";
      const mcs = Number(modulation.mcsSampleCount) ? num(modulation.mcsMedian) + " · n=" + esc(modulation.mcsSampleCount) : "not measured";
      const riText = Number(ri.sampleCount) ? "median " + num(ri.median) + " · n=" + esc(ri.sampleCount) : "not measured";
      return '<tr><td><strong>' + esc(row.operator) + '</strong></td><td><strong>' + esc(ca) + '</strong><br><span class="br-card-detail">' + esc(bands) + '</span></td><td>' + cqi + '</td><td>' + mcs + '</td><td>' + riText + '</td></tr>';
    }).join("") + '</tbody></table><p class="br-card-detail">CA reports observed bands in this DT; it does not infer an unmeasured carrier-aggregation configuration. CQI and MCS remain distinct metrics.</p>';
  }
  function renderOverview(data) {
    const meta = data.meta || {}, exec = data.executiveSummary || {}, p = data.performance || {}, validity = data.validity || {};
    const controls = '<div class="br-filterbar br-no-print">' +
      '<label class="br-filter">Direction<select id="brDirection"><option value="DL">DL</option><option value="UL">UL</option></select></label>' +
      '<label class="br-filter">DT<select id="brDt"><option value="">All DTs</option>' + (data.filters.availableDts || []).map((d) => '<option value="' + esc(d.canonicalDtId) + '">' + esc(d.label || d.canonicalDtId) + '</option>').join("") + '</select></label>' +
      '<label class="br-filter">Cause status<select id="brCause"><option value="">All statuses</option><option>SUPPORTED</option><option>HYPOTHESIS</option><option>NOT_MEASURED</option><option>CONTRADICTED</option></select></label>' +
      '<button class="br-button" id="brReset">Reset</button></div>';
    const hero = '<header class="br-hero"><div class="br-hero-actions br-no-print"><button class="br-button" id="brExportExcel">Exporter le rapport Excel</button><button class="br-button br-button--quiet" id="brPrint">Print</button><button class="br-button br-button--quiet" id="brClose">Close</button></div><div class="br-kicker">Evidence-driven telecom benchmark</div><h1>Benchmark Analysis Report</h1><p>' + esc(exec.headline || "Campaign report") + '</p><div class="br-meta"><span>' + esc(meta.campaign) + '</span><span>' + esc(meta.scopeLabel || "All DTs") + '</span><span>' + esc(meta.dtCount) + ' DTs</span><span>' + esc(meta.direction || "DL") + '</span><span>Analysis v' + esc(meta.analysisVersion) + '</span><span>' + esc(validity.overallStatus || "not measured") + '</span></div></header>';
    const nav = '<nav class="br-nav br-no-print"><a href="#brOverview">Overview</a><a href="#brPerformance">Performance</a><a href="#brEvidence">Evidence</a><a href="#brLocalization">Localization</a><a href="#brDiagnostic">Diagnostic</a><a href="#brActions">Actions</a><a href="#brDetails">DT details</a></nav>';
    const cards = '<div class="br-grid">' + (data.kpiCards || []).map(card).join("") + '</div>';
    const selectedRadio = data.filters && data.filters.scope === "dt" ? '<article class="br-card" style="margin-top:12px"><div class="br-card-label">Selected DT — CA, modulation and RI summary</div>' + radioSummaryTable((data.drilldown || {}).radioSummary || []) + '</article>' : "";
    const performance = '<div class="br-grid br-grid--two"><article class="br-card"><div class="br-card-label">Executive conclusion</div><p class="br-narrative">' + esc(exec.managementSummary) + '</p><ul class="br-list">' + (exec.keyMessages || []).map((m) => '<li><strong>' + esc(m.type) + ':</strong> ' + esc(m.message) + '</li>').join("") + '</ul></article><article class="br-card br-chart"><div class="br-card-label">Operator throughput</div>' + barRows(p.ranking || [], "avgDlMbps") + '</article></div>' + selectedRadio;
    const missingItems = validity.notMeasured || [];
    const missingHtml = missingItems.length ? missingItems.slice(0, 4).map((x) => '<li>' + esc(x) + '</li>').join("") : '<li>No missing inputs declared</li>';
    const evidence = '<div class="br-grid br-grid--three"><article class="br-card"><div class="br-card-label">Statistical validity</div><p class="br-narrative">' + esc((validity.pairedDtCount || 0) + " paired DTs · CI " + ((validity.confidenceInterval || []).join(" to ") || "not measured") + " · p=" + (validity.pValue ?? "not measured")) + '</p>' + chip(validity.overallStatus) + '</article><article class="br-card"><div class="br-card-label">Comparability</div><p class="br-narrative">' + esc((validity.comparability || {}).level || "not measured") + '</p><p class="br-card-detail">' + esc(((validity.comparability || {}).flags || []).map((f) => f.message || f.kind).join(" · ") || "No comparability warning") + '</p></article><article class="br-card"><div class="br-card-label">Data limitations</div><ul class="br-list">' + missingHtml + '</ul></article></div>';
    const gaps = (p.pairedGaps || []).slice(0, 120), maxGap = Math.max(...gaps.map((g) => Math.abs(Number(g.gapMbps) || 0)), 1);
    const gapChart = '<article class="br-card"><div class="br-card-label">Paired IAM gap vs ' + esc((p.finding || {}).comparator || "reference") + '</div><div class="br-gap-list">' + gaps.map((g) => '<div class="br-gap" data-dt="' + esc(g.dtId) + '" tabindex="0"><span>' + esc(g.dtId) + '</span><div class="br-gap-track"><div class="br-gap-bar ' + ((g.gapMbps || 0) >= 0 ? "br-gap-bar--win" : "") + '" style="width:' + Math.max(3, Math.abs(g.gapMbps || 0) / maxGap * 100) + '%"></div></div><strong>' + esc(num(g.gapMbps)) + '</strong></div>').join("") + '</div></article>';
    const tech = '<article class="br-card"><div class="br-card-label">Technology context — declared denominators</div><table class="br-matrix"><thead><tr><th>Operator</th><th>NR active</th><th>n78 share</th><th>CA active</th></tr></thead><tbody>' + (p.technicalContext || []).map((x) => '<tr><td><strong>' + esc(x.operator) + '</strong></td><td>' + esc(num(x.nrActiveShare)) + '%</td><td>' + esc(num(x.n78Share)) + '%</td><td>' + esc(num(x.caActiveShare)) + '%</td></tr>').join("") + '</tbody></table></article>';
    const localization = data.localization || {}, entities = localization.entities || [];
    const loc = '<div class="br-grid br-grid--two"><article class="br-card"><div class="br-card-label">Localization status</div><div class="br-card-value">' + esc(String(localization.state || "NOT_LOCALIZABLE").replaceAll("_", " ")) + '</div><p class="br-card-detail">Loss contribution is descriptive, not causal proof.</p>' + chip(localization.status) + '</article><article class="br-card br-chart"><div class="br-card-label">Top observed loss contributors</div>' + (entities.length ? barRows(entities, "lossContributionPct", "br-bar--loss") : '<div class="br-empty">No bounded loss contributor is available.</div>') + '</article></div>';
    const diagnostic = renderDiagnostic(data.diagnostic || {}, data.charts && data.charts.causalMatrix);
    const action = renderActions(data.actions || [], data.missingEvidence || []);
    const detail = '<div id="brDetailsContent" class="br-empty">Select a DT from the paired-gap chart or the DT filter to open a traceable drill-down.</div>';
    const scopePrefix = data.filters && data.filters.scope === "dt" ? "Selected DT — " : "";
    return hero + controls + nav + section("brOverview", scopePrefix + "Campaign overview", "Management-ready evidence summary", cards) + section("brPerformance", scopePrefix + "Benchmark performance analysis", "Paired performance and technology context", performance + '<div class="br-grid br-grid--two" style="margin-top:12px">' + gapChart + tech + '</div>') + section("brEvidence", scopePrefix + "Evidence Quality and Validity", "Performance confirmation and attribution limits", evidence) + section("brLocalization", scopePrefix + "Loss localization", "Where observed IAM performance loss is concentrated", loc) + section("brDiagnostic", scopePrefix + "Professional diagnostic", "Causal evidence graph — no score overrides gates", diagnostic) + section("brActions", scopePrefix + "Recommended Actions and Validation Plan", "Only evidence-authorized actions are shown", action) + section("brDetails", "DT drill-down", "Trace a selected DT back to the campaign conclusion", detail) + '<p class="br-print-note">Report version ' + esc(meta.reportVersion) + ' · analysis ' + esc(meta.analysisVersion) + ' · generated ' + esc(meta.generatedAt) + '</p>';
  }
  function renderDiagnostic(diagnostic, causes) {
    const primary = diagnostic.primaryCause || {};
    const cards = (causes || []).map((cause, index) => '<div style="margin-top:7px"><button class="br-expand" aria-expanded="false" data-expand="' + index + '"><strong>' + esc(cause.code) + '</strong> · ' + chip(cause.status) + '</button><div><div class="br-grid br-grid--two"><div><strong>Supporting evidence</strong><ul class="br-list">' + (cause.supportingEvidence || []).map((x) => '<li>' + esc(x) + '</li>').join("") + '</ul></div><div><strong>Missing / blocked</strong><ul class="br-list">' + (cause.missingEvidence || []).concat(cause.blockedReasons || []).map((x) => '<li>' + esc(x) + '</li>').join("") + '</ul></div></div><p class="br-card-detail">Scope: ' + esc((cause.scope || {}).cells && (cause.scope || {}).cells.join(", ") || "campaign / unresolved") + '</p></div></div>').join("");
    return '<div class="br-grid br-grid--two"><article class="br-card"><div class="br-card-label">Primary diagnosis</div><div class="br-card-value">' + esc(primary.code || "No root cause published") + '</div>' + chip(primary.status) + '<p class="br-narrative">' + esc(diagnostic.diagnosticConclusion) + '</p></article><article class="br-card"><div class="br-card-label">Diagnostic interpretation</div><p class="br-narrative">Primary cause labels appear only for probable or confirmed causal status. Hypotheses, contradictions and missing evidence remain visible below.</p></article></div><div class="br-card" style="margin-top:12px"><div class="br-card-label">Root-cause evidence cards</div>' + cards + '</div>';
  }
  function timelineSvg(points, color) {
    const values = (points || []).map((point) => Number(point.dl ?? point.value)).filter(Number.isFinite);
    if (!values.length) return '<div class="br-empty">No app-throughput points in this selected transfer window.</div>';
    const max = Math.max(...values, 1), width = 440, height = 86;
    const path = values.map((value, index) => (index ? "L" : "M") + (index / Math.max(1, values.length - 1) * width).toFixed(1) + " " + (height - value / max * (height - 8)).toFixed(1)).join(" ");
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="100" role="img" aria-label="Application throughput timeline"><path d="M0 ' + (height - 1) + ' H' + width + '" stroke="#cbd5e1"/><path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round"/></svg><div class="br-card-detail">' + values.length + ' aligned app-throughput points · peak ' + esc(num(max)) + ' Mbps</div>';
  }
  function renderActions(actions, missing) {
    const actionRows = actions.length ? '<table class="br-matrix"><thead><tr><th>Priority</th><th>Action</th><th>Type</th><th>Owner</th><th>Scope</th></tr></thead><tbody>' + actions.map((a) => '<tr><td>' + esc(a.priority) + '</td><td><strong>' + esc(a.title) + '</strong><br><span class="br-card-detail">' + esc(a.rationale) + '</span></td><td>' + chip(a.type) + '</td><td>' + esc(a.responsibleEntity) + '</td><td>' + esc(((a.scope || {}).cells || []).concat((a.scope || {}).sites || []).join(", ") || "bounded evidence required") + '</td></tr>').join("") + '</tbody></table>' : '<div class="br-empty">No additional RCA action is authorized for this scope.</div>';
    return '<div class="br-grid br-grid--two"><article class="br-card"><div class="br-card-label">Actions</div>' + actionRows + '</article><article class="br-card"><div class="br-card-label">Required Additional Evidence</div><ul class="br-list">' + (missing.length ? missing.map((m) => '<li><strong>' + esc(m.domain) + ':</strong> ' + esc((m.items || []).join(" · ")) + '<br><span class="br-card-detail">Needed to validate/exclude: ' + esc((m.causes || []).join(", ")) + '</span></li>').join("") : '<li>No additional evidence request is currently declared.</li>') + '</ul></article></div>';
  }
  function renderDt(drilldown) {
    const root = $("brDetailsContent"); if (!root) return;
    const dt = drilldown.dt || {}, operators = drilldown.operators || [];
    root.className = "br-dt";
    const timeline = drilldown.timeline || {};
    const colors = {IAM: "#2563eb", Orange: "#f97316", INWI: "#7c3aed"};
    root.innerHTML = '<div class="br-dt-head"><div><div class="br-kicker" style="color:#0369a1">DT drill-down</div><h3 class="br-dt-title">' + esc(dt.label || dt.canonicalDtId) + '</h3><p class="br-card-detail">Canonical DT ID: ' + esc(dt.canonicalDtId) + ' · ' + esc(drilldown.message) + '</p></div><button class="br-button br-no-print" id="brBack">Back to campaign</button></div><div class="br-grid br-grid--three" style="margin-top:12px">' + operators.map((op) => '<article class="br-card"><div class="br-card-label">' + esc(op.operator) + '</div><div class="br-card-value">' + esc(num(op.dlMbps)) + ' Mbps</div><div class="br-card-detail">NR ' + esc(num(op.nrShare)) + '% · n78 ' + esc(num(op.n78Share)) + '%</div></article>').join("") + '</div><div class="br-card" style="margin-top:12px"><div class="br-card-label">CA, modulation and RI evidence</div>' + radioSummaryTable(drilldown.radioSummary || []) + '</div><div class="br-card" style="margin-top:12px"><div class="br-card-label">Transfer / radio evidence</div><table class="br-matrix"><thead><tr><th>Operator</th><th>RSRP</th><th>SINR</th><th>BLER</th><th>UL sessions</th></tr></thead><tbody>' + operators.map((op) => '<tr><td>' + esc(op.operator) + '</td><td>' + esc(num(op.rsrp)) + '</td><td>' + esc(num(op.sinr)) + '</td><td>' + esc(num(op.bler)) + '</td><td>' + esc(op.ulSessions) + '</td></tr>').join("") + '</tbody></table></div><div class="br-grid br-grid--three" style="margin-top:12px">' + operators.map((op) => '<article class="br-card"><div class="br-card-label">' + esc(op.operator) + ' app-throughput timeline</div>' + timelineSvg(timeline[op.operator], colors[op.operator] || "#0f766e") + '</article>').join("") + '</div>';
    $("brBack").onclick = () => { filters.dtId = ""; filters.scope = "all"; load(); };
  }
  async function load() {
    const content = $("benchmarkReportContent"); if (!content) return;
    content.innerHTML = '<div class="br-empty">Building report from the existing benchmark evidence…</div>';
    const qs = new URLSearchParams(filters); if (!filters.dtId) qs.delete("dtId");
    try { report = await api("/api/benchmark-nemo/report?" + qs); content.innerHTML = renderOverview(report); bind(); if (filters.dtId && report.drilldown) { document.querySelector("#brDetails").scrollIntoView({behavior:"smooth"}); renderDt(report.drilldown); } }
    catch (error) { content.innerHTML = '<div class="br-empty"><strong>Report unavailable.</strong><br>' + esc(error.message) + '</div>'; }
  }
  async function exportExcel() {
    const button = $("brExportExcel");
    if (!button) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Export en cours…";
    try {
      const response = await fetch("/api/benchmark-nemo/report/export", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({direction: filters.direction, scope: filters.scope, dtId: filters.dtId, causeStatus: filters.causeStatus})
      });
      if (!response.ok) {
        let message = "Export unavailable";
        try { message = (await response.json()).message || message; } catch (_) {}
        throw new Error(message);
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^";]+)"?/i);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = match ? match[1] : "Benchmark_Analysis_Report.xlsx";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) {
      window.alert("Échec de l’export Excel : " + error.message);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }
  function bind() {
    const direction = $("brDirection"), dt = $("brDt"), cause = $("brCause"), reset = $("brReset"); if (direction) direction.value = filters.direction; if (dt) dt.value = filters.dtId; if (cause) cause.value = filters.causeStatus || "";
    if (direction) direction.onchange = () => { filters.direction = direction.value; load(); };
    if (dt) dt.onchange = () => { filters.dtId = dt.value; filters.scope = dt.value ? "dt" : "all"; load(); };
    if (cause) cause.onchange = () => { filters.causeStatus = cause.value; load(); };
    if (reset) reset.onclick = () => { filters = {direction:"DL", scope:"all", dtId:"", causeStatus:""}; load(); };
    document.querySelectorAll(".br-gap").forEach((row) => row.onclick = () => { filters.dtId = row.dataset.dt; filters.scope = "dt"; load(); });
    document.querySelectorAll(".br-expand").forEach((button) => button.onclick = () => button.setAttribute("aria-expanded", button.getAttribute("aria-expanded") !== "true"));
    $("brClose").onclick = close; $("brPrint").onclick = () => window.print();
    const exportButton = $("brExportExcel"); if (exportButton) exportButton.onclick = exportExcel;
  }
  function open() { $("benchmarkReportWorkspace").classList.add("is-open"); document.body.style.overflow = "hidden"; load(); }
  function close() { $("benchmarkReportWorkspace").classList.remove("is-open"); document.body.style.overflow = ""; }
  document.addEventListener("DOMContentLoaded", () => { const button = $("benchmarkReportBtn"); if (button) button.addEventListener("click", open); });
  window.BenchmarkAnalysisReport = {open, close, load};
})();
