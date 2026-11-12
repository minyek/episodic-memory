/**
 * Read a non-negative count from an environment value. Unset gives the
 * fallback; exactly "0" gives 0; a positive integer is taken as is; anything
 * else keeps the fallback and warns, so a malformed value never turns a limit off.
 */
export declare function parseEnvCount(name: string, raw: string | undefined, fallback: number, unit: string, warn: (message: string) => void): number;
