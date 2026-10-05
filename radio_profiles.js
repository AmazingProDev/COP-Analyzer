/* Calibratable radio/QoE profiles. Defaults preserve the existing RF thresholds. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadioProfiles = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const VERSION = "radio-profiles-v3";
  const CONFIDENCE_LEVELS = Object.freeze({ VERY_HIGH: 90, HIGH: 80, MEDIUM: 55, LOW: 30 });
  const DEFAULT = Object.freeze({
    rf: {
      coverage: { coverageEntryDbm: -105, coverageExitDbm: -102, coverageCriticalDbm: -115, coverageMinSamples: 3, overshootRangeFactor: 1.25, overshootCloserRatio: 0.30, orientationErrorDeg: 60, stationaryMinDurationSec: 10, stationaryMaxNetDisplacementM: 50, stationaryMaxPathDistanceM: 75, stationaryMaxMeanSpeedMps: 1.25 },
      quality: { sinrEntryDb: 0, sinrExitDb: 3, sinrCriticalDb: -3, combinedSupportRatio: 0.40, mixedSymptomRatio: 0.30, sinrMinSamples: 3, minTypeSupportSnapshots: 3, minTypeSupportRatio: 0.10 },
    },
    segmentation: { canonicalBucketMs: 1000, entryWindowSnapshots: 5, entryBadSnapshots: 3, criticalConsecutiveSnapshots: 2, maintainBadRatio: 0.50, exitNormalSnapshots: 5, normalWindowSnapshots: 6, minDegradedDensity: 0.60, minDegradedSnapshots: 5, recoverySnapshots: 3, maxRecoveryBridgeSnapshots: 1, minDurationSec: 2, minDistanceM: 20, mergeGapSec: 3, maxGpsJumpM: 250, maxGpsSpeedMps: 70, macroZoneMaxGapSec: 20, macroZoneMaxGapM: 250 },
    neighbor: { bestNeighborMinPresenceRatio: 0.20, bestNeighborMinSnapshots: 3, candidateDiscoveryMinPresencePct: 20, strongEvidenceMinPresencePct: 50, neighborGoodDbm: -90, neighborAcceptableDbm: -100, neighborWeakDbm: -110, neighborMissingGapSec: 0 },
    mobility: { pingPongMaxSec: 15, pingPongMaxDistanceM: 150, mobilityBetterMinSec: 2, mobilityFailureMinSec: 5, mobilityBetterMinDistanceM: 50, mobilityLateMinSec: 4, mobilityLateMinDistanceM: 50 },
    dominance: { betterNeighborDeltaDb: 6, weakDominanceDb: 3 },
    nrContinuity: { nrLossMinDurationSec: 5, nrLossMinDistanceM: 50 },
    scoring: { recurrenceRadiusM: 100 },
    mos: { degraded: 3.5, severe: 3, critical: 2.5, recovery: 3.7, minSamples: 3,
      windowSamples: 5, criticalConsecutive: 2, recoveryConsecutive: 3, correlationWindowSec: 3,
      servicePacketLossPct: 2, serviceJitterMs: 30, serviceRttMs: 200 },
    throughput: { degradedMbps: 2, criticalMbps: .5, recoveryMbps: 3,
      minSamples: 3, windowSamples: 5, recoveryConsecutive: 3 },
  });
  const PRESETS = Object.freeze({
    LTE: { rat: "LTE" }, NR: { rat: "NR" },
    Voice: { purpose: "VOICE" }, Data: { purpose: "DATA" },
    Urban: { environment: "URBAN" }, Highway: { environment: "HIGHWAY" },
  });
  const overrides = new Map();
  const keyFor = (context = {}) => ["rat", "band", "environment", "purpose", "samplingRate"]
    .map((key) => String(context[key] || "*").toUpperCase()).join("|");
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const merge = (target, source) => {
    Object.entries(source || {}).forEach(([key, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        target[key] = merge({ ...(target[key] || {}) }, value);
      } else if (value !== undefined) target[key] = value;
    });
    return target;
  };
  const register = (context, profile) => {
    if (!context || !profile || typeof profile !== "object") throw new TypeError("Profile context and values are required");
    overrides.set(keyFor(context), clone(profile));
  };
  const getProfile = (context = {}, requested = {}) => {
    const result = clone(DEFAULT);
    const dimensions = ["rat", "band", "environment", "purpose", "samplingRate"];
    for (let count = 1; count <= dimensions.length; count += 1) {
      for (let mask = 1; mask < (1 << dimensions.length); mask += 1) {
        if (dimensions.reduce((sum, _, index) => sum + Boolean(mask & (1 << index)), 0) !== count) continue;
        const candidate = {};
        dimensions.forEach((dimension, index) => { if (mask & (1 << index)) candidate[dimension] = context[dimension]; });
        const override = overrides.get(keyFor(candidate));
        if (override) merge(result, override);
      }
    }
    merge(result, requested);
    result.coverage = { degraded: result.rf.coverage.coverageEntryDbm,
      critical: result.rf.coverage.coverageCriticalDbm, recovery: result.rf.coverage.coverageExitDbm,
      minSamples: result.rf.coverage.coverageMinSamples, ...(result.coverage || {}) };
    result.quality = { degraded: result.rf.quality.sinrEntryDb,
      critical: result.rf.quality.sinrCriticalDb, recovery: result.rf.quality.sinrExitDb,
      minSamples: result.rf.quality.sinrMinSamples, ...(result.quality || {}) };
    return result;
  };
  const radioDefaults = (profile = DEFAULT) => {
    const result = Object.assign({}, profile.rf?.coverage, profile.rf?.quality, profile.segmentation,
      profile.neighbor, profile.mobility, profile.dominance, profile.nrContinuity, profile.scoring);
    const legacy = profile.coverage || {};
    if (legacy.degraded !== undefined) result.coverageEntryDbm = legacy.degraded;
    if (legacy.critical !== undefined) result.coverageCriticalDbm = legacy.critical;
    if (legacy.recovery !== undefined) result.coverageExitDbm = legacy.recovery;
    if (legacy.minSamples !== undefined) result.coverageMinSamples = legacy.minSamples;
    const quality = profile.quality || {};
    if (quality.degraded !== undefined) result.sinrEntryDb = quality.degraded;
    if (quality.critical !== undefined) result.sinrCriticalDb = quality.critical;
    if (quality.recovery !== undefined) result.sinrExitDb = quality.recovery;
    if (quality.minSamples !== undefined) result.sinrMinSamples = quality.minSamples;
    if (profile.segmentation?.criticalConsecutive !== undefined)
      result.criticalConsecutiveSnapshots = profile.segmentation.criticalConsecutive;
    if (profile.segmentation?.recoveredConsecutive !== undefined)
      result.recoverySnapshots = profile.segmentation.recoveredConsecutive;
    if (profile.segmentation?.normalExitSnapshots !== undefined)
      result.exitNormalSnapshots = profile.segmentation.normalExitSnapshots;
    return result;
  };
  const confidenceLabel = (score) => score >= CONFIDENCE_LEVELS.VERY_HIGH ? "very_high"
    : score >= CONFIDENCE_LEVELS.HIGH ? "high"
      : score >= CONFIDENCE_LEVELS.MEDIUM ? "medium"
        : score >= CONFIDENCE_LEVELS.LOW ? "low" : "very_low";
  return { VERSION, DEFAULT, PRESETS, CONFIDENCE_LEVELS, getProfile, register, radioDefaults, confidenceLabel };
});
