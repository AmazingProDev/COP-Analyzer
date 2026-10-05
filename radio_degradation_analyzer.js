/*
 * LTE / NR Drive Test radio-degradation analysis.
 *
 * This is deliberately independent from the stable UMTS voice analyzer.  It
 * consumes the canonical LTE PCell and NR PSCell snapshots created by the
 * Benchmark TXT parser, so an LTE anchor can never be mistaken for the NR
 * serving cell and SCells never become route samples.
 */
(function radioDegradationAnalyzerFactory(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadioDegradationAnalyzer = api;
})(typeof window !== "undefined" ? window : globalThis, function makeRadioDegradationAnalyzer() {
  "use strict";

  const Profiles = globalThis.RadioProfiles || (typeof require === "function" ? require("./radio_profiles.js") : null);
  const MosAnalyzer = globalThis.RadioMosAnalyzer || (typeof require === "function" ? require("./radio_mos_analyzer.js") : null);
  const ThroughputAnalyzer = globalThis.RadioThroughputAnalyzer || (typeof require === "function" ? require("./radio_throughput_analyzer.js") : null);
  const RcaEngine = globalThis.RadioRcaEngine || (typeof require === "function" ? require("./radio_rca_engine.js") : null);
  const NeighborMobility = globalThis.RadioNeighborMobilityRca || (typeof require === "function" ? require("./radio_neighbor_mobility_rca.js") : null);
  const ScanFusion = globalThis.RadioScanFusion || (typeof require === "function" ? require("./radio_scan_fusion.js") : null);
  const Scoring = globalThis.RadioScoring || (typeof require === "function" ? require("./radio_scoring.js") : null);
  const VERSION = "lte-nr-radio-v15";
  const DEFAULT_COMMON = Object.freeze(Profiles.radioDefaults(Profiles.DEFAULT));
  const DEFAULT_PROFILES = Object.freeze({
    lte: Object.freeze({ ...DEFAULT_COMMON, id: "lte-radio-default-v2", rat: "LTE" }),
    nr: Object.freeze({ ...DEFAULT_COMMON, id: "nr-radio-default-v3", rat: "NR", sinrCriticalDb: -3 }),
  });

  const finite = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(String(value).replace(",", "."));
    return Number.isFinite(numeric) ? numeric : null;
  };
  const text = (value) => String(value ?? "").trim();
  const normal = (value) => text(value).toUpperCase().replace(/\s+/g, " ");
  const validCoordinate = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && lat !== 0 && lng !== 0;

  const timeTextFromMs = (ms) => {
    const date = new Date(ms);
    const pad = (value, width = 2) => String(value).padStart(width, "0");
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
      `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
  };

  const excelSerialTime = (value) => {
    const serial = finite(value);
    // Excel's 1900 date system: 1899-12-30 correctly includes its historical
    // leap-year compatibility offset. The supported range deliberately
    // rejects ordinary numeric timestamps, PCI values and time-only fractions.
    if (!Number.isFinite(serial) || serial < 20000 || serial > 90000) return null;
    const ms = Date.UTC(1899, 11, 30) + Math.round(serial * 86400000);
    return { raw: timeTextFromMs(ms), ms };
  };

  const parseTime = (value, sourceValue = null) => {
    const raw = text(value);
    if (!raw) return { raw, ms: null };
    const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (match) {
      return {
        raw,
        ms: Date.UTC(
          Number(match[1]), Number(match[2]) - 1, Number(match[3]),
          Number(match[4]), Number(match[5]), Number(match[6]),
          Number(String(match[7] || "0").padEnd(3, "0")),
        ),
      };
    }
    // The MOS/Benchmark Excel adapter keeps its source serial in
    // `__sourceTime` but formats the display field as HH:mm:ss.SSS. Parse the
    // source serial before Date.parse so every point retains its real day and
    // can participate in chronological segmentation.
    const excel = excelSerialTime(sourceValue) || excelSerialTime(value);
    if (excel) return excel;
    const parsed = Date.parse(raw);
    return { raw, ms: Number.isFinite(parsed) ? parsed : null };
  };

  const haversineM = (a, b) => {
    if (!a || !b || !validCoordinate(Number(a.lat), Number(a.lng)) || !validCoordinate(Number(b.lat), Number(b.lng))) return 0;
    const radians = Math.PI / 180;
    const dLat = (Number(b.lat) - Number(a.lat)) * radians;
    const dLng = (Number(b.lng) - Number(a.lng)) * radians;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(Number(a.lat) * radians) * Math.cos(Number(b.lat) * radians) * Math.sin(dLng / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };

  const numericStats = (values) => {
    const sorted = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return { min: null, p10: null, median: null, p90: null, max: null };
    const quantile = (p) => {
      const index = (sorted.length - 1) * p;
      const left = Math.floor(index);
      const right = Math.ceil(index);
      return left === right ? sorted[left] : sorted[left] + (sorted[right] - sorted[left]) * (index - left);
    };
    return { min: sorted[0], p10: quantile(0.1), median: quantile(0.5), p90: quantile(0.9), max: sorted[sorted.length - 1] };
  };

  const percent = (part, total) => total > 0 ? Number((part * 100 / total).toFixed(1)) : 0;
  const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0));
  const medianFinite = (values) => numericStats(values).median;
  const angularDifference = (a, b) => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.abs((((a - b) % 360) + 540) % 360 - 180);
  };
  const bearingDeg = (from, to) => {
    if (!from || !to || !validCoordinate(Number(from.lat), Number(from.lng)) ||
      !validCoordinate(Number(to.lat), Number(to.lng))) return null;
    const radians = Math.PI / 180;
    const lat1 = Number(from.lat) * radians;
    const lat2 = Number(to.lat) * radians;
    const dLng = (Number(to.lng) - Number(from.lng)) * radians;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) / radians + 360) % 360;
  };
  const isFallbackCellName = (value) => /^(?:LTE|NR)\s+PCI\s+/i.test(text(value));
  const cellNameFor = (rat, serving, point) => {
    const candidate = serving?.cellName || serving?.name ||
      (rat === "NR" ? point?.nr_serving_cell_name : point?.lte_serving_cell_name);
    if (candidate && !/^(?:unknown|n\/?a|null)$/i.test(String(candidate).trim())) return text(candidate);
    const pci = finite(serving?.pci ?? serving?.sc);
    const channel = finite(serving?.nrarfcn ?? serving?.earfcn ?? serving?.freq);
    return `${rat} PCI ${pci ?? "N/D"} / ${rat === "NR" ? "NR-ARFCN" : "EARFCN"} ${channel ?? "N/D"}`;
  };

  const identityFor = (rat, serving, name) => {
    const pci = finite(serving?.pci ?? serving?.sc);
    const channel = finite(serving?.nrarfcn ?? serving?.earfcn ?? serving?.freq);
    return [rat, pci ?? "", channel ?? "", normal(name)].join("|");
  };

  const bandFor = (rat, channel, explicit = null) => {
    const raw = text(explicit);
    if (raw) return raw;
    const value = finite(channel);
    if (!Number.isFinite(value)) return "";
    if (rat === "NR") {
      if (value >= 620000 && value <= 680000) return "n78";
      if (value >= 499200 && value <= 537999) return "n41";
      if (value >= 151600 && value <= 160600) return "n28";
      if (value >= 361000 && value <= 376000) return "n3";
      if (value >= 422000 && value <= 440000) return "n1";
      return `NR-ARFCN ${value}`;
    }
    if (value >= 0 && value <= 599) return "B1";
    if (value >= 600 && value <= 1199) return "B2";
    if (value >= 1200 && value <= 1949) return "B3";
    if (value >= 2750 && value <= 3449) return "B7";
    if (value >= 3450 && value <= 3799) return "B8";
    if (value >= 6150 && value <= 6449) return "B20";
    return `EARFCN ${value}`;
  };

  // Presentation uses the same source of truth as incident detection. Keep
  // this mapping here so the UI, RCA report and XLSX never disagree on a
  // frequency band label.
  const displayBandFor = (rat, channel, explicit = null) => {
    const canonical = bandFor(rat, channel, explicit);
    const labels = rat === "NR"
      ? { n28: "NR n28 / NR700", n1: "NR n1 / NR2100", n3: "NR n3 / NR1800", n41: "NR n41", n78: "NR n78 / C-Band" }
      : { B1: "LTE B1 / L2100", B2: "LTE B2 / L1900", B3: "LTE B3 / L1800", B7: "LTE B7 / L2600", B8: "LTE B8 / L900", B20: "LTE B20 / L800" };
    return labels[canonical] || (canonical ? `${rat === "NR" ? "NR" : "LTE"} ${canonical}` : "N/A");
  };

  const anchorFor = (point) => {
    const serving = point?.parsed?.serving_lte;
    if (!serving) return null;
    const pci = finite(serving.pci ?? serving.sc);
    const channel = finite(serving.earfcn ?? serving.freq);
    const cellName = cellNameFor("LTE", serving, point);
    return {
      rat: "LTE",
      role: "LTE PCell (anchor)",
      pci,
      channel,
      band: bandFor("LTE", channel, serving.band),
      cellName,
      cellKey: identityFor("LTE", serving, cellName),
      rsrp: valueFor(explicitValueFor(point, "4G RSRP"), serving, "rsrp"),
      sinr: valueFor(explicitValueFor(point, "4G SINR"), serving, "sinr"),
    };
  };

  const explicitValueFor = (point, field) => finite(point?.[field] ?? point?.properties?.[field]);
  const valueFor = (explicit, serving, servingField) => {
    if (explicit !== null) return explicit;
    return finite(serving?.[servingField]);
  };

  const snapshotFor = (point, sourceIndex, rat, allowAnchor = false) => {
    const serving = rat === "NR" ? point?.parsed?.serving_nr : point?.parsed?.serving_lte;
    if (!serving) return null;
    // EN-DC has two genuine radio legs, but it has only one user-facing
    // serving cell: the NR PSCell. The LTE PCell is its anchor. Do not create
    // LTE coverage/SINR candidates while a NR PSCell is present; otherwise a
    // weak anchor would be incorrectly reported as a user-serving fault.
    if (rat === "LTE" && point?.parsed?.serving_nr && !allowAnchor) return null;
    const lat = finite(point?.lat);
    const lng = finite(point?.lng);
    if (!validCoordinate(lat, lng)) return null;
    const time = parseTime(point?.time ?? point?.properties?.Time, point?.__sourceTime ?? point?.properties?.__sourceTime);
    if (!time.raw || !Number.isFinite(time.ms)) return null;
    const prefix = rat === "NR" ? "5G" : "4G";
    const explicitRsrp = explicitValueFor(point, `${prefix} RSRP`);
    const explicitSinr = explicitValueFor(point, `${prefix} SINR`);
    // Benchmark parser can attach an identity to a nearby application/service
    // row. That context is useful in Point Details, but its copied RF values
    // are not a new radio observation and must never extend an incident.
    const inheritedContext = /nearest preceding radio snapshot/i.test(String(
      point?.properties?.["Serving context"] ?? point?.["Serving context"] ?? "",
    ));
    if (inheritedContext && explicitRsrp === null && explicitSinr === null) return null;
    const rsrp = valueFor(explicitRsrp, serving, "rsrp");
    const sinr = valueFor(explicitSinr, serving, "sinr");
    // No radio value means a configuration/service row, not a serving DT
    // sample. It must not create a recovery nor bridge a candidate.
    if (rsrp === null && sinr === null) return null;
    const cellName = cellNameFor(rat, serving, point);
    const pci = finite(serving.pci ?? serving.sc);
    const channel = finite(rat === "NR" ? (serving.nrarfcn ?? serving.ssbNrarfcn ?? serving.freq) : (serving.earfcn ?? serving.freq));
    const nrReference = String(serving.measurementReference ?? point?.parsed?.nrMeasurementReference ??
      (finite(point?.["5G SS-RSRP"] ?? point?.properties?.["5G SS-RSRP"]) !== null ? "SS_RSRP" :
        finite(point?.["5G CSI-RSRP"] ?? point?.properties?.["5G CSI-RSRP"]) !== null ? "CSI_RSRP" : "UNKNOWN"));
    return {
      rat,
      role: rat === "NR" ? "NR PSCell" : "LTE PCell",
      sourceIndex,
      point,
      time: time.raw,
      timeMs: time.ms,
      lat,
      lng,
      rsrp,
      sinr,
      pci,
      channel,
      measurementReference: rat === "NR" ? nrReference : "LTE_RSRP",
      frequencyReference: rat === "NR" ? String(serving.frequencyReference ||
        (serving.nrarfcn !== undefined ? "CARRIER_ARFCN" : serving.ssbNrarfcn !== undefined ? "SSB_ARFCN" : "UNKNOWN")) : "EARFCN",
      ssbIndex: finite(serving.ssbIndex ?? serving.beam_index ?? serving.beam),
      bwpId: finite(serving.bwpId ?? serving.bwp_id),
      ssbArfcn: finite(serving.ssbNrarfcn),
      carrierArfcn: finite(serving.nrarfcn),
      band: bandFor(rat, channel, serving.band ?? point?.properties?.[`${prefix} Band`]),
      cellName,
      reportedCellName: cellName,
      nameSource: isFallbackCellName(cellName) ? "derived" : "source",
      cellKey: identityFor(rat, serving, cellName),
      anchor: rat === "NR" ? anchorFor(point) : null,
      sourceIndices: [sourceIndex],
    };
  };

  const buildSnapshots = (points, profiles = DEFAULT_PROFILES) => {
    const byRat = { LTE: new Map(), NR: new Map() };
    (points || []).forEach((point, sourceIndex) => {
      ["LTE", "NR"].forEach((rat) => {
        const snapshot = snapshotFor(point, sourceIndex, rat);
        if (!snapshot) return;
        const bucketMs = Math.max(1, Number((rat === "NR" ? profiles.nr : profiles.lte)?.canonicalBucketMs) || 1000);
        const key = Math.floor(snapshot.timeMs / bucketMs);
        const bucket = byRat[rat].get(key) || [];
        bucket.push(snapshot);
        byRat[rat].set(key, bucket);
      });
    });
    const collapse = (buckets, profile) => [...buckets.values()].map((bucket) => {
      const groups = new Map();
      bucket.forEach((snapshot) => {
        if (!groups.has(snapshot.cellKey)) groups.set(snapshot.cellKey, []);
        groups.get(snapshot.cellKey).push(snapshot);
      });
      const selected = [...groups.values()].sort((a, b) =>
        new Set(b.map((item) => item.timeMs)).size - new Set(a.map((item) => item.timeMs)).size ||
        b[b.length - 1].timeMs - a[a.length - 1].timeMs)[0] || bucket;
      // An export may repeat the same physical measurement at one timestamp.
      // Collapse it before counting critical runs or computing RF percentiles.
      const byInstant = new Map();
      selected.forEach((sample) => {
        const same = byInstant.get(sample.timeMs) || [];
        same.push(sample);
        byInstant.set(sample.timeMs, same);
      });
      const chosen = [...byInstant.values()].map((same) => {
        const latestAtTime = same[same.length - 1];
        const neighbors = same.flatMap((item) => item.point?.parsed?.neighbors || []);
        return { ...latestAtTime, rsrp: medianFinite(same.map((item) => item.rsrp)),
          sinr: medianFinite(same.map((item) => item.sinr)),
          point: neighbors.length ? { ...latestAtTime.point,
            parsed: { ...(latestAtTime.point?.parsed || {}), neighbors } } : latestAtTime.point,
          sourceIndices: [...new Set(same.flatMap((item) => item.sourceIndices || [item.sourceIndex]))],
          rawDuplicates: same };
      });
      const latest = chosen.slice().sort((a, b) => b.timeMs - a.timeMs || b.sourceIndex - a.sourceIndex)[0];
      const neighborRows = new Map();
      chosen.slice().sort((a, b) => a.timeMs - b.timeMs || a.sourceIndex - b.sourceIndex).forEach((sample) => {
        sample.rawDuplicates.flatMap((item) => item.point?.parsed?.neighbors || []).forEach((neighbor) => {
          const key = [normal(neighbor.rat ?? neighbor.technology),
            finite(neighbor.pci ?? neighbor.sc) ?? "", finite(neighbor.nrarfcn ?? neighbor.earfcn ?? neighbor.freq) ?? "",
            normal(neighbor.source_kind ?? neighbor.sourceKind ?? neighbor.role)].join("|");
          const group = neighborRows.get(key) || [];
          group.push(neighbor);
          neighborRows.set(key, group);
        });
      });
      const canonicalPoint = neighborRows.size ? {
        ...latest.point, parsed: { ...(latest.point?.parsed || {}), neighbors: [...neighborRows.values()].map((group) => ({
          ...group[group.length - 1], rsrp: medianFinite(group.map((item) => finite(item.rsrp ?? item.ssRsrp ?? item.csiRsrp))),
          rsrq: medianFinite(group.map((item) => finite(item.rsrq ?? item.ssRsrq))),
          sinr: medianFinite(group.map((item) => finite(item.sinr ?? item.ssSinr))),
        })) },
      } : latest.point;
      const rsrpStats = numericStats(chosen.map((item) => item.rsrp));
      const sinrStats = numericStats(chosen.map((item) => item.sinr));
      const degradedCount = chosen.filter((item) =>
        (Number.isFinite(item.rsrp) && item.rsrp <= profile.coverageEntryDbm) ||
        (Number.isFinite(item.sinr) && item.sinr <= profile.sinrEntryDb)).length;
      const criticalCount = chosen.filter((item) =>
        (Number.isFinite(item.rsrp) && item.rsrp <= profile.coverageCriticalDbm) ||
        (Number.isFinite(item.sinr) && item.sinr <= profile.sinrCriticalDb)).length;
      let criticalRun = 0;
      let rsrpCriticalRun = 0;
      let sinrCriticalRun = 0;
      let maxRsrpCriticalRun = 0;
      let maxSinrCriticalRun = 0;
      const maxCriticalRun = chosen.slice().sort((a, b) => a.timeMs - b.timeMs)
        .reduce((max, item) => {
          const rsrpCritical = Number.isFinite(item.rsrp) && item.rsrp <= profile.coverageCriticalDbm;
          const sinrCritical = Number.isFinite(item.sinr) && item.sinr <= profile.sinrCriticalDb;
          rsrpCriticalRun = rsrpCritical ? rsrpCriticalRun + 1 : 0;
          sinrCriticalRun = sinrCritical ? sinrCriticalRun + 1 : 0;
          maxRsrpCriticalRun = Math.max(maxRsrpCriticalRun, rsrpCriticalRun);
          maxSinrCriticalRun = Math.max(maxSinrCriticalRun, sinrCriticalRun);
          const critical = rsrpCritical || sinrCritical;
          criticalRun = critical ? criticalRun + 1 : 0;
          return Math.max(max, criticalRun);
        }, 0);
      return {
        ...latest,
        point: canonicalPoint,
        bucketKey: Math.floor(latest.timeMs / profile.canonicalBucketMs),
        lat: medianFinite(chosen.map((item) => item.lat)),
        lng: medianFinite(chosen.map((item) => item.lng)),
        rsrp: rsrpStats.median,
        sinr: sinrStats.median,
        bucketStats: { rsrp: rsrpStats, sinr: sinrStats,
          sampleCount: chosen.length, degradedShare: degradedCount / chosen.length,
          criticalShare: criticalCount / chosen.length, maxCriticalRun,
          maxRsrpCriticalRun, maxSinrCriticalRun },
        sourceIndices: [...new Set(chosen.flatMap((item) => item.sourceIndices || [item.sourceIndex]))],
        rawSampleCount: chosen.length,
        rawSamples: chosen,
      };
    }).sort((a, b) => a.timeMs - b.timeMs || a.sourceIndex - b.sourceIndex);
    const nr = collapse(byRat.NR, profiles.nr);
    const nrByBucket = new Map(nr.map((snapshot) => [Math.floor(snapshot.timeMs /
      Math.max(1, profiles.nr.canonicalBucketMs)), snapshot]));
    const lte = collapse(byRat.LTE, profiles.lte).filter((snapshot) => {
      const sameSecondNr = nrByBucket.get(Math.floor(snapshot.timeMs /
        Math.max(1, profiles.nr.canonicalBucketMs)));
      if (!sameSecondNr) return true;
      if (!sameSecondNr.anchor) sameSecondNr.anchor = {
        rat: "LTE", role: "LTE PCell (anchor)", pci: snapshot.pci, channel: snapshot.channel,
        band: snapshot.band, cellName: snapshot.cellName, cellKey: snapshot.cellKey,
        rsrp: snapshot.rsrp, sinr: snapshot.sinr,
      };
      return false;
    });
    return { LTE: lte, NR: nr };
  };

  const buildServingStream = (snapshotsByRat, profiles) => {
    // Some exports contain an LTE component row and an NR component row in
    // the same second. There is still only one user-facing serving decision:
    // the NR PSCell wins and LTE remains the NSA anchor/context.
    const bucketMs = Math.max(1, Math.min(
      Number(profiles?.lte?.canonicalBucketMs) || 1000,
      Number(profiles?.nr?.canonicalBucketMs) || 1000,
    ));
    const buckets = new Map();
    [...(snapshotsByRat?.LTE || []), ...(snapshotsByRat?.NR || [])].forEach((snapshot) => {
      const key = Math.floor(snapshot.timeMs / bucketMs);
      const bucket = buckets.get(key) || [];
      bucket.push(snapshot);
      buckets.set(key, bucket);
    });
    return [...buckets.values()].map((bucket) => {
      const nr = bucket.filter((snapshot) => snapshot.rat === "NR");
      const candidates = nr.length ? nr : bucket.filter((snapshot) => snapshot.rat === "LTE");
      return candidates.slice().sort((a, b) => b.timeMs - a.timeMs || b.sourceIndex - a.sourceIndex)[0];
    }).filter(Boolean).sort((a, b) => a.timeMs - b.timeMs || a.sourceIndex - b.sourceIndex);
  };

  const normalizeProfile = (requested, defaults) => {
    const profile = { ...defaults, ...(requested || {}) };
    const bounded = (value, fallback, min, max) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
    };
    profile.coverageEntryDbm = bounded(profile.coverageEntryDbm, defaults.coverageEntryDbm, -150, -40);
    profile.coverageExitDbm = Math.max(profile.coverageEntryDbm, bounded(profile.coverageExitDbm, defaults.coverageExitDbm, -150, -40));
    profile.coverageCriticalDbm = Math.min(profile.coverageEntryDbm, bounded(profile.coverageCriticalDbm, defaults.coverageCriticalDbm, -150, -40));
    profile.sinrEntryDb = bounded(profile.sinrEntryDb, defaults.sinrEntryDb, -30, 30);
    profile.sinrExitDb = Math.max(profile.sinrEntryDb, bounded(profile.sinrExitDb, defaults.sinrExitDb, -30, 40));
    profile.sinrCriticalDb = Math.min(profile.sinrEntryDb, bounded(profile.sinrCriticalDb, defaults.sinrCriticalDb, -30, 30));
    profile.canonicalBucketMs = Math.round(bounded(profile.canonicalBucketMs, defaults.canonicalBucketMs, 100, 5000));
    profile.entryWindowSnapshots = Math.round(bounded(profile.entryWindowSnapshots, defaults.entryWindowSnapshots, 2, 20));
    profile.entryBadSnapshots = Math.round(bounded(profile.entryBadSnapshots, defaults.entryBadSnapshots, 1, profile.entryWindowSnapshots));
    profile.criticalConsecutiveSnapshots = Math.round(bounded(profile.criticalConsecutiveSnapshots, defaults.criticalConsecutiveSnapshots, 2, 10));
    profile.maintainBadRatio = bounded(profile.maintainBadRatio, defaults.maintainBadRatio, 0, 1);
    profile.normalWindowSnapshots = Math.round(bounded(profile.normalWindowSnapshots, defaults.normalWindowSnapshots, 3, 20));
    profile.exitNormalSnapshots = Math.round(bounded(profile.exitNormalSnapshots, defaults.exitNormalSnapshots, 1, profile.normalWindowSnapshots));
    profile.minDegradedDensity = bounded(profile.minDegradedDensity, defaults.minDegradedDensity, 0, 1);
    profile.combinedSupportRatio = bounded(profile.combinedSupportRatio, defaults.combinedSupportRatio, 0, 1);
    profile.mixedSymptomRatio = bounded(profile.mixedSymptomRatio, defaults.mixedSymptomRatio, 0, 1);
    ["coverageMinSamples", "sinrMinSamples", "minDegradedSnapshots", "minTypeSupportSnapshots", "recoverySnapshots"].forEach((key) => {
      profile[key] = Math.round(bounded(profile[key], defaults[key], 1, 1000));
    });
    profile.maxRecoveryBridgeSnapshots = Math.round(bounded(profile.maxRecoveryBridgeSnapshots, defaults.maxRecoveryBridgeSnapshots, 0, 100));
    profile.minTypeSupportRatio = bounded(profile.minTypeSupportRatio, defaults.minTypeSupportRatio, 0, 1);
    profile.minDurationSec = bounded(profile.minDurationSec, defaults.minDurationSec, 0, 3600);
    profile.minDistanceM = bounded(profile.minDistanceM, defaults.minDistanceM, 0, 100000);
    profile.mergeGapSec = bounded(profile.mergeGapSec, defaults.mergeGapSec, 0, 300);
    profile.maxGpsJumpM = bounded(profile.maxGpsJumpM, defaults.maxGpsJumpM, 20, 10000);
    profile.maxGpsSpeedMps = bounded(profile.maxGpsSpeedMps, defaults.maxGpsSpeedMps, 10, 250);
    profile.macroZoneMaxGapSec = bounded(profile.macroZoneMaxGapSec, defaults.macroZoneMaxGapSec, 0, 3600);
    profile.macroZoneMaxGapM = bounded(profile.macroZoneMaxGapM, defaults.macroZoneMaxGapM, 0, 100000);
    profile.betterNeighborDeltaDb = bounded(profile.betterNeighborDeltaDb, defaults.betterNeighborDeltaDb, 0, 30);
    profile.weakDominanceDb = bounded(profile.weakDominanceDb, defaults.weakDominanceDb, 0, 30);
    profile.bestNeighborMinPresenceRatio = bounded(profile.bestNeighborMinPresenceRatio, defaults.bestNeighborMinPresenceRatio, 0, 1);
    profile.bestNeighborMinSnapshots = Math.round(bounded(profile.bestNeighborMinSnapshots, defaults.bestNeighborMinSnapshots, 1, 1000));
    profile.candidateDiscoveryMinPresencePct = bounded(profile.candidateDiscoveryMinPresencePct, defaults.candidateDiscoveryMinPresencePct, 0, 100);
    profile.strongEvidenceMinPresencePct = bounded(profile.strongEvidenceMinPresencePct, defaults.strongEvidenceMinPresencePct, 0, 100);
    profile.neighborGoodDbm = bounded(profile.neighborGoodDbm, defaults.neighborGoodDbm, -150, -40);
    profile.neighborAcceptableDbm = bounded(profile.neighborAcceptableDbm, defaults.neighborAcceptableDbm, -150, -40);
    profile.neighborWeakDbm = bounded(profile.neighborWeakDbm, defaults.neighborWeakDbm, -150, -40);
    profile.nrLossMinDurationSec = bounded(profile.nrLossMinDurationSec, defaults.nrLossMinDurationSec, 0, 3600);
    profile.nrLossMinDistanceM = bounded(profile.nrLossMinDistanceM, defaults.nrLossMinDistanceM, 0, 100000);
    profile.pingPongMaxSec = bounded(profile.pingPongMaxSec, defaults.pingPongMaxSec, 1, 300);
    profile.pingPongMaxDistanceM = bounded(profile.pingPongMaxDistanceM, defaults.pingPongMaxDistanceM, 1, 10000);
    profile.mobilityBetterMinSec = bounded(profile.mobilityBetterMinSec, defaults.mobilityBetterMinSec, 0, 300);
    profile.mobilityFailureMinSec = bounded(profile.mobilityFailureMinSec, defaults.mobilityFailureMinSec, 0, 3600);
    profile.neighborMissingGapSec = bounded(profile.neighborMissingGapSec, defaults.neighborMissingGapSec, 0, 2);
    profile.mobilityBetterMinDistanceM = bounded(profile.mobilityBetterMinDistanceM, defaults.mobilityBetterMinDistanceM, 0, 1000);
    profile.mobilityLateMinSec = bounded(profile.mobilityLateMinSec, defaults.mobilityLateMinSec, 0, 120);
    profile.mobilityLateMinDistanceM = bounded(profile.mobilityLateMinDistanceM, defaults.mobilityLateMinDistanceM, 0, 1000);
    profile.recurrenceRadiusM = bounded(profile.recurrenceRadiusM, defaults.recurrenceRadiusM, 10, 5000);
    profile.overshootRangeFactor = bounded(profile.overshootRangeFactor, defaults.overshootRangeFactor, 1, 10);
    profile.overshootCloserRatio = bounded(profile.overshootCloserRatio, defaults.overshootCloserRatio, 0, 1);
    profile.orientationErrorDeg = bounded(profile.orientationErrorDeg, defaults.orientationErrorDeg, 1, 180);
    profile.stationaryMinDurationSec = bounded(profile.stationaryMinDurationSec, defaults.stationaryMinDurationSec, 5, 3600);
    profile.stationaryMaxNetDisplacementM = bounded(profile.stationaryMaxNetDisplacementM, defaults.stationaryMaxNetDisplacementM, 5, 1000);
    profile.stationaryMaxPathDistanceM = bounded(profile.stationaryMaxPathDistanceM, defaults.stationaryMaxPathDistanceM, 5, 5000);
    profile.stationaryMaxMeanSpeedMps = bounded(profile.stationaryMaxMeanSpeedMps, defaults.stationaryMaxMeanSpeedMps, 0.1, 20);
    return profile;
  };

  const classificationFor = (rows, profile, fastCritical = false) => {
    const degraded = rows.filter((row) => row.rawCoverage || row.rawSinr);
    const total = Math.max(1, degraded.length);
    const coverageRaw = degraded.filter((row) => row.rawCoverage).length;
    const sinrRaw = degraded.filter((row) => row.rawSinr).length;
    const requiredCoverage = fastCritical ? 2 : Math.max(profile.coverageMinSamples, profile.minTypeSupportSnapshots,
      Math.ceil(total * profile.minTypeSupportRatio));
    const requiredSinr = fastCritical ? 2 : Math.max(profile.sinrMinSamples, profile.minTypeSupportSnapshots,
      Math.ceil(total * profile.minTypeSupportRatio));
    const coverage = coverageRaw >= requiredCoverage ? coverageRaw : 0;
    const sinr = sinrRaw >= requiredSinr ? sinrRaw : 0;
    if (!coverage && !sinr) return null;
    const both = coverage && sinr ? degraded.filter((row) => row.rawCoverage && row.rawSinr).length : 0;
    const coverageOnly = coverage - both;
    const sinrOnly = sinr - both;
    if ((both / total) >= profile.combinedSupportRatio) {
      return { type: "COMBINED_RADIO_DEGRADATION", category: "combined" };
    }
    if ((coverageOnly / total) >= profile.mixedSymptomRatio && (sinrOnly / total) >= profile.mixedSymptomRatio) {
      return { type: "MIXED_RADIO_DEGRADATION", category: "mixed" };
    }
    if (coverage >= sinr) return { type: "COVERAGE_DEGRADATION", category: "coverage" };
    return { type: "SINR_DEGRADATION", category: "sinr" };
  };

  // Coverage and quality have their own time windows. A long coverage zone
  // must not turn one isolated low-SINR sample into a quality correlation.
  const buildSymptomEpisodes = (snapshots, profile, rat, metric) => {
    const isCoverage = metric === "rsrp";
    const degradedThreshold = isCoverage ? profile.coverageEntryDbm : profile.sinrEntryDb;
    const criticalThreshold = isCoverage ? profile.coverageCriticalDbm : profile.sinrCriticalDb;
    const recoveryThreshold = isCoverage ? profile.coverageExitDbm : profile.sinrExitDb;
    const criticalRunKey = isCoverage ? "maxRsrpCriticalRun" : "maxSinrCriticalRun";
    const required = isCoverage ? profile.coverageMinSamples : profile.sinrMinSamples;
    const episodes = [];
    let pending = [], current = null, previous = null, recovered = 0;
    const rowFor = (snapshot) => {
      const value = snapshot[metric], bucket = snapshot.bucketStats?.[metric];
      return { snapshot,
        degraded: Number.isFinite(value) && value <= degradedThreshold ||
          Number.isFinite(bucket?.p10) && bucket.p10 <= criticalThreshold,
        critical: Number.isFinite(bucket?.min) && bucket.min <= criticalThreshold,
        fastWithinBucket: (snapshot.bucketStats?.[criticalRunKey] || 0) >= profile.criticalConsecutiveSnapshots,
        recovered: Number.isFinite(value) && value > recoveryThreshold };
    };
    const flush = () => {
      if (!current?.length) { current = null; return; }
      while (current.length && !current[current.length - 1].degraded) current.pop();
      while (current.length && !current[0].degraded) current.shift();
      const bad = current.filter((row) => row.degraded);
      const fast = current.some((row, index) => row.fastWithinBucket ||
        index > 0 && row.critical && current[index - 1].critical);
      if (!current.length || bad.length < (fast ? 1 : required) ||
        (!fast && bad.length / current.length < profile.minDegradedDensity)) { current = null; return; }
      const first = current[0].snapshot, last = current[current.length - 1].snapshot;
      const durationSec = Math.max(0, (last.timeMs - first.timeMs) / 1000);
      const distanceM = current.slice(1).reduce((sum, row, index) =>
        sum + haversineM(current[index].snapshot, row.snapshot), 0);
      if (!fast && durationSec < profile.minDurationSec && distanceM < profile.minDistanceM) { current = null; return; }
      episodes.push({ id: `${rat.toLowerCase()}_${metric}_${episodes.length + 1}`,
        rat, metric, type: isCoverage ? "COVERAGE" : "QUALITY", startTime: first.time, endTime: last.time,
        startTimeMs: first.timeMs, endTimeMs: last.timeMs, durationSec, distanceM,
        sampleCount: bad.length, canonicalSampleCount: current.length,
        criticalSnapshotCount: current.filter((row) => row.critical).length,
        fastCritical: fast, distribution: numericStats(current.map((row) => row.snapshot[metric])) });
      current = null;
    };
    snapshots.forEach((snapshot) => {
      const row = rowFor(snapshot);
      const gapSec = previous ? (snapshot.timeMs - previous.timeMs) / 1000 : 0;
      if (previous && (gapSec < 0 || gapSec > profile.mergeGapSec ||
        gapSec > 0 && haversineM(previous, snapshot) / gapSec > profile.maxGpsSpeedMps)) {
        flush(); pending = []; recovered = 0;
      }
      pending.push(row);
      if (pending.length > profile.entryWindowSnapshots) pending.shift();
      if (!current) {
        const criticalTail = pending.slice(-profile.criticalConsecutiveSnapshots);
        if (pending.filter((item) => item.degraded).length >= profile.entryBadSnapshots ||
          row.fastWithinBucket || criticalTail.length >= profile.criticalConsecutiveSnapshots &&
            criticalTail.every((item) => item.critical)) {
          current = pending.slice(Math.max(0, pending.findIndex((item) => item.degraded)));
          pending = []; recovered = 0;
        }
      } else {
        current.push(row);
        recovered = row.recovered ? recovered + 1 : 0;
        const tail = current.slice(-profile.normalWindowSnapshots);
        if (recovered >= profile.recoverySnapshots ||
          tail.length >= profile.normalWindowSnapshots &&
            tail.filter((item) => !item.degraded).length >= profile.exitNormalSnapshots) {
          const restart = tail.slice(-profile.entryWindowSnapshots);
          flush(); pending = restart; recovered = 0;
        }
      }
      previous = snapshot;
    });
    flush();
    return episodes;
  };

  const neighborRatFor = (neighbor) => {
    const explicit = normal(neighbor?.rat ?? neighbor?.technology ?? neighbor?.tech ?? neighbor?.radio);
    if (/\b(?:NR|5G|NGRAN)\b/.test(explicit) || neighbor?.nrarfcn !== undefined || neighbor?.ssbNrarfcn !== undefined) return "NR";
    if (/\b(?:LTE|4G|E-UTRA|EUTRA)\b/.test(explicit) || neighbor?.earfcn !== undefined) return "LTE";
    return null;
  };

  const neighborFor = (raw, serving, rat) => {
    if (!raw || neighborRatFor(raw) !== rat) return null;
    const sourceKind = normal(raw.source_kind ?? raw.sourceKind ?? raw.role ?? raw.type);
    // Benchmark component rows label LTE/NR secondary legs as
    // `secondary_serving`. They are inventory/context rows, not a measured
    // neighbour set. Keeping them here would turn an anchor/SCell into a
    // fabricated RCA alternative.
    if (/(?:SECONDARY[_\s-]*SERVING|\bSCELL\b|\bPCELL\b|\bPSCELL\b|\bANCHOR\b)/.test(sourceKind)) return null;
    const pci = finite(raw.pci ?? raw.sc ?? raw.psc ?? raw.physicalCellId);
    const channel = finite(rat === "NR"
      ? (raw.nrarfcn ?? raw.ssbNrarfcn ?? raw.freq ?? raw.arfcn)
      : (raw.earfcn ?? raw.freq ?? raw.uarfcn ?? raw.arfcn));
    const servingChannel = finite(serving?.channel);
    const servingPci = finite(serving?.pci);
    // A repeated serving row in the neighbour collection is not independent
    // evidence. Exclude it before calculating dominance or alternatives.
    if (pci !== null && pci === servingPci && (channel === null || servingChannel === null || channel === servingChannel)) return null;
    const rsrp = finite(raw.rsrp ?? raw.rscp ?? raw.ssRsrp ?? raw.level);
    // RSRQ/EcNo is a different radio quantity and cannot stand in for SINR.
    const sinr = finite(raw.sinr ?? raw.ssSinr);
    if (rsrp === null && sinr === null) return null;
    const name = text(raw.cellName ?? raw.cell_name ?? raw.name ?? raw.label) ||
      `${rat} PCI ${pci ?? "N/D"} / ${rat === "NR" ? "NR-ARFCN" : "EARFCN"} ${channel ?? "N/D"}`;
    return {
      rat,
      pci,
      channel,
      cellName: name,
      cellKey: [rat, pci ?? "", channel ?? "", normal(name)].join("|"),
      rsrp,
      sinr,
      sameFrequency: channel !== null && servingChannel !== null && channel === servingChannel,
      sourceKind: text(raw.source_kind ?? raw.sourceKind ?? raw.type ?? "measured"),
    };
  };

  const publicNeighbor = (candidate) => candidate ? {
    cellName: candidate.cellName,
    pci: candidate.pci,
    channel: candidate.channel,
    rat: candidate.rat,
    sampleCount: candidate.sampleCount,
    presenceRatio: candidate.presenceRatio,
    rsrp: candidate.rsrp,
    sinr: candidate.sinr,
    medianDeltaDb: candidate.delta.median,
    sameFrequency: candidate.sameFrequency,
    band: candidate.band,
    alternativeClass: candidate.alternativeClass,
    inventory: candidate.inventory || null,
  } : null;

  const neighborContextFor = (rows, profile, rat) => {
    const candidates = new Map();
    const otherRatCandidates = new Map();
    let measurementSnapshots = 0;
    const dominanceRows = [];
    let significantThreeCellSnapshots = 0;
    rows.forEach((row) => {
      const rawNeighbors = Array.isArray(row.snapshot?.point?.parsed?.neighbors)
        ? row.snapshot.point.parsed.neighbors : [];
      const seen = new Set();
      let usableAtSnapshot = false;
      const snapshotNeighbors = [];
      rawNeighbors.forEach((raw) => {
        const rawRat = neighborRatFor(raw);
        if (rawRat && rawRat !== rat) {
          const other = neighborFor(raw, { ...row.snapshot, channel: null }, rawRat);
          if (other) {
            const existingOther = otherRatCandidates.get(other.cellKey) || {
              ...other, band: bandFor(rawRat, other.channel, raw.band), rsrpValues: [], observedSnapshots: new Set(),
            };
            if (Number.isFinite(other.rsrp)) existingOther.rsrpValues.push(other.rsrp);
            existingOther.observedSnapshots.add(row.snapshot.sourceIndex);
            otherRatCandidates.set(other.cellKey, existingOther);
          }
          return;
        }
        const neighbor = neighborFor(raw, row.snapshot, rat);
        if (!neighbor || seen.has(neighbor.cellKey)) return;
        seen.add(neighbor.cellKey);
        usableAtSnapshot = true;
        neighbor.band = bandFor(rat, neighbor.channel, raw.band);
        neighbor.alternativeClass = neighbor.sameFrequency ? "same_frequency"
          : neighbor.band && row.snapshot.band && normal(neighbor.band) === normal(row.snapshot.band)
            ? "same_band" : "other_frequency";
        snapshotNeighbors.push(neighbor);
        const existing = candidates.get(neighbor.cellKey) || {
          ...neighbor,
          rsrpValues: [], sinrValues: [], deltaValues: [], observedSnapshots: new Set(),
        };
        if (Number.isFinite(neighbor.rsrp)) {
          existing.rsrpValues.push(neighbor.rsrp);
        }
        if (Number.isFinite(neighbor.sinr)) existing.sinrValues.push(neighbor.sinr);
        existing.observedSnapshots.add(row.snapshot.sourceIndex);
        candidates.set(neighbor.cellKey, existing);
      });
      if (usableAtSnapshot) {
        measurementSnapshots += 1;
        const paired = (row.snapshot.rawSamples || [row.snapshot]).flatMap((sample) => {
          if (!Number.isFinite(sample.rsrp)) return [];
          const unique = new Map();
          (sample.point?.parsed?.neighbors || []).forEach((raw) => {
            const neighbor = neighborFor(raw, sample, rat);
            if (!neighbor || !Number.isFinite(neighbor.rsrp)) return;
            if (rat === "NR") {
              const servingRef = String(sample.measurementReference || "UNKNOWN").toUpperCase();
              const neighborRef = String(raw.measurementReference ||
                (raw.ssRsrp !== undefined ? "SS_RSRP" : raw.csiRsrp !== undefined ? "CSI_RSRP" : "UNKNOWN")).toUpperCase();
              if (servingRef === "UNKNOWN" || servingRef !== neighborRef) return;
            }
            unique.set(neighbor.cellKey, neighbor);
            const existing = candidates.get(neighbor.cellKey);
            if (existing) existing.deltaValues.push(neighbor.rsrp - sample.rsrp);
          });
          const sameFrequency = [...unique.values()].filter((item) => item.sameFrequency);
          if (!sameFrequency.length) return [];
          const strongest = sameFrequency.slice().sort((a, b) => b.rsrp - a.rsrp)[0];
          const levels = [sample.rsrp, ...sameFrequency.map((item) => item.rsrp)];
          const strongestLevel = Math.max(...levels);
          return [{ sample, strongest, dominanceDb: sample.rsrp - strongest.rsrp,
            threeCells: levels.filter((value) => strongestLevel - value <= 6).length >= 3 }];
        });
        if (paired.length) {
          const dominanceDb = numericStats(paired.map((item) => item.dominanceDb)).median;
          const anchor = paired[Math.floor((paired.length - 1) / 2)];
          dominanceRows.push({ sourceIndex: row.snapshot.sourceIndex, time: row.snapshot.time,
            timeMs: row.snapshot.timeMs, lat: row.snapshot.lat, lng: row.snapshot.lng,
            servingCellName: row.snapshot.cellName, servingPci: row.snapshot.pci,
            servingChannel: row.snapshot.channel, servingRsrp: row.snapshot.rsrp,
            neighbor: { ...anchor.strongest }, dominanceDb, neighborDeltaDb: -dominanceDb });
          if (paired.filter((item) => item.threeCells).length / paired.length >= .5)
            significantThreeCellSnapshots += 1;
        }
      }
    });
    const minSamples = Math.max(1, profile.bestNeighborMinSnapshots);
    const all = [...candidates.values()].map((candidate) => ({
      ...candidate,
      sampleCount: candidate.observedSnapshots.size,
      presenceRatio: Number((candidate.observedSnapshots.size / Math.max(1, rows.length)).toFixed(3)),
      rsrp: numericStats(candidate.rsrpValues),
      sinr: numericStats(candidate.sinrValues),
      delta: numericStats(candidate.deltaValues),
    }));
    const recurrent = all.filter((candidate) => candidate.sampleCount >= minSamples &&
      candidate.presenceRatio >= profile.bestNeighborMinPresenceRatio && Number.isFinite(candidate.rsrp.median));
    const strongest = (list) => list.slice().sort((a, b) =>
      (b.rsrp.median ?? -Infinity) - (a.rsrp.median ?? -Infinity) || b.sampleCount - a.sampleCount)[0] || null;
    const sameFrequency = recurrent.filter((candidate) => candidate.alternativeClass === "same_frequency");
    const sameBand = recurrent.filter((candidate) => candidate.alternativeClass === "same_band");
    const interFrequency = recurrent.filter((candidate) => candidate.alternativeClass === "other_frequency");
    const bestSameFrequency = strongest(sameFrequency);
    const bestInterFrequency = strongest(interFrequency);
    const bestSameBand = strongest(sameBand);
    const bestNeighbor = strongest(recurrent);
    const otherRat = [...otherRatCandidates.values()].map((candidate) => ({
      ...candidate,
      sampleCount: candidate.observedSnapshots.size,
      presenceRatio: Number((candidate.observedSnapshots.size / Math.max(1, rows.length)).toFixed(3)),
      rsrp: numericStats(candidate.rsrpValues),
      sinr: numericStats([]),
      delta: numericStats([]),
      alternativeClass: "other_rat",
    })).filter((candidate) => candidate.sampleCount >= minSamples && candidate.presenceRatio >= profile.bestNeighborMinPresenceRatio);
    const bestOtherRat = strongest(otherRat);
    const dominanceStats = numericStats(dominanceRows.map((item) => item.dominanceDb));
    const dominance = {
      sampleCount: dominanceRows.length,
      coveragePct: percent(dominanceRows.length, rows.length),
      p10: dominanceStats.p10,
      p50: dominanceStats.median,
      p90: dominanceStats.p90,
      weakPct: percent(dominanceRows.filter((item) => item.dominanceDb < profile.weakDominanceDb).length, dominanceRows.length),
      neighborBetterPct: percent(dominanceRows.filter((item) => item.dominanceDb < 0).length, dominanceRows.length),
      neighborBetter6Pct: percent(dominanceRows.filter((item) => item.dominanceDb <= -profile.betterNeighborDeltaDb).length, dominanceRows.length),
      significantThreeCellPct: percent(significantThreeCellSnapshots, rows.length),
      sequence: dominanceRows,
    };
    return {
      measurementSnapshots,
      measurementCoveragePct: percent(measurementSnapshots, rows.length),
      hasMeasuredNeighbors: measurementSnapshots > 0,
      distinctNeighborCount: all.length,
      recurrentNeighborCount: recurrent.length,
      dominanceDb: dominance.p50,
      dominance,
      bestNeighbor: publicNeighbor(bestNeighbor),
      bestSameFrequencyNeighbor: publicNeighbor(bestSameFrequency),
      bestSameBandNeighbor: publicNeighbor(bestSameBand),
      bestInterFrequencyNeighbor: publicNeighbor(bestInterFrequency),
      bestOtherRatNeighbor: publicNeighbor(bestOtherRat),
      recurrentNeighbors: recurrent.map(publicNeighbor),
    };
  };

  const diagnosticFor = (rows, profile, classification, servingChanges, rat) => {
    const rsrp = numericStats(rows.map((row) => row.snapshot.rsrp));
    const sinr = numericStats(rows.map((row) => row.snapshot.sinr));
    const coverageCount = rows.filter((row) => row.rawCoverage).length;
    const sinrCount = rows.filter((row) => row.rawSinr).length;
    const coverageProblem = coverageCount >= (profile.coverageMinSamples ?? 3);
    const sinrProblem = sinrCount >= (profile.sinrMinSamples ?? 3);
    const radioContext = neighborContextFor(rows, profile, rat);
    // This layer reports measured RF symptoms only. Neighbour/mobility
    // decisions belong to RadioNeighborMobilityRca; fusion belongs to
    // RadioRcaEngine. There is no parallel +6 dB/-105 dBm decision tree.
    let code;
    let label;
    let recommendation;
    if (classification.category === "combined" || classification.category === "mixed" || coverageProblem && sinrProblem) {
      code = radioContext.hasMeasuredNeighbors ? "COVERAGE_AND_LOW_SINR" : "COVERAGE_AND_LOW_SINR_NEEDS_NEIGHBOR_CONTEXT";
      label = radioContext.hasMeasuredNeighbors ? "Couverture et SINR dégradés" : "Couverture et SINR dégradés — voisinage non mesuré";
      recommendation = radioContext.hasMeasuredNeighbors
        ? "Prioriser la couverture serving, puis vérifier dominance, interférences et mobilité avec les voisins mesurés."
        : "Prioriser la couverture serving. Le fichier ne contient pas de voisin mesuré pour confirmer une cause de mobilité ou d’interférence.";
    } else if (coverageProblem) {
      code = radioContext.hasMeasuredNeighbors ? "WEAK_AVAILABLE_COVERAGE" : "WEAK_SERVING_COVERAGE_UNCONFIRMED";
      label = radioContext.hasMeasuredNeighbors ? "Couverture serving insuffisante" : "Couverture serving insuffisante — voisinage non mesuré";
      recommendation = radioContext.hasMeasuredNeighbors
        ? "Vérifier la couverture des secteurs environnants, azimut, tilt, puissance et disponibilité de la couche radio."
        : "Vérifier la couverture serving, azimut, tilt, puissance et disponibilité. Aucun voisin mesuré ne permet de confirmer un trou de couverture général.";
    } else {
      code = radioContext.hasMeasuredNeighbors ? "LOW_SINR_WITH_NEIGHBOR_CONTEXT" : "LOW_SINR_NEEDS_NEIGHBOR_CONTEXT";
      label = radioContext.hasMeasuredNeighbors ? "SINR serving dégradé — voisinage mesuré" : "SINR dégradé — voisinage non mesuré";
      recommendation = radioContext.hasMeasuredNeighbors
        ? "Vérifier charge et interférences ; qualifier les voisines par comparaison temporelle appariée avant toute conclusion de mobilité."
        : "Vérifier charge et interférences. Le fichier ne contient pas de voisin mesuré : aucune cause de pollution ou de mobilité ne peut être confirmée.";
    }
    const evidence = [
      `RSRP P50/P10 ${rsrp.median?.toFixed(1) ?? "N/D"}/${rsrp.p10?.toFixed(1) ?? "N/D"} dBm`,
      `SINR P50/P10 ${sinr.median?.toFixed(1) ?? "N/D"}/${sinr.p10?.toFixed(1) ?? "N/D"} dB`,
      `${coverageCount} snapshot(s) RSRP dégradé(s) · ${sinrCount} snapshot(s) SINR dégradé(s)`,
    ];
    if (radioContext.hasMeasuredNeighbors) {
      evidence.push(`${radioContext.distinctNeighborCount} voisin(s) ${rat} mesuré(s) · couverture voisinage ${radioContext.measurementCoveragePct}%`);
      if (radioContext.bestNeighbor) evidence.push(`Meilleur voisin: ${radioContext.bestNeighbor.cellName} (${radioContext.bestNeighbor.rsrp.median?.toFixed(1) ?? "N/D"} dBm)`);
      if (Number.isFinite(radioContext.dominance?.p50)) evidence.push(`Dominance P50/P10 ${radioContext.dominance.p50.toFixed(1)}/${radioContext.dominance.p10?.toFixed(1) ?? "N/D"} dB · <3 dB ${radioContext.dominance.weakPct}% · voisin meilleur ${radioContext.dominance.neighborBetterPct}%`);
    } else {
      evidence.push(`Voisinage ${rat} non mesuré dans le fichier source`);
    }
    const secondary = servingChanges >= 2
      ? {
        code: rat === "NR" ? "NR_PSCELL_MOBILITY_CONTEXT" : "LTE_PCELL_MOBILITY_CONTEXT",
        label: rat === "NR" ? "Changements de NR PSCell dans la zone" : "Changements de LTE PCell dans la zone",
        evidence: `${servingChanges} changement(s) de ${rat === "NR" ? "NR PSCell" : "LTE PCell"} observé(s)`,
      }
      : null;
    return {
      code, label, recommendation, secondary, evidence, rsrp, sinr, radioContext,
      bestNeighbor: radioContext.bestNeighbor,
      bestSameFrequencyNeighbor: radioContext.bestSameFrequencyNeighbor,
      bestSameBandNeighbor: radioContext.bestSameBandNeighbor,
      bestInterFrequencyNeighbor: radioContext.bestInterFrequencyNeighbor,
      bestOtherRatNeighbor: radioContext.bestOtherRatNeighbor,
    };
  };

  const scoreIncident = (incident, profile) => {
    if (!Scoring) throw new Error("RadioScoring must be loaded before RadioDegradationAnalyzer");
    return Scoring.score(incident, profile);
  };

  const mobilityFor = (rows, durationSec, distanceM, profile) => {
    const snapshots = rows.map((row) => row.snapshot).filter(Boolean);
    const steps = snapshots.slice(1).map((snapshot, index) => haversineM(snapshots[index], snapshot));
    const netDisplacementM = snapshots.length > 1 ? haversineM(snapshots[0], snapshots[snapshots.length - 1]) : 0;
    const stepStats = numericStats(steps);
    const meanSpeedMps = durationSec > 0 ? distanceM / durationSec : 0;
    // This is intentionally a "stationary / low-mobility" classification,
    // not a claim that the vehicle was parked. It also covers a queue, a
    // traffic light or a GPS-drifting test terminal.
    const stationary = durationSec >= profile.stationaryMinDurationSec &&
      netDisplacementM <= profile.stationaryMaxNetDisplacementM &&
      distanceM <= profile.stationaryMaxPathDistanceM &&
      meanSpeedMps <= profile.stationaryMaxMeanSpeedMps;
    return {
      classification: stationary ? "stationary_low_mobility" : "drive_mobility",
      state: stationary ? "STATIONARY" : durationSec <= 0 ? "UNKNOWN" : meanSpeedMps < 0.83 ? "SLOW" : "MOVING",
      stationary,
      durationSec,
      pathDistanceM: distanceM,
      netDisplacementM,
      meanSpeedMps,
      stepMedianM: stepStats.median,
      stepP90M: stepStats.p90,
    };
  };

  const anchorContextFor = (rows, profile) => {
    const anchors = rows.map((row) => row.snapshot?.anchor).filter(Boolean);
    if (!anchors.length) return { available: false, status: "not_applicable", evidence: [] };
    const rsrp = numericStats(anchors.map((item) => item.rsrp));
    const sinr = numericStats(anchors.map((item) => item.sinr));
    const healthy = anchors.filter((item) =>
      (!Number.isFinite(item.rsrp) || item.rsrp > profile.coverageEntryDbm) &&
      (!Number.isFinite(item.sinr) || item.sinr > profile.sinrEntryDb)).length;
    const bad = anchors.filter((item) =>
      (Number.isFinite(item.rsrp) && item.rsrp <= profile.coverageEntryDbm) ||
      (Number.isFinite(item.sinr) && item.sinr <= profile.sinrEntryDb)).length;
    const changes = anchors.slice(1).reduce((count, item, index) => count + (item.cellKey !== anchors[index].cellKey ? 1 : 0), 0);
    const healthyPct = percent(healthy, anchors.length);
    const badPct = percent(bad, anchors.length);
    const status = healthyPct >= 60 ? "healthy_anchor" : badPct >= 60 ? "shared_degradation" : "mixed_anchor";
    return {
      available: true,
      role: "LTE PCell (anchor)",
      sampleCount: anchors.length,
      healthyPct,
      badPct,
      changes,
      rsrp,
      sinr,
      status,
      cellName: anchors[0]?.cellName || "",
      evidence: [
        `Ancre LTE ${status === "healthy_anchor" ? "saine" : status === "shared_degradation" ? "également dégradée" : "variable"} sur ${Math.max(healthyPct, badPct)}% des snapshots`,
        `LTE anchor RSRP P50 ${rsrp.median?.toFixed(1) ?? "N/D"} dBm · SINR P50 ${sinr.median?.toFixed(1) ?? "N/D"} dB`,
        `${changes} changement(s) d’ancre LTE`,
      ],
    };
  };

  const mobilityEvidenceFor = (rows, profile, rat) => {
    const snapshots = rows.map((row) => row.snapshot);
    const changes = [];
    snapshots.slice(1).forEach((snapshot, index) => {
      const previous = snapshots[index];
      if (snapshot.cellKey !== previous.cellKey) {
        changes.push({
          type: rat === "NR" ? "NR_PSCELL_CHANGE_PROBABLE" : "LTE_PCELL_CHANGE_PROBABLE",
          time: snapshot.time,
          timeMs: snapshot.timeMs,
          lat: snapshot.lat,
          lng: snapshot.lng,
          fromCell: previous.cellName,
          toCell: snapshot.cellName,
          fromKey: previous.cellKey,
          toKey: snapshot.cellKey,
          fromIndex: index,
          toIndex: index + 1,
          source: "measured_serving_transition",
          confirmedBySignaling: false,
        });
      }
    });
    const anomalies = [];
    // The raw-time neighbour engine owns persistent advantage, delayed
    // transition and non-observation decisions. A +6 dB RF screening value
    // is never interpreted here as a HO condition or failure.
    // A small before/after RF gain alone cannot establish that a serving
    // change was unnecessary. The transition is retained as an observed fact.
    const durationSec = snapshots.length > 1 ? Math.max(0, (snapshots[snapshots.length - 1].timeMs - snapshots[0].timeMs) / 1000) : 0;
    const distanceM = snapshots.slice(1).reduce((sum, snapshot, index) => sum + haversineM(snapshots[index], snapshot), 0);
    return {
      changes,
      changeCount: changes.length,
      changesPerMinute: durationSec > 0 ? Number((changes.length * 60 / durationSec).toFixed(2)) : 0,
      changesPerKm: distanceM > 0 ? Number((changes.length * 1000 / distanceM).toFixed(2)) : 0,
      anomalies,
      confirmedBySignaling: false,
      label: changes.length ? "Changement de cellule probable (mesures serving)" : "Aucun changement serving mesuré",
    };
  };

  const buildIncidents = (snapshots, profile, rat) => {
    const incidents = [];
    let current = null;
    let pending = [];
    let previous = null;
    let consecutiveRecovered = 0;
    let consecutiveNormal = 0;

    const rowFor = (snapshot) => {
      const rawCoverage = Number.isFinite(snapshot.rsrp) && snapshot.rsrp <= profile.coverageEntryDbm ||
        Number.isFinite(snapshot.bucketStats?.rsrp?.p10) && snapshot.bucketStats.rsrp.p10 <= profile.coverageCriticalDbm ||
        snapshot.bucketStats?.maxRsrpCriticalRun >= profile.criticalConsecutiveSnapshots &&
          snapshot.bucketStats?.rsrp?.min <= profile.coverageCriticalDbm;
      const rawSinr = Number.isFinite(snapshot.sinr) && snapshot.sinr <= profile.sinrEntryDb ||
        Number.isFinite(snapshot.bucketStats?.sinr?.p10) && snapshot.bucketStats.sinr.p10 <= profile.sinrCriticalDb ||
        snapshot.bucketStats?.maxSinrCriticalRun >= profile.criticalConsecutiveSnapshots &&
          snapshot.bucketStats?.sinr?.min <= profile.sinrCriticalDb;
      return {
        snapshot,
        rawCoverage,
        rawSinr,
        critical: Number.isFinite(snapshot.bucketStats?.rsrp?.min) && snapshot.bucketStats.rsrp.min <= profile.coverageCriticalDbm ||
          Number.isFinite(snapshot.bucketStats?.sinr?.min) && snapshot.bucketStats.sinr.min <= profile.sinrCriticalDb,
        degraded: rawCoverage || rawSinr,
        coverageRecovered: Number.isFinite(snapshot.rsrp) && snapshot.rsrp > profile.coverageExitDbm,
        sinrRecovered: Number.isFinite(snapshot.sinr) && snapshot.sinr > profile.sinrExitDb,
      };
    };

    const flush = () => {
      if (!current?.length) { current = null; return; }
      while (current.length && !current[current.length - 1].degraded) current.pop();
      while (current.length && !current[0].degraded) current.shift();
      if (!current.length) { current = null; return; }
      const degraded = current.filter((row) => row.degraded);
      const degradedDensity = degraded.length / current.length;
      const fastCritical = current.some((row, index) => row.snapshot.bucketStats?.maxCriticalRun >= profile.criticalConsecutiveSnapshots ||
        index > 0 && row.critical && current[index - 1].critical);
      if ((degraded.length < profile.minDegradedSnapshots || degradedDensity < profile.minDegradedDensity) && !fastCritical) {
        current = null; return;
      }
      const first = current[0].snapshot;
      const last = current[current.length - 1].snapshot;
      const durationSec = Math.max(0, (last.timeMs - first.timeMs) / 1000);
      const distanceM = current.slice(1).reduce((total, row, index) => total + haversineM(current[index].snapshot, row.snapshot), 0);
      if (durationSec < profile.minDurationSec && distanceM < profile.minDistanceM && !fastCritical) { current = null; return; }
      const classification = classificationFor(current, profile, fastCritical);
      if (!classification) { current = null; return; }
      const servingMap = new Map();
      current.forEach((row) => {
        const value = servingMap.get(row.snapshot.cellKey) || { snapshot: row.snapshot, count: 0 };
        value.count += 1;
        servingMap.set(row.snapshot.cellKey, value);
      });
      const servingCells = [...servingMap.values()].sort((a, b) => b.count - a.count);
      const mobilityBase = mobilityFor(current, durationSec, distanceM, profile);
      const mobilityEvidence = mobilityEvidenceFor(current, profile, rat);
      const mobility = { ...mobilityBase, ...mobilityEvidence };
      const servingChanges = mobilityEvidence.changeCount;
      const diagnostic = diagnosticFor(current, profile, classification, servingChanges, rat);
      const anchorContext = rat === "NR" ? anchorContextFor(current, DEFAULT_PROFILES.lte) : { available: false, status: "not_applicable", evidence: [] };
      const stationaryContext = mobility.stationary ? {
        code: "STATIONARY_LOW_MOBILITY_CONTEXT",
        label: "Zone stationnaire / faible mobilité",
        evidence: `${durationSec.toFixed(1)} s · ${Math.round(distanceM)} m parcourus · déplacement net ${Math.round(mobility.netDisplacementM)} m`,
      } : null;
      const anchorRca = anchorContext.available ? {
        code: anchorContext.status === "healthy_anchor" ? "NR_LAYER_LOCALIZED_CONTEXT"
          : anchorContext.status === "shared_degradation" ? "SHARED_NR_LTE_DEGRADATION_CONTEXT" : "LTE_ANCHOR_MIXED_CONTEXT",
        label: anchorContext.status === "healthy_anchor" ? "Ancre LTE saine — défaut probablement localisé NR"
          : anchorContext.status === "shared_degradation" ? "NR et ancre LTE dégradés — cause de couverture/environnement commune probable"
            : "Contexte ancre LTE variable",
        evidence: anchorContext.evidence.join(" · "),
      } : null;
      const endcInteractionRca = rat === "NR" && anchorContext.changes > 0 && mobilityEvidence.changeCount > 0 ? {
        code: "ENDC_MOBILITY_INTERACTION_PROBABLE",
        label: "Interaction mobilité EN-DC probable",
        evidence: `${anchorContext.changes} changement(s) d’ancre LTE proche(s) de ${mobilityEvidence.changeCount} changement(s) NR PSCell`,
      } : null;
      const contextRca = [diagnostic.secondary, anchorRca, endcInteractionRca, stationaryContext].filter(Boolean);
      const representative = degraded.reduce((worst, row) => {
        const score = (row.rawCoverage && Number.isFinite(row.snapshot.rsrp) ? profile.coverageEntryDbm - row.snapshot.rsrp : 0) +
          (row.rawSinr && Number.isFinite(row.snapshot.sinr) ? profile.sinrEntryDb - row.snapshot.sinr : 0);
        return score > worst.score ? { row, score } : worst;
      }, { row: degraded[0], score: -Infinity }).row;
      const metrics = { rsrp: diagnostic.rsrp, sinr: diagnostic.sinr };
      const coverageCount = current.filter((row) => row.rawCoverage).length;
      const sinrCount = current.filter((row) => row.rawSinr).length;
      const bothCount = current.filter((row) => row.rawCoverage && row.rawSinr).length;
      const criticalCount = current.filter((row) => row.critical).length;
      const incident = {
        id: `radio_${rat.toLowerCase()}_${incidents.length + 1}`,
        rat,
        ...classification,
        severity: criticalCount ? "critical" : "major",
        startTime: first.time,
        endTime: last.time,
        start: { lat: first.lat, lng: first.lng },
        end: { lat: last.lat, lng: last.lng },
        representative: { ...representative.snapshot },
        dominantServing: servingCells[0] ? { ...servingCells[0].snapshot, count: servingCells[0].count } : null,
        servingCells: servingCells.map((item) => ({ ...item.snapshot, count: item.count })),
        servingChanges,
        mobility,
        stationary: mobility.stationary,
        sampleCount: degraded.length,
        canonicalSampleCount: current.length,
        requiredSampleCount: profile.minDegradedSnapshots,
        fastCritical,
        degradedDensityPct: percent(degraded.length, current.length),
        criticalSnapshotPct: percent(criticalCount, current.length),
        coverageSampleCount: coverageCount,
        sinrSampleCount: sinrCount,
        bothSampleCount: bothCount,
        durationSec,
        distanceM,
        band: servingCells[0]?.snapshot?.band || "",
        channel: servingCells[0]?.snapshot?.channel ?? null,
        metrics,
        dominance: diagnostic.radioContext?.dominance || null,
        anchorContext,
        nrContinuity: null,
        geometry: null,
        recurrence: { available: false, score: null, affectedPassages: 1, eligiblePassages: 1 },
        composition: {
          coverageOnlyPct: percent(coverageCount - bothCount, degraded.length),
          sinrOnlyPct: percent(sinrCount - bothCount, degraded.length),
          bothPct: percent(bothCount, degraded.length),
        },
        primaryRca: diagnostic,
        secondaryRca: diagnostic.secondary,
        secondaryRcas: contextRca,
        contextRca,
        reviewState: "candidate",
        sourceRows: [...new Set(current.flatMap((row) => row.snapshot.sourceIndices || [row.snapshot.sourceIndex]))],
        sequence: current.map((row) => ({
          ...row.snapshot,
          radioState: row.rawCoverage && row.rawSinr ? "both" : row.rawCoverage ? "coverage" : row.rawSinr ? "sinr" : "recovery_bridge",
        })),
        evidence: diagnostic.evidence.slice(),
      };
      scoreIncident(incident, profile);
      incidents.push(incident);
      current = null;
    };

    snapshots.forEach((snapshot) => {
      const row = rowFor(snapshot);
      const gapSec = previous ? (snapshot.timeMs - previous.timeMs) / 1000 : 0;
      const gpsJump = previous && gapSec > 0 ? haversineM(previous, snapshot) / gapSec > profile.maxGpsSpeedMps : false;
      if (previous && (gapSec < 0 || gapSec > profile.mergeGapSec || gpsJump)) {
        flush(); pending = []; consecutiveRecovered = 0; consecutiveNormal = 0;
      }
      pending.push(row);
      if (pending.length > profile.entryWindowSnapshots) pending.shift();
      if (!current) {
        const badCount = pending.filter((item) => item.degraded).length;
        const fastCritical = pending.some((item) => item.snapshot.bucketStats?.maxCriticalRun >= profile.criticalConsecutiveSnapshots) ||
          pending.slice(-profile.criticalConsecutiveSnapshots)
            .filter((item) => item.critical).length >= profile.criticalConsecutiveSnapshots;
        if (badCount >= profile.entryBadSnapshots || fastCritical) {
          const firstBad = pending.findIndex((item) => item.degraded);
          current = pending.slice(Math.max(0, firstBad));
          pending = [];
          consecutiveRecovered = 0;
          consecutiveNormal = current[current.length - 1]?.degraded ? 0 : 1;
        }
      } else {
        current.push(row);
        const affectedCoverage = current.some((item) => item.rawCoverage);
        const affectedSinr = current.some((item) => item.rawSinr);
        const recovered = (!affectedCoverage || row.coverageRecovered) && (!affectedSinr || row.sinrRecovered);
        consecutiveRecovered = recovered ? consecutiveRecovered + 1 : 0;
        consecutiveNormal = row.degraded ? 0 : consecutiveNormal + 1;
        const tail = current.slice(-profile.normalWindowSnapshots);
        const normalCount = tail.filter((item) => !item.degraded).length;
        const close = consecutiveRecovered >= profile.recoverySnapshots ||
          (tail.length >= profile.normalWindowSnapshots && normalCount >= profile.exitNormalSnapshots);
        if (close) {
          const restart = tail.slice();
          flush();
          pending = restart.slice(-profile.entryWindowSnapshots);
          consecutiveRecovered = 0;
          consecutiveNormal = 0;
        }
      }
      previous = snapshot;
    });
    flush();
    // Drive findings lead the review. Stationary findings are retained but do
    // not take the top positions merely because a stopped tester generated
    // dozens of repeated samples at the same coordinate.
    incidents.sort((a, b) => Number(a.stationary) - Number(b.stationary) ||
      b.sampleCount - a.sampleCount || b.durationSec - a.durationSec || b.distanceM - a.distanceM || a.startTime.localeCompare(b.startTime));
    incidents.forEach((incident, index) => { incident.rank = index + 1; });
    incidents.filter((incident) => !incident.stationary).slice().sort((a, b) => b.priorityScore - a.priorityScore || a.rank - b.rank)
      .forEach((incident, index) => { incident.priorityRank = index + 1; });
    incidents.filter((incident) => incident.stationary).forEach((incident) => { incident.priorityRank = null; });
    return incidents;
  };

  const continuousBetween = (rows, profile) => rows.slice(1).every((row, index) => {
    const previous = rows[index];
    const gapSec = (row.timeMs - previous.timeMs) / 1000;
    return gapSec >= 0 && gapSec <= profile.mergeGapSec && haversineM(previous, row) <= profile.maxGpsJumpM;
  });

  const buildNrContinuity = (servingStream, profiles) => {
    const stream = servingStream.slice().sort((a, b) => a.timeMs - b.timeMs || a.sourceIndex - b.sourceIndex);
    const eligible = stream.length;
    const nrSnapshots = stream.filter((item) => item.rat === "NR").length;
    const losses = [];
    const boundaryContexts = [];
    let index = 0;
    while (index < stream.length) {
      if (stream[index].rat !== "LTE") { index += 1; continue; }
      const startIndex = index;
      while (index + 1 < stream.length && stream[index + 1].rat === "LTE") index += 1;
      const endIndex = index;
      const before = stream[startIndex - 1];
      const after = stream[endIndex + 1];
      const lteOnly = stream.slice(startIndex, endIndex + 1);
      const boundedByNr = before?.rat === "NR" && after?.rat === "NR";
      const continuityRows = [before, ...lteOnly, after].filter(Boolean);
      const continuous = continuousBetween(continuityRows, profiles.nr);
      const first = lteOnly[0];
      const last = lteOnly[lteOnly.length - 1];
      const durationSec = Math.max(0, (last.timeMs - first.timeMs) / 1000);
      const distanceM = lteOnly.slice(1).reduce((sum, item, itemIndex) => sum + haversineM(lteOnly[itemIndex], item), 0);
      const qualifies = boundedByNr && continuous &&
        (durationSec >= profiles.nr.nrLossMinDurationSec || distanceM >= profiles.nr.nrLossMinDistanceM);
      if (qualifies) {
        losses.push({
          id: `nr_loss_${losses.length + 1}`,
          type: "NR_AVAILABILITY_LOSS",
          category: "availability",
          rat: "NR",
          startTime: first.time,
          endTime: last.time,
          start: { lat: first.lat, lng: first.lng },
          end: { lat: last.lat, lng: last.lng },
          durationSec,
          distanceM,
          sampleCount: lteOnly.length,
          canonicalSampleCount: lteOnly.length,
          degradedDensityPct: 100,
          criticalSnapshotPct: 0,
          previousNrServing: { ...before },
          nextNrServing: { ...after },
          lteContext: { ...first },
          sequence: lteOnly.map((item) => ({ ...item, radioState: "nr_unavailable_lte_only" })),
          sourceRows: [...new Set(lteOnly.flatMap((item) => item.sourceIndices || [item.sourceIndex]))],
          closedEvidence: true,
        });
      } else if (!boundedByNr && continuous && (durationSec >= profiles.nr.nrLossMinDurationSec || distanceM >= profiles.nr.nrLossMinDistanceM)) {
        boundaryContexts.push({
          id: `nr_boundary_context_${boundaryContexts.length + 1}`,
          type: "NR_AVAILABILITY_BOUNDARY_CONTEXT",
          startTime: first.time,
          endTime: last.time,
          start: { lat: first.lat, lng: first.lng },
          end: { lat: last.lat, lng: last.lng },
          durationSec,
          distanceM,
          reason: "Séquence LTE-only ouverte en bord de fichier: preuve NR→LTE→NR incomplète.",
        });
      }
      index += 1;
    }
    return {
      availabilityRatioPct: percent(nrSnapshots, eligible),
      nrSnapshots,
      eligibleSnapshots: eligible,
      losses,
      boundaryContexts,
    };
  };

  const nrLossIncident = (loss, profile, rank) => {
    const serving = loss.previousNrServing || loss.nextNrServing;
    const anchorKeys = [loss.previousNrServing?.anchor, loss.lteContext, loss.nextNrServing?.anchor]
      .filter(Boolean).map((item) => item.cellKey).filter(Boolean);
    const anchorChangedNearLoss = new Set(anchorKeys).size > 1;
    const primaryRca = {
      code: "NR_AVAILABILITY_LOSS_PROBABLE",
      label: "Perte locale de disponibilité NR confirmée par retour NR",
      recommendation: "Vérifier couverture NR, relations EN-DC, paramètres B1/A2/B1, disponibilité cellule et signalisation autour de la transition NR→LTE-only→NR.",
      evidence: [
        `Séquence NR→LTE-only→NR mesurée pendant ${loss.durationSec.toFixed(1)} s et ${Math.round(loss.distanceM)} m`,
        `${loss.sampleCount} snapshot(s) LTE-only canonique(s)`,
        `NR avant: ${loss.previousNrServing?.cellName || "N/D"} · NR après: ${loss.nextNrServing?.cellName || "N/D"}`,
      ],
      radioContext: { hasMeasuredNeighbors: false, measurementCoveragePct: 0, recurrentNeighborCount: 0 },
    };
    const incident = {
      ...loss,
      rank,
      severity: "major",
      representative: { ...(loss.lteContext || {}) },
      dominantServing: serving ? { ...serving, role: "NR PSCell avant perte" } : null,
      servingCells: [loss.previousNrServing, loss.nextNrServing].filter(Boolean),
      servingChanges: 0,
      mobility: {
        classification: "drive_mobility",
        stationary: false,
        changes: [],
        changeCount: 0,
        changesPerMinute: 0,
        changesPerKm: 0,
        anomalies: [{ code: "NR_AVAILABILITY_LOSS_PROBABLE", label: primaryRca.label }],
        confirmedBySignaling: false,
      },
      stationary: false,
      requiredSampleCount: 1,
      coverageSampleCount: 0,
      sinrSampleCount: 0,
      bothSampleCount: 0,
      band: serving?.band || "",
      channel: serving?.channel ?? null,
      metrics: { rsrp: numericStats([]), sinr: numericStats([]) },
      composition: { coverageOnlyPct: 0, sinrOnlyPct: 0, bothPct: 0 },
      dominance: null,
      anchorContext: {
        available: true,
        status: "lte_only",
        changes: Math.max(0, new Set(anchorKeys).size - 1),
        evidence: [
          `LTE-only: ${loss.lteContext?.cellName || "cellule non résolue"}`,
          anchorChangedNearLoss ? "Changement d’ancre LTE observé autour de la perte NR" : null,
        ].filter(Boolean),
      },
      nrContinuity: { closedEvidence: true, durationSec: loss.durationSec, distanceM: loss.distanceM },
      geometry: null,
      recurrence: { available: false, score: null, affectedPassages: 1, eligiblePassages: 1 },
      primaryRca,
      secondaryRca: null,
      secondaryRcas: anchorChangedNearLoss ? [{
        code: "ENDC_MOBILITY_INTERACTION_PROBABLE",
        label: "Interaction EN-DC probable autour de la perte NR",
        evidence: "La cellule LTE d’ancrage change au voisinage de la séquence NR→LTE-only→NR.",
      }] : [],
      contextRca: anchorChangedNearLoss ? [{
        code: "ENDC_MOBILITY_INTERACTION_PROBABLE",
        label: "Interaction EN-DC probable autour de la perte NR",
        evidence: "La cellule LTE d’ancrage change au voisinage de la séquence NR→LTE-only→NR.",
      }] : [],
      reviewState: "candidate",
      evidence: primaryRca.evidence.slice(),
    };
    scoreIncident(incident, profile);
    return incident;
  };

  const buildServingChangeEvents = (servingStream, profiles) => {
    const events = [];
    const stream = servingStream.slice().sort((a, b) => a.timeMs - b.timeMs || a.sourceIndex - b.sourceIndex);
    const previousByRat = new Map();
    stream.forEach((snapshot) => {
      const previous = previousByRat.get(snapshot.rat);
      previousByRat.set(snapshot.rat, snapshot);
      if (!previous) return;
      const profile = snapshot.rat === "NR" ? profiles.nr : profiles.lte;
      const gapSec = (snapshot.timeMs - previous.timeMs) / 1000;
      if (gapSec < 0 || gapSec > profile.mergeGapSec || haversineM(previous, snapshot) > profile.maxGpsJumpM) return;
      if (snapshot.cellKey !== previous.cellKey) {
        events.push({
          id: `serving_change_${events.length + 1}`,
          type: snapshot.rat === "NR" ? "NR_PSCELL_CHANGE_PROBABLE" : "LTE_PCELL_CHANGE_PROBABLE",
          event: snapshot.rat === "NR" ? "NR PSCell Change probable" : "LTE PCell Change probable",
          rat: snapshot.rat,
          time: snapshot.time,
          timeMs: snapshot.timeMs,
          lat: snapshot.lat,
          lng: snapshot.lng,
          fromCell: previous.cellName,
          toCell: snapshot.cellName,
          sourceIndex: snapshot.sourceIndex,
          source: "measured_serving_transition",
          confirmedBySignaling: false,
        });
      }
    });
    return events;
  };

  const buildIndependentMobilityIncidents = (servingStream, profiles) => {
    const incidents = [];
    for (let index = 2; index < servingStream.length; index += 1) {
      const first = servingStream[index - 2], middle = servingStream[index - 1], last = servingStream[index];
      if (first.rat !== middle.rat || middle.rat !== last.rat ||
        first.cellKey !== last.cellKey || first.cellKey === middle.cellKey) continue;
      const profile = last.rat === "NR" ? profiles.nr : profiles.lte;
      const durationSec = (last.timeMs - first.timeMs) / 1000;
      const distanceM = haversineM(first, middle) + haversineM(middle, last);
      // A→B→A while physically turning back over the same road is not enough
      // evidence for a ping-pong mobility incident.
      if (distanceM >= 30 && haversineM(first, last) < distanceM * 0.4) continue;
      const firstGapSec = (middle.timeMs - first.timeMs) / 1000;
      const secondGapSec = (last.timeMs - middle.timeMs) / 1000;
      if (firstGapSec <= 0 || secondGapSec <= 0 || durationSec > profile.pingPongMaxSec ||
        distanceM > profile.pingPongMaxDistanceM ||
        haversineM(first, middle) / firstGapSec > profile.maxGpsSpeedMps ||
        haversineM(middle, last) / secondGapSec > profile.maxGpsSpeedMps) continue;
      const sequence = [first, middle, last];
      const rca = { code: "PING_PONG_CANDIDATE", label: "Aller-retour serving observé",
        recommendation: "Vérifier voisinage, hystérésis, seuils et temporisations ; confirmer les transitions par RRC.",
        evidence: [`${first.cellName} → ${middle.cellName} → ${last.cellName} en ${durationSec.toFixed(1)} s / ${Math.round(distanceM)} m`],
        radioContext: { hasMeasuredNeighbors: false, measurementCoveragePct: 0, recurrentNeighborCount: 0 } };
      const incident = { id: `mobility_${last.rat.toLowerCase()}_${incidents.length + 1}`,
        type: "MOBILITY_ANOMALY", category: "MOBILITY", rat: last.rat,
        startTime: first.time, endTime: last.time, start: { lat: first.lat, lng: first.lng },
        end: { lat: last.lat, lng: last.lng }, durationSec, distanceM,
        representative: { ...middle }, dominantServing: { ...middle }, servingCells: [first, middle, last],
        servingChanges: 2, mobility: { state: "MOVING", stationary: false, confirmedBySignaling: false,
          changes: [], changeCount: 2, anomalies: [{ code: "PING_PONG_CANDIDATE", label: rca.label, durationSec, distanceM }] },
        stationary: false, sampleCount: 3, canonicalSampleCount: 3, degradedDensityPct: 0,
        criticalSnapshotPct: 0, coverageSampleCount: 0, sinrSampleCount: 0, bothSampleCount: 0,
        band: middle.band, channel: middle.channel,
        metrics: { rsrp: numericStats(sequence.map((item) => item.rsrp)),
          sinr: numericStats(sequence.map((item) => item.sinr)) },
        dominance: null, anchorContext: null, nrContinuity: null, geometry: null,
        recurrence: { available: false, score: null, affectedPassages: 1, eligiblePassages: 1 },
        primaryRca: rca, contextRca: [], secondaryRca: null,
        sequence, sourceRows: [...new Set(sequence.flatMap((item) => item.sourceIndices || [item.sourceIndex]))],
        reviewState: "candidate", severity: "major", evidence: rca.evidence.slice() };
      scoreIncident(incident, profile);
      incidents.push(incident);
    }
    return incidents;
  };

  const buildMacroZones = (incidents, profiles) => {
    const zones = [];
    ["LTE", "NR"].forEach((rat) => {
      const profile = rat === "NR" ? profiles.nr : profiles.lte;
      const stream = incidents.filter((item) => item.rat === rat).slice().sort((a, b) => a.startTime.localeCompare(b.startTime));
      let group = [];
      const flush = () => {
        if (group.length < 2) { group = []; return; }
        const first = group[0]; const last = group[group.length - 1];
        zones.push({
          id: `radio_macro_${rat.toLowerCase()}_${zones.filter((zone) => zone.rat === rat).length + 1}`,
          rat,
          childZoneIds: group.map((item) => item.id),
          microZoneCount: group.length,
          startTime: first.startTime,
          endTime: last.endTime,
          start: first.start,
          end: last.end,
          degradedSnapshotCount: group.reduce((total, item) => total + item.sampleCount, 0),
          degradedDistanceM: group.reduce((total, item) => total + item.distanceM, 0),
          priorityScore: Math.round(group.reduce((total, item) => total + item.priorityScore, 0) / group.length),
        });
        group = [];
      };
      stream.forEach((item) => {
        const previous = group[group.length - 1];
        if (!previous) { group.push(item); return; }
        const gapSec = Math.max(0, (parseTime(item.startTime).ms - parseTime(previous.endTime).ms) / 1000);
        const gapM = haversineM(previous.end, item.start);
        if (gapSec <= profile.macroZoneMaxGapSec && gapM <= profile.macroZoneMaxGapM) group.push(item);
        else { flush(); group.push(item); }
      });
      flush();
    });
    return zones;
  };

  const snapshotReferenceKey = (snapshot) => [
    snapshot?.sourceIndex ?? "", snapshot?.rat ?? "", snapshot?.pci ?? "", snapshot?.channel ?? "",
  ].join("|");

  const servingResolutionKey = (snapshot) => {
    const lat = Number(snapshot?.lat);
    const lng = Number(snapshot?.lng);
    // PCI/channel pairs are reused by geographically distinct cells. Keep a
    // small spatial component in the cache so BDD proximity matching remains
    // valid along a long drive, while nearby repeated measurements still
    // share the expensive lookup. Four decimals represent roughly 9-11 m in
    // Morocco and preserve the same-cell behaviour for a stationary cluster.
    const position = Number.isFinite(lat) && Number.isFinite(lng)
      ? `${lat.toFixed(4)}|${lng.toFixed(4)}`
      : `source:${snapshot?.sourceIndex ?? ""}`;
    return [snapshot?.rat ?? "", snapshot?.pci ?? "", snapshot?.channel ?? "", position].join("|");
  };

  const inventoryFor = (resolved, snapshot) => {
    if (!resolved || typeof resolved !== "object") return null;
    const lat = finite(resolved.lat ?? resolved.latitude);
    const lng = finite(resolved.lng ?? resolved.lon ?? resolved.longitude);
    const azimuth = finite(resolved.azimuth ?? resolved.az ?? resolved.bearing);
    const rangeM = finite(resolved.currentRadius ?? resolved.range ?? resolved.radius);
    const pci = finite(resolved.pci ?? resolved.sc);
    const channel = finite(resolved.currentFreq ?? resolved.freq ?? resolved.nrarfcn ?? resolved.earfcn);
    const ratText = normal(resolved.tech ?? resolved.rat ?? resolved.technology);
    const expectedRat = snapshot?.rat;
    const ratMatches = expectedRat === "NR" ? /(?:NR|5G)/.test(ratText) || /^N\d+/i.test(text(resolved.band))
      : !/(?:NR|5G)/.test(ratText);
    const pciMatches = finite(snapshot?.pci) === null || pci === null || finite(snapshot.pci) === pci;
    const channelMatches = finite(snapshot?.channel) === null || channel === null || Math.abs(finite(snapshot.channel) - channel) <= (expectedRat === "NR" ? 4000 : 1);
    const matchScore = clamp((ratMatches ? 35 : 0) + (pciMatches ? 30 : 0) + (channelMatches ? 25 : 0) + (validCoordinate(lat, lng) ? 10 : 0));
    return {
      cellName: text(resolved.cellName ?? resolved.name ?? resolved.siteName),
      siteName: text(resolved.siteName ?? resolved.name),
      lat,
      lng,
      azimuth,
      rangeM,
      band: text(resolved.band) || bandFor(expectedRat, snapshot?.channel),
      pci,
      channel,
      lac: finite(resolved.lac),
      tac: finite(resolved.tac),
      cid: finite(resolved.cid),
      ratMatches,
      pciMatches: finite(snapshot?.pci) !== null && pci !== null && finite(snapshot.pci) === pci,
      channelMatches: finite(snapshot?.channel) !== null && channel !== null && channelMatches,
      matchScore,
      matchQuality: matchScore >= 80 ? "high" : matchScore >= 60 ? "medium" : "low",
    };
  };

  const geometryForIncident = (incident, profile) => {
    const samples = (incident.sequence || []).map((snapshot) => {
      const inventory = snapshot.inventory;
      if (!inventory || !validCoordinate(inventory.lat, inventory.lng)) return null;
      const distanceM = haversineM(snapshot, inventory);
      const bearing = bearingDeg(inventory, snapshot);
      const azimuthErrorDeg = angularDifference(inventory.azimuth, bearing);
      return { distanceM, bearingDeg: bearing, azimuthErrorDeg, matchScore: inventory.matchScore, rangeM: inventory.rangeM, snapshot };
    }).filter(Boolean);
    if (!samples.length) return { available: false, matchScore: null, overshooting: false, orientationIssue: false, evidence: [] };
    const distance = numericStats(samples.map((item) => item.distanceM));
    const azimuthError = numericStats(samples.map((item) => item.azimuthErrorDeg));
    const matchScore = Math.round(medianFinite(samples.map((item) => item.matchScore)) || 0);
    const expectedRangeM = medianFinite(samples.map((item) => item.rangeM));
    const representative = incident.representative || incident.sequence?.[0];
    const alternatives = [
      incident.primaryRca?.bestSameFrequencyNeighbor,
      incident.primaryRca?.bestSameBandNeighbor,
      incident.primaryRca?.bestInterFrequencyNeighbor,
    ].filter(Boolean);
    const closerAlternative = alternatives.map((neighbor) => {
      const inventory = neighbor.inventory;
      if (!inventory || !validCoordinate(inventory.lat, inventory.lng) || !representative) return null;
      const neighborDistanceM = haversineM(representative, inventory);
      const neighborBearing = bearingDeg(inventory, representative);
      return { neighbor, distanceM: neighborDistanceM, azimuthErrorDeg: angularDifference(inventory.azimuth, neighborBearing) };
    }).filter(Boolean).sort((a, b) => a.distanceM - b.distanceM)[0] || null;
    const dominanceP50 = finite(incident.dominance?.p50);
    const overshooting = matchScore >= 60 && Number.isFinite(expectedRangeM) && expectedRangeM > 0 &&
      Number.isFinite(distance.median) && distance.median > expectedRangeM * profile.overshootRangeFactor &&
      closerAlternative && closerAlternative.distanceM <= distance.median * (1 - profile.overshootCloserRatio) &&
      Number.isFinite(dominanceP50) && Math.abs(dominanceP50) <= profile.weakDominanceDb;
    const orientationIssue = matchScore >= 60 && Number.isFinite(azimuthError.median) &&
      azimuthError.median > profile.orientationErrorDeg && closerAlternative &&
      Number.isFinite(closerAlternative.azimuthErrorDeg) && closerAlternative.azimuthErrorDeg < azimuthError.median;
    const evidence = [
      `Distance serving BDD P50 ${Math.round(distance.median || 0)} m`,
      Number.isFinite(azimuthError.median) ? `Erreur azimut P50 ${azimuthError.median.toFixed(1)}°` : null,
      Number.isFinite(expectedRangeM) ? `Portée BDD ${Math.round(expectedRangeM)} m` : null,
      closerAlternative ? `Alternative ${closerAlternative.neighbor.cellName} à ${Math.round(closerAlternative.distanceM)} m` : null,
    ].filter(Boolean);
    return {
      available: true,
      matchScore,
      matchQuality: matchScore >= 80 ? "high" : matchScore >= 60 ? "medium" : "low",
      servingDistanceM: distance,
      bearingErrorDeg: azimuthError,
      expectedRangeM,
      closerAlternative: closerAlternative ? {
        cellName: closerAlternative.neighbor.cellName,
        distanceM: closerAlternative.distanceM,
        azimuthErrorDeg: closerAlternative.azimuthErrorDeg,
      } : null,
      overshooting,
      orientationIssue,
      evidence,
    };
  };

  // Cell-name enrichment is intentionally a presentation step. Detection and
  // segmentation remain based on the immutable canonical LTE PCell / NR
  // PSCell identifiers captured from the source file. The caller supplies a
  // RAT-safe BDD resolver, so a 5G fallback can never be replaced by a 3G/LTE
  // label simply because both inventories share a site name or PCI.
  const enrichServingNames = (analysis, resolveCell) => {
    if (!analysis || typeof resolveCell !== "function") return analysis;
    const byReference = new Map();
    const resolutionCache = new Map();
    const evidenceReferences = new Set((analysis.incidents || []).flatMap((incident) =>
      [incident.representative, incident.dominantServing, ...(incident.sequence || [])]
        .filter(Boolean).map(snapshotReferenceKey)));
    let resolvedCount = 0;
    const updateSnapshot = (snapshot) => {
      if (!snapshot || !snapshot.rat) return snapshot;
      const reference = snapshotReferenceKey(snapshot);
      const sourceName = text(snapshot.cellName);
      if (!isFallbackCellName(sourceName) && !evidenceReferences.has(reference)) {
        byReference.set(reference, snapshot);
        return snapshot;
      }
      const resolverKey = servingResolutionKey(snapshot);
      let resolved = resolutionCache.get(resolverKey);
      if (resolved === undefined) {
        try { resolved = resolveCell(snapshot) || null; } catch (_) { resolved = null; }
        resolutionCache.set(resolverKey, resolved);
      }
      const inventory = inventoryFor(resolved, snapshot);
      if (inventory) snapshot.inventory = inventory;
      const resolvedName = text(resolved?.cellName ?? resolved?.name ?? resolved?.label ?? resolved);
      if (isFallbackCellName(sourceName) && resolvedName && !isFallbackCellName(resolvedName) && !/^(?:unknown|n\/?a|null)$/i.test(resolvedName)) {
        snapshot.reportedCellName = snapshot.reportedCellName || sourceName;
        snapshot.inventoryCellName = resolvedName;
        snapshot.cellName = resolvedName;
        snapshot.nameSource = "bdd";
        resolvedCount += 1;
      }
      byReference.set(reference, snapshot);
      return snapshot;
    };
    Object.values(analysis.snapshots || {}).forEach((snapshots) => {
      (snapshots || []).forEach(updateSnapshot);
    });
    const replaceFromReference = (snapshot) => {
      if (!snapshot) return snapshot;
      const known = byReference.get(snapshotReferenceKey(snapshot));
      if (!known) return snapshot;
      return { ...snapshot, cellName: known.cellName, reportedCellName: known.reportedCellName,
        inventoryCellName: known.inventoryCellName, nameSource: known.nameSource, inventory: known.inventory || snapshot.inventory };
    };
    (analysis.incidents || []).forEach((incident) => {
      incident.representative = replaceFromReference(incident.representative);
      incident.dominantServing = replaceFromReference(incident.dominantServing);
      incident.servingCells = (incident.servingCells || []).map(replaceFromReference);
      incident.sequence = (incident.sequence || []).map(replaceFromReference);
      const representative = incident.representative || incident.sequence?.[0];
      const neighborNameReplacements = [];
      ["bestNeighbor", "bestSameFrequencyNeighbor", "bestSameBandNeighbor", "bestInterFrequencyNeighbor"].forEach((key) => {
        const neighbor = incident.primaryRca?.[key];
        if (!neighbor || !representative) return;
        let resolvedNeighbor = null;
        try {
          resolvedNeighbor = resolveCell({
            ...representative,
            rat: neighbor.rat || incident.rat,
            pci: neighbor.pci,
            channel: neighbor.channel,
            cellName: neighbor.cellName,
          });
        } catch (_) { resolvedNeighbor = null; }
        const inventory = inventoryFor(resolvedNeighbor, { ...representative, rat: neighbor.rat || incident.rat, pci: neighbor.pci, channel: neighbor.channel });
        if (inventory) neighbor.inventory = inventory;
        const resolvedName = text(resolvedNeighbor?.cellName ?? resolvedNeighbor?.name ?? resolvedNeighbor?.label);
        if (isFallbackCellName(neighbor.cellName) && resolvedName && !isFallbackCellName(resolvedName)) {
          neighborNameReplacements.push([neighbor.cellName, resolvedName]);
          neighbor.cellName = resolvedName;
        }
      });
      if (neighborNameReplacements.length) {
        const renameNeighbors = (value) => neighborNameReplacements.reduce(
          (result, [before, after]) => result.replaceAll(before, after), String(value || ""));
        incident.primaryRca.evidence = (incident.primaryRca.evidence || []).map(renameNeighbors);
        incident.primaryRca.recommendation = renameNeighbors(incident.primaryRca.recommendation);
        if (incident.analysis) incident.analysis.observedEvidence =
          (incident.analysis.observedEvidence || []).map(renameNeighbors);
      }
      const structured = incident.neighborMobilityRca;
      if (structured) {
        const replacements = neighborNameReplacements.slice();
        const sourceSnapshot = (incident.sequence || []).find((snapshot) => snapshot.rat === structured.rat &&
          finite(snapshot.pci) === finite(structured.serving?.pci) &&
          finite(snapshot.channel) === finite(structured.serving?.channel));
        if (isFallbackCellName(structured.servingCell) && sourceSnapshot?.cellName &&
          !isFallbackCellName(sourceSnapshot.cellName))
          replacements.push([structured.servingCell, sourceSnapshot.cellName]);
        (structured.topCandidates || []).forEach((candidate) => {
          if (!isFallbackCellName(candidate.cellName) || !representative) return;
          let resolved = null;
          try { resolved = resolveCell({ ...representative, lat: candidate.lat ?? representative.lat,
            lng: candidate.lng ?? representative.lng, rat: candidate.rat, pci: candidate.pci,
            channel: candidate.channel, cellName: candidate.cellName }); } catch (_) { resolved = null; }
          const inventory = inventoryFor(resolved, { ...representative, rat: candidate.rat,
            pci: candidate.pci, channel: candidate.channel });
          const name = text(resolved?.cellName ?? resolved?.name ?? resolved?.label);
          if (inventory?.ratMatches && inventory?.pciMatches && inventory?.channelMatches && name &&
            !isFallbackCellName(name)) {
            replacements.push([candidate.cellName, name]);
            candidate.cellName = name;
          }
        });
        const rename = (value) => replacements.reduce((result, [before, after]) =>
          result.replaceAll(before, after), String(value || ""));
        structured.servingCell = rename(structured.servingCell);
        structured.targetCell = structured.target ? structured.target.cellName : rename(structured.targetCell);
        structured.facts = (structured.facts || []).map(rename);
        structured.hypothesis = rename(structured.hypothesis);
        structured.verification = (structured.verification || []).map(rename);
        if (structured.serving) structured.serving.name = structured.servingCell;
        if (structured.targetNeighbor) structured.targetNeighbor.name = structured.targetCell;
        if (structured.rca) {
          structured.rca.hypothesis = structured.hypothesis;
          structured.rca.measuredFacts = structured.facts;
          structured.rca.requiredVerification = structured.verification;
          structured.rca.recommendedAction = structured.verification.join(" ");
        }
        if (structured.transition) {
          structured.transition.from = rename(structured.transition.from);
          structured.transition.to = rename(structured.transition.to);
        }
        incident.primaryRca.evidence = (incident.primaryRca.evidence || []).map(rename);
        incident.primaryRca.recommendation = rename(incident.primaryRca.recommendation);
        if (incident.primaryRca.mobilityTransition) {
          incident.primaryRca.mobilityTransition.fromCell = rename(incident.primaryRca.mobilityTransition.fromCell);
          incident.primaryRca.mobilityTransition.toCell = rename(incident.primaryRca.mobilityTransition.toCell);
        }
        if (incident.analysis) {
          incident.analysis.observedEvidence = (incident.analysis.observedEvidence || []).map(rename);
          incident.analysis.cause.name = rename(incident.analysis.cause.name);
        }
      }
      if (incident.scanOverlap?.matches?.length && representative && ScanFusion?.rcaFor) {
        const previousFacts = incident.scanOverlap.rca?.facts || [];
        incident.scanOverlap.matches.forEach((match) => {
          match.topContributors?.forEach((candidate) => {
            if (candidate.cellName && !isFallbackCellName(candidate.cellName)) return;
            const probe = { ...representative, lat: match.points?.[0]?.lat ?? representative.lat,
              lng: match.points?.[0]?.lng ?? representative.lng, rat: candidate.rat,
              pci: candidate.pci, channel: candidate.channel, cellName: candidate.cellName };
            let resolved = null;
            try { resolved = resolveCell(probe); } catch (_) { resolved = null; }
            const inventory = inventoryFor(resolved, probe);
            const name = text(resolved?.cellName ?? resolved?.name ?? resolved?.label);
            if (inventory?.ratMatches && inventory?.pciMatches &&
                finite(inventory.channel) === finite(candidate.channel) &&
                name && !isFallbackCellName(name)) candidate.cellName = name;
          });
        });
        incident.scanOverlap.rca = ScanFusion.rcaFor(incident, incident.scanOverlap.matches);
        if (incident.analysis) incident.analysis.observedEvidence =
          (incident.analysis.observedEvidence || []).map((fact) => {
            const index = previousFacts.indexOf(fact);
            return index >= 0 ? incident.scanOverlap.rca.facts[index] || fact : fact;
          });
      }
      const transition = incident.primaryRca?.mobilityTransition;
      if (transition) {
        const source = (incident.sequence || []).find((snapshot) => snapshot.cellKey === transition.event?.fromKey);
        const target = (incident.sequence || []).find((snapshot) => snapshot.cellKey === transition.event?.toKey);
        const oldSource = transition.fromCell;
        const oldTarget = transition.toCell;
        if (source?.cellName && isFallbackCellName(oldSource)) transition.fromCell = source.cellName;
        if (target?.cellName && isFallbackCellName(oldTarget)) transition.toCell = target.cellName;
        if (!target && isFallbackCellName(transition.toCell)) {
          const resolvedNeighbor = [incident.primaryRca.bestSameFrequencyNeighbor,
            incident.primaryRca.bestSameBandNeighbor, incident.primaryRca.bestInterFrequencyNeighbor]
            .find((neighbor) => finite(neighbor?.pci) === finite(transition.targetPci) &&
              finite(neighbor?.channel) === finite(transition.targetChannel));
          if (resolvedNeighbor?.cellName) transition.toCell = resolvedNeighbor.cellName;
        }
        const rewrite = (value) => String(value || "")
          .replaceAll(oldSource, transition.fromCell)
          .replaceAll(oldTarget, transition.toCell);
        incident.primaryRca.evidence = (incident.primaryRca.evidence || []).map(rewrite);
        incident.primaryRca.recommendation = rewrite(incident.primaryRca.recommendation);
        if (incident.analysis) {
          incident.analysis.observedEvidence = (incident.analysis.observedEvidence || []).map(rewrite);
          incident.analysis.cause.name = rewrite(incident.analysis.cause.name);
        }
      }
      const profile = incident.rat === "NR" ? analysis.profiles?.nr : analysis.profiles?.lte;
      if (profile && incident.type !== "NR_AVAILABILITY_LOSS") {
        incident.geometry = geometryForIncident(incident, profile);
        if (incident.geometry.overshooting || incident.geometry.orientationIssue) {
          const geometryRca = {
            code: incident.geometry.overshooting ? "OVERSHOOTING_PROBABLE" : "ORIENTATION_MISMATCH_PROBABLE",
            label: incident.geometry.overshooting ? "Overshooting serving probable" : "Défaut d’orientation serving probable",
            evidence: incident.geometry.evidence.join(" · "),
          };
          incident.contextRca = [...(incident.contextRca || []).filter((item) => !/^OVERSHOOTING|^ORIENTATION/.test(String(item.code))), geometryRca];
          incident.secondaryRcas = incident.contextRca.slice();
        }
        scoreIncident(incident, profile);
      }
    });
    analysis.servingNameEnrichment = {
      resolvedCount,
      resolverEntries: resolutionCache.size,
      updatedAt: new Date().toISOString(),
    };
    return analysis;
  };

  const isSupported = (points) => {
    if (!Array.isArray(points) || points.length < 2) return false;
    return points.some((point) => point?.parsed?.serving_lte || point?.parsed?.serving_nr ||
      Number.isFinite(Number(point?.mos ?? point?.["MOS DL"])) ||
      Number(point?.["App. rate DL"] ?? point?.properties?.["App. rate DL"]) > 0);
  };

  const rankIncidents = (incidents) => {
    ["LTE", "NR", "MOS", "DATA"].forEach((rat) => {
      const ratItems = incidents.filter((item) => item.rat === rat).sort((a, b) =>
        Number(a.stationary) - Number(b.stationary) || b.priorityScore - a.priorityScore || a.startTime.localeCompare(b.startTime));
      ratItems.forEach((item, index) => { item.rank = index + 1; });
      ratItems.filter((item) => !item.stationary).sort((a, b) => b.priorityScore - a.priorityScore || a.rank - b.rank)
        .forEach((item, index) => { item.priorityRank = index + 1; });
      ratItems.filter((item) => item.stationary).forEach((item) => { item.priorityRank = null; });
    });
  };

  const centroidFor = (incident) => {
    const points = (incident?.sequence || []).filter((item) => validCoordinate(Number(item.lat), Number(item.lng)));
    if (!points.length) return incident?.start || null;
    return {
      lat: points.reduce((sum, item) => sum + Number(item.lat), 0) / points.length,
      lng: points.reduce((sum, item) => sum + Number(item.lng), 0) / points.length,
    };
  };

  const sampledSpatialPoints = (sequence, limit = 64) => {
    const points = (sequence || []).filter((item) => validCoordinate(Number(item.lat), Number(item.lng)));
    if (points.length <= limit) return points;
    const stride = Math.ceil(points.length / limit);
    const sampled = points.filter((_, index) => index % stride === 0);
    if (sampled[sampled.length - 1] !== points[points.length - 1]) sampled.push(points[points.length - 1]);
    return sampled;
  };

  const spatialOverlapPct = (left, right, radiusM) => {
    const leftPoints = sampledSpatialPoints(left?.sequence);
    const rightPoints = sampledSpatialPoints(right?.sequence);
    if (!leftPoints.length || !rightPoints.length) return 0;
    const covered = (source, target) => percent(
      source.filter((point) => target.some((candidate) => haversineM(point, candidate) <= radiusM)).length,
      source.length,
    );
    // Mutual coverage avoids treating one tiny crossing of a long route as a
    // recurrent incident zone.
    return Math.min(covered(leftPoints, rightPoints), covered(rightPoints, leftPoints));
  };

  const applyCampaignRecurrence = (entries) => {
    const usable = (entries || []).map((entry, index) => ({
      logId: entry?.logId ?? entry?.id ?? index,
      analysis: entry?.analysis || entry?.radioDegradationAnalysis || entry,
    })).filter((entry) => Array.isArray(entry.analysis?.incidents));
    usable.forEach((target) => {
      (target.analysis.incidents || []).forEach((incident) => {
        if (incident.stationary) {
          incident.recurrence = { available: false, score: null, affectedPassages: 1, eligiblePassages: 1, excludedReason: "stationary" };
          return;
        }
        const center = centroidFor(incident);
        const profile = incident.rat === "NR" ? target.analysis.profiles?.nr : target.analysis.profiles?.lte;
        const radiusM = Number(profile?.recurrenceRadiusM || 100);
        const zonePoints = sampledSpatialPoints(incident.sequence);
        const eligible = usable.filter((entry) => Object.values(entry.analysis.snapshots || {}).flat().some((snapshot) =>
          haversineM(center, snapshot) <= radiusM || zonePoints.some((point) => haversineM(point, snapshot) <= radiusM)));
        let bestSpatialOverlapPct = 0;
        const affected = eligible.filter((entry) => (entry.analysis.incidents || []).some((candidate) => {
          if (candidate.stationary || candidate.rat !== incident.rat || candidate.category !== incident.category) return false;
          const overlapPct = spatialOverlapPct(incident, candidate, radiusM);
          bestSpatialOverlapPct = Math.max(bestSpatialOverlapPct, overlapPct);
          return haversineM(center, centroidFor(candidate)) <= radiusM || overlapPct >= 50;
        }));
        const available = eligible.length >= 2;
        incident.recurrence = {
          available,
          score: available ? percent(affected.length, eligible.length) : null,
          affectedPassages: affected.length,
          eligiblePassages: eligible.length,
          radiusM,
          bestSpatialOverlapPct,
          logIds: affected.map((entry) => entry.logId),
        };
        if (profile) scoreIncident(incident, profile);
      });
      rankIncidents(target.analysis.incidents);
    });
    return usable.map((entry) => entry.analysis);
  };

  const analyze = (points, options = {}) => {
    if (!isSupported(points)) return null;
    const requestedFor = (rat) => options?.profiles?.[rat.toLowerCase()] ?? options?.[rat.toLowerCase()] ?? {};
    const contextFor = (rat) => ({ ...options.profileContext, rat });
    const radioRequest = (rat) => {
      const preset = Profiles?.getProfile(contextFor(rat), options.profileOverrides) || {};
      return { ...Profiles.radioDefaults(preset), ...requestedFor(rat) };
    };
    const profiles = {
      lte: normalizeProfile(radioRequest("LTE"), DEFAULT_PROFILES.lte),
      nr: normalizeProfile(radioRequest("NR"), DEFAULT_PROFILES.nr),
      mos: { ...(Profiles?.getProfile({ ...options.profileContext, purpose: "VOICE" }, options.profileOverrides)?.mos || {}),
        ...(options?.profiles?.mos || options?.mos || {}) },
      throughput: { ...(Profiles?.getProfile({ ...options.profileContext, purpose: "DATA" }, options.profileOverrides)?.throughput || {}),
        ...(options?.profiles?.throughput || options?.throughput || {}) },
    };
    const snapshotsByRat = buildSnapshots(points, profiles);
    // Preserve sub-second serving observations for RCA chronology. The LTE
    // PCell remains available as an NSA anchor but is never an NR neighbour.
    const rawMobilityTimeline = { LTE: [], NR: [] };
    points.forEach((point, sourceIndex) => {
      ["LTE", "NR"].forEach((rat) => {
        const snapshot = snapshotFor(point, sourceIndex, rat, true);
        if (snapshot) rawMobilityTimeline[rat].push(snapshot);
      });
    });
    Object.values(rawMobilityTimeline).forEach((stream) => stream.sort((a, b) => a.timeMs - b.timeMs || a.sourceIndex - b.sourceIndex));
    const servingStream = buildServingStream(snapshotsByRat, profiles);
    const gpsJumps = servingStream.slice(1).map((snapshot, index) => {
      const previous = servingStream[index];
      const gapSec = (snapshot.timeMs - previous.timeMs) / 1000;
      const distanceM = haversineM(previous, snapshot);
      const impliedSpeedMps = gapSec > 0 ? distanceM / gapSec : null;
      return Number.isFinite(impliedSpeedMps) && impliedSpeedMps > profiles.nr.maxGpsSpeedMps
        ? { code: "GPS_JUMP", time: snapshot.time, sourceIndex: snapshot.sourceIndex,
          distanceM, gapSec, impliedSpeedMps } : null;
    }).filter(Boolean);
    const lteIncidents = buildIncidents(snapshotsByRat.LTE, profiles.lte, "LTE");
    const nrIncidents = buildIncidents(snapshotsByRat.NR, profiles.nr, "NR");
    const symptomTracks = {
      coverage: [...buildSymptomEpisodes(snapshotsByRat.LTE, profiles.lte, "LTE", "rsrp"),
        ...buildSymptomEpisodes(snapshotsByRat.NR, profiles.nr, "NR", "rsrp")],
      quality: [...buildSymptomEpisodes(snapshotsByRat.LTE, profiles.lte, "LTE", "sinr"),
        ...buildSymptomEpisodes(snapshotsByRat.NR, profiles.nr, "NR", "sinr")],
    };
    const nrContinuity = buildNrContinuity(servingStream, profiles);
    const nrLossIncidents = nrContinuity.losses.map((loss, index) => nrLossIncident(loss, profiles.nr, nrIncidents.length + index + 1));
    const mobilityIncidents = buildIndependentMobilityIncidents(servingStream, profiles);
    const mosResult = MosAnalyzer?.detect(points, { ...profiles.mos,
      maxGpsSpeedMps: profiles.nr.maxGpsSpeedMps, mergeGapSec: profiles.nr.mergeGapSec }) || { snapshots: [], incidents: [] };
    mosResult.incidents.forEach((incident) => scoreIncident(incident, { ...profiles.nr, mos: profiles.mos }));
    const throughputResult = ThroughputAnalyzer?.detect(points, profiles.throughput) || { snapshots: [], incidents: [] };
    throughputResult.incidents.forEach((incident) => scoreIncident(incident, { ...profiles.nr, throughput: profiles.throughput }));
    const incidents = [...lteIncidents, ...nrIncidents, ...nrLossIncidents, ...mobilityIncidents,
      ...mosResult.incidents, ...throughputResult.incidents];
    incidents.forEach((incident) => {
      if (!incident.sequence?.length || !["LTE", "NR"].includes(incident.rat) ||
        incident.type === "NR_AVAILABILITY_LOSS") return;
      const profile = incident.rat === "NR" ? profiles.nr : profiles.lte;
      const rca = NeighborMobility?.analyzeIncident(incident, rawMobilityTimeline[incident.rat], profile);
      if (!rca) return;
      incident.neighborMobilityRca = rca;
      if (["PROBABLE_DELAYED_TRANSITION", "TRANSITION_NOT_OBSERVED", "PING_PONG_CANDIDATE"].includes(rca.type))
        incident.mobility?.anomalies?.unshift({ code: rca.type, label: rca.label,
          timeMs: rca.transition?.timeMs ?? rca.timeline.firstPersistentAdvantageMs ?? incident.sequence[0].timeMs,
          lat: rca.transition?.lat ?? incident.representative?.lat,
          lng: rca.transition?.lng ?? incident.representative?.lng,
          fromCell: rca.servingCell, toCell: rca.targetCell, confirmedBySignaling: false });
    });
    const mobilityEvents = buildServingChangeEvents(servingStream, profiles);
    rankIncidents(incidents);
    const driveIncidents = incidents.filter((item) => !item.stationary);
    const macroZones = buildMacroZones(driveIncidents.filter((item) => item.type !== "MOBILITY_ANOMALY"), profiles);
    const count = (rat, predicate) => driveIncidents.filter((item) => item.rat === rat && predicate(item)).length;
    const stationaryCount = (rat) => incidents.filter((item) => item.rat === rat && item.stationary).length;
    const overlaps = [];
    ["LTE", "NR"].forEach((rat) => {
      // Mobility and NR availability are independent symptom layers. Their
      // time windows may legitimately intersect a coverage/quality zone.
      const stream = incidents.filter((item) => item.rat === rat &&
        /^(?:COVERAGE_DEGRADATION|SINR_DEGRADATION|COMBINED_RADIO_DEGRADATION|MIXED_RADIO_DEGRADATION)$/.test(item.type))
        .slice().sort((a, b) => a.startTime.localeCompare(b.startTime));
      for (let i = 1; i < stream.length; i += 1) {
        if (parseTime(stream[i].startTime).ms <= parseTime(stream[i - 1].endTime).ms) overlaps.push([stream[i - 1].id, stream[i].id]);
      }
    });
    const result = {
      version: VERSION,
      schema: "lte_nr_signal_incident_rca_v2",
      profileContext: { ...(options.profileContext || {}) },
      profiles,
      snapshots: snapshotsByRat,
      mosSnapshots: mosResult.snapshots,
      throughputSnapshots: throughputResult.snapshots,
      servingStream,
      symptomTracks,
      incidents,
      macroZones,
      mobilityEvents,
      nrContinuity,
      summary: {
        sourcePoints: Array.isArray(points) ? points.length : 0,
        lteSnapshots: snapshotsByRat.LTE.length,
        nrSnapshots: snapshotsByRat.NR.length,
        lteCandidates: driveIncidents.filter((item) => item.rat === "LTE" && item.type !== "MOBILITY_ANOMALY").length,
        nrCandidates: driveIncidents.filter((item) => item.rat === "NR" && item.type !== "MOBILITY_ANOMALY").length,
        mosCandidates: mosResult.incidents.length,
        throughputCandidates: throughputResult.incidents.length,
        mobilityCandidates: mobilityIncidents.length,
        lteStationaryFindings: stationaryCount("LTE"),
        nrStationaryFindings: stationaryCount("NR"),
        lteCoverage: count("LTE", (item) => item.coverageSampleCount >= (item.fastCritical ? 2 : profiles.lte.coverageMinSamples)),
        lteSinr: count("LTE", (item) => item.sinrSampleCount >= (item.fastCritical ? 2 : profiles.lte.sinrMinSamples)),
        nrCoverage: count("NR", (item) => item.coverageSampleCount >= (item.fastCritical ? 2 : profiles.nr.coverageMinSamples)),
        nrSinr: count("NR", (item) => item.sinrSampleCount >= (item.fastCritical ? 2 : profiles.nr.sinrMinSamples)),
        nrAvailabilityLosses: nrLossIncidents.length,
        coverageSymptoms: symptomTracks.coverage.length,
        qualitySymptoms: symptomTracks.quality.length,
        nrAvailabilityRatioPct: nrContinuity.availabilityRatioPct,
        servingChangeEvents: mobilityEvents.length,
        combined: driveIncidents.filter((item) => item.type === "COMBINED_RADIO_DEGRADATION").length,
        mixed: driveIncidents.filter((item) => item.type === "MIXED_RADIO_DEGRADATION").length,
      },
      validationReport: {
        overlappingZoneIds: overlaps,
        gpsJumps,
        valid: overlaps.length === 0,
        message: overlaps.length ? "Overlapping primary radio zones detected." : "Radio-zone segmentation is valid.",
      },
    };
    // Correlate the independent symptom zones with measured same-carrier
    // route-scan samples before the RCA engine selects the leading cause.
    try { ScanFusion?.apply(result, points); }
    catch (error) {
      result.routeScanOverlap = { status: "unavailable", zones: [], matchedIncidents: 0,
        message: String(error?.message || error) };
    }
    RcaEngine?.apply(result, options);
    if (Scoring) {
      incidents.forEach((incident) => Scoring.score(incident, {
        ...(incident.rat === "LTE" ? profiles.lte : profiles.nr), mos: profiles.mos,
        throughput: profiles.throughput,
      }));
      RcaEngine?.apply(result, options);
      rankIncidents(incidents);
    }
    return result;
  };

  return {
    VERSION, DEFAULT_PROFILES, isSupported, analyze, normalizeProfile, enrichServingNames,
    applyCampaignRecurrence, buildServingStream, getDisplayBand: displayBandFor,
    isFallbackCellName, numericStats, haversineM,
  };
});
