/* Separate severity, persistence, RCA confidence, user impact and priority. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadioScoring = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";
  const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));
  const weighted = (parts, weights) => {
    let total = 0, denominator = 0;
    Object.entries(weights).forEach(([key, weight]) => {
      if (!Number.isFinite(parts[key])) return;
      total += clamp(parts[key]) * weight;
      denominator += weight;
    });
    return denominator ? Math.round(total / denominator) : null;
  };
  const label = (value) => root.RadioProfiles?.confidenceLabel?.(value) ||
    (value >= 90 ? "very_high" : value >= 80 ? "high" : value >= 55 ? "medium" : value >= 30 ? "low" : "very_low");
  const dataQualityFor = (incident) => {
    const sequence = incident.sequence || [];
    const count = sequence.length || 1;
    const servingMeasurementCoveragePct = 100 * sequence.filter((row) =>
      Number.isFinite(row.rsrp) || Number.isFinite(row.sinr) || Number.isFinite(row.mos)).length / count;
    const neighborMeasurementCoveragePct = 100 * sequence.filter((row) =>
      Array.isArray(row.point?.parsed?.neighbors) && row.point.parsed.neighbors.some((neighbor) => {
        const rat = String(neighbor.rat || neighbor.technology || "").toUpperCase();
        const role = String(neighbor.source_kind || neighbor.sourceKind || neighbor.role || "").toUpperCase();
        return (incident.rat === "NR" ? /NR|5G/.test(rat) : /LTE|4G/.test(rat)) &&
          !/SCELL|ANCHOR|PCELL|PSCELL|SECONDARY_SERVING/.test(role);
      })).length / count;
    const comparableNeighborSamples = incident.neighborMobilityRca?.topCandidates?.reduce((sum, row) =>
      sum + (row.comparableCount || 0), 0) || 0;
    const gpsValidPct = 100 * sequence.filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng) &&
      row.lat !== 0 && row.lng !== 0).length / count;
    const breaks = sequence.slice(1).filter((row, index) => !Number.isFinite(row.timeMs) ||
      !Number.isFinite(sequence[index].timeMs) || row.timeMs - sequence[index].timeMs > 3000 ||
      row.timeMs <= sequence[index].timeMs).length;
    const timeContinuityPct = sequence.length < 2 ? 100 : 100 * (sequence.length - 1 - breaks) / (sequence.length - 1);
    const identity = incident.neighborMobilityRca?.serving?.identityConfidence ||
      (Number.isFinite(incident.dominantServing?.pci) && Number.isFinite(incident.dominantServing?.channel) ? "high" : "low");
    const targetIdentity = incident.neighborMobilityRca?.targetNeighbor?.identityConfidence || "unavailable";
    const reference = incident.rat === "NR" ? incident.dominantServing?.measurementReference ||
      incident.sequence?.[0]?.measurementReference || "UNKNOWN" : incident.rat === "LTE" ? "LTE_RSRP" : "N/A";
    const rrcAvailable = sequence.some((row) => row.point?.parsed?.rrcEvents?.length);
    const scannerAvailable = sequence.some((row) => row.point?.parsed?.scanner?.length);
    const neighborScore = incident.rat === "MOS" || incident.rat === "DATA" ? 100 : neighborMeasurementCoveragePct;
    const referenceScore = incident.rat === "NR" ? reference === "UNKNOWN" ? 30 : 100 : 100;
    const score = Math.round(clamp(servingMeasurementCoveragePct * .25 + gpsValidPct * .15 +
      timeContinuityPct * .2 + neighborScore * .2 + referenceScore * .1 +
      (identity === "high" ? 100 : identity === "medium" ? 65 : 30) * .1));
    return { score, servingMeasurementCoveragePct: Math.round(servingMeasurementCoveragePct),
      neighborMeasurementCoveragePct: Math.round(neighborMeasurementCoveragePct), comparableNeighborSamples,
      gpsContinuity: gpsValidPct >= 95 ? "Good" : "Limited", gpsValidPct: Math.round(gpsValidPct),
      timeContinuity: timeContinuityPct >= 95 ? "Good" : "Limited", timeContinuityPct: Math.round(timeContinuityPct),
      servingIdentityConfidence: identity, targetIdentityConfidence: targetIdentity,
      nrMeasurementReference: reference, rrcAvailable, scannerAvailable };
  };
  const score = (incident, profile = {}) => {
    const density = Number(incident.degradedDensityPct || 0);
    const sampleSupport = clamp(Number(incident.canonicalSampleCount || incident.sampleCount || 0) / 20 * 100);
    incident.dataQuality = dataQualityFor(incident);
    const dataQuality = incident.dataQuality.score;
    const duration = clamp(Number(incident.durationSec || 0) / 30 * 100);
    const distance = clamp(Number(incident.distanceM || 0) / 500 * 100);
    const persistence = Math.round(duration * .55 + distance * .45);
    const rsrp = incident.metrics?.rsrp?.p10;
    const sinr = incident.metrics?.sinr?.p10;
    const mos = incident.mos?.p10;
    const throughput = incident.throughput?.p10;
    const rsrpSeverity = Number.isFinite(rsrp) ? clamp(((profile.coverageEntryDbm ?? -105) - rsrp) /
      Math.max(1, (profile.coverageEntryDbm ?? -105) - (profile.coverageCriticalDbm ?? -115)) * 100) : null;
    const sinrSeverity = Number.isFinite(sinr) ? clamp(((profile.sinrEntryDb ?? 0) - sinr) /
      Math.max(1, (profile.sinrEntryDb ?? 0) - (profile.sinrCriticalDb ?? -3)) * 100) : null;
    const mosSeverity = Number.isFinite(mos) ? clamp(((profile.mos?.degraded ?? 3.5) - mos) /
      Math.max(.1, (profile.mos?.degraded ?? 3.5) - (profile.mos?.critical ?? 2.5)) * 100) : null;
    const throughputSeverity = Number.isFinite(throughput) ? clamp(((profile.throughput?.degradedMbps ?? 2) - throughput) /
      Math.max(.1, (profile.throughput?.degradedMbps ?? 2) - (profile.throughput?.criticalMbps ?? .5)) * 100) : null;
    const criticalShare = clamp(incident.criticalSnapshotPct || 0);
    const severity = incident.type === "NR_AVAILABILITY_LOSS" ? 80 : incident.type === "MOBILITY_ANOMALY" ? 65 :
      Math.round(clamp(Math.max(rsrpSeverity ?? 0, sinrSeverity ?? 0, mosSeverity ?? 0, throughputSeverity ?? 0) * .75 + criticalShare * .25));
    const serviceImpact = Number.isFinite(incident.serviceImpact?.score) ? clamp(incident.serviceImpact.score)
      : Number.isFinite(mos) ? clamp(50 + (3.5 - mos) * 35)
        : Number.isFinite(throughput) ? clamp(30 + Math.max(0, 2 - throughput) * 30)
        : incident.type === "NR_AVAILABILITY_LOSS" ? 80 : null;
    const radioContext = incident.primaryRca?.radioContext;
    const neighbourEvidence = radioContext?.hasMeasuredNeighbors
      ? clamp((radioContext.measurementCoveragePct || 0) * .6 + Math.min(100, (radioContext.recurrentNeighborCount || 0) * 25) * .4) : null;
    const inventoryEvidence = Number.isFinite(incident.geometry?.matchScore) ? clamp(incident.geometry.matchScore) : null;
    const recurrence = incident.recurrence?.available ? clamp(incident.recurrence.score) : null;
    const crossKpi = Number.isFinite(incident.correlation?.bestOverlap) ? clamp(incident.correlation.bestOverlap * 100) : null;
    const confidenceParts = { dataQuality, persistence, crossKpi, neighbourEvidence, inventoryEvidence, recurrence };
    let confidenceScore = weighted(confidenceParts, {
      dataQuality: 20, persistence: 20, crossKpi: 20, neighbourEvidence: 15, inventoryEvidence: 15, recurrence: 10,
    }) ?? 0;
    const level = incident.analysis?.cause?.evidenceLevel || incident.neighborMobilityRca?.evidenceLevel || "NOT_VERIFIABLE";
    const evidenceCaps = { NOT_VERIFIABLE: 39, POSSIBLE: 59, PROBABLE: 79, OBSERVED: 89, STRONGLY_SUPPORTED: 95 };
    confidenceScore = Math.min(confidenceScore, evidenceCaps[level] ?? 59);
    const caps = [];
    if (incident.mobility?.anomalies?.length && !incident.mobility.confirmedBySignaling && confidenceScore > 69) {
      confidenceScore = 69;
      caps.push("Mobilité inférée sans signalisation RRC décodée.");
    }
    if (radioContext?.hasMeasuredNeighbors === false && /(?:POLLUTION|MOBILITY|DOMINANCE|ALTERNATIVE|NEEDS_NEIGHBOR_CONTEXT)/.test(String(incident.primaryRca?.code || ""))) {
      confidenceScore = Math.min(confidenceScore, 39);
      caps.push("RCA voisinage sans voisins mesurés.");
    }
    if (incident.type === "MOS_DEGRADATION" && !incident.correlation?.bestOverlap && !Number.isFinite(incident.serviceMetrics?.packetLoss)
      && !Number.isFinite(incident.serviceMetrics?.jitter)) confidenceScore = Math.min(confidenceScore, 49);
    const priorityParts = { severity, userImpact: serviceImpact, persistence, distance, recurrence, confidence: confidenceScore };
    const priorityScore = weighted(priorityParts, {
      severity: 35, userImpact: 25, persistence: 15, distance: 10, recurrence: 10, confidence: 5,
    }) ?? 0;
    incident.scores = { severity, persistence, dataQuality, confidence: confidenceScore, userImpact: serviceImpact,
      priority: priorityScore, components: { confidence: confidenceParts, priority: priorityParts } };
    incident.confidence = label(confidenceScore);
    incident.confidenceDetail = { score: confidenceScore, label: incident.confidence, components: confidenceParts, caps };
    incident.priority = { score: priorityScore, components: priorityParts,
      unavailable: Object.entries(priorityParts).filter(([, value]) => !Number.isFinite(value)).map(([key]) => key) };
    incident.priorityScore = priorityScore;
    return incident;
  };
  return { score, weighted, label, dataQualityFor };
});
