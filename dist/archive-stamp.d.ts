/**
 * Pick the mtime for a pending archive copy: the first margin below the
 * source's mtime whose stamp reads back below the source, or null when none
 * does. setAndReadBack sets the copy's mtime to the given value and returns the
 * mtime the filesystem reports afterwards.
 */
export declare function settlePendingMtime(sourceMtimeMs: number, setAndReadBack: (mtimeMs: number) => number): number | null;
/** The mtime a finished archive copy takes: the source's, rounded up to a whole millisecond. */
export declare function currentArchiveMtimeMs(sourceMtimeMs: number): number;
