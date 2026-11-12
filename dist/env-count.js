export function parseEnvCount(raw, count, warn) {
    if (raw === undefined)
        return count.fallback;
    if (raw === '0')
        return 0;
    if (/^[1-9][0-9]*$/.test(raw))
        return Number.parseInt(raw, 10);
    warn(`episodic-memory: ignoring invalid ${count.name}=${JSON.stringify(raw)}; using ${count.fallback} ${count.unit}`);
    return count.fallback;
}
