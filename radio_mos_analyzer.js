/* Independent measured MOS / QoE incident detector. RF is never required. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadioMosAnalyzer = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";
  const finite = (value) => value === null || value === undefined || value === "" ? null
    : Number.isFinite(Number(String(value).replace(",", "."))) ? Number(String(value).replace(",", ".")) : null;
  const stats = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    const q = (share) => {
      if (!sorted.length) return null;
      const index = (sorted.length - 1) * share, left = Math.floor(index), right = Math.ceil(index);
      return sorted[left] + (sorted[right] - sorted[left]) * (index - left);
    };
    return { min: q(0), p10: q(.1), median: q(.5), p50: q(.5), p95: q(.95), max: q(1), count: sorted.length };
  };
  const timeMs = (point) => {
    const serial = finite(point?.__sourceTime ?? point?.properties?.__sourceTime);
    if (serial !== null && serial >= 20000 && serial <= 90000) return Date.UTC(1899, 11, 30) + Math.round(serial * 86400000);
    const raw = String(point?.time ?? point?.properties?.Time ?? "");
    const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (match) return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6], +(match[7] || "0").padEnd(3, "0"));
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const metric = (point, names) => {
    for (const name of names) {
      const value = finite(point?.[name] ?? point?.properties?.[name]);
      if (value !== null) return value;
    }
    return null;
  };
  const sourceFor = (point) => {
    const explicit = String(point?.mosSource ?? point?.properties?.["MOS source"] ?? "").trim();
    if (explicit) return explicit;
    const title = String(point?.properties?.["Measurement Title"] ?? "");
    const method = title.match(/\b(?:POLQA|PESQ|P\.563|E-?MODEL)\b/i);
    return method ? method[0].toUpperCase() : "unknown";
  };
  const distribution = (values) => {
    const counts = {};
    values.forEach((value) => { if (value !== null && value !== undefined && String(value).trim())
      counts[String(value)] = (counts[String(value)] || 0) + 1; });
    return counts;
  };
  const serviceFor = (points, active, degradedAt) => {
    const all = [...new Set(active.flatMap((item) => item.sourceIndices))].map((index) => points[index]).filter(Boolean);
    const bad = [...new Set(active.filter(degradedAt).flatMap((item) => item.sourceIndices))].map((index) => points[index]).filter(Boolean);
    const collect = (rows, names) => rows.map((row) => metric(row, names)).filter(Number.isFinite);
    const lossNames = ["Packet loss", "Packet Loss", "RTP packet loss"];
    const jitterNames = ["Jitter", "RTP jitter"];
    const rttNames = ["RTT", "Latency"];
    const packetLossStats = stats(collect(all, lossNames));
    const jitterStats = stats(collect(all, jitterNames));
    const rttStats = stats(collect(all, rttNames));
    const readText = (row, names) => names.map((name) => row?.[name] ?? row?.properties?.[name])
      .find((value) => value !== undefined && value !== null && String(value).trim()) ?? null;
    return { packetLoss: packetLossStats.median, jitter: jitterStats.median, rtt: rttStats.median,
      packetLossStats, jitterStats, rttStats,
      degradedMosPacketLossStats: stats(collect(bad, lossNames)),
      degradedMosJitterStats: stats(collect(bad, jitterNames)),
      degradedMosRttStats: stats(collect(bad, rttNames)),
      codecDistribution: distribution(all.map((row) => readText(row, ["Codec"]))),
      qciDistribution: distribution(all.map((row) => readText(row, ["QCI"]))),
      fiveQiDistribution: distribution(all.map((row) => readText(row, ["5QI"]))),
      callStateDistribution: distribution(all.map((row) => readText(row, ["Call state"]))),
      callStateCoveragePct: all.length ? Number((100 * all.filter((row) => readText(row, ["Call state"]) !== null).length / all.length).toFixed(1)) : 0,
      sampleCount: all.length };
  };
  const distanceM = (a, b) => {
    const r = Math.PI / 180, lat1 = a.lat * r, lat2 = b.lat * r;
    const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((b.lng - a.lng) * r / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  const snapshots = (points, profile = {}) => {
    const buckets = new Map();
    (points || []).forEach((point, sourceIndex) => {
      const mos = metric(point, ["mos", "MOS DL", "Audio quality MOS DL", "MOS"]);
      const lat = finite(point?.lat), lng = finite(point?.lng), ms = timeMs(point);
      if (mos === null || mos < 0 || mos > 5 || !Number.isFinite(ms) || !Number.isFinite(lat) || !Number.isFinite(lng) ||
        Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return;
      const bucketMs = Math.max(100, Number(profile.canonicalBucketMs) || 1000);
      const key = Math.floor(ms / bucketMs);
      const items = buckets.get(key) || [];
      items.push({ point, sourceIndex, timeMs: ms, time: point.time, lat, lng, mos, source: sourceFor(point) });
      buckets.set(key, items);
    });
    return [...buckets.values()].map((items) => {
      const latest = items[items.length - 1], distribution = stats(items.map((item) => item.mos));
      let criticalRun = 0;
      const maxCriticalRun = items.slice().sort((a, b) => a.timeMs - b.timeMs).reduce((max, item) => {
        criticalRun = item.mos < (profile.critical ?? 2.5) ? criticalRun + 1 : 0;
        return Math.max(max, criticalRun);
      }, 0);
      return { ...latest, mos: distribution.median, mosStats: distribution, sampleCount: items.length,
        degradedShare: items.filter((item) => item.mos < (profile.degraded ?? 3.5)).length / items.length,
        criticalShare: items.filter((item) => item.mos < (profile.critical ?? 2.5)).length / items.length,
        maxCriticalRun,
        sourceIndices: items.map((item) => item.sourceIndex) };
    }).sort((a, b) => a.timeMs - b.timeMs);
  };
  const detect = (points, profile = {}) => {
    const stream = snapshots(points, profile), incidents = [];
    const degradedAt = (item) => item.mos < (profile.degraded ?? 3.5) || item.mosStats.p10 < (profile.severe ?? 3) ||
      item.maxCriticalRun >= (profile.criticalConsecutive ?? 2);
    const criticalAt = (item) => item.mosStats.min < (profile.critical ?? 2.5);
    const windowSize = profile.windowSamples ?? 5, required = profile.minSamples ?? 3;
    let pending = [], active = null, recovered = 0, previous = null;
    const flush = () => {
      if (!active?.length) { active = null; return; }
      while (active.length && !degradedAt(active[active.length - 1])) active.pop();
      const bad = active.filter(degradedAt);
      const fast = active.some((item, index) => item.maxCriticalRun >= (profile.criticalConsecutive ?? 2) ||
        index && criticalAt(item) && criticalAt(active[index - 1]));
      if (bad.length < required && !fast) { active = null; return; }
      const first = active[0], last = active[active.length - 1];
      const pathDistance = active.slice(1).reduce((sum, item, index) => sum + distanceM(active[index], item), 0);
      const durationSec = (last.timeMs - first.timeMs) / 1000;
      const stationary = durationSec >= 10 && pathDistance <= 75 && distanceM(first, last) <= 50 &&
        pathDistance / Math.max(1, durationSec) <= 1.25;
      const distribution = stats(active.map((item) => item.mos));
      const criticalCount = active.filter(criticalAt).length;
      incidents.push({
        id: `mos_${incidents.length + 1}`, type: "MOS_DEGRADATION", category: "MOS", rat: "MOS",
        startTime: first.time, endTime: last.time, startTimeMs: first.timeMs, endTimeMs: last.timeMs,
        start: { lat: first.lat, lng: first.lng }, end: { lat: last.lat, lng: last.lng },
        durationSec, distanceM: pathDistance,
        sampleCount: bad.length, canonicalSampleCount: active.length,
        degradedDensityPct: Number((bad.length * 100 / active.length).toFixed(1)),
        criticalSnapshotPct: Number((criticalCount * 100 / active.length).toFixed(1)),
        mos: { ...distribution, source: first.source, degradedShare: bad.length / active.length,
          criticalShare: criticalCount / active.length, classification: distribution.median < 2.5 ? "critical"
            : distribution.median < 3 ? "poor" : distribution.median < 3.6 ? "fair"
              : distribution.median < 4 ? "good" : "excellent" },
        serviceMetrics: serviceFor(points, active, degradedAt),
        metrics: { rsrp: stats([]), sinr: stats([]) },
        representative: first, dominantServing: null, servingCells: [],
        sequence: active.map((item) => ({ ...item, radioState: "mos_degradation" })),
        sourceRows: [...new Set(active.flatMap((item) => item.sourceIndices))],
        reviewState: "candidate", stationary, mobility: { state: stationary ? "STATIONARY" : "MOVING", stationary },
        severity: criticalCount ? "critical" : "major",
        fastCritical: fast,
      });
      active = null;
    };
    stream.forEach((item) => {
      const gapSec = previous ? (item.timeMs - previous.timeMs) / 1000 : 0;
      const speed = previous && gapSec > 0 ? distanceM(previous, item) / gapSec : 0;
      if (previous && (gapSec > (profile.mergeGapSec ?? 3) || gapSec <= 0 || speed > (profile.maxGpsSpeedMps ?? 70))) {
        flush(); pending = []; recovered = 0;
      }
      pending.push(item);
      if (pending.length > windowSize) pending.shift();
      if (!active) {
        const criticalPair = pending.some((snapshot) => snapshot.maxCriticalRun >= (profile.criticalConsecutive ?? 2)) ||
          pending.length >= 2 && criticalAt(pending[pending.length - 1]) && criticalAt(pending[pending.length - 2]);
        if (pending.filter(degradedAt).length >= required || criticalPair) {
          active = pending.slice(Math.max(0, pending.findIndex(degradedAt)));
          pending = []; recovered = 0;
        }
      } else {
        active.push(item);
        recovered = item.mos > (profile.recovery ?? 3.7) ? recovered + 1 : 0;
        if (recovered >= (profile.recoveryConsecutive ?? 3)) {
          flush(); pending = []; recovered = 0;
        }
      }
      previous = item;
    });
    flush();
    return { version: "mos-qoe-v2", snapshots: stream, incidents };
  };
  return { detect, snapshots, timeMs, stats };
});
