
// ----------------------------------------------------
// THEME & THRESHOLD CONFIGURATION
// ----------------------------------------------------
window.themeConfig = {
    activeMetric: 'level', // Default Metric
    // Default Thresholds (can be modified by UI)
    thresholds: {
        // Voice quality MOS (POLQA/PESQ), valid scale 0..5
        // Défaut: Mauvaise 0 à 2,2 / Moyen 2,2 à 3 / Bon > 3
        mos: [
            { min: 3, color: '#22c55e', label: 'Bon (3 à 5)' },
            { min: 2.2, max: 3, color: '#eab308', label: 'Moyen (2,2 à < 3)' },
            { min: 0, max: 2.2, color: '#ef4444', label: 'Mauvaise (0 à < 2,2)' }
        ],
        // RSRP (LTE & NR) — défaut: Mauvaise < -115 / Moyen -115 à -105 / Bon > -105
        rsrp: [
            { min: -105, color: '#22c55e', label: 'Bon (> -105 dBm)' },
            { min: -115, max: -105, color: '#eab308', label: 'Moyen (-115 à -105 dBm)' },
            { max: -115, color: '#ef4444', label: 'Mauvaise (< -115 dBm)' }
        ],
        // RSRQ (LTE & NR)
        rsrq: [
            { min: -10, color: '#22c55e', label: 'Excellent ( > -10 )' },
            { min: -15, max: -10, color: '#84cc16', label: 'Good ( -15 to -10 )' },
            { min: -20, max: -15, color: '#f97316', label: 'Fair ( -20 to -15 )' },
            { max: -20, color: '#ef4444', label: 'Bad ( < -20 )' }
        ],
        // SINR (LTE & NR) — défaut: Mauvaise < 0 / Moyen 0 à 5 / Bon > 5
        sinr: [
            { min: 5, color: '#22c55e', label: 'Bon (> 5 dB)' },
            { min: 0, max: 5, color: '#eab308', label: 'Moyen (0 à 5 dB)' },
            { max: 0, color: '#ef4444', label: 'Mauvaise (< 0 dB)' }
        ],
        // CQI
        cqi: [
            { min: 12, color: '#22c55e', label: 'Excellent ( 13-15 )' },
            { min: 9, max: 12, color: '#84cc16', label: 'Good ( 10-12 )' },
            { min: 6, max: 9, color: '#eab308', label: 'Fair ( 7-9 )' },
            { max: 6, color: '#ef4444', label: 'Bad ( 0-6 )' }
        ],
        // MCS
        mcs: [
            { min: 20, color: '#22c55e', label: 'High ( 20-31 )' },
            { min: 10, max: 20, color: '#84cc16', label: 'Mid ( 10-19 )' },
            { max: 10, color: '#eab308', label: 'Low ( 0-9 )' }
        ],
        // Throughput (Mbps)
        throughput: [
            { min: 100, color: '#22c55e', label: 'Excellent ( > 100 Mbps )' },
            { min: 50, max: 100, color: '#84cc16', label: 'Good ( 50-100 Mbps )' },
            { min: 10, max: 50, color: '#eab308', label: 'Fair ( 10-50 Mbps )' },
            { min: 5, max: 10, color: '#f97316', label: 'Poor ( 5-10 Mbps )' },
            { max: 5, color: '#ef4444', label: 'Bad ( < 5 Mbps )' }
        ],
        // Legacy 'level' and 'quality' (mapping to rsrp/rsrq)
        // 'level' suit le même défaut RSRP: Mauvaise < -115 / Moyen -115 à -105 / Bon > -105
        level: [
            { min: -105, color: '#22c55e', label: 'Bon (> -105)' },
            { min: -115, max: -105, color: '#eab308', label: 'Moyen (-115 à -105)' },
            { max: -115, color: '#ef4444', label: 'Mauvaise (< -115)' }
        ],
        quality: [
            { min: -10, color: '#22c55e', label: 'Excellent ( > -10 )' },
            { min: -15, max: -10, color: '#84cc16', label: 'Good ( -15 to -10 )' },
            { min: -20, max: -15, color: '#f97316', label: 'Fair ( -20 to -15 )' },
            { max: -20, color: '#ef4444', label: 'Bad ( < -20 )' }
        ]
    }
};

// Map 'metric' names to threshold keys
window.getThresholdKey = (metric) => {
    if (!metric) return null;
    const m = metric.toLowerCase();
    const mNorm = m.replace(/[^a-z0-9]/g, '');

    // MOS (voix) — avant les règles génériques
    if (mNorm.includes('audioqualitymos') || mNorm === 'mos' || mNorm === 'mosdl' || m.includes('polqa') || m.includes('pesq')) return 'mos';

    // RSRP
    if (m.includes('rsrp') || m === 'level' || m.includes('rscp')) return 'rsrp';
    // RSRQ
    if (m.includes('rsrq') || m === 'quality' || m.includes('ecno')) return 'rsrq';
    // SINR
    if (m.includes('sinr')) return 'sinr';
    // CQI
    if (m.includes('cqi')) return 'cqi';
    // MCS
    if (m.includes('mcs')) return 'mcs';
    // Throughput
    if (m.includes('throughput') || m.includes('thr')) return 'throughput';

    // Discrete/Categorical Metrics
    const discrete = [
        'pci', 'cid', 'cellid', 'sc', 'beam', 'index', 'band', 'freq', 'earfcn', 'uarfcn', 'arfcn', 'channel', 'bandwidth',
        'rnc', 'lac', 'name', 'state', 'event', 'cause', 'technology', 'ssb', 'slot', 'frame', 'mode', 'type'
    ];
    if (discrete.some(d => m.includes(d))) return 'discrete';

    return null; // Default fallback
};
