import { ConversationExchange } from './types.js';
/**
 * Thrown by callClaude when the SDK yields an `is_error: true` result message.
 * Carries the SDK's `subtype`, `session_id`, the HTTP `api_error_status`, and the
 * `result` error text as typed fields so callers can dispatch on structural
 * metadata and logs show the real failure rather than a bare subtype.
 *
 * `subtype: 'success'` with `is_error: true` is a documented SDK combination
 * (`SDKResultSuccess`): the agent loop finished but the turn hit an API error,
 * with the message in `result` and the status in `api_error_status`. Surfacing
 * both turns the otherwise-useless "Summarizer SDK error: success" into a
 * diagnostic line.
 */
export declare class SummarizerSdkError extends Error {
    readonly subtype: string;
    readonly sessionId?: string | undefined;
    readonly apiErrorStatus?: number | null | undefined;
    readonly apiError?: string | undefined;
    constructor(subtype: string, sessionId?: string | undefined, apiErrorStatus?: number | null | undefined, apiError?: string | undefined);
}
/**
 * True when the failure was caused by the resume continuation itself — the
 * trigger for the non-resume fallback in summarizeConversation. Two signals:
 *
 * - subtype `error_during_execution`: the SDK couldn't resume the session
 *   (e.g. the recorded cwd no longer exists, or "No conversation found").
 * - an HTTP 400 on the result: the API rejected the *replayed history*. The
 *   canonical case is `thinking`/`redacted_thinking` blocks in the latest
 *   assistant turn, which the API forbids modifying when continuing. Our
 *   summary prompt is plain, well-formed text, so on a resume call a 400 can
 *   only come from the replayed turns — exactly what the non-resume path (fresh
 *   session, transcript as text) sidesteps. Other statuses (401/403/429/5xx)
 *   are not resume-specific, so they propagate rather than burn a futile retry.
 */
export declare function isResumeFailure(error: unknown): boolean;
export interface CodexSummarizerCommand {
    command: string;
    args: string[];
    prompt: string;
    sessionId: string;
    model?: string;
    versionArgs?: string[];
    skipVersionCheck?: boolean;
}
/**
 * Get API environment overrides for summarization calls.
 * Returns full env merged with process.env so subprocess inherits PATH, HOME, etc.
 *
 * Env vars (all optional):
 * - EPISODIC_MEMORY_API_MODEL: Model to use (default: haiku)
 * - EPISODIC_MEMORY_API_MODEL_FALLBACK: Fallback model on error (default: sonnet)
 * - EPISODIC_MEMORY_API_BASE_URL: Custom API endpoint
 * - EPISODIC_MEMORY_API_TOKEN: Auth token for custom endpoint
 * - EPISODIC_MEMORY_API_TIMEOUT_MS: Timeout for API calls (default: SDK default)
 */
export declare function getApiEnv(): Record<string, string | undefined> | undefined;
/**
 * Detect whether the current process is running inside the Claude Agent SDK
 * subprocess that the summarizer just spawned. The flag is set by getApiEnv()
 * and inherited by the spawned subprocess. Used by sync entry points to bail
 * out before re-entering the sync→summarizer→spawn cycle (#87).
 */
export declare function shouldSkipReentrantSync(): boolean;
export declare function formatConversationText(exchanges: ConversationExchange[]): string;
/**
 * Build the options object passed to the Claude Agent SDK's query() for a
 * summarization call.
 *
 * persistSession: false keeps the SDK from writing its session transcript to
 * ~/.claude/projects/ (#83). Without it, every summarization spawns a fake
 * session JSONL that pollutes the IDE session sidebar. The option is honored
 * by claude-agent-sdk >= 0.2.0.
 */
export declare function buildSummarizerQueryOptions(args: {
    model: string;
    sessionId?: string;
    cwd?: string;
}): Record<string, unknown>;
export declare function buildCodexSummaryPrompt(): string;
export declare function buildCodexSummarizerCommand(args: {
    sessionId: string;
    prompt: string;
    model?: string;
    codexBin?: string;
}): CodexSummarizerCommand;
export declare function runCodexCommand(command: CodexSummarizerCommand): Promise<string>;
/**
 * Resolve the model to pass into Codex `thread/fork` for summarization.
 *
 * Historical exchanges may carry deprecated model ids (e.g. `gpt-5.2-codex`),
 * and `-codex`-suffixed variants are API-key-only — ChatGPT-subscription users
 * get a 400 from `app-server` regardless of the suffix used. Reading the model
 * from history therefore breaks summarization for two large user populations.
 *
 * Default to `undefined` so `app-server` uses the current Codex config
 * (`~/.codex/config.toml#model`). Operators can override via
 * `EPISODIC_MEMORY_CODEX_MODEL` if they need a specific model id (e.g. an
 * API-key user wanting `gpt-5.5-codex`).
 *
 * See https://github.com/obra/episodic-memory/issues/98.
 */
export declare function getCodexModel(_exchanges: ConversationExchange[]): string | undefined;
export declare function summarizeConversation(exchanges: ConversationExchange[], sessionId?: string): Promise<string>;
