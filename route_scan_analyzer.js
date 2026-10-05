/* Route scan for imported DT snapshots. Measurements are never compared across RATs or carriers. */
(function (root, factory) {
  const analyzer = factory();
  if (typeof module === "object" && module.exports) module.exports = analyzer;
  if (root) root.RouteScanAnalyzer = analyzer;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const number = (value) => value === null || value === undefined || value === ""
    ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
  const ratOf = (value) => {
    const text = String(value || "").toUpperCase();
    if (/\bNR\b|5G/.test(text)) return "NR";
    if (/LTE|E-UTRA|4G/.test(text)) return "LTE";
    return null;
  };
  const timeMs = (value) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") {
      if (value > 1e12) return value;
      if (value > 1e9) return value * 1000;
      if (value > 0 && value < 100000) return (value % 1) * 86400000;
    }
    const raw = String(value).trim();
    const tod = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?$/);
    if (tod) return (+tod[1] * 3600 + +tod[2] * 60 + +tod[3]) * 1000 + +(String(tod[4] || "0").padEnd(3, "0").slice(0, 3));
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const distanceM = (a, b) => {
    if (a.lat === null || a.lon === null || b.lat === null || b.lon === null) return null;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 12742000 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  const round = (value, places = 1) => Number(value.toFixed(places));
  const nrReference = (cell) => {
    const stated = String(cell?.measurementReference ?? cell?.rsrpReference ?? "").toUpperCase().replace(/[\s-]/g, "_");
    if (/^SS_?RSRP$/.test(stated) || cell?.ssRsrp !== undefined) return "SS_RSRP";
    if (/^CSI_?RSRP$/.test(stated) || cell?.csiRsrp !== undefined) return "CSI_RSRP";
    return "UNKNOWN";
  };
  const nrFrequencyReference = (cell) => {
    const stated = String(cell?.frequencyReference || "").toUpperCase().replace(/[\s-]/g, "_");
    if (stated === "BWP") return "BWP";
    if (stated === "SSB_ARFCN" || stated === "CARRIER_ARFCN") return stated;
    if (cell?.ssbNrarfcn !== undefined) return "SSB_ARFCN";
    if (cell?.nrarfcn !== undefined) return "CARRIER_ARFCN";
    return "UNKNOWN";
  };

  function servingLegs(point, defaultRat) {
    const parsed = point.parsed || {};
    const legs = [];
    if (parsed.serving_lte) legs.push({ rat: "LTE", cell: parsed.serving_lte });
    if (parsed.serving_nr) legs.push({ rat: "NR", cell: parsed.serving_nr });
    if (!legs.length && parsed.serving) {
      const rat = ratOf(parsed.serving.rat || point["Serving Technology"] || point.Tech || point.tech) || defaultRat;
      if (rat) legs.push({ rat, cell: parsed.serving });
    }
    if (!legs.length && defaultRat) legs.push({ rat: defaultRat, cell: point });
    return legs;
  }

  function snapshot(point, index, leg) {
    const { rat, cell } = leg;
    const pci = number(cell.pci ?? cell.sc);
    const channel = number(rat === "NR" ? (cell.nrarfcn ?? cell.freq ?? cell.channel) : (cell.earfcn ?? cell.freq ?? cell.channel));
    const rsrp = number(cell.rsrp ?? cell.level ?? (rat === "NR" ? point["5G RSRP"] : point["4G RSRP"]));
    const rsrq = number(cell.rsrq ?? cell.ecno ?? (rat === "NR" ? point["5G RSRQ"] : point["4G RSRQ"]));
    const sinr = number(cell.sinr ?? (rat === "NR" ? point["5G SINR"] : point["4G SINR"]));
    if (pci === null || channel === null || rsrp === null || rsrp < -150 || rsrp > -30) return null;
    const neighbors = Array.isArray(point.parsed?.neighbors) ? point.parsed.neighbors : [];
    const byPci = new Map();
    const servingReference = rat === "NR" ? nrReference(cell) : "LTE_RSRP";
    const servingFrequencyReference = rat === "NR" ? nrFrequencyReference(cell) : "EARFCN";
    let referenceVerified = rat !== "NR";
    for (const neighbor of neighbors) {
      if (/inferred|estimated|synthetic|secondary[_ -]?serving|scell|anchor|pcell|pscell/i.test(
        String(neighbor.source_kind || neighbor.sourceKind || neighbor.role || ""))) continue;
      const neighborRat = ratOf(neighbor.rat || neighbor.technology) ||
        (neighbor.nrarfcn != null ? "NR" : neighbor.earfcn != null ? "LTE" : null);
      if (neighborRat !== rat || neighbor.isServing) continue;
      const neighborPci = number(neighbor.pci ?? neighbor.sc);
      const neighborChannel = number(rat === "NR" ? (neighbor.nrarfcn ?? neighbor.ssbNrarfcn ?? neighbor.freq ?? neighbor.channel) : (neighbor.earfcn ?? neighbor.freq ?? neighbor.channel));
      const neighborRsrp = number(neighbor.rsrp ?? neighbor.rscp);
      const neighborReference = rat === "NR" ? nrReference(neighbor) : "LTE_RSRP";
      const neighborFrequencyReference = rat === "NR" ? nrFrequencyReference(neighbor) : "EARFCN";
      if (rat === "NR" && (servingFrequencyReference === "BWP" || neighborFrequencyReference === "BWP" ||
          servingFrequencyReference !== "UNKNOWN" && neighborFrequencyReference !== "UNKNOWN" &&
          servingFrequencyReference !== neighborFrequencyReference)) continue;
      if (rat === "NR" && servingReference !== "UNKNOWN" && neighborReference !== "UNKNOWN" &&
          servingReference !== neighborReference) continue;
      if (neighborPci === null || neighborPci === pci || neighborChannel !== channel ||
          neighborRsrp === null || neighborRsrp < -150 || neighborRsrp > -30) continue;
      const previous = byPci.get(neighborPci);
      if (!previous || neighborRsrp > previous.rsrp) byPci.set(neighborPci, {
        pci: neighborPci, rsrp: neighborRsrp,
        cellName: neighbor.cellName || neighbor.name || null,
        measurementReference: neighborReference,
        frequencyReference: neighborFrequencyReference,
      });
    }
    if (rat === "NR") referenceVerified = servingReference !== "UNKNOWN" &&
      servingFrequencyReference !== "UNKNOWN" &&
      [...byPci.values()].every((entry) => entry.measurementReference === servingReference &&
        entry.frequencyReference === servingFrequencyReference);
    const eligible = byPci.size >= 2 && (rsrq !== null || sinr !== null);
    const all = [{ pci, rsrp, serving: true }, ...byPci.values()];
    const best = Math.max(...all.map((entry) => entry.rsrp));
    const strong = all.filter((entry) => entry.rsrp >= -105 && best - entry.rsrp <= 5);
    // SS-RSRQ is not interchangeable with LTE RSRQ; use RAT-specific limits.
    const poor = rat === "NR"
      ? ((rsrq !== null && rsrq <= -15) || (sinr !== null && sinr < 5))
      : ((rsrq !== null && rsrq <= -12) || (sinr !== null && sinr < 5));
    const polluted = eligible && poor && best >= -105 && strong.length >= 3;
    const severity = strong.length >= 5 && (sinr !== null && sinr < 0 || rsrq !== null && rsrq <= (rat === "NR" ? -17 : -14))
      ? "High" : strong.length >= 4 || (sinr !== null && sinr < 3) || (rsrq !== null && rsrq <= (rat === "NR" ? -16 : -13))
        ? "Medium" : "Low";
    const rawTime = point.time ?? point.timestamp ?? point.ts ?? null;
    return {
      eligible, polluted, severity, rat, channel, pci, rsrp, rsrq, sinr,
      referenceVerified,
      cellName: cell.cellName || cell.name || point.serving_cell_name || null,
      strong, best, index, tMs: timeMs(rawTime), time: rawTime == null ? "" : String(rawTime),
      lat: number(point.lat ?? point.latitude), lon: number(point.lng ?? point.lon ?? point.longitude),
    };
  }

  function summarizeZone(samples) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const worst = samples.reduce((a, b) => {
      const aScore = a.sinr ?? a.rsrq ?? 0;
      const bScore = b.sinr ?? b.rsrq ?? 0;
      return bScore < aScore ? b : a;
    });
    const avg = (key) => {
      const values = samples.map((sample) => sample[key]).filter((value) => value !== null);
      return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    };
    const polluters = new Map();
    const sequence = [];
    for (const sample of samples) {
      if (sequence[sequence.length - 1] !== sample.pci) sequence.push(sample.pci);
      for (const cell of sample.strong) {
        if (cell.serving) continue;
        const row = polluters.get(cell.pci) || { pci: cell.pci, samples: 0, deltaSum: 0 };
        row.samples++;
        row.deltaSum += sample.best - cell.rsrp;
        polluters.set(cell.pci, row);
      }
    }
    const severityOrder = { Low: 1, Medium: 2, High: 3 };
    return {
      rat: first.rat, channel: first.channel,
      ...(first.rat === "NR" ? { nrarfcn: first.channel } : { earfcn: first.channel }),
      severity: samples.reduce((best, sample) => severityOrder[sample.severity] > severityOrder[best] ? sample.severity : best, "Low"),
      referenceVerified: samples.every((sample) => sample.referenceVerified),
      startTime: first.time, endTime: last.time, centerTime: worst.time,
      startIndex: first.index, endIndex: last.index, centerIndex: worst.index,
      // Preserve the measured samples. A degradation may intersect only part
      // of this scan zone; its RCA must never inherit unrelated route points.
      samples: samples.map((sample) => ({
        index: sample.index, time: sample.time, tMs: sample.tMs,
        lat: sample.lat, lon: sample.lon, pci: sample.pci,
        rsrp: sample.rsrp, rsrq: sample.rsrq, sinr: sample.sinr,
        referenceVerified: sample.referenceVerified,
        strong: sample.strong.map((cell) => ({ ...cell })),
      })),
      centerLat: worst.lat, centerLon: worst.lon,
      durationSeconds: first.tMs !== null && last.tMs !== null ? round(Math.max(0, last.tMs - first.tMs) / 1000) : 0,
      sampleCount: samples.length, maxStrongCells: Math.max(...samples.map((sample) => sample.strong.length)),
      avgServingRsrp: avg("rsrp"), avgServingRsrq: avg("rsrq"), avgServingSinr: avg("sinr"),
      servingPciSequence: sequence,
      topPolluters: [...polluters.values()].map((row) => ({
        pci: row.pci, samples: row.samples, avgDelta: round(row.deltaSum / row.samples, 2),
        score: round(row.samples * (5 - row.deltaSum / row.samples), 2),
      })).sort((a, b) => b.score - a.score).slice(0, 5),
      a3EventCount: 0, hoFailureCount: 0,
    };
  }

  function scan(points, options = {}) {
    if (!Array.isArray(points)) throw new TypeError("DT points must be an array");
    const tech = String(options.tech || "");
    const defaultRat = /4G|LTE/i.test(tech) && /5G|\bNR\b/i.test(tech) ? null : ratOf(tech);
    const snapshots = [];
    const assessed = { LTE: 0, NR: 0 };
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (!point) continue;
      for (const leg of servingLegs(point, defaultRat)) {
        const result = snapshot(point, index, leg);
        if (!result || !result.eligible) continue;
        assessed[result.rat]++;
        if (result.polluted) snapshots.push(result);
      }
    }
    const byRat = { LTE: [], NR: [] };
    for (const sample of snapshots) byRat[sample.rat].push(sample);
    const zones = [];
    for (const rat of ["LTE", "NR"]) {
      const samples = byRat[rat];
      let group = [];
      const flush = () => {
        if (group.length >= 2) zones.push(summarizeZone(group));
        group = [];
      };
      for (const sample of samples) {
        const previous = group[group.length - 1];
        const distance = previous && distanceM(previous, sample);
        const joins = previous && previous.channel === sample.channel && sample.index - previous.index <= 3 &&
          (previous.tMs === null || sample.tMs === null || (sample.tMs >= previous.tMs && sample.tMs - previous.tMs <= 5000)) &&
          (distance === null || distance <= 100);
        if (!joins) flush();
        group.push(sample);
      }
      flush();
    }
    const rank = { High: 3, Medium: 2, Low: 1 };
    zones.sort((a, b) => rank[b.severity] - rank[a.severity] || b.sampleCount - a.sampleCount);
    return { status: "success", zones, totalZones: zones.length,
      totalPollutedSamples: snapshots.length, assessedSamples: assessed };
  }

  function analyzeZone(points, zone, options = {}) {
    if (!Array.isArray(points) || !zone || !Number.isInteger(zone.centerIndex)) {
      throw new Error("The selected zone has no source DT point.");
    }
    const requestedIndices = Array.isArray(options.sampleIndices)
      ? [...new Set(options.sampleIndices.filter((index) => Number.isInteger(index) && index >= 0 && index < points.length))].sort((a, b) => a - b)
      : null;
    const selectedIndex = requestedIndices?.length ? requestedIndices[Math.floor(requestedIndices.length / 2)] : zone.centerIndex;
    const centerPoint = points[selectedIndex];
    const leg = servingLegs(centerPoint || {}, null).find((item) => item.rat === zone.rat);
    const selected = leg && snapshot(centerPoint, selectedIndex, leg);
    if (!selected || !selected.eligible || !selected.polluted || selected.channel !== zone.channel) {
      throw new Error("Measured serving and neighbor data for this zone are unavailable.");
    }
    const windowMs = Number.isFinite(options.windowMs) ? Math.max(2000, options.windowMs) : 12000;
    const spanStart = requestedIndices?.length ? timeMs(points[requestedIndices[0]]?.time ?? points[requestedIndices[0]]?.timestamp ?? points[requestedIndices[0]]?.ts) : null;
    const spanEnd = requestedIndices?.length ? timeMs(points[requestedIndices[requestedIndices.length - 1]]?.time ?? points[requestedIndices[requestedIndices.length - 1]]?.timestamp ?? points[requestedIndices[requestedIndices.length - 1]]?.ts) : null;
    const contextMs = 5000;
    const nearby = [];
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (!point) continue;
      const timestamp = timeMs(point.time ?? point.timestamp ?? point.ts);
      if (requestedIndices?.length) {
        if (spanStart !== null && spanEnd !== null && timestamp !== null) {
          if (timestamp < spanStart - contextMs || timestamp > spanEnd + contextMs) continue;
        } else if (index < requestedIndices[0] - 20 || index > requestedIndices[requestedIndices.length - 1] + 20) continue;
      } else if (selected.tMs !== null && timestamp !== null) {
        if (Math.abs(timestamp - selected.tMs) > windowMs) continue;
      } else if (Math.abs(index - selected.index) > 20) continue;
      const candidateLeg = servingLegs(point, null).find((item) => item.rat === zone.rat);
      const sample = candidateLeg && snapshot(point, index, candidateLeg);
      if (sample && sample.channel === selected.channel) nearby.push(sample);
    }
    const polluted = nearby.filter((sample) => sample.polluted);
    const groups = [];
    for (const sample of polluted) {
      const group = groups[groups.length - 1];
      const previous = group && group[group.length - 1];
      const distance = previous && distanceM(previous, sample);
      const joins = previous && sample.index - previous.index <= 3 &&
        (previous.tMs === null || sample.tMs === null || (sample.tMs >= previous.tMs && sample.tMs - previous.tMs <= 5000)) &&
        (distance === null || distance <= 100);
      if (joins) group.push(sample);
      else groups.push([sample]);
    }
    // For automatic degradation RCA, analyze the exact measured intersection
    // rather than the default point-centered 12-second scan window.
    const samples = requestedIndices?.length
      ? requestedIndices.map((index) => {
        const point = points[index];
        const sourceLeg = servingLegs(point || {}, null).find((item) => item.rat === zone.rat);
        return sourceLeg && snapshot(point, index, sourceLeg);
      }).filter((sample) => sample?.eligible && sample.polluted && sample.channel === selected.channel)
      : groups.find((group) => group.some((sample) => sample.index === selected.index)) || [selected];
    if (!samples.length) throw new Error("No measured co-channel overlap intersects this degradation.");
    const first = samples[0];
    const last = samples[samples.length - 1];
    const mean = (values) => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    const meanMetric = (key) => mean(samples.map((sample) => sample[key]).filter((value) => value !== null));
    const median = (values) => {
      const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
      return sorted.length ? round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2) : null;
    };
    const contextFor = (rows) => ({ sampleCount: rows.length,
      rsrpP50: median(rows.map((sample) => sample.rsrp)),
      rsrqP50: median(rows.map((sample) => sample.rsrq)),
      sinrP50: median(rows.map((sample) => sample.sinr)),
      servingPcis: [...new Set(rows.map((sample) => sample.pci))],
    });
    const before = nearby.filter((sample) => sample.index < samples[0].index &&
      (samples[0].tMs === null || sample.tMs === null || samples[0].tMs - sample.tMs <= contextMs));
    const after = nearby.filter((sample) => sample.index > samples[samples.length - 1].index &&
      (samples[samples.length - 1].tMs === null || sample.tMs === null || sample.tMs - samples[samples.length - 1].tMs <= contextMs));
    const polluterMap = new Map();
    const groupMap = new Map();
    const servingPciSequence = [];
    let routeLengthMeters = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (i > 0) routeLengthMeters += distanceM(samples[i - 1], sample) || 0;
      if (servingPciSequence[servingPciSequence.length - 1] !== sample.pci) servingPciSequence.push(sample.pci);
      for (const cell of sample.strong) {
        const delta = sample.best - cell.rsrp;
        const group = groupMap.get(cell.pci) || {
          pci: cell.pci, earfcn: sample.channel, cellName: cell.cellName || null,
          groupSampleCount: 0, servingMemberSampleCount: 0,
          nonServingPolluterSampleCount: 0, corePolluterSampleCount: 0, deltaSum: 0,
        };
        group.groupSampleCount++;
        group.deltaSum += delta;
        if (cell.serving) group.servingMemberSampleCount++;
        else {
          group.nonServingPolluterSampleCount++;
          if (delta <= 3) group.corePolluterSampleCount++;
        }
        groupMap.set(cell.pci, group);
        if (cell.serving) continue;
        const polluter = polluterMap.get(cell.pci) || {
          pci: cell.pci, earfcn: sample.channel, cellName: cell.cellName || null,
          nonServingPolluterSampleCount: 0, corePolluterSampleCount: 0,
          rsrpSum: 0, deltaSum: 0,
        };
        polluter.nonServingPolluterSampleCount++;
        if (delta <= 3) polluter.corePolluterSampleCount++;
        polluter.rsrpSum += cell.rsrp;
        polluter.deltaSum += delta;
        polluterMap.set(cell.pci, polluter);
      }
    }
    const topPolluters = [...polluterMap.values()].map((row) => {
      const count = row.nonServingPolluterSampleCount;
      const averageDeltaToBest = round(row.deltaSum / count, 2);
      return {
        pci: row.pci, earfcn: row.earfcn, cellName: row.cellName,
        sampleCount: count, nonServingPolluterSampleCount: count,
        corePolluterSampleCount: row.corePolluterSampleCount,
        averageRsrp: mean([row.rsrpSum / count]), averageDeltaToBest,
        polluterScore: round(count * (1 + row.corePolluterSampleCount / count) * Math.max(0.1, 5 - averageDeltaToBest) * 1.5, 2),
      };
    }).sort((a, b) => b.polluterScore - a.polluterScore);
    const topPollutionGroupMembers = [...groupMap.values()].map((row) => ({
      pci: row.pci, earfcn: row.earfcn, cellName: row.cellName,
      groupSampleCount: row.groupSampleCount,
      servingMemberSampleCount: row.servingMemberSampleCount,
      nonServingPolluterSampleCount: row.nonServingPolluterSampleCount,
      corePolluterSampleCount: row.corePolluterSampleCount,
      averageDeltaToBest: round(row.deltaSum / row.groupSampleCount, 2),
    })).sort((a, b) => b.groupSampleCount - a.groupSampleCount);
    const dwellBlocks = [];
    for (const sample of samples) {
      const block = dwellBlocks[dwellBlocks.length - 1];
      if (block && block.pci === sample.pci) {
        block.endTime = sample.time;
        block.sampleCount++;
        block.rsrpSum += sample.rsrp;
        block.avgServingRsrp = round(block.rsrpSum / block.sampleCount);
        block.durationMs = block.startMs !== null && sample.tMs !== null ? Math.max(0, sample.tMs - block.startMs) : 0;
      } else dwellBlocks.push({
        pci: sample.pci, startTime: sample.time, endTime: sample.time,
        startMs: sample.tMs, durationMs: 0, sampleCount: 1,
        rsrpSum: sample.rsrp, avgServingRsrp: round(sample.rsrp),
      });
    }
    for (const block of dwellBlocks) { delete block.startMs; delete block.rsrpSum; }
    const durationSeconds = first.tMs !== null && last.tMs !== null ? round(Math.max(0, last.tMs - first.tMs) / 1000) : 0;
    const strongCount = selected.strong.length;
    const coreCount = selected.strong.filter((cell) => selected.best - cell.rsrp <= 3).length;
    const qualityBadIndicators = [];
    const rsrqLimit = selected.rat === "NR" ? -15 : -12;
    if (selected.rsrq !== null && selected.rsrq <= rsrqLimit) qualityBadIndicators.push(`${selected.rat === "NR" ? "SS-RSRQ" : "RSRQ"} <= ${rsrqLimit} dB`);
    if (selected.sinr !== null && selected.sinr < 5) qualityBadIndicators.push(`${selected.rat === "NR" ? "SS-SINR" : "RS-SINR"} < 5 dB`);
    const detectionConfidence = round(Math.min(0.95, 0.42 + Math.max(0, strongCount - 2) * 0.1 + (qualityBadIndicators.length > 1 ? 0.08 : 0) + Math.min(samples.length, 6) * 0.035), 2);
    const attributionConfidence = topPolluters.length ? round(Math.min(0.9, 0.35 + Math.min(samples.length, 6) * 0.045 + Math.min(topPolluters[0].corePolluterSampleCount, 4) * 0.07), 2) : null;
    const severityOrder = { Low: 1, Medium: 2, High: 3 };
    const severity = samples.reduce((best, sample) => severityOrder[sample.severity] > severityOrder[best] ? sample.severity : best, "Low");
    const serving = {
      pci: selected.pci, earfcn: selected.channel,
      ...(selected.rat === "NR" ? { nrarfcn: selected.channel } : {}),
      rsrp: selected.rsrp, rsrq: selected.rsrq, sinr: selected.sinr,
      cellName: selected.cellName, pdschSinr: null, sinrAgeMs: null, pdschSinrAgeMs: null,
    };
    const event = {
      id: 1, rat: selected.rat, carrier: selected.channel, severity,
      startTime: first.time, endTime: last.time, centerLat: selected.lat, centerLon: selected.lon,
      startMs: first.tMs, endMs: last.tMs,
      startLat: first.lat, startLon: first.lon, endLat: last.lat, endLon: last.lon,
      durationSeconds, routeLengthMeters: round(routeLengthMeters),
      impliedSpeedKmh: durationSeconds > 0 ? round(routeLengthMeters / durationSeconds * 3.6) : null,
      maxStrongCellsWithin5dB: Math.max(...samples.map((sample) => sample.strong.length)),
      maxStrongCellsWithin3dB: Math.max(...samples.map((sample) => sample.strong.filter((cell) => sample.best - cell.rsrp <= 3).length)),
      averageServingRsrp: meanMetric("rsrp"), averageServingRsrq: meanMetric("rsrq"),
      averageServingSinr: meanMetric("sinr"),
      detectionConfidence, attributionConfidence,
      servingPciSequence, servingDwellBlocks: dwellBlocks,
      topPolluters: topPolluters.slice(0, 5),
      topCorePolluters: topPolluters.filter((row) => row.corePolluterSampleCount > 0).slice(0, 3),
      topExtendedPolluters: topPolluters.filter((row) => row.averageDeltaToBest > 3 && row.averageDeltaToBest <= 5).slice(0, 3),
      a3EventCount: 0, hoCount: 0, a3Events: [], hoFailureEvents: [], eventCounts: {},
      evidence: [
        `${samples.length} measured overlap samples on ${selected.rat === "NR" ? "NR-ARFCN" : "EARFCN"} ${selected.channel}.`,
        `Serving sequence: ${servingPciSequence.join(" → ")}.`,
        `Up to ${Math.max(...samples.map((sample) => sample.strong.length))} same-carrier cells within 5 dB of the best measured cell.`,
        `Average serving quality: ${selected.rat === "NR" ? "SS-RSRQ" : "RSRQ"} ${meanMetric("rsrq") ?? "n/a"} dB / ${selected.rat === "NR" ? "SS-SINR" : "SINR"} ${meanMetric("sinr") ?? "n/a"} dB.`,
        topPolluters.length ? `Strongest measured non-serving cell: PCI ${topPolluters[0].pci}, present in ${topPolluters[0].sampleCount} samples, avg Δ ${topPolluters[0].averageDeltaToBest} dB.` : "No strong non-serving cell was identified.",
        "Source: imported DT serving and measured neighbor snapshots; no A3 or handover evidence inferred.",
      ],
    };
    return {
      status: "success",
      analysis: {
        source: "imported_dt_client_side", rat: selected.rat, verdict: severity,
        centerTime: selected.time, centerLat: selected.lat, centerLon: selected.lon, windowMs,
        config: { strongThresholdRsrpDbm: -105, deltaToBestDb: 5, coreDeltaDb: 3, qualityThresholdSinrDb: 5, qualityThresholdRsrqDb: rsrqLimit },
        summary: {
          eventCount: 1, pollutedSampleCount: samples.length,
          evaluatedSampleCount: nearby.filter((sample) => sample.eligible).length,
          topPolluters: topPolluters.slice(0, 10),
          topPollutionGroupMembers: topPollutionGroupMembers.slice(0, 10),
          context: { before: contextFor(before), during: contextFor(samples), after: contextFor(after) },
          selectedSample: {
            serving, bestRsrp: selected.best, strongCellCount: strongCount,
            coreStrongCellCount: coreCount, qualityBadIndicators,
            detectionConfidence, attributionConfidence,
          },
        },
        events: [event],
        samples: samples.map((sample, index) => {
          const strongCells = sample.strong.map((cell) => ({
            pci: cell.pci, earfcn: sample.channel, rsrp: cell.rsrp,
            role: cell.serving ? "serving" : "neighbor",
            isCore: !cell.serving && sample.best - cell.rsrp <= 3,
            deltaToBest: round(sample.best - cell.rsrp, 2),
          }));
          return {
            id: index + 1, time: sample.time, t_ms: sample.tMs, lat: sample.lat, lon: sample.lon,
            serving: { pci: sample.pci, earfcn: sample.channel, rsrp: sample.rsrp,
              rsrq: sample.rsrq, sinr: sample.sinr },
            bestRsrp: sample.best, polluted: true, strongCellCount: strongCells.length,
            strongCells, pollutionGroupMembers: strongCells, detectionConfidence,
          };
        }),
        debug: { source: "imported_dt_client_side", windowMs, totalWindowPoints: nearby.length,
          analyzedWindowPoints: nearby.filter((sample) => sample.eligible).length, pollutedWindowPoints: samples.length,
          selectedIndex: selected.index, degradationIntersection: !!requestedIndices?.length,
          firstIndex: first.index, lastIndex: last.index },
      },
    };
  }

  function analyzePoint(points, selectedPoint, options = {}) {
    if (!Array.isArray(points)) throw new TypeError("DT points must be an array");
    let index = Number.isInteger(selectedPoint) ? selectedPoint : points.indexOf(selectedPoint);
    if (index < 0 && selectedPoint && typeof selectedPoint === "object") {
      const time = selectedPoint.time ?? selectedPoint.timestamp ?? selectedPoint.ts;
      const lat = number(selectedPoint.lat ?? selectedPoint.latitude);
      const lon = number(selectedPoint.lng ?? selectedPoint.lon ?? selectedPoint.longitude);
      index = points.findIndex((p) => p && time != null &&
        String(p.time ?? p.timestamp ?? p.ts) === String(time) &&
        (lat === null || Math.abs(number(p.lat ?? p.latitude) - lat) < 1e-7) &&
        (lon === null || Math.abs(number(p.lng ?? p.lon ?? p.longitude) - lon) < 1e-7));
    }
    const point = points[index];
    if (!point) throw new Error("The selected point was not found in this DT.");
    const legs = servingLegs(point, ratOf(options.tech));
    const preferredRat = ratOf(options.rat) || ratOf(point.parsed?.serving?.rat) ||
      (legs.some((leg) => leg.rat === "NR") ? "NR" : "LTE");
    const leg = legs.find((item) => item.rat === preferredRat);
    const selected = leg && snapshot(point, index, leg);
    if (!selected) throw new Error("Measured LTE/NR serving PCI, channel and RSRP are required at this point.");
    if (selected.polluted) return analyzeZone(points,
      { centerIndex: index, rat: selected.rat, channel: selected.channel }, options);

    const rsrqLimit = selected.rat === "NR" ? -15 : -12;
    const qualityBadIndicators = [];
    if (selected.rsrq !== null && selected.rsrq <= rsrqLimit) qualityBadIndicators.push(`RSRQ <= ${rsrqLimit} dB`);
    if (selected.sinr !== null && selected.sinr < 5) qualityBadIndicators.push("SINR < 5 dB");
    return { status: "success", analysis: {
      source: "imported_dt_client_side", rat: selected.rat, verdict: selected.eligible ? "Not detected" : "Insufficient data",
      centerTime: selected.time, centerLat: selected.lat, centerLon: selected.lon,
      windowMs: options.windowMs ?? 12000,
      message: selected.eligible
        ? "The selected point does not meet the measured same-channel overlap and poor-quality criteria."
        : "Insufficient data: at least two measured same-channel neighbors and serving RSRQ or SINR are required. Pilot pollution cannot be assessed at this point.",
      summary: { eventCount: 0, pollutedSampleCount: 0, evaluatedSampleCount: selected.eligible ? 1 : 0,
        topPolluters: [], topPollutionGroupMembers: [], selectedSample: {
          serving: { pci: selected.pci, earfcn: selected.channel, cellName: selected.cellName,
            rsrp: selected.rsrp, rsrq: selected.rsrq, sinr: selected.sinr },
          bestRsrp: selected.best, strongCellCount: selected.strong.length,
          coreStrongCellCount: selected.strong.filter((cell) => selected.best - cell.rsrp <= 3).length,
          qualityBadIndicators, detectionConfidence: 0, attributionConfidence: 0,
        } }, events: [], samples: [],
      debug: { source: "imported_dt_client_side", selectedIndex: index,
        eligible: selected.eligible, referenceVerified: selected.referenceVerified, pollutedWindowPoints: 0 },
    } };
  }

  return { scan, analyzeZone, analyzePoint };
});
