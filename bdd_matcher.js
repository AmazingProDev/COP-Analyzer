/* BDD matcher — JS port of bdd_matcher.py (optim-deep-bdd-v6 package).
 * Pure geometry/statistics, no backend: the cell inventory always comes from
 * the request payload (bddCells), already filtered by RAT/channel/distance by
 * the caller (RadioOptimAnalysis.matchPayload). Mirrors the Python semantics,
 * including None-handling and key names, so results match the server version.
 * Exposes createLocalBddFetch() to serve /api/bdd/match locally in static apps.
 */
(function bddMatcherFactory(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BddMatcher = api;
})(typeof window !== "undefined" ? window : globalThis, function makeBddMatcher() {
  "use strict";

  const BAND_RADIUS_M = {
    L800: 4000.0,
    L900: 3000.0,
    L1800: 2000.0,
    L2100: 1500.0,
    L2600: 1000.0,
  };

  const safeInt = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" && v.trim() === "") return null;
    const n = Number(v);
    if (Number.isNaN(n)) return null;
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n);
  };

  const safeFloat = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" && v.trim() === "") return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  };

  const round1 = (v) => Math.round(v * 10) / 10;
  const round2 = (v) => Math.round(v * 100) / 100;

  function expectedRadius(cell, band) {
    const stated = safeFloat(cell.coverage_radius_m);
    if (stated !== null && stated > 0) return stated;
    if (cell.rat === "NR") {
      const map = { n28: 4000.0, n1: 1500.0, n3: 2000.0, n78: 1000.0 };
      const hit = map[String(band).toLowerCase()];
      return hit !== undefined ? hit : 2000.0;
    }
    const hit = BAND_RADIUS_M[band];
    return hit !== undefined ? hit : 2000.0;
  }

  function normalizeReferenceCells(rows) {
    if (!Array.isArray(rows) || rows.length > 10000) return [];
    const result = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const rat = String(row.rat || "").toUpperCase();
      const pci = safeInt(row.pci);
      const channel = safeInt(row.earfcn);
      const lat = safeFloat(row.lat);
      const lon = safeFloat(row.lon);
      if (rat !== "LTE" && rat !== "NR") continue;
      if (pci === null || channel === null || lat === null || lon === null) continue;
      if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) continue;
      const out = { rat, pci, earfcn: channel, lat, lon };
      for (const key of ["cell_name", "site_name", "band", "admin_state"]) {
        out[key] = String(row[key] || "").slice(0, 300);
      }
      for (const key of ["azimuth", "total_tilt", "antenna_height", "h_beamwidth", "coverage_radius_m"]) {
        out[key] = safeFloat(row[key]);
      }
      result.push(out);
    }
    return result;
  }

  function referenceCellsFor(rat, channel, supplied) {
    const r = String(rat || "").toUpperCase();
    return normalizeReferenceCells(supplied).filter((c) => c.rat === r && c.earfcn === channel);
  }

  function earfcnToBand(earfcn) {
    if (earfcn === null || earfcn === undefined) return "L1800";
    const e = parseInt(earfcn, 10);
    if (e >= 6150 && e <= 6449) return "L800";
    if (e >= 2750 && e <= 3449) return "L900";
    if (e >= 1200 && e <= 1949) return "L1800";
    if (e >= 300 && e <= 699) return "L2100";
    if (e >= 2400 && e <= 2700) return "L2600";
    if (e >= 3400 && e <= 3799) return "L2600";
    return "L1800";
  }

  function nrarfcnToBand(nrarfcn) {
    if (nrarfcn === null || nrarfcn === undefined) return "";
    const n = parseInt(nrarfcn, 10);
    if (n >= 151600 && n <= 160600) return "n28";
    if (n >= 361000 && n <= 376000) return "n3";
    if (n >= 384000 && n <= 396000) return "n1";
    if (n >= 422000 && n <= 440000) return "n1";
    if (n >= 499200 && n <= 537999) return "n41";
    if (n >= 620000 && n <= 680000) return "n78";
    if (n >= 693334 && n <= 733333) return "n79";
    return "";
  }

  const DEG = Math.PI / 180;
  function haversineM(lat1, lon1, lat2, lon2) {
    const r1 = lat1 * DEG, r2 = lat2 * DEG;
    const a = Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 +
      Math.cos(r1) * Math.cos(r2) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
    const clamped = Math.max(0.0, Math.min(1.0, a));
    return 6371000.0 * 2.0 * Math.asin(Math.sqrt(clamped));
  }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    const r1 = lat1 * DEG, r2 = lat2 * DEG;
    const dlon = (lon2 - lon1) * DEG;
    const x = Math.sin(dlon) * Math.cos(r2);
    const y = Math.cos(r1) * Math.sin(r2) - Math.sin(r1) * Math.cos(r2) * Math.cos(dlon);
    return (((Math.atan2(x, y) / DEG) + 360.0) % 360 + 360) % 360;
  }

  function angleDiff(a, b) {
    return Math.abs(((((a - b + 180.0) % 360) + 360) % 360) - 180.0);
  }

  function verticalAngleDeg(hM, distM, ueH = 1.5) {
    if (distM <= 0) return null;
    return Math.atan(Math.max(0.0, hM - ueH) / distM) / DEG;
  }

  function lobeClass(azError, beamwidth = 65.0) {
    const half = beamwidth / 2.0;
    if (azError <= half) return "main_lobe";
    if (azError <= beamwidth) return "edge_lobe";
    if (azError <= beamwidth + 50.0) return "side_lobe";
    return "back_lobe";
  }

  function classifyRootCause(lobe, distM, avgDelta, nonServingCount, totalTilt, expectedRadiusM) {
    const aligned = lobe === "main_lobe" || lobe === "edge_lobe";
    const beyondRadius = distM > expectedRadiusM;
    const wellBeyond = distM > expectedRadiusM * 1.5;
    const strongSignal = avgDelta <= 3.0;
    const persistent = nonServingCount >= 2;
    if (aligned && beyondRadius && strongSignal && persistent) {
      if (totalTilt !== null && totalTilt !== undefined && totalTilt <= 4.0) return "overshooting_candidate";
      if (totalTilt !== null && totalTilt !== undefined && totalTilt <= 6.0 && wellBeyond) return "overshooting_candidate";
    }
    if (lobe === "main_lobe" && avgDelta <= 3.0) {
      if (beyondRadius) return "main_lobe_overshooting";
      return "main_lobe_overlap";
    }
    if (lobe === "edge_lobe" && distM > expectedRadiusM * 0.8 && avgDelta <= 4.0) return "edge_lobe_overlap_or_overshoot";
    if (lobe === "edge_lobe" && avgDelta <= 3.0) return "main_lobe_overlap";
    if (lobe === "side_lobe" && avgDelta <= 5.0) return "side_lobe_pollution_candidate";
    if (lobe === "back_lobe" && avgDelta <= 5.0) return "back_lobe_or_bdd_error_candidate";
    return lobe;
  }

  const RECOMMENDATIONS = {
    overshooting_candidate: "Check RET/electrical tilt, mechanical tilt, antenna height, and RS power. Consider adding 1–2° downtilt after verifying coverage impact on adjacent cells.",
    main_lobe_overshooting: "The sector is aligned with the event area but the distance suggests it may be overshooting. Verify whether this road segment is inside the intended coverage boundary. If not, check RET/electrical tilt and mechanical tilt to reduce footprint.",
    main_lobe_overlap: "Create a clearer dominant server by balancing tilt, azimuth, and power between overlapping sectors. Review planned serving boundary and CIO if needed.",
    edge_lobe_overlap_or_overshoot: "Check whether this sector is creating edge-lobe overlap into the event area. Review azimuth, tilt, and planned coverage boundary. If signal is strong beyond the intended footprint, also check for overshooting.",
    side_lobe_pollution_candidate: "Check physical antenna azimuth, antenna pattern, feeder/antenna installation, and possible reflection or diffraction from local clutter.",
    back_lobe_or_bdd_error_candidate: "Verify BDD azimuth accuracy and physical antenna installation. Check for back-lobe/reflection. If BDD azimuth is confirmed correct, review feeder connections and possible antenna swap.",
  };

  function recommend(rootCause) {
    return RECOMMENDATIONS[rootCause] ||
      "Validate cell mapping and compare with planned coverage before applying RF or mobility changes.";
  }

  function findCandidates(earfcn, pci, eventLat, eventLon, maxDistM = 15000.0, rat = "LTE", bddCells = []) {
    const ratUpper = String(rat || "").trim().toUpperCase();
    const results = [];
    for (const cell of bddCells || []) {
      if (cell.rat !== ratUpper) continue;
      if (cell.earfcn !== earfcn || cell.pci !== pci) continue;
      const dist = haversineM(eventLat, eventLon, cell.lat, cell.lon);
      if (dist > maxDistM) continue;
      results.push({ ...cell, _dist_m: dist });
    }
    results.sort((a, b) => a._dist_m - b._dist_m);
    return results;
  }

  function geometryForCandidate(candidate, eventLat, eventLon, avgDelta, nonServingCount, earfcn) {
    const distM = candidate._dist_m;
    const brg = bearingDeg(candidate.lat, candidate.lon, eventLat, eventLon);
    const az = candidate.azimuth;
    const azErr = az !== null && az !== undefined ? angleDiff(az, brg) : null;
    const bw = candidate.h_beamwidth || 65.0;
    const lobe = azErr !== null ? lobeClass(azErr, bw) : "unknown";
    const totalTilt = candidate.total_tilt;
    const h = candidate.antenna_height || 0.0;
    const vAngle = verticalAngleDeg(h, distM);
    const band = candidate.band || (candidate.rat === "NR" ? nrarfcnToBand(earfcn) : earfcnToBand(earfcn));
    const expectedR = expectedRadius(candidate, band);
    const rootCause = classifyRootCause(lobe, distM, avgDelta, nonServingCount, totalTilt, expectedR);
    return {
      distM: Math.round(distM),
      bearingDeg: round1(brg),
      azimuthErrorDeg: azErr !== null ? round1(azErr) : null,
      lobeClass: lobe,
      verticalAngleDeg: vAngle !== null ? round2(vAngle) : null,
      expectedRadiusM: expectedR,
      rootCause,
      recommendation: recommend(rootCause),
    };
  }

  function mappingConfidence(nCandidates, bestLobe) {
    if (nCandidates === 0) return 0.0;
    if (nCandidates === 1) return (bestLobe === "main_lobe" || bestLobe === "edge_lobe") ? 0.88 : 0.72;
    const penalty = Math.min(0.35, (nCandidates - 1) * 0.07);
    const base = (bestLobe === "main_lobe" || bestLobe === "edge_lobe") ? 0.82 : 0.65;
    return round2(Math.max(0.30, base - penalty));
  }

  function azimuthScore(azError) {
    if (azError <= 20) return 100.0;
    if (azError <= 35) return 85.0;
    if (azError <= 60) return 60.0;
    if (azError <= 90) return 30.0;
    if (azError <= 120) return 15.0;
    return 5.0;
  }

  function distanceScorePlanned(distanceM, expectedRadiusM) {
    const ratio = distanceM / Math.max(expectedRadiusM, 1.0);
    if (ratio <= 0.5) return 100.0;
    if (ratio <= 1.0) return 85.0;
    if (ratio <= 1.5) return 60.0;
    if (ratio <= 2.0) return 35.0;
    return 10.0;
  }

  function lobeScorePlanned(lobe) {
    const map = { main_lobe: 100.0, edge_lobe: 70.0, side_lobe: 25.0, back_lobe: 5.0 };
    return map[lobe] !== undefined ? map[lobe] : 30.0;
  }

  function verticalScorePlanned(cell, distanceM) {
    const h = cell.antenna_height || 0.0;
    const totalTilt = cell.total_tilt;
    if (totalTilt === null || totalTilt === undefined || distanceM <= 0) return 50.0;
    const vAngle = Math.atan(Math.max(0.0, h - 1.5) / Math.max(distanceM, 1.0)) / DEG;
    const vErr = Math.abs(totalTilt - vAngle);
    if (vErr <= 3) return 100.0;
    if (vErr <= 6) return 70.0;
    if (vErr <= 10) return 40.0;
    return 15.0;
  }

  function scoreCellForPoint(cell, pointLat, pointLon, earfcn) {
    const distM = haversineM(cell.lat, cell.lon, pointLat, pointLon);
    const brg = bearingDeg(cell.lat, cell.lon, pointLat, pointLon);
    const az = cell.azimuth;
    const azErr = (az !== null && az !== undefined) ? angleDiff(az, brg) : 90.0;
    const bw = cell.h_beamwidth || 65.0;
    const lobe = lobeClass(azErr, bw);
    const band = cell.band || (cell.rat === "NR" ? nrarfcnToBand(earfcn) : earfcnToBand(earfcn));
    const expectedR = expectedRadius(cell, band);
    const plannedScore = 0.40 * azimuthScore(azErr) + 0.30 * distanceScorePlanned(distM, expectedR) +
      0.15 * lobeScorePlanned(lobe) + 0.10 * verticalScorePlanned(cell, distM) +
      0.05 * (String(cell.admin_state || "").toUpperCase() === "ON_AIR" ? 100.0 : 0.0);
    return {
      pci: cell.pci,
      cellName: cell.cell_name,
      siteName: cell.site_name,
      plannedScore: round1(plannedScore),
      distM: Math.round(distM),
      azimuthErrorDeg: round1(azErr),
      lobeClass: lobe,
      expectedRadiusM: expectedR,
      _cell_ref: cell,
    };
  }

  function findActiveCellsOnEarfcn(earfcn, eventLat, eventLon, maxDistM = 15000.0, rat = "LTE", bddCells = []) {
    const ratUpper = String(rat || "").trim().toUpperCase();
    const results = [];
    for (const cell of bddCells || []) {
      if (cell.rat !== ratUpper) continue;
      if (cell.earfcn !== earfcn) continue;
      const dist = haversineM(eventLat, eventLon, cell.lat, cell.lon);
      if (dist > maxDistM) continue;
      results.push({ ...cell, _dist_m: dist });
    }
    results.sort((a, b) => a._dist_m - b._dist_m);
    return results;
  }

  const PLANNED_MIN_SCORE = 60.0;
  const PLANNED_OVERLAP_GAP = 10.0;
  const PLANNED_OVERLAP_MIN_SECOND = 55.0;

  function classifyPlannedConflict(mainPlannedPci, polluterPcis, servingSequence, bestPciSequence, servingMatchPct, overlapPct) {
    if (mainPlannedPci === null || mainPlannedPci === undefined) {
      return ["unknown", "No clear planned server identified from BDD geometry"];
    }
    const plannedIsPolluter = polluterPcis.includes(mainPlannedPci);
    const plannedInServing = servingSequence.includes(mainPlannedPci);
    const plannedIsBest = bestPciSequence.includes(mainPlannedPci);
    if (servingMatchPct >= 55 && plannedIsBest && !plannedIsPolluter) {
      return ["A", "Planned server dominates but co-channel cells degrade quality"];
    }
    if (servingMatchPct >= 55) {
      return ["A", "Planned server is dominant; measured pollution is from nearby cells"];
    }
    if (servingMatchPct < 35 && overlapPct >= 55) {
      return ["B/C", "Planned-server dominance failure with high planned overlap"];
    }
    if (overlapPct >= 55) {
      return ["C", "Planned overlap — BDD design does not create clean dominance at this location"];
    }
    if (servingMatchPct < 35 && !plannedInServing && !plannedIsBest) {
      return ["D", "Planned server is not dominant — possible overshoot by another cell or coverage gap"];
    }
    if (servingMatchPct < 50) {
      return ["B", "Planned server does not consistently dominate — unstable dominance"];
    }
    return ["B", "Partial planned-server dominance — further analysis recommended"];
  }

  function polluterPlannedRole(pci, mainPlannedPci, ranked, polluterPcis, plannedScore) {
    if (pci === mainPlannedPci) return "planned_server";
    if (ranked.length >= 2 && ranked[1].pci === pci && plannedScore >= PLANNED_OVERLAP_MIN_SECOND) {
      return "planned_overlap_candidate";
    }
    if (plannedScore >= 70) return "planned_overlap_candidate";
    const found = ranked.find((r) => r.pci === pci);
    const lobe = found ? found.lobeClass : null;
    const isMeasuredPolluter = polluterPcis.includes(pci);
    if (plannedScore < 35) {
      if (lobe === "back_lobe") return "back_lobe_or_bdd_error";
      if (lobe === "side_lobe") return isMeasuredPolluter ? "unexpected_side_lobe" : "side_lobe_candidate";
      return isMeasuredPolluter ? "unexpected_polluter" : "low_score_candidate";
    }
    return "secondary_candidate";
  }

  function analyzePlannedServer(routePoints, bddCandidates, earfcn, polluterPcis, servingSequence, bestPciSequence) {
    if (!bddCandidates || !bddCandidates.length) return { ok: false, reason: "no_bdd_candidates_on_earfcn" };
    const validPts = (routePoints || []).filter((p) =>
      safeFloat(p && p.lat) !== null && safeFloat(p && p.lon) !== null);
    if (!validPts.length) return { ok: false, reason: "no_valid_route_points" };
    const perPoint = [];
    for (const pt of validPts) {
      const lat = Number(pt.lat);
      const lon = Number(pt.lon);
      const servingPci = safeInt(pt.servingPci);
      const scored = bddCandidates.map((c) => scoreCellForPoint(c, lat, lon, earfcn));
      scored.sort((a, b) => b.plannedScore - a.plannedScore);
      const top = scored.length ? scored[0] : null;
      const second = scored.length > 1 ? scored[1] : null;
      const plannedOverlap = Boolean(top && second &&
        top.plannedScore >= PLANNED_MIN_SCORE &&
        (top.plannedScore - second.plannedScore) <= PLANNED_OVERLAP_GAP &&
        second.plannedScore >= PLANNED_OVERLAP_MIN_SECOND);
      perPoint.push({
        tMs: pt.tMs,
        plannedPci: top ? top.pci : null,
        plannedScore: top ? top.plannedScore : null,
        secondPlannedPci: second ? second.pci : null,
        secondScore: second ? second.plannedScore : null,
        plannedOverlap,
        servingPci,
        servingMatchesPlanned: servingPci !== null && top !== null && servingPci === top.pci,
      });
    }
    const total = perPoint.length;
    const plannedVotes = {};
    let servingMatchCount = 0;
    let overlapCount = 0;
    for (const pt of perPoint) {
      if (pt.plannedPci !== null && pt.plannedPci !== undefined) {
        plannedVotes[pt.plannedPci] = (plannedVotes[pt.plannedPci] || 0) + 1;
      }
      if (pt.servingMatchesPlanned) servingMatchCount++;
      if (pt.plannedOverlap) overlapCount++;
    }
    let mainPlannedPci = null;
    let mainVotes = 0;
    for (const key of Object.keys(plannedVotes)) {
      if (plannedVotes[key] > mainVotes) { mainVotes = plannedVotes[key]; mainPlannedPci = Number(key); }
    }
    const servingMatchPct = total ? Math.round((servingMatchCount / total) * 100) : 0;
    const overlapPct = total ? Math.round((overlapCount / total) * 100) : 0;
    const avgLat = validPts.reduce((s, pt) => s + Number(pt.lat), 0) / validPts.length;
    const avgLon = validPts.reduce((s, pt) => s + Number(pt.lon), 0) / validPts.length;
    const mainInfo = {};
    if (mainPlannedPci !== null) {
      const cell = bddCandidates.find((c) => c.pci === mainPlannedPci);
      if (cell) {
        const s = scoreCellForPoint(cell, avgLat, avgLon, earfcn);
        mainInfo.mainPlannedCell = cell.cell_name;
        mainInfo.mainPlannedSite = cell.site_name;
        mainInfo.mainPlannedScore = s.plannedScore;
        mainInfo.mainPlannedDistM = s.distM;
        mainInfo.mainPlannedAzErr = s.azimuthErrorDeg;
        mainInfo.mainPlannedLobe = s.lobeClass;
      }
    }
    const bestPerPci = {};
    for (const cell of bddCandidates) {
      const s = scoreCellForPoint(cell, avgLat, avgLon, earfcn);
      if (bestPerPci[cell.pci] === undefined || s.plannedScore > bestPerPci[cell.pci].plannedScore) {
        bestPerPci[cell.pci] = s;
      }
    }
    const ranked = Object.values(bestPerPci).sort((a, b) => b.plannedScore - a.plannedScore);
    for (const r of ranked) {
      r.plannedRole = polluterPlannedRole(r.pci, mainPlannedPci, ranked, polluterPcis, r.plannedScore);
      delete r._cell_ref;
    }
    const [conflictClass, conflictLabel] = classifyPlannedConflict(
      mainPlannedPci, polluterPcis, servingSequence, bestPciSequence, servingMatchPct, overlapPct);
    return {
      ok: true,
      mainPlannedPci,
      mainPlannedSamplePct: (mainPlannedPci !== null && total) ? Math.round(((plannedVotes[mainPlannedPci] || 0) / total) * 100) : 0,
      servingMatchPct,
      plannedOverlapPct: overlapPct,
      conflictClass,
      conflictLabel,
      rankedCandidates: ranked.slice(0, 6),
      ...mainInfo,
    };
  }

  function localMeasuredServerCandidate(selectedPoint, earfcn, rat, bddCells = []) {
    if (!selectedPoint || typeof selectedPoint !== "object") return null;
    const lat = safeFloat(selectedPoint.lat);
    const lon = safeFloat(selectedPoint.lon);
    if (lat === null || lon === null) return null;
    const measured = selectedPoint.cells;
    if (!Array.isArray(measured)) return null;
    const rows = [];
    const seenPcis = new Set();
    for (const measurement of measured) {
      if (!measurement || typeof measurement !== "object") continue;
      const pci = safeInt(measurement.pci);
      const rsrp = safeFloat(measurement.rsrp);
      if (pci === null || seenPcis.has(pci) || rsrp === null || rsrp < -150 || rsrp > -30) continue;
      seenPcis.add(pci);
      const matches = findCandidates(earfcn, pci, lat, lon, 5000.0, rat, bddCells);
      if (!matches.length) continue;
      const sector = matches[0];
      const geometry = scoreCellForPoint(sector, lat, lon, earfcn);
      const eligible = rsrp >= -105 &&
        (geometry.lobeClass === "main_lobe" || geometry.lobeClass === "edge_lobe") &&
        geometry.distM <= geometry.expectedRadiusM;
      rows.push({
        pci,
        cellName: sector.cell_name,
        siteName: sector.site_name,
        rsrp: round1(rsrp),
        isServing: Boolean(measurement.isServing),
        plannedScore: geometry.plannedScore,
        distM: geometry.distM,
        azimuthErrorDeg: geometry.azimuthErrorDeg,
        lobeClass: geometry.lobeClass,
        expectedRadiusM: geometry.expectedRadiusM,
        eligible,
        candidateCountForPci: matches.length,
      });
    }
    const eligibleRows = rows.filter((row) => row.eligible);
    eligibleRows.sort((a, b) => (b.rsrp - a.rsrp) || (b.plannedScore - a.plannedScore) || (a.distM - b.distM));
    if (!eligibleRows.length) return null;
    const best = eligibleRows[0];
    return {
      ...best,
      sampleTime: selectedPoint.time,
      method: "selected_sample_rsrp_with_nearest_bdd_geometry",
      verifiedPlan: false,
      marginToNextDb: eligibleRows.length > 1 ? round1(best.rsrp - eligibleRows[1].rsrp) : null,
      alternatives: eligibleRows.slice(1, 4),
    };
  }

  function matchPollutionEvent(args = {}) {
    const {
      eventLat, eventLon, polluters = [], earfcn,
      maxDistM = 15000.0, rat = "LTE",
      routePoints = null, servingSequence = [], bestPciSequence = [],
      selectedPoint = null, bddCells = [],
    } = args;
    const cells = Array.isArray(bddCells) ? bddCells : [];
    const ratUpper = String(rat || "").trim().toUpperCase();
    const hasComparable = cells.some((cell) => cell.rat === ratUpper && cell.earfcn === earfcn);
    if (!cells.length || !hasComparable) {
      return { ok: false, error: `No comparable ${rat} BDD on channel ${earfcn}. Load the RAT-specific inventory.` };
    }
    const results = [];
    for (const polluter of polluters) {
      const pci = safeInt(polluter ? polluter.pci : null);
      if (pci === null) continue;
      const avgDeltaValue = safeFloat(polluter.averageDeltaToBest);
      const avgDelta = avgDeltaValue !== null ? avgDeltaValue : 99.0;
      const nonServingCount = parseInt(polluter.nonServingPolluterSampleCount || 0, 10);
      const coreHits = parseInt(polluter.corePolluterSampleCount || 0, 10);
      const score = Number(polluter.polluterScore || 0.0);
      const candidates = findCandidates(earfcn, pci, eventLat, eventLon, maxDistM, rat, cells);
      if (!candidates.length) {
        results.push({
          pci, earfcn, matched: false, candidateCount: 0,
          avgDeltaToBest: avgDelta, coreHits, nonServingCount, polluterScore: score,
          mappingConfidence: 0.0,
          error: `No BDD cell found within ${Math.round(maxDistM / 1000)} km for EARFCN ${earfcn} PCI ${pci}`,
        });
        continue;
      }
      const geoList = candidates.slice(0, 5).map((c) =>
        geometryForCandidate(c, eventLat, eventLon, avgDelta, nonServingCount, earfcn));
      const bestLobe = geoList.length ? (geoList[0].lobeClass || "unknown") : "unknown";
      const conf = mappingConfidence(candidates.length, bestLobe);
      const candRows = candidates.slice(0, 5).map((c, i) => {
        const geo = geoList[i];
        return {
          siteName: c.site_name, cellName: c.cell_name, cgiEci: c.cgi_eci ?? null,
          lat: c.lat, lon: c.lon, azimuth: c.azimuth, totalTilt: c.total_tilt,
          antennaHeight: c.antenna_height, hBeamwidth: c.h_beamwidth, band: c.band,
          ...geo,
        };
      });
      results.push({
        pci, earfcn, matched: true, candidateCount: candidates.length,
        avgDeltaToBest: avgDelta, coreHits, nonServingCount, polluterScore: score,
        mappingConfidence: conf,
        bestMatch: candRows.length ? candRows[0] : null,
        allCandidates: candRows,
      });
    }
    let plannedServer = null;
    if (routePoints) {
      const earfcnCandidates = findActiveCellsOnEarfcn(earfcn, eventLat, eventLon, maxDistM, rat, cells);
      const polluterPcis = polluters.filter((p) => p && p.pci !== null && p.pci !== undefined).map((p) => parseInt(p.pci, 10));
      plannedServer = analyzePlannedServer(
        routePoints, earfcnCandidates, earfcn, polluterPcis, servingSequence || [], bestPciSequence || []);
      if (plannedServer.ok) {
        const localCandidate = localMeasuredServerCandidate(selectedPoint, earfcn, rat, cells);
        plannedServer.localCandidate = localCandidate;
        plannedServer.localDisagreesWithGeometry = Boolean(
          localCandidate && localCandidate.pci !== plannedServer.mainPlannedPci);
      }
    }
    return {
      ok: true, eventLat, eventLon, earfcn,
      bddCellCount: cells.length,
      polluters: results,
      plannedServer,
    };
  }

  /* Serve /api/bdd/match locally (static apps without the Python backend). */
  function createLocalBddFetch(fallbackFetch) {
    return async function localBddFetch(url, opts) {
      if (typeof url === "string" && url.endsWith("/api/bdd/match")) {
        let body = {};
        try { body = JSON.parse((opts && opts.body) || "{}"); } catch (_) { body = {}; }
        const result = matchPollutionEvent({
          eventLat: body.eventLat, eventLon: body.eventLon,
          earfcn: body.earfcn, maxDistM: body.maxDistM || 15000,
          rat: body.rat || "LTE", polluters: body.polluters || [],
          routePoints: body.routePoints || null,
          servingSequence: body.servingSequence || [],
          bestPciSequence: body.bestPciSequence || [],
          selectedPoint: body.selectedPoint || null,
          bddCells: referenceCellsFor(body.rat || "LTE", body.earfcn, body.bddCells || []),
        });
        return {
          ok: true, status: 200,
          json: async () => ({ status: result.ok ? "success" : "error", ...result }),
        };
      }
      if (typeof fallbackFetch === "function") return fallbackFetch(url, opts);
      throw new Error("Service BDD local : fetch de repli indisponible.");
    };
  }

  return {
    normalizeReferenceCells,
    referenceCellsFor,
    earfcnToBand,
    nrarfcnToBand,
    haversineM,
    bearingDeg,
    angleDiff,
    findCandidates,
    geometryForCandidate,
    mappingConfidence,
    classifyRootCause,
    recommend,
    scoreCellForPoint,
    findActiveCellsOnEarfcn,
    classifyPlannedConflict,
    polluterPlannedRole,
    analyzePlannedServer,
    localMeasuredServerCandidate,
    matchPollutionEvent,
    createLocalBddFetch,
  };
});
