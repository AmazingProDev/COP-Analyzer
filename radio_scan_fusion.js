/* Match independently detected radio degradations with measured route-scan overlap. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadioScanFusion = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  const number = (value) => value === null || value === undefined || value === "" ? null :
    (Number.isFinite(Number(value)) ? Number(value) : null);
  const pct = (part, whole) => whole ? Number((part * 100 / whole).toFixed(1)) : 0;
  const round = (value, digits = 1) => Number(value.toFixed(digits));
  const distanceM = (a, b) => {
    if (![a?.lat, a?.lon, b?.lat, b?.lon].every((value) => Number.isFinite(number(value)))) return 0;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 12742000 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  const isRadioDegradation = (incident) => ["COVERAGE_DEGRADATION", "SINR_DEGRADATION",
    "COMBINED_RADIO_DEGRADATION", "MIXED_RADIO_DEGRADATION"].includes(incident?.type);
  const scanner = () => root.RouteScanAnalyzer ||
    (typeof require === "function" ? require("./route_scan_analyzer.js") : null);

  function sourceSnapshotMap(incident) {
    const sourceSnapshots = new Map();
    for (const snapshot of incident.sequence || []) {
      if (snapshot.radioState === "recovery_bridge") continue;
      for (const index of snapshot.sourceIndices || [snapshot.sourceIndex]) {
        if (Number.isInteger(index)) sourceSnapshots.set(index, snapshot);
      }
    }
    return sourceSnapshots;
  }

  function summarizeMatch(incident, zone, zoneIndex, sourceSnapshots = sourceSnapshotMap(incident)) {
    const matched = (zone.samples || []).filter((sample) => {
      const snapshot = sourceSnapshots.get(sample.index);
      return snapshot && number(snapshot.pci) === number(sample.pci) &&
        number(snapshot.channel) === number(zone.channel);
    });
    if (!matched.length) return null;
    const uniqueSnapshots = new Set(matched.map((sample) => sourceSnapshots.get(sample.index)));
    const qualitySnapshots = [...uniqueSnapshots].filter((snapshot) =>
      snapshot.radioState === "sinr" || snapshot.radioState === "both");
    const first = matched[0], last = matched[matched.length - 1];
    let routeLengthMeters = 0;
    let durationMs = 0;
    const runs = [];
    for (const sample of matched) {
      const run = runs[runs.length - 1];
      const previous = run?.[run.length - 1];
      const stepDistance = previous ? distanceM(previous, sample) : 0;
      const stepMs = previous && previous.tMs !== null && sample.tMs !== null ? sample.tMs - previous.tMs : null;
      if (!run || sample.index - previous.index > 3 || stepMs !== null && (stepMs < 0 || stepMs > 2000) ||
          stepDistance > 100) runs.push([sample]);
      else {
        run.push(sample);
        routeLengthMeters += stepDistance;
        if (stepMs !== null) durationMs += stepMs;
      }
    }
    const durationSeconds = round(durationMs / 1000);
    const longestRun = Math.max(...runs.map((run) => run.length));
    const contributors = new Map();
    for (const sample of matched) {
      const best = Math.max(...sample.strong.map((cell) => cell.rsrp));
      for (const cell of sample.strong) {
        if (cell.serving) continue;
        const key = `${zone.rat}|${zone.channel}|${cell.pci}`;
        const row = contributors.get(key) || { rat: zone.rat, channel: zone.channel, pci: cell.pci,
          cellName: cell.cellName || null, samples: 0, coreSamples: 0, deltaSum: 0 };
        row.samples++;
        row.deltaSum += best - cell.rsrp;
        if (best - cell.rsrp <= 3) row.coreSamples++;
        if (!row.cellName && cell.cellName) row.cellName = cell.cellName;
        contributors.set(key, row);
      }
    }
    const topContributors = [...contributors.values()].map((row) => ({
      rat: row.rat, channel: row.channel, pci: row.pci, cellName: row.cellName,
      samples: row.samples, coreSamples: row.coreSamples,
      averageDeltaToBest: round(row.deltaSum / row.samples, 2),
    })).sort((a, b) => b.coreSamples - a.coreSamples || b.samples - a.samples ||
      a.averageDeltaToBest - b.averageDeltaToBest).slice(0, 5);
    const degradedSnapshots = Math.max(1, number(incident.sampleCount) ||
      (incident.sequence || []).filter((snapshot) => snapshot.radioState !== "recovery_bridge").length);
    const overlapPct = pct(uniqueSnapshots.size, degradedSnapshots);
    const referenceVerified = matched.every((sample) => sample.referenceVerified !== false);
    // A short intersection is retained on the map, but cannot by itself
    // promote co-channel overlap to the leading root-cause hypothesis.
    const supported = uniqueSnapshots.size >= 3 && longestRun >= 3 && overlapPct >= 30 && qualitySnapshots.length >= 2 &&
      (durationSeconds >= 2 || routeLengthMeters >= 20) && referenceVerified;
    const mapPoint = (sample) => ({ lat: sample.lat, lng: sample.lon, time: sample.time,
      sourceIndex: sample.index });
    return {
      zoneIndex, rat: zone.rat, channel: zone.channel, scanSeverity: zone.severity,
      startIndex: first.index, endIndex: last.index, startTime: first.time, endTime: last.time,
      sampleIndices: matched.map((sample) => sample.index),
      points: matched.map(mapPoint), segments: runs.map((run) => run.map(mapPoint)),
      sampleCount: matched.length, degradedSnapshotCount: uniqueSnapshots.size,
      qualitySnapshotCount: qualitySnapshots.length, overlapPct,
      durationSeconds, routeLengthMeters: round(routeLengthMeters),
      maxStrongCells: Math.max(...matched.map((sample) => sample.strong.length)),
      referenceVerified, supported, topContributors,
    };
  }

  function rcaFor(incident, matches) {
    const best = matches[0];
    const quality = incident.sinrSampleCount > 0;
    const persistent = quality && best.supported;
    const label = incident.rat === "NR" ? "Recouvrement cofréquence NR suspecté" : "Pilot pollution LTE suspectée";
    const facts = [
      `${best.degradedSnapshotCount} snapshot(s) dégradé(s) coïncident avec Scan Route sur ${incident.rat} ${incident.rat === "NR" ? "NR-ARFCN" : "EARFCN"} ${best.channel} (${best.overlapPct} % de la zone).`,
      `${best.sampleCount} mesure(s) voisines dans l'intersection, jusqu'à ${best.maxStrongCells} cellules fortes sur la même fréquence, sur ${best.durationSeconds ?? "N/D"} s / ${Math.round(best.routeLengthMeters)} m.`,
    ];
    if (best.topContributors.length) facts.push(`Voisines contributrices mesurées : ${best.topContributors.slice(0, 3).map((row) =>
      `${row.cellName || `PCI ${row.pci}`} (PCI ${row.pci}, ${row.samples} mesures, Δ moyen au meilleur ${row.averageDeltaToBest} dB)`).join(" ; ")}.`);
    if (!best.referenceVerified && incident.rat === "NR") facts.push("Références SS-RSRP/CSI-RSRP non entièrement identifiées : l'attribution NR reste à confirmer.");
    const hypothesis = persistent
      ? `${label} : plusieurs cellules cofréquence restent fortes pendant la baisse SINR. Leur contribution à la dégradation est possible et doit être vérifiée par scanner et KPI réseau.`
      : "Recouvrement cofréquence et dégradation présents sur une portion commune ; durée, qualité SINR ou comparabilité des mesures insuffisantes pour en faire la cause principale.";
    // Scan Route and the degradation detector reuse the same DT measurements.
    // Their coincidence adds localization, never independent causal proof.
    return { code: persistent ? "SCAN_COCHANNEL_OVERLAP_PERSISTENT" : "SCAN_COCHANNEL_OVERLAP_CANDIDATE",
      label: persistent ? label : "Recouvrement cofréquence à vérifier", evidenceLevel: "POSSIBLE",
      facts, hypothesis,
      verification: ["Vérifier scanner/FFT, KPI d'interférence et les secteurs cofréquence sur la portion commune avant toute correction RF."],
      limitations: ["Le recouvrement mesuré et la mauvaise qualité ne démontrent pas seuls une interférence causale ; aucune tentative ou panne HO n'est déduite."],
    };
  }

  function crossRatCoexistence(incidents) {
    const lte = incidents.filter((item) => item.rat === "LTE" && isRadioDegradation(item));
    const nr = incidents.filter((item) => item.rat === "NR" && isRadioDegradation(item));
    const degraded = (incident) => (incident.sequence || []).filter((snapshot) =>
      snapshot.radioState !== "recovery_bridge" && Number.isFinite(number(snapshot.timeMs)));
    const pairs = [];
    for (const left of lte) {
      const leftRows = degraded(left);
      for (const right of nr) {
        const rightRows = degraded(right);
        if (!leftRows.length || !rightRows.length) continue;
        const bySecond = new Map();
        for (const snapshot of rightRows) {
          const second = Math.floor(snapshot.timeMs / 1000);
          if (!bySecond.has(second)) bySecond.set(second, []);
          bySecond.get(second).push(snapshot);
        }
        const matched = [];
        const used = new Set();
        for (const snapshot of leftRows) {
          const second = Math.floor(snapshot.timeMs / 1000);
          const candidates = [-1, 0, 1].flatMap((offset) => bySecond.get(second + offset) || [])
            .filter((candidate) => !used.has(candidate) &&
              Math.abs(candidate.timeMs - snapshot.timeMs) <= 1500 &&
              distanceM({ lat: snapshot.lat, lon: snapshot.lng },
                { lat: candidate.lat, lon: candidate.lng }) <= 50)
            .sort((a, b) => Math.abs(a.timeMs - snapshot.timeMs) - Math.abs(b.timeMs - snapshot.timeMs));
          if (candidates[0]) {
            used.add(candidates[0]);
            matched.push({ lte: snapshot, nr: candidates[0] });
          }
        }
        if (matched.length < 2) continue;
        const pair = { lteIncidentId: left.id, nrIncidentId: right.id,
          matchedSnapshots: matched.length, lteOverlapPct: pct(matched.length, leftRows.length),
          nrOverlapPct: pct(matched.length, rightRows.length),
          startTime: matched[0].nr.time, endTime: matched[matched.length - 1].nr.time,
          points: matched.map((row) => ({ lat: row.nr.lat, lng: row.nr.lng, time: row.nr.time })),
          interpretation: "Dégradations LTE et NR simultanées sur le même trajet ; mécanisme commun non démontré. L'ancre LTE NSA reste un contexte séparé.",
        };
        pairs.push(pair);
        left.crossRatCoexistence = [...(left.crossRatCoexistence || []), pair];
        right.crossRatCoexistence = [...(right.crossRatCoexistence || []), pair];
      }
    }
    return pairs;
  }

  function apply(analysis, points, options = {}) {
    if (!analysis || !Array.isArray(analysis.incidents) || !Array.isArray(points)) return analysis;
    const crossRatPairs = crossRatCoexistence(analysis.incidents);
    let routeScan;
    try { routeScan = options.scanPayload || scanner()?.scan(points); }
    catch (error) {
      analysis.routeScanOverlap = { status: "unavailable", zones: [], matchedIncidents: 0,
        crossRatPairs, message: String(error?.message || error) };
      return analysis;
    }
    if (!routeScan || routeScan.status !== "success") {
      analysis.routeScanOverlap = { status: "unavailable", zones: [], matchedIncidents: 0, crossRatPairs };
      return analysis;
    }
    const zones = Array.isArray(routeScan.zones) ? routeScan.zones : [];
    let matchedIncidents = 0;
    for (const incident of analysis.incidents) {
      if (!isRadioDegradation(incident)) continue;
      const sourceSnapshots = sourceSnapshotMap(incident);
      const matches = zones.flatMap((zone, zoneIndex) => zone.rat === incident.rat
        ? [summarizeMatch(incident, zone, zoneIndex, sourceSnapshots)].filter(Boolean) : []);
      if (!matches.length) continue;
      matches.sort((a, b) => b.degradedSnapshotCount - a.degradedSnapshotCount ||
        b.qualitySnapshotCount - a.qualitySnapshotCount || b.sampleCount - a.sampleCount);
      incident.scanOverlap = { matches, best: matches[0], rca: rcaFor(incident, matches) };
      matchedIncidents++;
    }
    analysis.routeScanOverlap = { status: "success", zones,
      assessedSamples: routeScan.assessedSamples, totalScanZones: zones.length,
      matchedIncidents, crossRatPairs };
    return analysis;
  }

  return { apply, summarizeMatch, rcaFor, crossRatCoexistence };
});
