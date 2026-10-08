/* Two-sheet Analyse DT COP export, projected from the loaded DT and radio review. */
(function radioDtCopExportFactory(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadioDtCopExport = api;
})(typeof window !== "undefined" ? window : globalThis, function makeRadioDtCopExport(root) {
  "use strict";

  const STAT_HEADERS = [
    "Année", "Semaine", "Date", "Parcours", "Type_parcours",
    "Nbr coupure", "Nbr echecs", "Nbr de dégradation",
    "% bonne couverture (RSRP>-115 dBm)", "% bonne qualité (SINR>0 dB)", "% bon MOS (MOS>2.2)",
    "Nbr Cellules serveuse",
    "%5G", "%4G", "%TDD",
    "%nr700", "%nr2100", "%L1800", "%L2100", "%L2600", "%L800",
    "Durée", "Km", "Heure_D", "Heure_F",
  ];
  const ANALYSIS_HEADERS = [
    "ID", "Année", "Semaine", "Date_parcours", "Parcours", "Type_Test", "Problème",
    "Occurence", "LAC", "CID", "Nom_Cellule", "Niveau", "Qualité",
    "Analyse Optim", "Type_Action", "Etat_Action", "Responsabilité", "X", "Y",
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
    // Presence shares over ALL serving snapshots (EN-DC/TDD overlaps allowed).
    // Missing measurements are skipped; out-of-scope RATs count as absent.
    const nStream = stream.length;
    const share = (test) => {
      if (!nStream) return null;
      let hit = 0, total = 0;
      for (const item of stream) {
        const value = test(item);
        if (value === null || value === undefined) continue;
        total++;
        if (value) hit++;
      }
      return total ? Math.round((hit / total) * 10000) / 100 : null;
    };
    const shareAll = (test) => {
      if (!nStream) return null;
      let hit = 0;
      for (const item of stream) {
        if (test(item)) hit++;
      }
      return Math.round((hit / nStream) * 10000) / 100;
    };
    const lteBandOf = (channel) => {
      if (channel === null || channel === undefined) return null;
      const v = Number(channel);
      if (!Number.isFinite(v)) return null;
      if (v >= 1200 && v <= 1949) return "L1800";
      if (v >= 300 && v <= 699) return "L2100";
      if ((v >= 2400 && v <= 2700) || (v >= 2750 && v <= 3449) || (v >= 3400 && v <= 3799)) return "L2600";
      if (v >= 6150 && v <= 6449) return "L800";
      return null;
    };
    const nrBandOf = (channel) => {
      if (channel === null || channel === undefined) return null;
      const v = Number(channel);
      if (!Number.isFinite(v)) return null;
      if (v >= 151600 && v <= 160600) return "nr700";
      if (v >= 422000 && v <= 440000) return "nr2100";
      return null;
    };
    const isTdd = (item) => {
      if (/tdd/i.test(String(item.band || ""))) return true;
      if (String(item.rat || "").toUpperCase() === "NR") {
        const v = Number(item.channel);
        return Number.isFinite(v) && ((v >= 499200 && v <= 537999) || (v >= 620000 && v <= 680000) ||
          (v >= 37750 && v <= 38249) || (v >= 38650 && v <= 39649) || (v >= 39650 && v <= 41589));
      }
      const v = Number(item.channel);
      return Number.isFinite(v) && ((v >= 37750 && v <= 38249) || (v >= 38650 && v <= 39649) || (v >= 39650 && v <= 41589));
    };
    const mosSnaps = Array.isArray(analysis.mosSnapshots) ? analysis.mosSnapshots : [];
    const mosValues = mosSnaps.map((item) => finite(item?.mos)).filter((value) => value !== null);
    const voiceSummary = log?.voiceAnalysis?.summary || {};
    Object.assign(stat, {
      "Année": year, "Semaine": week, "Date": dtDate || null,
      "Parcours": parcours, "Type_parcours": meta.testType || "Drive Test 4G/5G",
      "Nbr coupure": finite(voiceSummary.drops) ?? 0,
      "Nbr echecs": finite(voiceSummary.failures) ?? 0,
      "Nbr de dégradation": (analysis.incidents || []).filter((item) => item?.reviewState === "validated").length,
      "% bonne couverture (RSRP>-115 dBm)": share((item) => { const v = finite(item?.rsrp); return v === null ? null : v > -115; }),
      "% bonne qualité (SINR>0 dB)": share((item) => { const v = finite(item?.sinr); return v === null ? null : v > 0; }),
      "% bon MOS (MOS>2.2)": mosValues.length ? Math.round((mosValues.filter((value) => value > 2.2).length / mosValues.length) * 10000) / 100 : null,
      "Nbr Cellules serveuse": nStream ? new Set(stream.map((item) => item.cellKey || `${item.rat}|${item.pci}|${item.channel}`)).size : null,
      "%5G": shareAll((item) => String(item?.rat || "").toUpperCase() === "NR"),
      "%4G": shareAll((item) => { const r = String(item?.rat || "").toUpperCase(); return !!r && r !== "NR"; }),
      "%TDD": shareAll((item) => isTdd(item)),
      "%nr700": shareAll((item) => String(item?.rat || "").toUpperCase() === "NR" && nrBandOf(item?.channel) === "nr700"),
      "%nr2100": shareAll((item) => String(item?.rat || "").toUpperCase() === "NR" && nrBandOf(item?.channel) === "nr2100"),
      "%L1800": shareAll((item) => String(item?.rat || "").toUpperCase() !== "NR" && !!String(item?.rat || "") && lteBandOf(item?.channel) === "L1800"),
      "%L2100": shareAll((item) => String(item?.rat || "").toUpperCase() !== "NR" && !!String(item?.rat || "") && lteBandOf(item?.channel) === "L2100"),
      "%L2600": shareAll((item) => String(item?.rat || "").toUpperCase() !== "NR" && !!String(item?.rat || "") && lteBandOf(item?.channel) === "L2600"),
      "%L800": shareAll((item) => String(item?.rat || "").toUpperCase() !== "NR" && !!String(item?.rat || "") && lteBandOf(item?.channel) === "L800"),
      "Durée": durationMs === null ? null : round(durationMs / 60000, 2),
      "Km": distanceKm(stream, analyzer), "Heure_D": timePart(first.time) || null,
      "Heure_F": timePart(last.time) || null,
    });
    const eligibleIncidents = (analysis.incidents || []).filter((item) => item.reviewState !== "rejected");
    const incidentShortId = (item) => "D" + String((analysis.incidents || []).indexOf(item) + 1).padStart(3, "0");
    const analysisRows = eligibleIncidents
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
          "ID": incidentShortId(item),
          "Année": incidentDate ? Number(incidentDate.slice(0, 4)) : null,
          "Semaine": isoWeek(incidentDate), "Date_parcours": incidentDate || null,
          "Parcours": parcours, "Type_Test": meta.testType || "Radio 4G/5G",
          "Problème": `${item.rat === "NR" ? "5G NR" : item.rat === "MOS" ? "MOS QoE" : item.rat === "DATA" ? "Data DL" : "4G LTE"} ${professional.band || item.band || ""} — ${professional.issueFrenchLabel || item.type || "Dégradation radio"}`.trim(),
          "Occurence": 1, "Analyse Optim": optimSummary,
          "LAC": bddIds?.locationArea ?? null, "CID": bddIds?.cid ?? null,
          "Nom_Cellule": professional.servingCell || serving.cellName || null,
          "Niveau": finite(item.metrics?.rsrp?.median), "Qualité": finite(item.metrics?.sinr?.median),
          "Type_Action": "Vérification radio", "Etat_Action": null, "Responsabilité": null,
          "X": gps.start?.lng ?? null, "Y": gps.start?.lat ?? null,
        };
      });
    return {
      filename: `Analyse_DT_COP_${logName.replace(/[\\/:*?"<>|]+/g, "_") || "DT"}.xlsx`,
      statistiquesHeaders: STAT_HEADERS,
      statistiquesRows: [stat],
      analyseHeaders: ANALYSIS_HEADERS,
      analyseRows: analysisRows,
      validerHeaders: ANALYSIS_HEADERS,
      validerRows: analysisRows.filter((_, idx) => eligibleIncidents[idx] && eligibleIncidents[idx].reviewState === "validated"),
    };
  };

  const buildFallbackWorkbook = (xlsx, payload) => {
    const workbook = xlsx.utils.book_new();
    const makeSheet = (headers, rows, hidden) => {
      const grid = [headers, ...rows.map((row) => headers.map((header) => safeCell(row[header]) ?? null))];
      const sheet = xlsx.utils.aoa_to_sheet(grid, { cellDates: true });
      sheet["!cols"] = headers.map((header, ci) => ({ wch: /Analyse Optim|Action|LogFile/.test(header) ? 65 : /Parcours|Nom_Cellule/.test(header) ? 38 : 16, hidden: (hidden || []).includes(ci) || undefined }));
      sheet["!autofilter"] = { ref: sheet["!ref"] };
      return sheet;
    };
    const hiddenAnalyse = [];
    xlsx.utils.book_append_sheet(workbook, makeSheet(payload.statistiquesHeaders, payload.statistiquesRows, []), "Statistiques");
    xlsx.utils.book_append_sheet(workbook, makeSheet(payload.analyseHeaders, payload.analyseRows, hiddenAnalyse), "Analyse");
    xlsx.utils.book_append_sheet(workbook, makeSheet(payload.validerHeaders || payload.analyseHeaders, payload.validerRows || [], hiddenAnalyse), "Valider");
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
      { name: "Statistiques", headers: payload.statistiquesHeaders, rows: payload.statistiquesRows, hidden: [] },
      { name: "Analyse", headers: payload.analyseHeaders, rows: payload.analyseRows, hidden: [] },
      { name: "Valider", headers: payload.validerHeaders || payload.analyseHeaders, rows: payload.validerRows || [], hidden: [] },
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
      widths.forEach((wch, ci) => {
        const hidden = (sheet.hidden || []).includes(ci) ? ' ss:Hidden="1"' : "";
        parts.push(`<Column ss:Width="${Math.round(wch * 6.5)}"${hidden}/>`);
      });
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
