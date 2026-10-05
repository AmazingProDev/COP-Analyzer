/*
 * Professional presentation layer for LTE/NR radio degradations.
 *
 * Detection remains in radio_degradation_analyzer.js.  This module only
 * converts deterministic incident evidence into explicit facts, a guarded
 * RCA narrative, executive aggregates and export-ready rows.
 */
(function radioProfessionalReportFactory(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadioProfessionalReport = api;
})(typeof window !== "undefined" ? window : globalThis, function makeRadioProfessionalReport(root) {
  "use strict";

  const VERSION = "professional-radio-report-v7";
  const confidenceLevels = root.RadioProfiles?.CONFIDENCE_LEVELS || { VERY_HIGH: 90, HIGH: 80, MEDIUM: 55, LOW: 30 };
  const CONFIG = Object.freeze({
    priority: Object.freeze([
      Object.freeze({ id: "P1", minimum: 80, label: "P1 — critique" }),
      Object.freeze({ id: "P2", minimum: 60, label: "P2 — majeure" }),
      Object.freeze({ id: "P3", minimum: 40, label: "P3 — modérée" }),
      Object.freeze({ id: "P4", minimum: 0, label: "P4 — limitée" }),
    ]),
    confidence: Object.freeze([
      Object.freeze({ id: "very_high", minimum: confidenceLevels.VERY_HIGH, label: "Très élevée" }),
      Object.freeze({ id: "high", minimum: confidenceLevels.HIGH, label: "Élevée" }),
      Object.freeze({ id: "medium", minimum: confidenceLevels.MEDIUM, label: "Moyenne" }),
      Object.freeze({ id: "low", minimum: confidenceLevels.LOW, label: "Faible" }),
      Object.freeze({ id: "very_low", minimum: 0, label: "Très faible" }),
    ]),
  });

  const finite = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const text = (value, fallback = "N/A") => {
    const output = String(value ?? "").trim();
    return output || fallback;
  };
  const n = (value, digits = 1, fallback = "N/A") => {
    const numeric = finite(value);
    return numeric === null ? fallback : numeric.toFixed(digits);
  };
  const pct = (value, digits = 1, fallback = "N/A") => n(value, digits, fallback) + (finite(value) === null ? "" : " %");
  const list = (items) => [...new Set((items || []).filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];
  const servingFor = (incident) => incident?.dominantServing || incident?.previousNrServing || incident?.representative || {};
  const rcaFor = (incident) => incident?.primaryRca || {};
  const isNrLoss = (incident) => incident?.type === "NR_AVAILABILITY_LOSS";
  const hasMeasuredNeighbors = (incident) => rcaFor(incident)?.radioContext?.hasMeasuredNeighbors === true;
  const profileFor = (analysis, incident) => incident?.rat === "NR" ? analysis?.profiles?.nr : analysis?.profiles?.lte;

  const priorityFor = (score) => {
    const numeric = finite(score) ?? 0;
    return CONFIG.priority.find((entry) => numeric >= entry.minimum) || CONFIG.priority[CONFIG.priority.length - 1];
  };
  const confidenceFor = (score) => {
    const numeric = finite(score) ?? 0;
    return CONFIG.confidence.find((entry) => numeric >= entry.minimum) || CONFIG.confidence[CONFIG.confidence.length - 1];
  };
  const getDisplayBand = (incident) => {
    if (incident?.type === "MOS_DEGRADATION") return "QoE / MOS";
    if (incident?.type === "THROUGHPUT_DEGRADATION") return "Data / DL";
    const serving = servingFor(incident);
    const rat = incident?.rat === "NR" ? "NR" : "LTE";
    const channel = incident?.channel ?? serving?.channel;
    const existing = incident?.band || serving?.band;
    if (typeof root.RadioDegradationAnalyzer?.getDisplayBand === "function") {
      return root.RadioDegradationAnalyzer.getDisplayBand(rat, channel, existing);
    }
    return text(existing, channel === null || channel === undefined ? "N/A" : `${rat} ${channel}`);
  };

  const issueFor = (incident, analysis) => {
    if (incident?.type === "MOBILITY_ANOMALY") return {
      id: "mobility", label: "Mobility anomaly", frenchLabel: "Instabilité de cellule serveuse",
      severity: "Dégradation mobilité probable",
    };
    if (incident?.type === "THROUGHPUT_DEGRADATION") return {
      id: "throughput", label: "Application DL Throughput", frenchLabel: "Débit DL dégradé",
      severity: incident?.severity === "critical" ? "Severe Service Condition" : "Dégradation débit",
    };
    if (incident?.type === "MOS_DEGRADATION") return {
      id: "mos", label: "MOS / Service Quality", frenchLabel: "Dégradation MOS",
      severity: incident?.mos?.classification === "critical" ? "Severe Service Condition" : "Dégradation QoE",
    };
    const profile = profileFor(analysis, incident) || {};
    const rsrp = incident?.metrics?.rsrp || {};
    const sinr = incident?.metrics?.sinr || {};
    const legacyType = text(incident?.type, "");
    const hasCoverageCount = Number.isFinite(Number(incident?.coverageSampleCount));
    const hasSinrCount = Number.isFinite(Number(incident?.sinrSampleCount));
    const coverage = hasCoverageCount
      ? Number(incident.coverageSampleCount) > 0
      : /COVERAGE|COMBINED|MIXED/.test(legacyType);
    const quality = hasSinrCount
      ? Number(incident.sinrSampleCount) > 0
      : /SINR|COMBINED|MIXED/.test(legacyType);
    const critical = isNrLoss(incident) || Number(incident?.criticalSnapshotPct || 0) > 0 ||
      (finite(rsrp.min) !== null && finite(rsrp.min) <= finite(profile.coverageCriticalDbm)) ||
      (finite(sinr.min) !== null && finite(sinr.min) <= finite(profile.sinrCriticalDb));
    if (isNrLoss(incident)) {
      return { id: "nr_availability_loss", label: "NR Availability Loss", frenchLabel: "Passage de la 5G vers LTE", severity: "Severe Radio Condition" };
    }
    if (coverage && quality) return { id: "coverage_quality", label: "Coverage + Quality", frenchLabel: "Problème couverture & qualité", severity: critical ? "Severe Radio Condition" : "Dégradation radio" };
    if (coverage) return { id: "coverage", label: "Coverage Issue", frenchLabel: "Problème de couverture", severity: critical ? "Severe Radio Condition" : "Dégradation radio" };
    return { id: "quality", label: "Quality Issue", frenchLabel: "Problème de la Qualité", severity: critical ? "Severe Radio Condition" : "Dégradation radio" };
  };

  const causeFor = (incident, issue) => {
    if (incident?.neighborMobilityRca && rcaFor(incident).code === incident.neighborMobilityRca.type)
      return incident.neighborMobilityRca.hypothesis;
    if (incident?.analysis?.cause?.name) return incident.analysis.cause.name;
    const code = text(rcaFor(incident).code, "");
    const noNeighbors = !hasMeasuredNeighbors(incident);
    if (isNrLoss(incident)) return "Perte locale de disponibilité 5G, confirmée par une séquence NR→LTE-only→NR mesurée.";
    if (code === "PILOT_POLLUTION_PROBABLE") return "Faible dominance / interférence co-fréquence suspectée, à confirmer.";
    if (/^(?:INTRAFREQ|SAME_BAND|INTERFREQ)_MOBILITY_OPPORTUNITY$/.test(code)) return "Alternative de même RAT mesurée plus forte ; impact mobilité à vérifier par la chronologie et la signalisation.";
    if (code === "INTERRAT_MOBILITY_OPPORTUNITY") return "Voisine d'un autre RAT mesurée ; les niveaux RSRP LTE et SS-RSRP NR ne suffisent pas à conclure sur la mobilité.";
    if (code === "WEAK_DOMINANCE") return "Dominance serving insuffisante.";
    if (/WEAK_(?:AVAILABLE_)?COVERAGE|COVERAGE_AND_LOW_SINR/.test(code) || issue.id === "coverage" || issue.id === "coverage_quality") {
      return issue.id === "coverage_quality"
        ? "Couverture insuffisante avec dégradation de qualité radio."
        : "Insuffisance locale de couverture.";
    }
    if (issue.id === "quality" && noNeighbors) return "Dégradation de qualité radio non expliquée par le voisinage mesuré.";
    if (issue.id === "quality") return "Dégradation de qualité radio à investiguer avec les voisins réellement mesurés.";
    return "Cause radio non déterminable avec certitude à partir des mesures disponibles.";
  };

  const limitationFor = (incident, issue) => {
    if (incident?.analysis) return list(incident.analysis.limitations || incident.analysis.missingEvidence);
    const radioContext = rcaFor(incident).radioContext || {};
    const limitations = [];
    if (incident?.stationary) limitations.push("Analyse effectuée en faible mobilité : preuve locale conservée hors classement Drive.");
    if (isNrLoss(incident)) limitations.push("La perte NR décrit l’absence de PSCell ; elle ne constitue pas une mesure RSRP/SINR NR pendant l’intervalle.");
    if (radioContext.hasMeasuredNeighbors === false) {
      limitations.push(`Voisinage ${incident?.rat === "NR" ? "NR" : "LTE"} non mesuré : impossible de confirmer une pollution, une dominance ou une mobilité par voisinage.`);
    } else if (Number(radioContext.recurrentNeighborCount || 0) < 2 && issue.id === "quality") {
      limitations.push("Nombre de voisins récurrents insuffisant pour confirmer une RCA de dominance ou de co-channel overlap.");
    }
    if (issue.id === "quality" && finite(incident?.metrics?.sinr?.median) === null) limitations.push("SINR serving non disponible dans le DT.");
    if (!limitations.length) limitations.push("RCA limitée aux mesures serving, voisinage et contexte BDD réellement disponibles dans ce DT.");
    return list(limitations);
  };

  const actionFor = (incident, issue, limitations) => {
    const code = text(rcaFor(incident).code, "");
    if (isNrLoss(incident)) return "Qualifier la perte de PSCell NR avec signalisation EN-DC et KPI disponibilité avant correction de paramétrage, puis refaire le parcours.";
    if (/PROBABLE_DELAYED_TRANSITION|TRANSITION_NOT_OBSERVED/.test(code)) return "Confirmer d'abord les événements A3/A5, Measurement Reports, offsets, hystérésis et TTT par RRC/KPI ; ajuster la mobilité uniquement après identification du paramètre responsable.";
    if (/LOW_DOMINANCE|SUSPECTED_MULTI_CELL_INTERFERENCE/.test(code)) return "Identifier par scanner et KPI les secteurs responsables du recouvrement, simuler l'action RF puis valider le gain par un nouveau DT avant tout changement de tilt.";
    if (/INTER_FREQUENCY_RADIO_ALTERNATIVE/.test(code)) return "Vérifier priorités inter-fréquences et configuration A5 avant de proposer un ajustement ; comparer la couverture cible sur un nouveau DT.";
    if (/MOBILITY|PING_PONG|TRANSITION/.test(code)) return "Reconstituer la chronologie RRC et les relations de voisinage ; ne modifier la mobilité qu'après confirmation du mécanisme.";
    if (incident?.type === "MOS_DEGRADATION") return "Corréler le MOS aux KPI packet loss, jitter, RTT et codec sur la même fenêtre ; qualifier la contribution RF avant action réseau.";
    if (issue.id === "coverage" || issue.id === "coverage_quality") return "Contrôler disponibilité, couverture de couche, puissance et géométrie des secteurs ; choisir l'action RF après vérification terrain et simulation.";
    if (limitations.some((item) => /Voisinage .* non mesuré/.test(item))) return "Compléter les mesures de voisinage/scanner et rejouer le DT avant toute optimisation radio ciblée.";
    return "Vérifier les KPI et mesures complémentaires sur la fenêtre exacte, définir une correction documentée puis rejouer le DT après action.";
  };

  const windowFor = (incident) => {
    const start = text(incident?.startTime, "");
    const end = text(incident?.endTime, "");
    return start && end ? ` du ${start} au ${end}` : start ? ` à partir du ${start}` : "";
  };
  const extentFor = (incident) => {
    const parts = [];
    if (finite(incident?.durationSec) !== null) parts.push(`${n(incident.durationSec)} s`);
    if (finite(incident?.distanceM) !== null) parts.push(`${Math.round(incident.distanceM)} m`);
    return parts.join(" / ");
  };
  const cellFor = (incident) => {
    const serving = servingFor(incident);
    const details = [];
    if (finite(serving?.pci) !== null) details.push(`PCI ${serving.pci}`);
    const channel = finite(incident?.channel ?? serving?.channel);
    if (channel !== null) details.push(`${incident?.rat === "NR" ? "NR-ARFCN" : "EARFCN"} ${channel}`);
    return `${text(serving?.cellName, "cellule non résolue")}${details.length ? ` (${details.join(" ; ")})` : ""}`;
  };
  const descriptionFor = (incident, issue, displayBand) => {
    const extent = extentFor(incident);
    const scope = extent ? `, sur ${extent}` : "";
    const sampleCount = finite(incident?.sampleCount);
    const total = finite(incident?.canonicalSampleCount);
    const density = finite(incident?.degradedDensityPct);
    const samples = sampleCount === null ? "" : ` ${sampleCount}${total === null ? "" : `/${total}`} snapshots dégradés${density === null ? "" : ` (${pct(density)})`}.`;
    if (incident?.type === "MOBILITY_ANOMALY") return `Aller-retour de cellule serveuse observé${windowFor(incident)} sur ${displayBand}${scope}.${samples} Mécanisme de mobilité à confirmer par RRC.`;
    if (incident?.type === "THROUGHPUT_DEGRADATION") return `Débit DL application dégradé${windowFor(incident)}${scope}.${samples} Débit P50 ${n(incident.throughput?.median, 2)} Mbit/s.`;
    if (incident?.type === "MOS_DEGRADATION") return `Dégradation MOS mesurée${windowFor(incident)}${scope}.${samples} MOS P50 ${n(incident.mos?.median, 2)} ; origine à qualifier.`;
    const techBand = `${incident?.rat === "NR" ? "5G" : "4G"} ${displayBand}`;
    const zone = `${techBand}, serveuse ${cellFor(incident)}${windowFor(incident)}${scope}.`;
    if (isNrLoss(incident)) return `Perte locale de PSCell sur ${techBand}${windowFor(incident)}${scope}.${samples} ` +
      `PSCell avant : ${text(incident.previousNrServing?.cellName, "non résolue")} ; ` +
      `PSCell après : ${text(incident.nextNrServing?.cellName, "non résolue")}. ` +
      `Intervalle LTE seule mesuré.`;
    const symptom = issue.id === "coverage" ? "Couverture RSRP dégradée" : issue.id === "quality" ? "Qualité SINR dégradée" : "Couverture RSRP et qualité SINR dégradées";
    const rf = `${finite(incident?.metrics?.rsrp?.median) === null ? "" : ` RSRP P50 ${n(incident.metrics.rsrp.median)} dBm.`}` +
      `${finite(incident?.metrics?.sinr?.median) === null ? "" : ` SINR P50 ${n(incident.metrics.sinr.median)} dB.`}`;
    return `${symptom} sur ${zone}${samples}${rf}`;
  };

  const dtAnalysisFor = (incident, issue, profile = {}) => {
    if (incident?.type === "THROUGHPUT_DEGRADATION") return `Débit DL application P50 ${n(incident.throughput?.median, 2)} Mbit/s, P10 ${n(incident.throughput?.p10, 2)} Mbit/s ; ${incident.sampleCount} snapshots dégradés. ` +
      `Corrélation temporelle avec un symptôme radio : ${pct((incident.correlation?.bestOverlap || 0) * 100)} ; la cause du débit n'est pas démontrée par cette seule corrélation.`;
    if (incident?.type === "MOS_DEGRADATION") {
      const correlation = incident.correlation || {};
      const service = incident.serviceMetrics || {};
      const observedService = [];
      if (finite(service.packetLoss) !== null) observedService.push(`packet loss P50/P95 ${pct(service.packetLoss)}/${pct(service.packetLossStats?.p95)}`);
      if (finite(service.jitter) !== null) observedService.push(`jitter P50/P95 ${n(service.jitter)}/${n(service.jitterStats?.p95)} ms`);
      if (finite(service.rtt) !== null) observedService.push(`RTT P50/P95 ${n(service.rtt)}/${n(service.rttStats?.p95)} ms`);
      return `MOS P50 ${n(incident.mos?.median, 2)}, P10 ${n(incident.mos?.p10, 2)} ; ${incident.sampleCount} snapshots dégradés sur ${n(incident.durationSec)} s. ` +
        `Overlap temporel couverture ${pct((correlation.coverageOverlap || 0) * 100)}, qualité ${pct((correlation.qualityOverlap || 0) * 100)}, mobilité ${pct((correlation.mobilityOverlap || 0) * 100)}, perte NR ${pct((correlation.nrLossOverlap || 0) * 100)}.` +
        (observedService.length ? ` KPI service sur la fenêtre : ${observedService.join(" ; ")}.` : " KPI service non disponibles : lien causal à confirmer.") +
        (incident.mobilityImpact ? ` MOS avant/pendant/après transition : ${n(incident.mobilityImpact.preMos, 2)}/${n(incident.mobilityImpact.transitionMos, 2)}/${n(incident.mobilityImpact.postMos, 2)}.` : "");
    }
    const rsrp = incident?.metrics?.rsrp || {};
    const sinr = incident?.metrics?.sinr || {};
    const facts = [];
    if (finite(rsrp.median) !== null) facts.push(`RSRP serving P50 = ${n(rsrp.median)} dBm${finite(rsrp.p10) === null ? "" : ` et P10 = ${n(rsrp.p10)} dBm`}.`);
    if (finite(sinr.median) !== null) facts.push(`SINR serving P50 = ${n(sinr.median)} dB${finite(sinr.p10) === null ? "" : ` et P10 = ${n(sinr.p10)} dB`}.`);
    const total = finite(incident?.canonicalSampleCount);
    if (total !== null && total > 0 && !isNrLoss(incident)) {
      const breaches = [];
      if (finite(incident?.coverageSampleCount) !== null && finite(profile?.coverageEntryDbm) !== null)
        breaches.push(`critère RSRP (≤ ${n(profile.coverageEntryDbm, 0)} dBm ou P10 intra-seconde critique) sur ${incident.coverageSampleCount}/${total} snapshots`);
      if (finite(incident?.sinrSampleCount) !== null && finite(profile?.sinrEntryDb) !== null)
        breaches.push(`critère SINR (≤ ${n(profile.sinrEntryDb, 0)} dB ou P10 intra-seconde critique) sur ${incident.sinrSampleCount}/${total} snapshots`);
      if (breaches.length) facts.push(`Seuils de détection : ${breaches.join(" ; ")}.`);
    }
    if (finite(incident?.degradedDensityPct) !== null) facts.push(`La dégradation est présente sur ${pct(incident.degradedDensityPct)} des snapshots canoniques.`);
    const extent = [];
    if (finite(incident?.durationSec) !== null) extent.push(`${n(incident.durationSec)} s`);
    if (finite(incident?.distanceM) !== null) extent.push(`${Math.round(incident.distanceM)} m`);
    if (extent.length) facts.push(`Étendue mesurée : ${extent.join(" / ")}.`);
    if (Number(incident?.criticalSnapshotPct || 0) > 0) facts.push(`${pct(incident.criticalSnapshotPct)} des snapshots atteignent au moins un seuil critique${finite(profile?.coverageCriticalDbm) !== null && finite(profile?.sinrCriticalDb) !== null ? ` (RSRP ≤ ${n(profile.coverageCriticalDbm, 0)} dBm ou SINR ≤ ${n(profile.sinrCriticalDb, 0)} dB)` : ""}.`);
    const neighborMobility = incident?.neighborMobilityRca;
    if (neighborMobility?.target) {
      const target = neighborMobility.target;
      facts.push(`Paire serveuse ${text(target.sourceCell, cellFor(incident))} → voisine mesurée ${text(target.cellName)} (${target.class}) : ${target.comparableCount} comparaisons, ` +
        `présence en zone dégradée ${pct(target.degradedPresencePct)}, RSRP P50 ${n(target.rsrp?.p50)} dBm, ` +
        `serving correspondant ${n(target.servingRsrp?.p50)} dBm. ` +
        (target.class === "intra_frequency" ? `ΔRSRP apparié P50/P25/P10 ${n(target.delta?.p50)}/${n(target.delta?.p25)}/${n(target.delta?.p10)} dB. ` :
          "Fréquence distincte : niveau absolu cible retenu ; paramètres A5 et priorités à vérifier. ") +
        `Avantage continu ${n(target.longestBetter?.durationSec)} s / ${n(target.longestBetter?.distanceM, 0)} m ; ` +
        (target.class === "intra_frequency" ? `Δ≥3 dB ${pct(target.clearPct)}, Δ≥6 dB ${pct(target.strongPct)}.` : ""));
      if (neighborMobility.targetStrength) {
        const strength = { GOOD: "bonne", ACCEPTABLE: "acceptable", WEAK: "faible", VERY_WEAK: "très faible" }[neighborMobility.targetStrength] || neighborMobility.targetStrength;
        facts.push(`Couverture absolue de la voisine : ${strength} ; un avantage relatif ne garantit pas une couverture cible suffisante.`);
      }
      if (neighborMobility.transition) {
        const transition = neighborMobility.transition;
        const beforeAfter = [];
        if (finite(transition.beforeRsrpP50) !== null && finite(transition.afterRsrpP50) !== null)
          beforeAfter.push(`RSRP P50 avant/après ${n(transition.beforeRsrpP50)}/${n(transition.afterRsrpP50)} dBm`);
        if (finite(transition.beforeSinrP50) !== null && finite(transition.afterSinrP50) !== null)
          beforeAfter.push(`SINR P50 avant/après ${n(transition.beforeSinrP50)}/${n(transition.afterSinrP50)} dB`);
        facts.push(`Changement serving brut ${text(transition.from)} → ${text(transition.to)} après ` +
          `${n(transition.delaySec, 3)} s / ${n(transition.delayDistanceM, 0)} m depuis le premier avantage persistant` +
          `${beforeAfter.length ? ` ; ${beforeAfter.join(" ; ")}` : ""}.`);
      }
    }
    if (neighborMobility && !neighborMobility.target && neighborMobility.type === "MOBILITY_NOT_VERIFIABLE")
      facts.push(`Aucune voisine ${incident.rat} exploitable mesurée dans la zone : la RCA mobilité n'est pas vérifiable.`);
    if (incident.rat === "NR" && neighborMobility?.topCandidates?.some((item) => item.observedCount && !item.referenceComparable))
      facts.push("Références NR SS-RSRP/CSI-RSRP non comparables pour certaines voisines ; Δ mobilité non calculé.");
    if (incident?.scanOverlap?.best) facts.push(...incident.scanOverlap.rca.facts);
    if (incident?.crossRatCoexistence?.length)
      facts.push(`${incident.crossRatCoexistence.length} zone(s) LTE/NR coexistent en temps et position ; les deux couches sont analysées séparément.`);
    const dominance = incident?.dominance;
    if (finite(dominance?.p50) !== null && (issue.id === "quality" || issue.id === "coverage_quality"))
      facts.push(`Dominance serving P50 ${n(dominance.p50)} dB ; faible dominance sur ${pct(dominance.weakPct)} des comparaisons${finite(dominance.significantThreeCellPct) === null ? "" : ` ; ≥3 cellules co-fréquence significatives sur ${pct(dominance.significantThreeCellPct)} des snapshots`}.`);
    const anchor = incident?.anchorContext;
    if (incident?.rat === "NR" && anchor?.available && finite(anchor.healthyPct) !== null) {
      const radioFacts = [`Ancre LTE saine sur ${pct(anchor.healthyPct)} des snapshots`];
      if (finite(anchor?.rsrp?.median) !== null) radioFacts.push(`RSRP P50 ${n(anchor.rsrp.median)} dBm`);
      if (finite(anchor?.sinr?.median) !== null) radioFacts.push(`SINR P50 ${n(anchor.sinr.median)} dB`);
      facts.push(`${radioFacts.join(" ; ")}.`);
    }
    if (isNrLoss(incident)) {
      const lossDuration = finite(incident?.nrContinuity?.durationSec ?? incident?.durationSec);
      const lossDistance = finite(incident?.nrContinuity?.distanceM ?? incident?.distanceM);
      facts.push(`La PSCell NR est absente${lossDuration === null ? "" : ` pendant ${n(lossDuration)} s`}` +
        `${lossDistance === null ? "" : ` sur ${Math.round(lossDistance)} m`}, puis revient.`);
    }
    if (incident?.correlation?.mosIncidentId) facts.push(`Un épisode MOS est corrélé temporellement à cette zone (${pct((incident.correlation.bestOverlap || 0) * 100)} d'overlap) ; causalité non démontrée.`);
    return facts.length ? facts.join(" ") : "Mesures serving insuffisantes pour établir une analyse DT chiffrée.";
  };

  const shortDiagnosticFor = (incident, issue, limitations) => {
    const serving = servingFor(incident);
    const isNr = incident?.rat === "NR";
    const techShort = isNr ? "5G" : "4G";
    const pci = serving?.pci ?? incident?.pci ?? null;
    const channel = serving?.channel ?? incident?.channel ?? null;
    const chanLabel = isNr ? "NR-ARFCN" : "EARFCN";
    const ratWord = isNr ? "NR" : "LTE";
    let identity = "";
    if (Number.isFinite(Number(pci)) && Number.isFinite(Number(channel))) identity = ` sur la cellule serving ${ratWord} PCI ${pci} / ${chanLabel} ${channel}`;
    else if (Number.isFinite(Number(pci))) identity = ` sur la cellule serving ${ratWord} PCI ${pci}`;
    const distance = finite(incident?.distanceM);
    const distPart = distance === null ? "" : ` sur environ ${Math.round(distance)} m`;
    let head = "";
    if (issue.id === "quality") head = `Dégradation de qualité ${techShort}${identity}. Le SINR serving est dégradé${distPart}.`;
    else if (issue.id === "coverage") head = `Dégradation de couverture ${techShort}${identity}. Le RSRP serving est dégradé${distPart}.`;
    else if (issue.id === "coverage_quality") head = `Dégradation de couverture & qualité ${techShort}${identity}. Le RSRP et le SINR serving sont dégradés${distPart}.`;
    else if (isNrLoss(incident)) head = `Passage de la 5G vers LTE${identity}${distPart}.`;
    else head = `Dégradation radio ${techShort}${identity}${distPart}.`;
    const neighborMissing = (limitations || []).some((item) => /Voisinage .* non mesuré/.test(item));
    const neighborLine = neighborMissing ? `Voisinage ${ratWord} non mesuré : le fichier ne contient pas la liste de voisinage (vérifier le fichier exporté).` : "";
    return neighborLine ? `${head}\n${neighborLine}` : head;
  };

  const evidenceFor = (incident) => {
    if (incident?.analysis?.observedEvidence) return list(incident.analysis.observedEvidence);
    const rca = rcaFor(incident);
    const evidence = [...(rca.evidence || [])];
    const dominance = incident?.dominance;
    if (finite(dominance?.p50) !== null) evidence.push(`Dominance P50 ${n(dominance.p50)} dB ; <3 dB sur ${pct(dominance.weakPct)} ; voisin meilleur sur ${pct(dominance.neighborBetterPct)}.`);
    if (Number(incident?.servingChanges || 0) > 0) evidence.push(`${incident.servingChanges} changement(s) serving mesuré(s).`);
    return list(evidence);
  };

  const detailedRcaFor = (incident, issue, limitations, confidence, profile = {}) => {
    const neighbor = incident?.neighborMobilityRca;
    const primary = rcaFor(incident);
    const main = causeFor(incident, issue);
    const sections = [
      `Description du problème : ${descriptionFor(incident, issue, getDisplayBand(incident))}`,
      `Analyse DT : ${dtAnalysisFor(incident, issue, profile)}`,
      `Niveau de preuve : ${text(incident?.analysis?.cause?.evidenceLevel, "NOT_VERIFIABLE")} ; ` +
        `qualité des données ${incident?.dataQuality?.score ?? "N/D"}/100 ; confiance RCA ${incident?.confidenceDetail?.score ?? "N/D"}/100.`,
      `Faits mesurés : ${evidenceFor(incident).join(" ") || "preuves radio insuffisantes."}`,
      `Hypothèse principale : ${main}`,
    ];
    if (neighbor && neighbor.hypothesis && neighbor.hypothesis !== main &&
        neighbor.type !== "MOBILITY_NOT_VERIFIABLE")
      sections.push(`Voisinage/mobilité (hypothèse secondaire) : ${neighbor.hypothesis}`);
    if (incident?.scanOverlap?.rca?.hypothesis && incident.scanOverlap.rca.hypothesis !== main)
      sections.push(`Scan Route / recouvrement (hypothèse secondaire) : ${incident.scanOverlap.rca.hypothesis}`);
    if (incident?.dataQuality) sections.push(`Qualité des données : mesures serving ${incident.dataQuality.servingMeasurementCoveragePct} %, ` +
      `voisines ${incident.dataQuality.neighborMeasurementCoveragePct} %, comparaisons ${incident.dataQuality.comparableNeighborSamples}, ` +
      `continuité GPS ${incident.dataQuality.gpsContinuity}, temps ${incident.dataQuality.timeContinuity}, ` +
      `référence NR ${incident.dataQuality.nrMeasurementReference}, RRC ${incident.dataQuality.rrcAvailable ? "oui" : "non"}, ` +
      `scanner ${incident.dataQuality.scannerAvailable ? "oui" : "non"}.`);
    if (limitations.length) sections.push(`Limites : ${limitations.join(" ")}`);
    const verification = (incident?.analysis?.verification || []).join(" ") || actionFor(incident, issue, limitations);
    if (verification) sections.push(`Vérification : ${verification}`);
    sections.push(`Action Optim : ${actionFor(incident, issue, limitations)}`);
    return sections.join("\n");
  };

  const professionalFor = (incident, analysis) => {
    const issue = issueFor(incident, analysis);
    const score = finite(incident?.priority?.score ?? incident?.priorityScore) ?? 0;
    const confidenceScore = finite(incident?.confidenceDetail?.score) ?? 0;
    const limitations = limitationFor(incident, issue);
    const displayBand = getDisplayBand(incident);
    const serving = servingFor(incident);
    const priority = priorityFor(score);
    const confidence = confidenceFor(confidenceScore);
    return {
      id: incident?.id || "",
      technology: incident?.rat === "NR" ? "5G NR" : incident?.rat === "MOS" ? "Service MOS" : incident?.rat === "DATA" ? "Service Data" : "4G LTE",
      rat: incident?.rat || "N/A",
      band: displayBand,
      canonicalBand: text(incident?.band || serving?.band),
      frequency: serving?.channel ?? incident?.channel ?? null,
      servingCell: text(serving?.cellName),
      servingRole: text(serving?.role),
      pci: serving?.pci ?? null,
      startTime: incident?.startTime || "N/A",
      endTime: incident?.endTime || "N/A",
      startLat: incident?.start?.lat ?? incident?.representative?.lat ?? null,
      startLon: incident?.start?.lng ?? incident?.representative?.lng ?? null,
      endLat: incident?.end?.lat ?? null,
      endLon: incident?.end?.lng ?? null,
      snapshotsTotal: incident?.canonicalSampleCount ?? incident?.sampleCount ?? 0,
      snapshotsDegraded: incident?.sampleCount ?? 0,
      degradedRatio: finite(incident?.degradedDensityPct),
      durationS: finite(incident?.durationSec),
      distanceM: finite(incident?.distanceM),
      rsrpP50: finite(incident?.metrics?.rsrp?.median),
      rsrpP10: finite(incident?.metrics?.rsrp?.p10),
      rsrpMin: finite(incident?.metrics?.rsrp?.min),
      sinrP50: finite(incident?.metrics?.sinr?.median),
      sinrP10: finite(incident?.metrics?.sinr?.p10),
      sinrMin: finite(incident?.metrics?.sinr?.min),
      mosP50: finite(incident?.mos?.median),
      mosP10: finite(incident?.mos?.p10),
      mosImpact: incident?.mos?.classification || null,
      throughputP50: finite(incident?.throughput?.median),
      symptom: incident?.analysis?.symptom?.name || issue.frenchLabel,
      evidenceLevel: incident?.analysis?.cause?.evidenceLevel || "NOT_VERIFIABLE",
      verification: (incident?.analysis?.verification || []).join(" "),
      category: incident?.analysis?.category || incident?.category || issue.id,
      severityScore: finite(incident?.scores?.severity),
      persistenceScore: finite(incident?.scores?.persistence),
      userImpactScore: finite(incident?.scores?.userImpact),
      criticalSnapshotRatio: finite(incident?.criticalSnapshotPct),
      servingChanges: Number(incident?.servingChanges || 0),
      mobilitySourceCell: incident?.neighborMobilityRca?.servingCell || rcaFor(incident).mobilityTransition?.fromCell || null,
      mobilityTargetCell: incident?.neighborMobilityRca?.targetCell || rcaFor(incident).mobilityTransition?.toCell || null,
      mobilityDeltaDb: finite(incident?.neighborMobilityRca?.target?.delta?.p50 ?? rcaFor(incident).mobilityTransition?.neighborDeltaDb),
      mobilityDelaySec: finite(incident?.neighborMobilityRca?.transition?.delaySec ?? rcaFor(incident).mobilityTransition?.timeToChangeSec),
      neighborMobilityType: incident?.neighborMobilityRca?.type || null,
      neighborMobilityTop3: (incident?.neighborMobilityRca?.topCandidates || []).map((candidate) =>
        `${candidate.cellName} [${candidate.class}] ΔP50 ${n(candidate.delta?.p50)} dB, présence dégradée ${pct(candidate.degradedPresencePct)}, ${n(candidate.longestBetter?.durationSec)} s`).join(" | "),
      scanOverlapPct: finite(incident?.scanOverlap?.best?.overlapPct),
      scanOverlapSnapshots: finite(incident?.scanOverlap?.best?.degradedSnapshotCount),
      scanOverlapRca: incident?.scanOverlap?.rca?.hypothesis || "",
      issueType: issue.id,
      issueLabel: issue.label,
      issueFrenchLabel: issue.frenchLabel,
      severity: issue.severity,
      mainRca: causeFor(incident, issue),
      rcaCode: text(incident?.analysis?.cause?.code || rcaFor(incident).code),
      rcaConfidence: confidenceScore,
      dataQualityScore: incident?.dataQuality?.score ?? null,
      dataQuality: incident?.dataQuality || null,
      rcaConfidenceLabel: confidence.label,
      rcaConfidenceClass: confidence.id,
      rcaEvidence: evidenceFor(incident),
      limitation: limitations,
      recommendedAction: actionFor(incident, issue, limitations),
      priorityScore: score,
      priorityClass: priority.id,
      priorityLabel: priority.label,
      driveOrStationary: incident?.stationary ? "Preuve locale / faible mobilité" : "Drive",
      description: descriptionFor(incident, issue, displayBand),
      dtAnalysis: dtAnalysisFor(incident, issue, profileFor(analysis, incident)),
      shortDiagnostic: shortDiagnosticFor(incident, issue, limitations),
      rcaDetailed: detailedRcaFor(incident, issue, limitations, confidence, profileFor(analysis, incident)),
      probableCause: causeFor(incident, issue),
      rcaLimited: limitations.length > 0,
    };
  };

  const ordered = (incidents) => (incidents || []).slice().sort((left, right) => {
    const leftPriority = priorityFor(left?.professional?.priorityScore ?? left?.priorityScore).minimum;
    const rightPriority = priorityFor(right?.professional?.priorityScore ?? right?.priorityScore).minimum;
    return rightPriority - leftPriority || (right?.professional?.priorityScore ?? right?.priorityScore ?? 0) - (left?.professional?.priorityScore ?? left?.priorityScore ?? 0);
  });
  const mode = (values, fallback = "N/A") => {
    const counts = new Map();
    (values || []).filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] || fallback;
  };
  const weightedMean = (incidents, pick) => {
    let numerator = 0; let denominator = 0;
    (incidents || []).forEach((incident) => {
      const value = finite(pick(incident));
      const weight = Math.max(1, finite(incident?.professional?.priorityScore) ?? 1);
      if (value === null) return;
      numerator += value * weight; denominator += weight;
    });
    return denominator ? numerator / denominator : null;
  };

  const technologySummary = (incidents, rat) => {
    const rows = (incidents || []).filter((incident) => incident?.rat === rat);
    if (!rows.length) return null;
    const p = rows.map((item) => item.professional);
    const band = mode(p.map((item) => item.band));
    const issue = mode(p.map((item) => item.issueFrenchLabel));
    const rsrp = weightedMean(rows, (item) => item.professional?.rsrpP50);
    const sinr = weightedMean(rows, (item) => item.professional?.sinrP50);
    const anchorRows = rows.filter((item) => finite(item?.anchorContext?.healthyPct) !== null);
    const anchorHealthy = weightedMean(anchorRows, (item) => item.anchorContext?.healthyPct);
    const qualityOnly = p.filter((item) => item.issueType === "quality").length > 0;
    const textParts = [`${rat === "NR" ? "5G NR" : "4G LTE"} — ${rows.length} incident(s) Drive, principalement sur ${band}.`];
    if (issue !== "N/A") textParts.push(`Type dominant : ${issue}.`);
    if (finite(rsrp) !== null || finite(sinr) !== null) textParts.push(`RSRP P50 agrégé ${n(rsrp)} dBm ; SINR P50 agrégé ${n(sinr)} dB.`);
    if (rat === "NR" && qualityOnly && finite(anchorHealthy) !== null) textParts.push(`Ancre LTE saine sur ${pct(anchorHealthy)} des snapshots NR concernés.`);
    return { rat, count: rows.length, band, issue, rsrpP50: rsrp, sinrP50: sinr, anchorHealthyPct: anchorHealthy, text: textParts.join(" ") };
  };

  const executiveFor = (incidents, meta = {}) => {
    const all = incidents || [];
    const drive = ordered(all.filter((item) => !item?.stationary));
    const stationary = ordered(all.filter((item) => item?.stationary));
    const p = drive.map((item) => item.professional);
    const p1 = p.filter((item) => item.priorityClass === "P1").length;
    const p2 = p.filter((item) => item.priorityClass === "P2").length;
    const lte = p.filter((item) => item.rat === "LTE").length;
    const nr = p.filter((item) => item.rat === "NR").length;
    const mos = drive.filter((item) => item.type === "MOS_DEGRADATION");
    const throughputCount = drive.filter((item) => item.type === "THROUGHPUT_DEGRADATION").length;
    const scanMatched = drive.filter((item) => item.scanOverlap?.best).length;
    const crossRatPairs = new Set(drive.flatMap((item) => (item.crossRatCoexistence || [])
      .map((pair) => `${pair.lteIncidentId}|${pair.nrIncidentId}`))).size;
    const mosCorrelated = mos.filter((item) => item.correlation?.bestOverlap >= .5).length;
    const mosWithoutRf = mos.length - mosCorrelated;
    const criticalRouteKm = Number((drive.filter((item) => item.rat !== "MOS" && item.severity === "critical")
      .reduce((sum, item) => sum + (item.distanceM || 0), 0) / 1000).toFixed(2));
    const mostRat = nr > lte ? "5G NR" : lte > nr ? "4G LTE" : (nr ? "4G LTE et 5G NR" : "N/A");
    const mostBand = mode(p.filter((item) => item.rat === "LTE" || item.rat === "NR").map((item) => item.band));
    const dominantIssue = mode(p.map((item) => item.issueFrenchLabel));
    const dominantCause = mode(p.map((item) => item.probableCause));
    const top = drive[0] || null;
    const worstRsrpP10 = p.map((item) => finite(item.rsrpP10)).filter((item) => item !== null).sort((a, b) => a - b)[0] ?? null;
    const worstSinrP10 = p.map((item) => finite(item.sinrP10)).filter((item) => item !== null).sort((a, b) => a - b)[0] ?? null;
    const longestDistance = p.map((item) => finite(item.distanceM)).filter((item) => item !== null).sort((a, b) => b - a)[0] ?? null;
    const confidenceScore = weightedMean(drive, (item) => item.professional?.rcaConfidence);
    const confidence = confidenceFor(confidenceScore);
    const limited = drive.some((item) => item.professional?.limitation?.some((value) => /Voisinage .* non mesuré|insuffisant/.test(value)));
    const actions = list(drive.slice(0, 3).map((item) => item.professional?.recommendedAction));
    const narrative = [];
    narrative.push(`La qualification Drive Test met en évidence ${drive.length} zone(s) exploitables : ${lte + nr} incident(s) radio, ${mos.length} MOS et ${throughputCount} débit DL, dont ${p1 + p2} prioritaires P1/P2.`);
    if (lte + nr) narrative.push(`Les dégradations radio concernent principalement ${mostRat}, avec une concentration sur ${mostBand}.`);
    if (mos.length) narrative.push(`${mosCorrelated} incident(s) MOS corrélé(s) à un symptôme radio ou de mobilité ; ${mosWithoutRf} sans cause RF simultanée démontrée.`);
    if (scanMatched) narrative.push(`${scanMatched} zone(s) dégradée(s) recoupent un recouvrement cofréquence mesuré par Scan Route ; scanner et KPI restent nécessaires pour attribuer la cause.`);
    if (crossRatPairs) narrative.push(`${crossRatPairs} portion(s) comportent des dégradations LTE et NR simultanées ; chaque couche conserve sa RCA propre.`);
    narrative.push(`Distance de route affectée par des incidents radio critiques : ${criticalRouteKm} km.`);
    if (top) {
      narrative.push(`Le problème dominant est de type ${dominantIssue}.`);
      narrative.push(`L’incident le plus prioritaire est observé sur ${top.professional.technology} ${top.professional.band}, serving ${top.professional.servingCell}, sur ${Math.round(top.professional.distanceM || 0)} m et ${pct(top.professional.degradedRatio)} des snapshots dégradés.`);
      narrative.push(`La cause probable dominante est : ${dominantCause} Confiance RCA globale : ${confidence.label}.`);
    }
    if (limited) narrative.push("La RCA reste limitée par l’absence ou l’insuffisance de voisinage mesuré ; aucune conclusion définitive de pollution ou de mobilité ne doit être formulée sans preuve complémentaire.");
    if (actions.length) narrative.push(`Actions prioritaires : ${actions.join(" ")}`);
    const cards = [
      ["Nombre de problème", drive.length], ["LTE", lte], ["5G NR", nr],
      ["Scan Route ∩ RF", scanMatched], ["LTE + NR simultanés", crossRatPairs],
      ["MOS", mos.length], ["MOS corrélés RF", mosCorrelated], ["MOS sans RF", mosWithoutRf], ["Débit DL", throughputCount], ["Route critique", `${criticalRouteKm} km`],
      ["Problème de couverture", p.filter((item) => item.issueType === "coverage").length], ["Problème de la Qualité", p.filter((item) => item.issueType === "quality").length],
      ["Problème couverture & qualité", p.filter((item) => item.issueType === "coverage_quality").length], ["Passage de la 5G vers LTE", p.filter((item) => item.issueType === "nr_availability_loss").length],
      ["Technologie la plus impactée", mostRat],
    ];
    return {
      version: VERSION,
      title: "Executive Summary — Dégradations Radio 4G/5G",
      meta: { date: text(meta?.date, ""), logfile: text(meta?.logfile, ""), testType: text(meta?.testType, ""), plaque: text(meta?.plaque, "") },
      driveCount: drive.length, stationaryCount: stationary.length, p1, p2, lte, nr, mostRat, mostBand,
      dominantIssue, dominantCause, worstRsrpP10, worstSinrP10, longestDistanceM: longestDistance,
      confidenceScore, confidenceLabel: confidence.label, limited, narrative: narrative.join(" "), cards,
      topIncidents: drive.slice(0, 10), technology: [technologySummary(drive, "NR"), technologySummary(drive, "LTE")].filter(Boolean),
      recommendedActions: actions,
    };
  };

  const apply = (analysis, meta = {}) => {
    if (!analysis || !Array.isArray(analysis.incidents)) return analysis;
    analysis.incidents.forEach((incident) => { incident.professional = professionalFor(incident, analysis); });
    analysis.professionalReport = executiveFor(analysis.incidents, meta);
    return analysis;
  };

  const rowFor = (incident) => {
    const p = incident?.professional || {};
    return {
      ID: p.id, Priorité: p.priorityClass, "Score priorité": p.priorityScore, Technologie: p.technology, Bande: p.band,
      Serving: p.servingCell, PCI: p.pci ?? "", Fréquence: p.frequency ?? "", "Type problème": p.issueLabel,
      Sévérité: p.severity, Début: p.startTime, Fin: p.endTime, "Durée (s)": p.durationS ?? "", "Distance (m)": p.distanceM ?? "",
      "Snapshots dégradés": p.snapshotsDegraded, "Snapshots canoniques": p.snapshotsTotal, "% dégradé": p.degradedRatio ?? "",
      "RSRP P50 (dBm)": p.rsrpP50 ?? "", "RSRP P10 (dBm)": p.rsrpP10 ?? "", "SINR P50 (dB)": p.sinrP50 ?? "", "SINR P10 (dB)": p.sinrP10 ?? "",
      "Description du problème": p.description, "Analyse DT": p.dtAnalysis, "RCA détaillée": p.rcaDetailed,
      "Analyse Optim": incident.optimAnalysis?.text || "Analyse Optim non calculée.",
      "Cause probable": p.probableCause,
      "Confiance RCA": p.rcaConfidenceLabel, "Score confiance RCA": p.rcaConfidence ?? "", "Preuves RCA": (p.rcaEvidence || []).join(" | "),
      "Limite RCA": (p.limitation || []).join(" | "), "Action recommandée": p.recommendedAction, "Drive / Stationary": p.driveOrStationary,
      "Symptôme": p.symptom, "Score sévérité": p.severityScore ?? "", "Score persistance": p.persistenceScore ?? "",
      "Impact utilisateur": p.userImpactScore ?? "", "MOS P50": p.mosP50 ?? "", "MOS P10": p.mosP10 ?? "",
      "Impact MOS": p.mosImpact || "", "Débit DL P50": p.throughputP50 ?? "",
      "Niveau preuve": p.evidenceLevel, "Vérification": p.verification,
      "Mobilité source": p.mobilitySourceCell || "", "Mobilité cible": p.mobilityTargetCell || "",
      "Écart voisin P50 (dB)": p.mobilityDeltaDb ?? "", "Délai avant transition (s)": p.mobilityDelaySec ?? "",
      "RCA voisinage / mobilité": p.neighborMobilityType || "", "Top 3 voisines": p.neighborMobilityTop3 || "",
      "Scan Route overlap (%)": p.scanOverlapPct ?? "", "Scan Route snapshots": p.scanOverlapSnapshots ?? "",
      "RCA recouvrement": p.scanOverlapRca || "",
    };
  };
  const rcaRowFor = (incident) => {
    const p = incident?.professional || {};
    const rca = rcaFor(incident);
    const dominance = incident?.dominance || {};
    return {
      ID: p.id, Priorité: p.priorityClass, Technologie: p.technology, Bande: p.band, Serving: p.servingCell,
      "Code RCA": p.rcaCode, "Cause probable": p.probableCause, "Confiance RCA": p.rcaConfidenceLabel,
      "Score confiance RCA": p.rcaConfidence ?? "", "Preuves RCA": (p.rcaEvidence || []).join(" | "), "Limite RCA": (p.limitation || []).join(" | "),
      "Voisins mesurés": rca?.radioContext?.distinctNeighborCount ?? "", "Voisins récurrents": rca?.radioContext?.recurrentNeighborCount ?? "",
      "Dominance P50 (dB)": dominance.p50 ?? "", "Dominance P10 (dB)": dominance.p10 ?? "", "Dominance <=3 dB (%)": dominance.weakPct ?? "",
      "Voisin meilleur (%)": dominance.neighborBetterPct ?? "", "Changements serving": p.servingChanges ?? "", Action: p.recommendedAction,
      "Mobilité source": p.mobilitySourceCell || "", "Mobilité cible": p.mobilityTargetCell || "",
      "Écart voisin P50 (dB)": p.mobilityDeltaDb ?? "", "Délai avant transition (s)": p.mobilityDelaySec ?? "",
      "RCA voisinage / mobilité": p.neighborMobilityType || "", "Top 3 voisines": p.neighborMobilityTop3 || "",
      "Scan Route overlap (%)": p.scanOverlapPct ?? "", "Scan Route snapshots": p.scanOverlapSnapshots ?? "",
      "RCA recouvrement": p.scanOverlapRca || "",
      "Niveau preuve": p.evidenceLevel, "Vérification": p.verification,
      "RCA détaillée": p.rcaDetailed || "",
      "Analyse Optim": incident.optimAnalysis?.text || "Analyse Optim non calculée.",
    };
  };
  const exportModel = (analysis, meta = {}) => {
    const enriched = apply(analysis, meta);
    const report = enriched?.professionalReport || executiveFor([], meta);
    const all = enriched?.incidents || [];
    const drive = ordered(all.filter((item) => !item?.stationary));
    const stationary = ordered(all.filter((item) => item?.stationary));
    return {
      executive: report,
      incidentsDrive: drive.map(rowFor),
      rca: drive.map(rcaRowFor),
      stationary: stationary.map(rowFor),
      topIncidents: report.topIncidents.map(rowFor),
    };
  };

  return { VERSION, CONFIG, getDisplayBand, priorityFor, confidenceFor, professionalFor, apply, executiveFor, exportModel };
});
