/* Two-sheet Analyse DT COP export, projected from the loaded DT and radio review. */
(function radioDtCopExportFactory(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadioDtCopExport = api;
})(typeof window !== "undefined" ? window : globalThis, function makeRadioDtCopExport(root) {
  "use strict";

  const STAT_HEADERS = [
    "Année", "Semaine", "Date", "Parcours", "Type_parcours",
    "DATA Couverture", "DATA Qualité", "DATA HO", "DATA D_1", "DATA D_2",
    "DATA D_5", "DATA D_10", "DATA D_Max", "DATA D_Moy", "DATA Cellules", "DATA HO_3G",
    "VoLTE Coupures", "VoLTE Echecs", "VoLTE Couverture", "VoLTE Qualité",
    "VoLTE HO", "VoLTE MOS", "VoLTE Cellules", "VoLTE HO_3G",
    "VOIX Auto Coupures", "VOIX Auto Echecs", "VOIX Auto Couverture", "VOIX Auto Qualité",
    "VOIX Auto HO", "VOIX Auto MOS", "VOIX Auto Cellules", "VOIX Auto HO_2G",
    "Durée", "Km", "Heure_D", "Heure_F",
  ];
  const ANALYSIS_HEADERS = [
    "Année", "Semaine", "Date_parcours", "Parcours", "Type_Test", "Problème",
    "Occurence", "Analyse Optim", "LAC", "CID", "Nom_Cellule", "Niveau", "Qualité",
    "Action", "Type_Action", "Etat_Action", "Responsabilité", "X", "Y",
    "CGPS_Debut_X", "CGPS_Debut_Y", "CGPS_Fin_X", "CGPS_Fin_Y", "Trace_CGPS", "LogFile",
    "Symptôme", "Sévérité", "MOS_P50", "Impact_MOS", "Cause_probable", "Preuves",
  ];

  const finite = (value) => value !== null && value !== undefined && value !== "" &&
    Number.isFinite(Number(String(value).replace(",", ".")))
    ? Number(String(value).replace(",", ".")) : null;
  const round = (value, digits = 1) => Number(value.toFixed(digits));
  const percent = (part, total) => total ? round(100 * part / total, 2) : null;
  const datePart = (value) => {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
    const serial = finite(value);
    if (serial !== null && serial >= 20000 && serial <= 90000) {
      return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000)).toISOString().slice(0, 10);
    }
    if (serial !== null && serial >= Date.UTC(2000, 0, 1) && serial < Date.UTC(2100, 0, 1)) {
      return new Date(serial).toISOString().slice(0, 10);
    }
    const match = String(value ?? "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?=\D|$)/);
    if (!match) return "";
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  const timePart = (value) => String(value ?? "").match(/\b(\d{2}:\d{2})/)?.[1] || "";
  const isoWeek = (dateText) => {
    if (!datePart(dateText)) return null;
    const day = new Date(`${dateText}T00:00:00Z`);
    if (Number.isNaN(day.getTime())) return null;
    day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
    return Math.ceil((((day - yearStart) / 86400000) + 1) / 7);
  };
  const importedDate = (log, analysis, stream) => {
    const candidates = [stream[0]?.time, stream[0]?.timeMs, analysis.incidents?.[0]?.startTime];
    for (const candidate of candidates) {
      const date = datePart(candidate);
      if (date) return date;
    }
    for (const point of log?.points || []) {
      const date = datePart(point?.time) || datePart(point?.properties?.Time) ||
        datePart(point?.__sourceTime) || datePart(point?.properties?.__sourceTime);
      if (date) return date;
    }
    return "";
  };
  const measuredPercent = (snapshots, field, thresholdFor) => {
    const measurements = snapshots.map((item) => ({ value: finite(item?.[field]), threshold: thresholdFor(item) }))
      .filter((item) => item.value !== null);
    return percent(measurements.filter((item) => item.value > item.threshold).length, measurements.length);
  };
  const dlSamplesMbps = (points) => {
    // Nemo App. rate DL is in bit/s. No MAC/anchor throughput is substituted.
    return (points || []).map((point) => finite(point?.["App. rate DL"] ?? point?.properties?.["App. rate DL"]))
      .filter((value) => value !== null && value > 0).map((value) => value / 1_000_000);
  };
  const distanceKm = (snapshots, analyzer) => {
    if (typeof analyzer?.haversineM !== "function") return null;
    let distanceM = 0;
    let pairs = 0;
    for (let i = 1; i < snapshots.length; i += 1) {
      const previous = snapshots[i - 1];
      const current = snapshots[i];
      const gap = (finite(current?.timeMs) ?? 0) - (finite(previous?.timeMs) ?? 0);
      if (gap < 0 || gap > 30000) continue;
      const step = analyzer.haversineM(previous, current);
      if (Number.isFinite(step) && step <= 250) { distanceM += step; pairs += 1; }
    }
    return pairs ? round(distanceM / 1000, 2) : (snapshots.length === 1 ? 0 : null);
  };
  const safeCell = (value) => typeof value === "string" && /^[=+@]/.test(value) ? `'${value}` : value;

  const buildCopDescription = (professional = {}) => {
    const short = String(professional.shortDiagnostic || "").trim();
    if (short) return short;
    const description = String(professional.description || "").replace(/\bsnapshots\b/g, "points").trim();
    const measuredFacts = String(professional.dtAnalysis || "")
      .replace(/La dégradation est présente sur \d+(?:[.,]\d+)? % des snapshots canoniques\.\s*/g, "")
      .replace(/\bsnapshots\b/g, "points")
      .trim();
    const cause = professional.probableCause ? `Cause probable : ${professional.probableCause}` : "";
    const quality = finite(professional.dataQualityScore) === null ? "" :
      `Qualité des données : ${professional.dataQualityScore}/100 ; mesures serving ${professional.dataQuality?.servingMeasurementCoveragePct ?? "N/D"} %, ` +
      `voisines ${professional.dataQuality?.neighborMeasurementCoveragePct ?? "N/D"} %, ` +
      `${professional.dataQuality?.comparableNeighborSamples ?? 0} comparaisons appariées.`;
    const limitations = (Array.isArray(professional.limitation) ? professional.limitation : [professional.limitation])
      .filter(Boolean).join("\n");
    const body = [description, measuredFacts, cause, quality].filter(Boolean).join("\n");
    return limitations ? `${body}\n\n${limitations}`.trim() : body;
  };

  const normalizedCellName = (value) => String(value ?? "").toUpperCase().replace(/[\s_-]+/g, "");
  const servingBddIds = (incident, analyzer) => {
    const dominant = incident?.dominantServing || incident?.representative;
    if (!dominant) return null;
    const candidates = [dominant, incident?.representative, ...(incident?.sequence || [])]
      .filter((snapshot) => snapshot && (!dominant.cellKey || snapshot.cellKey === dominant.cellKey));
    for (const snapshot of candidates) {
      const inventory = snapshot.inventory;
      if (!inventory || inventory.ratMatches !== true || inventory.pciMatches !== true ||
        inventory.channelMatches !== true) continue;
      const sourceName = snapshot.reportedCellName || snapshot.cellName;
      const hasExplicitName = !!sourceName && !/^(?:LTE|NR)\s+PCI\s+/i.test(String(sourceName));
      const sourceNameMatched = hasExplicitName && !!inventory.cellName &&
        normalizedCellName(sourceName) === normalizedCellName(inventory.cellName);
      const validCoordinates = [snapshot.lat, snapshot.lng, inventory.lat, inventory.lng]
        .every((value) => finite(value) !== null);
      const nearby = validCoordinates && typeof analyzer?.haversineM === "function" &&
        analyzer.haversineM(snapshot, inventory) <= 5000;
      if ((hasExplicitName && !sourceNameMatched) || (!hasExplicitName && !nearby)) continue;
      const lac = finite(inventory.lac);
      const tac = finite(inventory.tac);
      const cid = finite(inventory.cid);
      if (lac !== null || tac !== null || cid !== null) {
        return { locationArea: lac !== null ? lac : (tac !== null ? `TAC ${tac}` : null), cid };
      }
    }
    return null;
  };

  const gpsPosition = (value) => {
    const lat = finite(value?.lat);
    const lng = finite(value?.lng);
    return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && lat !== 0 && lng !== 0
      ? { lat, lng } : null;
  };
  const incidentGps = (incident) => {
    const measured = (incident.sequence || []).map(gpsPosition).filter(Boolean);
    const start = gpsPosition(incident.start) || measured[0] || gpsPosition(incident.representative);
    const end = gpsPosition(incident.end) || measured[measured.length - 1] || start;
    const path = [start, ...measured, end].filter(Boolean).filter((point, index, all) =>
      index === 0 || point.lat !== all[index - 1].lat || point.lng !== all[index - 1].lng);
    const limit = 256;
    const sampled = path.length > limit
      ? Array.from({ length: limit }, (_, index) => path[Math.round(index * (path.length - 1) / (limit - 1))])
      : path;
    return { start, end, trace: sampled.length > 1
      ? JSON.stringify(sampled.map((point) => [round(point.lng, 6), round(point.lat, 6)])) : null };
  };

  const buildPayload = (log, meta = {}, analyzer = root.RadioDegradationAnalyzer) => {
    const analysis = log?.radioDegradationAnalysis;
    if (!analysis) throw new Error("Analyse radio indisponible pour ce DT.");
    if (typeof root.RadioProfessionalReport?.apply === "function") root.RadioProfessionalReport.apply(analysis, meta);
    const stream = (analysis.servingStream || []).slice().sort((a, b) => (finite(a.timeMs) ?? 0) - (finite(b.timeMs) ?? 0));
    const first = stream[0] || {};
    const last = stream[stream.length - 1] || {};
    const dtDate = importedDate(log, analysis, stream);
    const year = dtDate ? Number(dtDate.slice(0, 4)) : null;
    const week = isoWeek(dtDate);
    const parcours = String(meta.plaque || log?.name || "").trim();
    const logName = String(meta.logfile || log?.name || "").trim();
    const dl = dlSamplesMbps(log?.points);
    const profileFor = (item) => item?.rat === "NR" ? analysis.profiles?.nr : analysis.profiles?.lte;
    const durationMs = finite(last.timeMs) !== null && finite(first.timeMs) !== null && last.timeMs >= first.timeMs
      ? last.timeMs - first.timeMs : null;
    const stat = Object.fromEntries(STAT_HEADERS.map((header) => [header, null]));
    Object.assign(stat, {
      "Année": year, "Semaine": week, "Date": dtDate || null,
      "Parcours": parcours, "Type_parcours": meta.testType || "Drive Test 4G/5G",
      "DATA Couverture": measuredPercent(stream, "rsrp", (item) => finite(profileFor(item)?.coverageEntryDbm) ?? -105),
      "DATA Qualité": measuredPercent(stream, "sinr", (item) => finite(profileFor(item)?.sinrEntryDb) ?? 0),
      "DATA D_1": percent(dl.filter((value) => value >= 1).length, dl.length),
      "DATA D_2": percent(dl.filter((value) => value >= 2).length, dl.length),
      "DATA D_5": percent(dl.filter((value) => value >= 5).length, dl.length),
      "DATA D_10": percent(dl.filter((value) => value >= 10).length, dl.length),
      "DATA D_Max": dl.length ? round(dl.reduce((max, value) => Math.max(max, value), 0), 2) : null,
      "DATA D_Moy": dl.length ? round(dl.reduce((sum, value) => sum + value, 0) / dl.length, 2) : null,
      "DATA Cellules": stream.length ? new Set(stream.map((item) => item.cellKey || `${item.rat}|${item.pci}|${item.channel}`)).size : null,
      "Durée": durationMs === null ? null : round(durationMs / 60000, 2),
      "Km": distanceKm(stream, analyzer), "Heure_D": timePart(first.time) || null,
      "Heure_F": timePart(last.time) || null,
    });
    const analysisRows = (analysis.incidents || []).filter((item) => item.reviewState !== "rejected")
      .map((item) => {
        const professional = item.professional || {};
        const serving = item.dominantServing || item.representative || {};
        const bddIds = servingBddIds(item, analyzer);
        const gps = incidentGps(item);
        const incidentDate = datePart(item.startTime) || datePart(item.sequence?.[0]?.time) || dtDate;
        // A manual edit always wins verbatim (no auto-appended overlap action).
        const manualExec = String(item.optimExecOverride || "").trim();
        const optimExec = String(item.optimAnalysis?.executiveSummary || "").trim();
        const optimOverlap = !manualExec && item.optimAnalysis?.overlap?.applies && String(item.optimAnalysis.overlap.action || "").trim()
          ? `\n${item.optimAnalysis.overlap.action.trim()}` : "";
        const optimSummary = (manualExec || (optimExec + optimOverlap).trim()) ||
          String(professional.shortDiagnostic || "").replace(/\n/g, " ").trim() ||
          "Analyse Optim non calculée.";
        return {
          "Année": incidentDate ? Number(incidentDate.slice(0, 4)) : null,
          "Semaine": isoWeek(incidentDate), "Date_parcours": incidentDate || null,
          "Parcours": parcours, "Type_Test": meta.testType || "Radio 4G/5G",
          "Problème": `${item.rat === "NR" ? "5G NR" : item.rat === "MOS" ? "MOS QoE" : item.rat === "DATA" ? "Data DL" : "4G LTE"} ${professional.band || item.band || ""} — ${professional.issueFrenchLabel || item.type || "Dégradation radio"}`.trim(),
          "Occurence": 1, "Analyse Optim": optimSummary,
          "LAC": bddIds?.locationArea ?? null, "CID": bddIds?.cid ?? null,
          "Nom_Cellule": professional.servingCell || serving.cellName || null,
          "Niveau": finite(item.metrics?.rsrp?.median), "Qualité": finite(item.metrics?.sinr?.median),
          "Action": professional.recommendedAction || item.primaryRca?.recommendation || null,
          "Type_Action": "Vérification radio", "Etat_Action": null, "Responsabilité": null,
          "X": gps.start?.lng ?? null, "Y": gps.start?.lat ?? null,
          "CGPS_Debut_X": gps.start?.lng ?? null, "CGPS_Debut_Y": gps.start?.lat ?? null,
          "CGPS_Fin_X": gps.end?.lng ?? null, "CGPS_Fin_Y": gps.end?.lat ?? null,
          "Trace_CGPS": gps.trace, "LogFile": logName,
          "Symptôme": professional.symptom || item.analysis?.symptom?.name || null,
          "Sévérité": professional.severity || null,
          "MOS_P50": finite(item.mos?.median), "Impact_MOS": professional.mosImpact || null,
          "Cause_probable": item.analysis?.cause?.name || professional.probableCause || null,
          "Preuves": (item.analysis?.observedEvidence || []).join(" ; ") || null,
        };
      });
    return {
      filename: `Analyse_DT_COP_${logName.replace(/[\\/:*?"<>|]+/g, "_") || "DT"}.xlsx`,
      statistiquesHeaders: STAT_HEADERS,
      statistiquesRows: [stat],
      analyseHeaders: ANALYSIS_HEADERS,
      analyseRows: analysisRows,
    };
  };

  const buildFallbackWorkbook = (xlsx, payload) => {
    const workbook = xlsx.utils.book_new();
    const makeSheet = (headers, rows) => {
      const grid = [headers, ...rows.map((row) => headers.map((header) => safeCell(row[header]) ?? null))];
      const sheet = xlsx.utils.aoa_to_sheet(grid, { cellDates: true });
      sheet["!cols"] = headers.map((header) => ({ wch: /Analyse Optim|Action|LogFile/.test(header) ? 65 : /Parcours|Nom_Cellule/.test(header) ? 38 : 16 }));
      sheet["!autofilter"] = { ref: sheet["!ref"] };
      return sheet;
    };
    xlsx.utils.book_append_sheet(workbook, makeSheet(payload.statistiquesHeaders, payload.statistiquesRows), "Statistiques");
    xlsx.utils.book_append_sheet(workbook, makeSheet(payload.analyseHeaders, payload.analyseRows), "Analyse");
    return workbook;
  };

  /* Professional styled export (SpreadsheetML .xls): SheetJS community cannot
   * write cell styles, and the styled server endpoint is unreachable in static
   * builds — so the lite download renders styled XML directly, no dependency. */
  const xmlEscape = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  const xmlCellValue = (value) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" && Number.isFinite(value)) return { type: "Number", text: String(value) };
    return { type: "String", text: String(value) };
  };
  const buildStyledSpreadsheetXML = (payload) => {
    const border = '<Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#B4C6E7"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#B4C6E7"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#B4C6E7"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#B4C6E7"/></Borders>';
    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
      '<Styles>',
      `<Style ss:ID="hdr"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#FFFFFF" ss:Bold="1"/><Interior ss:Color="#C00000" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>${border}</Style>`,
      `<Style ss:ID="cell"><Font ss:FontName="Calibri" ss:Size="11"/><Alignment ss:Vertical="Top" ss:WrapText="1"/>${border}</Style>`,
      `<Style ss:ID="alt"><Font ss:FontName="Calibri" ss:Size="11"/><Interior ss:Color="#FBE9E9" ss:Pattern="Solid"/><Alignment ss:Vertical="Top" ss:WrapText="1"/>${border}</Style>`,
      '</Styles>',
    ];
    const sheets = [
      { name: "Statistiques", headers: payload.statistiquesHeaders, rows: payload.statistiquesRows },
      { name: "Analyse", headers: payload.analyseHeaders, rows: payload.analyseRows },
    ];
    for (const sheet of sheets) {
      const nCols = sheet.headers.length;
      const nRows = sheet.rows.length + 1;
      const widths = sheet.headers.map((header) => {
        let mx = String(header).length;
        for (const row of sheet.rows) {
          const v = row[header];
          const len = v === null || v === undefined ? 0 : String(v).length;
          if (len > mx) mx = Math.min(len, /Analyse Optim|Action|Preuves/.test(header) ? 200 : 60);
        }
        return Math.max(12, Math.min(/Analyse Optim/.test(header) ? 80 : 42, mx));
      });
      parts.push(`<Worksheet ss:Name="${xmlEscape(sheet.name)}"><Table>`);
      widths.forEach((wch) => parts.push(`<Column ss:Width="${Math.round(wch * 6.5)}"/>`));
      parts.push('<Row ss:Height="30">');
      sheet.headers.forEach((header) => parts.push(`<Cell ss:StyleID="hdr"><Data ss:Type="String">${xmlEscape(header)}</Data></Cell>`));
      parts.push('</Row>');
      sheet.rows.forEach((row, ri) => {
        const style = ri % 2 === 0 ? "cell" : "alt";
        parts.push('<Row ss:AutoFitHeight="1">');
        sheet.headers.forEach((header) => {
          const cv = xmlCellValue(safeCell(row[header]));
          if (!cv) parts.push(`<Cell ss:StyleID="${style}"/>`);
          else parts.push(`<Cell ss:StyleID="${style}"><Data ss:Type="${cv.type}">${xmlEscape(cv.text)}</Data></Cell>`);
        });
        parts.push('</Row>');
      });
      parts.push('</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions>');
      parts.push(`<AutoFilter xmlns="urn:schemas-microsoft-com:office:excel" x:Range="R1C1:R${nRows}C${nCols}"/>`);
      parts.push('</Worksheet>');
    }
    parts.push('</Workbook>');
    return parts.join("");
  };

  const saveBlobFile = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    root.setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const download = async (log, meta) => {
    if (root.prepareRadioOptimAnalysis) await root.prepareRadioOptimAnalysis(log);
    else if (root.RadioOptimAnalysis) await root.RadioOptimAnalysis.prepare(log);
    const payload = buildPayload(log, meta);
    const xlsFilename = payload.filename.replace(/\.xlsx$/i, ".xls");
    try {
      const xml = buildStyledSpreadsheetXML(payload);
      saveBlobFile(new Blob(["\uFEFF" + xml], { type: "application/vnd.ms-excel;charset=utf-8" }), xlsFilename);
    } catch (error) {
      if (!root.XLSX) throw error;
      root.XLSX.writeFile(buildFallbackWorkbook(root.XLSX, payload), payload.filename);
      console.warn("Analyse DT COP: export stylé indisponible, export compatible utilisé.", error);
    }
    return payload;
  };

  return { STAT_HEADERS, ANALYSIS_HEADERS, datePart, isoWeek, importedDate, buildCopDescription, servingBddIds, buildPayload, buildFallbackWorkbook, buildStyledSpreadsheetXML, download };
});
