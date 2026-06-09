/**
 * Return whether a JSONL conversation file is a sidechain. A file is
 * "sidechain" when the first record carrying an isSidechain field has it set to
 * true — subagent dispatches (every record), Warmup stubs, prompt-suggestion
 * sidechains, ai-title stubs, etc.
 *
 * Conservative: if we can't read the file, can't parse a record, or no record
 * carries the field within the scan cap, return false so the file is copied.
 * Mixed-content sessions (regular session with some sidechain records inline)
 * also return false — the indexer-side filter handles per-exchange skipping.
 */
export declare function isSidechainFile(filePath: string): boolean;
export interface SyncResult {
    copied: number;
    skipped: number;
    indexed: number;
    summarized: number;
    errors: Array<{
        file: string;
        error: string;
    }>;
}
export interface SyncOptions {
    skipIndex?: boolean;
    skipSummaries?: boolean;
    summaryLimit?: number;
}
export declare function extractSessionIdFromPath(filePath: string): string | null;
/**
 * Order a summary queue so never-summarized conversations come before re-summary
 * retries (a conversation that already has a good summary). A backlog of growing
 * or failing re-summaries must not starve fresh work out of the per-run
 * summaryLimit — the #91 head-of-queue failure mode. Stable within each group.
 */
export declare function orderFreshBeforeRetry<T extends {
    path: string;
}>(files: T[]): T[];
export declare function syncConversations(sourceDir: string, destDir: string, options?: SyncOptions): Promise<SyncResult>;
