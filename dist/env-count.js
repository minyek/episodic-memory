/**
 * Read a non-negative count from an environment value. Unset gives the
 * fallback; exactly "0" gives 0; a positive integer is taken as is; anything
 * else keeps the fallback and warns, so a malformed value never turns a limit off.
 */
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
