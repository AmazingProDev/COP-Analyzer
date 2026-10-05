/* Independent application DL-throughput symptom detector when measured rate exists. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadioThroughputAnalyzer = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";
  const mosModule = root.RadioMosAnalyzer || (typeof require === "function" ? require("./radio_mos_analyzer.js") : null);
  const finite = (value) => value === null || value === undefined || value === "" ? null
    : Number.isFinite(Number(value)) ? Number(value) : null;
  const detect = (points, profile = {}) => {
    const measured = (points || []).map((point, sourceIndex) => {
      const raw = finite(point?.["App. rate DL"] ?? point?.properties?.["App. rate DL"]);
      const timeMs = mosModule?.timeMs(point);
      const lat = finite(point?.lat), lng = finite(point?.lng);
      // Zero/empty rate can be idle, so it is not interpreted as a failed DL session.
      if (!(raw > 0) || !Number.isFinite(timeMs) || !Number.isFinite(lat) || !Number.isFinite(lng) ||
        Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
      return { point, sourceIndex, timeMs, time: point.time, lat, lng, mbps: raw / 1e6 };
    }).filter(Boolean).sort((a, b) => a.timeMs - b.timeMs);
    const bySecond = new Map();
    measured.forEach((item) => {
      const bucket = Math.floor(item.timeMs / 1000);
      const values = bySecond.get(bucket) || [];
      values.push(item);
      bySecond.set(bucket, values);
    });
    const snapshots = [...bySecond.values()].map((items) => {
      const distribution = mosModule.stats(items.map((item) => item.mbps));
      return { ...items[items.length - 1], mbps: distribution.median,
        throughputStats: distribution, sourceIndices: items.map((item) => item.sourceIndex) };
    });
    const bad = (item) => item.mbps < (profile.degradedMbps ?? 2);
    const critical = (item) => item.mbps < (profile.criticalMbps ?? .5);
    const incidents = [];
    let active = null, pending = [], recovered = 0, previous = null;
    const flush = () => {
      if (!active?.length) { active = null; return; }
      while (active.length && !bad(active[active.length - 1])) active.pop();
      const degraded = active.filter(bad);
      const fast = active.some((item, index) => index > 0 && critical(item) && critical(active[index - 1]));
      if (degraded.length < (profile.minSamples ?? 3) && !fast) { active = null; return; }
      const first = active[0], last = active[active.length - 1];
      const rate = mosModule.stats(active.map((item) => item.mbps));
      incidents.push({ id: `throughput_${incidents.length + 1}`, type: "THROUGHPUT_DEGRADATION",
        category: "SERVICE_QUALITY", rat: "DATA", startTime: first.time, endTime: last.time,
        startTimeMs: first.timeMs, endTimeMs: last.timeMs,
        start: { lat: first.lat, lng: first.lng }, end: { lat: last.lat, lng: last.lng },
        durationSec: (last.timeMs - first.timeMs) / 1000, distanceM: 0,
        sampleCount: degraded.length, canonicalSampleCount: active.length,
        degradedDensityPct: Number((degraded.length / active.length * 100).toFixed(1)),
        criticalSnapshotPct: Number((active.filter(critical).length / active.length * 100).toFixed(1)),
        throughput: { ...rate, degradedShare: degraded.length / active.length, unit: "Mbps" },
        metrics: { rsrp: mosModule.stats([]), sinr: mosModule.stats([]) },
        representative: first, dominantServing: null, servingCells: [],
        sequence: active.map((item) => ({ ...item, radioState: "throughput_degradation" })),
        sourceRows: [...new Set(active.flatMap((item) => item.sourceIndices))],
        reviewState: "candidate", stationary: false, fastCritical: fast,
        severity: fast ? "critical" : "major" });
      active = null;
    };
    snapshots.forEach((item) => {
      if (previous && (item.timeMs <= previous.timeMs || item.timeMs - previous.timeMs > 3000)) {
        flush(); pending = []; recovered = 0;
      }
      pending.push(item);
      if (pending.length > (profile.windowSamples ?? 5)) pending.shift();
      if (!active) {
        if (pending.filter(bad).length >= (profile.minSamples ?? 3) ||
          pending.length >= 2 && critical(pending[pending.length - 1]) && critical(pending[pending.length - 2])) {
          active = pending.slice(Math.max(0, pending.findIndex(bad)));
          pending = []; recovered = 0;
        }
      } else {
        active.push(item);
        recovered = item.mbps > (profile.recoveryMbps ?? 3) ? recovered + 1 : 0;
        if (recovered >= (profile.recoveryConsecutive ?? 3)) { flush(); pending = []; recovered = 0; }
      }
      previous = item;
    });
    flush();
    return { version: "throughput-v2", snapshots, incidents };
  };
  return { detect };
});
