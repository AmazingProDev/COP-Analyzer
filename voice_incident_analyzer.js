/*
 * Voice Drive Test incident analysis.
 *
 * This module deliberately works on the unmodified rows emitted by ExcelParser.
 * An Excel "Cell type" export contains several cells for the same measurement
 * instant: Active is the serving/active set; Monitored and Detected are
 * neighbours.  Treating those rows as a chronological sequence creates false
 * events, so snapshots are the unit of analysis here.
 */
(function voiceIncidentAnalyzerFactory(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.VoiceIncidentAnalyzer = api;
})(typeof window !== "undefined" ? window : globalThis, function makeAnalyzer() {
  "use strict";

  const VERSION = "voice-umts-v10";
  const DEFAULT_PROFILE = Object.freeze({
    id: "umts-voice-default-v4",
    coverageEntryDbm: -105,
    coverageExitDbm: -102,
    coverageCriticalDbm: -110,
    qualityEntryDb: -15,
    qualityExitDb: -13,
    qualityCriticalDb: -18,
    goodCoverageDbm: -95,
    goodQualityDb: -12,
    // Radio-diagnostic engineering rules.  They are independent from the
    // degradation gates above and can be overridden in an analysis profile.
    credibleNeighborDbm: -105,
    significantPilotDbm: -100,
    strongPilotDbm: -95,
    betterNeighborDeltaDb: 6,
    closePilotDeltaDb: 6,
    weakDominanceDb: 3,
    pilotPollutionMinPilots: 3,
    diagnosticHighSupportPct: 60,
    diagnosticMediumSupportPct: 30,
    diagnosticMinConsecutive: 3,
    bestNeighborMinPresenceRatio: 0.2,
    bestNeighborMinSnapshots: 3,
    // A "general weak coverage" conclusion requires that no usable radio
    // alternative is available over most of the degraded zone. Serving RSCP
    // alone is not enough: a strong monitored neighbour changes the RCA.
    generalWeakCoverageMinRatio: 0.6,
    structuralCoverageMinRatio: 0.6,
    highConfidenceScore: 75,
    mediumConfidenceScore: 50,
    secondaryRcaMinScore: 50,
    lowDominanceRcaMinRatio: 0.5,
    lowDominanceQualitySupportRatio: 0.2,
    serviceImpactDirectDistanceM: 100,
    serviceImpactNearbyDistanceM: 100,
    serviceImpactTemporalMarginSec: 2,
    priorityDropBonus: 20,
    priorityCallFailureBonus: 12,
    // A zone type needs durable evidence. A single quality sample inside a
    // long coverage hole must not turn the whole zone into "mixed".
    minTypeSupportSnapshots: 3,
    minTypeSupportRatio: 0.10,
    minTypeSpatialSupport: 0.10,
    // Recovery samples preserve continuity but are explicitly bounded and
    // labelled; they do not become degradation evidence.
    maxRecoveryBridgeSnapshots: 1,
    minDegradedSnapshots: 5,
    maxPingPongDurationSec: 30,
    maxPingPongDistanceM: 1000,
    minimumReverseTransitions: 1,
    macroZoneMaxGapSec: 20,
    macroZoneMaxGapM: 250,
    macroMaxTemporalGapSec: 20,
    macroMaxSpatialGapM: 250,
    macroMinRcaCompatibility: 70,
    // Separate persistence gates: coverage holes and quality degradation do
    // not necessarily have the same spatial/temporal signature.
    coverageMinSamples: 3,
    qualityMinSamples: 3,
    // Legacy compatibility for profiles saved before v3. New profiles should
    // use the two category-specific values above.
    minSamples: 3,
    recoverySnapshots: 2,
    // A candidate must persist spatially or temporally, not merely contain a
    // burst of rapid samples at one location.
    minDurationSec: 2,
    minDistanceM: 20,
    mergeGapSec: 3,
    maxGpsJumpM: 250,
    eventContextSec: 30,
  });

  const finite = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(String(value).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };

  const text = (value) => String(value ?? "").trim();
  const normal = (value) => text(value).toLowerCase().replace(/[\s_.#-]+/g, "");
  const normalCell = (value) => text(value).replace(/\s+/g, " ").toUpperCase();
  const validCellName = (value) => {
    const name = text(value);
    return Boolean(name) && !/^(?:n\/?d|unknown|null|none)$/i.test(name) && /[a-z]/i.test(name);
  };
  const displayCellName = (cell) => validCellName(cell?.cellName)
    ? text(cell.cellName)
    : `SC ${cell?.sc ?? "N/D"} / UARFCN ${cell?.channel ?? "N/D"}`;

  const getAny = (row, names) => {
    if (!row || typeof row !== "object") return undefined;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
    }
    const wanted = new Set(names.map(normal));
    const key = Object.keys(row).find((candidate) => wanted.has(normal(candidate)));
    return key === undefined ? undefined : row[key];
  };

  const parseTime = (value) => {
    // SheetJS exposes Excel datetimes as serial day numbers unless cellDates is
    // enabled.  Keep the date and milliseconds; Date.parse("46217.45") is not
    // portable and silently loses the event identity.
    if (typeof value === "number" && Number.isFinite(value) && value > 20000 && value < 90000) {
      const excelEpochUtc = Date.UTC(1899, 11, 30);
      const date = new Date(excelEpochUtc + Math.round(value * 86400000));
      const rawExcel = date.toISOString().replace("T", " ").replace("Z", "");
      return { raw: rawExcel, ms: date.getTime() };
    }
    const raw = text(value);
    if (!raw || raw === "N/A") return { raw, ms: null };
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return { raw, ms: parsed };
    const match = raw.match(/(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
    if (!match) return { raw, ms: null };
    const ms = Number(String(match[4] || "0").padEnd(3, "0"));
    return {
      raw,
      ms: (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + ms,
    };
  };

  const haversineM = (a, b) => {
    if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lng) || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return 0;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };

  const isVoiceSchema = (points) => {
    const sample = Array.isArray(points) ? points.slice(0, 300) : [];
    if (sample.length < 2) return false;
    let role = 0;
    let rscp = 0;
    let cell = 0;
    sample.forEach((point) => {
      if (/^(active|monitored|detected|serving)$/i.test(text(getAny(point, ["Cell type", "Cell Type"])))) role += 1;
      if (finite(getAny(point, ["RSCP", "Serving RSCP"])) !== null) rscp += 1;
      if (text(getAny(point, ["Cell name", "Serving Cell Name"]))) cell += 1;
    });
    return role >= 2 && rscp >= 2 && cell >= 2;
  };

  const roleFromRow = (row) => {
    const value = normal(getAny(row, ["Cell type", "Cell Type"]));
    if (value === "active" || value === "serving") return "active";
    if (value === "monitored" || value === "monitor") return "monitored";
    if (value === "detected" || value === "detect") return "detected";
    return "unknown";
  };

  const markersFromRow = (row) => {
    const eventMain = text(getAny(row, ["Event"]));
    const eventSecondary = text(getAny(row, ["event"]));
    const eventId = text(getAny(row, ["Event ID"]));
    const eventIdSecondary = text(getAny(row, ["Event ID_1", "Event ID.1", "Event ID 1"]));
    const disconnect = text(getAny(row, ["Disconnect status"]));
    const disconnectSecondary = text(getAny(row, ["Disconnect status_1", "Disconnect status.1", "Disconnect status 1"]));
    const eventNo = finite(getAny(row, ["Event#", "Event #"]));
    const eventNoSecondary = finite(getAny(row, ["Event#_1_", "Event#_1", "Event# 1"]));
    const all = `${eventMain} ${eventSecondary} ${eventId} ${eventIdSecondary} ${disconnect} ${disconnectSecondary}`.toLowerCase();
    return {
      connected: eventId.toUpperCase() === "CAC" || /\bcall\s+connected\b/.test(all),
      normalDisconnect: /normal\s+disconnect/.test(all),
      drop: /call\s+dropped|dropped\s+call|drop[_ ]?call/.test(all),
      failure: eventIdSecondary.toUpperCase() === "CAD" || /call\s+attempt\s+failure|call[_ ]?setup[_ ]?failure/.test(all),
      eventNo: eventNo ?? eventNoSecondary,
      raw: { eventMain, eventSecondary, eventId, eventIdSecondary, disconnect, disconnectSecondary },
    };
  };

  const mergeMarkers = (target, source) => {
    ["connected", "normalDisconnect", "drop", "failure"].forEach((key) => { target[key] = !!target[key] || !!source[key]; });
    if (target.eventNo === null || target.eventNo === undefined) target.eventNo = source.eventNo;
    return target;
  };

  const readCell = (point, sourceIndex) => {
    const lat = finite(point.lat ?? getAny(point, ["Lat.", "Latitude"]));
    const lng = finite(point.lng ?? getAny(point, ["Lon.", "Longitude"]));
    const cellName = text(getAny(point, ["Cell name", "Cell Name", "Serving Cell Name", "serving_cell_name"]));
    const cellId = finite(getAny(point, ["Cell ID", "CellID", "CI", "cellId"]));
    const channel = finite(getAny(point, ["Ch", "UARFCN", "freq"]));
    const sc = finite(getAny(point, ["SC", "PSC", "sc"]));
    const rscp = finite(getAny(point, ["RSCP", "Serving RSCP", "rscp", "level"]));
    const ecno = finite(getAny(point, ["Ec/N0", "EcNo", "Ec/N0 (dB)", "ecno"]));
    const mos = finite(getAny(point, ["Audio quality MOS DL", "MOS DL", "MOS"]));
    const time = parseTime(point.__sourceTime ?? point.time ?? getAny(point, ["Time", "Timestamp"]));
    return {
      point,
      sourceIndex,
      time: time.raw,
      timeMs: time.ms,
      lat,
      lng,
      role: roleFromRow(point),
      siteName: text(getAny(point, ["Site name", "Site Name"])),
      cellName,
      cellId,
      channel,
      sc,
      rscp,
      ecno,
      mos,
      markers: markersFromRow(point),
      cellKey: [cellId ?? "", channel ?? "", sc ?? "", normalCell(cellName)].join("|"),
    };
  };

  const snapshotKey = (cell) => {
    const stamp = Number.isFinite(cell.timeMs) ? String(cell.timeMs) : cell.time;
    const lat = Number.isFinite(cell.lat) ? cell.lat.toFixed(7) : "";
    const lng = Number.isFinite(cell.lng) ? cell.lng.toFixed(7) : "";
    return `${stamp}|${lat}|${lng}`;
  };

  const buildSnapshots = (points) => {
    const byKey = new Map();
    points.forEach((point, sourceIndex) => {
      const cell = readCell(point, sourceIndex);
      if (!cell.time || !Number.isFinite(cell.lat) || !Number.isFinite(cell.lng)) return;
      const key = snapshotKey(cell);
      let snapshot = byKey.get(key);
      if (!snapshot) {
        snapshot = {
          id: `voice_snapshot_${byKey.size + 1}`,
          key,
          time: cell.time,
          timeMs: cell.timeMs,
          lat: cell.lat,
          lng: cell.lng,
          cells: [],
          markers: { connected: false, normalDisconnect: false, drop: false, failure: false, eventNo: null },
          sourceRows: [],
        };
        byKey.set(key, snapshot);
      }
      snapshot.sourceRows.push(sourceIndex);
      mergeMarkers(snapshot.markers, cell.markers);
      const existing = snapshot.cells.find((candidate) => candidate.cellKey === cell.cellKey && candidate.role === cell.role);
      if (existing) {
        existing.sourceRows.push(sourceIndex);
        mergeMarkers(existing.markers, cell.markers);
        ["siteName", "cellName", "cellId", "channel", "sc", "rscp", "ecno", "mos"].forEach((field) => {
          if ((existing[field] === null || existing[field] === undefined || existing[field] === "") && cell[field] !== null && cell[field] !== undefined && cell[field] !== "") existing[field] = cell[field];
        });
      } else {
        cell.sourceRows = [sourceIndex];
        snapshot.cells.push(cell);
      }
    });
    const snapshots = [...byKey.values()].sort((a, b) => {
      if (Number.isFinite(a.timeMs) && Number.isFinite(b.timeMs)) return a.timeMs - b.timeMs;
      return String(a.time).localeCompare(String(b.time));
    });
    snapshots.forEach((snapshot) => {
      snapshot.activeSet = snapshot.cells.filter((cell) => cell.role === "active");
      snapshot.monitoredNeighbors = snapshot.cells.filter((cell) => cell.role === "monitored");
      snapshot.detectedNeighbors = snapshot.cells.filter((cell) => cell.role === "detected");
      snapshot.primaryServing = snapshot.activeSet[0] || null;
      enrichSnapshotPointsForDetails(snapshot);
    });
    return snapshots;
  };

  const publicCell = (cell) => {
    if (!cell) return null;
    return {
      role: cell.role,
      siteName: cell.siteName || null,
      cellName: displayCellName(cell),
      sourceCellName: validCellName(cell.cellName) ? cell.cellName : null,
      cellId: cell.cellId,
      channel: cell.channel,
      sc: cell.sc,
      rscp: cell.rscp,
      ecno: cell.ecno,
      mos: cell.mos,
      sourceRows: Array.isArray(cell.sourceRows) ? cell.sourceRows.slice() : [],
    };
  };

  const enrichSnapshotPointsForDetails = (snapshot) => {
    const serving = snapshot && snapshot.primaryServing;
    if (!serving || !serving.point) return;
    const counters = { active: 1, monitored: 0, detected: 0, unknown: 0 };
    const neighbors = snapshot.cells
      .filter((cell) => cell !== serving)
      .map((cell) => {
        const role = String(cell.role || "unknown").toLowerCase();
        const key = Object.prototype.hasOwnProperty.call(counters, role) ? role : "unknown";
        counters[key] += 1;
        const prefix = key === "active" ? "A" : key === "monitored" ? "M" : key === "detected" ? "D" : "N";
        return {
          type: `${prefix}${counters[key]}`,
          rat: "UTRA",
          sc: cell.sc ?? "-",
          psc: cell.sc ?? null,
          freq: cell.channel ?? "-",
          uarfcn: cell.channel ?? null,
          rscp: cell.rscp ?? "-",
          ecno: cell.ecno ?? "-",
          cellName: cell.cellName || "",
          name: cell.cellName || "",
          source_kind: "same_time_snapshot",
        };
      });
    const serving3g = {
      cellName: serving.cellName || "",
      cellId: serving.cellId ?? null,
      sc: serving.sc ?? null,
      freq: serving.channel ?? null,
      uarfcn: serving.channel ?? null,
      rscp: serving.rscp ?? null,
      ecno: serving.ecno ?? null,
    };
    // A map click can land on any Active/Monitored/Detected row with this
    // timestamp.  Attach the same canonical serving + neighbour snapshot to
    // all of them, so Point Details never treats a neighbour as the server.
    snapshot.cells.forEach((cell) => {
      const point = cell.point;
      if (!point || typeof point !== "object") return;
      point.tech = "3G";
      point.__voiceSnapshot = true;
      point.serving_cell_name = serving3g.cellName;
      point.servingCellName = serving3g.cellName;
      point.cellName = serving3g.cellName;
      point["Serving Cell Name"] = serving3g.cellName;
      point.cellId = serving3g.cellId;
      point.sc = serving3g.sc;
      point.freq = serving3g.freq;
      point.rscp = serving3g.rscp;
      point.level = serving3g.rscp;
      point.ecno = serving3g.ecno;
      point.parsed = Object.assign({}, point.parsed || {}, {
        serving: Object.assign({}, point.parsed?.serving || {}, serving3g),
        serving_3g: serving3g,
        neighbors,
      });
      point.properties = Object.assign({}, point.properties || {}, {
        "Serving Cell Name": serving3g.cellName,
        "Serving cell": serving3g.cellName,
        "Cell ID": serving3g.cellId ?? "",
        "Same-time neighbour count": neighbors.length,
        // The source workbook has RSCP and Ec/N0 only; never fabricate a
        // UMTS SINR value from Ec/N0.
        "SINR (source)": "N/A — non fourni par cet export",
      });
    });
  };

  // Neighbours are a same-time radio observation, not extra samples on the
  // drive route.  Keep their evidence with the incident so an engineer can
  // distinguish a local coverage hole from a potential mobility/quality case.
  // This is deliberately a diagnostic hypothesis, never a conclusive root
  // cause: the workbook has no RNC counters, load or signalling trace.
  const cellIdentity = (cell) => [cell?.cellId ?? "", cell?.channel ?? "", cell?.sc ?? "", normalCell(cell?.cellName)].join("|");
  const formatDelta = (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(1)} dB` : "n/a";
  const confidenceLabel = (value) => ({ high: "élevée", medium: "moyenne", low: "faible" }[value] || "faible");

  const formatDiagnostic = (primary, confidence, supportPct = null, secondary = null) => {
    const parts = [primary?.label || "Diagnostic mixte / non conclusif"];
    if (primary?.trigger) parts.push(primary.trigger);
    parts.push(`Confiance ${confidenceLabel(confidence)}`);
    if (Number.isFinite(supportPct)) parts.push(`Support ${supportPct.toFixed(1)} %`);
    if (secondary?.label) parts.push(`Secondaire : ${secondary.label}`);
    return parts.join(" | ");
  };

  // Produces an explainable hypothesis for one radio snapshot.  Intra- and
  // inter-frequency neighbours are intentionally never mixed: only the
  // former can support dominance/pilot-pollution conclusions.
  const describeNeighborContext = (snapshot, serving, profile) => {
    const unavailable = {
      neighborCount: 0, credibleNeighborCount: 0, sameFrequencyNeighborCount: 0,
      interFrequencyNeighborCount: 0, sameFrequencyPilotCount: 0,
      significantSameFrequencyPilots: 0, strongSameFrequencyPilots: 0,
      nearBestPilotCount: 0, detectedCredibleCount: 0,
      bestNeighbor: null, bestSameFrequencyNeighbor: null,
      bestInterFrequencyNeighbor: null, bestNeighborDeltaDb: null,
      deltaSameFreqDb: null, deltaInterFreqDb: null, servingAdvantageDb: null,
      neighborAdvantageDb: null, pilotDominanceMarginDb: null, dominanceMarginDb: null,
      pilotPollutionCompatible: false,
      primaryCode: "INSUFFICIENT_DATA", secondaryCode: null,
      diagnostic: "Données radio insuffisantes | Confiance faible",
      primaryDiagnostic: "Données radio insuffisantes", secondaryDiagnostic: null,
      confidence: "low", candidates: [],
    };
    if (!snapshot || !serving) return unavailable;
    const distinct = new Map();
    [...(snapshot.monitoredNeighbors || []), ...(snapshot.detectedNeighbors || [])].forEach((cell) => {
      if (!cell || !cell.cellKey || cell.cellKey === serving.cellKey) return;
      const existing = distinct.get(cell.cellKey);
      if (!existing || (Number.isFinite(cell.rscp) && (!Number.isFinite(existing.rscp) || cell.rscp > existing.rscp))) distinct.set(cell.cellKey, cell);
    });
    const neighbors = [...distinct.values()];
    const ranked = neighbors.filter((cell) => Number.isFinite(cell.rscp)).sort((a, b) => b.rscp - a.rscp);
    const servingRscp = serving.rscp;
    const servingEcno = serving.ecno;
    const sameFrequency = ranked.filter((cell) => Number.isFinite(serving.channel) && Number.isFinite(cell.channel) && cell.channel === serving.channel);
    const interFrequency = ranked.filter((cell) => Number.isFinite(serving.channel) && Number.isFinite(cell.channel) && cell.channel !== serving.channel);
    const bestSame = sameFrequency[0] || null;
    const bestInter = interFrequency[0] || null;
    const best = bestSame || bestInter || ranked[0] || null;
    const deltaSame = bestSame && Number.isFinite(servingRscp) ? bestSame.rscp - servingRscp : null;
    const deltaInter = bestInter && Number.isFinite(servingRscp) ? bestInter.rscp - servingRscp : null;
    const delta = best && Number.isFinite(servingRscp) ? best.rscp - servingRscp : null;
    const credibleDbm = Number(profile.credibleNeighborDbm ?? profile.coverageEntryDbm);
    const significantDbm = Number(profile.significantPilotDbm ?? -100);
    const strongDbm = Number(profile.strongPilotDbm ?? profile.goodCoverageDbm ?? -95);
    const betterDelta = Number(profile.betterNeighborDeltaDb ?? 6);
    const closeDelta = Number(profile.closePilotDeltaDb ?? 6);
    const weakDominance = Number(profile.weakDominanceDb ?? 3);
    const minPollutionPilots = Math.max(2, Number(profile.pilotPollutionMinPilots ?? 3));
    const credible = ranked.filter((cell) => cell.rscp >= credibleDbm);
    const credibleSame = sameFrequency.filter((cell) => cell.rscp >= credibleDbm);
    const detectedCredible = sameFrequency.filter((cell) => cell.role === "detected" && cell.rscp >= credibleDbm);
    const pilots = [serving, ...sameFrequency].filter((cell) => Number.isFinite(cell?.rscp));
    const bestPilotRscp = pilots.length ? Math.max(...pilots.map((cell) => cell.rscp)) : null;
    const nearBest = Number.isFinite(bestPilotRscp) ? pilots.filter((cell) => bestPilotRscp - cell.rscp <= closeDelta) : [];
    const significantPilots = pilots.filter((cell) => cell.rscp >= significantDbm);
    const strongPilots = pilots.filter((cell) => cell.rscp >= strongDbm);
    // Serving advantage and pilot dominance are different physical measures.
    // The former may be negative; the latter is a sorted top-two margin and
    // therefore can never be negative.
    const servingAdvantage = bestSame && Number.isFinite(servingRscp) ? servingRscp - bestSame.rscp : null;
    const neighborAdvantage = Number.isFinite(servingAdvantage) ? -servingAdvantage : null;
    const sortedPilotLevels = pilots.map((cell) => cell.rscp).sort((a, b) => b - a);
    const pilotDominance = sortedPilotLevels.length >= 2 ? sortedPilotLevels[0] - sortedPilotLevels[1] : null;
    const coverageLow = Number.isFinite(servingRscp) && servingRscp <= profile.coverageEntryDbm;
    const qualityLow = Number.isFinite(servingEcno) && servingEcno <= profile.qualityEntryDb;
    const sameMonitoredBetter = sameFrequency.find((cell) => cell.role === "monitored" && cell.rscp >= credibleDbm && Number.isFinite(servingRscp) && cell.rscp - servingRscp >= betterDelta);
    const sameDetectedBetter = sameFrequency.find((cell) => cell.role === "detected" && cell.rscp >= credibleDbm && Number.isFinite(servingRscp) && cell.rscp - servingRscp >= betterDelta);
    const interBetter = interFrequency.find((cell) => cell.rscp >= credibleDbm && Number.isFinite(servingRscp) && cell.rscp - servingRscp >= betterDelta);
    const candidates = [];
    let pilotPollution = false;
    const add = (code, label, trigger, priority) => candidates.push({ code, label, trigger, priority });
    const neighborTrigger = (cell, set) => `${set} ${cell?.cellName || "inconnu"} à ${formatDelta(Number(cell?.rscp) - Number(servingRscp))}`;

    if (!Number.isFinite(servingRscp)) {
      add("INSUFFICIENT_DATA", "Données radio insuffisantes", "RSCP Serving indisponible", 100);
    } else {
      if (sameDetectedBetter) add("MISSING_NEIGHBOR", "Voisin manquant potentiel", neighborTrigger(sameDetectedBetter, "Detected co-fréquence"), 10);
      if (sameMonitoredBetter) add("INTRA_FREQ_MOBILITY", "Mobilité intra-frequency à vérifier", neighborTrigger(sameMonitoredBetter, "Monitored co-fréquence"), 20);
      if (interBetter) add("INTER_FREQ_MOBILITY", "Meilleure couverture disponible sur une autre porteuse — mobilité inter-frequency à investiguer", neighborTrigger(interBetter, "Voisin inter-fréquence"), 30);

      pilotPollution = qualityLow && servingRscp >= credibleDbm && significantPilots.length >= minPollutionPilots && nearBest.length >= minPollutionPilots;
      const strongPollution = pilotPollution && strongPilots.length >= minPollutionPilots;
      const weakDominanceCase = qualityLow && servingRscp >= strongDbm && Number.isFinite(pilotDominance) && pilotDominance <= weakDominance;
      const servingDominantQuality = qualityLow && servingRscp >= strongDbm && (!Number.isFinite(pilotDominance) || pilotDominance > weakDominance);
      if (strongPollution) add("PILOT_POLLUTION_STRONG", "Pilot pollution fortement suspectée", `${strongPilots.length} pilotes co-fréquence ≥ ${strongDbm} dBm, ${nearBest.length} proches du meilleur`, 40);
      else if (pilotPollution) add("PILOT_POLLUTION", "Pilot pollution probable", `${significantPilots.length} pilotes co-fréquence ≥ ${significantDbm} dBm, ${nearBest.length} proches du meilleur`, 45);
      else if (weakDominanceCase) add("WEAK_DOMINANCE", "Faible dominance radio", `${nearBest.length} pilotes co-fréquence proches ; marge pilotes ${pilotDominance.toFixed(1)} dB`, 50);
      else if (servingDominantQuality) add("QUALITY_SERVING_DOMINANT", "Qualité dégradée malgré un Serving dominant", "Charge/interférence externe/autre cause à investiguer", 55);
      else if (qualityLow) add("QUALITY_NEIGHBORHOOD", "Qualité faible — voisinage radio à investiguer", `${sameFrequency.length} voisin(s) co-fréquence observé(s)`, 60);

      if (coverageLow && !credible.length) {
        add(qualityLow ? "COVERAGE_QUALITY_INSUFFICIENT" : "COVERAGE_INSUFFICIENT", qualityLow ? "Couverture insuffisante avec qualité dégradée" : "Couverture insuffisante probable", "Aucun voisin radio crédible observé", 70);
      } else if (coverageLow && !sameDetectedBetter && !sameMonitoredBetter && !interBetter) {
        add("GENERAL_WEAK_COVERAGE", "Couverture faible généralisée", "Serving et voisins de niveaux insuffisants", 75);
      }
      if (!coverageLow && !qualityLow && !sameDetectedBetter && !sameMonitoredBetter && !interBetter) add("NORMAL", "Conditions radio normales", "Aucune dégradation RF détectée au snapshot", 95);
      else if (!coverageLow && !qualityLow && candidates.length) add("BETTER_NEIGHBOR_NO_DEGRADATION", "Voisin plus favorable sans dégradation", "Opportunité de mobilité à confirmer", 90);
    }
    candidates.sort((a, b) => a.priority - b.priority);
    const primary = candidates[0] || { code: "INCONCLUSIVE", label: "Diagnostic mixte / non conclusif", trigger: "Éléments radio insuffisants", priority: 99 };
    const secondary = candidates.find((candidate) => candidate.code !== primary.code) || null;
    const snapshotConfidence = primary.code === "INSUFFICIENT_DATA" ? "low" : (primary.code.includes("PILOT_POLLUTION") || primary.code === "MISSING_NEIGHBOR") ? "high" : neighbors.length ? "medium" : "low";
    return {
      neighborCount: neighbors.length, credibleNeighborCount: credible.length,
      sameFrequencyNeighborCount: sameFrequency.length, interFrequencyNeighborCount: interFrequency.length,
      credibleSameFrequencyNeighborCount: credibleSame.length, detectedCredibleCount: detectedCredible.length,
      sameFrequencyPilotCount: pilots.length, significantSameFrequencyPilots: significantPilots.length,
      strongSameFrequencyPilots: strongPilots.length, nearBestPilotCount: nearBest.length,
      bestNeighbor: publicCell(best), bestSameFrequencyNeighbor: publicCell(bestSame), bestInterFrequencyNeighbor: publicCell(bestInter),
      bestNeighborSet: best?.role || null,
      bestNeighborDeltaDb: Number.isFinite(delta) ? Number(delta.toFixed(1)) : null,
      deltaSameFreqDb: Number.isFinite(deltaSame) ? Number(deltaSame.toFixed(1)) : null,
      deltaInterFreqDb: Number.isFinite(deltaInter) ? Number(deltaInter.toFixed(1)) : null,
      servingAdvantageDb: Number.isFinite(servingAdvantage) ? Number(servingAdvantage.toFixed(1)) : null,
      neighborAdvantageDb: Number.isFinite(neighborAdvantage) ? Number(neighborAdvantage.toFixed(1)) : null,
      pilotDominanceMarginDb: Number.isFinite(pilotDominance) ? Number(pilotDominance.toFixed(1)) : null,
      // Legacy alias now means pilot dominance, never serving advantage.
      dominanceMarginDb: Number.isFinite(pilotDominance) ? Number(pilotDominance.toFixed(1)) : null,
      pilotPollutionCompatible: !!pilotPollution,
      primaryCode: primary.code, secondaryCode: secondary?.code || null,
      primaryDiagnostic: primary.label, secondaryDiagnostic: secondary?.label || null,
      diagnostic: formatDiagnostic(primary, snapshotConfidence, null, secondary),
      confidence: snapshotConfidence, candidates,
    };
  };

  const aggregateDiagnosticContext = (snapshotContexts, profile, representativeContext = null) => {
    const contexts = (snapshotContexts || []).filter(Boolean);
    if (!contexts.length) return representativeContext || describeNeighborContext(null, null, profile);
    const byCode = new Map();
    contexts.forEach((context, index) => {
      const candidate = (context.candidates || []).find((item) => item.code === context.primaryCode) || {
        code: context.primaryCode || "INCONCLUSIVE", label: context.primaryDiagnostic || "Diagnostic mixte / non conclusif", trigger: "", priority: 99,
      };
      const item = byCode.get(candidate.code) || { candidate, count: 0, indices: [], contexts: [] };
      item.count += 1; item.indices.push(index); item.contexts.push(context); byCode.set(candidate.code, item);
    });
    const ranked = [...byCode.values()].sort((a, b) => b.count - a.count || a.candidate.priority - b.candidate.priority);
    const winner = ranked[0];
    let maxConsecutive = 0; let run = 0;
    contexts.forEach((context) => { run = context.primaryCode === winner.candidate.code ? run + 1 : 0; maxConsecutive = Math.max(maxConsecutive, run); });
    const supportPct = Number((winner.count * 100 / contexts.length).toFixed(1));
    const patternCounts = new Map();
    winner.contexts.forEach((context) => {
      const key = `${context.primaryCode}|${cellIdentity(context.bestNeighbor)}|${context.bestNeighborSet || ""}`;
      patternCounts.set(key, (patternCounts.get(key) || 0) + 1);
    });
    const recurrentPattern = Math.max(0, ...patternCounts.values()) >= Math.max(2, Math.ceil(winner.count * 0.6));
    const highSupport = Number(profile.diagnosticHighSupportPct ?? 60);
    const mediumSupport = Number(profile.diagnosticMediumSupportPct ?? 30);
    const minConsecutive = Math.max(1, Number(profile.diagnosticMinConsecutive ?? 3));
    const confidence = supportPct >= highSupport && maxConsecutive >= minConsecutive && recurrentPattern
      ? "high" : supportPct >= mediumSupport || (winner.count >= 2 && recurrentPattern) ? "medium" : "low";
    const secondary = ranked.find((item) => item.candidate.code !== winner.candidate.code && item.count * 100 / contexts.length >= mediumSupport);
    const triggerContext = winner.contexts.slice().sort((a, b) => (Number(b.bestNeighborDeltaDb) || -Infinity) - (Number(a.bestNeighborDeltaDb) || -Infinity))[0] || representativeContext || contexts[0];
    const primary = { ...winner.candidate, trigger: triggerContext?.candidates?.find((item) => item.code === winner.candidate.code)?.trigger || winner.candidate.trigger };
    const bestNeighbor = triggerContext?.bestNeighbor || representativeContext?.bestNeighbor || null;
    return {
      ...(representativeContext || contexts[0]),
      neighborCount: Math.max(...contexts.map((context) => context.neighborCount || 0)),
      bestNeighbor, bestNeighborSet: triggerContext?.bestNeighborSet || null,
      bestNeighborDeltaDb: triggerContext?.bestNeighborDeltaDb ?? null,
      primaryCode: primary.code, primaryDiagnostic: primary.label,
      secondaryCode: secondary?.candidate.code || null, secondaryDiagnostic: secondary?.candidate.label || null,
      diagnostic: formatDiagnostic(primary, confidence, supportPct, secondary?.candidate || null),
      confidence, supportPct, supportSnapshots: winner.count, maxConsecutiveSupport: maxConsecutive,
      diagnosticSecondarySupportPct: secondary ? Number((secondary.count * 100 / contexts.length).toFixed(1)) : 0,
    };
  };

  const eventPoint = (snapshot, kind, sessionId, profile) => {
    const serving = snapshot.primaryServing;
    const neighborContext = describeNeighborContext(snapshot, serving, profile);
    const label = kind === "CALL_DROP" ? "Call dropped" : "Call attempt failure";
    const source = serving?.point || snapshot.cells[0]?.point || {};
    return Object.assign({}, source, {
      lat: snapshot.lat,
      lng: snapshot.lng,
      time: snapshot.time,
      // Keep the event self-contained.  Some point-detail renderers resolve a
      // cell from top-level fields rather than from properties, and the Excel
      // source has `Cell name` (not `Serving Cell Name`).
      serving_cell_name: serving?.cellName || "",
      cellName: serving?.cellName || "",
      cellId: serving?.cellId ?? null,
      cid: serving?.cellId ?? null,
      sc: serving?.sc ?? null,
      freq: serving?.channel ?? null,
      level: serving?.rscp ?? null,
      rscp: serving?.rscp ?? null,
      ecno: serving?.ecno ?? null,
      type: "EVENT",
      event: label,
      message: label,
      sessionId,
      drop: kind === "CALL_DROP",
      setupFailure: kind === "CALL_SETUP_FAILURE",
      endType: kind === "CALL_DROP" ? "DROP" : "CALL_SETUP_FAILURE",
      neighborContext,
      // The point-details panel needs every same-time Active/Monitored/Detected
      // row, not only the winning cell.  Store a typed, compact snapshot so a
      // map click cannot accidentally resolve to another row with the same
      // timestamp.
      snapshotCells: snapshot.cells.map(publicCell),
      properties: Object.assign({}, source.properties || {}, {
        Event: label,
        "Session ID": sessionId,
        "Cell role": serving?.role || "unknown",
        "Serving cell": serving?.cellName || "",
        "Cell ID": serving?.cellId ?? "",
        "Serving RSCP": serving?.rscp ?? "",
        "Serving Ec/N0": serving?.ecno ?? "",
        "Radio diagnostic": neighborContext.diagnostic,
        "Observed neighbours": neighborContext.neighborCount,
        "Best neighbour": neighborContext.bestNeighbor?.cellName || "",
        "Best neighbour RSCP": neighborContext.bestNeighbor?.rscp ?? "",
        "Best neighbour delta (dB)": neighborContext.bestNeighborDeltaDb ?? "",
        "Voice source rows": snapshot.sourceRows.join(","),
      }),
    });
  };

  const buildCallSessions = (snapshots, profile) => {
    const sessions = [];
    const events = [];
    let active = null;
    let sequence = 0;
    const createSession = (snapshot, outcome) => {
      sequence += 1;
      const primary = publicCell(snapshot.primaryServing);
      return {
        id: `voice_xlsx_${sequence}`,
        sessionId: `voice_xlsx_${sequence}`,
        kind: "UMTS_VOICE_EXCEL",
        technology: "3G (Voice Excel)",
        startTs: snapshot.time,
        endTs: null,
        startGps: { lat: snapshot.lat, lng: snapshot.lng },
        endGps: null,
        startCell: primary,
        endCell: null,
        connected: outcome === "CONNECTED",
        events: [],
        drop: false,
        setupFailure: false,
        outcome: outcome || "INCOMPLETE",
        endType: "UNKNOWN",
      };
    };
    const close = (session, snapshot, outcome) => {
      const primary = publicCell(snapshot.primaryServing);
      session.endTs = snapshot.time;
      session.endGps = { lat: snapshot.lat, lng: snapshot.lng };
      session.endCell = primary;
      session.outcome = outcome;
      session.endType = outcome === "DROP_CALL" ? "DROP" : outcome === "CALL_SETUP_FAILURE" ? "CALL_SETUP_FAILURE" : "NORMAL_RELEASE";
      session.drop = outcome === "DROP_CALL";
      session.setupFailure = outcome === "CALL_SETUP_FAILURE";
      if (Number.isFinite(snapshot.timeMs) && Number.isFinite(parseTime(session.startTs).ms)) session.durationSec = Math.max(0, (snapshot.timeMs - parseTime(session.startTs).ms) / 1000);
      sessions.push(session);
    };
    snapshots.forEach((snapshot) => {
      if (snapshot.markers.connected) {
        if (active) close(active, snapshot, "INCOMPLETE");
        active = createSession(snapshot, "CONNECTED");
      }
      if (snapshot.markers.drop) {
        if (!active) active = createSession(snapshot, "INCOMPLETE");
        const event = eventPoint(snapshot, "CALL_DROP", active.id, profile);
        active.events.push(event);
        // This is the authoritative CGPS event point.  Consumers must not
        // re-anchor it by a nearest-time search across Active/Monitored rows.
        active.eventAnchor = event;
        events.push(event);
        close(active, snapshot, "DROP_CALL");
        active = null;
      } else if (snapshot.markers.failure) {
        const failed = createSession(snapshot, "CALL_SETUP_FAILURE");
        const event = eventPoint(snapshot, "CALL_SETUP_FAILURE", failed.id, profile);
        failed.events.push(event);
        failed.eventAnchor = event;
        events.push(event);
        close(failed, snapshot, "CALL_SETUP_FAILURE");
      } else if (snapshot.markers.normalDisconnect && active) {
        close(active, snapshot, "SUCCESS");
        active = null;
      }
    });
    if (active) sessions.push(active);
    return { sessions, events };
  };

  const classifyRadio = (cell, profile) => {
    const coverage = Number.isFinite(cell.rscp) && cell.rscp <= profile.coverageEntryDbm;
    const quality = Number.isFinite(cell.ecno) && cell.ecno <= profile.qualityEntryDb && !coverage;
    if (coverage && Number.isFinite(cell.ecno) && cell.ecno <= profile.qualityEntryDb) return "combined";
    if (coverage) return "coverage";
    if (quality) return "quality";
    return null;
  };

  const buildEpisodesForKind = (snapshots, profile, kind) => {
    const episodes = [];
    let current = [];
    const legacyMinimumSamples = Math.max(1, Math.round(Number(profile.minSamples) || 1));
    const minimumSamples = kind === "coverage"
      ? Math.max(1, Math.round(Number(profile.coverageMinSamples) || legacyMinimumSamples))
      : Math.max(1, Math.round(Number(profile.qualityMinSamples) || legacyMinimumSamples));
    const isDegraded = (cell) => kind === "coverage"
      ? Number.isFinite(cell?.rscp) && cell.rscp <= profile.coverageEntryDbm
      : Number.isFinite(cell?.ecno) && cell.ecno <= profile.qualityEntryDb;
    const flush = () => {
      if (!current.length) return;
      const first = current[0];
      const last = current[current.length - 1];
      const durationSec = Number.isFinite(first.snapshot.timeMs) && Number.isFinite(last.snapshot.timeMs) ? (last.snapshot.timeMs - first.snapshot.timeMs) / 1000 : 0;
      let distanceM = 0;
      for (let i = 1; i < current.length; i += 1) distanceM += haversineM(current[i - 1].snapshot, current[i].snapshot);
      const minimumDurationSec = Math.max(0, Number(profile.minDurationSec) || 0);
      if (current.length < minimumSamples || durationSec < minimumDurationSec) return;
      const representative = current.reduce((best, row) => {
        const metric = kind === "quality" ? row.cell.ecno : row.cell.rscp;
        const bestMetric = kind === "quality" ? best.cell.ecno : best.cell.rscp;
        return !Number.isFinite(bestMetric) || (Number.isFinite(metric) && metric < bestMetric) ? row : best;
      }, current[0]);
      const rscp = current.map((row) => row.cell.rscp).filter(Number.isFinite).sort((a, b) => a - b);
      const ecno = current.map((row) => row.cell.ecno).filter(Number.isFinite).sort((a, b) => a - b);
      const median = (values) => values.length ? values[Math.floor(values.length / 2)] : null;
      const severity = kind === "coverage"
        ? (representative.cell.rscp <= profile.coverageCriticalDbm ? "critical" : "major")
        : (representative.cell.ecno <= profile.qualityCriticalDb ? "critical" : "major");
      episodes.push({
        id: `voice_${kind}_${episodes.length + 1}`,
        type: kind === "coverage" ? "COVERAGE_DEGRADATION" : "QUALITY_DEGRADATION",
        category: kind,
        severity,
        startTime: first.snapshot.time,
        endTime: last.snapshot.time,
        start: { lat: first.snapshot.lat, lng: first.snapshot.lng },
        end: { lat: last.snapshot.lat, lng: last.snapshot.lng },
        representative: {
          time: representative.snapshot.time,
          lat: representative.snapshot.lat,
          lng: representative.snapshot.lng,
          cell: publicCell(representative.cell),
        },
        servingCell: publicCell(first.cell),
        sampleCount: current.length,
        requiredSampleCount: minimumSamples,
        durationSec,
        distanceM,
        metrics: {
          rscpMin: rscp.length ? rscp[0] : null,
          rscpMedian: median(rscp),
          ecnoMin: ecno.length ? ecno[0] : null,
          ecnoMedian: median(ecno),
        },
        // Preserve the complete serving route, rather than only the worst
        // representative sample.  A snapshot is intentionally one Active
        // serving measurement at a time: Monitored/Detected rows remain
        // evidence on that snapshot and can never inflate this sequence.
        sequence: current.map((row) => ({
          time: row.snapshot.time,
          timeMs: row.snapshot.timeMs,
          lat: row.snapshot.lat,
          lng: row.snapshot.lng,
          serving: publicCell(row.cell),
          snapshotCells: row.snapshot.cells.map(publicCell),
          sourceRows: row.snapshot.sourceRows.slice(),
        })),
        neighborContext: describeNeighborContext(representative.snapshot, representative.cell, profile),
        snapshotCells: representative.snapshot.cells.map(publicCell),
        confidence: current.length >= 10 && durationSec >= 10 ? "high" : "medium",
        reviewState: "candidate",
        sourceRows: [...new Set(current.flatMap((row) => row.cell.sourceRows))],
      });
    };

    snapshots.forEach((snapshot) => {
      const cell = snapshot.primaryServing;
      const prior = current[current.length - 1];
      const deltaSec = prior && Number.isFinite(snapshot.timeMs) && Number.isFinite(prior.snapshot.timeMs)
        ? (snapshot.timeMs - prior.snapshot.timeMs) / 1000 : 0;
      // Each category has its own run. A quality threshold crossing therefore
      // cannot break coverage persistence (and vice versa). A handover also
      // does not break a continuous degraded route sequence.
      if (
        !cell ||
        !isDegraded(cell) ||
        (prior && (deltaSec < 0 || deltaSec > profile.mergeGapSec))
      ) {
        flush();
        current = [];
      }
      if (cell && isDegraded(cell)) current.push({ snapshot, cell });
    });
    flush();
    return episodes;
  };

  const numericStats = (values) => {
    const sorted = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return { median: null, p10: null, p90: null, min: null, max: null };
    const quantile = (p) => {
      const index = (sorted.length - 1) * p;
      const lo = Math.floor(index); const hi = Math.ceil(index);
      return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
    };
    return { median: quantile(0.5), p10: quantile(0.1), p90: quantile(0.9), min: sorted[0], max: sorted[sorted.length - 1] };
  };

  const RCA_META = Object.freeze({
    STRUCTURAL_COVERAGE_GAP: ["Insuffisance de couverture structurelle", "Étudier une solution de couverture de la zone : optimisation RF de l'existant ou capacité/couverture additionnelle selon étude radio."],
    GENERAL_WEAK_COVERAGE: ["Couverture faible généralisée", "Vérifier la couverture disponible, les couches radio et les paramètres de couverture."],
    INTRAFREQ_MOBILITY_ISSUE: ["Mobilité intra-frequency à vérifier", "Vérifier Active Set, relations de voisinage, paramètres SHO/HO, hystérésis et timers."],
    POTENTIAL_MISSING_NEIGHBOR: ["Voisin manquant potentiel", "Vérifier la relation de voisinage et la configuration RNC ; cette hypothèse doit être confirmée par la configuration."],
    INTERFREQ_MOBILITY_OPPORTUNITY: ["Mobilité inter-frequency à investiguer", "Vérifier les seuils, priorités et la stratégie de mobilité inter-frequency."],
    LOW_DOMINANCE_RCA: ["Faible dominance radio avec impact mesuré", "Étudier la dominance, l'overlap, azimuts, tilts, puissance CPICH et voisinage."],
    PILOT_POLLUTION_PROBABLE: ["Pilot pollution probable", "Étudier dominance, overlap, tilt/azimut, puissance CPICH et design RF ; à confirmer avec les données réseau."],
    QUALITY_DEGRADATION_DOMINANT_SERVING: ["Qualité dégradée malgré un Serving dominant", "Investiguer charge, interférence externe, matériel, puissance et configuration ; aucune cause n'est confirmée par le DT seul."],
    COVERAGE_AND_QUALITY_DEGRADATION: ["Couverture et qualité dégradées", "Prioriser une étude de couverture puis de qualité radio sur la zone."],
    PING_PONG_PROBABLE: ["Ping-pong mobilité probable", "Vérifier hystérésis, timers, SHO/HO, overlap et dominance."],
    MOBILITY_INSTABILITY: ["Instabilité de mobilité / absence de dominance", "Vérifier la cohérence des transitions Serving et les paramètres de mobilité."],
    STRONGER_NEIGHBOR_WITHOUT_DEGRADATION: ["Voisin plus favorable sans dégradation", "Vérifier l'opportunité de mobilité sans l'interpréter comme une cause d'incident."],
    INSUFFICIENT_DATA: ["Données radio insuffisantes", "Compléter les mesures radio, voisinage et/ou GPS avant une conclusion."],
    INCONCLUSIVE: ["Diagnostic radio non conclusif", "Poursuivre l'investigation avec paramètres RNC, signalisation, charge, RTWP/interférence, alarmes et configuration radio."],
  });

  const rcaMeta = (code) => RCA_META[code] || RCA_META.INCONCLUSIVE;
  const ratio = (part, total) => total ? Number((part / total).toFixed(4)) : 0;
  const rcaConfidence = (score, supportSnapshots, profile) => {
    if (supportSnapshots < Number(profile.minDegradedSnapshots ?? 5)) return "low";
    // A compatible pattern with a small, valid sample is still not strong
    // enough for a high-confidence RCA.
    if (supportSnapshots <= 7) return score >= Number(profile.mediumConfidenceScore ?? 50) ? "medium" : "low";
    if (supportSnapshots < Math.max(2, Number(profile.diagnosticMinConsecutive ?? 3))) return "low";
    if (score >= Number(profile.highConfidenceScore ?? 75)) return "high";
    if (score >= Number(profile.mediumConfidenceScore ?? 50)) return "medium";
    return "low";
  };

  const priorityComponentsFor = ({ rscpP10, ecnoP10, profile, distanceM, durationSec, degradedSnapshotCount, rcaConfidence: confidence, serviceImpact = null }) => {
    const clamp = (value, max) => Math.max(0, Math.min(max, value));
    const coverageSeverity = Number.isFinite(rscpP10)
      ? clamp((Number(profile.coverageEntryDbm) - rscpP10) / 15 * 20, 20) : 0;
    const qualitySeverity = Number.isFinite(ecnoP10)
      ? clamp((Number(profile.qualityEntryDb) - ecnoP10) / 10 * 20, 20) : 0;
    const radioSeverity = Number((coverageSeverity + qualitySeverity).toFixed(1));
    const extent = Number((clamp(Number(distanceM || 0) / 1500 * 15, 15) + clamp(Number(durationSec || 0) / 90 * 10, 10)).toFixed(1));
    const service = clamp((Number(serviceImpact?.dropCount || 0) * 14) + (Number(serviceImpact?.callSetupFailureCount || 0) * 8) + (Number(serviceImpact?.rlfCount || 0) * 10) + (Number(serviceImpact?.hofCount || 0) * 6), 20);
    const rca = ({ high: 10, medium: 7, low: 3 }[confidence] || 3);
    const recurrence = Number(clamp(Number(degradedSnapshotCount || 0) / 60 * 5, 5).toFixed(1));
    const total = Math.round(clamp(radioSeverity + extent + service + rca + recurrence, 100));
    return { radioSeverity, extent, serviceImpact: service, rcaConfidence: rca, recurrence, total };
  };

  const priorityEvidenceFor = (components) => `Severity ${components.radioSeverity}/40 · Extent ${components.extent}/25 · Service ${components.serviceImpact}/20 · RCA confidence ${components.rcaConfidence}/10 · Recurrence ${components.recurrence}/5 = Priority ${components.total}/100.`;

  const professionalConfidenceLabel = (confidence) => ({
    high: "Élevée",
    medium: "Moyenne",
    low: "Faible",
  }[String(confidence || "").toLowerCase()] || "À confirmer");

  const professionalRcaBadgeLabel = (code) => ({
    STRUCTURAL_COVERAGE_GAP: "Couverture structurelle",
    GENERAL_WEAK_COVERAGE: "Couverture",
    COVERAGE_AND_QUALITY_DEGRADATION: "Couverture + qualité",
    POTENTIAL_MISSING_NEIGHBOR: "Voisin manquant",
    INTRAFREQ_MOBILITY_ISSUE: "Mobilité intra-fréquence",
    INTERFREQ_MOBILITY_OPPORTUNITY: "Mobilité inter-fréquence",
    PILOT_POLLUTION_PROBABLE: "Pilot Pollution",
    LOW_DOMINANCE_RCA: "Faible dominance",
    QUALITY_DEGRADATION_DOMINANT_SERVING: "Qualité",
    PING_PONG_PROBABLE: "Ping-Pong",
    MOBILITY_INSTABILITY: "Instabilité mobilité",
    INCONCLUSIVE: "À investiguer",
  }[code] || "Analyse radio");

  const professionalNumber = (value, digits = 1) => Number.isFinite(Number(value))
    ? Number(value).toFixed(digits)
    : null;
  const professionalPercent = (value) => Number.isFinite(Number(value))
    ? Math.round(Number(value) * (Number(value) <= 1 ? 100 : 1))
    : null;
  const professionalCellName = (cell, fallback = "cellule non identifiée") => text(cell?.cellName || cell?.name) || fallback;

  function generateProfessionalRadioAnalysis(
    zoneFeatures,
    rcaResult,
    radioObservations,
    serviceImpact,
    macroContext,
  ) {
    const zone = zoneFeatures || {};
    const primary = rcaResult?.primaryRca || rcaResult?.primary || rcaResult || zone.primaryRca || {};
    const secondary = rcaResult?.secondaryRca || rcaResult?.secondary || zone.secondaryRca || null;
    const observations = Array.isArray(radioObservations) ? radioObservations : (zone.radioObservations || []);
    const impact = serviceImpact || zone.serviceImpact || {};
    const thresholds = zone.radioThresholds || {};
    const coverageThreshold = Number(thresholds.coverageEntryDbm ?? DEFAULT_PROFILE.coverageEntryDbm);
    const coverageCritical = Number(thresholds.coverageCriticalDbm ?? DEFAULT_PROFILE.coverageCriticalDbm);
    const credibleNeighbor = Number(thresholds.credibleNeighborDbm ?? DEFAULT_PROFILE.credibleNeighborDbm);
    const betterDelta = Number(thresholds.betterNeighborDeltaDb ?? DEFAULT_PROFILE.betterNeighborDeltaDb);
    const rscpP50 = professionalNumber(zone.servingRscp?.median);
    const rscpP10 = professionalNumber(zone.servingRscp?.p10);
    const ecnoP50 = professionalNumber(zone.servingEcno?.median);
    const ecnoP10 = professionalNumber(zone.servingEcno?.p10);
    const weakCoverage = professionalPercent(zone.weakAvailableCoverageRatioDegraded);
    const best = zone.bestRecurrentNeighbor || zone.bestAlternativeCell || null;
    const bestRscp = professionalNumber(best?.rscpMedian);
    const bestEcno = professionalNumber(best?.ecnoMedian);
    const bestDelta = professionalNumber(best?.deltaVsServingMedian ?? best?.deltaMedian);
    const bestPresence = professionalPercent(best?.presenceRatio);
    const bestIsCredible = Number.isFinite(Number(best?.rscpMedian)) && Number(best.rscpMedian) >= credibleNeighbor;
    const bestIsSignificantlyBetter = bestIsCredible
      && Number.isFinite(Number(best?.deltaVsServingMedian ?? best?.deltaMedian))
      && Number(best.deltaVsServingMedian ?? best.deltaMedian) >= betterDelta;
    const observationCodes = new Set(observations.map((observation) => observation?.code).filter(Boolean));
    const lowDominanceObserved = observationCodes.has("LOW_DOMINANCE_OBSERVED");
    const trigger = primary.triggerCell || secondary?.triggerCell || null;
    const confidence = professionalConfidenceLabel(primary.confidence);
    const primaryLabel = primary.label || rcaMeta(primary.code)[0];
    const severeCoverage = Number(zone.servingRscp?.p10) <= coverageCritical
      || Number(zone.servingRscp?.median) <= coverageThreshold - 5;
    const parts = [];

    if (primary.code === "GENERAL_WEAK_COVERAGE" || primary.code === "STRUCTURAL_COVERAGE_GAP") {
      const extent = weakCoverage !== null && weakCoverage >= 95 ? "sur l’ensemble de la zone" : "sur la majorité de la zone";
      parts.push(`Couverture ${severeCoverage ? "sévèrement " : ""}insuffisante ${extent}.`);
      if (rscpP50 !== null || rscpP10 !== null) {
        parts.push(`RSCP P50/P10 ${rscpP50 ?? "N/D"}/${rscpP10 ?? "N/D"} dBm.`);
      }
      if (best && bestRscp !== null) {
        if (bestIsSignificantlyBetter) {
          parts.push(`Une meilleure cellule est disponible à ${bestRscp} dBm, soit +${bestDelta} dB par rapport au Serving.`);
        } else if (!bestIsCredible) {
          parts.push(`Le meilleur voisin reste lui-même insuffisant à ${bestRscp} dBm${bestEcno !== null ? ` (Ec/N0 ${bestEcno} dB)` : ""}, sans alternative de couverture exploitable${weakCoverage !== null ? ` sur ${weakCoverage} % de la zone` : ""}.`);
        } else {
          parts.push(`Le voisin disponible à ${bestRscp} dBm ne présente pas un gain suffisant pour constituer une alternative de mobilité.`);
        }
      } else {
        parts.push(`Aucun voisin ne fournit une couverture alternative suffisante${weakCoverage !== null ? ` (${weakCoverage} % de couverture disponible faible)` : ""}.`);
      }
      if (lowDominanceObserved && primary.code === "GENERAL_WEAK_COVERAGE") {
        parts.push("Faible dominance observée, secondaire au déficit de couverture.");
      }
      parts.push(`RCA : ${primaryLabel}.`);
    } else if (primary.code === "POTENTIAL_MISSING_NEIGHBOR") {
      const triggerName = professionalCellName(trigger, "cellule Detected non identifiée");
      parts.push(`Une cellule Detected forte et persistante est observée : ${triggerName}, RSCP P50 ${professionalNumber(trigger?.rscpMedian) ?? "N/D"} dBm, Δ +${professionalNumber(trigger?.deltaVsServingMedian) ?? "N/D"} dB, présence ${professionalPercent(trigger?.presenceRatio) ?? "N/D"} %.`);
      parts.push("La couverture est disponible mais cette cellule ne semble pas correctement exploitée. RCA : voisin manquant potentiel.");
    } else if (primary.code === "INTRAFREQ_MOBILITY_ISSUE") {
      const mobilityNeighbor = trigger || best;
      parts.push(`Le Serving reste défavorable alors qu’un voisin co-fréquence significativement meilleur est disponible sur ${professionalPercent(mobilityNeighbor?.presenceRatio) ?? "N/D"} % de la zone (${professionalNumber(mobilityNeighbor?.rscpMedian) ?? "N/D"} dBm, Δ +${professionalNumber(mobilityNeighbor?.deltaVsServingMedian) ?? "N/D"} dB).`);
      parts.push("RCA : mobilité intra-frequency à vérifier.");
    } else if (primary.code === "INTERFREQ_MOBILITY_OPPORTUNITY") {
      const mobilityNeighbor = trigger || zone.bestRecurrentInterFreqNeighbor || best;
      parts.push(`Une couverture alternative inter-fréquence est disponible via ${professionalCellName(mobilityNeighbor)} à ${professionalNumber(mobilityNeighbor?.rscpMedian) ?? "N/D"} dBm (Δ +${professionalNumber(mobilityNeighbor?.deltaVsServingMedian) ?? "N/D"} dB).`);
      parts.push("RCA : mobilité inter-frequency à investiguer.");
    } else if (primary.code === "PILOT_POLLUTION_PROBABLE") {
      const dominance = professionalNumber(zone.pilotDominanceMargin?.median);
      const snapshotRatio = professionalPercent(zone.pilotPollutionSnapshotRatio);
      const spatialRatio = professionalPercent(zone.pilotPollutionSpatialRatio);
      parts.push(`Qualité fortement dégradée malgré un niveau radio exploitable${ecnoP50 !== null || ecnoP10 !== null ? ` (Ec/N0 P50/P10 ${ecnoP50 ?? "N/D"}/${ecnoP10 ?? "N/D"} dB)` : ""}.`);
      parts.push(`${professionalNumber(zone.significantPilotCountP50, 0) ?? "Plusieurs"} pilotes co-fréquence significatifs sont simultanément présents avec une faible dominance${dominance !== null ? ` (${dominance} dB)` : ""}. ${snapshotRatio ?? "N/D"} % des snapshots${spatialRatio !== null ? ` / ${spatialRatio} % de la distance` : ""} sont compatibles avec une compétition co-fréquence. RCA : Pilot Pollution probable.`);
    } else if (primary.code === "LOW_DOMINANCE_RCA") {
      parts.push(`Qualité dégradée associée à une faible dominance radio : écart médian entre les deux meilleurs pilotes ${professionalNumber(zone.pilotDominanceMargin?.median) ?? "N/D"} dB.`);
      parts.push("Le chevauchement co-fréquence est susceptible de contribuer à la dégradation. RCA : faible dominance radio à vérifier.");
    } else if (primary.code === "QUALITY_DEGRADATION_DOMINANT_SERVING") {
      parts.push(`Ec/N0 dégradé${ecnoP50 !== null || ecnoP10 !== null ? ` (P50/P10 ${ecnoP50 ?? "N/D"}/${ecnoP10 ?? "N/D"} dB)` : ""} malgré un bon niveau RSCP et un Serving suffisamment dominant.`);
      parts.push("Le voisinage observé n’explique pas la dégradation ; charge, interférence externe, hardware ou configuration sont à investiguer.");
    } else if (primary.code === "PING_PONG_PROBABLE") {
      const sequence = Array.isArray(zone.compressedServingSequence) ? zone.compressedServingSequence.slice(0, 3) : [];
      parts.push(`Instabilité de mobilité observée${sequence.length >= 3 ? ` avec séquence ${sequence.join(" → ")}` : ""} sur ${Math.round(Number(zone.zoneDistanceM || 0))} m / ${professionalNumber(zone.zoneDurationSec) ?? "N/D"} s.`);
      parts.push("RCA : Ping-Pong mobilité probable.");
    } else if (primary.code === "MOBILITY_INSTABILITY") {
      parts.push(`Instabilité de mobilité observée avec ${Number(zone.servingChanges || 0)} changements entre ${Number(zone.servingCellsCount || 0)} cellules Serving.`);
      parts.push("La dominance et les paramètres de mobilité sont à vérifier.");
    } else {
      parts.push(`Dégradation radio observée${rscpP50 !== null ? `, RSCP P50 ${rscpP50} dBm` : ""}${ecnoP50 !== null ? `, Ec/N0 P50 ${ecnoP50} dB` : ""}.`);
      parts.push(`RCA la plus compatible : ${primaryLabel || "à investiguer"}.`);
    }

    if (secondary?.code === "PING_PONG_PROBABLE" && primary.code !== "PING_PONG_PROBABLE") {
      parts.push(primary.code === "GENERAL_WEAK_COVERAGE"
        ? "Un Ping-Pong est également observé et peut être favorisé par l’absence de dominance dans cette zone de faible couverture."
        : "Un Ping-Pong est également observé comme facteur secondaire de mobilité.");
    } else if (lowDominanceObserved && primary.code !== "LOW_DOMINANCE_RCA" && primary.code !== "GENERAL_WEAK_COVERAGE") {
      parts.push("Faible dominance observée en complément, sans être retenue comme cause principale.");
    }

    if (impact.hasDirectServiceImpact) {
      parts.push(`Impact service confirmé : ${Number(impact.dropCount || 0)} Drop Call, ${Number(impact.callSetupFailureCount || 0)} Call Failure.`);
    } else if (impact.hasNearbyServiceImpact) {
      parts.push("Un événement service est observé à proximité immédiate de la zone.");
    }

    if (macroContext && Number(macroContext.microZoneCount || 0) >= 2) {
      const macroDistance = Number(macroContext.corridorDistanceM ?? macroContext.degradedDistanceM);
      parts.push(`Cette dégradation appartient à une zone étendue${Number.isFinite(macroDistance) ? ` de ${(macroDistance / 1000).toFixed(2)} km` : ""} regroupant ${macroContext.microZoneCount} micro-zones.`);
      if (Number(macroContext.dropCount || 0) || Number(macroContext.callSetupFailureCount || 0)) {
        parts.push(`Macro-zone associée : ${Number(macroContext.dropCount || 0)} Drop + ${Number(macroContext.callSetupFailureCount || 0)} Call Failure.`);
      }
    }

    const shortAnalysis = parts.join(" ").replace(/\s+/g, " ").trim();
    const evidence = Array.isArray(primary.evidence) && primary.evidence.length
      ? primary.evidence.join(" ; ")
      : "Aucune preuve RCA structurée supplémentaire.";
    const detailedAnalysis = [
      shortAnalysis,
      `RCA principale : ${primaryLabel || "À investiguer"} — confiance ${confidence}.`,
      secondary ? `RCA secondaire : ${secondary.label || rcaMeta(secondary.code)[0]} — confiance ${professionalConfidenceLabel(secondary.confidence)}.` : "RCA secondaire : aucune hypothèse distincte suffisamment supportée.",
      `Evidence radio : ${evidence}`,
    ].join("\n\n");
    return { shortAnalysis, detailedAnalysis };
  }

  function generateRecommendedAction(primaryRca, secondaryRca, zoneFeatures, serviceImpact, geometry) {
    const primary = primaryRca || {};
    const secondary = secondaryRca || null;
    const zone = zoneFeatures || {};
    const impact = serviceImpact || zone.serviceImpact || {};
    const serving = zone.dominantServingName || professionalCellName(zone.dominantServing, "Serving");
    const trigger = primary.triggerCell || secondary?.triggerCell || zone.bestRecurrentNeighbor || null;
    const neighbor = professionalCellName(trigger, "voisin concerné");
    let actionShort;
    let steps;
    switch (primary.code) {
      case "STRUCTURAL_COVERAGE_GAP":
        actionShort = geometry?.available
          ? "Étudier une solution de couverture de la zone après validation des possibilités d’optimisation de l’existant."
          : "Vérifier d’abord la couverture et la géométrie des sites existants avant toute conclusion structurelle.";
        steps = ["Valider la géométrie BDD et la disponibilité des sites autour de la zone.", "Vérifier azimut, tilt, puissance et couverture existante.", "Étudier une solution de couverture seulement si l’optimisation de l’existant reste insuffisante."];
        break;
      case "GENERAL_WEAK_COVERAGE":
      case "COVERAGE_AND_QUALITY_DEGRADATION":
        actionShort = "Priorité couverture : vérifier les sites/secteurs environnants, azimuts, tilts, puissance et disponibilité des couches ; étudier une solution de couverture si l’optimisation de l’existant reste insuffisante.";
        steps = ["Vérifier la disponibilité des sites et couches autour de la zone.", "Vérifier les alarmes et cellules indisponibles lorsque la BDD et les KPI réseau sont disponibles.", "Contrôler azimut, tilt, puissance et couverture existante.", "Évaluer les gains possibles par optimisation RF.", "Si aucun site existant n’apporte une couverture suffisante, lancer une étude de solution de couverture."];
        break;
      case "POTENTIAL_MISSING_NEIGHBOR":
        actionShort = `Vérifier la relation de voisinage de ${neighbor} dans le RNC, l’Active/Monitored Set et les paramètres SHO/HO.`;
        steps = [actionShort, "Confirmer la présence et la persistance de la cellule Detected dans les traces RRC/L3."];
        break;
      case "INTRAFREQ_MOBILITY_ISSUE":
        actionShort = `Vérifier Active Set, relations de voisinage, thresholds SHO/HO, hystérésis et timers entre ${serving} et ${neighbor}.`;
        steps = [actionShort, "Corréler les transitions avec les événements RRC/L3 et les paramètres RNC."];
        break;
      case "INTERFREQ_MOBILITY_OPPORTUNITY":
        actionShort = "Vérifier thresholds et paramètres de mobilité inter-frequency, priorités de couches et conditions de déclenchement.";
        steps = [actionShort, `Contrôler la relation et la stratégie de mobilité vers ${neighbor}.`];
        break;
      case "PILOT_POLLUTION_PROBABLE":
        actionShort = "Optimiser la dominance : analyser overlap, tilt, azimut, puissance CPICH et contribution des pilotes co-fréquence.";
        steps = [actionShort, "Confirmer la compétition avec RTWP/interférence, KPI RNC et mesures complémentaires avant optimisation."];
        break;
      case "LOW_DOMINANCE_RCA":
        actionShort = "Renforcer la dominance du secteur cible et réduire les overlaps co-fréquence inutiles.";
        steps = [actionShort, "Vérifier tilt, azimut, puissance CPICH et cohérence du voisinage."];
        break;
      case "QUALITY_DEGRADATION_DOMINANT_SERVING":
        actionShort = "Corréler avec charge cellule, KPI RNC, RTWP/interférence, alarmes HW et configuration radio.";
        steps = [actionShort, "Ne conclure à aucune cause sans confirmation par les données réseau."];
        break;
      case "PING_PONG_PROBABLE":
      case "MOBILITY_INSTABILITY":
        actionShort = "Vérifier hystérésis, timers, Active Set/SHO et overlap entre les cellules impliquées.";
        steps = [actionShort, "Rejouer la séquence Serving avec les événements RRC/L3 pour identifier le déclenchement."];
        break;
      default:
        actionShort = "Poursuivre l’investigation avec les paramètres RNC, la signalisation, la charge, le RTWP, les alarmes et la configuration radio.";
        steps = [actionShort];
    }
    if (impact.hasDirectServiceImpact) {
      const servicePrefix = `Priorité élevée — ${Number(impact.dropCount || 0)} Drop Call et ${Number(impact.callSetupFailureCount || 0)} Call Failure observés.`;
      actionShort = `${servicePrefix} ${actionShort}`;
      steps.unshift(`${servicePrefix} Corréler les événements avec les traces RRC/L3 et les KPI RNC.`);
    }
    return {
      actionShort,
      actionDetailed: steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
    };
  }

  function buildRadioAnalysisPresentationModel(
    zoneFeatures,
    rcaResult,
    radioObservations,
    serviceImpact,
    macroContext,
  ) {
    const zone = zoneFeatures || {};
    const primary = rcaResult?.primaryRca || rcaResult?.primary || rcaResult || zone.primaryRca || {};
    const secondary = rcaResult?.secondaryRca || rcaResult?.secondary || zone.secondaryRca || null;
    const impact = serviceImpact || zone.serviceImpact || {};
    const analysis = generateProfessionalRadioAnalysis(zone, { primaryRca: primary, secondaryRca: secondary }, radioObservations, impact, macroContext);
    const action = generateRecommendedAction(primary, secondary, zone, impact, zone.geometry || {});
    const confidenceLabel = professionalConfidenceLabel(primary.confidence);
    const rscpP10 = zone.servingRscp?.p10;
    const ecnoP10 = zone.servingEcno?.p10;
    const severityLabel = (rscpP10 !== null && rscpP10 !== undefined && Number.isFinite(Number(rscpP10))
      && Number(rscpP10) <= Number(zone.radioThresholds?.coverageCriticalDbm ?? DEFAULT_PROFILE.coverageCriticalDbm))
      || (ecnoP10 !== null && ecnoP10 !== undefined && Number.isFinite(Number(ecnoP10))
      && Number(ecnoP10) <= Number(zone.radioThresholds?.qualityCriticalDb ?? DEFAULT_PROFILE.qualityCriticalDb))
      ? "Sévère"
      : "Significative";
    const badges = [
      { kind: "rca", label: `RCA: ${professionalRcaBadgeLabel(primary.code)}` },
      { kind: "confidence", label: `Confiance: ${confidenceLabel}` },
      { kind: "score", label: `Score RCA: ${primary.finalSelectionScore ?? primary.score ?? "N/D"}/100` },
    ];
    if (impact.hasDirectServiceImpact) badges.push({ kind: "impact", label: "Impact service" });
    else if (impact.hasNearbyServiceImpact) badges.push({ kind: "nearby", label: "Service proche" });
    if (macroContext && Number(macroContext.microZoneCount || 0) >= 2) badges.push({ kind: "macro", label: "Macro-zone" });
    return {
      analysisShort: analysis.shortAnalysis,
      analysisDetailed: analysis.detailedAnalysis,
      actionShort: action.actionShort,
      actionDetailed: action.actionDetailed,
      badges: badges.slice(0, 4),
      severityLabel,
      impactLabel: impact.hasDirectServiceImpact ? "Impact service confirmé" : impact.hasNearbyServiceImpact ? "Événement service proche" : "Sans impact service direct",
    };
  }

  // This is intentionally the only type derivation for a radio zone. The
  // legacy coverage/quality candidate streams are not consulted here.
  const deriveZoneDegradationType = (features, profile) => {
    const total = Number(features?.zoneSnapshotCount || features?.snapshotCount || 0);
    const enough = (count) => count >= Number(profile.minTypeSupportSnapshots) && ratio(count, total) >= Number(profile.minTypeSupportRatio);
    const coverage = Number(features?.coverageOnlyCount || 0) + Number(features?.bothCount || 0);
    const quality = Number(features?.qualityOnlyCount || 0) + Number(features?.bothCount || 0);
    const both = Number(features?.bothCount || 0);
    const spatialEnough = (value) => Number(value ?? 0) >= Number(profile.minTypeSpatialSupport ?? 0);
    // Category run settings control episode detection only.  Once a valid
    // zone exists, its final type is derived solely from the explicit zone
    // type support settings.  Otherwise a 3/5 BOTH zone was incorrectly
    // downgraded when the independent quality-run threshold happened to be 5.
    const coveragePersistent = enough(coverage) && spatialEnough(features?.coverageSpatialSupport);
    const qualityPersistent = enough(quality) && spatialEnough(features?.qualitySpatialSupport);
    if (coveragePersistent && qualityPersistent && enough(both) && spatialEnough(features?.bothSpatialSupport)) return { type: "COMBINED_RADIO_DEGRADATION", category: "combined" };
    if (coveragePersistent && qualityPersistent) return { type: "MIXED_RADIO_DEGRADATION", category: "mixed" };
    if (coveragePersistent) return { type: "COVERAGE_DEGRADATION", category: "coverage" };
    if (qualityPersistent) return { type: "QUALITY_DEGRADATION", category: "quality" };
    return coverage >= quality ? { type: "COVERAGE_DEGRADATION", category: "coverage" } : { type: "QUALITY_DEGRADATION", category: "quality" };
  };

  // Kept deliberately separate from deriveZoneDegradationType so the
  // integrity report can catch a regression in the production derivation.
  const expectedZoneDegradationType = (features, profile) => {
    const total = Number(features?.zoneSnapshotCount || features?.snapshotCount || 0);
    const requiredCount = Number(profile.minTypeSupportSnapshots);
    const requiredRatio = Number(profile.minTypeSupportRatio);
    const requiredSpatial = Number(profile.minTypeSpatialSupport ?? 0);
    const qualifies = (count, spatial) => count >= requiredCount
      && (total ? count / total : 0) >= requiredRatio
      && Number(spatial ?? 0) >= requiredSpatial;
    const coverage = Number(features?.coverageOnlyCount || 0) + Number(features?.bothCount || 0);
    const quality = Number(features?.qualityOnlyCount || 0) + Number(features?.bothCount || 0);
    const both = Number(features?.bothCount || 0);
    const coverageOk = qualifies(coverage, features?.coverageSpatialSupport);
    const qualityOk = qualifies(quality, features?.qualitySpatialSupport);
    if (coverageOk && qualityOk && qualifies(both, features?.bothSpatialSupport)) return "COMBINED_RADIO_DEGRADATION";
    if (coverageOk && qualityOk) return "MIXED_RADIO_DEGRADATION";
    return coverageOk || coverage >= quality ? "COVERAGE_DEGRADATION" : "QUALITY_DEGRADATION";
  };

  // ZoneRadioFeatures is the only business object consumed by the RCA, UI,
  // map and XLSX exporters. `allRows` contains the complete recovered route
  // zone; raw crossings are a subset and are the only RCA degradation proof.
  const buildZoneDiagnostic = (allRows, profile) => {
    const rows = (allRows || []).filter(Boolean);
    const degradedRows = rows.filter((row) => row.rawCoverage || row.rawQuality);
    if (!degradedRows.length) return null;
    const snapshotCount = rows.length;
    const degradedSnapshotCount = degradedRows.length;
    const zoneDurationSec = snapshotCount > 1 && Number.isFinite(rows[0].snapshot.timeMs) && Number.isFinite(rows[snapshotCount - 1].snapshot.timeMs)
      ? Math.max(0, (rows[snapshotCount - 1].snapshot.timeMs - rows[0].snapshot.timeMs) / 1000) : 0;
    const zoneDistanceM = rows.slice(1).reduce((sum, row, index) => sum + haversineM(rows[index].snapshot, row.snapshot), 0);
    const spatialSupport = (predicate) => {
      let coveredDistance = 0;
      rows.slice(1).forEach((row, index) => {
        if (predicate(row)) coveredDistance += haversineM(rows[index].snapshot, row.snapshot);
      });
      const count = rows.filter(predicate).length;
      return zoneDistanceM > 0 ? ratio(coveredDistance, zoneDistanceM) : ratio(count, snapshotCount);
    };
    const coverageSpatialSupport = spatialSupport((row) => row.rawCoverage);
    const qualitySpatialSupport = spatialSupport((row) => row.rawQuality);
    const bothSpatialSupport = spatialSupport((row) => row.rawCoverage && row.rawQuality);
    const bridgeRows = rows.filter((row) => row.snapshotState === "RECOVERY_BRIDGE");
    const normalRows = rows.filter((row) => !row.rawCoverage && !row.rawQuality);
    const rscpStats = numericStats(rows.map((row) => row.cell.rscp));
    const ecnoStats = numericStats(rows.map((row) => row.cell.ecno));
    const degradedRscpStats = numericStats(degradedRows.map((row) => row.cell.rscp));
    const degradedEcnoStats = numericStats(degradedRows.map((row) => row.cell.ecno));
    const contexts = rows.map((row) => describeNeighborContext(row.snapshot, row.cell, profile));
    const degradedContexts = degradedRows.map((row) => describeNeighborContext(row.snapshot, row.cell, profile));
    const coverageRows = degradedRows.filter((row) => row.rawCoverage);
    const qualityRows = degradedRows.filter((row) => row.rawQuality);
    const bothRows = degradedRows.filter((row) => row.rawCoverage && row.rawQuality);
    const servingCounts = new Map();
    const neighborMap = new Map();
    const featureRows = rows.map((row, index) => {
      const serving = row.cell;
      const context = contexts[index];
      const allCells = [serving, ...(row.snapshot.monitoredNeighbors || []), ...(row.snapshot.detectedNeighbors || [])]
        .filter((cell) => Number.isFinite(cell?.rscp));
      const bestAvailableRscp = allCells.length ? Math.max(...allCells.map((cell) => cell.rscp)) : null;
      const servingKey = cellIdentity(serving);
      servingCounts.set(servingKey, { cell: serving, count: (servingCounts.get(servingKey)?.count || 0) + 1 });
      const seenNeighbors = new Set();
      [...(row.snapshot.monitoredNeighbors || []), ...(row.snapshot.detectedNeighbors || [])].forEach((neighbor) => {
        const key = cellIdentity(neighbor);
        if (!key || seenNeighbors.has(key) || key === servingKey) return;
        seenNeighbors.add(key);
        const entry = neighborMap.get(key) || { cell: neighbor, snapshots: 0, rscp: [], ecno: [], deltas: [], monitored: 0, detected: 0, same: 0, inter: 0 };
        entry.snapshots += 1;
        if (Number.isFinite(neighbor.rscp)) entry.rscp.push(neighbor.rscp);
        if (Number.isFinite(neighbor.ecno)) entry.ecno.push(neighbor.ecno);
        if (Number.isFinite(neighbor.rscp) && Number.isFinite(serving.rscp)) entry.deltas.push(neighbor.rscp - serving.rscp);
        if (neighbor.role === "monitored") entry.monitored += 1;
        if (neighbor.role === "detected") entry.detected += 1;
        if (Number.isFinite(neighbor.channel) && Number.isFinite(serving.channel) && neighbor.channel === serving.channel) entry.same += 1;
        else if (Number.isFinite(neighbor.channel) && Number.isFinite(serving.channel)) entry.inter += 1;
        neighborMap.set(key, entry);
      });
      return { row, context, bestAvailableRscp, servingKey };
    });
    const servingCells = [...servingCounts.values()].sort((a, b) => b.count - a.count);
    const dominantServing = servingCells[0] || null;
    const servingChanges = rows.slice(1).reduce((sum, row, index) => sum + (cellIdentity(row.cell) !== cellIdentity(rows[index].cell) ? 1 : 0), 0);
    const neighbors = [...neighborMap.values()].map((entry) => {
      const rscp = numericStats(entry.rscp); const ecno = numericStats(entry.ecno); const delta = numericStats(entry.deltas);
      const type = entry.monitored && entry.detected ? "Mixte" : entry.detected ? "Detected" : "Monitored";
      return {
        ...publicCell(entry.cell), type, snapshotCount: entry.snapshots,
        presenceRatio: ratio(entry.snapshots, snapshotCount), rscpMedian: rscp.median, rscpP10: rscp.p10, rscpMin: rscp.min, rscpMax: rscp.max,
        ecnoMedian: ecno.median, ecnoP10: ecno.p10, ecnoMin: ecno.min, deltaMedian: delta.median, deltaVsServingMedian: delta.median,
        frequencyRelation: entry.same >= entry.inter ? "Same-frequency" : "Inter-frequency",
        monitoredRatio: ratio(entry.monitored, entry.snapshots), detectedRatio: ratio(entry.detected, entry.snapshots),
      };
    });
    const minPresence = Number(profile.bestNeighborMinPresenceRatio ?? 0.2);
    const minNeighborSnapshots = Math.max(1, Number(profile.bestNeighborMinSnapshots ?? 3));
    const recurrentNeighbors = neighbors.filter((neighbor) => neighbor.snapshotCount >= minNeighborSnapshots || neighbor.presenceRatio >= minPresence)
      .sort((a, b) => (Number(b.rscpMedian) || -Infinity) - (Number(a.rscpMedian) || -Infinity) || b.snapshotCount - a.snapshotCount);
    const bestRecurrentSameFreqNeighbor = recurrentNeighbors.find((neighbor) => neighbor.frequencyRelation === "Same-frequency") || null;
    const bestRecurrentInterFreqNeighbor = recurrentNeighbors.find((neighbor) => neighbor.frequencyRelation === "Inter-frequency") || null;
    const bestRecurrentNeighbor = recurrentNeighbors[0] || null;
    const bestAlternativeCell = recurrentNeighbors.filter((neighbor) => cellIdentity(neighbor) !== cellIdentity(dominantServing?.cell))[0] || null;
    const weakAvailable = featureRows.filter((feature) => Number.isFinite(feature.bestAvailableRscp) && feature.bestAvailableRscp <= profile.coverageEntryDbm);
    const weakAvailableDegraded = featureRows.filter((feature) => (feature.row.rawCoverage || feature.row.rawQuality) && Number.isFinite(feature.bestAvailableRscp) && feature.bestAvailableRscp <= profile.coverageEntryDbm);
    const weakAvailableCoverageRatio = ratio(weakAvailable.length, snapshotCount);
    const weakAvailableCoverageRatioDegraded = ratio(weakAvailableDegraded.length, degradedSnapshotCount);
    // Both the zone margin and the low-dominance ratios must come from this
    // exact per-snapshot pilot population.  Do not infer low dominance from
    // the selected RCA: pilot pollution may legitimately be the primary RCA
    // on the very same snapshots.
    const dominanceStats = numericStats(contexts.map((context) => context.pilotDominanceMarginDb));
    const isLowDominance = (context) => Number.isFinite(context?.pilotDominanceMarginDb)
      && context.pilotDominanceMarginDb <= Number(profile.weakDominanceDb);
    const lowDominanceRatio = ratio(contexts.filter(isLowDominance).length, snapshotCount);
    const pilotPollutionRatio = ratio(contexts.filter((context) => context.pilotPollutionCompatible).length, snapshotCount);
    const detectedStrongNeighborRatio = ratio(contexts.filter((context) => context.primaryCode === "MISSING_NEIGHBOR").length, snapshotCount);
    // Serving-only sequence: observations and RCA evaluators may use it, but
    // it never affects the already-stable zone segmentation.
    const servingSequence = rows.map((row) => cellIdentity(row.cell));
    const compressedServingSequence = servingSequence.filter((identity, index) => index === 0 || identity !== servingSequence[index - 1]);
    const servingTransitionCount = Math.max(0, compressedServingSequence.length - 1);
    const reversePatterns = [];
    for (let index = 0; index + 2 < compressedServingSequence.length;) {
      if (compressedServingSequence[index] === compressedServingSequence[index + 2]) {
        reversePatterns.push(compressedServingSequence.slice(index, index + 3));
        index += 2;
      } else index += 1;
    }
    const reverseTransitionCount = reversePatterns.length;
    const pingDurationOk = zoneDurationSec <= Number(profile.maxPingPongDurationSec);
    const pingDistanceOk = zoneDistanceM <= Number(profile.maxPingPongDistanceM);
    const mobilityInstability = servingCells.length >= 3 && servingChanges >= 3;
    const pingPong = servingTransitionCount >= 2 && reverseTransitionCount >= Number(profile.minimumReverseTransitions) && pingDurationOk && pingDistanceOk;
    const support = (predicate) => {
      let samples = 0; let distance = 0; let totalDistance = 0;
      featureRows.forEach((feature, index) => {
        const isDegraded = feature.row.rawCoverage || feature.row.rawQuality;
        if (isDegraded && predicate(feature)) samples += 1;
        if (index === 0) return;
        const step = haversineM(featureRows[index - 1].row.snapshot, feature.row.snapshot);
        totalDistance += step;
        if (isDegraded && predicate(feature)) distance += step;
      });
      const snapshotRatio = ratio(samples, degradedSnapshotCount);
      return { snapshots: samples, snapshotRatio, spatialRatio: totalDistance > 0 ? ratio(distance, totalDistance) : snapshotRatio };
    };
    const lowDomSupport = support((feature) => isLowDominance(feature.context));
    const pollutionSupport = support((feature) => feature.context.pilotPollutionCompatible);
    const multipleSignificantPilotSupport = support((feature) => feature.context.significantSameFrequencyPilots >= 2);
    const weakAvailableSupport = support((feature) => Number.isFinite(feature.bestAvailableRscp) && feature.bestAvailableRscp <= profile.coverageEntryDbm);
    const bestAvailableRscpStats = numericStats(featureRows.map((feature) => feature.bestAvailableRscp));
    const qualitySupportRatio = ratio(qualityRows.length, degradedSnapshotCount);
    const significantPilotCountP50 = numericStats(contexts.map((context) => context.significantSameFrequencyPilots)).median ?? 0;
    const radioObservations = [];
    const observe = (code, label, active, supportInfo, evidence) => {
      if (!active) return;
      radioObservations.push({ code, label, supportSnapshotRatio: supportInfo?.snapshotRatio ?? 0, supportSpatialRatio: supportInfo?.spatialRatio ?? 0, supportSnapshots: supportInfo?.snapshots ?? 0, evidence: Array.isArray(evidence) ? evidence : [evidence] });
    };
    observe("LOW_DOMINANCE_OBSERVED", "Faible dominance observée", lowDomSupport.snapshots > 0, lowDomSupport, `Pilot1 − Pilot2 ≤ ${profile.weakDominanceDb} dB sur ${Math.round(lowDomSupport.snapshotRatio * 100)} % des snapshots dégradés`);
    observe("MULTIPLE_COCHANNEL_PILOTS", "Plusieurs pilotes co-fréquence significatifs", multipleSignificantPilotSupport.snapshots > 0, multipleSignificantPilotSupport, `${significantPilotCountP50} pilote(s) ≥ ${profile.significantPilotDbm} dBm au P50`);
    observe("STRONG_ALTERNATIVE_CELL", "Cellule alternative forte", !!bestAlternativeCell && Number(bestAlternativeCell.rscpMedian) >= Number(profile.credibleNeighborDbm), { snapshots: bestAlternativeCell?.snapshotCount || 0, snapshotRatio: bestAlternativeCell?.presenceRatio || 0, spatialRatio: bestAlternativeCell?.presenceRatio || 0 }, bestAlternativeCell ? `${bestAlternativeCell.cellName} · RSCP P50 ${bestAlternativeCell.rscpMedian?.toFixed(1) ?? "N/D"} dBm · présence ${Math.round((bestAlternativeCell.presenceRatio || 0) * 100)} %` : "");
    observe("WEAK_AVAILABLE_COVERAGE", "Couverture disponible faible", weakAvailableCoverageRatioDegraded > 0, weakAvailableSupport, `${Math.round(weakAvailableCoverageRatioDegraded * 100)} % BestAvailableRSCP faible parmi les snapshots dégradés`);
    observe("SERVING_INSTABILITY", "Instabilité Serving observée", mobilityInstability, { snapshots: servingChanges, snapshotRatio: ratio(servingChanges, Math.max(1, snapshotCount - 1)), spatialRatio: ratio(servingChanges, Math.max(1, snapshotCount - 1)) }, `${servingChanges} changements Serving sur ${servingCells.length} cellules`);
    observe("PING_PONG_OBSERVED", "Ping-pong Serving observé", pingPong, { snapshots: reverseTransitionCount, snapshotRatio: ratio(reverseTransitionCount, Math.max(1, servingTransitionCount)), spatialRatio: ratio(reverseTransitionCount, Math.max(1, servingTransitionCount)) }, reversePatterns.length ? `Séquence ${reversePatterns[0].join(" → ")}` : "");
    const candidates = [];
    const triggerCellFor = (code) => {
      const minimumPresence = Number(profile.bestNeighborMinPresenceRatio ?? 0.2);
      const credibleDbm = Number(profile.credibleNeighborDbm ?? profile.coverageEntryDbm);
      const requiredDelta = Number(profile.betterNeighborDeltaDb ?? 6);
      const eligibleAggregate = (aggregate, role, sameFrequency) => aggregate
        && (role === "detected" ? aggregate.detectedRatio > 0 : aggregate.monitoredRatio > 0)
        && (sameFrequency ? aggregate.frequencyRelation === "Same-frequency" : aggregate.frequencyRelation === "Inter-frequency")
        && Number.isFinite(aggregate.rscpMedian)
        && Number.isFinite(aggregate.deltaVsServingMedian)
        && aggregate.rscpMedian >= credibleDbm
        && aggregate.deltaVsServingMedian >= requiredDelta
        && aggregate.presenceRatio >= minimumPresence;
      const role = code === "MISSING_NEIGHBOR" ? "detected" : "monitored";
      const sameFrequency = code !== "INTER_FREQ_MOBILITY";
      // The RCA is a zone conclusion. A one-off snapshot candidate cannot
      // become a high-score trigger when its recurrent P50/delta/presence no
      // longer meet the configured thresholds.
      const candidatesByAggregate = neighbors
        .filter((aggregate) => eligibleAggregate(aggregate, role, sameFrequency))
        .sort((a, b) => (b.deltaVsServingMedian - a.deltaVsServingMedian) || (b.rscpMedian - a.rscpMedian));
      const aggregateCandidate = candidatesByAggregate[0] || null;
      if (!aggregateCandidate) return null;
      for (const feature of featureRows) {
        const serving = feature.row.cell;
        const pool = [...(feature.row.snapshot.monitoredNeighbors || []), ...(feature.row.snapshot.detectedNeighbors || [])]
          .filter((cell) => Number.isFinite(cell?.rscp) && Number.isFinite(serving?.rscp));
        const isSame = (cell) => Number(cell.channel) === Number(serving.channel);
        const match = code === "MISSING_NEIGHBOR"
          ? pool.find((cell) => cellIdentity(cell) === cellIdentity(aggregateCandidate) && cell.role === "detected" && isSame(cell) && cell.rscp >= credibleDbm && cell.rscp - serving.rscp >= requiredDelta)
          : code === "INTRA_FREQ_MOBILITY"
            ? pool.find((cell) => cellIdentity(cell) === cellIdentity(aggregateCandidate) && cell.role === "monitored" && isSame(cell) && cell.rscp >= credibleDbm && cell.rscp - serving.rscp >= requiredDelta)
            : code === "INTER_FREQ_MOBILITY"
              ? pool.find((cell) => cellIdentity(cell) === cellIdentity(aggregateCandidate) && !isSame(cell) && cell.rscp >= credibleDbm && cell.rscp - serving.rscp >= requiredDelta)
              : null;
        if (!match) continue;
        return { cellName: aggregateCandidate.cellName, ci: aggregateCandidate.cellId, sc: aggregateCandidate.sc, uarfcn: aggregateCandidate.channel, setType: match.role, sameFrequency: isSame(match), rscpMedian: aggregateCandidate.rscpMedian, rscpP10: aggregateCandidate.rscpP10, ecnoMedian: aggregateCandidate.ecnoMedian, ecnoP10: aggregateCandidate.ecnoP10, deltaVsServingMedian: aggregateCandidate.deltaVsServingMedian, presenceRatio: aggregateCandidate.presenceRatio };
      }
      return null;
    };
    const add = (code, data) => {
      const meta = rcaMeta(code);
      const rawCompatibilityScore = Math.max(0, Math.min(100, Math.round(data.score)));
      const causalAdjustment = Number(data.causalAdjustment ?? (data.causalPrecedence ? 20 : 0));
      const finalSelectionScore = Math.max(0, Math.min(100, Math.round(rawCompatibilityScore + causalAdjustment)));
      if (!data.applicable) return;
      candidates.push({ code, label: meta[0], recommendation: meta[1], score: finalSelectionScore, rawCompatibilityScore, causalAdjustment, finalSelectionScore, causalPrecedence: Number(data.causalPrecedence || 0),
        confidence: rcaConfidence(finalSelectionScore, data.support.snapshots, profile), supportSnapshotRatio: data.support.snapshotRatio,
        supportSpatialRatio: data.support.spatialRatio, supportSnapshots: data.support.snapshots,
        evidence: data.evidence.filter(Boolean), triggerCell: data.triggerCell || null, rawScoreComponents: data.components || {} });
    };
    const score = (s, radio) => (s.spatialRatio * 40 + s.snapshotRatio * 30 + radio * 30);
    const structuralSupport = weakAvailableSupport;
    const structuralRatio = Number(profile.structuralCoverageMinRatio ?? 0.6);
    // Geometry is deliberately explicit. Current workbook-only analysis has no
    // antenna/site geometry, so a radio-only weak zone can never claim a
    // structural coverage gap with high confidence.
    const geometry = { available: false, closestServingDistanceM: null, closestAlternativeDistanceM: null, servingSiteName: null, alternativeSiteName: null, reason: "Géométrie BDD non disponible dans les données analysées" };
    add("STRUCTURAL_COVERAGE_GAP", {
      applicable: geometry.available && structuralSupport.snapshotRatio >= structuralRatio && coverageRows.length > 0,
      support: structuralSupport, score: score(structuralSupport, bestRecurrentNeighbor && Number(bestRecurrentNeighbor.rscpMedian) <= profile.coverageEntryDbm ? 1 : 0.7),
      evidence: [`${Math.round(weakAvailableCoverageRatioDegraded * 100)} % des snapshots dégradés ont BestAvailableRSCP ≤ ${profile.coverageEntryDbm} dBm`,
        `RSCP Serving P10 = ${rscpStats.p10?.toFixed(1) ?? "N/D"} dBm`, bestRecurrentNeighbor ? `Meilleur voisin récurrent : ${bestRecurrentNeighbor.cellName || "SC " + bestRecurrentNeighbor.sc}, médiane ${bestRecurrentNeighbor.rscpMedian?.toFixed(1) ?? "N/D"} dBm, présence ${Math.round(bestRecurrentNeighbor.presenceRatio * 100)} %` : "Aucun voisin récurrent exploitable observé"],
    });
    const generalWeakCoverageRatio = Number(profile.generalWeakCoverageMinRatio ?? 0.6);
    const weakCoverageCausalPrecedence = weakAvailableCoverageRatioDegraded >= generalWeakCoverageRatio && significantPilotCountP50 === 0;
    add("GENERAL_WEAK_COVERAGE", { applicable: coverageRows.length >= 2 && weakAvailableCoverageRatioDegraded >= generalWeakCoverageRatio, support: structuralSupport, causalPrecedence: weakCoverageCausalPrecedence ? 100 : 0, causalAdjustment: weakCoverageCausalPrecedence ? 20 : 0, score: score(structuralSupport, weakAvailableCoverageRatioDegraded), evidence: [`RSCP Serving P10 zone = ${rscpStats.p10?.toFixed(1) ?? "N/D"} dBm`, `${Math.round(weakAvailableCoverageRatioDegraded * 100)} % BestAvailableRSCP faible parmi les snapshots dégradés (seuil RCA ${Math.round(generalWeakCoverageRatio * 100)} %)`, significantPilotCountP50 === 0 ? "Aucun pilote co-fréquence ≥ seuil significatif au P50 : priorité causale couverture" : geometry.reason] });
    const byCode = (code) => support((feature) => feature.context.primaryCode === code);
    const intraTrigger = triggerCellFor("INTRA_FREQ_MOBILITY");
    const missingTrigger = triggerCellFor("MISSING_NEIGHBOR");
    const interTrigger = triggerCellFor("INTER_FREQ_MOBILITY");
    add("INTRAFREQ_MOBILITY_ISSUE", { applicable: byCode("INTRA_FREQ_MOBILITY").snapshots > 0, support: byCode("INTRA_FREQ_MOBILITY"), score: score(byCode("INTRA_FREQ_MOBILITY"), 1), triggerCell: intraTrigger, evidence: [intraTrigger ? `Cellule Monitored candidate : ${intraTrigger.cellName} · Δ ${intraTrigger.deltaVsServingMedian?.toFixed(1) ?? "N/D"} dB · présence ${Math.round((intraTrigger.presenceRatio || 0) * 100)} %` : "Voisin Monitored co-fréquence récurrent nettement meilleur que le Serving"] });
    add("POTENTIAL_MISSING_NEIGHBOR", { applicable: !!missingTrigger, support: byCode("MISSING_NEIGHBOR"), score: score(byCode("MISSING_NEIGHBOR"), 1), triggerCell: missingTrigger, evidence: [missingTrigger ? `Cellule Detected candidate : ${missingTrigger.cellName} · RSCP P50 ${missingTrigger.rscpMedian?.toFixed(1) ?? "N/D"} dBm (seuil ${profile.credibleNeighborDbm} dBm) · Δ ${missingTrigger.deltaVsServingMedian?.toFixed(1) ?? "N/D"} dB (seuil +${profile.betterNeighborDeltaDb} dB) · présence ${Math.round((missingTrigger.presenceRatio || 0) * 100)} %` : "Aucune cellule Detected ne respecte simultanément les seuils RSCP, Δ et présence de la zone"] });
    add("INTERFREQ_MOBILITY_OPPORTUNITY", { applicable: byCode("INTER_FREQ_MOBILITY").snapshots > 0, support: byCode("INTER_FREQ_MOBILITY"), score: score(byCode("INTER_FREQ_MOBILITY"), 0.9), triggerCell: interTrigger, evidence: [interTrigger ? `Cellule inter-fréquence candidate : ${interTrigger.cellName} · Δ ${interTrigger.deltaVsServingMedian?.toFixed(1) ?? "N/D"} dB` : "Meilleure couverture récurrente disponible sur une autre porteuse"] });
    const continuousPilotPollutionScore = Math.min(100, Math.round(
      30 * Math.min(1, qualitySupportRatio / Math.max(0.01, Number(profile.lowDominanceQualitySupportRatio ?? 0.2)))
      + 20 * Math.min(1, significantPilotCountP50 / Math.max(2, Number(profile.pilotPollutionMinPilots ?? 3)))
      + 15 * Math.min(1, Number(contexts.length ? numericStats(contexts.map((context) => context.strongSameFrequencyPilots)).median || 0 : 0) / Math.max(2, Number(profile.pilotPollutionMinPilots ?? 3)))
      + 15 * Math.max(0, Math.min(1, (Number(profile.weakDominanceDb) + 1 - (dominanceStats.median ?? Infinity)) / Math.max(1, Number(profile.weakDominanceDb) + 1)))
      + 12 * pollutionSupport.snapshotRatio
      + 8 * pollutionSupport.spatialRatio
    ));
    // Compatibility is continuous near support thresholds: a 49.8 % route
    // support remains a meaningful candidate instead of disappearing at 50 %.
    add("PILOT_POLLUTION_PROBABLE", { applicable: pollutionSupport.snapshots > 0, support: pollutionSupport, score: continuousPilotPollutionScore, evidence: [`Pilot Pollution Compatibility Score = ${continuousPilotPollutionScore}/100`, `Ec/N0 P10 = ${ecnoStats.p10?.toFixed(1) ?? "N/D"} dB`, `${Math.round(pollutionSupport.snapshotRatio * 100)} % snapshots / ${Math.round(pollutionSupport.spatialRatio * 100)} % distance compatibles avec une compétition co-fréquence`] });
    const lowDominanceRcaApplicable = lowDomSupport.snapshotRatio >= Number(profile.lowDominanceRcaMinRatio ?? 0.5)
      && (multipleSignificantPilotSupport.snapshots > 0 || (qualitySupportRatio >= Number(profile.lowDominanceQualitySupportRatio ?? 0.2) && Number.isFinite(bestAvailableRscpStats.median) && bestAvailableRscpStats.median >= Number(profile.significantPilotDbm)));
    add("LOW_DOMINANCE_RCA", { applicable: lowDominanceRcaApplicable, support: lowDomSupport, score: score(lowDomSupport, 0.8), evidence: [`Dominance pilotes P50/P10/min = ${dominanceStats.median?.toFixed(1) ?? "N/D"} / ${dominanceStats.p10?.toFixed(1) ?? "N/D"} / ${dominanceStats.min?.toFixed(1) ?? "N/D"} dB`, `Impact associé : qualité ${Math.round(qualitySupportRatio * 100)} % · pilotes significatifs simultanés ${Math.round(multipleSignificantPilotSupport.snapshotRatio * 100)} %`], components: { qualitySupportRatio, significantPilotSupportRatio: multipleSignificantPilotSupport.snapshotRatio, mobilityInstability, pingPongDetected: pingPong } });
    const dominantQualitySupport = byCode("QUALITY_SERVING_DOMINANT");
    add("QUALITY_DEGRADATION_DOMINANT_SERVING", { applicable: dominantQualitySupport.snapshots > 0, support: dominantQualitySupport, score: score(dominantQualitySupport, 0.75), evidence: ["Ec/N0 dégradé sans compétition co-fréquence locale évidente"] });
    const pingSupport = { snapshots: reverseTransitionCount, snapshotRatio: ratio(reverseTransitionCount, Math.max(1, servingTransitionCount)), spatialRatio: ratio(reverseTransitionCount, Math.max(1, servingTransitionCount)) };
    const pingEvidence = reversePatterns.length ? `Serving sequence ${reversePatterns[0].map((identity) => identity || "N/D").join(" → ")} observée sur ${zoneDurationSec.toFixed(1)} s / ${Math.round(zoneDistanceM)} m` : "Aucune séquence Serving A → B → A";
    add("PING_PONG_PROBABLE", { applicable: servingTransitionCount >= 2 && reverseTransitionCount >= Number(profile.minimumReverseTransitions) && pingDurationOk && pingDistanceOk, support: pingSupport, score: score(pingSupport, 0.9), evidence: [pingEvidence] });
    const instabilitySupport = { snapshots: servingChanges, snapshotRatio: ratio(servingChanges, Math.max(1, snapshotCount - 1)), spatialRatio: ratio(servingChanges, Math.max(1, snapshotCount - 1)) };
    add("MOBILITY_INSTABILITY", { applicable: servingCells.length >= 3 && servingChanges >= 3, support: instabilitySupport, score: score(instabilitySupport, 0.7), evidence: [`${servingCells.length} cellules Serving et ${servingChanges} changements Serving dans la zone`] });
    // Causal precedence is intentionally narrow: weak available coverage
    // with no significant co-channel pilot must not be displaced by a mere
    // low-dominance observation.
    candidates.sort((a, b) => b.finalSelectionScore - a.finalSelectionScore || b.causalPrecedence - a.causalPrecedence || b.supportSpatialRatio - a.supportSpatialRatio || b.supportSnapshotRatio - a.supportSnapshotRatio);
    if (!candidates.length) {
      const meta = rcaMeta("INCONCLUSIVE");
      candidates.push({ code: "INCONCLUSIVE", label: meta[0], recommendation: meta[1], score: 20, rawCompatibilityScore: 20, causalAdjustment: 0, finalSelectionScore: 20, causalPrecedence: 0, confidence: "low", supportSnapshotRatio: 0, supportSpatialRatio: 0, supportSnapshots: 0, evidence: ["Les mesures disponibles ne permettent pas de distinguer une RCA dominante."], rawScoreComponents: {} });
    }
    const primaryRca = candidates[0];
    const family = (code) => ({
      STRUCTURAL_COVERAGE_GAP: "coverage", GENERAL_WEAK_COVERAGE: "coverage", COVERAGE_AND_QUALITY_DEGRADATION: "coverage-quality",
      INTRAFREQ_MOBILITY_ISSUE: "mobility", POTENTIAL_MISSING_NEIGHBOR: "mobility", INTERFREQ_MOBILITY_OPPORTUNITY: "mobility", PING_PONG_PROBABLE: "mobility", MOBILITY_INSTABILITY: "mobility",
      LOW_DOMINANCE_RCA: "dominance", PILOT_POLLUTION_PROBABLE: "dominance", QUALITY_DEGRADATION_DOMINANT_SERVING: "quality",
    }[code] || code);
    const secondaryRca = candidates.find((candidate) => candidate.code !== primaryRca.code && candidate.score >= Number(profile.secondaryRcaMinScore ?? 50) && family(candidate.code) !== family(primaryRca.code)) || null;
    const first = rows[0].snapshot; const last = rows[rows.length - 1].snapshot;
    const zoneFeatures = {
      zoneId: null, startGps: { lat: first.lat, lng: first.lng }, endGps: { lat: last.lat, lng: last.lng },
      centerGps: { lat: (first.lat + last.lat) / 2, lng: (first.lng + last.lng) / 2 },
      // Counts are intentionally reconciled: normal includes recovery bridge
      // samples, with bridge retained as an explicit normal sub-state.
      zoneSnapshotCount: snapshotCount, snapshotCount, degradedSnapshotCount, zoneDurationSec, zoneDistanceM,
      normalSnapshotCount: normalRows.length, bridgeSnapshotCount: bridgeRows.length,
      degradedRatio: ratio(degradedSnapshotCount, snapshotCount), normalRatio: ratio(normalRows.length, snapshotCount), bridgeRatio: ratio(bridgeRows.length, snapshotCount),
      coverageOnlyCount: degradedRows.filter((row) => row.rawCoverage && !row.rawQuality).length,
      qualityOnlyCount: degradedRows.filter((row) => row.rawQuality && !row.rawCoverage).length,
      bothCount: bothRows.length,
      coverageSpatialSupport, qualitySpatialSupport, bothSpatialSupport,
      normalCount: normalRows.length,
      compositionInvariant: degradedRows.length + normalRows.length === snapshotCount,
      servingCells: servingCells.map(({ cell, count }) => ({ ...publicCell(cell), count, ratio: ratio(count, snapshotCount) })),
      servingCellsCount: servingCells.length, dominantServing: dominantServing ? { ...publicCell(dominantServing.cell), count: dominantServing.count, ratio: ratio(dominantServing.count, snapshotCount) } : null,
      dominantServingName: dominantServing ? displayCellName(dominantServing.cell) : null,
      dominantServingCI: dominantServing?.cell?.cellId ?? null,
      dominantServingSC: dominantServing?.cell?.sc ?? null,
      dominantServingUarfcn: dominantServing?.cell?.channel ?? null,
      startServing: publicCell(rows[0].cell), endServing: publicCell(rows[rows.length - 1].cell), worstPointServing: null,
      servingChanges, servingSequence, compressedServingSequence, servingTransitionCount, reverseTransitionCount, servingRscp: rscpStats, servingEcno: ecnoStats, degradedServingRscp: degradedRscpStats, degradedServingEcno: degradedEcnoStats,
      coverageOnlyRatio: ratio(degradedRows.filter((row) => row.rawCoverage && !row.rawQuality).length, snapshotCount), qualityOnlyRatio: ratio(degradedRows.filter((row) => row.rawQuality && !row.rawCoverage).length, snapshotCount), bothRatio: ratio(bothRows.length, snapshotCount),
      bestAvailableRscp: bestAvailableRscpStats, weakAvailableCoverageRatio, weakAvailableCoverageRatioDegraded, qualitySupportRatio,
      bestRecurrentNeighbor, bestRecurrentSameFreqNeighbor, bestRecurrentInterFreqNeighbor, bestNeighborAtWorstPoint: null, bestAlternativeCell, neighbors, pilotDominanceMargin: dominanceStats, dominanceMedian: dominanceStats.median,
      sameFreqPilotCountP50: numericStats(contexts.map((context) => context.sameFrequencyPilotCount)).median,
      sameFreqPilotCountP90: numericStats(contexts.map((context) => context.sameFrequencyPilotCount)).p90,
      sameFreqPilotCountMax: numericStats(contexts.map((context) => context.sameFrequencyPilotCount)).max,
      strongPilot100CountP50: numericStats(contexts.map((context) => context.significantSameFrequencyPilots)).median,
      strongPilot95CountP50: numericStats(contexts.map((context) => context.strongSameFrequencyPilots)).median,
      closePilotCountP50: numericStats(contexts.map((context) => context.nearBestPilotCount)).median,
      lowDominanceSnapshotRatio: lowDominanceRatio, lowDominanceSpatialRatio: lowDomSupport.spatialRatio, lowDominanceRcaApplicable, significantPilotCountP50, mobilityInstability, pingPongDetected: pingPong, pilotPollutionCompatibilityScore: continuousPilotPollutionScore, pilotPollutionSnapshotRatio: pollutionSupport.snapshotRatio, pilotPollutionSpatialRatio: pollutionSupport.spatialRatio, pilotPollutionRatio, detectedStrongNeighborRatio,
      geometry,
      radioThresholds: {
        coverageEntryDbm: profile.coverageEntryDbm,
        coverageCriticalDbm: profile.coverageCriticalDbm,
        qualityEntryDb: profile.qualityEntryDb,
        qualityCriticalDb: profile.qualityCriticalDb,
        credibleNeighborDbm: profile.credibleNeighborDbm,
        betterNeighborDeltaDb: profile.betterNeighborDeltaDb,
      },
      radioObservations, serviceImpact: { dropCount: 0, callSetupFailureCount: 0, rlfCount: 0, hofCount: 0, events: [], hasDirectServiceImpact: false, hasNearbyServiceImpact: false }, primaryRca, secondaryRca, allRcaCandidates: candidates,
    };
    zoneFeatures.zoneType = deriveZoneDegradationType(zoneFeatures, profile).type;
    zoneFeatures.radioCondition = ({
      COVERAGE_DEGRADATION: "COVERAGE_ONLY", QUALITY_DEGRADATION: "QUALITY_ONLY",
      COMBINED_RADIO_DEGRADATION: "COVERAGE_AND_QUALITY", MIXED_RADIO_DEGRADATION: "MIXED",
    })[zoneFeatures.zoneType] || "UNKNOWN";
    const primary = zoneFeatures.primaryRca;
    const neighbor = zoneFeatures.bestRecurrentNeighbor;
    const stat = (value, unit) => Number.isFinite(value) ? `${value.toFixed(1)} ${unit}` : "N/D";
    zoneFeatures.diagnosticText = `${primary.label} | Confiance ${confidenceLabel(primary.confidence)}\n\nZone GPS :\n${first.lat.toFixed(6)},${first.lng.toFixed(6)} → ${last.lat.toFixed(6)},${last.lng.toFixed(6)}\n${Math.round(zoneDistanceM)} m · ${zoneDurationSec.toFixed(1)} s\n\nServing dominant :\n${zoneFeatures.dominantServingName || "N/D"} (${Math.round((zoneFeatures.dominantServing?.ratio || 0) * 100)} %)\n\nRSCP zone :\nP50 ${stat(rscpStats.median, "dBm")} / P10 ${stat(rscpStats.p10, "dBm")}\nEc/N0 zone :\nP50 ${stat(ecnoStats.median, "dB")} / P10 ${stat(ecnoStats.p10, "dB")}\n\nMeilleur voisin récurrent :\n${neighbor?.cellName || "N/D"}\nRSCP P50/P10 ${stat(neighbor?.rscpMedian, "dBm")} / ${stat(neighbor?.rscpP10, "dBm")}\nEc/N0 P50/P10 ${stat(neighbor?.ecnoMedian, "dB")} / ${stat(neighbor?.ecnoP10, "dB")}\nPrésence ${Math.round((neighbor?.presenceRatio || 0) * 100)} % · Δ vs Serving ${stat(neighbor?.deltaVsServingMedian, "dB")}\n\nWeak Available Coverage : ${Math.round(weakAvailableCoverageRatioDegraded * 100)} % des snapshots dégradés\n\nPreuves RCA :\n${primary.evidence.join("\n")}\n\nAction :\n${primary.recommendation}`;
    return zoneFeatures;
  };

  const buildEpisodes = (snapshots, profile) => {
    const episodes = [];
    let current = [];
    let coverageHeld = false;
    let qualityHeld = false;
    let coverageRecovery = 0;
    let qualityRecovery = 0;
    let previousSnapshot = null;
    const quantile = (values, p) => {
      if (!values.length) return null;
      const index = (values.length - 1) * p;
      const low = Math.floor(index);
      const high = Math.ceil(index);
      return low === high ? values[low] : values[low] + (values[high] - values[low]) * (index - low);
    };
    const pct = (count, total) => total ? Number((count * 100 / total).toFixed(1)) : 0;
    const classifySegment = (coverageOnly, qualityOnly, both, zoneCount) => {
      const enough = (count) => count >= profile.minTypeSupportSnapshots && ratio(count, zoneCount) >= profile.minTypeSupportRatio;
      const coverageSupport = coverageOnly + both;
      const qualitySupport = qualityOnly + both;
      const coveragePersistent = enough(coverageSupport) && coverageSupport >= profile.coverageMinSamples;
      const qualityPersistent = enough(qualitySupport) && qualitySupport >= profile.qualityMinSamples;
      if (coveragePersistent && qualityPersistent && enough(both)) return { type: "COMBINED_RADIO_DEGRADATION", category: "combined" };
      if (coveragePersistent && qualityPersistent) return { type: "MIXED_RADIO_DEGRADATION", category: "mixed" };
      if (coveragePersistent) return { type: "COVERAGE_DEGRADATION", category: "coverage" };
      if (qualityPersistent) return { type: "QUALITY_DEGRADATION", category: "quality" };
      return coverageSupport >= qualitySupport && coverageSupport >= profile.coverageMinSamples
        ? { type: "COVERAGE_DEGRADATION", category: "coverage" }
        : { type: "QUALITY_DEGRADATION", category: "quality" };
    };
    const flush = () => {
      if (!current.length) return;
      // A bridge is only meaningful between two degradation groups. Remove a
      // trailing recovery before validating the zone, so D D D D B END is not
      // accepted as a five-point degradation and does not extend its GPS/time.
      while (current.length && !current[current.length - 1].rawCoverage && !current[current.length - 1].rawQuality) current.pop();
      if (!current.length) return;
      const degradedSnapshotCount = current.filter((row) => row.rawCoverage || row.rawQuality).length;
      const minDegradedSnapshots = Math.max(1, Number(profile.minDegradedSnapshots ?? Math.max(profile.coverageMinSamples, profile.qualityMinSamples)));
      if (degradedSnapshotCount < minDegradedSnapshots) return;
      const first = current[0];
      const last = current[current.length - 1];
      const durationSec = Number.isFinite(first.snapshot.timeMs) && Number.isFinite(last.snapshot.timeMs)
        ? (last.snapshot.timeMs - first.snapshot.timeMs) / 1000 : 0;
      let distanceM = 0;
      for (let i = 1; i < current.length; i += 1) distanceM += haversineM(current[i - 1].snapshot, current[i].snapshot);
      const minSamples = minDegradedSnapshots;
      if (durationSec < profile.minDurationSec && distanceM < profile.minDistanceM) return;

      const rscp = current.map((row) => row.cell.rscp).filter(Number.isFinite).sort((a, b) => a - b);
      const ecno = current.map((row) => row.cell.ecno).filter(Number.isFinite).sort((a, b) => a - b);
      const coverageOnly = current.filter((row) => row.rawCoverage && !row.rawQuality).length;
      const qualityOnly = current.filter((row) => row.rawQuality && !row.rawCoverage).length;
      const both = current.filter((row) => row.rawCoverage && row.rawQuality).length;
      let classification = classifySegment(coverageOnly, qualityOnly, both, current.length);
      const servingByKey = new Map();
      const snapshotContexts = [];
      const degradedSnapshotContexts = [];
      current.forEach((row) => {
        const key = row.cell.cellKey || row.cell.cellName || "unknown";
        servingByKey.set(key, { cell: row.cell, count: (servingByKey.get(key)?.count || 0) + 1 });
        const context = describeNeighborContext(row.snapshot, row.cell, profile);
        snapshotContexts.push(context);
        // Hysteresis keeps a route geometrically continuous through a brief
        // recovery.  Such a snapshot is not evidence of degradation and must
        // never vote for "Conditions radio normales" in the segment RCA.
        if (row.rawCoverage || row.rawQuality) degradedSnapshotContexts.push(context);
      });
      const servingCells = [...servingByKey.values()].sort((a, b) => b.count - a.count);
      const dominantServing = servingCells[0]?.cell || null;
      const servingChanges = current.slice(1).reduce((count, row, index) =>
        count + (row.cell.cellKey !== current[index].cell.cellKey ? 1 : 0), 0);
      const representative = current.reduce((best, row) => {
        const score = (row.rawCoverage ? Math.max(0, profile.coverageEntryDbm - row.cell.rscp) : 0)
          + (row.rawQuality ? Math.max(0, profile.qualityEntryDb - row.cell.ecno) : 0);
        return score > best.score ? { row, score } : best;
      }, { row: current[0], score: -Infinity }).row;
      const representativeIndex = current.indexOf(representative);
      const representativeContext = snapshotContexts[representativeIndex] || describeNeighborContext(representative.snapshot, representative.cell, profile);
      // The segment diagnosis comes from all degraded snapshots.  The worst
      // radio point remains available separately, but can no longer dictate a
      // conclusion that the rest of the segment does not support.
      const diagnosticContext = aggregateDiagnosticContext(degradedSnapshotContexts, profile, representativeContext);
      const episodeId = `voice_radio_${episodes.length + 1}`;
      const zoneDiagnostic = buildZoneDiagnostic(current, profile);
      if (zoneDiagnostic) {
        zoneDiagnostic.zoneId = episodeId;
        classification = { type: zoneDiagnostic.zoneType, category: deriveZoneDegradationType(zoneDiagnostic, profile).category };
        const primary = zoneDiagnostic.primaryRca;
        const secondary = zoneDiagnostic.secondaryRca;
        diagnosticContext.primaryCode = primary.code;
        diagnosticContext.primaryDiagnostic = primary.label;
        diagnosticContext.secondaryCode = secondary?.code || null;
        diagnosticContext.secondaryDiagnostic = secondary?.label || null;
        diagnosticContext.confidence = primary.confidence;
        diagnosticContext.supportPct = Number((primary.supportSnapshotRatio * 100).toFixed(1));
        diagnosticContext.score = primary.score;
        diagnosticContext.recommendation = primary.recommendation;
        diagnosticContext.evidence = primary.evidence.slice();
        diagnosticContext.bestNeighbor = zoneDiagnostic.bestRecurrentNeighbor || diagnosticContext.bestNeighbor;
        diagnosticContext.bestNeighborDeltaDb = zoneDiagnostic.bestRecurrentNeighbor?.deltaMedian ?? diagnosticContext.bestNeighborDeltaDb;
        zoneDiagnostic.bestNeighborAtWorstPoint = representativeContext.bestNeighbor ? publicCell(representativeContext.bestNeighbor) : null;
        zoneDiagnostic.worstPointServing = publicCell(representative.cell);
        diagnosticContext.diagnostic = `${primary.label} | ${primary.score}/100 · Confiance ${confidenceLabel(primary.confidence)}${secondary ? ` | Secondaire : ${secondary.label}` : ""}`;
      }
      const priorityComponents = priorityComponentsFor({
        rscpP10: zoneDiagnostic?.servingRscp?.p10 ?? quantile(rscp, 0.1),
        ecnoP10: zoneDiagnostic?.servingEcno?.p10 ?? quantile(ecno, 0.1),
        profile, distanceM, durationSec, degradedSnapshotCount,
        rcaConfidence: zoneDiagnostic?.primaryRca?.confidence || "low",
      });
      const priorityScore = priorityComponents.total;
      episodes.push({
        id: episodeId,
        ...classification,
        severity: rscp[0] <= profile.coverageCriticalDbm || ecno[0] <= profile.qualityCriticalDb ? "critical" : "major",
        startTime: first.snapshot.time, endTime: last.snapshot.time,
        start: { lat: first.snapshot.lat, lng: first.snapshot.lng }, end: { lat: last.snapshot.lat, lng: last.snapshot.lng },
        representative: { time: representative.snapshot.time, lat: representative.snapshot.lat, lng: representative.snapshot.lng, cell: publicCell(representative.cell) },
        servingCell: publicCell(first.cell),
        dominantServing: publicCell(dominantServing),
        servingCells: servingCells.map(({ cell, count }) => ({ ...publicCell(cell), count })),
        servingChanges,
        sampleCount: zoneDiagnostic?.degradedSnapshotCount || degradedSnapshotCount, requiredSampleCount: minSamples,
        coverageSampleCount: coverageOnly + both,
        qualitySampleCount: qualityOnly + both,
        requiredCoverageSampleCount: profile.coverageMinSamples,
        requiredQualitySampleCount: profile.qualityMinSamples,
        durationSec, distanceM, priorityScore, priorityComponents, priorityEvidence: [priorityEvidenceFor(priorityComponents)],
        metrics: {
          rscpMin: zoneDiagnostic?.servingRscp?.min ?? rscp[0] ?? null, rscpMedian: zoneDiagnostic?.servingRscp?.median ?? quantile(rscp, 0.5), rscpP10: zoneDiagnostic?.servingRscp?.p10 ?? quantile(rscp, 0.1),
          ecnoMin: zoneDiagnostic?.servingEcno?.min ?? ecno[0] ?? null, ecnoMedian: zoneDiagnostic?.servingEcno?.median ?? quantile(ecno, 0.5), ecnoP10: zoneDiagnostic?.servingEcno?.p10 ?? quantile(ecno, 0.1),
        },
        composition: {
          coverageOnlyPct: pct(coverageOnly, current.length), qualityOnlyPct: pct(qualityOnly, current.length),
          bothPct: pct(both, current.length), coverageOnlySamples: coverageOnly,
          qualityOnlySamples: qualityOnly, bothSamples: both,
        },
        neighborContext: diagnosticContext,
        zoneDiagnostic,
        primaryRca: zoneDiagnostic?.primaryRca || null,
        secondaryRca: zoneDiagnostic?.secondaryRca || null,
        worstRadioPoint: {
          time: representative.snapshot.time,
          lat: representative.snapshot.lat,
          lng: representative.snapshot.lng,
          serving: publicCell(representative.cell),
          diagnostic: representativeContext.diagnostic,
          // Explicitly preserve the punctual evidence used by the renamed
          // "Worst Point" export columns; zone statistics live separately.
          diagnosticContext: representativeContext,
        },
        sequence: current.map((row) => ({
          time: row.snapshot.time, timeMs: row.snapshot.timeMs, lat: row.snapshot.lat, lng: row.snapshot.lng,
          serving: publicCell(row.cell), snapshotCells: row.snapshot.cells.map(publicCell),
          sourceRows: row.snapshot.sourceRows.slice(), radioState: row.snapshotState || (row.rawCoverage && row.rawQuality ? "both" : row.rawCoverage ? "coverage" : row.rawQuality ? "quality" : "recovery_bridge"),
        })),
        snapshotCells: representative.snapshot.cells.map(publicCell),
        confidence: current.length >= 10 && (durationSec >= 10 || distanceM >= 100) ? "high" : "medium",
        reviewState: "candidate", sourceRows: [...new Set(current.flatMap((row) => row.cell.sourceRows))],
      });
    };

    snapshots.forEach((snapshot) => {
      const cell = snapshot.primaryServing;
      const gpsJump = previousSnapshot && haversineM(previousSnapshot, snapshot) > profile.maxGpsJumpM;
      const prior = current[current.length - 1];
      const deltaSec = prior && Number.isFinite(snapshot.timeMs) && Number.isFinite(prior.snapshot.timeMs)
        ? (snapshot.timeMs - prior.snapshot.timeMs) / 1000 : 0;
      if (gpsJump) {
        // Do not convert an implausible GPS leap into either a route sample or
        // a bridge between two candidates.
        flush(); current = []; coverageHeld = false; qualityHeld = false; coverageRecovery = 0; qualityRecovery = 0;
        previousSnapshot = snapshot;
        return;
      }
      if (!cell || (prior && (deltaSec < 0 || deltaSec > profile.mergeGapSec))) {
        flush(); current = []; coverageHeld = false; qualityHeld = false; coverageRecovery = 0; qualityRecovery = 0;
      }
      if (!cell) { previousSnapshot = snapshot; return; }
      const rawCoverage = Number.isFinite(cell.rscp) && cell.rscp <= profile.coverageEntryDbm;
      const rawQuality = Number.isFinite(cell.ecno) && cell.ecno <= profile.qualityEntryDb;
      if (!coverageHeld && rawCoverage) coverageHeld = true;
      if (!qualityHeld && rawQuality) qualityHeld = true;
      coverageRecovery = coverageHeld && Number.isFinite(cell.rscp) && cell.rscp > profile.coverageExitDbm ? coverageRecovery + 1 : 0;
      qualityRecovery = qualityHeld && Number.isFinite(cell.ecno) && cell.ecno > profile.qualityExitDb ? qualityRecovery + 1 : 0;
      if (coverageRecovery >= profile.recoverySnapshots) { coverageHeld = false; coverageRecovery = 0; }
      if (qualityRecovery >= profile.recoverySnapshots) { qualityHeld = false; qualityRecovery = 0; }
      if (!coverageHeld && !qualityHeld) {
        // The second confirmed good snapshot closes the preceding segment and
        // is not counted as a degraded customer sample.
        flush(); current = [];
      }
      if (coverageHeld || qualityHeld) {
        const snapshotState = rawCoverage && rawQuality ? "BOTH" : rawCoverage ? "COVERAGE" : rawQuality ? "QUALITY" : "RECOVERY_BRIDGE";
        const bridgeCount = current.reduce((count, row) => count + (row.snapshotState === "RECOVERY_BRIDGE" ? 1 : 0), 0);
        if (snapshotState === "RECOVERY_BRIDGE" && bridgeCount >= profile.maxRecoveryBridgeSnapshots) {
          // Do not let recovery samples become the majority of a degradation
          // zone. A new candidate can start only on a later raw crossing.
          flush(); current = []; coverageHeld = false; qualityHeld = false; coverageRecovery = 0; qualityRecovery = 0;
        } else {
          current.push({ snapshot, cell, rawCoverage, rawQuality, snapshotState });
        }
      }
      previousSnapshot = snapshot;
    });
    flush();
    // Canonical ranking: the longest consecutive degraded sequences are the
    // first candidates presented to the engineer. Duration and travelled
    // distance only break ties; chronology is the final deterministic key.
    episodes.sort((a, b) =>
      (Number(b.sampleCount) || 0) - (Number(a.sampleCount) || 0) ||
      (Number(b.durationSec) || 0) - (Number(a.durationSec) || 0) ||
      (Number(b.distanceM) || 0) - (Number(a.distanceM) || 0) ||
      parseTime(a.startTime).ms - parseTime(b.startTime).ms
    );
    episodes.forEach((episode, index) => {
      episode.rank = index + 1;
    });
    episodes.slice().sort((a, b) => b.priorityScore - a.priorityScore || a.rank - b.rank)
      .forEach((episode, index) => { episode.priorityRank = index + 1; });
    return episodes;
  };

  const distanceToEpisodeRouteM = (episode, point) => {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return null;
    const route = Array.isArray(episode?.sequence) ? episode.sequence : [];
    if (!route.length) return null;
    const distances = route.map((sample) => haversineM(sample, point)).filter(Number.isFinite);
    return distances.length ? Math.min(...distances) : null;
  };

  const connectEpisodes = (episodes, events, profile) => {
    const directToleranceM = Number(profile.serviceImpactDirectDistanceM ?? 100);
    const nearbyToleranceM = Number(profile.serviceImpactNearbyDistanceM ?? 100);
    const temporalMarginMs = Number(profile.serviceImpactTemporalMarginSec ?? 2) * 1000;
    episodes.forEach((episode) => {
      const impact = { dropCount: 0, callSetupFailureCount: 0, rlfCount: 0, hofCount: 0, events: [], hasDirectServiceImpact: false, hasNearbyServiceImpact: false };
      episode.serviceImpact = impact;
      if (episode.zoneDiagnostic) episode.zoneDiagnostic.serviceImpact = impact;
    });
    events.forEach((event) => {
      const eventMs = parseTime(event.time).ms;
      if (!Number.isFinite(eventMs)) return;
      const matches = episodes.map((episode) => {
        const startMs = parseTime(episode.startTime).ms;
        const endMs = parseTime(episode.endTime).ms;
        const distanceM = distanceToEpisodeRouteM(episode, event);
        const gpsAvailable = Number.isFinite(distanceM);
        const direct = eventMs >= startMs && eventMs <= endMs && (!gpsAvailable || distanceM <= directToleranceM);
        const nearby = !direct && eventMs >= startMs - temporalMarginMs && eventMs <= endMs + temporalMarginMs && (!gpsAvailable || distanceM <= nearbyToleranceM);
        if (!direct && !nearby) return null;
        const timeDeltaSec = direct ? 0 : Math.min(Math.abs(eventMs - startMs), Math.abs(eventMs - endMs)) / 1000;
        return { episode, category: direct ? "DIRECT" : "NEARBY", distanceM, timeDeltaSec };
      }).filter(Boolean).sort((a, b) => (a.category === b.category ? (a.timeDeltaSec - b.timeDeltaSec) || ((a.distanceM ?? Infinity) - (b.distanceM ?? Infinity)) : a.category === "DIRECT" ? -1 : 1));
      const match = matches[0];
      if (!match) {
        event.properties = Object.assign({}, event.properties || {}, { "Radio zone service impact": "UNRELATED" });
        return;
      }
      const impact = match.episode.serviceImpact;
      const eventType = event.drop ? "CALL_DROP" : event.setupFailure ? "CALL_SETUP_FAILURE" : "EVENT";
      if (event.drop) impact.dropCount += 1;
      if (event.setupFailure) impact.callSetupFailureCount += 1;
      impact.events.push({ id: event.sessionId, type: eventType, category: match.category, time: event.time, distanceM: match.distanceM, timeDeltaSec: match.timeDeltaSec });
      impact.hasDirectServiceImpact ||= match.category === "DIRECT";
      impact.hasNearbyServiceImpact ||= match.category === "NEARBY";
      match.episode.relatedEventIds = [...new Set([...(match.episode.relatedEventIds || []), event.sessionId])];
      event.properties = Object.assign({}, event.properties || {}, {
        "Radio zone service impact": match.category,
        "Radio zone ID": match.episode.id,
        "Radio zone distance (m)": Number.isFinite(match.distanceM) ? Math.round(match.distanceM) : "",
      });
    });
    episodes.forEach((episode) => {
      const impact = episode.serviceImpact;
      episode.priorityComponents = priorityComponentsFor({
        rscpP10: episode.metrics?.rscpP10, ecnoP10: episode.metrics?.ecnoP10,
        profile, distanceM: episode.distanceM, durationSec: episode.durationSec,
        degradedSnapshotCount: episode.sampleCount,
        rcaConfidence: episode.primaryRca?.confidence || "low", serviceImpact: impact,
      });
      episode.priorityScore = episode.priorityComponents.total;
      episode.priorityEvidence = [priorityEvidenceFor(episode.priorityComponents)];
      if (impact.dropCount || impact.callSetupFailureCount || impact.rlfCount || impact.hofCount) {
        episode.priorityEvidence[0] += ` Priority increased due to ${impact.dropCount ? `${impact.dropCount} Drop Call${impact.dropCount > 1 ? "s" : ""}` : ""}${impact.dropCount && impact.callSetupFailureCount ? " and " : ""}${impact.callSetupFailureCount ? `${impact.callSetupFailureCount} Call Setup Failure${impact.callSetupFailureCount > 1 ? "s" : ""}` : ""}.`;
        if (episode.zoneDiagnostic) episode.zoneDiagnostic.diagnosticText += `\n\nImpact service confirmé : ${impact.dropCount} Drop Call, ${impact.callSetupFailureCount} Call Setup Failure.`;
      }
    });
  };

  const rcaFamily = (code) => ({
    STRUCTURAL_COVERAGE_GAP: "coverage", GENERAL_WEAK_COVERAGE: "coverage", COVERAGE_AND_QUALITY_DEGRADATION: "coverage",
    QUALITY_DEGRADATION_DOMINANT_SERVING: "quality", PILOT_POLLUTION_PROBABLE: "quality", LOW_DOMINANCE_RCA: "quality",
    INTRAFREQ_MOBILITY_ISSUE: "mobility", POTENTIAL_MISSING_NEIGHBOR: "mobility", INTERFREQ_MOBILITY_OPPORTUNITY: "mobility", PING_PONG_PROBABLE: "mobility", MOBILITY_INSTABILITY: "mobility",
  }[code] || "other");

  // Macro zones are a second, non-destructive aggregation level. Micro
  // segments remain untouched for map precision and audit traceability.
  const buildMacroRadioProblemZones = (incidents, profile) => {
    const maxGapSec = Number(profile.macroMaxTemporalGapSec ?? profile.macroZoneMaxGapSec ?? 20);
    const maxGapM = Number(profile.macroMaxSpatialGapM ?? profile.macroZoneMaxGapM ?? 250);
    const minCompatibility = Number(profile.macroMinRcaCompatibility ?? 70);
    const ordered = incidents.slice().sort((a, b) => parseTime(a.startTime).ms - parseTime(b.startTime).ms);
    const compatibleObservations = (left, right) => {
      const leftCodes = new Set((left.zoneDiagnostic?.radioObservations || []).map((item) => item.code));
      return (right.zoneDiagnostic?.radioObservations || []).some((item) => leftCodes.has(item.code));
    };
    const mergeScore = (left, right) => {
      const gapSec = Math.max(0, (parseTime(right.startTime).ms - parseTime(left.endTime).ms) / 1000);
      const gapM = haversineM(left.end, right.start);
      const geographic = Math.max(0, 30 * (1 - gapM / Math.max(1, maxGapM)));
      const temporal = Math.max(0, 20 * (1 - gapSec / Math.max(1, maxGapSec)));
      const sameFamily = rcaFamily(left.primaryRca?.code) === rcaFamily(right.primaryRca?.code);
      const observationCompatible = compatibleObservations(left, right);
      const rcaCompatibility = sameFamily ? 30 : observationCompatible ? 18 : 0;
      const sameServing = normalCell(left.zoneDiagnostic?.dominantServingName) === normalCell(right.zoneDiagnostic?.dominantServingName);
      const sameAlternative = normalCell(left.zoneDiagnostic?.bestAlternativeCell?.cellName) === normalCell(right.zoneDiagnostic?.bestAlternativeCell?.cellName);
      const servingNeighbor = sameServing || sameAlternative ? 10 : 0;
      const rscpDelta = Math.abs(Number(left.metrics?.rscpMedian) - Number(right.metrics?.rscpMedian));
      const ecnoDelta = Math.abs(Number(left.metrics?.ecnoMedian) - Number(right.metrics?.ecnoMedian));
      const metricContinuity = (Number.isFinite(rscpDelta) && rscpDelta <= 4 ? 6 : 0) + (Number.isFinite(ecnoDelta) && ecnoDelta <= 3 ? 4 : 0);
      return { score: Number((geographic + temporal + rcaCompatibility + servingNeighbor + metricContinuity).toFixed(1)), gapSec, gapM, sameFamily, observationCompatible };
    };
    const groups = [];
    ordered.forEach((incident) => {
      const previous = groups[groups.length - 1];
      const preceding = previous?.children?.[previous.children.length - 1];
      const compatibility = preceding ? mergeScore(preceding, incident) : null;
      const eligible = compatibility && compatibility.gapSec <= maxGapSec && compatibility.gapM <= maxGapM
        && (compatibility.sameFamily || compatibility.observationCompatible) && compatibility.score >= minCompatibility;
      if (eligible) previous.children.push(incident), previous.mergeScores.push(compatibility);
      else groups.push({ children: [incident], mergeScores: [] });
    });
    return groups.map((group, index) => {
      const children = group.children;
      const first = children[0]; const last = children[children.length - 1];
      const sum = (selector) => children.reduce((total, child) => total + Number(selector(child) || 0), 0);
      const codeCounts = new Map();
      const conditionCounts = new Map();
      const servingCounts = new Map();
      const alternatives = new Map();
      children.forEach((child) => {
        const code = child.primaryRca?.code || "INCONCLUSIVE";
        codeCounts.set(code, (codeCounts.get(code) || 0) + Number(child.sampleCount || 1));
        const condition = child.zoneDiagnostic?.radioCondition || child.type;
        conditionCounts.set(condition, (conditionCounts.get(condition) || 0) + Number(child.sampleCount || 1));
        (child.zoneDiagnostic?.servingCells || []).forEach((cell) => servingCounts.set(cell.cellName, (servingCounts.get(cell.cellName) || 0) + Number(cell.count || 1)));
        const alternative = child.zoneDiagnostic?.bestAlternativeCell;
        if (alternative?.cellName) alternatives.set(alternative.cellName, alternative);
      });
      const primaryCode = [...codeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "INCONCLUSIVE";
      const primaryChildren = children.filter((child) => child.primaryRca?.code === primaryCode);
      const primaryScore = primaryChildren.length ? Math.round(sum((child) => child.primaryRca?.finalSelectionScore ?? child.primaryRca?.score) / primaryChildren.length) : 20;
      const secondaryCode = [...codeCounts.entries()].filter(([code]) => code !== primaryCode).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const serviceEvents = children.flatMap((child) => child.serviceImpact?.events || []);
      const dropCount = sum((child) => child.serviceImpact?.dropCount);
      const callSetupFailureCount = sum((child) => child.serviceImpact?.callSetupFailureCount);
      const degradedDistanceM = sum((child) => child.distanceM);
      const corridorDistanceM = degradedDistanceM + group.mergeScores.reduce((total, item) => total + item.gapM, 0);
      const priorityScore = Math.min(100, Math.round((sum((child) => child.priorityScore) / children.length) + Math.min(12, dropCount * 7 + callSetupFailureCount * 4)));
      const meta = rcaMeta(primaryCode);
      const dominantRadioCondition = [...conditionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "UNKNOWN";
      const rcaEvidence = [
        `${children.length} micro-zones successives · ${Math.round(degradedDistanceM)} m dégradés`,
        `Compatibilité fusion min/max : ${group.mergeScores.length ? `${Math.round(Math.min(...group.mergeScores.map((item) => item.score)))}/${Math.round(Math.max(...group.mergeScores.map((item) => item.score)))}` : "zone unique"}`,
        `${dropCount} Drop Call · ${callSetupFailureCount} Call Setup Failure`,
      ];
      return {
        id: `macro_radio_${index + 1}`, macroZoneId: `macro_radio_${index + 1}`,
        childZoneIds: children.map((child) => child.id), children,
        startTime: first.startTime, endTime: last.endTime, startGps: first.start, endGps: last.end, start: first.start, end: last.end,
        degradedDistanceM, corridorDistanceM, durationSec: Math.max(0, (parseTime(last.endTime).ms - parseTime(first.startTime).ms) / 1000),
        degradedSnapshotCount: sum((child) => child.sampleCount), totalSnapshotCount: sum((child) => child.zoneDiagnostic?.zoneSnapshotCount), microZoneCount: children.length,
        servingCells: [...servingCounts.entries()].sort((a, b) => b[1] - a[1]).map(([cellName, count]) => ({ cellName, count })),
        dominantServingCells: [...servingCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cellName, count]) => ({ cellName, count })),
        bestAlternativeCells: [...alternatives.values()].sort((a, b) => (b.rscpMedian || -Infinity) - (a.rscpMedian || -Infinity)),
        dominantRadioCondition,
        primaryRca: { code: primaryCode, label: meta[0], score: primaryScore, finalSelectionScore: primaryScore },
        secondaryRca: secondaryCode ? { code: secondaryCode, label: rcaMeta(secondaryCode)[0] } : null,
        rcaConfidence: primaryChildren.some((child) => child.primaryRca?.confidence === "high") ? "high" : primaryChildren.some((child) => child.primaryRca?.confidence === "medium") ? "medium" : "low",
        rcaEvidence, dropCount, callSetupFailureCount, rlfCount: 0, hofCount: 0, serviceEvents,
        priorityScore, recommendedAction: meta[1], mergeScores: group.mergeScores,
      };
    });
  };

  const analyze = (points, options = {}) => {
    if (!isVoiceSchema(points)) return null;
    const requestedProfile = options.profile || {};
    const profile = Object.assign({}, DEFAULT_PROFILE, requestedProfile);
    profile.id = DEFAULT_PROFILE.id;
    // Migrate old saved profiles which only contain `minSamples`. Explicit v3
    // values always win; otherwise the former setting is applied to both.
    const legacyMinimum = Math.max(1, Math.round(Number(requestedProfile.minSamples) || DEFAULT_PROFILE.minSamples));
    profile.coverageMinSamples = Math.max(1, Math.round(Number(
      requestedProfile.coverageMinSamples ?? legacyMinimum
    ) || legacyMinimum));
    profile.qualityMinSamples = Math.max(1, Math.round(Number(
      requestedProfile.qualityMinSamples ?? legacyMinimum
    ) || legacyMinimum));
    const normalizedCoverageEntry = Number(profile.coverageEntryDbm);
    const normalizedQualityEntry = Number(profile.qualityEntryDb);
    profile.coverageEntryDbm = Number.isFinite(normalizedCoverageEntry)
      ? Math.max(-150, Math.min(-40, normalizedCoverageEntry))
      : DEFAULT_PROFILE.coverageEntryDbm;
    profile.qualityEntryDb = Number.isFinite(normalizedQualityEntry)
      ? Math.max(-30, Math.min(0, normalizedQualityEntry))
      : DEFAULT_PROFILE.qualityEntryDb;
    const bounded = (value, fallback, min, max) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
    };
    profile.coverageExitDbm = Math.max(profile.coverageEntryDbm, bounded(profile.coverageExitDbm, DEFAULT_PROFILE.coverageExitDbm, -150, -40));
    profile.qualityExitDb = Math.max(profile.qualityEntryDb, bounded(profile.qualityExitDb, DEFAULT_PROFILE.qualityExitDb, -30, 0));
    profile.recoverySnapshots = Math.round(bounded(profile.recoverySnapshots, DEFAULT_PROFILE.recoverySnapshots, 1, 20));
    profile.maxRecoveryBridgeSnapshots = Math.round(bounded(profile.maxRecoveryBridgeSnapshots, DEFAULT_PROFILE.maxRecoveryBridgeSnapshots, 0, 20));
    const requestedMinDegraded = requestedProfile.minDegradedSnapshots;
    profile.minDegradedSnapshots = Math.round(bounded(
      requestedMinDegraded,
      Math.max(profile.coverageMinSamples, profile.qualityMinSamples),
      1,
      100,
    ));
    profile.minTypeSupportSnapshots = Math.round(bounded(profile.minTypeSupportSnapshots, DEFAULT_PROFILE.minTypeSupportSnapshots, 1, 100));
    profile.minTypeSupportRatio = bounded(profile.minTypeSupportRatio, DEFAULT_PROFILE.minTypeSupportRatio, 0, 1);
    profile.minTypeSpatialSupport = bounded(profile.minTypeSpatialSupport, DEFAULT_PROFILE.minTypeSpatialSupport, 0, 1);
    profile.maxPingPongDurationSec = bounded(profile.maxPingPongDurationSec, DEFAULT_PROFILE.maxPingPongDurationSec, 1, 3600);
    profile.maxPingPongDistanceM = bounded(profile.maxPingPongDistanceM, DEFAULT_PROFILE.maxPingPongDistanceM, 1, 100000);
    profile.minimumReverseTransitions = Math.round(bounded(profile.minimumReverseTransitions, DEFAULT_PROFILE.minimumReverseTransitions, 1, 100));
    profile.macroZoneMaxGapSec = bounded(profile.macroZoneMaxGapSec, DEFAULT_PROFILE.macroZoneMaxGapSec, 0, 3600);
    profile.macroZoneMaxGapM = bounded(profile.macroZoneMaxGapM, DEFAULT_PROFILE.macroZoneMaxGapM, 0, 100000);
    profile.macroMaxTemporalGapSec = bounded(profile.macroMaxTemporalGapSec, DEFAULT_PROFILE.macroMaxTemporalGapSec, 0, 3600);
    profile.macroMaxSpatialGapM = bounded(profile.macroMaxSpatialGapM, DEFAULT_PROFILE.macroMaxSpatialGapM, 0, 100000);
    profile.macroMinRcaCompatibility = bounded(profile.macroMinRcaCompatibility, DEFAULT_PROFILE.macroMinRcaCompatibility, 0, 100);
    profile.minDurationSec = bounded(profile.minDurationSec, DEFAULT_PROFILE.minDurationSec, 0, 3600);
    profile.minDistanceM = bounded(profile.minDistanceM, DEFAULT_PROFILE.minDistanceM, 0, 10000);
    profile.mergeGapSec = bounded(profile.mergeGapSec, DEFAULT_PROFILE.mergeGapSec, 0, 300);
    profile.maxGpsJumpM = bounded(profile.maxGpsJumpM, DEFAULT_PROFILE.maxGpsJumpM, 20, 10000);
    profile.credibleNeighborDbm = bounded(profile.credibleNeighborDbm, DEFAULT_PROFILE.credibleNeighborDbm, -150, -40);
    profile.significantPilotDbm = bounded(profile.significantPilotDbm, DEFAULT_PROFILE.significantPilotDbm, -150, -40);
    profile.strongPilotDbm = bounded(profile.strongPilotDbm, DEFAULT_PROFILE.strongPilotDbm, -150, -40);
    profile.betterNeighborDeltaDb = bounded(profile.betterNeighborDeltaDb, DEFAULT_PROFILE.betterNeighborDeltaDb, 0, 30);
    profile.closePilotDeltaDb = bounded(profile.closePilotDeltaDb, DEFAULT_PROFILE.closePilotDeltaDb, 0, 30);
    profile.weakDominanceDb = bounded(profile.weakDominanceDb, DEFAULT_PROFILE.weakDominanceDb, 0, 30);
    profile.pilotPollutionMinPilots = Math.round(bounded(profile.pilotPollutionMinPilots, DEFAULT_PROFILE.pilotPollutionMinPilots, 2, 20));
    profile.diagnosticHighSupportPct = bounded(profile.diagnosticHighSupportPct, DEFAULT_PROFILE.diagnosticHighSupportPct, 1, 100);
    profile.diagnosticMediumSupportPct = bounded(profile.diagnosticMediumSupportPct, DEFAULT_PROFILE.diagnosticMediumSupportPct, 1, profile.diagnosticHighSupportPct);
    profile.diagnosticMinConsecutive = Math.round(bounded(profile.diagnosticMinConsecutive, DEFAULT_PROFILE.diagnosticMinConsecutive, 1, 100));
    profile.bestNeighborMinPresenceRatio = bounded(profile.bestNeighborMinPresenceRatio, DEFAULT_PROFILE.bestNeighborMinPresenceRatio, 0, 1);
    profile.bestNeighborMinSnapshots = Math.round(bounded(profile.bestNeighborMinSnapshots, DEFAULT_PROFILE.bestNeighborMinSnapshots, 1, 100));
    profile.generalWeakCoverageMinRatio = bounded(profile.generalWeakCoverageMinRatio, DEFAULT_PROFILE.generalWeakCoverageMinRatio, 0, 1);
    profile.lowDominanceRcaMinRatio = bounded(profile.lowDominanceRcaMinRatio, DEFAULT_PROFILE.lowDominanceRcaMinRatio, 0, 1);
    profile.lowDominanceQualitySupportRatio = bounded(profile.lowDominanceQualitySupportRatio, DEFAULT_PROFILE.lowDominanceQualitySupportRatio, 0, 1);
    profile.serviceImpactDirectDistanceM = bounded(profile.serviceImpactDirectDistanceM, DEFAULT_PROFILE.serviceImpactDirectDistanceM, 0, 10000);
    profile.serviceImpactNearbyDistanceM = bounded(profile.serviceImpactNearbyDistanceM, DEFAULT_PROFILE.serviceImpactNearbyDistanceM, 0, 10000);
    profile.serviceImpactTemporalMarginSec = bounded(profile.serviceImpactTemporalMarginSec, DEFAULT_PROFILE.serviceImpactTemporalMarginSec, 0, 3600);
    profile.priorityDropBonus = bounded(profile.priorityDropBonus, DEFAULT_PROFILE.priorityDropBonus, 0, 100);
    profile.priorityCallFailureBonus = bounded(profile.priorityCallFailureBonus, DEFAULT_PROFILE.priorityCallFailureBonus, 0, 100);
    profile.structuralCoverageMinRatio = bounded(profile.structuralCoverageMinRatio, DEFAULT_PROFILE.structuralCoverageMinRatio, 0, 1);
    profile.highConfidenceScore = bounded(profile.highConfidenceScore, DEFAULT_PROFILE.highConfidenceScore, 1, 100);
    profile.mediumConfidenceScore = bounded(profile.mediumConfidenceScore, DEFAULT_PROFILE.mediumConfidenceScore, 1, profile.highConfidenceScore);
    profile.secondaryRcaMinScore = bounded(profile.secondaryRcaMinScore, DEFAULT_PROFILE.secondaryRcaMinScore, 1, 100);
    const snapshots = buildSnapshots(points);
    const calls = buildCallSessions(snapshots, profile);
    const incidents = buildEpisodes(snapshots, profile);
    connectEpisodes(incidents, calls.events, profile);
    // Service impact is added after segmentation; recompute only the
    // operational-priority rank, never the degradation rank or boundaries.
    incidents.slice().sort((a, b) => b.priorityScore - a.priorityScore || a.rank - b.rank)
      .forEach((episode, index) => { episode.priorityRank = index + 1; });
    const macroZones = buildMacroRadioProblemZones(incidents, profile);
    incidents.forEach((incident) => {
      const zone = incident.zoneDiagnostic || {};
      const macroContext = macroZones.find((macro) => (macro.childZoneIds || []).includes(incident.id)) || null;
      const presentationModel = buildRadioAnalysisPresentationModel(
        zone,
        { primaryRca: incident.primaryRca, secondaryRca: incident.secondaryRca },
        zone.radioObservations,
        incident.serviceImpact || zone.serviceImpact,
        macroContext,
      );
      incident.presentationModel = presentationModel;
      zone.presentationModel = presentationModel;
    });
    const radioIntervals = incidents.map((incident) => ({ id: incident.id, start: parseTime(incident.startTime).ms, end: parseTime(incident.endTime).ms })).filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end));
    const overlappingZoneIds = [];
    for (let left = 0; left < radioIntervals.length; left += 1) {
      for (let right = left + 1; right < radioIntervals.length; right += 1) {
        const a = radioIntervals[left]; const b = radioIntervals[right];
        if (Math.max(a.start, b.start) <= Math.min(a.end, b.end)) overlappingZoneIds.push([a.id, b.id]);
      }
    }
    const invalidPingPong = incidents.filter((incident) => incident.primaryRca?.code === "PING_PONG_PROBABLE" || incident.secondaryRca?.code === "PING_PONG_PROBABLE")
      .filter((incident) => Number(incident.zoneDiagnostic?.servingTransitionCount || 0) < 2 || Number(incident.zoneDiagnostic?.reverseTransitionCount || 0) < Number(profile.minimumReverseTransitions));
    const negativePilotDominance = incidents.filter((incident) => Number(incident.zoneDiagnostic?.pilotDominanceMargin?.min) < 0);
    const zoneTypeMismatch = incidents.filter((incident) => {
      const expected = expectedZoneDegradationType(incident.zoneDiagnostic, profile);
      return incident.type !== expected || incident.zoneDiagnostic?.zoneType !== expected;
    });
    const belowMinimumDegraded = incidents.filter((incident) => Number(incident.zoneDiagnostic?.degradedSnapshotCount || 0) < Number(profile.minDegradedSnapshots));
    const thresholdMetadataMismatch = incidents.filter((incident) => !Number.isFinite(profile.coverageEntryDbm) || !Number.isFinite(profile.qualityEntryDb));
    const servingIdentityMismatch = incidents.filter((incident) => {
      const zone = incident.zoneDiagnostic;
      const dominant = zone?.dominantServing;
      if (!zone || !dominant) return true;
      return normalCell(zone.dominantServingName) !== normalCell(dominant.cellName)
        || String(zone.dominantServingCI ?? "") !== String(dominant.cellId ?? "")
        || String(zone.dominantServingSC ?? "") !== String(dominant.sc ?? "")
        || String(zone.dominantServingUarfcn ?? "") !== String(dominant.channel ?? "");
    });
    const invalidLowDominanceRca = incidents.filter((incident) => [incident.primaryRca, incident.secondaryRca]
      .filter(Boolean).some((candidate) => candidate.code === "LOW_DOMINANCE_RCA" && !incident.zoneDiagnostic?.lowDominanceRcaApplicable));
    const invalidMissingNeighborTrigger = incidents.filter((incident) => [incident.primaryRca, incident.secondaryRca]
      .filter((candidate) => candidate?.code === "POTENTIAL_MISSING_NEIGHBOR")
      .some((candidate) => !candidate.triggerCell
        || candidate.triggerCell.rscpMedian < profile.credibleNeighborDbm
        || candidate.triggerCell.deltaVsServingMedian < profile.betterNeighborDeltaDb
        || candidate.triggerCell.presenceRatio < profile.bestNeighborMinPresenceRatio));
    const rcaScoreOutsideRange = incidents.filter((incident) => [incident.primaryRca, incident.secondaryRca]
      .filter(Boolean).some((candidate) => !Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 100));
    const duplicateRcaFamily = incidents.filter((incident) => incident.primaryRca && incident.secondaryRca
      && rcaFamily(incident.primaryRca.code) === rcaFamily(incident.secondaryRca.code));
    const primarySecondaryScoreInversion = incidents.filter((incident) => incident.primaryRca && incident.secondaryRca
      && Number(incident.primaryRca.finalSelectionScore ?? incident.primaryRca.score) < Number(incident.secondaryRca.finalSelectionScore ?? incident.secondaryRca.score));
    const prioritySaturation = incidents.filter((incident) => Number(incident.priorityScore) >= 100);
    const serviceEventCorrelationErrors = incidents.filter((incident) => {
      const impact = incident.serviceImpact;
      return !impact || !Array.isArray(impact.events)
        || impact.events.some((event) => !["DIRECT", "NEARBY"].includes(event.category))
        || (impact.hasDirectServiceImpact && !impact.events.some((event) => event.category === "DIRECT"));
    });
    const bddResolved = incidents.filter((incident) => incident.zoneDiagnostic?.geometry?.available).length;
    const integrityReport = {
      radioZoneCount: incidents.length,
      overlapCount: overlappingZoneIds.length,
      belowMinimumDegradedCount: belowMinimumDegraded.length,
      zoneTypeMismatchCount: zoneTypeMismatch.length,
      negativeDominanceCount: negativePilotDominance.length,
      invalidPingPongCount: invalidPingPong.length,
      thresholdMetadataMismatchCount: thresholdMetadataMismatch.length,
      servingIdentityMismatchCount: servingIdentityMismatch.length,
      invalidLowDominanceRcaCount: invalidLowDominanceRca.length,
      serviceEventCorrelationErrorCount: serviceEventCorrelationErrors.length,
      primaryRcaScoreOutsideRangeCount: rcaScoreOutsideRange.length,
      invalidMissingNeighborTriggerCount: invalidMissingNeighborTrigger.length,
      duplicateRcaFamilyCount: duplicateRcaFamily.length,
      primarySecondaryScoreInversionCount: primarySecondaryScoreInversion.length,
      prioritySaturationCount: prioritySaturation.length,
      bddResolvedCount: bddResolved,
      bddUnresolvedCount: incidents.length - bddResolved,
    };
    const count = (type) => incidents.filter((incident) => incident.type === type).length;
    // These counters remain independent detection metrics; the zone type is
    // a separate final classification and must not hide a valid quality run
    // merely because coverage is the dominant zone characteristic.
    const countContaining = (kind) => incidents.filter((incident) => kind === "coverage"
      ? incident.coverageSampleCount >= incident.requiredCoverageSampleCount
      : incident.qualitySampleCount >= incident.requiredQualitySampleCount
    ).length;
    return {
      version: VERSION,
      schema: "umts_voice_excel",
      profile,
      snapshots,
      events: calls.events,
      callSessions: calls.sessions,
      incidents,
      macroZones,
      validationReport: {
        overlappingZones: overlappingZoneIds,
        invalidPingPongZoneIds: invalidPingPong.map((incident) => incident.id),
        negativePilotDominanceZoneIds: negativePilotDominance.map((incident) => incident.id),
        zoneTypeMismatchZoneIds: zoneTypeMismatch.map((incident) => incident.id),
        servingIdentityMismatchZoneIds: servingIdentityMismatch.map((incident) => incident.id),
        integrityReport,
        consoleReport: `OVERLAPPING ZONES: ${integrityReport.overlapCount}\nBELOW MINIMUM DEGRADED: ${integrityReport.belowMinimumDegradedCount}\nINVALID PING-PONG: ${integrityReport.invalidPingPongCount}\nNEGATIVE PILOT DOMINANCE: ${integrityReport.negativeDominanceCount}\nZONE TYPE MISMATCH: ${integrityReport.zoneTypeMismatchCount}\nTHRESHOLD METADATA MISMATCH: ${integrityReport.thresholdMetadataMismatchCount}\nSERVING IDENTITY MISMATCH: ${integrityReport.servingIdentityMismatchCount}\nINVALID LOW DOMINANCE RCA: ${integrityReport.invalidLowDominanceRcaCount}\nSERVICE EVENT CORRELATION ERRORS: ${integrityReport.serviceEventCorrelationErrorCount}\nPRIMARY RCA SCORE OUTSIDE 0..100: ${integrityReport.primaryRcaScoreOutsideRangeCount}\nINVALID MISSING NEIGHBOR TRIGGER: ${integrityReport.invalidMissingNeighborTriggerCount}\nDUPLICATE RCA FAMILY: ${integrityReport.duplicateRcaFamilyCount}\nPRIMARY/SECONDARY SCORE INVERSION: ${integrityReport.primarySecondaryScoreInversionCount}\nPRIORITY SATURATION: ${integrityReport.prioritySaturationCount}\nMACRO ZONES: ${macroZones.length}`,
      },
      summary: {
        sourceRows: Array.isArray(points) ? points.length : 0,
        snapshots: snapshots.length,
        callsConnected: snapshots.filter((snapshot) => snapshot.markers.connected).length,
        normalDisconnects: snapshots.filter((snapshot) => snapshot.markers.normalDisconnect).length,
        drops: calls.events.filter((event) => event.drop).length,
        failures: calls.events.filter((event) => event.setupFailure).length,
        coverageDegradations: countContaining("coverage"),
        qualityDegradations: countContaining("quality"),
        combinedDegradations: count("COMBINED_RADIO_DEGRADATION"),
        mixedDegradations: count("MIXED_RADIO_DEGRADATION"),
      },
    };
  };

  return {
    VERSION,
    DEFAULT_PROFILE,
    isVoiceSchema,
    analyze,
    generateProfessionalRadioAnalysis,
    generateRecommendedAction,
    buildRadioAnalysisPresentationModel,
  };
});
