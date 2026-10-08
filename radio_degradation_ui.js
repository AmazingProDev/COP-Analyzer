/* LTE / NR radio-degradation review window and map overlay. */
(function radioDegradationUiFactory(root) {
  "use strict";

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const number = (value, digits = 1) => value !== null && value !== undefined && value !== "" &&
    Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
  const unique = (values) => [...new Set((values || []).filter((value) => value !== null && value !== undefined && String(value).trim() !== ""))];
  const getLog = (logId) => (root.loadedLogs || []).find((log) => String(log?.id) === String(logId));
  const typeLabel = (type) => ({
    COVERAGE_DEGRADATION: "Couverture",
    SINR_DEGRADATION: "SINR",
    COMBINED_RADIO_DEGRADATION: "Couverture + SINR",
    MIXED_RADIO_DEGRADATION: "Mixte couverture / SINR",
    NR_AVAILABILITY_LOSS: "Perte de disponibilité NR",
    MOS_DEGRADATION: "Dégradation MOS",
    THROUGHPUT_DEGRADATION: "Débit DL dégradé",
    MOBILITY_ANOMALY: "Instabilité serving",
  }[type] || "Dégradation radio");
  const typeColor = (incident) => {
    if (incident?.stationary) return "#64748b";
    if (incident?.type === "MOS_DEGRADATION") return incident.analysis?.category?.startsWith("MOS_RADIO") ||
      incident.analysis?.category === "MOS_MOBILITY" || incident.analysis?.category === "MOS_NR_CONTINUITY" ? "#ec4899" : "#14b8a6";
    if (incident?.type === "THROUGHPUT_DEGRADATION") return "#f59e0b";
    if (incident?.type === "MOBILITY_ANOMALY") return "#38bdf8";
    if (incident?.type === "COVERAGE_DEGRADATION") return incident.rat === "NR" ? "#8b5cf6" : "#f97316";
    if (incident?.type === "SINR_DEGRADATION") return incident.rat === "NR" ? "#0ea5e9" : "#eab308";
    if (incident?.type === "COMBINED_RADIO_DEGRADATION") return incident.rat === "NR" ? "#d946ef" : "#ef4444";
    if (incident?.type === "NR_AVAILABILITY_LOSS") return "#f43f5e";
    return incident?.rat === "NR" ? "#7c3aed" : "#f59e0b";
  };
  const analysisRows = (log) => Array.isArray(log?.radioDegradationAnalysis?.incidents)
    ? log.radioDegradationAnalysis.incidents : [];
  // Selected row highlight (validated rows always stay highlighted).
  let selectedRadioRowId = null;
  const paintRadioRowState = (tr, incident) => {
    const isSel = tr.dataset.radioId === selectedRadioRowId;
    const isVal = incident && incident.reviewState === "validated";
    tr.style.background = isSel ? "rgba(59,130,246,0.22)" : (isVal ? "rgba(21,128,61,0.20)" : "");
    tr.style.boxShadow = isSel ? "inset 3px 0 0 #3b82f6" : (isVal ? "inset 3px 0 0 #22c55e" : "");
  };
  const contextsFor = (item) => Array.isArray(item?.contextRca)
    ? item.contextRca : (item?.secondaryRca ? [item.secondaryRca] : []);
  const applyProfessionalReport = (log, meta = null) => {
    const analysis = log?.radioDegradationAnalysis;
    if (!analysis || typeof root.RadioProfessionalReport?.apply !== "function") return analysis;
    return root.RadioProfessionalReport.apply(analysis, meta || analysis.exportMeta || { logfile: log?.name || "" });
  };
  const professionalFor = (item) => item?.professional || null;
  const prepareOptim = (log) => {
    if (!root.RadioOptimAnalysis) return Promise.resolve(log?.radioDegradationAnalysis);
    const layers = root.mapRenderer?.siteLayers;
    const sectors = layers?.values ? Array.from(layers.values()).flatMap((layer) => layer.sectors || []) : root.mapRenderer?.siteData || [];
    // Static builds have no Python backend: serve /api/bdd/match from the
    // local BDD matcher (BddMatcher) over the loaded map sectors.
    const localFetch = root.BddMatcher && typeof root.BddMatcher.createLocalBddFetch === "function"
      ? root.BddMatcher.createLocalBddFetch(root.fetch ? root.fetch.bind(root) : undefined)
      : undefined;
    return root.RadioOptimAnalysis.prepare(log, { sectors,
      ...(localFetch ? { fetch: localFetch } : {}),
      resolveCell: (snapshot) => {
        const nr = snapshot.rat === "NR";
        const cell = { rat: nr ? "NR" : "E-UTRA", pci: snapshot.pci, sc: snapshot.pci,
          freq: snapshot.channel, ...(nr ? { nrarfcn: snapshot.channel } : { earfcn: snapshot.channel }) };
        const resolved = root.mapRenderer?.getServingCell?.({ lat: snapshot.lat, lng: snapshot.lng,
          parsed: { serving: cell, [nr ? "serving_nr" : "serving_lte"]: cell } });
        const technology = String(resolved?.tech || resolved?.rat || "").toUpperCase();
        if (!resolved || (nr ? !/NR|5G/.test(technology) : !/LTE|4G|E-UTRA/.test(technology)) ||
          Number(resolved.pci ?? resolved.sc) !== Number(snapshot.pci) ||
          Number(resolved.currentFreq ?? resolved.freq ?? resolved.nrarfcn ?? resolved.earfcn) !== Number(snapshot.channel)) return null;
        return resolved;
      },
    });
  };
  root.prepareRadioOptimAnalysis = prepareOptim;

  // Resolve only fallback identities ("NR PCI …" / "LTE PCI …") and delegate
  // the actual matching to MapRenderer's RAT-safe PCI/frequency/proximity
  // resolver. This keeps a missing NR name from ever falling back to a 3G or
  // LTE BDD sector that happens to share a PCI or site label.
  const enrichServingNamesFromBdd = (analysis) => {
    if (!analysis || typeof root.RadioDegradationAnalyzer?.enrichServingNames !== "function" ||
      typeof root.mapRenderer?.getServingCell !== "function") return analysis;
    return root.RadioDegradationAnalyzer.enrichServingNames(analysis, (snapshot) => {
      const isNr = snapshot?.rat === "NR";
      const serving = {
        rat: isNr ? "NR" : "E-UTRA",
        pci: snapshot?.pci,
        sc: snapshot?.pci,
        freq: snapshot?.channel,
        ...(isNr ? { nrarfcn: snapshot?.channel } : { earfcn: snapshot?.channel }),
      };
      const probe = {
        lat: snapshot?.lat,
        lng: snapshot?.lng,
        rat: serving.rat,
        tech: isNr ? "5G NR" : "4G LTE",
        pci: snapshot?.pci,
        sc: snapshot?.pci,
        freq: snapshot?.channel,
        ...(isNr ? { nrarfcn: snapshot?.channel } : { earfcn: snapshot?.channel }),
        parsed: {
          serving,
          ...(isNr ? { serving_nr: serving } : { serving_lte: serving }),
        },
      };
      const resolved = root.mapRenderer.getServingCell(probe);
      return resolved || null;
    });
  };

  const refreshCampaignRecurrence = () => {
    if (typeof root.RadioDegradationAnalyzer?.applyCampaignRecurrence !== "function") return;
    root.RadioDegradationAnalyzer.applyCampaignRecurrence((root.loadedLogs || [])
      .filter((log) => log?.radioDegradationAnalysis?.version === root.RadioDegradationAnalyzer.VERSION)
      .map((log) => ({ logId: log.id, analysis: log.radioDegradationAnalysis })));
  };

  const defaultFilters = () => ({
    lte: true, nr: true, coverage: true, sinr: true, availability: true, mobility: true,
    mos: true, mosCorrelated: true, throughput: true,
    scope: "drive", band: "all", priority: "all", issue: "all", rca: "all", confidence: "all",
    minPoints: 1, top: "20",
  });
  const filtersFor = (log) => {
    const analysis = log?.radioDegradationAnalysis;
    if (!analysis) return defaultFilters();
    // Stable reference: recreating the object on every call orphaned the
    // closure captured by refreshFilters, so no filter change ever applied.
    if (!analysis.viewFilters) analysis.viewFilters = defaultFilters();
    return analysis.viewFilters;
  };
  const filteredRows = (log) => {
    const filters = filtersFor(log);
    const rows = analysisRows(log).filter((row) => {
      if (row.reviewState === "rejected") return false;
      if (row.rat === "LTE" && !filters.lte) return false;
      if (row.rat === "NR" && !filters.nr) return false;
      if (row.type === "MOS_DEGRADATION" && !filters.mos) return false;
      if (row.type === "MOS_DEGRADATION" && row.correlation?.bestOverlap >= .5 && !filters.mosCorrelated) return false;
      if (row.type === "THROUGHPUT_DEGRADATION" && !filters.throughput) return false;
      if (row.type === "MOBILITY_ANOMALY" && !filters.mobility) return false;
      if (filters.scope === "drive" && row.stationary) return false;
      if (filters.scope === "stationary" && !row.stationary) return false;
      if (row.type === "NR_AVAILABILITY_LOSS" && !filters.availability) return false;
      if (row.type !== "NR_AVAILABILITY_LOSS" && row.type !== "MOS_DEGRADATION" && row.type !== "THROUGHPUT_DEGRADATION" && row.type !== "MOBILITY_ANOMALY" && !filters.coverage && !filters.sinr) return false;
      if (/^COVERAGE_DEGRADATION$/.test(String(row.type)) && !filters.coverage) return false;
      if (/^SINR_DEGRADATION$/.test(String(row.type)) && !filters.sinr) return false;
      // A combined zone remains relevant when either selected KPI is requested.
      if (/COMBINED|MIXED/.test(String(row.type)) && !(filters.coverage || filters.sinr)) return false;
      const professional = professionalFor(row);
      if (filters.band !== "all" && professional?.band !== filters.band) return false;
      if (filters.priority !== "all" && professional?.priorityClass !== filters.priority) return false;
      if (filters.issue !== "all" && professional?.issueType !== filters.issue) return false;
      if (filters.rca !== "all" && professional?.rcaCode !== filters.rca) return false;
      if (filters.confidence !== "all" && professional?.rcaConfidenceClass !== filters.confidence) return false;
      return Number(row.sampleCount || 0) >= Math.max(1, Number(filters.minPoints) || 1);
    });
    // COP: chronological order (Top N keeps the N earliest per RAT).
    rows.sort((a, b) => {
      const ta = Number(a.timeMs ?? Date.parse(a.startTime));
      const tb = Number(b.timeMs ?? Date.parse(b.startTime));
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      return String(a.startTime || "").localeCompare(String(b.startTime || ""));
    });
    const max = filters.top === "all" ? Infinity : Math.max(1, Number(filters.top) || 20);
    const perRat = { LTE: 0, NR: 0, MOS: 0, DATA: 0 };
    return rows.filter((row) => {
      perRat[row.rat] = (perRat[row.rat] || 0) + 1;
      return perRat[row.rat] <= max;
    });
  };

  const popupHtml = (item) => {
    const serving = item.dominantServing || item.representative || {};
    const analysis = item.analysis || {};
    return `<div style="font:12px/1.45 system-ui,sans-serif;min-width:270px;">
      <b>${escapeHtml(item.rat)} #${item.rank} · ${escapeHtml(typeLabel(item.type))}</b><br>
      <span>${escapeHtml(serving.cellName || "Serving non résolu")}</span><br>
      <span>Symptôme observé : ${escapeHtml(analysis.symptom?.name || typeLabel(item.type))}</span><br>
      ${item.type === "MOS_DEGRADATION" ? `<span>MOS P50/P10: ${number(item.mos?.median, 2)} / ${number(item.mos?.p10, 2)}</span><br>` :
        item.type === "THROUGHPUT_DEGRADATION" ? `<span>Débit DL P50/P10: ${number(item.throughput?.median, 2)} / ${number(item.throughput?.p10, 2)} Mbps</span><br>` :
        `<span>RSRP P50/P10: ${number(item.metrics?.rsrp?.median)} / ${number(item.metrics?.rsrp?.p10)} dBm</span><br>
         <span>SINR P50/P10: ${number(item.metrics?.sinr?.median)} / ${number(item.metrics?.sinr?.p10)} dB</span><br>`}
      <span>${item.sampleCount || 0} snapshots · ${number(item.durationSec)} s · ${Math.round(Number(item.distanceM) || 0)} m</span><br>
      ${item.scanOverlap?.best ? `<span style="color:#fca5a5;">Scan Route : ${number(item.scanOverlap.best.overlapPct)} % des snapshots dégradés, ${item.scanOverlap.best.maxStrongCells} cellules fortes cofréquence.</span><br>` : ""}
      <span style="color:#a7f3d0;">Cause probable : ${escapeHtml(item.professional?.probableCause || analysis.cause?.name || item.primaryRca?.label || "À confirmer")}</span><br>
      <span>Preuve RCA : ${escapeHtml(analysis.cause?.evidenceLevel || "NOT_VERIFIABLE")} · confiance ${item.confidenceDetail?.score ?? "N/D"}/100</span><br>
      <span>Qualité des données : ${item.dataQuality?.score ?? "N/D"}/100 · serving ${item.dataQuality?.servingMeasurementCoveragePct ?? "N/D"}% · voisines ${item.dataQuality?.neighborMeasurementCoveragePct ?? "N/D"}% · comparaisons ${item.dataQuality?.comparableNeighborSamples ?? 0}</span><br>
      <span style="font-size:11px;color:#94a3b8;">${escapeHtml((item.professional?.rcaEvidence || analysis.observedEvidence || item.primaryRca?.evidence || []).join(" · "))}</span><br>
      <span style="font-size:11px;color:#fbbf24;">Vérification : ${escapeHtml((analysis.verification || []).join(" "))}</span>
    </div>`;
  };

  const focusRow = (log, item) => {
    // The table/popup displays dominantServing. Open that exact measurement
    // in Point Details so both panels always describe the same serving cell.
    // The worst KPI snapshot remains available as `representative` for the
    // incident statistics and severity calculation.
    const focusSnapshot = item?.dominantServing || item?.representative || item?.sequence?.[0];
    const sourceIndex = Number(focusSnapshot?.sourceIndex);
    if (Number.isInteger(sourceIndex) && log?.points?.[sourceIndex] && typeof root.globalSync === "function") {
      const point = log.points[sourceIndex];
      point.properties = point.properties || {};
      point.properties["Radio RCA"] = item?.primaryRca?.label || "À confirmer";
      point.properties["Radio RCA confidence"] = `${item?.confidenceDetail?.score ?? "N/D"}/100 (${item?.confidenceDetail?.label || item?.confidence || "N/D"})`;
      point.properties["Radio degraded density"] = `${number(item?.degradedDensityPct)}%`;
      point.properties["Radio dominance P50"] = Number.isFinite(Number(item?.dominance?.p50)) ? `${number(item.dominance.p50)} dB` : "N/A";
      point.properties["Radio NR availability"] = item?.nrContinuity?.closedEvidence ? "NR→LTE-only→NR" : "N/A";
      point.properties["Radio anchor context"] = item?.anchorContext?.evidence?.join(" | ") || "N/A";
      point.__radioIncidentEvidence = item;
      root.globalSync(log.id, sourceIndex, "radio-degradation");
    }
    const latlngs = (item?.sequence || []).map((point) => [Number(point?.lat), Number(point?.lng)])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    if (root.map && latlngs.length >= 2 && typeof root.map.fitBounds === "function") {
      root.map.fitBounds(latlngs, { padding: [45, 45], maxZoom: 18, animate: true });
    } else if (root.map && focusSnapshot && Number.isFinite(Number(focusSnapshot.lat)) && Number.isFinite(Number(focusSnapshot.lng))) {
      root.map.setView([Number(focusSnapshot.lat), Number(focusSnapshot.lng)], Math.max(16, Number(root.map.getZoom?.() || 0)), { animate: true });
    }
  };

  // The review is a workspace, not a full-screen overlay: keep the selected
  // measurement and map visible above the incident table on desktop screens.
  const reviewLayoutProperties = ["left", "top", "right", "bottom", "width", "height", "maxWidth", "maxHeight", "margin"];
  let reviewLayoutState = null;
  const saveReviewRect = (element) => element && ({
    element,
    values: Object.fromEntries(reviewLayoutProperties.map((property) => [property, element.style[property]])),
    maximized: element.classList.contains("maximized"),
  });
  const restoreReviewLayout = () => {
    if (!reviewLayoutState) return;
    reviewLayoutState.forEach((entry) => {
      if (!entry) return;
      reviewLayoutProperties.forEach((property) => { entry.element.style[property] = entry.values[property]; });
      entry.element.classList.toggle("maximized", entry.maximized);
    });
    reviewLayoutState = null;
    root.mapRenderer?.map?.invalidateSize?.();
  };
  const arrangeReviewLayout = (modal) => {
    const content = modal?.querySelector(".modal-content");
    const mapWindow = document.getElementById("win-map");
    const pointPanel = document.getElementById("floatingInfoPanel");
    if (!content || !mapWindow) return;
    if (document.getElementById("center-pane")?.classList.contains("paired-workspace-grid")) return;
    if (root.innerWidth < 1100 || root.innerHeight < 680) {
      restoreReviewLayout();
      return;
    }

    if (!reviewLayoutState) reviewLayoutState = [saveReviewRect(content), saveReviewRect(mapWindow), saveReviewRect(pointPanel)];
    const headerBottom = document.querySelector("#app > header")?.getBoundingClientRect().bottom || 64;
    const top = Math.max(64, Math.round(headerBottom + 8));
    const gap = 8;
    const bottomHeight = Math.max(260, Math.min(380, Math.round(root.innerHeight * .31)));
    const bottomTop = Math.max(top + 270, root.innerHeight - bottomHeight - 10);
    const topHeight = bottomTop - top - gap;
    const layersWindow = document.getElementById("smartcare-sidebar")?.closest(".floating-window");
    const layersRect = layersWindow?.getBoundingClientRect();
    const rightEdge = layersRect && layersRect.width > 0 && layersRect.left > root.innerWidth * .6
      ? layersRect.left - gap : root.innerWidth - 10;
    const hasPoint = pointPanel && getComputedStyle(pointPanel).display !== "none";
    const pointWidth = hasPoint ? Math.round(rightEdge * .51) : 0;
    const mapLeft = hasPoint ? pointWidth + 16 : 10;
    const mapParent = mapWindow.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };

    if (hasPoint) {
      Object.assign(pointPanel.style, {
        left: "10px", top: `${top}px`, right: "auto", bottom: "auto",
        width: `${pointWidth - 10}px`, height: `${topHeight}px`,
        maxWidth: "none", maxHeight: "none",
      });
    }
    mapWindow.classList.remove("maximized");
    Object.assign(mapWindow.style, {
      left: `${Math.round(mapLeft - mapParent.left)}px`,
      top: `${Math.round(top - mapParent.top)}px`,
      width: `${Math.round(rightEdge - mapLeft)}px`, height: `${topHeight}px`,
    });
    Object.assign(content.style, {
      left: "10px", top: `${bottomTop}px`, right: "auto", bottom: "auto",
      width: `${root.innerWidth - 20}px`, height: `${root.innerHeight - bottomTop - 10}px`,
      maxWidth: "none", maxHeight: "none", margin: "0px",
    });
    root.requestAnimationFrame?.(() => root.mapRenderer?.map?.invalidateSize?.());
  };

  const openScanDeepAnalysis = (log, incident, zoneIndex = null) => {
    const match = (incident?.scanOverlap?.matches || []).find((item) =>
      zoneIndex === null || item.zoneIndex === zoneIndex);
    const zone = log?.radioDegradationAnalysis?.routeScanOverlap?.zones?.[match?.zoneIndex];
    if (!match || !zone || !root.RouteScanAnalyzer?.analyzeZone || !root.renderRouteScanDeepAnalysis) return;
    try {
      const result = root.RouteScanAnalyzer.analyzeZone(log.points, zone, { sampleIndices: match.sampleIndices });
      const point = log.points[match.sampleIndices[Math.floor(match.sampleIndices.length / 2)]];
      root.renderRouteScanDeepAnalysis(result, point, log);
    } catch (error) {
      root.alert?.(`Deep Analysis impossible : ${error.message}`);
    }
  };

  const showRadioSegmentsOnMap = (log, selectedId = null) => {
    if (!log || !root.mapRenderer || typeof root.mapRenderer.drawVoiceDegradationSegments !== "function") return;
    const all = filteredRows(log);
    const rows = selectedId ? all.filter((item) => String(item.id) === String(selectedId)) : all;
    const radioRows = rows.filter((item) => item.type !== "NR_AVAILABILITY_LOSS");
    const nrLossRows = rows.filter((item) => item.type === "NR_AVAILABILITY_LOSS");
    const layerId = `radio_segments__${log.id}`;
    root.mapRenderer.drawVoiceDegradationSegments(layerId, radioRows.map((item) => ({
      id: item.id,
      rank: item.rank,
      sampleCount: item.sampleCount,
      color: typeColor(item),
      typeLabel: `${item.rat} · ${typeLabel(item.type)}`,
      points: item.sequence || [],
      tooltip: `${item.rat} #${item.rank} · ${typeLabel(item.type)} · ${item.sampleCount || 0} points`,
      popupHtml: popupHtml(item),
      item,
    })), {
      onSegmentClick: (segment) => {
        const item = segment.item;
        focusRow(log, item);
        showRadioSegmentsOnMap(log, item.id);
      },
    });
    const overlapLayerId = `radio_scan_overlap__${log.id}`;
    const overlapSegments = radioRows.flatMap((item) => (item.scanOverlap?.matches || [])
      .flatMap((match) => (match.segments || [match.points]).filter((points) => points.length >= 2)
        .map((points, part) => ({
        id: `${item.id}::scan_${match.zoneIndex}_${part}`, sampleCount: points.length,
        color: "#dc2626", points,
        tooltip: `${item.rat} · Scan Route ∩ dégradation · ${match.overlapPct} %`,
        popupHtml: `<div style="font:12px/1.5 system-ui,sans-serif;min-width:240px;"><b>Scan Route ∩ dégradation ${escapeHtml(item.rat)}</b><br>` +
          `${match.degradedSnapshotCount} snapshots communs (${number(match.overlapPct)} %) · ${match.maxStrongCells} cellules cofréquence fortes.<br>` +
          `${escapeHtml(item.scanOverlap.rca.hypothesis)}</div>`,
        item, match,
      }))));
    root.mapRenderer.drawVoiceDegradationSegments(overlapLayerId, overlapSegments, {
      onSegmentClick: (segment) => {
        focusRow(log, segment.item);
        openScanDeepAnalysis(log, segment.item, segment.match.zoneIndex);
      },
    });
    const overlapLegendKey = `${log.id}::radio_scan_overlap`;
    if (overlapSegments.length) {
      root.eventLegendEntries = root.eventLegendEntries || {};
      root.eventLegendEntries[overlapLegendKey] = {
        title: `Scan Route ∩ dégradations (${overlapSegments.length})`, color: "#dc2626",
        count: overlapSegments.length, logId: log.id, points: overlapSegments,
        layerId: overlapLayerId, visible: true,
      };
      root.moveDTLayerToTop?.(overlapLegendKey);
    } else if (root.eventLegendEntries) delete root.eventLegendEntries[overlapLegendKey];
    const visibleIds = new Set(radioRows.map((item) => item.id));
    const coexistence = (log.radioDegradationAnalysis?.routeScanOverlap?.crossRatPairs || [])
      .filter((pair) => visibleIds.has(pair.lteIncidentId) && visibleIds.has(pair.nrIncidentId) && pair.points.length >= 2);
    const coexistenceLayerId = `radio_lte_nr_coexistence__${log.id}`;
    root.mapRenderer.drawVoiceDegradationSegments(coexistenceLayerId, coexistence.map((pair) => ({
      id: `${pair.lteIncidentId}::${pair.nrIncidentId}`, color: "#22d3ee",
      sampleCount: pair.matchedSnapshots, points: pair.points,
      tooltip: `LTE + NR simultanés · ${pair.matchedSnapshots} snapshots`,
      popupHtml: `<div style="font:12px/1.5 system-ui,sans-serif;"><b>Dégradations LTE et NR simultanées</b><br>` +
        `${pair.matchedSnapshots} snapshots · LTE ${number(pair.lteOverlapPct)} % · NR ${number(pair.nrOverlapPct)} %.<br>` +
        `${escapeHtml(pair.interpretation)}</div>`,
    })));
    const coexistenceLegendKey = `${log.id}::radio_lte_nr_coexistence`;
    if (coexistence.length) root.eventLegendEntries[coexistenceLegendKey] = {
      title: `Dégradations LTE + NR simultanées (${coexistence.length})`, color: "#22d3ee",
      count: coexistence.length, logId: log.id, points: coexistence,
      layerId: coexistenceLayerId, visible: true,
    };
    else delete root.eventLegendEntries[coexistenceLegendKey];
    if (!root.eventLegendEntries) root.eventLegendEntries = {};
    const eventKey = `${log.id}::radio_incidents`;
    root.eventLegendEntries[eventKey] = {
      title: selectedId && radioRows[0] ? `${radioRows[0].rat} #${radioRows[0].rank} · ${typeLabel(radioRows[0].type)}` : `Segments radio 4G/5G (${radioRows.length})`,
      color: "#a855f7",
      count: radioRows.length,
      logId: log.id,
      points: radioRows,
      layerId,
      visible: true,
    };
    if (nrLossRows.length) {
      const lossLayerId = `radio_nr_loss__${log.id}`;
      root.mapRenderer.drawVoiceDegradationSegments(lossLayerId, nrLossRows.map((item) => ({
        id: item.id,
        rank: item.rank,
        sampleCount: item.sampleCount,
        color: "#f43f5e",
        typeLabel: "NR · Perte de disponibilité",
        points: item.sequence || [],
        tooltip: `Perte NR #${item.rank} · ${number(item.durationSec)} s · ${Math.round(item.distanceM || 0)} m`,
        popupHtml: popupHtml(item),
        item,
      })), { onSegmentClick: (segment) => focusRow(log, segment.item) });
      root.eventLegendEntries[`${log.id}::nr_availability_loss`] = {
        title: `Pertes de disponibilité NR (${nrLossRows.length})`,
        color: "#f43f5e",
        count: nrLossRows.length,
        logId: log.id,
        points: nrLossRows,
        layerId: lossLayerId,
        visible: true,
      };
      root.moveDTLayerToTop?.(`${log.id}::nr_availability_loss`);
    }
    const changes = log.radioDegradationAnalysis?.mobilityEvents || [];
    if (changes.length && typeof root.mapRenderer.addEventsLayer === "function") {
      const changeLayerId = `radio_serving_changes__${log.id}`;
      root.mapRenderer.addEventsLayer(changeLayerId, changes, { useFlag: true, flagStyle: "tall", flagColor: "#22d3ee" });
      root.eventLegendEntries[`${log.id}::probable_serving_changes`] = {
        title: `Changements PSCell/PCell probables (${changes.length})`,
        color: "#22d3ee",
        count: changes.length,
        logId: log.id,
        points: changes,
        layerId: changeLayerId,
        visible: true,
      };
      root.moveDTLayerToTop?.(`${log.id}::probable_serving_changes`);
    }
    const anomalies = analysisRows(log).flatMap((item) => (item.mobility?.anomalies || [])
      .filter((anomaly) => anomaly.code !== "NR_AVAILABILITY_LOSS_PROBABLE")
      .map((anomaly) => ({
        ...item.representative,
        type: "EVENT",
        event: anomaly.label,
        eventKind: "radio_mobility_anomaly",
        message: `${anomaly.label} · ${item.dominantServing?.cellName || "Serving non résolu"}`,
        incidentId: item.id,
      })));
    if (anomalies.length && typeof root.mapRenderer.addEventsLayer === "function") {
      const anomalyLayerId = `radio_mobility_anomalies__${log.id}`;
      root.mapRenderer.addEventsLayer(anomalyLayerId, anomalies, { useFlag: true, flagStyle: "tall", flagColor: "#fb7185" });
      root.eventLegendEntries[`${log.id}::radio_mobility_anomalies`] = {
        title: `Anomalies mobilité probables (${anomalies.length})`, color: "#fb7185", count: anomalies.length,
        logId: log.id, points: anomalies, layerId: anomalyLayerId, visible: true,
      };
      root.moveDTLayerToTop?.(`${log.id}::radio_mobility_anomalies`);
    }
    root.moveDTLayerToTop?.(eventKey);
    root.applyDTLayerOrder?.();
    root.updateLegend?.();
    root.updateDTLayersSidebar?.();
  };

  const ensureModal = () => {
    let modal = document.getElementById("radioDegradationModal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "radioDegradationModal";
    modal.className = "modal";
    modal.style.cssText = "z-index:10032;";
    modal.innerHTML = `
      <div class="modal-content" style="width:min(96vw,1900px);height:min(84vh,900px);min-width:760px;min-height:260px;display:flex;flex-direction:column;background:#101827;color:#e5e7eb;border:1px solid #475569;resize:both;overflow:hidden;">
        <div class="modal-header" id="radioDegradationHeader" style="display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid #334155;cursor:move;">
          <h3 id="radioDegradationTitle" style="margin:0;flex:1;font-size:16px;">Analyse automatique radio 4G/5G + MOS</h3>
          <span style="font-size:10px;color:#94a3b8;">↘ Ajuster la taille</span>
          <button id="radioDegradationMinimize" type="button" title="Réduire la fenêtre" style="width:28px;height:28px;border:1px solid #475569;border-radius:5px;background:#1e293b;color:#e2e8f0;font-size:18px;cursor:pointer;">−</button>
          <button id="radioDegradationClose" type="button" title="Fermer" style="width:28px;height:28px;border:0;background:transparent;color:#94a3b8;font-size:22px;cursor:pointer;">×</button>
        </div>
        <div class="modal-body" id="radioDegradationBody" style="padding:12px;overflow:auto;">
          <div id="radioDegradationSummary" style="display:none;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin-bottom:10px;"></div>
          <section id="radioProfessionalSummary" style="margin:0 0 12px;padding:12px;border:1px solid #334155;border-radius:7px;background:#0b1220;color:#dbeafe;"></section>
          <fieldset style="display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:0 0 10px;padding:9px 10px;border:1px solid #334155;border-radius:6px;background:#0b1220;">
            <legend style="font-size:11px;font-weight:700;color:#c4b5fd;">Détection LTE / NR</legend>
            <label style="font-size:11px;color:#94a3b8;">LTE RSRP ≤ (dBm)<input id="radioLteRsrp" type="number" step="0.5" style="display:block;width:96px;margin-top:4px;"></label>
            <label style="font-size:11px;color:#94a3b8;">LTE SINR ≤ (dB)<input id="radioLteSinr" type="number" step="0.5" style="display:block;width:96px;margin-top:4px;"></label>
            <label style="font-size:11px;color:#94a3b8;">NR RSRP ≤ (dBm)<input id="radioNrRsrp" type="number" step="0.5" style="display:block;width:96px;margin-top:4px;"></label>
            <label style="font-size:11px;color:#94a3b8;">NR SINR ≤ (dB)<input id="radioNrSinr" type="number" step="0.5" style="display:block;width:96px;margin-top:4px;"></label>
            <label style="font-size:11px;color:#94a3b8;">Points dégradés min.<input id="radioMinPoints" type="number" min="1" step="1" style="display:block;width:90px;margin-top:4px;"></label>
            <label style="font-size:11px;color:#94a3b8;">MOS &lt;<input id="radioMosThreshold" type="number" min="0" max="5" step="0.1" style="display:block;width:75px;margin-top:4px;"></label>
            <label style="font-size:11px;color:#94a3b8;">Milieu<select id="radioProfileEnvironment" style="display:block;width:110px;margin-top:4px;"><option value="">Auto</option><option value="URBAN">Urban</option><option value="HIGHWAY">Highway</option></select></label>
            <label style="font-size:11px;color:#94a3b8;">Usage<select id="radioProfilePurpose" style="display:block;width:90px;margin-top:4px;"><option value="">Auto</option><option value="VOICE">Voice</option><option value="DATA">Data</option></select></label>
            <label style="font-size:11px;color:#94a3b8;">Bande<input id="radioProfileBand" placeholder="Auto" style="display:block;width:72px;margin-top:4px;"></label>
            <label style="font-size:11px;color:#94a3b8;">Hz<input id="radioProfileSampling" type="number" min="0.1" max="100" step="0.1" placeholder="Auto" style="display:block;width:65px;margin-top:4px;"></label>
            <label style="font-size:11px;color:#94a3b8;">Profil JSON<input id="radioProfileImport" type="file" accept=".json" style="display:block;width:190px;margin-top:4px;"></label>
            <button id="radioRecalculate" class="btn" style="background:#4338ca;">Recalculer</button>
            <span id="radioDetectionStatus" style="font-size:11px;color:#94a3b8;max-width:360px;">Les flux LTE PCell et NR PSCell sont analysés séparément. Les SCells ne sont jamais comptées comme Serving.</span>
          </fieldset>
          <fieldset style="display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:0 0 10px;padding:9px 10px;border:1px solid #334155;border-radius:6px;background:#0b1220;">
            <legend style="font-size:11px;font-weight:700;color:#cbd5e1;">Segments affichés</legend>
            <label style="font-size:12px;color:#a7f3d0;"><input id="radioFilterLte" type="checkbox"> LTE</label>
            <label style="font-size:12px;color:#c4b5fd;"><input id="radioFilterNr" type="checkbox"> NR</label>
            <label style="font-size:12px;color:#fed7aa;"><input id="radioFilterCoverage" type="checkbox"> Couverture</label>
            <label style="font-size:12px;color:#fde68a;"><input id="radioFilterSinr" type="checkbox"> SINR</label>
            <label style="font-size:12px;color:#fda4af;"><input id="radioFilterAvailability" type="checkbox"> Passage 5G vers LTE</label>
            <label style="font-size:12px;color:#67e8f9;"><input id="radioFilterMobility" type="checkbox"> Mobilité probable</label>
            <label style="font-size:12px;color:#5eead4;"><input id="radioFilterMos" type="checkbox"> MOS</label>
            <label style="font-size:12px;color:#f9a8d4;"><input id="radioFilterMosCorrelated" type="checkbox"> MOS + RF corrélés</label>
            <label style="font-size:12px;color:#fbbf24;"><input id="radioFilterThroughput" type="checkbox"> Débit DL</label>
            <label style="font-size:11px;color:#94a3b8;display:none;">Population<select id="radioFilterScope" style="display:block;width:150px;margin-top:4px;"><option value="drive">Incidents Drive</option><option value="stationary">Preuves stationnaires</option><option value="all">Tous</option></select></label>
            <label style="font-size:11px;color:#94a3b8;display:none;">Bande<select id="radioFilterBand" style="display:block;width:135px;margin-top:4px;"><option value="all">Toutes</option></select></label>
            <label style="font-size:11px;color:#94a3b8;display:none;">Priorité<select id="radioFilterPriority" style="display:block;width:90px;margin-top:4px;"><option value="all">Toutes</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option><option value="P4">P4</option></select></label>
            <label style="font-size:11px;color:#94a3b8;display:none;">Type<select id="radioFilterIssue" style="display:block;width:155px;margin-top:4px;"><option value="all">Tous</option><option value="coverage">Coverage</option><option value="quality">Quality</option><option value="coverage_quality">Coverage + Quality</option><option value="nr_availability_loss">NR Availability Loss</option><option value="mobility">Mobilité</option><option value="mos">MOS</option><option value="throughput">Débit DL</option></select></label>
            <label style="font-size:11px;color:#94a3b8;display:none;">RCA<select id="radioFilterRca" style="display:block;width:180px;margin-top:4px;"><option value="all">Toutes</option></select></label>
            <label style="font-size:11px;color:#94a3b8;display:none;">Confiance<select id="radioFilterConfidence" style="display:block;width:120px;margin-top:4px;"><option value="all">Toutes</option><option value="very_high">Très élevée</option><option value="high">Élevée</option><option value="medium">Moyenne</option><option value="low">Faible</option><option value="very_low">Très faible</option></select></label>
            <label style="font-size:11px;color:#94a3b8;">Min. points<input id="radioFilterMinPoints" type="number" min="1" step="1" style="display:block;width:78px;margin-top:4px;"></label>
            <label style="font-size:11px;color:#94a3b8;">Classement<select id="radioFilterTop" style="display:block;width:95px;margin-top:4px;"><option value="5">Top 5</option><option value="10">Top 10</option><option value="20">Top 20</option><option value="all">Tous</option></select></label>
            <button id="radioShowMap" class="btn" style="background:#0f766e;">Afficher sur la carte</button>
            <button id="radioExport" class="btn" style="background:#2563eb;display:none;">Exporter validations XLSX</button>
            <button id="radioDtCopExport" class="btn" style="background:#7c3aed;" title="Statistiques du DT et candidats radio non rejetés, dans les feuilles Statistiques et Analyse">Exporter Analyse DT COP</button>
            <button id="radioCellStatisticsExport" class="btn" style="background:#0e7490;display:none;" title="Deux feuilles : statistiques par cellule serveuse LTE/NR (dont BLER et packet loss) et distributions du parcours DT.">Exporter synthèse DT par cellule</button>
          </fieldset>
          <fieldset style="display:grid;grid-template-columns:150px 170px minmax(210px,1fr) minmax(210px,1fr);gap:8px;align-items:end;margin:0 0 10px;padding:9px 10px;border:1px solid #334155;border-radius:6px;background:#0b1220;">
            <legend style="font-size:11px;font-weight:700;color:#86efac;">Export des dégradations validées</legend>
            <label style="font-size:11px;color:#94a3b8;">Date du parcours<input id="radioDegradationDate" type="date" style="display:block;width:100%;margin-top:4px;"></label>
            <label style="font-size:11px;color:#94a3b8;">Type de test<input id="radioDegradationTestType" style="display:block;width:100%;margin-top:4px;"></label>
            <label style="font-size:11px;color:#94a3b8;">Nom de la plaque<input id="radioDegradationPlaque" placeholder="À renseigner" style="display:block;width:100%;margin-top:4px;"></label>
            <label style="font-size:11px;color:#94a3b8;">Nom du logfile<input id="radioDegradationLogfile" style="display:block;width:100%;margin-top:4px;"></label>
            <span id="radioApprovalStatus" style="grid-column:1/-1;font-size:11px;color:#94a3b8;">Validez une ou plusieurs dégradations pour alimenter la feuille « Synthèse incidents ».</span>
          </fieldset>
          <div id="radioExecutiveTop" style="margin:0 0 10px;padding:8px 10px;border:1px solid #334155;border-radius:6px;background:#0b1220;font-size:11px;color:#cbd5e1;"></div>
          <div id="radioMacroZones" style="margin:0 0 10px;padding:8px 10px;border:1px solid #334155;border-radius:6px;background:#0b1220;font-size:11px;color:#cbd5e1;"></div>
          <section id="radioTimeline" style="margin:0 0 10px;padding:10px;border:1px solid #334155;border-radius:6px;background:#0b1220;font-size:11px;color:#cbd5e1;"></section>
          <div style="overflow:auto;border:1px solid #334155;border-radius:6px;"><table style="width:100%;min-width:1750px;border-collapse:collapse;font-size:12px;line-height:1.4;"><thead><tr style="background:#1e293b;color:#dbeafe;"><th style="padding:9px;text-align:left;">ID</th><th style="padding:9px;text-align:left;">Décision</th><th style="padding:9px;text-align:left;">Type</th><th style="padding:9px;text-align:left;">Début</th><th style="padding:9px;text-align:left;">Serving dominant</th><th style="padding:9px;">Bande / canal</th><th style="padding:9px;text-align:left;">Analyse Optim</th><th style="padding:9px;">Dominance</th><th style="padding:9px;">RSRP P50 / P10</th><th style="padding:9px;">SINR P50 / P10</th><th style="padding:9px;">MOS P50 / P10</th><th style="padding:9px;">Points</th><th style="padding:9px;">Distance</th></tr></thead><tbody id="radioDegradationRows"></tbody></table></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector("#radioDegradationClose").onclick = () => {
      modal.style.display = "none";
      restoreReviewLayout();
    };
    const content = modal.querySelector(".modal-content");
    const min = modal.querySelector("#radioDegradationMinimize");
    min.onclick = () => {
      const minimized = !content.classList.contains("is-minimized");
      if (minimized) content.dataset.restoreHeight = `${Math.round(content.getBoundingClientRect().height)}px`;
      content.classList.toggle("is-minimized", minimized);
      modal.querySelector("#radioDegradationBody").style.display = minimized ? "none" : "block";
      content.style.height = minimized ? "52px" : (content.dataset.restoreHeight || "min(84vh,900px)");
      min.textContent = minimized ? "□" : "−";
    };
    if (typeof root.makeElementDraggable === "function") root.makeElementDraggable(modal.querySelector("#radioDegradationHeader"), content);
    root.addEventListener("resize", () => {
      if (reviewLayoutState && modal.style.display !== "none") arrangeReviewLayout(modal);
    });
    modal.querySelectorAll("input:not([type=checkbox]), select").forEach((input) => {
      input.style.cssText += "box-sizing:border-box;padding:6px 7px;border:1px solid #475569;border-radius:4px;background:#111827;color:#f8fafc;font-weight:650;";
    });
    return modal;
  };

  const summaryCard = (label, value, color) => `<div style="border:1px solid #334155;background:#0f172a;border-radius:6px;padding:8px 10px;"><div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;">${escapeHtml(label)}</div><div style="font-size:21px;font-weight:800;color:${color};margin-top:3px;">${escapeHtml(value ?? 0)}</div></div>`;
  const priorityColor = (priority) => ({ P1: "#f87171", P2: "#fbbf24", P3: "#60a5fa", P4: "#94a3b8" }[priority] || "#94a3b8");
  const renderExecutiveSummary = (log, modal) => {
    const analysis = applyProfessionalReport(log, exportMetaFor(log));
    const report = analysis?.professionalReport;
    const q = (id) => modal.querySelector(id);
    if (!report) return;
    const cards = report.cards || [];
    try {
      const nProf = (analysis.incidents || []).filter((item) => item && item.professional).length;
      console.info("[COP summary]", `incidents=${(analysis.incidents || []).length} withProfessional=${nProf} cards=${cards.length}`);
    } catch (_) {}
    q("#radioDegradationSummary").innerHTML = cards.map(([label, value]) => summaryCard(label, value, /Passage|Nombre/.test(label) ? "#fb7185" : /5G|NR/.test(label) ? "#a78bfa" : "#67e8f9")).join("");
    q("#radioProfessionalSummary").innerHTML = "";
    q("#radioProfessionalSummary").style.display = "none";
    const technologies = (report.technology || []).map((item) => `<div style="padding:8px;border-left:3px solid ${item.rat === "NR" ? "#a78bfa" : "#34d399"};background:#111827;border-radius:4px;margin-top:7px;">${escapeHtml(item.text)}</div>`).join("");
    void technologies;
    q("#radioExecutiveTop").innerHTML = "";
    q("#radioExecutiveTop").style.display = "none";
  };
  const fillFilterOptions = (modal, log) => {
    const filters = filtersFor(log);
    const rows = analysisRows(log);
    const replace = (selector, values, selected, labels = {}) => {
      const select = modal.querySelector(selector);
      if (!select) return;
      select.innerHTML = `<option value="all">Toutes</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(labels[value] || value)}</option>`).join("")}`;
      select.value = values.includes(selected) ? selected : "all";
    };
    replace("#radioFilterBand", unique(rows.map((item) => professionalFor(item)?.band)).sort(), filters.band);
    replace("#radioFilterRca", unique(rows.map((item) => professionalFor(item)?.rcaCode)).sort(), filters.rca);
  };

  const preserveReviewStates = (previous, next) => {
    const states = new Map((previous?.incidents || []).map((item) => [`${item.rat}|${item.startTime}|${item.endTime}|${item.type}`, item.reviewState]));
    (next?.incidents || []).forEach((item) => {
      const state = states.get(`${item.rat}|${item.startTime}|${item.endTime}|${item.type}`);
      if (state) item.reviewState = state;
    });
  };

  const renderTimeline = (modal, analysis, selected) => {
    const host = modal.querySelector("#radioTimeline");
    if (host) host.style.display = "none";
    return;
    if (!host || !selected) { if (host) host.textContent = "Aucun incident à afficher sur la timeline."; return; }
    const parse = (value) => root.RadioRcaEngine?.timeMs?.(value) ?? Date.parse(value);
    const start = parse(selected.startTime) - 5000;
    const end = parse(selected.endTime) + 5000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { host.textContent = "Horodatage indisponible."; return; }
    const percentAt = (ms) => Math.max(0, Math.min(100, (ms - start) / (end - start) * 100));
    const within = (row) => Number.isFinite(row?.timeMs) && row.timeMs >= start && row.timeMs <= end;
    const sampled = (rows) => {
      const visible = (rows || []).filter(within);
      const step = Math.max(1, Math.ceil(visible.length / 120));
      return visible.filter((_, index) => index % step === 0);
    };
    const serving = sampled(analysis.servingStream);
    const mos = sampled(analysis.mosSnapshots);
    const throughput = sampled(analysis.throughputSnapshots);
    const changes = (analysis.mobilityEvents || []).filter(within);
    const nrLoss = (analysis.incidents || []).filter((item) => item.type === "NR_AVAILABILITY_LOSS" &&
      parse(item.endTime) >= start && parse(item.startTime) <= end);
    const points = (rows, value, color, unit = "") => rows.map((row) => {
      const measured = value(row);
      if (!Number.isFinite(measured)) return "";
      return `<span title="${escapeHtml(row.time || "")} · ${escapeHtml(String(measured))}${escapeHtml(unit)}" style="position:absolute;left:${percentAt(row.timeMs)}%;top:3px;width:5px;height:13px;border-radius:3px;background:${color(measured)};"></span>`;
    }).join("");
    const marker = (ms, title, color) => `<span title="${escapeHtml(title)}" style="position:absolute;left:${percentAt(ms)}%;top:0;height:19px;border-left:2px solid ${color};"></span>`;
    const track = (label, content) => `<div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:center;margin:3px 0;"><b style="color:#94a3b8;">${label}</b><div style="position:relative;height:19px;border-radius:4px;background:#172235;overflow:hidden;">${content}</div></div>`;
    const changeMarkers = changes.map((event) => marker(event.timeMs, `Serving ${event.fromCell || ""} → ${event.toCell || ""}`, "#fbbf24")).join("");
    const lossMarkers = nrLoss.map((item) => `<span title="Perte NR ${escapeHtml(item.startTime)} → ${escapeHtml(item.endTime)}" style="position:absolute;left:${percentAt(parse(item.startTime))}%;width:${Math.max(1, percentAt(parse(item.endTime)) - percentAt(parse(item.startTime)))}%;top:2px;height:15px;background:#f43f5eaa;"></span>`).join("");
    const incidentMarkers = marker(parse(selected.startTime), "Début incident", "#4ade80") + marker(parse(selected.endTime), "Fin incident", "#fb7185");
    const neighborTimeline = selected.neighborMobilityRca?.timeline;
    const neighborMarkers = neighborTimeline ? [
      neighborTimeline.firstAdvantageMs !== null ? marker(neighborTimeline.firstAdvantageMs, "Premier avantage de la meilleure voisine", "#22d3ee") : "",
      neighborTimeline.firstPersistentAdvantageMs !== null ? marker(neighborTimeline.firstPersistentAdvantageMs, "Premier avantage persistant", "#a78bfa") : "",
      selected.neighborMobilityRca?.transition ? marker(selected.neighborMobilityRca.transition.timeMs, "Changement serving brut", "#fbbf24") : "",
    ].join("") : "";
    host.innerHTML = `<b style="color:#e2e8f0;">Timeline multi-KPI · ${escapeHtml(selected.id)}</b><span style="margin-left:8px;color:#64748b;">±5 s autour de la zone ; survoler les marqueurs</span>` +
      track("RSRP", points(serving, (row) => row.rsrp, (value) => value <= -105 ? "#ef4444" : "#22c55e", " dBm")) +
      track("SINR", points(serving, (row) => row.sinr, (value) => value <= 0 ? "#ef4444" : "#22c55e", " dB")) +
      track("MOS", points(mos, (row) => row.mos, (value) => value < 3.5 ? "#ec4899" : "#2dd4bf")) +
      track("Débit DL", points(throughput, (row) => row.mbps, (value) => value < 2 ? "#f59e0b" : "#22c55e", " Mbps")) +
      track("Technologie", points(serving, (row) => row.rat === "NR" ? 5 : 4, (value) => value === 5 ? "#a78bfa" : "#38bdf8")) +
      track("Serving RSRP", points(serving, (row) => row.rsrp, (value) => value <= -105 ? "#ef4444" : "#22c55e", " dBm")) +
      track("Voisine RSRP", points(sampled(selected.neighborMobilityRca?.target?.states || []),
        (row) => row.rsrp, (value) => value <= -105 ? "#f97316" : "#22d3ee", " dBm")) +
      track("Cellule serving", changeMarkers) + track("Disponibilité NR", lossMarkers) +
      track("Voisine / mobilité", neighborMarkers) +
      track("Début / fin zone", incidentMarkers);
  };

  const defaultRadioExportMeta = (log) => ({
    date: String(analysisRows(log)[0]?.startTime || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "",
    testType: "Radio 4G/5G",
    plaque: "",
    logfile: String(log?.name || "Export radio").trim(),
  });
  const exportMetaFor = (log) => {
    const analysis = log?.radioDegradationAnalysis;
    if (!analysis) return defaultRadioExportMeta(log);
    analysis.exportMeta = { ...defaultRadioExportMeta(log), ...(analysis.exportMeta || {}) };
    return analysis.exportMeta;
  };
  const updateRadioExportMeta = (log, modal) => {
    const meta = exportMetaFor(log);
    const q = (id) => modal?.querySelector(id);
    const date = q("#radioDegradationDate");
    const testType = q("#radioDegradationTestType");
    const plaque = q("#radioDegradationPlaque");
    const logfile = q("#radioDegradationLogfile");
    if (date) meta.date = date.value || "";
    if (testType) meta.testType = testType.value.trim() || "Radio 4G/5G";
    if (plaque) meta.plaque = plaque.value.trim() || "";
    if (logfile) meta.logfile = logfile.value.trim() || String(log?.name || "Export radio");
    return meta;
  };
  const validatedRows = (log) => analysisRows(log).filter((item) => item.reviewState === "validated");
  const numericCell = (value, digits = 1) => Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : "";
  const coordinateFor = (item) => item?.start || item?.representative || item?.sequence?.[0] || {};
  const radioNature = (item) => item?.rat === "MOS" ? "Dégradation MOS / QoE" :
    item?.rat === "DATA" ? "Débit DL dégradé" :
    `Dégradation ${item?.rat === "NR" ? "5G" : "4G"}`;
  const radioDescription = (item) => {
    const professional = professionalFor(item);
    if (professional?.description) return professional.description;
    const serving = item?.dominantServing || item?.representative || {};
    return `${typeLabel(item?.type)} sur ${serving.role || "Serving"} ${serving.cellName || "non résolu"}`;
  };
  const professionalAnalysis = (item) => {
    const professional = professionalFor(item);
    if (professional) {
      return [
        professional.description,
        professional.dtAnalysis,
        professional.probableCause ? `Cause probable : ${professional.probableCause}` : "",
        professional.limitation?.length ? `Limite RCA : ${professional.limitation.join(" ")}` : "",
      ].filter(Boolean).join(" ");
    }
    const serving = item?.dominantServing || item?.representative || {};
    const rca = item?.primaryRca || {};
    const evidence = (rca.evidence || []).filter(Boolean).join(" · ");
    const context = contextsFor(item).map((entry) => `${entry.label}${entry.evidence ? ` (${entry.evidence})` : ""}`).join(" · ");
    const radioContext = rca.radioContext;
    const neighborStatement = radioContext?.hasMeasuredNeighbors === false
      ? "Aucun voisin mesuré exploitable dans le DT : la cause reste à confirmer."
      : "Le diagnostic repose uniquement sur les voisins réellement mesurés dans le DT.";
    return [
      `${typeLabel(item?.type)} ${item?.rat || "radio"} sur ${serving.role || "Serving"} ${serving.cellName || "non résolu"}.`,
      `RSRP P50/P10 ${number(item?.metrics?.rsrp?.median)} / ${number(item?.metrics?.rsrp?.p10)} dBm ; SINR P50/P10 ${number(item?.metrics?.sinr?.median)} / ${number(item?.metrics?.sinr?.p10)} dB.`,
      rca.label ? `RCA : ${rca.label}.` : "RCA à confirmer.",
      `Densité dégradée ${number(item?.degradedDensityPct)}% ; confiance RCA ${item?.confidenceDetail?.score ?? "N/D"}/100 ; priorité ${item?.priority?.score ?? item?.priorityScore ?? "N/D"}/100.`,
      Number.isFinite(Number(item?.dominance?.p50)) ? `Dominance P50/P10 ${number(item.dominance.p50)} / ${number(item.dominance.p10)} dB ; dominance <3 dB ${number(item.dominance.weakPct)}%.` : "",
      item?.recurrence?.available ? `Récurrence campagne ${number(item.recurrence.score)}% (${item.recurrence.affectedPassages}/${item.recurrence.eligiblePassages} passages).` : "",
      evidence,
      context,
      neighborStatement,
    ].filter(Boolean).join(" ");
  };
  const professionalAction = (item) => {
    const professional = professionalFor(item);
    if (professional?.recommendedAction) return professional.recommendedAction;
    const rca = item?.primaryRca || {};
    const radioContext = rca.radioContext;
    const validation = radioContext?.hasMeasuredNeighbors === false
      ? "Compléter la mesure des voisins et vérifier les paramètres de mobilité avant tout changement."
      : "Vérifier la configuration, les alarmes et les compteurs radio sur la fenêtre exacte, puis rejouer un DT après action.";
    return [rca.recommendation || "Investigation radio ciblée recommandée.", validation].join("\n");
  };
  const approvedSummaryRow = (item, meta) => {
    const professional = professionalFor(item);
    const serving = item?.dominantServing || item?.representative || {};
    const gps = coordinateFor(item);
    return {
      "Date du parcours": meta.date,
      "Type de test": meta.testType,
      "Nom de la plaque": meta.plaque,
      "Nature de problème": radioNature(item),
      "Description du problème": radioDescription(item),
      "Analyse radio professionnelle": professionalAnalysis(item),
      "Analyse Optim": item.optimAnalysis?.text || "Analyse Optim non calculée.",
      "Action recommandée courte": professional?.recommendedAction || item?.primaryRca?.recommendation || "Investigation radio ciblée recommandée.",
      "Action recommandée détaillée": professionalAction(item),
      "Dominant Serving Name": serving.cellName || "",
      "Dominant Serving CI": serving.pci ?? "",
      "Niveau de signal": numericCell(item?.metrics?.rsrp?.median),
      "Qualité du signal": numericCell(item?.metrics?.sinr?.median),
      "Coordonnées X": numericCell(gps.lat, 6),
      "Coordonnées Y": numericCell(gps.lng, 6),
      "Nom du logfile de parcours": meta.logfile,
    };
  };
  const auditRow = (item) => {
    const professional = professionalFor(item);
    const serving = item?.dominantServing || item?.representative || {};
    const rca = item?.primaryRca || {};
    const neighbor = rca.bestNeighbor || {};
    return {
      "Incident ID": item?.id || "",
      Décision: item?.reviewState || "candidate",
      RAT: item?.rat || "",
      "Statut mobilité": item?.stationary ? "Stationnaire / faible mobilité" : "Drive",
      Rang: item?.rank ?? "",
      "Rang priorité": item?.priorityRank ?? "",
      "Score priorité": item?.priorityScore ?? "",
      Type: typeLabel(item?.type),
      Début: item?.startTime || "",
      Fin: item?.endTime || "",
      "Serving dominant": serving.cellName || "",
      "Rôle Serving": serving.role || "",
      "Serving PCI": serving.pci ?? "",
      "Canal Serving": serving.channel ?? "",
      "Bande Serving": professional?.band || item?.band || serving.band || "",
      "Source nom Serving": serving.nameSource || "",
      "RSRP P50 (dBm)": numericCell(item?.metrics?.rsrp?.median),
      "RSRP P10 (dBm)": numericCell(item?.metrics?.rsrp?.p10),
      "SINR P50 (dB)": numericCell(item?.metrics?.sinr?.median),
      "SINR P10 (dB)": numericCell(item?.metrics?.sinr?.p10),
      Points: item?.sampleCount ?? "",
      "Snapshots canoniques": item?.canonicalSampleCount ?? "",
      "Densité dégradée (%)": numericCell(item?.degradedDensityPct),
      "Snapshots critiques (%)": numericCell(item?.criticalSnapshotPct),
      "Durée (s)": numericCell(item?.durationSec),
      "Distance (m)": numericCell(item?.distanceM),
      "Déplacement net (m)": numericCell(item?.mobility?.netDisplacementM),
      "Vitesse moyenne (m/s)": numericCell(item?.mobility?.meanSpeedMps, 2),
      "Changements Serving": item?.servingChanges ?? "",
      "Changements/min": numericCell(item?.mobility?.changesPerMinute, 2),
      "Changements/km": numericCell(item?.mobility?.changesPerKm, 2),
      "Anomalies mobilité": (item?.mobility?.anomalies || []).map((entry) => entry.label).join(" | "),
      "Mobilité cellule source": professional?.mobilitySourceCell || "",
      "Mobilité meilleure voisine": professional?.mobilityTargetCell || "",
      "Écart voisin P50 (dB)": professional?.mobilityDeltaDb == null ? "" : numericCell(professional.mobilityDeltaDb),
      "Délai avant transition (s)": professional?.mobilityDelaySec == null ? "" : numericCell(professional.mobilityDelaySec),
      "Dominance P50 (dB)": numericCell(item?.dominance?.p50),
      "Dominance P10 (dB)": numericCell(item?.dominance?.p10),
      "Dominance <3 dB (%)": numericCell(item?.dominance?.weakPct),
      "Voisin meilleur (%)": numericCell(item?.dominance?.neighborBetterPct),
      "Voisin meilleur +6 dB (%)": numericCell(item?.dominance?.neighborBetter6Pct),
      "Disponibilité NR / perte": item?.type === "NR_AVAILABILITY_LOSS" ? "NR→LTE-only→NR" : "",
      "Contexte ancre LTE": (item?.anchorContext?.evidence || []).join(" | "),
      "Géométrie BDD": (item?.geometry?.evidence || []).join(" | "),
      "Overshooting probable": item?.geometry?.overshooting ? "Oui" : "Non",
      "Erreur orientation probable": item?.geometry?.orientationIssue ? "Oui" : "Non",
      "Code RCA": rca.code || "",
      "Diagnostic RCA": professional?.probableCause || rca.label || "",
      "Confiance RCA (/100)": professional?.rcaConfidence ?? item?.confidenceDetail?.score ?? "",
      "Qualité données (/100)": item?.dataQuality?.score ?? "",
      "Couverture mesures serving (%)": item?.dataQuality?.servingMeasurementCoveragePct ?? "",
      "Couverture mesures voisines (%)": item?.dataQuality?.neighborMeasurementCoveragePct ?? "",
      "Comparaisons voisines": item?.dataQuality?.comparableNeighborSamples ?? "",
      "Continuité GPS": item?.dataQuality?.gpsContinuity ?? "",
      "Continuité temps": item?.dataQuality?.timeContinuity ?? "",
      "Référence NR": item?.dataQuality?.nrMeasurementReference ?? "",
      "RRC disponible": item?.dataQuality?.rrcAvailable ? "Oui" : "Non",
      "Scanner disponible": item?.dataQuality?.scannerAvailable ? "Oui" : "Non",
      "Niveau confiance": professional?.rcaConfidenceLabel || item?.confidenceDetail?.label || item?.confidence || "",
      "Détail confiance": JSON.stringify(item?.confidenceDetail?.components || {}),
      "Détail priorité": JSON.stringify(item?.priority?.components || {}),
      "Récurrence (%)": item?.recurrence?.available ? numericCell(item.recurrence.score) : "",
      "Passages affectés / éligibles": item?.recurrence?.available ? `${item.recurrence.affectedPassages}/${item.recurrence.eligiblePassages}` : "",
      "Analyse radio professionnelle": professionalAnalysis(item),
      "Analyse Optim": item.optimAnalysis?.text || "Analyse Optim non calculée.",
      "Preuves RCA": professional?.rcaEvidence?.join(" | ") || (rca.evidence || []).join(" | "),
      "Contexte RCA": contextsFor(item).map((entry) => `${entry.label}${entry.evidence ? `: ${entry.evidence}` : ""}`).join(" | "),
      "Voisins mesurés": rca.radioContext?.distinctNeighborCount ?? "",
      "Meilleur voisin mesuré": neighbor.cellName || "",
      "RSRP voisin P50 (dBm)": numericCell(neighbor.rsrp?.median),
      "Présence voisin (%)": Number.isFinite(Number(neighbor.presenceRatio)) ? numericCell(neighbor.presenceRatio * 100) : "",
      "Action recommandée": professionalAction(item),
      "Lignes sources": (item?.sourceRows || []).join(","),
    };
  };
  const macroRow = (item) => ({
    "Macro Zone ID": item?.id || "",
    RAT: item?.rat || "",
    Début: item?.startTime || "",
    Fin: item?.endTime || "",
    "GPS début": Number.isFinite(Number(item?.start?.lat)) ? `${Number(item.start.lat).toFixed(6)}, ${Number(item.start.lng).toFixed(6)}` : "",
    "GPS fin": Number.isFinite(Number(item?.end?.lat)) ? `${Number(item.end.lat).toFixed(6)}, ${Number(item.end.lng).toFixed(6)}` : "",
    "Micro-zones": item?.microZoneCount ?? "",
    "IDs micro-zones": (item?.childZoneIds || []).join(" | "),
    "Snapshots dégradés": item?.degradedSnapshotCount ?? "",
    "Distance dégradée (m)": numericCell(item?.degradedDistanceM),
    "Score priorité": item?.priorityScore ?? "",
  });
  const radioWorkbookPayload = (log, meta = exportMetaFor(log)) => {
    applyProfessionalReport(log, meta);
    const selected = validatedRows(log);
    const summaryHeaders = ["Date du parcours", "Type de test", "Nom de la plaque", "Nature de problème", "Description du problème", "Analyse radio professionnelle", "Action recommandée courte", "Action recommandée détaillée", "Dominant Serving Name", "Dominant Serving CI", "Niveau de signal", "Qualité du signal", "Coordonnées X", "Coordonnées Y", "Nom du logfile de parcours", "Analyse Optim"];
    const auditHeaders = ["Incident ID", "Décision", "RAT", "Statut mobilité", "Rang", "Rang priorité", "Score priorité", "Type", "Début", "Fin", "Serving dominant", "Rôle Serving", "Serving PCI", "Canal Serving", "Bande Serving", "Source nom Serving", "RSRP P50 (dBm)", "RSRP P10 (dBm)", "SINR P50 (dB)", "SINR P10 (dB)", "Points", "Snapshots canoniques", "Densité dégradée (%)", "Snapshots critiques (%)", "Durée (s)", "Distance (m)", "Déplacement net (m)", "Vitesse moyenne (m/s)", "Changements Serving", "Changements/min", "Changements/km", "Anomalies mobilité", "Dominance P50 (dB)", "Dominance P10 (dB)", "Dominance <3 dB (%)", "Voisin meilleur (%)", "Voisin meilleur +6 dB (%)", "Disponibilité NR / perte", "Contexte ancre LTE", "Géométrie BDD", "Overshooting probable", "Erreur orientation probable", "Code RCA", "Diagnostic RCA", "Confiance RCA (/100)", "Niveau confiance", "Détail confiance", "Détail priorité", "Récurrence (%)", "Passages affectés / éligibles", "Analyse radio professionnelle", "Preuves RCA", "Contexte RCA", "Voisins mesurés", "Meilleur voisin mesuré", "RSRP voisin P50 (dBm)", "Présence voisin (%)", "Action recommandée", "Lignes sources", "Analyse Optim"];
    const macroHeaders = ["Macro Zone ID", "RAT", "Début", "Fin", "GPS début", "GPS fin", "Micro-zones", "IDs micro-zones", "Snapshots dégradés", "Distance dégradée (m)", "Score priorité"];
    const professionalExport = typeof root.RadioProfessionalReport?.exportModel === "function"
      ? root.RadioProfessionalReport.exportModel(log?.radioDegradationAnalysis, meta)
      : { executive: log?.radioDegradationAnalysis?.professionalReport || {}, incidentsDrive: [], rca: [], stationary: [], topIncidents: [] };
    const incidentsDriveHeaders = ["ID", "Priorité", "Score priorité", "Technologie", "Bande", "Serving", "PCI", "Fréquence", "Type problème", "Sévérité", "Début", "Fin", "Durée (s)", "Distance (m)", "Snapshots dégradés", "Snapshots canoniques", "% dégradé", "RSRP P50 (dBm)", "RSRP P10 (dBm)", "SINR P50 (dB)", "SINR P10 (dB)", "Description du problème", "Analyse DT", "RCA détaillée", "Cause probable", "Confiance RCA", "Score confiance RCA", "Preuves RCA", "Limite RCA", "Action recommandée", "Drive / Stationary", "Symptôme", "Score sévérité", "Score persistance", "Impact utilisateur", "MOS P50", "MOS P10", "Impact MOS", "Débit DL P50", "Niveau preuve", "Vérification", "Analyse Optim"];
    const rcaHeaders = ["ID", "Priorité", "Technologie", "Bande", "Serving", "Code RCA", "Cause probable", "Confiance RCA", "Score confiance RCA", "Preuves RCA", "Limite RCA", "Voisins mesurés", "Voisins récurrents", "Dominance P50 (dB)", "Dominance P10 (dB)", "Dominance <=3 dB (%)", "Voisin meilleur (%)", "Changements serving", "Action", "Niveau preuve", "Vérification"];
    const mobilityHeaders = ["Mobilité source", "Mobilité cible", "Écart voisin P50 (dB)", "Délai avant transition (s)",
      "RCA voisinage / mobilité", "Top 3 voisines"];
    incidentsDriveHeaders.push(...mobilityHeaders);
    rcaHeaders.push(...mobilityHeaders, "RCA détaillée", "Analyse Optim");
    auditHeaders.push("Mobilité cellule source", "Mobilité meilleure voisine", "Écart voisin P50 (dB)", "Délai avant transition (s)");
    return {
      title: `Dégradations radio validées — ${meta.logfile || log?.name || "Export radio"}`,
      executive: professionalExport.executive || {},
      topIncidentRows: professionalExport.topIncidents || [],
      incidentsDriveHeaders,
      incidentsDriveRows: professionalExport.incidentsDrive || [],
      rcaHeaders,
      rcaRows: professionalExport.rca || [],
      stationaryHeaders: incidentsDriveHeaders,
      stationaryRows: professionalExport.stationary || [],
      summaryHeaders,
      summaryRows: selected.map((item) => approvedSummaryRow(item, meta)),
      auditHeaders,
      auditRows: analysisRows(log).map(auditRow),
      macroHeaders,
      macroRows: (log?.radioDegradationAnalysis?.macroZones || []).map(macroRow),
      selectedCount: selected.length,
    };
  };
  const buildRadioWorkbook = (xlsx, log, meta = exportMetaFor(log)) => {
    const payload = radioWorkbookPayload(log, meta);
    const workbook = xlsx.utils.book_new();
    const summarySheet = xlsx.utils.json_to_sheet(payload.summaryRows, { header: payload.summaryHeaders });
    summarySheet["!cols"] = [14, 14, 36, 18, 56, 72, 58, 78, 42, 12, 18, 19, 16, 16, 38, 75].map((wch) => ({ wch }));
    const auditSheet = xlsx.utils.json_to_sheet(payload.auditRows, { header: payload.auditHeaders });
    auditSheet["!cols"] = payload.auditHeaders.map((header) => ({ wch: /Analyse|Preuves|Contexte|Action|Géométrie|Détail/.test(header) ? 58 : /Serving|Voisin|Mobilité|Disponibilité/.test(header) ? 32 : 17 }));
    const macroSheet = xlsx.utils.json_to_sheet(payload.macroRows, { header: payload.macroHeaders });
    macroSheet["!cols"] = [20, 9, 24, 24, 24, 24, 14, 48, 20, 22, 16].map((wch) => ({ wch }));
    const executiveRows = [
      { "Indicateur": "Titre", "Valeur": payload.executive?.title || "Executive Summary — Dégradations Radio 4G/5G" },
      { "Indicateur": "Logfile", "Valeur": payload.executive?.meta?.logfile || meta.logfile || "" },
      { "Indicateur": "Synthèse", "Valeur": payload.executive?.narrative || "Aucune synthèse professionnelle disponible." },
      ...(payload.executive?.cards || []).map(([label, value]) => ({ "Indicateur": label, "Valeur": value })),
      ...(payload.executive?.recommendedActions || []).map((value) => ({ "Indicateur": "Action prioritaire", "Valeur": value })),
    ];
    const executiveSheet = xlsx.utils.json_to_sheet(executiveRows, { header: ["Indicateur", "Valeur"] });
    executiveSheet["!cols"] = [{ wch: 30 }, { wch: 120 }];
    const driveSheet = xlsx.utils.json_to_sheet(payload.incidentsDriveRows, { header: payload.incidentsDriveHeaders });
    driveSheet["!cols"] = payload.incidentsDriveHeaders.map((header) => ({ wch: /Description|Analyse|Cause|Preuves|Limite|Action/.test(header) ? 58 : /Serving|Bande/.test(header) ? 32 : 17 }));
    const rcaSheet = xlsx.utils.json_to_sheet(payload.rcaRows, { header: payload.rcaHeaders });
    rcaSheet["!cols"] = payload.rcaHeaders.map((header) => ({ wch: /Cause|Preuves|Limite|Action/.test(header) ? 58 : /Serving|Bande/.test(header) ? 32 : 17 }));
    const stationarySheet = xlsx.utils.json_to_sheet(payload.stationaryRows, { header: payload.stationaryHeaders });
    stationarySheet["!cols"] = driveSheet["!cols"];
    xlsx.utils.book_append_sheet(workbook, executiveSheet, "Executive Summary");
    xlsx.utils.book_append_sheet(workbook, driveSheet, "Incidents Drive");
    xlsx.utils.book_append_sheet(workbook, rcaSheet, "Analyse RCA");
    xlsx.utils.book_append_sheet(workbook, stationarySheet, "Preuves stationnaires");
    xlsx.utils.book_append_sheet(workbook, summarySheet, "Synthèse incidents");
    xlsx.utils.book_append_sheet(workbook, auditSheet, "Audit technique");
    xlsx.utils.book_append_sheet(workbook, macroSheet, "Macro RCA Zones");
    return { workbook, selectedCount: payload.selectedCount, payload };
  };
  const updateApprovalStatus = (log, modal) => {
    const count = validatedRows(log).length;
    const status = modal?.querySelector("#radioApprovalStatus");
    const counter = modal?.querySelector("#radioApprovedCount");
    if (status) status.textContent = count
      ? `${count} dégradation(s) validée(s) : elles seront ajoutées à la feuille « Synthèse incidents » à l’export.`
      : "Validez une ou plusieurs dégradations pour alimenter la feuille « Synthèse incidents ».";
    if (counter) counter.textContent = String(count);
  };
  const exportWorkbook = async (log, modal) => {
    if (!root.XLSX || !log?.radioDegradationAnalysis) return;
    const meta = updateRadioExportMeta(log, modal);
    await prepareOptim(log);
    const result = buildRadioWorkbook(root.XLSX, log, meta);
    if (!result.selectedCount) {
      root.alert?.("Validez au moins une dégradation avant l’export XLSX.");
      return;
    }
    const safeName = String(meta.logfile || log.name || "radio").replace(/[\\/:*?\"<>|]+/g, "_");
    const filename = `${safeName}_degradations_radio_validees.xlsx`;
    try {
      const response = await root.fetch("/api/radio-degradations/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...result.payload, filename }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (error) {
      console.warn("Professional radio workbook export unavailable; using local XLSX fallback.", error);
      root.XLSX.writeFile(result.workbook, filename);
      root.alert?.(`Export professionnel indisponible (${error.message}). Un fichier compatible non stylé a été généré.`);
    }
  };

  // COP: pre-detection popup — choose LTE/NR thresholds, then launch.
  root.showRadioDetectionSetup = (logId) => {
    const log = getLog(logId);
    if (!log) return;
    const previous = document.getElementById("radioDetectionSetupModal");
    if (previous) previous.remove();
    const defaults = root.RadioDegradationAnalyzer?.DEFAULT_PROFILES || {};
    const num = (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const modal = document.createElement("div");
    modal.id = "radioDetectionSetupModal";
    modal.className = "modal";
    modal.style.display = "block";
    const field = (id, label, value, step) =>
      `<label style="font-size:11px;color:#94a3b8;">${label}<input id="${id}" type="number" step="${step}" value="${value}" style="display:block;width:100%;margin-top:4px;box-sizing:border-box;padding:6px 7px;border:1px solid #475569;border-radius:4px;background:#111827;color:#f8fafc;"></label>`;
    modal.innerHTML = `
      <div class="modal-content glass-modal-content" style="max-width:420px;">
        <div class="modal-header glass-modal-header">
          <h3>Détection LTE / NR</h3>
          <span class="close" data-setup-close style="cursor:pointer;">&times;</span>
        </div>
        <div class="modal-body glass-modal-body">
          <p class="form-hint" style="margin-bottom:10px;">Seuils de détection automatique pour <b>${escapeHtml(log.name || "")}</b></p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            ${field("radioSetupLteRsrp", "LTE RSRP ≤ (dBm)", num(defaults.lte?.coverageEntryDbm, -105), "0.5")}
            ${field("radioSetupLteSinr", "LTE SINR ≤ (dB)", num(defaults.lte?.sinrEntryDb, 0), "0.5")}
            ${field("radioSetupNrRsrp", "NR RSRP ≤ (dBm)", num(defaults.nr?.coverageEntryDbm, -105), "0.5")}
            ${field("radioSetupNrSinr", "NR SINR ≤ (dB)", num(defaults.nr?.sinrEntryDb, 0), "0.5")}
            ${field("radioSetupMos", "MOS < (seuil)", 3.5, "0.1")}
            ${field("radioSetupMinPoints", "Points dégradés min.", num(defaults.lte?.minDegradedSnapshots, 5), "1")}
          </div>
          <div id="radioSetupStatus" style="font-size:11px;color:#94a3b8;margin-top:10px;"></div>
          <div class="editor-footer" style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn" data-setup-close>Annuler</button>
            <button class="btn btn-green" data-setup-launch>Lancer la détection</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    // Moveable popup (drag by header).
    try {
      const dragHeader = modal.querySelector(".modal-header");
      const dragContent = modal.querySelector(".modal-content");
      if (dragHeader && dragContent && typeof window.makeElementDraggable === "function") {
        window.makeElementDraggable(dragHeader, dragContent);
      }
    } catch (_) {}
    modal.querySelectorAll("[data-setup-close]").forEach((btn) => {
      btn.onclick = () => modal.remove();
    });
    modal.querySelector("[data-setup-launch]").onclick = async () => {
      const val = (id) => modal.querySelector("#" + id).value;
      const min = Math.max(1, Number(val("radioSetupMinPoints")) || 5);
      const status = modal.querySelector("#radioSetupStatus");
      const launchBtn = modal.querySelector("[data-setup-launch]");
      const tracker = window.ProgressTracker;
      const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
      if (status) status.textContent = "Détection en cours…";
      if (launchBtn) launchBtn.disabled = true;
      try {
        tracker?.show("Détection automatique radio", log.name || "");
        tracker?.update(6, "Lecture des points…");
        await frame();
        const previousAnalysis = log.radioDegradationAnalysis;
        tracker?.update(20, "Snapshots radio…");
        await frame();
        const next = root.RadioDegradationAnalyzer.analyze(log.points, { profiles: {
          lte: { coverageEntryDbm: val("radioSetupLteRsrp"), sinrEntryDb: val("radioSetupLteSinr"), minDegradedSnapshots: min },
          nr: { coverageEntryDbm: val("radioSetupNrRsrp"), sinrEntryDb: val("radioSetupNrSinr"), minDegradedSnapshots: min },
          mos: { degraded: Number(val("radioSetupMos")) || 3.5 },
        } });
        tracker?.update(55, `Incidents détectés : ${(next.summary?.lteCandidates || 0) + (next.summary?.nrCandidates || 0)} radio, ${next.summary?.mosCandidates || 0} MOS…`);
        await frame();
        preserveReviewStates(previousAnalysis, next);
        next.viewFilters = { ...(previousAnalysis?.viewFilters || {}), minPoints: min };
        log.radioDegradationAnalysis = next;
        try {
          const s = next.summary || {};
          console.info("[COP detection]", `incidents=${(next.incidents || []).length}`,
            `LTE=${s.lteCandidates} NR=${s.nrCandidates} MOS=${s.mosCandidates} TPUT=${s.throughputCandidates} MOB=${s.mobilityCandidates}`,
            `stationary=${(s.lteStationaryFindings || 0) + (s.nrStationaryFindings || 0)}`);
        } catch (_) {}
        enrichServingNamesFromBdd(next);
        refreshCampaignRecurrence();
        tracker?.update(80, "Rapport professionnel…");
        await frame();
        applyProfessionalReport(log, exportMetaFor(log));
        root.updateLogsList?.();
        modal.remove();
        await tracker?.complete("Détection terminée");
        root.showRadioDegradationAnalysis(log.id);
      } catch (error) {
        tracker?.hide();
        if (status) status.textContent = "Échec de la détection : " + (error?.message || error);
        if (launchBtn) launchBtn.disabled = false;
      }
    };
  };

  root.showRadioDegradationAnalysis = (logId) => {
    const log = getLog(logId);
    if (!log || !root.RadioDegradationAnalyzer) return;
    if (
      !log.radioDegradationAnalysis ||
      log.radioDegradationAnalysis.version !== root.RadioDegradationAnalyzer.VERSION
    ) {
      log.radioDegradationAnalysis = root.RadioDegradationAnalyzer.analyze(log.points);
    }
    if (!log.radioDegradationAnalysis) return;
    const analysis = log.radioDegradationAnalysis;
    enrichServingNamesFromBdd(analysis);
    refreshCampaignRecurrence();
    const exportMeta = exportMetaFor(log);
    applyProfessionalReport(log, exportMeta);
    const modal = ensureModal();
    modal.style.display = "block";
    if (modal.querySelector(".modal-content")?.classList.contains("is-minimized")) {
      modal.querySelector("#radioDegradationMinimize")?.click();
    }
    const profiles = analysis.profiles || {};
    const filters = filtersFor(log);
    const q = (id) => modal.querySelector(id);
    q("#radioDegradationTitle").textContent = `Analyse automatique radio 4G/5G + MOS — ${log.name}`;
    q("#radioLteRsrp").value = profiles.lte?.coverageEntryDbm ?? -105;
    q("#radioLteSinr").value = profiles.lte?.sinrEntryDb ?? 0;
    q("#radioNrRsrp").value = profiles.nr?.coverageEntryDbm ?? -105;
    q("#radioNrSinr").value = profiles.nr?.sinrEntryDb ?? 0;
    q("#radioMinPoints").value = profiles.lte?.minDegradedSnapshots ?? 5;
    q("#radioMosThreshold").value = profiles.mos?.degraded ?? 3.5;
    q("#radioProfileEnvironment").value = analysis.profileContext?.environment || "";
    q("#radioProfilePurpose").value = analysis.profileContext?.purpose || "";
    q("#radioProfileBand").value = analysis.profileContext?.band || "";
    q("#radioProfileSampling").value = analysis.profileContext?.samplingRate || "";
    q("#radioFilterLte").checked = !!filters.lte;
    q("#radioFilterNr").checked = !!filters.nr;
    q("#radioFilterCoverage").checked = !!filters.coverage;
    q("#radioFilterSinr").checked = !!filters.sinr;
    q("#radioFilterAvailability").checked = !!filters.availability;
    q("#radioFilterMobility").checked = !!filters.mobility;
    q("#radioFilterMos").checked = !!filters.mos;
    q("#radioFilterMosCorrelated").checked = !!filters.mosCorrelated;
    q("#radioFilterThroughput").checked = !!filters.throughput;
    fillFilterOptions(modal, log);
    q("#radioFilterScope").value = filters.scope || "drive";
    q("#radioFilterBand").value = filters.band || "all";
    q("#radioFilterPriority").value = filters.priority || "all";
    q("#radioFilterIssue").value = filters.issue || "all";
    q("#radioFilterRca").value = filters.rca || "all";
    q("#radioFilterConfidence").value = filters.confidence || "all";
    q("#radioFilterMinPoints").value = filters.minPoints;
    q("#radioFilterTop").value = filters.top;
    q("#radioDegradationDate").value = exportMeta.date || "";
    q("#radioDegradationTestType").value = exportMeta.testType || "Radio 4G/5G";
    q("#radioDegradationPlaque").value = exportMeta.plaque || "";
    q("#radioDegradationLogfile").value = exportMeta.logfile || log.name || "";
    const enrichment = analysis.servingNameEnrichment || {};
    const summary = analysis.summary || {};
    const stationaryCount = Number(summary.lteStationaryFindings || 0) + Number(summary.nrStationaryFindings || 0);
    q("#radioDetectionStatus").textContent = enrichment.resolvedCount
      ? `${enrichment.resolvedCount} nom(s) Serving résolu(s) depuis la BDD par RAT, PCI, fréquence et proximité. ${stationaryCount} constat(s) stationnaire(s) sont exclus du classement par défaut.`
      : `Un seul serving primaire par instant : NR PSCell prioritaire, ancre LTE gardée en contexte. ${summary.mosCandidates || 0} incident(s) MOS. ${stationaryCount} constat(s) stationnaire(s) exclus du classement Drive.`;
    renderExecutiveSummary(log, modal);
    const macroZones = analysis.macroZones || [];
    void macroZones;
    q("#radioMacroZones").innerHTML = "";
    q("#radioMacroZones").style.display = "none";

    const renderRows = () => {
      const rows = filteredRows(log);
      // Keep the summary cards aligned with the filtered list (e.g. Min. points).
      try {
        const scoped = root.RadioProfessionalReport && typeof root.RadioProfessionalReport.executiveFor === "function"
          ? root.RadioProfessionalReport.executiveFor(rows.map((item) => ({ ...item, professional: professionalFor(item) || item.professional })), exportMetaFor(log))
          : null;
        if (scoped && Array.isArray(scoped.cards)) {
          q("#radioDegradationSummary").innerHTML = scoped.cards.map(([label, value]) => summaryCard(label, value, /Passage|Nombre/.test(label) ? "#fb7185" : /5G|NR/.test(label) ? "#a78bfa" : "#67e8f9")).join("");
        }
      } catch (_) {}
      renderTimeline(modal, analysis, rows[0]);
      const incidentShortId = (it) => {
        const idx = (analysis.incidents || []).indexOf(it);
        return "D" + String(idx + 1).padStart(3, "0");
      };
      q("#radioDegradationRows").innerHTML = rows.map((item) => {
        const professional = professionalFor(item) || {};
        const decision = item.reviewState || "candidate";
        const color = typeColor(item);
        const priorityRank = Number(item.priorityRank);
        const priority = Number.isInteger(priorityRank) && priorityRank > 0
          ? `${professional.priorityClass || `P#${priorityRank}`} · ${professional.priorityScore ?? item.priorityScore}`
          : (item.stationary ? "Preuve locale" : (professional.priorityClass || "Hors classement Drive"));
        const contexts = contextsFor(item);
        const neighborRca = item.neighborMobilityRca;
        const neighborDetail = neighborRca ? `<div style="border-top:1px solid #334155;margin-top:6px;padding-top:5px;color:#93c5fd;">
          <b>RCA voisinage / mobilité : ${escapeHtml(neighborRca.type)}</b><br>
          <span style="color:#e2e8f0;">Faits : ${escapeHtml(neighborRca.facts.join(" "))}</span><br>
          <span style="color:#c4b5fd;">Hypothèse : ${escapeHtml(neighborRca.hypothesis)}</span><br>
          <span style="color:#fbbf24;">À vérifier : ${escapeHtml(neighborRca.verification.join(" "))}</span><br>
          <span style="color:#94a3b8;">Top 3 : ${escapeHtml(neighborRca.topCandidates.map((candidate) =>
            `${candidate.cellName} (${candidate.class}, ΔP50 ${number(candidate.delta.p50)} dB, présence dégradée ${number(candidate.degradedPresencePct)} %, avantage ${number(candidate.longestBetter.durationSec)} s)`).join(" ; ") || "aucune")}</span>
        </div>` : "";
        const scanDetail = item.scanOverlap?.best ? `<div style="border-top:1px solid #7f1d1d;margin-top:6px;padding-top:6px;color:#fca5a5;">
          <b>Scan Route ∩ dégradation :</b> ${number(item.scanOverlap.best.overlapPct)} % des snapshots dégradés · ${item.scanOverlap.best.degradedSnapshotCount} snapshots communs · ${item.scanOverlap.best.maxStrongCells} cellules fortes sur ${escapeHtml(item.rat === "NR" ? "NR-ARFCN" : "EARFCN")} ${escapeHtml(item.scanOverlap.best.channel)}.
          <span style="color:#cbd5e1;">${escapeHtml(item.scanOverlap.rca.hypothesis)}</span>
          <button type="button" data-scan-deep style="margin-left:8px;padding:3px 8px;border:1px solid #f87171;border-radius:5px;background:#7f1d1d;color:#fff;cursor:pointer;">Deep Analysis · portion commune</button>
        </div>` : "";
        const coexistenceDetail = item.crossRatCoexistence?.length
          ? `<div style="margin-top:5px;color:#67e8f9;">LTE + NR simultanés : ${item.crossRatCoexistence.length} portion(s) ; chaque couche conserve sa RCA propre.</div>` : "";
        const actionStyle = (state, background) => `padding:3px 5px;border:1px solid ${decision === state ? "#f8fafc" : "transparent"};border-radius:4px;background:${background};color:#fff;font-size:10px;cursor:pointer;`;
        const isSelRow = item.id === selectedRadioRowId;
        const isValRow = item.reviewState === "validated";
        const rowHi = isSelRow ? "background:rgba(59,130,246,0.22);box-shadow:inset 3px 0 0 #3b82f6;" : (isValRow ? "background:rgba(21,128,61,0.20);box-shadow:inset 3px 0 0 #22c55e;" : "");
        return `<tr data-radio-id="${escapeHtml(item.id)}" style="cursor:pointer;border-top:1px solid #263244;${rowHi}">
          <td style="padding:8px;white-space:nowrap;font-weight:700;color:#93c5fd;">${escapeHtml(incidentShortId(item))}</td>
          <td style="padding:8px;white-space:nowrap;"><button data-decision="validated" style="${actionStyle("validated", "#15803d")}">Valider</button></td>
          <td style="padding:8px;color:${color};font-weight:700;">${escapeHtml(professional.issueFrenchLabel || typeLabel(item.type))}<div style="font-size:10px;color:#94a3b8;margin-top:3px;">${escapeHtml(professional.severity || "Dégradation radio")}${item.stationary ? " · Stationnaire / faible mobilité" : ""}</div></td>
          <td style="padding:8px;white-space:nowrap;">${escapeHtml(item.startTime || "—")}</td>
          <td style="padding:8px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(professional.servingCell || item.dominantServing?.cellName || "")}">${escapeHtml(professional.servingCell || item.dominantServing?.cellName || "Non résolu")}<div style="font-size:10px;color:#94a3b8;">${escapeHtml(professional.servingRole || item.dominantServing?.role || "Serving")}${item.dominantServing?.nameSource === "bdd" ? " · BDD (PCI/freq/proximité)" : " · source DT"}</div></td>
          <td style="padding:8px;text-align:center;white-space:nowrap;">${escapeHtml(professional.band || item.band || "—")}<div style="font-size:10px;color:#94a3b8;">${professional.frequency ?? item.channel ?? "—"}</div></td>
          <td style="padding:8px;min-width:520px;max-width:680px;vertical-align:top;"><div style="color:#a7f3d0;white-space:pre-wrap;">${escapeHtml(item.optimAnalysis?.executiveSummary || "Analyse Optim en préparation…")}</div><div><button data-optim-edit style="margin-top:6px;font-size:10px;padding:2px 9px;border-radius:5px;background:rgba(59,130,246,0.16);border:1px solid rgba(147,197,253,0.4);color:#bfdbfe;cursor:pointer;">✎ Modifier</button></div></td>
          <td style="padding:8px;text-align:center;white-space:nowrap;">P50 ${number(item.dominance?.p50)} dB<div style="font-size:10px;color:#94a3b8;">&lt;3 dB ${number(item.dominance?.weakPct)}% · voisin +6 ${number(item.dominance?.neighborBetter6Pct)}%</div></td>
          <td style="padding:8px;text-align:right;white-space:nowrap;">${number(item.metrics?.rsrp?.median)} / ${number(item.metrics?.rsrp?.p10)} dBm</td>
          <td style="padding:8px;text-align:right;white-space:nowrap;">${number(item.metrics?.sinr?.median)} / ${number(item.metrics?.sinr?.p10)} dB</td>
          <td style="padding:8px;text-align:right;white-space:nowrap;">${number(item.mos?.median, 2)} / ${number(item.mos?.p10, 2)}</td>
          <td style="padding:8px;text-align:right;font-weight:800;">${item.sampleCount}</td><td style="padding:8px;text-align:right;">${Math.round(item.distanceM || 0)} m</td>
        </tr>`;
      }).join("") || '<tr><td colspan="14" style="padding:18px;text-align:center;color:#94a3b8;">Aucun segment ne correspond aux filtres actuels.</td></tr>';
      q("#radioDegradationRows").querySelectorAll("tr[data-radio-id]").forEach((row) => {
        const incident = analysisRows(log).find((item) => item.id === row.dataset.radioId);
        row.onclick = (event) => {
          if (event.target?.closest("button[data-scan-deep]") && incident) {
            openScanDeepAnalysis(log, incident);
            return;
          }
          // Inline Analyse Optim editor (writes through to the incident).
          const editBtn = event.target?.closest("button[data-optim-edit]");
          if (editBtn && incident && incident.optimAnalysis) {
            const cell = editBtn.closest("td");
            const current = incident.optimAnalysis.executiveSummary || "";
            cell.innerHTML = `<textarea data-optim-text style="width:100%;box-sizing:border-box;min-height:90px;font-size:11px;padding:6px;border-radius:5px;border:1px solid #475569;background:#0f172a;color:#e5e7eb;">${escapeHtml(current)}</textarea>
              <div style="margin-top:5px;display:flex;gap:6px;"><button data-optim-save style="font-size:10px;padding:2px 10px;border-radius:5px;background:#15803d;border:1px solid #16a34a;color:#fff;cursor:pointer;">Enregistrer</button><button data-optim-cancel style="font-size:10px;padding:2px 10px;border-radius:5px;background:#374151;border:1px solid #4b5563;color:#e5e7eb;cursor:pointer;">Annuler</button></div>`;
            const area = cell.querySelector("textarea[data-optim-text]");
            if (area) { area.focus(); area.setSelectionRange(area.value.length, area.value.length); }
            return;
          }
          const saveBtn = event.target?.closest("button[data-optim-save]");
          if (saveBtn && incident && incident.optimAnalysis) {
            const area = row.querySelector("textarea[data-optim-text]");
            const value = String(area ? area.value : "").trim() || "Analyse Optim non calculée.";
            incident.optimAnalysis.executiveSummary = value;
            incident.optimExecOverride = value;
            renderRows();
            return;
          }
          if (event.target?.closest("button[data-optim-cancel]")) {
            renderRows();
            return;
          }
          const decisionButton = event.target?.closest("button[data-decision]");
          if (decisionButton && incident) {
            incident.reviewState = incident.reviewState === "validated" ? "candidate" : "validated";
            updateApprovalStatus(log, modal);
            renderRows();
            return;
          }
          if (incident) {
            selectedRadioRowId = incident.id;
            const tbodyEl = row.closest("tbody");
            if (tbodyEl) {
              tbodyEl.querySelectorAll("tr[data-radio-id]").forEach((other) => {
                const otherInc = analysisRows(log).find((x) => x.id === other.dataset.radioId);
                paintRadioRowState(other, otherInc);
              });
            }
            renderTimeline(modal, analysis, incident);
            focusRow(log, incident);
            root.requestAnimationFrame?.(() => arrangeReviewLayout(modal));
          }
        };
      });
    };
    const refreshFilters = () => {
      Object.assign(filters, {
        lte: q("#radioFilterLte").checked,
        nr: q("#radioFilterNr").checked,
        coverage: q("#radioFilterCoverage").checked,
        sinr: q("#radioFilterSinr").checked,
        availability: q("#radioFilterAvailability").checked,
        mobility: q("#radioFilterMobility").checked,
        mos: q("#radioFilterMos").checked,
        mosCorrelated: q("#radioFilterMosCorrelated").checked,
        throughput: q("#radioFilterThroughput").checked,
        scope: q("#radioFilterScope").value,
        band: q("#radioFilterBand").value,
        priority: q("#radioFilterPriority").value,
        issue: q("#radioFilterIssue").value,
        rca: q("#radioFilterRca").value,
        confidence: q("#radioFilterConfidence").value,
        minPoints: Math.max(1, Number(q("#radioFilterMinPoints").value) || 1),
        top: q("#radioFilterTop").value,
      });
      renderRows();
    };
    ["#radioFilterLte", "#radioFilterNr", "#radioFilterCoverage", "#radioFilterSinr", "#radioFilterAvailability", "#radioFilterMobility", "#radioFilterMos", "#radioFilterMosCorrelated", "#radioFilterThroughput", "#radioFilterScope", "#radioFilterBand", "#radioFilterPriority", "#radioFilterIssue", "#radioFilterRca", "#radioFilterConfidence", "#radioFilterMinPoints", "#radioFilterTop"].forEach((selector) => { q(selector).onchange = refreshFilters; });
    // Min. points reacts while typing (change alone needs blur/Enter).
    const minPointsInput = q("#radioFilterMinPoints");
    if (minPointsInput) {
      let minPointsTimer = null;
      minPointsInput.addEventListener("input", () => {
        if (minPointsTimer) clearTimeout(minPointsTimer);
        minPointsTimer = setTimeout(refreshFilters, 350);
      });
    }
    // Detection "Points dégradés min." drives the display "Min. points" filter.
    const detMinPointsInput = q("#radioMinPoints");
    if (detMinPointsInput) {
      let detMinTimer = null;
      const syncDetMinToFilter = () => {
        const target = q("#radioFilterMinPoints");
        if (target && target.value !== detMinPointsInput.value) {
          target.value = detMinPointsInput.value;
          refreshFilters();
        }
      };
      detMinPointsInput.addEventListener("change", syncDetMinToFilter);
      detMinPointsInput.addEventListener("input", () => {
        if (detMinTimer) clearTimeout(detMinTimer);
        detMinTimer = setTimeout(syncDetMinToFilter, 400);
      });
    }
    q("#radioShowMap").onclick = () => { refreshFilters(); showRadioSegmentsOnMap(log); };
    ["#radioDegradationDate", "#radioDegradationTestType", "#radioDegradationPlaque", "#radioDegradationLogfile"].forEach((selector) => {
      q(selector).oninput = () => updateRadioExportMeta(log, modal);
    });
    q("#radioExport").onclick = () => exportWorkbook(log, modal);
    q("#radioDtCopExport").onclick = async () => {
      const button = q("#radioDtCopExport");
      if (!root.RadioDtCopExport || button.disabled) return;
      button.disabled = true;
      button.textContent = "Génération…";
      try {
        await root.RadioDtCopExport.download(log, updateRadioExportMeta(log, modal));
      } catch (error) {
        console.error("Analyse DT COP export failed", error);
        root.alert?.(`Export Analyse DT COP impossible : ${error.message}`);
      } finally {
        button.disabled = false;
        button.textContent = "Exporter Analyse DT COP";
      }
    };
    q("#radioCellStatisticsExport").onclick = async () => {
      const button = q("#radioCellStatisticsExport");
      if (!root.RadioCellStatisticsExport || button.disabled) return;
      button.disabled = true;
      button.textContent = "Génération…";
      try {
        await root.RadioCellStatisticsExport.download(log);
      } catch (error) {
        console.error("Synthèse DT par cellule export failed", error);
        root.alert?.(`Export synthèse DT par cellule impossible : ${error.message}`);
      } finally {
        button.disabled = false;
        button.textContent = "Exporter synthèse DT par cellule";
      }
    };
    q("#radioRecalculate").onclick = () => {
      const previous = log.radioDegradationAnalysis;
      const min = Math.max(1, Number(q("#radioMinPoints").value) || 5);
      const profilesRequest = {
        lte: { coverageEntryDbm: q("#radioLteRsrp").value, sinrEntryDb: q("#radioLteSinr").value, minDegradedSnapshots: min },
        nr: { coverageEntryDbm: q("#radioNrRsrp").value, sinrEntryDb: q("#radioNrSinr").value, minDegradedSnapshots: min },
      };
      profilesRequest.mos = { degraded: Number(q("#radioMosThreshold").value) || 3.5 };
      const profileContext = {
        environment: q("#radioProfileEnvironment").value,
        purpose: q("#radioProfilePurpose").value,
        band: q("#radioProfileBand").value.trim(),
        samplingRate: q("#radioProfileSampling").value,
      };
      const next = root.RadioDegradationAnalyzer.analyze(log.points, { profiles: profilesRequest, profileContext });
      preserveReviewStates(previous, next);
      next.viewFilters = filters;
      log.radioDegradationAnalysis = next;
      enrichServingNamesFromBdd(next);
      refreshCampaignRecurrence();
      applyProfessionalReport(log, exportMetaFor(log));
      q("#radioDetectionStatus").textContent = `Détection recalculée : ${next.summary.lteCandidates} LTE, ${next.summary.nrCandidates} NR, ${next.summary.mosCandidates} MOS.`;
      root.updateLogsList?.();
      root.showRadioDegradationAnalysis(log.id);
    };
    q("#radioProfileImport").onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file || !root.RadioProfiles) return;
      try {
        const imported = JSON.parse(await file.text());
        if (!imported.context || !imported.profile) throw new Error("Le JSON doit contenir context et profile.");
        root.RadioProfiles.register(imported.context, imported.profile);
        const preset = root.RadioProfiles.getProfile(imported.context);
        if (imported.context.rat === "LTE") {
          q("#radioLteRsrp").value = preset.coverage.degraded;
          q("#radioLteSinr").value = preset.quality.degraded;
        } else if (imported.context.rat === "NR") {
          q("#radioNrRsrp").value = preset.coverage.degraded;
          q("#radioNrSinr").value = preset.quality.degraded;
        }
        q("#radioMosThreshold").value = preset.mos.degraded;
        ["environment", "purpose", "band", "samplingRate"].forEach((field) => {
          const selector = { environment: "#radioProfileEnvironment", purpose: "#radioProfilePurpose",
            band: "#radioProfileBand", samplingRate: "#radioProfileSampling" }[field];
          if (imported.context[field] !== undefined) q(selector).value = imported.context[field];
        });
        q("#radioRecalculate").click();
      } catch (error) {
        root.alert?.(`Profil radio invalide : ${error.message}`);
      }
    };
    const optimReady = prepareOptim(log);
    renderRows();
    optimReady.then(() => {
      if (log.radioDegradationAnalysis !== analysis || modal.style.display === "none") return;
      // Re-apply manual Analyse Optim edits (prepare rebuilds the narratives).
      for (const item of analysis.incidents || []) {
        if (item.optimExecOverride && item.optimAnalysis) {
          item.optimAnalysis.executiveSummary = item.optimExecOverride;
        }
      }
      applyProfessionalReport(log, exportMetaFor(log));
      renderRows();
    }).catch((error) => { console.error("Analyse Optim", error); });
    updateApprovalStatus(log, modal);
    const pointPanel = document.getElementById("floatingInfoPanel");
    if (pointPanel && getComputedStyle(pointPanel).display === "none") {
      const firstCandidate = filteredRows(log)[0];
      if (firstCandidate) {
        focusRow(log, firstCandidate);
        root.setTimeout?.(() => {
          if (modal.style.display !== "none") arrangeReviewLayout(modal);
        }, 80);
      }
    }
    arrangeReviewLayout(modal);
  };

  root.showRadioDegradationSegmentsOnMap = (logOrId, selectedId = null) => {
    const log = typeof logOrId === "object" ? logOrId : getLog(logOrId);
    if (log) showRadioSegmentsOnMap(log, selectedId);
  };
  root.exportRadioDegradationWorkbook = (logId) => exportWorkbook(getLog(logId));
  root.RadioDegradationWorkbook = {
    build: (log, meta) => buildRadioWorkbook(root.XLSX, log, meta),
    payload: (log, meta) => radioWorkbookPayload(log, meta),
  };
  root.RadioReviewWorkspaceLayout = {
    arrange: arrangeReviewLayout,
    restore: restoreReviewLayout,
  };
})(window);
