/* One persisted Optim narrative shared by radio review and both Excel exports. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RadioOptimAnalysis = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";
  const VERSION = "optim-deep-bdd-v6";
  const finite = (value) => value === null || value === undefined || value === "" ? null :
    (Number.isFinite(Number(value)) ? Number(value) : null);
  const round = (value) => Number(value.toFixed(1));
  const scanner = () => root.RouteScanAnalyzer || (typeof require === "function" ? require("./route_scan_analyzer.js") : null);
  const cellLabel = (cell) => `${cell.cellName || `${cell.rat || ""} PCI ${cell.pci}`.trim()} (PCI ${cell.pci}, ${cell.channel ?? cell.earfcn ?? "N/D"})`;
  const distance = (a, b) => {
    const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 12742000 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };

  function normalizeSectors(sectors) {
    return (sectors || []).map((s) => {
      const ratText = String(s.rat || s.tech || s.technology || "").toUpperCase();
      const rat = /5G|\bNR\b/.test(ratText) ? "NR" : /LTE|4G|E-UTRA/.test(ratText) ? "LTE" : null;
      return { rat, pci: finite(s.pci ?? s.sc), earfcn: finite(s.currentFreq ?? s.freq ?? s.nrarfcn ?? s.earfcn),
        lat: finite(s.lat), lon: finite(s.lng ?? s.lon), azimuth: finite(s.azimuth ?? s.az),
        cell_name: s.cellName || s.name || s.cellId || "", site_name: s.siteName || s.name || "",
        band: s.band || "", total_tilt: finite(s.totalTilt ?? s.total_tilt ?? s.tilt),
        antenna_height: finite(s.antennaHeight ?? s.antenna_height ?? s.height),
        h_beamwidth: finite(s.hBeamwidth ?? s.h_beamwidth ?? s.horizontalBeamwidth),
        admin_state: s.adminState || s.admin_state || "", coverage_radius_m: finite(s.coverageRadiusM ?? s.plannedCoverageRadiusM) };
    }).filter((s) => s.rat && s.pci !== null && s.earfcn !== null && s.lat !== null && s.lon !== null);
  }

  // Attribute each observed interval to its serving at the start. No time is
  // assigned across missing measurements, disjoint scan portions or >2 s gaps.
  function dwellFor(samples, rat) {
    const blocks = [], byCell = new Map();
    let knownDuration = 0, omittedGaps = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i], serving = s.serving || s;
      const pci = finite(serving.pci), channel = finite(serving.earfcn ?? serving.nrarfcn ?? serving.channel);
      if (pci === null || channel === null) continue;
      const key = `${rat}|${channel}|${pci}`;
      const time = finite(s.t_ms ?? s.timeMs);
      const next = samples[i + 1], nextTime = finite(next?.t_ms ?? next?.timeMs);
      const gap = time !== null && nextTime !== null ? nextTime - time : null;
      const indexGap = next && Number.isInteger(s.sourceIndex) && Number.isInteger(next.sourceIndex)
        ? next.sourceIndex - s.sourceIndex : 1;
      const duration = gap !== null && gap >= 0 && gap <= 2000 && indexGap <= 3 ? gap / 1000 : 0;
      if (next && gap !== null && (gap > 2000 || indexGap > 3)) omittedGaps++;
      let block = blocks[blocks.length - 1];
      if (!block || block.key !== key || block.disconnected) {
        block = { key, rat, pci, channel, cellName: serving.cellName || s.cellName || null,
          startTime: s.time, endTime: s.time, durationS: 0, sampleCount: 0 };
        blocks.push(block);
      }
      block.sampleCount++;
      block.durationS += duration;
      block.endTime = duration > 0 ? next.time : s.time;
      block.disconnected = !!next && duration === 0 && gap !== 0;
      const total = byCell.get(key) || { key, rat, pci, channel, cellName: block.cellName, durationS: 0, sampleCount: 0 };
      total.durationS += duration; total.sampleCount++;
      if (!total.cellName && block.cellName) total.cellName = block.cellName;
      byCell.set(key, total); knownDuration += duration;
    }
    const cells = [...byCell.values()].sort((a, b) => b.durationS - a.durationS || b.sampleCount - a.sampleCount);
    for (const row of [...blocks, ...cells]) {
      row.durationS = round(row.durationS);
      row.dwellPct = knownDuration > 0 ? round(row.durationS * 100 / knownDuration) : null;
      delete row.disconnected;
    }
    return { blocks, cells, dominant: cells[0] || null, knownDurationS: round(knownDuration), omittedGaps,
      dominanceBasis: knownDuration > 0 ? "duration" : "samples_only" };
  }

  // Use the segment geometry winner for BDD recommendation context only when
  // recommendations discuss DT/geometry disagreement or insufficient planned
  // dominance. Keep the point-local DT candidate separate.
  function recommendedServer(planned) {
    if (!planned?.ok) return null;
    const servingPct = finite(planned.servingMatchPct);
    const discussedByRecommendations = !!(planned.localCandidate && planned.localDisagreesWithGeometry) ||
      (servingPct !== null && servingPct < 50);
    const name = planned.mainPlannedCell || planned.rankedCandidates?.find(
      (cell) => cell.pci === planned.mainPlannedPci)?.cellName;
    return discussedByRecommendations && finite(planned.mainPlannedPci) !== null && String(name || "").trim()
      ? { pci: planned.mainPlannedPci, cellName: name, basis: "bdd_geometry" } : null;
  }

  function render(incident) {
    const optim = incident.optimAnalysis;
    const cause = incident.primaryRca?.label || incident.analysis?.cause?.name || "cause à confirmer";
    const name = optim.degradedServing?.cellName || incident.dominantServing?.cellName || incident.representative?.cellName || "serving non résolu";
    const pollution = optim.rat === "NR" ? "recouvrement cofréquence NR" : "pilot pollution LTE";
    const planned = optim.planned;
    optim.recommendedServing = optim.deep && optim.bddStatus === "ready"
      ? recommendedServer(planned) : null;
    const plannedName = optim.recommendedServing?.cellName;
    optim.summaryActions = plannedName ? [
      "Create a clearer dominant server by balancing tilt, azimuth, and power between overlapping sectors.",
    ] : [];
    let summary = `La dégradation sur ${name} est analysée comme : ${cause}.`;
    if (optim.deep) {
      summary = `La dégradation de qualité SINR sur ${name} coïncide avec un problème de ${pollution} sur ${optim.overlapPct} % de la zone.`;
      if (optim.polluters.length) summary += ` Top 3 contributeurs non-serving mesurés : ${optim.polluters.map(cellLabel).join(" ; ")}.`;
      if (plannedName) {
        summary += `\nActions recommandées :\n${optim.summaryActions.join("\n")}`;
      }
    }
    optim.executiveSummary = summary;
    const dwell = optim.dwell;
    const sequence = dwell.blocks.map((b) => `${cellLabel(b)} : ${b.durationS} s${b.dwellPct === null ? "" : ` (${b.dwellPct} %)`} [${b.startTime} → ${b.endTime}]`).join(" → ");
    const dominant = dwell.dominant;
    const top = optim.polluters.map((p, i) => `${i + 1}. ${cellLabel(p)} : ${p.sampleCount} mesures non-serving, ${p.corePolluterSampleCount} dans les 3 dB du meilleur ; Δ moyen ${p.averageDeltaToBest} dB ; RSRP moyen ${p.averageRsrp ?? "N/D"} dBm${p.servingSamples ? ` ; sert aussi ${p.servingSamples} mesures` : ""}${p.bddConfidence != null ? ` ; confiance identité BDD ${Math.round(p.bddConfidence * 100)} %` : ""}.`).join("\n");
    let plannedText = "Non identifié : plan de couverture non fourni.";
    if (planned?.ok) {
      const local = planned.localCandidate;
      const geometry = { pci: planned.mainPlannedPci, cellName: planned.mainPlannedCell, channel: optim.channel };
      plannedText = local ? `Candidat local DT : ${cellLabel({ ...local, channel: optim.channel })}, ${local.rsrp} dBm, ${local.distM} m ; provisoire.` : "Candidat local DT : non identifié.";
      plannedText += ` Projection géométrique BDD : ${cellLabel(geometry)}, score ${planned.mainPlannedScore}/100, ${planned.mainPlannedDistM} m ; aucun secteur prévu n'est confirmé par un plan RF.`;
      if (planned.localDisagreesWithGeometry) plannedText += " Les deux candidats diffèrent ; ne pas confondre ces méthodes.";
    }
    const status = optim.bddStatus === "loading" ? "Enrichissement BDD en cours." : optim.bddError || "";
    const recommendations = [...new Set([...optim.summaryActions, ...optim.recommendations])];
    optim.text = [
      `Executive summary : ${summary}`,
      `Périmètre : ${optim.scope}`,
      `Séquence serving / dwell : ${sequence || "Non disponible"}`,
      `Serving dominante : ${dominant ? `${cellLabel(dominant)} ; ${dominant.durationS} s${dominant.dwellPct === null ? " (dominance par nombre de mesures ; temps indisponible)" : ` (${dominant.dwellPct} % du temps observé)`}` : "Non disponible"}.`,
      `Top 3 polluters :\n${top || "Non identifiés : aucune intersection Scan Route exploitable ; pas de pollution inventée."}`,
      `Planned serving cell : ${plannedText}`,
      `Final classification : ${optim.classification || "Class indéterminée — BDD et contexte planned requis."}`,
      `BDD-enhanced recommendations :\n${recommendations.length ? recommendations.map((r, i) => `P${i + 1}. ${r}`).join("\n") : "Compléter la BDD et vérifier scanner/KPI réseau avant toute modification RF."}`,
      `Limites : les mesures DT servent aux deux moteurs et ne sont pas des preuves indépendantes. Les temps sans mesure sont exclus du dwell (${dwell.omittedGaps} coupure(s)). ${optim.rat === "NR" ? "La comparaison NR exige les mêmes références de mesure et de fréquence. " : ""}${status}`,
    ].join("\n\n");
    return optim;
  }

  // Multi-server overlap (expert rule): a short degraded run served by
  // several cells at comparable levels, with a measured same-channel
  // neighbor at the same level. Works LTE + NR from measured samples only;
  // BDD geometry (keeper vs interferers + named action) is added in enrich().
  const OVERLAP = {
    maxServingSpreadDb: 6,
    neighborWithinDb: 6,
    minDegradedSamples: 2,
    interfererDistRatio: 2,
    thinSampleCap: 5,
  };

  function overlapServingOf(sample) {
    const serving = sample.serving || sample;
    return {
      pci: finite(serving.pci),
      channel: finite(serving.earfcn ?? serving.nrarfcn ?? serving.channel ?? serving.freq),
      rsrp: finite(serving.rsrp),
      cellName: serving.cellName || null,
    };
  }

  function overlapMeasuredNeighbors(sample, servingChannel, rat) {
    const out = [];
    const push = (pci, rsrp, channel, cellName) => {
      const p = finite(pci), r = finite(rsrp), c = finite(channel);
      if (p === null || r === null || c === null) return;
      if (c !== servingChannel) return;
      out.push({ pci: p, rsrp: r, channel: c, cellName: cellName || null });
    };
    // Deep-analysis path: strongCells carry measured non-serving cells.
    if (Array.isArray(sample.strongCells)) {
      for (const cell of sample.strongCells) {
        if (!cell || cell.role === "serving") continue;
        push(cell.pci, cell.rsrp, cell.channel ?? cell.earfcn ?? cell.nrarfcn ?? servingChannel, cell.cellName);
      }
    }
    // Canonical path: parsed measured neighbors on the point snapshot.
    const raws = sample.point?.parsed?.neighbors || sample.parsed?.neighbors || [];
    for (const raw of (Array.isArray(raws) ? raws : [])) {
      if (!raw || typeof raw !== "object") continue;
      const rawRat = String(raw.rat || "").toUpperCase();
      if (rawRat && ((rat === "NR") !== (rawRat === "NR"))) continue;
      const kind = String(raw.source_kind ?? raw.sourceKind ?? raw.role ?? raw.type ?? "");
      if (/inferred|estimated|synthetic|secondary[_\s-]*serving|scell|anchor/i.test(kind)) continue;
      push(raw.pci ?? raw.sc, raw.rsrp ?? raw.rscp,
        rat === "NR" ? (raw.nrarfcn ?? raw.freq ?? raw.channel) : (raw.earfcn ?? raw.freq ?? raw.channel),
        raw.cellName ?? raw.name ?? null);
    }
    const dedup = new Map();
    for (const entry of out) {
      const key = `${entry.pci}|${entry.channel}`;
      const prev = dedup.get(key);
      if (!prev || entry.rsrp > prev.rsrp) dedup.set(key, entry);
    }
    return [...dedup.values()];
  }

  function overlapFor(incident, samples, rat) {
    const none = { applies: false };
    const usable = (Array.isArray(samples) ? samples : []).map((s) => {
      const serving = overlapServingOf(s);
      return { sample: s, serving };
    }).filter((row) => row.serving.pci !== null && row.serving.rsrp !== null && row.serving.channel !== null);
    if (usable.length < OVERLAP.minDegradedSamples) return none;
    const byPci = new Map();
    for (const row of usable) {
      const entry = byPci.get(row.serving.pci) || { pci: row.serving.pci, cellName: row.serving.cellName, samples: 0, rsrpSum: 0 };
      entry.samples++;
      entry.rsrpSum += row.serving.rsrp;
      if (!entry.cellName && row.serving.cellName) entry.cellName = row.serving.cellName;
      byPci.set(row.serving.pci, entry);
    }
    if (byPci.size < 2) return none;
    const servingCells = [...byPci.values()].map((entry) => ({
      pci: entry.pci, cellName: entry.cellName, samples: entry.samples,
      rsrpMean: Math.round((entry.rsrpSum / entry.samples) * 10) / 10,
    })).sort((a, b) => b.rsrpMean - a.rsrpMean);
    const spreadDb = Math.round((servingCells[0].rsrpMean - servingCells[servingCells.length - 1].rsrpMean) * 10) / 10;
    if (!(spreadDb <= OVERLAP.maxServingSpreadDb)) return none;
    const bestServing = servingCells[0].rsrpMean;
    let neighbor = null;
    for (const row of usable) {
      const servingPcis = new Set(servingCells.map((cell) => cell.pci));
      for (const cand of overlapMeasuredNeighbors(row.sample, row.serving.channel, rat)) {
        if (servingPcis.has(cand.pci)) continue;
        const delta = Math.round((bestServing - cand.rsrp) * 10) / 10;
        if (delta <= OVERLAP.neighborWithinDb && (!neighbor || delta < neighbor.deltaDb)) {
          neighbor = { pci: cand.pci, cellName: cand.cellName, rsrp: cand.rsrp, deltaDb: delta };
        }
      }
    }
    const thin = usable.length <= OVERLAP.thinSampleCap;
    return {
      applies: true, rat, channel: usable[0].serving.channel,
      sampleCount: usable.length, servingCells, spreadDb, neighbor,
      keeperPci: null, interferers: [],
      confidence: "medium",
      directional: thin,
      action: thin
        ? `Recouvrement multi-serveurs (${usable.length} snapshots — directionnel) entre ${servingCells.map((c) => `PCI ${c.pci}`).join(", ")} à niveaux comparables (${spreadDb} dB)${neighbor ? ` ; voisine PCI ${neighbor.pci} au même niveau` : ""} : équilibrer tilt/azimut/puissance pour dégager une serveuse dominante ; confirmer la géométrie BDD.`
        : `Recouvrement multi-serveurs entre ${servingCells.map((c) => `PCI ${c.pci}`).join(", ")} à niveaux comparables (${spreadDb} dB)${neighbor ? ` ; voisine PCI ${neighbor.pci} au même niveau` : ""} : équilibrer tilt/azimut/puissance pour dégager une serveuse dominante ; confirmer la géométrie BDD.`,
    };
  }

  function overlapRefineWithBdd(optim) {
    const overlap = optim && optim.overlap;
    if (!overlap || !overlap.applies) return;
    const ranked = optim.planned && optim.planned.ok && Array.isArray(optim.planned.rankedCandidates)
      ? optim.planned.rankedCandidates : [];
    overlapApplyDistances(overlap,
      new Map(ranked.map((row) => [Number(row.pci), { distM: row.distM, cellName: row.cellName }])));
  }

  // Local refinement for overlaps without Deep Analysis (short runs rarely
  // have scan zones): nearest BDD candidate per PCI straight from the loaded
  // sectors, no planned classification involved.
  function overlapRefineLocal(optim, sectors, bdd) {
    const overlap = optim && optim.overlap;
    if (!overlap || !overlap.applies || overlap.keeperPci !== null) return;
    if (!bdd || !Array.isArray(sectors) || !sectors.length) return;
    const rat = overlap.rat, channel = overlap.channel;
    const cells = sectors.map((s) => {
      const ratText = String(s.rat || s.tech || "").toUpperCase();
      return {
        rat: /5G|\bNR\b/.test(ratText) ? "NR" : (/LTE|4G|E-UTRA/.test(ratText) ? "LTE" : null),
        pci: finite(s.pci ?? s.sc), earfcn: finite(s.currentFreq ?? s.freq ?? s.nrarfcn ?? s.earfcn),
        lat: finite(s.lat), lon: finite(s.lng ?? s.lon),
        cell_name: s.cellName || s.name || "",
      };
    }).filter((c) => c.rat && c.pci !== null && c.earfcn !== null && c.lat !== null && c.lon !== null);
    if (!cells.length) return;
    let latSum = 0, lonSum = 0, nPts = 0;
    const samples = Array.isArray(optim.samples) ? optim.samples : [];
    for (const s of samples) {
      const la = finite(s.lat), lo = finite(s.lon ?? s.lng);
      if (la !== null && lo !== null) { latSum += la; lonSum += lo; nPts++; }
    }
    if (!nPts) return;
    const centroid = { lat: latSum / nPts, lon: lonSum / nPts };
    const distByPci = new Map();
    const wanted = new Set([...overlap.servingCells.map((c) => Number(c.pci)),
      ...(overlap.neighbor ? [Number(overlap.neighbor.pci)] : [])]);
    for (const pci of wanted) {
      const cands = bdd.findCandidates(channel, pci, centroid.lat, centroid.lon, 5000, rat, cells);
      if (cands.length) distByPci.set(pci, { distM: cands[0]._dist_m, cellName: cands[0].cell_name || undefined });
    }
    if (!distByPci.size) return;
    overlapApplyDistances(overlap, distByPci);
  }

  function overlapApplyDistances(overlap, distByPci) {
    const withDist = overlap.servingCells.map((cell) => ({ ...cell, distM: distByPci.get(Number(cell.pci))?.distM ?? null }));
    const known = withDist.filter((cell) => Number.isFinite(cell.distM));
    let keeper = null, interferers = [];
    if (known.length) {
      known.sort((a, b) => a.distM - b.distM);
      keeper = known[0].pci;
      interferers = known.slice(1).filter((cell) =>
        cell.distM >= known[0].distM * OVERLAP.interfererDistRatio || known.length === 2).map((cell) => cell.pci);
      if (!interferers.length) interferers = known.slice(1).map((cell) => cell.pci);
    }
    let neighborDist = null;
    if (overlap.neighbor && distByPci.has(Number(overlap.neighbor.pci))) {
      neighborDist = distByPci.get(Number(overlap.neighbor.pci)).distM;
    }
    const fmtCell = (pci) => {
      const cell = withDist.find((row) => Number(row.pci) === Number(pci));
      const name = cell?.cellName ? ` ${cell.cellName}` : "";
      const dist = Number.isFinite(cell?.distM) ? ` (${Math.round(cell.distM)} m)` : "";
      return `PCI ${pci}${name}${dist}`;
    };
    const thinNote = overlap.directional ? ` (${overlap.sampleCount} snapshots — directionnel)` : "";
    if (keeper !== null && interferers.length) {
      const extra = overlap.neighbor && !interferers.includes(overlap.neighbor.pci) &&
        (neighborDist === null || neighborDist >= (withDist.find((row) => Number(row.pci) === Number(keeper))?.distM || 0) * OVERLAP.interfererDistRatio)
        ? [overlap.neighbor.pci] : [];
      const targets = [...interferers, ...extra];
      overlap.keeperPci = keeper;
      overlap.interferers = targets;
      overlap.action = `Recouvrement multi-serveurs${thinNote} : forcer ${targets.map(fmtCell).join(" et ")} à ne plus couvrir ce tronçon par downtilt ou baisse de puissance ; conserver ${fmtCell(keeper)} comme serveuse.`;
    } else {
      overlap.action = `Recouvrement multi-serveurs${thinNote} entre ${overlap.servingCells.map((c) => `PCI ${c.pci}`).join(", ")} à niveaux comparables (${overlap.spreadDb} dB)${overlap.neighbor ? ` ; voisine PCI ${overlap.neighbor.pci} au même niveau` : ""} : équilibrer tilt/azimut/puissance pour dégager une serveuse dominante ; confirmer la géométrie BDD.`;
    }
  }

  function build(log, incident, context = {}) {
    const match = incident.scanOverlap?.best;
    const zone = log.radioDegradationAnalysis?.routeScanOverlap?.zones?.[match?.zoneIndex];
    let deep = null, error = null;
    if (match && zone && scanner()) {
      try { deep = scanner().analyzeZone(log.points, zone, { sampleIndices: match.sampleIndices }).analysis; }
      catch (e) { error = e.message; }
    }
    const rat = deep?.rat || incident.rat;
    const samples = deep ? deep.samples.map((s, i) => ({ ...s, sourceIndex: match.sampleIndices[i] })) :
      (incident.sequence || []).map((s) => ({ ...s, t_ms: s.timeMs, serving: s }));
    // Use the incident's canonical identities, then the existing RAT/carrier-safe resolver.
    for (const s of samples) {
      const canonical = (incident.sequence || []).find((c) => c.pci === s.serving.pci &&
        (c.sourceIndices || [c.sourceIndex]).includes(s.sourceIndex));
      let resolved = null;
      try { resolved = context.resolveCell?.({ rat, pci: s.serving.pci, channel: s.serving.earfcn ?? s.channel, lat: s.lat, lng: s.lon ?? s.lng }); } catch (_) {}
      s.serving = { ...s.serving, cellName: canonical?.cellName || resolved?.cellName || resolved?.name || s.serving.cellName || null };
    }
    const event = deep?.events?.[0];
    incident.optimAnalysis = { version: VERSION, rat, channel: event?.carrier ?? incident.channel,
      degradedServing: { ...(incident.dominantServing || incident.representative || {}) },
      deep, event, samples, overlapPct: match?.overlapPct ?? 0, supported: !!match?.supported,
      scope: deep ? `${event.startTime} → ${event.endTime} ; ${samples.length} mesures de l'intersection exacte dégradation ∩ Scan Route (${match.overlapPct} %).` : `Zone détectée ${incident.startTime} → ${incident.endTime} ; aucun Deep Analysis de pollution exploitable.`,
      dwell: dwellFor(samples, rat),
      polluters: (event?.topPolluters || []).slice(0, 3).map((p) => ({ ...p, rat, channel: event.carrier,
        servingSamples: samples.filter((s) => s.serving.pci === p.pci).length })),
      recommendations: [incident.primaryRca?.recommendation].filter(Boolean),
      bddStatus: deep ? "loading" : "not_applicable", bddError: error,
      classification: !deep ? `Class non applicable au screening de pollution — ${incident.primaryRca?.label || "RCA à confirmer"}.` : null,
      overlap: overlapFor(incident, samples, rat),
    };
    return render(incident);
  }

  function matchPayload(optim, sectors) {
    const event = optim.event, selected = optim.samples.find((s) => s.time === optim.deep.centerTime);
    const polluters = [...event.topPolluters];
    for (const block of optim.dwell.cells) if (!polluters.some((p) => p.pci === block.pci)) polluters.push({ pci: block.pci });
    if (finite(optim.degradedServing.pci) !== null && !polluters.some((p) => p.pci === optim.degradedServing.pci)) polluters.push({ pci: optim.degradedServing.pci });
    return { eventLat: event.centerLat, eventLon: event.centerLon, earfcn: event.carrier, rat: optim.rat,
      polluters, routePoints: optim.samples.map((s) => ({ lat: s.lat, lon: s.lon, servingPci: s.serving.pci, tMs: s.t_ms })),
      servingSequence: event.servingPciSequence,
      bestPciSequence: [...new Set(optim.samples.flatMap((s) => s.strongCells.filter((c) => c.deltaToBest === 0).map((c) => c.pci)))],
      selectedPoint: selected && { lat: selected.lat, lon: selected.lon, time: selected.time,
        cells: selected.strongCells.map((c) => ({ pci: c.pci, rsrp: c.rsrp, isServing: c.role === "serving" })) },
      bddCells: sectors.filter((s) => s.rat === optim.rat && s.earfcn === event.carrier &&
        distance({ lat: event.centerLat, lon: event.centerLon }, s) <= 15000),
    };
  }

  async function enrich(incident, payload, fetcher, optim = incident.optimAnalysis) {
    try {
      if (!fetcher) throw new Error("Service BDD indisponible.");
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeout = controller ? setTimeout(() => controller.abort(), 20000) : null;
      let response;
      try { response = await fetcher("/api/bdd/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), ...(controller ? { signal: controller.signal } : {}) }); }
      finally { if (timeout) clearTimeout(timeout); }
      if (!response.ok) throw new Error(`Service BDD HTTP ${response.status}`);
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || "BDD non disponible pour cette technologie.");
      optim.bddStatus = "ready"; optim.planned = result.plannedServer;
      const byPci = new Map((result.polluters || []).filter((p) => p.matched).map((p) => [p.pci, p]));
      if (!optim.degradedServing.cellName || /^(NR|LTE) PCI /.test(optim.degradedServing.cellName)) {
        optim.degradedServing.cellName = byPci.get(optim.degradedServing.pci)?.bestMatch?.cellName || optim.degradedServing.cellName;
      }
      for (const p of optim.polluters) {
        const mapped = byPci.get(p.pci);
        if (mapped) { p.cellName = mapped.bestMatch?.cellName || p.cellName; p.bddConfidence = mapped.mappingConfidence; }
      }
      for (const row of [...optim.dwell.blocks, ...optim.dwell.cells]) {
        if (!row.cellName || /^(NR|LTE) PCI /.test(row.cellName)) row.cellName = byPci.get(row.pci)?.bestMatch?.cellName || row.cellName;
      }
      const ps = optim.planned;
      optim.classification = ps?.ok ?
        (ps.localDisagreesWithGeometry ? `Class à confirmer — divergence entre candidat DT et projection BDD. Screening géométrique ${ps.conflictClass} : ${ps.conflictLabel} ; ce classement ne démontre pas un défaut du secteur prévu.` :
          `Class ${ps.conflictClass} — ${ps.conflictLabel} (projection BDD provisoire ; plan RF non fourni).`) : "Class indéterminée — aucune BDD comparable sur cette fréquence.";
      if (optim.rat === "NR" && !incident.scanOverlap?.best?.referenceVerified) optim.classification = "Class non vérifiable — références NR de mesure/fréquence insuffisantes.";
      const recommendations = [];
      if (incident.primaryRca?.recommendation) recommendations.push(incident.primaryRca.recommendation);
      const serverRecommendation = recommendedServer(ps);
      if (serverRecommendation) recommendations.push(`Vérifier le secteur prévu au plan RF, la dominance et la couverture de ${serverRecommendation.cellName} ; conserver la distinction entre candidat DT et projection géométrique.`);
      for (const p of optim.polluters) {
        const matched = byPci.get(p.pci);
        if (matched?.bestMatch?.recommendation) recommendations.push(`${cellLabel(p)} — ${matched.bestMatch.recommendation} Attribution géométrique à confirmer ; aucune modification de tilt/puissance automatique.`);
      }
      recommendations.push("Confirmer l'interférence par scanner/FFT, charge et KPI réseau ; vérifier la signalisation RRC pour toute hypothèse de mobilité, puis mesurer après action.");
      optim.recommendations = [...new Set(recommendations)];
      overlapRefineWithBdd(optim);
    } catch (error) {
      optim.bddStatus = "unavailable"; optim.bddError = `Enrichissement BDD incomplet : ${error.message}`;
      optim.classification = "Class indéterminée — enrichissement BDD indisponible ; faits DT conservés.";
    }
    if (incident.optimAnalysis === optim) render(incident);
  }

  function prepare(log, context = {}) {
    const analysis = log?.radioDegradationAnalysis;
    if (!analysis) return Promise.resolve(null);
    const sectors = normalizeSectors(context.sectors || []);
    const serialized = JSON.stringify(sectors);
    let hash = 2166136261;
    for (let i = 0; i < serialized.length; i++) hash = Math.imul(hash ^ serialized.charCodeAt(i), 16777619);
    const key = `${VERSION}|${sectors.length}|${hash >>> 0}`;
    if (!context.force && analysis.optimPreparation?.key === key) return analysis.optimPreparation.promise;
    const incidents = analysis.incidents || [];
    for (const incident of incidents) build(log, incident, context);
    const jobs = incidents.filter((i) => i.optimAnalysis.deep);
    const preparation = { key, promise: null };
    analysis.optimPreparation = preparation;
    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length && analysis.optimPreparation === preparation) {
        const incident = jobs[cursor++];
        const optim = incident.optimAnalysis;
        await enrich(incident, matchPayload(optim, sectors), context.fetch || root.fetch?.bind(root), optim);
        context.onProgress?.(incident);
      }
    };
    const promise = Promise.all([worker(), worker()]).then(() => {
      // Local overlap refinement (no Deep Analysis needed): nearest loaded
      // sector per PCI so short multi-server runs also get a named action.
      try {
        const bdd = root.BddMatcher || (typeof require === "function" ? require("./bdd_matcher.js") : null);
        if (bdd) {
          for (const incident of incidents) {
            if (incident.optimAnalysis) overlapRefineLocal(incident.optimAnalysis, sectors, bdd);
          }
          for (const incident of incidents) {
            if (incident.optimAnalysis) render(incident);
          }
        }
      } catch (_) {}
      return analysis;
    });
    preparation.promise = promise;
    return promise;
  }
  return { VERSION, dwellFor, build, render, normalizeSectors, matchPayload, recommendedServer, prepare };
});
