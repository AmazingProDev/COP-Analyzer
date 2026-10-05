/* Correlate independent RF, mobility, continuity and MOS symptoms. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadioRcaEngine = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";
  const timeMs = (value) => {
    const match = String(value || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
    if (match) return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6], +(match[7] || "0").padEnd(3, "0"));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const interval = (incident) => ({
    start: Number.isFinite(incident.startTimeMs) ? incident.startTimeMs : timeMs(incident.startTime),
    end: Number.isFinite(incident.endTimeMs) ? incident.endTimeMs : timeMs(incident.endTime),
  });
  const overlap = (target, source, lagSec = 3) => {
    const a = interval(target), b = interval(source);
    if (![a.start, a.end, b.start, b.end].every(Number.isFinite)) return 0;
    const numerator = Math.max(0, Math.min(a.end, b.end + lagSec * 1000) - Math.max(a.start, b.start - lagSec * 1000));
    return Math.min(1, numerator / Math.max(1000, a.end - a.start));
  };
  const mobilityOverlap = (mos, events) => {
    const a = interval(mos);
    if (![a.start, a.end].every(Number.isFinite)) return 0;
    return Math.max(0, ...(events || []).map((event) => {
      const at = Number.isFinite(event.timeMs) ? event.timeMs : timeMs(event.time);
      if (!Number.isFinite(at)) return 0;
      return Math.min(1, Math.max(0, Math.min(a.end, at + 5000) - Math.max(a.start, at - 3000)) /
        Math.max(1000, a.end - a.start));
    }));
  };
  const radioCategory = (incident) => incident.type === "NR_AVAILABILITY_LOSS" ? "NR_AVAILABILITY"
    : incident.type === "MOBILITY_ANOMALY" ? "MOBILITY"
    : incident.type === "COVERAGE_DEGRADATION" ? "COVERAGE"
      : incident.type === "SINR_DEGRADATION" ? "QUALITY" : "COVERAGE_QUALITY";
  const strongest = (incident, radioIncidents, events, lagSec, symptomTracks = null) => {
    const relevant = radioIncidents.filter((candidate) => !candidate.stationary);
    const forType = (predicate) => Math.max(0, ...relevant.filter(predicate).map((candidate) => overlap(incident, candidate, lagSec)));
    const trackOverlap = (track) => Math.max(0, ...(track || []).map((item) => overlap(incident, item, lagSec)));
    const coverageOverlap = symptomTracks ? trackOverlap(symptomTracks.coverage)
      : forType((item) => item.type !== "NR_AVAILABILITY_LOSS" && item.coverageSampleCount > 0);
    const qualityOverlap = symptomTracks ? trackOverlap(symptomTracks.quality)
      : forType((item) => item.type !== "NR_AVAILABILITY_LOSS" && item.sinrSampleCount > 0);
    const nrLossOverlap = forType((item) => item.type === "NR_AVAILABILITY_LOSS");
    const mobilityScore = mobilityOverlap(incident, events);
    const values = { coverageOverlap, qualityOverlap, mobilityOverlap: mobilityScore, nrLossOverlap };
    return { ...values, bestOverlap: Math.max(...Object.values(values)) };
  };
  const serviceEvidence = (incident) => {
    const metrics = incident.serviceMetrics || {};
    const measured = [];
    if (Number.isFinite(metrics.packetLoss)) measured.push(`Packet loss P50 ${metrics.packetLoss} %, P95 ${metrics.packetLossStats?.p95 ?? "N/D"} %`);
    if (Number.isFinite(metrics.jitter)) measured.push(`Jitter P50 ${metrics.jitter} ms, P95 ${metrics.jitterStats?.p95 ?? "N/D"} ms`);
    if (Number.isFinite(metrics.rtt)) measured.push(`RTT P50 ${metrics.rtt} ms, P95 ${metrics.rttStats?.p95 ?? "N/D"} ms`);
    if (Object.keys(metrics.codecDistribution || {}).length) measured.push(`Codec ${Object.keys(metrics.codecDistribution).join(", ")}`);
    if (Object.keys(metrics.qciDistribution || {}).length) measured.push(`QCI ${Object.keys(metrics.qciDistribution).join(", ")}`);
    if (Object.keys(metrics.fiveQiDistribution || {}).length) measured.push(`5QI ${Object.keys(metrics.fiveQiDistribution).join(", ")}`);
    if (metrics.callStateCoveragePct) measured.push(`Call state renseigné sur ${metrics.callStateCoveragePct} % des points`);
    return measured;
  };
  const median = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  };
  const distanceM = (a, b) => {
    if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) return Infinity;
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  const mobilityImpact = (incident, snapshots, events) => {
    const event = (events || []).filter((item) => item.timeMs >= incident.startTimeMs - 5000 &&
      item.timeMs <= incident.endTimeMs + 5000).sort((a, b) => Math.abs(a.timeMs - incident.startTimeMs) -
        Math.abs(b.timeMs - incident.startTimeMs))[0];
    if (!event) return null;
    const rows = snapshots || [];
    const around = (from, to) => median(rows.filter((item) => item.timeMs >= event.timeMs + from &&
      item.timeMs < event.timeMs + to).map((item) => item.mos));
    const preMos = around(-5000, -1000), transitionMos = around(-1000, 2000), postMos = around(2000, 7000);
    return { eventTimeMs: event.timeMs, fromCell: event.fromCell, toCell: event.toCell,
      preMos, transitionMos, postMos,
      deltaDuring: preMos !== null && transitionMos !== null ? Number((transitionMos - preMos).toFixed(2)) : null,
      recoveryAfter: postMos !== null && transitionMos !== null ? Number((postMos - transitionMos).toFixed(2)) : null };
  };
  const directionalEvidence = (incident, radio, lagSec) => {
    const lag = lagSec * 1000;
    const matching = radio.filter((item) => overlap(incident, item, lagSec) >= .5 &&
      item.startTimeMs < incident.startTimeMs - 500 && incident.startTimeMs - item.startTimeMs <= lag &&
      item.endTimeMs < incident.endTimeMs - 500 && incident.endTimeMs - item.endTimeMs <= lag &&
      distanceM(incident.start, item.start) <= 250);
    const matched = matching.sort((a, b) => overlap(incident, b, lagSec) - overlap(incident, a, lagSec))[0];
    return matched ? { observed: true, radioIncidentId: matched.id,
      onsetLagSec: Number(((incident.startTimeMs - matched.startTimeMs) / 1000).toFixed(2)),
      recoveryLagSec: Number(((incident.endTimeMs - matched.endTimeMs) / 1000).toFixed(2)),
      spatiallyAligned: true, severeRadio: Number(matched.criticalSnapshotPct || 0) >= 20 ||
        Number.isFinite(matched.metrics?.sinr?.p10) && matched.metrics.sinr.p10 <= -3 ||
        Number.isFinite(matched.metrics?.rsrp?.p10) && matched.metrics.rsrp.p10 <= -115 } : { observed: false };
  };
  const classifyMos = (incident, profile = {}) => {
    const correlation = incident.correlation || {};
    const pairs = [
      ["nrLossOverlap", "MOS_NR_CONTINUITY", "MOS corrélé à une perte de continuité 5G"],
      ["mobilityOverlap", "MOS_MOBILITY", "MOS corrélé temporellement à une transition serving"],
      ["qualityOverlap", "MOS_RADIO_QUALITY", "MOS corrélé à une baisse de qualité radio"],
      ["coverageOverlap", "MOS_RADIO_COVERAGE", "MOS corrélé à une baisse de couverture"],
    ].sort((a, b) => (correlation[b[0]] || 0) - (correlation[a[0]] || 0));
    const overlapValue = correlation[pairs[0][0]] || 0;
    const service = incident.serviceMetrics || {};
    const abnormalService = (service.degradedMosPacketLossStats?.p50 ?? service.packetLoss) >
      (profile.servicePacketLossPct ?? 2) ||
      (service.degradedMosJitterStats?.p50 ?? service.jitter) > (profile.serviceJitterMs ?? 30) ||
      (service.degradedMosRttStats?.p50 ?? service.rtt) > (profile.serviceRttMs ?? 200);
    const impact = incident.mobilityImpact;
    const mobilityDip = Number.isFinite(impact?.deltaDuring) && impact.deltaDuring <= -.5 &&
      Number.isFinite(impact?.recoveryAfter) && impact.recoveryAfter >= .5;
    if (overlapValue >= .5) {
      const directional = pairs[0][0] === "mobilityOverlap" ? mobilityDip : incident.directionalRfEvidence?.observed;
      if (abnormalService && !directional) return { category: "SERVICE_QUALITY",
        name: "KPI service dégradés pendant la baisse MOS ; contribution radio à vérifier", level: "PROBABLE" };
      const level = directional && !abnormalService ? overlapValue >= .8 && mobilityDip &&
        incident.directionalRfEvidence?.observed && incident.directionalRfEvidence?.severeRadio
        ? "STRONGLY_SUPPORTED" : "PROBABLE" : "POSSIBLE";
      return { category: pairs[0][1], name: pairs[0][2], level };
    }
    if (abnormalService) return { category: "SERVICE_QUALITY", name: "Dégradation QoE associée à des KPI service anormaux", level: "PROBABLE" };
    return { category: "MOS", name: "Cause radio non démontrée par le DT", level: "NOT_VERIFIABLE" };
  };
  const verificationFor = (category) => {
    if (category === "SERVICE_QUALITY")
      return ["Vérifier session DL active, serveur de test, TCP, packet loss, latence, charge cellule et débit radio mesuré."];
    if (/MOS/.test(category) && !/MOS_RADIO|MOS_MOBILITY|MOS_NR/.test(category))
      return ["Vérifier packet loss, jitter, latence, codec, RTP, QCI/5QI et chaîne de service."];
    if (/QUALITY|LOW_DOMINANCE/.test(category))
      return ["Vérifier scanner/FFT, voisins co-fréquence, dominance et KPI réseau d'interférence."];
    if (/COVERAGE/.test(category))
      return ["Vérifier disponibilité de couche, azimut, tilt, puissance et couverture des secteurs voisins."];
    if (/MOBILITY|NR_AVAILABILITY|NR_CONTINUITY/.test(category))
      return ["Vérifier relations, seuils, temporisations et signalisation RRC autour des transitions mesurées."];
    return ["Vérifier les mesures complémentaires et compteurs réseau avant modification radio."];
  };
  const apply = (analysis, options = {}) => {
    if (!analysis) return analysis;
    const incidents = analysis.incidents || [];
    const radio = incidents.filter((item) => item.rat === "LTE" || item.rat === "NR");
    const mos = incidents.filter((item) => item.type === "MOS_DEGRADATION");
    const throughput = incidents.filter((item) => item.type === "THROUGHPUT_DEGRADATION");
    const lagSec = Number(options.mosCorrelationWindowSec ?? analysis.profiles?.mos?.correlationWindowSec ?? 3);
    mos.forEach((incident) => {
      incident.correlation = strongest(incident, radio, analysis.mobilityEvents, lagSec, analysis.symptomTracks);
      incident.mobilityImpact = mobilityImpact(incident, analysis.mosSnapshots, analysis.mobilityEvents);
      incident.directionalRfEvidence = directionalEvidence(incident, radio, lagSec);
    });
    throughput.forEach((incident) => {
      const bestOverlap = Math.max(0, ...radio.map((candidate) => overlap(incident, candidate, lagSec)));
      incident.correlation = { bestOverlap };
    });
    radio.forEach((incident) => {
      const matchedMos = mos.map((item) => ({ item, overlap: overlap(incident, item, lagSec) }))
        .sort((a, b) => b.overlap - a.overlap)[0];
      incident.correlation = { bestOverlap: matchedMos?.overlap || 0,
        mosIncidentId: matchedMos?.overlap >= .5 ? matchedMos.item.id : null };
      if (matchedMos?.overlap >= .5) incident.mos = {
        median: matchedMos.item.mos?.median ?? null,
        p10: matchedMos.item.mos?.p10 ?? null,
        degradedShare: matchedMos.item.mos?.degradedShare ?? null,
        classification: matchedMos.item.mos?.classification || null,
        correlatedIncidentId: matchedMos.item.id,
      };
      else if (incident.mos?.correlatedIncidentId) delete incident.mos;
    });
    incidents.forEach((incident) => {
      const neighborMobility = incident.neighborMobilityRca || null;
      const isMos = incident.type === "MOS_DEGRADATION";
      const isThroughput = incident.type === "THROUGHPUT_DEGRADATION";
      const isService = isMos || isThroughput;
      if (!isService && neighborMobility) {
        // This is the sole RCA fusion point. The detector retains the RF
        // symptom; measured-neighbour evidence can replace its headline.
        const symptom = incident.rfSymptomRca || incident.primaryRca;
        incident.rfSymptomRca = symptom;
        const supported = ["BETTER_RADIO_ALTERNATIVE", "PROBABLE_DELAYED_TRANSITION",
          "OBSERVED_TRANSITION_WITH_PRIOR_ADVANTAGE", "TRANSITION_NOT_OBSERVED",
          "TRANSITION_OUTCOME_UNKNOWN", "RADIO_OPPORTUNITY_ENDED_WITHOUT_TRANSITION",
          "PING_PONG_CANDIDATE", "STRONGER_BUT_STILL_WEAK", "SUSPECTED_MULTI_CELL_INTERFERENCE",
          "LOW_DOMINANCE", "INTER_FREQUENCY_RADIO_ALTERNATIVE"];
        incident.primaryRca = supported.includes(neighborMobility.type) ? {
          ...symptom, code: neighborMobility.type, label: neighborMobility.label,
          evidence: neighborMobility.facts.slice(), recommendation: neighborMobility.verification.join(" "),
          mobilityTransition: neighborMobility.transition ? {
            code: neighborMobility.type, fromCell: neighborMobility.transition.from,
            toCell: neighborMobility.transition.to,
            timeToChangeSec: neighborMobility.transition.delaySec,
            neighborDeltaDb: neighborMobility.target?.delta?.p50,
            sampleCount: neighborMobility.target?.comparableCount, confirmedBySignaling: false,
          } : null,
        } : symptom;
      }
      const scanRca = !isService ? incident.scanOverlap?.rca : null;
      const observed = isThroughput ? [`Débit DL application P50 ${incident.throughput?.median?.toFixed(2) ?? "N/D"} Mbit/s.`] : isMos
        ? [`MOS P50 ${incident.mos?.median?.toFixed(2) ?? "N/D"}, P10 ${incident.mos?.p10?.toFixed(2) ?? "N/D"}, ${incident.sampleCount} snapshots dégradés.`]
        : (incident.primaryRca?.evidence || []).slice();
      const service = isMos ? serviceEvidence(incident) : [];
      observed.push(...service);
      const mosCause = isMos ? classifyMos(incident, analysis.profiles?.mos) : null;
      let category = isMos ? mosCause.category : isThroughput ? "SERVICE_QUALITY" : radioCategory(incident);
      let causeName = isMos ? mosCause.name : isThroughput ? (incident.correlation.bestOverlap >= .5
        ? "Débit dégradé corrélé à un symptôme RF" : "Cause du débit faible non démontrée") : incident.primaryRca?.label || "Cause non déterminée";
      let evidenceLevel = isMos ? mosCause.level : isThroughput ?
        (incident.correlation.bestOverlap >= .5 ? "POSSIBLE" : "NOT_VERIFIABLE") : "POSSIBLE";
      if (!isService && neighborMobility && incident.primaryRca?.code === neighborMobility.type) {
        causeName = neighborMobility.hypothesis;
        evidenceLevel = neighborMobility.evidenceLevel;
        if (/TRANSITION|MOBILITY|PING_PONG|RADIO_ALTERNATIVE|STRONGER_BUT/.test(neighborMobility.type)) category = "MOBILITY";
        observed.push(...neighborMobility.facts.filter((fact) => !observed.includes(fact)));
      }
      if (scanRca) {
        observed.push(...scanRca.facts.filter((fact) => !observed.includes(fact)));
      }
      if (!isService && incident.crossRatCoexistence?.length)
        observed.push(`${incident.crossRatCoexistence.length} portion(s) avec dégradations LTE et NR simultanées au même endroit ; mécanisme commun non démontré.`);
      if (!isService && incident.type === "NR_AVAILABILITY_LOSS") evidenceLevel = "POSSIBLE";
      if (!isService && /LOW_DOMINANCE|SUSPECTED_MULTI_CELL_INTERFERENCE/.test(incident.primaryRca?.code || "")) category = "LOW_DOMINANCE";
      if (!isService && /MOBILITY|PING_PONG|CELL_CHANGE/.test(incident.primaryRca?.code || "")) category = "MOBILITY";
      if (!isService && incident.geometry?.overshooting) category = "OVERSHOOTING_SUSPECTED";
      if (!isService && incident.correlation?.mosIncidentId) category = "MULTI_SYMPTOM";
      const limitations = [];
      if (isMos && incident.correlation.bestOverlap < .5) limitations.push("Aucune dégradation RF simultanée démontrée.");
      if (isThroughput && incident.correlation.bestOverlap < .5) limitations.push("Débit faible observé ; cause RF non démontrée et état de session DL à confirmer.");
      if (isMos && incident.mos?.source === "unknown") limitations.push("Méthode MOS non précisée : seuils à calibrer selon POLQA, PESQ ou estimation applicative.");
      if (!isService && incident.primaryRca?.radioContext?.hasMeasuredNeighbors === false)
        limitations.push(`Voisinage ${incident.rat} non mesuré : interférence, dominance et mobilité non confirmables.`);
      if (incident.type === "NR_AVAILABILITY_LOSS")
        limitations.push("L'absence de PSCell NR ne constitue pas une mesure RSRP/SINR NR pendant l'intervalle LTE-only.");
      if (incident.mobility?.anomalies?.length && !incident.mobility.confirmedBySignaling)
        limitations.push("Transition serving inférée sans signalisation RRC décodée ; mécanisme HO exact non confirmé.");
      if (!isService && neighborMobility && incident.primaryRca?.code === neighborMobility.type)
        limitations.push(...neighborMobility.limitations);
      if (scanRca) limitations.push(...scanRca.limitations);
      if (!isService && incident.crossRatCoexistence?.length)
        limitations.push("La simultanéité LTE/NR ne suffit pas à attribuer une cause commune aux deux couches.");
      if (!isService && incident.correlation?.mosIncidentId)
        observed.push(`MOS corrélé à l'incident ${incident.correlation.mosIncidentId} (${Math.round(incident.correlation.bestOverlap * 100)}% d'overlap temporel).`);
      const symptomText = isThroughput ? "Débit DL application dégradé" : isMos ? `MOS dégradé (${incident.mos?.classification || "QoE"})`
        : incident.type === "NR_AVAILABILITY_LOSS" ? "Perte locale de PSCell NR"
          : incident.type === "MOBILITY_ANOMALY" ? "Changements serving A→B→A mesurés"
          : incident.type === "COVERAGE_DEGRADATION" ? "RSRP serving dégradé"
            : incident.type === "SINR_DEGRADATION" ? "SINR serving dégradé" : "RSRP et SINR serving dégradés";
      const verification = !isService && neighborMobility && incident.primaryRca?.code === neighborMobility.type
        ? neighborMobility.verification.slice() : verificationFor(category);
      if (scanRca) verification.push(...scanRca.verification.filter((item) => !verification.includes(item)));
      incident.analysis = {
        category, symptom: { type: isThroughput ? "THROUGHPUT" : isMos ? "MOS" : radioCategory(incident), name: symptomText,
          severity: incident.scores?.severity ?? null, evidenceLevel: "OBSERVED" },
        cause: { name: causeName, code: isService ? category : incident.primaryRca?.code || "UNCLASSIFIED",
          evidenceLevel, confidence: incident.scores?.confidence ?? null },
        observedEvidence: observed, missingEvidence: limitations, verification,
        rf: isService ? { correlated: incident.correlation.bestOverlap >= .5 } : {
          rsrpP50: incident.metrics?.rsrp?.median ?? null, rsrpP10: incident.metrics?.rsrp?.p10 ?? null,
          sinrP50: incident.metrics?.sinr?.median ?? null, sinrP10: incident.metrics?.sinr?.p10 ?? null },
        mos: isMos ? { affected: true, p50: incident.mos?.median, p10: incident.mos?.p10,
          degradedShare: incident.mos?.degradedShare } : { affected: !!incident.correlation?.mosIncidentId,
          p50: incident.mos?.median ?? null, p10: incident.mos?.p10 ?? null,
          degradedShare: incident.mos?.degradedShare ?? null },
        correlation: incident.correlation, mobilityImpact: isMos ? incident.mobilityImpact : null,
        directionalRfEvidence: isMos ? incident.directionalRfEvidence : null, limitations,
      };
    });
    analysis.executiveV2 = {
      totalZones: incidents.filter((item) => !item.stationary).length,
      radioIncidents: radio.filter((item) => !item.stationary).length,
      mosIncidents: mos.length,
      throughputIncidents: throughput.length,
      mosRadioCorrelated: mos.filter((item) => item.correlation?.bestOverlap >= .5).length,
      mosWithoutRf: mos.filter((item) => item.correlation?.bestOverlap < .5).length,
      criticalRouteKm: Number((radio.filter((item) => !item.stationary && item.severity === "critical")
        .reduce((sum, item) => sum + (item.distanceM || 0), 0) / 1000).toFixed(2)),
    };
    return analysis;
  };
  return { apply, overlap, mobilityOverlap, timeMs };
});
