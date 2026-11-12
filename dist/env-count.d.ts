/**
 * Read a non-negative count from an environment value. Unset gives the
 * fallback; exactly "0" gives 0; a positive integer is taken as is; anything
 * else keeps the fallback and warns, so a malformed value never turns a limit off.
 */
export interface EnvCount {
    name: string;
    fallback: number;
    unit: string;
}
export declare function parseEnvCount(raw: string | undefined, count: EnvCount, warn: (message: string) => void): number;
