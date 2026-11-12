// How far below its source's mtime a pending archive copy is stamped. The
// second margin is for filesystems that round times up to a coarse step (FAT
// stores 2 s): a 1 ms margin would read back equal to the source there.
const PENDING_MARGINS_MS = [1, 2000];
/**
 * Pick the mtime for a pending archive copy: the first margin below the
 * source's mtime whose stamp reads back below the source, or null when none
 * does. setAndReadBack sets the copy's mtime to the given value and returns the
 * mtime the filesystem reports afterwards.
 */
export function settlePendingMtime(sourceMtimeMs, setAndReadBack) {
    const wholeMs = Math.ceil(sourceMtimeMs);
    for (const margin of PENDING_MARGINS_MS) {
        const target = wholeMs - margin;
        if (setAndReadBack(target) < sourceMtimeMs)
            return target;
    }
    return null;
}
/** The mtime a finished archive copy takes: the source's, rounded up to a whole millisecond. */
export function currentArchiveMtimeMs(sourceMtimeMs) {
    return Math.ceil(sourceMtimeMs);
}
