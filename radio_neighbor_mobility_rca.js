/* Measured-neighbour RCA. Canonical samples describe the zone; raw samples date mobility. */
(function neighborMobilityFactory(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadioNeighborMobilityRca = api;
})(typeof window !== "undefined" ? window : globalThis, function makeNeighborMobilityRca() {
  "use strict";
  const VERSION = "neighbor-mobility-v2";
  const num = (value) => value === null || value === undefined || value === "" ? null :
    (Number.isFinite(Number(value)) ? Number(value) : null);
  const pct = (a, b) => b ? Number((100 * a / b).toFixed(1)) : 0;
  const quantile = (values, p) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const at = (sorted.length - 1) * p, low = Math.floor(at), high = Math.ceil(at);
    return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
  };
  const stats = (values) => ({ p10: quantile(values, .1), p25: quantile(values, .25), p50: quantile(values, .5) });
  const distanceM = (a, b) => {
    const lat1 = num(a?.lat), lat2 = num(b?.lat), lng1 = num(a?.lng), lng2 = num(b?.lng);
    if ([lat1, lat2, lng1, lng2].some((value) => value === null)) return 0;
    const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  const keyOf = (item) => `${item.rat}|${item.pci}|${item.channel}`;
  const identity = (item) => item && item.pci !== null && item.channel !== null ? keyOf(item) : null;
  const measurementReference = (raw, rat) => {
    if (rat !== "NR") return "LTE_RSRP";
    const stated = String(raw?.measurementReference ?? raw?.rsrpReference ?? "").toUpperCase().replace(/[\s-]/g, "_");
    if (/^SS_?RSRP$/.test(stated)) return "SS_RSRP";
    if (/^CSI_?RSRP$/.test(stated)) return "CSI_RSRP";
    if (raw?.ssRsrp !== undefined) return "SS_RSRP";
    if (raw?.csiRsrp !== undefined) return "CSI_RSRP";
    return "UNKNOWN";
  };
  const frequencyReference = (raw, rat) => rat !== "NR" ? "EARFCN" :
    String(raw?.frequencyReference || (raw?.ssbNrarfcn !== undefined ? "SSB_ARFCN" :
      raw?.nrarfcn !== undefined ? "CARRIER_ARFCN" : "UNKNOWN")).toUpperCase().replace(/[\s-]/g, "_");
  const comparableReference = (serving, neighbor) => serving.rat !== "NR" ||
    serving.measurementReference !== "UNKNOWN" && serving.measurementReference === neighbor.measurementReference;
  const ratFor = (raw) => {
    const value = String(raw?.rat ?? raw?.technology ?? raw?.tech ?? "").toUpperCase();
    if (/\b(?:NR|5G|NGRAN)\b/.test(value) || raw?.nrarfcn !== undefined) return "NR";
    if (/\b(?:LTE|4G|EUTRA|E-UTRA)\b/.test(value) || raw?.earfcn !== undefined) return "LTE";
    return null;
  };
  const measured = (raw, serving, rat) => {
    const role = String(raw?.source_kind ?? raw?.sourceKind ?? raw?.role ?? raw?.type ?? "").toUpperCase();
    if (/(?:SECONDARY[_\s-]*SERVING|\bSCELL\b|\bPCELL\b|\bPSCELL\b|\bANCHOR\b)/.test(role)) return null;
    const otherRat = ratFor(raw);
    if (!otherRat) return null;
    const pci = num(raw.pci ?? raw.sc ?? raw.physicalCellId);
    const channel = num(otherRat === "NR" ? raw.nrarfcn ?? raw.ssbNrarfcn ?? raw.freq ?? raw.arfcn :
      raw.earfcn ?? raw.freq ?? raw.arfcn);
    const rsrp = num(raw.ssRsrp ?? raw.csiRsrp ?? raw.rsrp ?? raw.level);
    if (pci === null || channel === null || rsrp === null) return null;
    if (otherRat === rat && pci === num(serving.pci) && channel === num(serving.channel)) return null;
    const band = String(raw.band || "").trim();
    const frequencyKind = frequencyReference(raw, otherRat);
    const carrier = num(raw.nrarfcn ?? raw.carrierArfcn);
    const sharedCarrier = otherRat === "NR" && carrier !== null && carrier === num(serving.carrierArfcn);
    const knownReference = otherRat !== "NR" || frequencyKind !== "UNKNOWN" &&
      serving.frequencyReference !== "UNKNOWN" &&
      (frequencyKind === serving.frequencyReference || sharedCarrier);
    const sameFrequency = otherRat === rat && knownReference &&
      (channel === num(serving.channel) && frequencyKind === serving.frequencyReference || sharedCarrier) &&
      frequencyKind !== "BWP" && serving.frequencyReference !== "BWP";
    const unverifiedFrequency = frequencyKind === "BWP" || serving.frequencyReference === "BWP" ||
      otherRat === "NR" && !knownReference;
    const sameBand = otherRat === rat && !sameFrequency && !unverifiedFrequency && band && serving.band && band.toUpperCase() === String(serving.band).toUpperCase();
    return {
      rat: otherRat, pci, channel, band,
      cellName: String(raw.cellName ?? raw.cell_name ?? raw.name ?? raw.label ?? `${otherRat} PCI ${pci} / ${channel}`),
      rsrp, rsrq: num(raw.rsrq ?? raw.ssRsrq), sinr: num(raw.sinr ?? raw.ssSinr),
      measurementReference: measurementReference(raw, otherRat), frequencyReference: frequencyKind,
      ssbIndex: num(raw.ssbIndex ?? raw.ssb_index ?? raw.beam_index ?? raw.beam),
      bwpId: num(raw.bwpId ?? raw.bwp_id), ssbArfcn: num(raw.ssbNrarfcn),
      carrierArfcn: carrier,
      class: otherRat !== rat ? "inter_rat" : unverifiedFrequency ? "frequency_unverified" :
        sameFrequency ? "intra_frequency" : sameBand ? "same_band_other_channel" : "inter_frequency",
    };
  };
  const observationsAt = (snapshot, rat) => {
    const raw = Array.isArray(snapshot?.point?.parsed?.neighbors) ? snapshot.point.parsed.neighbors : [];
    const byKey = new Map();
    raw.forEach((entry) => {
      const candidate = measured(entry, snapshot, rat);
      if (!candidate) return;
      const key = `${keyOf(candidate)}|${candidate.measurementReference}`;
      const group = byKey.get(key) || [];
      group.push(candidate);
      byKey.set(key, group);
    });
    return [...byKey.values()].map((group) => ({ ...group[group.length - 1],
      rsrp: quantile(group.map((item) => item.rsrp), .5),
      rsrq: quantile(group.map((item) => item.rsrq), .5),
      sinr: quantile(group.map((item) => item.sinr), .5),
    }));
  };
  const runsFor = (observations, threshold, strict, profile, requireAdjacent = true) => {
    const runs = []; let run = [], missing = 0;
    const flush = () => { if (run.length) runs.push(run); run = []; missing = 0; };
    observations.forEach((item) => {
      if (item.state === "NOT_MEASURED") {
        if (!run.length || !(profile.neighborMissingGapSec > 0) || missing >= 1) flush();
        else missing += 1;
        return;
      }
      if (item.state === "SOURCE_CHANGED" || item.delta === null || item.delta === undefined) {
        flush(); return;
      }
      const previous = run[run.length - 1];
      const allowedGapSec = missing ? Math.min(profile.mergeGapSec ?? 3, profile.neighborMissingGapSec) : (profile.mergeGapSec ?? 3);
      const continuous = previous && (!requireAdjacent || item.index === previous.index + 1 + missing) &&
        (item.timeMs - previous.timeMs) / 1000 <= allowedGapSec &&
        distanceM(item, previous) <= (profile.maxGpsJumpM ?? 250) && item.servingKey === previous.servingKey;
      if (!continuous) flush();
      if (strict ? item.delta > threshold : item.delta >= threshold) run.push(item);
      else flush();
      missing = 0;
    });
    flush();
    return runs.map((items) => ({
      samples: items.length, startMs: items[0].timeMs, endMs: items[items.length - 1].timeMs,
      durationSec: Number(((items[items.length - 1].timeMs - items[0].timeMs) / 1000).toFixed(3)),
      distanceM: Number(items.slice(1).reduce((sum, item, index) => sum + distanceM(items[index], item), 0).toFixed(1)),
      deltaP50: quantile(items.map((item) => item.delta), .5),
      lastRawIndex: items[items.length - 1].rawIndex,
    })).sort((a, b) => b.durationSec - a.durationSec || b.samples - a.samples || b.distanceM - a.distanceM);
  };
  const targetStrength = (rsrp, profile) => rsrp === null ? "UNKNOWN" :
    rsrp >= (profile.neighborGoodDbm ?? -90) ? "GOOD" :
      rsrp >= (profile.neighborAcceptableDbm ?? -100) ? "ACCEPTABLE" :
        rsrp >= (profile.neighborWeakDbm ?? -110) ? "WEAK" : "VERY_WEAK";
  const format = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : "N/D";
  const classify = (incident, candidates, raw, profile, traceEndMs) => {
    const sequence = incident.sequence || [];
    const rat = incident.rat;
    const best = candidates.find((candidate) => candidate.eligible && candidate.persistentRuns.length &&
      (candidate.class === "intra_frequency" ? candidate.delta.p50 >= 3 && candidate.referenceComparable :
        candidate.class !== "inter_rat" && candidate.class !== "frequency_unverified" &&
        candidate.strength !== "VERY_WEAK" && candidate.servingRsrp.p50 <= (profile.coverageEntryDbm ?? -105))) || null;
    const same = candidates.filter((item) => item.class === "intra_frequency" && item.observedCount >= (profile.bestNeighborMinSnapshots ?? 3));
    const sameBySource = new Map();
    same.forEach((item) => sameBySource.set(item.sourceKey, (sameBySource.get(item.sourceKey) || 0) + 1));
    const qualityValidated = /SINR|COMBINED|MIXED/.test(String(incident.type || "")) &&
      Number(incident.sinrSampleCount || 0) >= (incident.fastCritical ? 2 : (profile.sinrMinSamples ?? 3));
    const weakDominance = qualityValidated &&
      num(incident.dominance?.weakPct) >= 40;
    const multiCell = weakDominance && [...sameBySource.values()].some((count) => count >= 2) &&
      num(incident.dominance?.significantThreeCellPct) >= 40;
    const startMs = incident.sequence?.[0]?.timeMs ?? -Infinity;
    const endMs = incident.sequence?.at(-1)?.timeMs ?? Infinity;
    traceEndMs = traceEndMs ?? raw.at(-1)?.timeMs ?? endMs;
    const localRaw = raw.filter((item) => item.timeMs >= startMs - 2000 && item.timeMs <= endMs + 10000);
    const changes = localRaw.slice(1).flatMap((item, index) => {
      const previous = localRaw[index];
      return identity(item) && identity(previous) && identity(item) !== identity(previous) &&
        (item.timeMs - previous.timeMs) / 1000 <= (profile.mergeGapSec ?? 3) &&
        distanceM(item, previous) <= (profile.maxGpsJumpM ?? 250)
        ? [{ timeMs: item.timeMs, time: item.time, from: previous.cellName, to: item.cellName,
          fromKey: identity(previous), toKey: identity(item), lat: item.lat, lng: item.lng }] : [];
    });
    const pingPong = changes.slice(1).map((change, index) => ({ first: changes[index], second: change })).find(({ first: prior, second: change }) => {
      if (prior.fromKey !== change.toKey || prior.toKey !== change.fromKey ||
        (change.timeMs - prior.timeMs) / 1000 > (profile.pingPongMaxSec ?? 15) ||
        distanceM(prior, change) > (profile.pingPongMaxDistanceM ?? 150)) return false;
      const route = localRaw.filter((item) => item.timeMs >= prior.timeMs && item.timeMs <= change.timeMs);
      const path = route.slice(1).reduce((sum, item, at) => sum + distanceM(route[at], item), 0);
      return path < 30 || distanceM(route[0], route.at(-1)) >= path * .4; // reject route reversal
    }) || null;
    let type, label, target = best, transition = null;
    if (pingPong) { type = "PING_PONG_CANDIDATE"; label = "Aller-retour serving mesuré"; target = null; }
    else if (best) {
      const matchedTransition = changes.filter((item) => item.fromKey === best.sourceKey && item.toKey === best.key &&
        (/^(?:NR|LTE) PCI /i.test(best.cellName) || /^(?:NR|LTE) PCI /i.test(item.to) || item.to === best.cellName) &&
        distanceM(item, best.lastObservation) <= (profile.maxGpsJumpM ?? 250))
        .map((change) => ({ change, run: (best.persistentRuns || []).find((run) =>
          change.timeMs > run.startMs && change.timeMs >= run.endMs &&
          change.timeMs - run.endMs <= (profile.mergeGapSec ?? 3) * 1000) }))
        .find((item) => item.run);
      const change = matchedTransition?.change || null;
      const persistent = matchedTransition?.run?.startMs ?? best.firstPersistentAdvantageMs;
      const targetLaterObserved = changes.some((item) => item.toKey === best.key &&
        persistent !== null && item.timeMs > persistent);
      const otherServingChange = changes.some((item) => item.fromKey === best.sourceKey &&
        item.toKey !== best.key && persistent !== null && item.timeMs > persistent);
      if (change && best.class === "intra_frequency") {
        const rawBefore = localRaw.filter((item) => item.timeMs < change.timeMs && identity(item) === best.sourceKey).slice(-3);
        const rawAfter = localRaw.filter((item) => item.timeMs >= change.timeMs && identity(item) === best.key).slice(0, 3);
        const path = localRaw.filter((item) => item.timeMs >= persistent && item.timeMs <= change.timeMs);
        transition = {
          ...change, firstPersistentAdvantageMs: persistent,
          delaySec: Number(((change.timeMs - persistent) / 1000).toFixed(3)),
          delayDistanceM: Number(path.slice(1).reduce((sum, item, at) => sum + distanceM(path[at], item), 0).toFixed(1)),
          beforeRsrpP50: quantile(rawBefore.map((item) => item.rsrp), .5),
          afterRsrpP50: quantile(rawAfter.map((item) => item.rsrp), .5),
          beforeSinrP50: quantile(rawBefore.map((item) => item.sinr), .5),
          afterSinrP50: quantile(rawAfter.map((item) => item.sinr), .5),
        };
        const late = ["GOOD", "ACCEPTABLE"].includes(best.strength) &&
          (transition.delaySec >= (profile.mobilityLateMinSec ?? 4) ||
            transition.delayDistanceM >= (profile.mobilityLateMinDistanceM ?? 50));
        type = late && best.strongEvidence ? "PROBABLE_DELAYED_TRANSITION" : "OBSERVED_TRANSITION_WITH_PRIOR_ADVANTAGE";
        label = late && best.strongEvidence ? "Transition probablement tardive vers la voisine mesurée" :
          "Transition observée après un avantage radio de la voisine";
      } else if (best.class !== "intra_frequency") {
        type = "INTER_FREQUENCY_RADIO_ALTERNATIVE"; label = "Alternative radio inter-fréquence mesurée";
      } else if (best.strength === "WEAK" || best.strength === "VERY_WEAK") {
        type = "STRONGER_BUT_STILL_WEAK"; label = "Voisine plus forte, mais couverture cible encore faible";
      } else if (!change && !targetLaterObserved && !otherServingChange && persistent !== null && best.strongEvidence) {
        const later = best.states.filter((row) => row.timeMs > best.lastAdvantageMs);
        const ended = later.some((row) => row.state === "NOT_BETTER");
        const continuing = best.lastState === "BETTER" && best.lastAdvantageMs >= endMs - (profile.mergeGapSec ?? 3) * 1000;
        const followupSec = continuing ? Math.max(0, (best.lastAdvantageMs - persistent) / 1000) : 0;
        type = ended ? "RADIO_OPPORTUNITY_ENDED_WITHOUT_TRANSITION" :
          continuing && followupSec >= (profile.mobilityFailureMinSec ?? 5) ? "TRANSITION_NOT_OBSERVED" : "TRANSITION_OUTCOME_UNKNOWN";
        label = type === "RADIO_OPPORTUNITY_ENDED_WITHOUT_TRANSITION" ? "Avantage radio terminé sans transition" :
          type === "TRANSITION_NOT_OBSERVED" ? "Transition vers la voisine non observée" : "Issue de la transition inconnue";
      } else { type = "BETTER_RADIO_ALTERNATIVE"; label = "Alternative radio mesurée"; }
    } else if (multiCell) { type = "SUSPECTED_MULTI_CELL_INTERFERENCE"; label = "Recouvrement multi-cellules suspecté"; }
    else if (weakDominance) { type = "LOW_DOMINANCE"; label = "Faible dominance serving"; }
    else if (!candidates.length) { type = "MOBILITY_NOT_VERIFIABLE"; label = "Mobilité non vérifiable : voisines absentes"; }
    else { type = "NO_CREDIBLE_MEASURED_ALTERNATIVE"; label = "Aucune alternative mesurée suffisamment crédible"; }
    const serving = pingPong?.first?.from || best?.sourceCell || incident.dominantServing?.cellName ||
      incident.representative?.cellName || "serving non résolu";
    const facts = [
      `${incident.rat} ${serving} : ${incident.sequence?.length || 0} snapshots canoniques dans la zone.`,
      pingPong ? `Aller-retour serving brut ${pingPong.first.from} → ${pingPong.first.to} → ${pingPong.second.to} sur une trajectoire sans demi-tour GPS détecté.` :
        best ? `${best.cellName} (${best.class}) : ${best.comparableCount} comparaisons, présence dégradée ${format(best.degradedPresencePct)} %, RSRP P50 ${format(best.rsrp.p50)} dBm, ΔRSRP P50 ${format(best.delta.p50)} dB ; avantage continu ${format(best.longestBetter.durationSec)} s / ${format(best.longestBetter.distanceM, 0)} m.` :
        `${candidates.length} voisine(s) mesurée(s), aucune candidate répondant aux critères d'avantage et de continuité.`,
      transition ? `Changement serving brut ${transition.from} → ${transition.to} à ${transition.time} ; ${format(transition.delaySec, 3)} s / ${format(transition.delayDistanceM, 0)} m après le premier avantage persistant.` : null,
      weakDominance ? `Dominance serving P50 ${format(incident.dominance?.p50)} dB ; faible dominance sur ${format(incident.dominance?.weakPct)} % des comparaisons.` : null,
      multiCell ? `Au moins trois cellules co-fréquence significatives sur ${format(incident.dominance?.significantThreeCellPct)} % des snapshots.` : null,
    ].filter(Boolean);
    const hypothesis = type === "PROBABLE_DELAYED_TRANSITION"
      ? `Sur ${rat === "NR" ? "NR-ARFCN" : "EARFCN"} ${best.channel}, ${best.cellName} reste meilleure que ${serving} : ` +
        `ΔRSRP apparié P50 ${format(best.delta.p50)} dB, P25 ${format(best.delta.p25)} dB, ` +
        `avantage continu ${format(best.longestBetter.durationSec)} s / ${format(best.longestBetter.distanceM, 0)} m. ` +
        `La transition ${transition.from} → ${transition.to} survient ${format(transition.delaySec)} s / ` +
        `${format(transition.delayDistanceM, 0)} m après le premier avantage persistant. ` +
        `Une transition probablement tardive est compatible avec cette chronologie RF ; le DT ne démontre pas que l'événement A3/A5 configuré était satisfait.`
      : type === "OBSERVED_TRANSITION_WITH_PRIOR_ADVANTAGE"
        ? `La transition ${transition.from} → ${transition.to} suit un avantage radio mesuré, mais le délai observé ne suffit pas à la qualifier de tardive.`
      : type === "RADIO_OPPORTUNITY_ENDED_WITHOUT_TRANSITION"
        ? `L'avantage de ${best.cellName} a disparu avant tout changement serving observé ; aucun défaut de mobilité ne peut être déduit.`
      : type === "INTER_FREQUENCY_RADIO_ALTERNATIVE"
        ? `${best.cellName} présente un niveau radio alternatif persistant sur une autre fréquence. Les critères A5, priorités et offsets ne sont pas disponibles ; aucun retard de transition n'est déduit.`
      : type === "TRANSITION_NOT_OBSERVED"
        ? `La voisine ${best.cellName} reste durablement meilleure sans transition observée vers elle. Aucune tentative ou défaillance HO ne peut être déduite des seules mesures RF.`
        : type === "TRANSITION_OUTCOME_UNKNOWN" ? `La trace se termine trop tôt pour déterminer l'issue de la mobilité vers ${best.cellName}.`
          : type === "STRONGER_BUT_STILL_WEAK"
            ? `La voisine ${best.cellName} est durablement supérieure à ${serving}, mais son RSRP P50 de ${format(best.rsrp.p50)} dBm reste faible ; le gain radio ne garantit pas une couverture suffisante.`
            : type === "BETTER_RADIO_ALTERNATIVE"
              ? `Une alternative radio ${best.class} crédible est mesurée sur ${best.cellName}, supérieure à ${serving} de ${format(best.delta.p50)} dB en médiane. Cette observation ne prouve pas qu'un événement HO a été déclenché.`
              : type === "SUSPECTED_MULTI_CELL_INTERFERENCE"
                ? "Le recouvrement de plusieurs cellules co-fréquence avec faible dominance et SINR dégradé suggère une interférence ; scanner et KPI sont requis pour identifier le mécanisme."
                : type === "LOW_DOMINANCE"
                  ? "La dominance serving est faible dans cette zone de SINR dégradé ; le rôle du voisinage et de la charge reste à vérifier."
                  : type === "NO_CREDIBLE_MEASURED_ALTERNATIVE"
                    ? "Aucune voisine mesurée ne présente un avantage radio suffisamment continu pour soutenir une RCA mobilité."
                    : type === "MOBILITY_NOT_VERIFIABLE"
                      ? "Le fichier ne contient pas de voisine exploitable pour qualifier la mobilité dans cette zone."
                      : "Un aller-retour serving est observé ; le mécanisme ping-pong reste à confirmer par la signalisation et le contexte de trajet.";
    const verification = type === "SUSPECTED_MULTI_CELL_INTERFERENCE" || type === "LOW_DOMINANCE"
      ? ["Vérifier la dominance par cellule et les mesures scanner/FFT sur la fenêtre exacte.",
        "Contrôler charge, PCI, azimuts et tilts ; confirmer la cause avec les KPI réseau avant modification."]
      : type === "INTER_FREQUENCY_RADIO_ALTERNATIVE"
        ? ["Vérifier priorités inter-fréquences, Measurement Reports, événement A5 applicable, offsets et relation de voisinage.",
          "Examiner la signalisation RRC et les compteurs avant toute modification de mobilité."]
        : ["Vérifier Measurement Reports, reportConfig/measId, A3/A5 applicable, CIO, offsets, hystérésis, TTT et relation de voisinage.",
          "Examiner résultat de la procédure RRC et les compteurs réseau avant de conclure sur le mécanisme ou un échec de mobilité."];
    const source = sequence.find((item) => identity(item) === (pingPong?.first?.fromKey || best?.sourceKey)) ||
      incident.dominantServing || incident.representative || sequence[0] || {};
    const identityConfidence = (item) => identity(item) ?
      (/^(?:LTE|NR) PCI /i.test(String(item.cellName || "")) ? "medium" : "high") : "low";
    const servingInfo = { name: serving, pci: num(source.pci), channel: num(source.channel), band: source.band || incident.band || "",
      role: rat === "NR" ? "NR PSCell" : "LTE PCell", identityConfidence: identityConfidence(source) };
    const targetInfo = target ? { name: target.cellName, pci: target.pci, channel: target.channel, band: target.band,
      identityConfidence: identityConfidence(target), samples: target.comparableCount, presencePct: target.presencePct,
      presenceDuringDegradationPct: target.degradedPresencePct, rsrpP50: target.rsrp.p50, rsrpP10: target.rsrp.p10 } : null;
    const superiority = target ? {
      deltaRsrpP50: target.delta.p50, deltaRsrpP25: target.delta.p25, deltaRsrpP10: target.delta.p10,
      pctDeltaAbove0: target.advantagePct, pctDeltaAbove3: target.clearPct, pctDeltaAbove6: target.strongPct,
      longestBetterRunSamples: target.longestBetter.samples, longestBetterRunSec: target.longestBetter.durationSec,
      longestBetterRunMeters: target.longestBetter.distanceM, firstBetterTime: target.firstAdvantageMs,
      firstPersistentBetterTime: target.firstPersistentAdvantageMs, lastBetterTime: target.lastAdvantageMs,
    } : null;
    const mobility = { futureServingMatch: !!target?.futureServing, servingChangeObserved: !!transition,
      servingChangeTime: transition?.timeMs ?? null, transitionDelaySec: transition?.delaySec ?? null,
      transitionDelayMeters: transition?.delayDistanceM ?? null,
      postChangeRsrpDelta: transition && transition.beforeRsrpP50 !== null && transition.afterRsrpP50 !== null
        ? transition.afterRsrpP50 - transition.beforeRsrpP50 : null,
      postChangeSinrDelta: transition && transition.beforeSinrP50 !== null && transition.afterSinrP50 !== null
        ? transition.afterSinrP50 - transition.beforeSinrP50 : null,
      postChangeServiceResult: "not_measured" };
    const dominance = { strongestVsSecondP50: incident.dominance?.p50 ?? null,
      cellsWithin3dB: same.filter((item) => item.delta.p50 !== null && item.delta.p50 >= -3).length,
      cellsWithin6dB: same.filter((item) => item.delta.p50 !== null && item.delta.p50 >= -6).length,
      cofrequencyStrongCellCount: incident.dominance?.significantThreeCellPct ?? null };
    const evidenceLevel = type === "PROBABLE_DELAYED_TRANSITION" ? "PROBABLE" :
      type === "OBSERVED_TRANSITION_WITH_PRIOR_ADVANTAGE" ? "OBSERVED" :
      best || pingPong || multiCell || weakDominance ? "POSSIBLE" : "NOT_VERIFIABLE";
    const limitations = ["Aucune signalisation RRC décodée reliée à cette comparaison serving/voisine.",
      "+6 dB indique une forte alternative radio mesurée, pas un déclenchement A3/HO."];
    return { version: VERSION, incidentId: incident.id || null, technology: rat === "NR" ? "5G NR" : "4G LTE",
      rat, band: incident.band || source.band || "", channel: incident.channel ?? source.channel ?? null,
      startTime: incident.startTime || sequence[0]?.time || null, endTime: incident.endTime || sequence.at(-1)?.time || null,
      durationSec: incident.durationSec ?? null, distanceMeters: incident.distanceM ?? null,
      startGps: incident.start || { lat: sequence[0]?.lat, lng: sequence[0]?.lng },
      endGps: incident.end || { lat: sequence.at(-1)?.lat, lng: sequence.at(-1)?.lng },
      type, label, servingCell: serving, targetCell: pingPong?.first?.to || target?.cellName || null, serving: servingInfo,
      targetNeighbor: targetInfo, superiority, mobility, dominance, targetStrength: target?.strength || null,
      secondaryTypes: target && ["WEAK", "VERY_WEAK"].includes(target.strength) ? ["STRONGER_BUT_STILL_WEAK"] : [],
      target, facts, hypothesis, verification, limitations,
      evidenceLevel,
      rca: { type, hypothesis, evidenceLevel,
        measuredFacts: facts, limitations, requiredVerification: verification, recommendedAction: verification.join(" ") },
      transition, changes, topCandidates: candidates.slice(0, 3), candidateCount: candidates.length,
      timeline: { startMs, endMs, traceEndMs, firstAdvantageMs: best?.firstAdvantageMs ?? null,
        firstPersistentAdvantageMs: best?.firstPersistentAdvantageMs ?? null, lastAdvantageMs: best?.lastAdvantageMs ?? null } };
  };
  const analyzeIncident = (incident, rawTimeline, profile = {}) => {
    const sequence = Array.isArray(incident?.sequence) ? incident.sequence : [];
    const rat = incident?.rat;
    if ((rat !== "LTE" && rat !== "NR") || !sequence.length) return null;
    const source = rawTimeline || [];
    const lowerBound = (timeMs) => {
      let left = 0, right = source.length;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (source[middle].timeMs < timeMs) left = middle + 1;
        else right = middle;
      }
      return left;
    };
    const nearbyRaw = source.slice(lowerBound(sequence[0].timeMs - 2000), lowerBound(sequence.at(-1).timeMs + 10001));
    const rawAtTime = new Map();
    nearbyRaw.filter((item) => item?.rat === rat).forEach((item) => {
      const group = rawAtTime.get(item.timeMs) || [];
      group.push(item);
      rawAtTime.set(item.timeMs, group);
    });
    const raw = [...rawAtTime.values()].map((group) => {
      const counts = new Map();
      group.forEach((item) => counts.set(identity(item), (counts.get(identity(item)) || 0) + 1));
      const selected = group.slice().sort((a, b) => counts.get(identity(b)) - counts.get(identity(a)) ||
        b.sourceIndex - a.sourceIndex)[0];
      const sameServing = group.filter((item) => identity(item) === identity(selected));
      return { ...selected, rsrp: quantile(sameServing.map((item) => item.rsrp), .5),
        sinr: quantile(sameServing.map((item) => item.sinr), .5),
        point: { ...selected.point, parsed: { ...(selected.point?.parsed || {}),
          neighbors: sameServing.flatMap((item) => item.point?.parsed?.neighbors || []) } } };
    }).sort((a, b) => a.timeMs - b.timeMs || a.sourceIndex - b.sourceIndex);
    const bucketMs = Math.max(100, num(profile.canonicalBucketMs) ?? 1000);
    const sequenceIndex = new Map(sequence.map((item, index) => [item.bucketKey ?? Math.floor(item.timeMs / bucketMs), index]));
    const grouped = new Map();
    const degradedCount = sequence.filter((item) => item.radioState !== "recovery_bridge").length;
    raw.forEach((snapshot, rawIndex) => {
      const index = sequenceIndex.get(Math.floor(snapshot.timeMs / bucketMs));
      if (index === undefined || identity(snapshot) !== identity(sequence[index])) return;
      observationsAt(snapshot, rat).forEach((neighbor) => {
        const targetKey = keyOf(neighbor), sourceKey = identity(snapshot);
        if (!sourceKey) return;
        const groupKey = `${sourceKey}=>${targetKey}|${neighbor.measurementReference}`;
        const entry = grouped.get(groupKey) || { ...neighbor, key: targetKey, sourceKey,
          sourceCell: snapshot.cellName, sourcePci: snapshot.pci, sourceChannel: snapshot.channel,
          observations: [], seen: new Set() };
        const referenceComparable = neighbor.rat === rat && comparableReference(snapshot, neighbor);
        entry.seen.add(index);
        entry.observations.push({ index, rawIndex, timeMs: snapshot.timeMs, time: snapshot.time,
          lat: snapshot.lat, lng: snapshot.lng, servingKey: sourceKey,
          servingRsrp: num(snapshot.rsrp), servingSinr: num(snapshot.sinr),
          servingMeasurementReference: snapshot.measurementReference || (rat === "NR" ? "UNKNOWN" : "LTE_RSRP"),
          referenceComparable, degraded: sequence[index].radioState !== "recovery_bridge",
          rsrp: neighbor.rsrp, rsrq: neighbor.rsrq,
          delta: referenceComparable && num(snapshot.rsrp) !== null ? neighbor.rsrp - num(snapshot.rsrp) : null });
        grouped.set(groupKey, entry);
      });
    });
    const candidates = [...grouped.values()].map((item) => {
      const comparable = item.observations.filter((row) => row.delta !== null);
      const better = comparable.filter((row) => row.delta > 0);
      const rows = new Map(item.observations.map((row) => [row.rawIndex, row]));
      const states = raw.map((snapshot, rawIndex) => {
        const row = rows.get(rawIndex);
        const inZone = snapshot.timeMs >= sequence[0].timeMs && snapshot.timeMs <= sequence.at(-1).timeMs;
        const sameSource = identity(snapshot) === item.sourceKey;
        const value = row && (item.class === "intra_frequency" ? row.delta :
          item.class === "inter_rat" || item.class === "frequency_unverified" ? null :
            row.rsrp - (profile.neighborWeakDbm ?? -110));
        return { index: rawIndex, rawIndex, timeMs: snapshot.timeMs, time: snapshot.time,
          lat: snapshot.lat, lng: snapshot.lng, rsrp: row?.rsrp ?? null,
          servingKey: identity(snapshot), delta: inZone && sameSource ? value : null,
          state: !inZone || !sameSource ? "SOURCE_CHANGED" : !row ? "NOT_MEASURED" :
            value === null ? "INCOMPARABLE" : value > 0 ? "BETTER" : "NOT_BETTER" };
      });
      const rawRuns = runsFor(states, 0, true, profile);
      const persistentRuns = rawRuns.filter((run) => run.samples >= (profile.bestNeighborMinSnapshots ?? 3) &&
        (run.durationSec >= (profile.mobilityBetterMinSec ?? 2) ||
          run.distanceM >= (profile.mobilityBetterMinDistanceM ?? 50)));
      const persistent = persistentRuns.slice().sort((a, b) => a.startMs - b.startMs)[0] || null;
      const rawClear = runsFor(states, 3, false, profile);
      const rawStrong = runsFor(states, 6, false, profile);
      const presencePct = pct(item.seen.size, sequence.length);
      const degradedPresencePct = pct(new Set(item.observations.filter((row) => row.degraded).map((row) => row.index)).size, degradedCount);
      const eligible = item.seen.size >= (profile.bestNeighborMinSnapshots ?? 3) &&
        presencePct >= (profile.candidateDiscoveryMinPresencePct ?? 20) &&
        item.observations.some((row) => row.degraded) &&
        (item.class === "intra_frequency" ? comparable.length >= (profile.bestNeighborMinSnapshots ?? 3) && better.length >= 2 :
          item.class !== "inter_rat" && item.class !== "frequency_unverified");
      return {
        key: item.key, sourceKey: item.sourceKey, sourceCell: item.sourceCell,
        sourcePci: item.sourcePci, sourceChannel: item.sourceChannel,
        rat: item.rat, pci: item.pci, channel: item.channel, band: item.band, class: item.class,
        lat: item.observations[0]?.lat ?? null, lng: item.observations[0]?.lng ?? null,
        cellName: item.cellName, observedCount: item.seen.size, rawObservedCount: item.observations.length,
        lastObservation: item.observations.at(-1),
        comparableCount: comparable.length, referenceComparable: comparable.length > 0,
        measurementReference: item.measurementReference, frequencyReference: item.frequencyReference,
        ssbIndex: item.ssbIndex, bwpId: item.bwpId, ssbArfcn: item.ssbArfcn, carrierArfcn: item.carrierArfcn,
        presencePct, degradedPresencePct, eligible,
        strongEvidence: eligible && degradedPresencePct >= (profile.strongEvidenceMinPresencePct ?? 50),
        rsrp: stats(item.observations.map((row) => row.rsrp)), servingRsrp: stats(comparable.map((row) => row.servingRsrp)),
        delta: stats(comparable.map((row) => row.delta)), rsrq: stats(item.observations.map((row) => row.rsrq)),
        servingSinr: stats(comparable.map((row) => row.servingSinr)),
        advantagePct: pct(better.length, comparable.length), clearPct: pct(comparable.filter((row) => row.delta >= 3).length, comparable.length),
        strongPct: pct(comparable.filter((row) => row.delta >= 6).length, comparable.length),
        longestBetter: rawRuns[0] || { samples: 0, durationSec: 0, distanceM: 0 },
        longestClear: rawClear[0] || { samples: 0, durationSec: 0, distanceM: 0 },
        longestStrong: rawStrong[0] || { samples: 0, durationSec: 0, distanceM: 0 },
        firstAdvantageMs: states.find((row) => row.state === "BETTER")?.timeMs ?? null,
        firstPersistentAdvantageMs: persistent?.startMs ?? null,
        persistentRuns, states,
        lastState: states.filter((row) => row.state !== "SOURCE_CHANGED").at(-1)?.state ?? null,
        lastAdvantageMs: states.filter((row) => row.state === "BETTER").at(-1)?.timeMs ?? null,
        futureServing: raw.slice(1).some((snapshot, index) => snapshot.timeMs > sequence[0].timeMs &&
          snapshot.timeMs <= sequence.at(-1).timeMs + 10000 && identity(raw[index]) === item.sourceKey &&
          identity(snapshot) === item.key && distanceM(raw[index], snapshot) <= (profile.maxGpsJumpM ?? 250)),
        strength: targetStrength(stats(item.observations.map((row) => row.rsrp)).p50, profile),
        rankingReason: `Présence dégradée ${format(degradedPresencePct)} %, avantage continu ${format(rawRuns[0]?.durationSec ?? 0)} s, ΔP25 ${format(stats(comparable.map((row) => row.delta)).p25)} dB`,
      };
    }).sort((a, b) => {
      const order = { intra_frequency: 0, same_band_other_channel: 1, inter_frequency: 2,
        frequency_unverified: 3, inter_rat: 4 };
      return Number(b.eligible) - Number(a.eligible) || (order[a.class] - order[b.class]) ||
        b.degradedPresencePct - a.degradedPresencePct || b.longestBetter.durationSec - a.longestBetter.durationSec ||
        b.longestBetter.distanceM - a.longestBetter.distanceM || (b.delta.p25 ?? -Infinity) - (a.delta.p25 ?? -Infinity) ||
        (b.delta.p50 ?? -Infinity) - (a.delta.p50 ?? -Infinity) || b.advantagePct - a.advantagePct;
    });
    return classify(incident, candidates, raw, profile, source.at(-1)?.timeMs);
  };
  return { VERSION, analyzeIncident, observationsAt, runsFor };
});
