import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import { getExcludedProjects, findJsonlFiles, statIfExists } from './paths.js';
import { formatErrorSentinel, shouldQueueForSummary } from './summary-sentinel.js';
import { getMaxMessageBytes, isOversizeExchange } from './message-size.js';
const EXCLUSION_MARKERS = [
    '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>',
    'Only use NO_INSIGHTS_FOUND',
    SUMMARIZER_CONTEXT_MARKER,
];
const MARKER_SCAN_CHUNK_BYTES = 1 << 20; // 1 MiB
/**
 * Stream and scan for any exclusion marker, carrying an overlap between
 * chunks so a marker split across a boundary is still found. A single
 * fs.readFileSync(path, 'utf-8') throws ERR_STRING_TOO_LONG above Node's
 * ~512 MB max string length; the old catch returned false (fail OPEN),
 * silently indexing a file whose DO NOT INDEX marker we never read (#152).
 * Streaming confirms cleanliness at any size, and a real read error now
 * fails CLOSED (skip) rather than open.
 */
export function shouldSkipConversation(filePath) {
    const maxMarkerLen = Math.max(...EXCLUSION_MARKERS.map(m => m.length));
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.allocUnsafe(MARKER_SCAN_CHUNK_BYTES);
        const decoder = new StringDecoder('utf8');
        let carry = '';
        let bytesRead;
        while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
            const window = carry + decoder.write(buf.subarray(0, bytesRead));
            if (EXCLUSION_MARKERS.some(marker => window.includes(marker))) {
                return true;
            }
            carry = window.slice(Math.max(0, window.length - (maxMarkerLen - 1)));
        }
        const tail = carry + decoder.end();
        return EXCLUSION_MARKERS.some(marker => tail.includes(marker));
    }
    catch {
        return true; // fail closed (#152)
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { }
        }
    }
}
/**
 * True when a transcript contains at least one message line in any supported
 * harness format. Summarizer-spawned Agent SDK sessions materialize as
 * message-less stub files (a single {"type":"ai-title"} line) that defeat the
 * marker-based exclusion above and would otherwise re-enter the sync queue on
 * every run — one new stub per summary generated. A transcript that has no
 * messages *yet* (a session that just started) is skipped this run and picked
 * up on a later sync once it has content, since its mtime keeps advancing.
 */
function hasConversationContent(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim())
                continue;
            try {
                const parsed = JSON.parse(line);
                // Claude: {type: "user"|"assistant", message: {...}}
                if ((parsed.type === 'user' || parsed.type === 'assistant') && parsed.message) {
                    return true;
                }
                // Codex: {type: "response_item"|..., payload: {...}}
                if (parsed.payload) {
                    return true;
                }
                // Cursor: {role: "user"|"assistant", message: {...}}
                if (parsed.role && parsed.message) {
                    return true;
                }
                // opencode: {type: "opencode_message", message: {...}, parts: [...]}.
                // The message line has no top-level `role` and its `type` is neither
                // user nor assistant, so without this branch #113's pre-copy guard would
                // skip every opencode transcript before it is copied/indexed/summarized.
                if (parsed.type === 'opencode_message' && parsed.message) {
                    return true;
                }
                // OMP: {type: "message", message: {role, content}, id, parentId}.
                // A session-header-only file has no message lines and is still skipped.
                if (parsed.type === 'message' && parsed.message && parsed.message.role) {
                    return true;
                }
            }
            catch {
                continue;
            }
        }
        return false;
    }
    catch {
        // If we can't read the file, let the normal pipeline handle it
        return true;
    }
}
/**
 * Whether the sync report should suggest checking the API configuration: every
 * summary attempt failed and no batch stopped on a cause other than auth.
 */
export function shouldHintApiConfiguration(report) {
    return report.summaryFailures > 0 && report.summarized === 0 && !report.stoppedOnNonAuthCause;
}
/**
 * Derive sync options from the process environment.
 *
 * `EPISODIC_MEMORY_SKIP_SUMMARIES=1` turns the summarization pass off.
 * Only the exact string '1' enables the switch — unset, '0', 'true',
 * and anything else leave summarization on, so a stray value can't
 * silently disable a feature the user still expects.
 *
 * Why anyone wants this: summaries are display-only. search.ts reads
 * the `-summary.txt` sidecar solely to decorate result output; summary
 * text is never embedded and never searched, so skipping it leaves
 * recall untouched. The summarizer, by contrast, resumes each
 * conversation through the Claude Agent SDK, which spends the user's
 * Claude quota and can stall on a permission prompt.
 */
export function buildSyncOptionsFromEnv(env) {
    return { skipSummaries: env.EPISODIC_MEMORY_SKIP_SUMMARIES === '1' };
}
function archiveIsCurrent(srcStat, dest) {
    if (!fs.existsSync(dest))
        return false;
    return fs.statSync(dest).mtimeMs >= srcStat.mtimeMs;
}
// Copies the source into the archive (temp file and rename), stamped with the
// source mtime the walk saw: harnesses without per-message timestamps (Cursor
// agent transcripts) fall back to the file's mtime, and a source that grows
// after the walk still looks newer than its copy. Rounded up to a whole
// millisecond: utimes can't always represent the source's sub-millisecond
// precision, and a copy even fractionally older would be copied again on every
// sync. A filesystem that refuses the stamp still gets the copy; the stamp
// error is returned for the caller to report.
function copyToArchive(src, dest, srcStat) {
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }
    const tempDest = dest + '.tmp.' + process.pid;
    fs.copyFileSync(src, tempDest);
    let stampError = null;
    try {
        fs.utimesSync(tempDest, srcStat.atimeMs / 1000, Math.ceil(srcStat.mtimeMs) / 1000);
    }
    catch (error) {
        stampError = error;
    }
    fs.renameSync(tempDest, dest); // Atomic on same filesystem
    return stampError;
}
export function extractSessionIdFromPath(filePath) {
    // Extract session ID from Claude filename or Codex rollout filename.
    const basename = path.basename(filePath, '.jsonl');
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
    const matches = basename.match(uuidPattern);
    if (matches && matches.length > 0) {
        return matches[matches.length - 1];
    }
    return null;
}
export async function syncConversations(sourceDir, destDir, options = {}) {
    const result = {
        copied: 0,
        skipped: 0,
        indexed: 0,
        summarized: 0,
        errors: []
    };
    // Ensure source directory exists
    if (!fs.existsSync(sourceDir)) {
        return result;
    }
    // Collect files to index and summarize
    const filesToIndex = [];
    const filesToSummarize = [];
    // The index database records each copy the walk makes until its index
    // attempt ends, so a sync stopped part-way leaves the rest for the next sync.
    // Loaded inside the try: a database that cannot load or open must not stop
    // the walk from archiving.
    let index = null;
    let pendingIndex = new Set();
    if (!options.skipIndex) {
        try {
            const dbModule = await import('./db.js');
            const db = dbModule.initDatabase();
            index = { db, dbModule };
            pendingIndex = dbModule.listIndexPending(db);
        }
        catch (error) {
            result.errors.push({
                file: '(index database)',
                error: `Index database unavailable; this run indexes nothing and later syncs will not index the conversations it archives (run \`episodic-memory index --cleanup\` once the database opens): ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }
    // Walk source directory
    const projects = fs.readdirSync(sourceDir);
    const excludedProjects = getExcludedProjects();
    const excludedDirSet = new Set(excludedProjects);
    for (const project of projects) {
        if (excludedProjects.includes(project)) {
            console.log("\nSkipping excluded project: " + project);
            continue;
        }
        const projectPath = path.join(sourceDir, project);
        const stat = statIfExists(projectPath);
        if (!stat?.isDirectory())
            continue;
        const files = findJsonlFiles(projectPath, excludedDirSet);
        for (const file of files) {
            const srcFile = path.join(projectPath, file);
            const destFile = path.join(destDir, project, file);
            try {
                // Skip message-less transcripts (summarizer-spawned stubs, sessions
                // that haven't produced content yet) before they enter the archive.
                if (!hasConversationContent(srcFile)) {
                    result.skipped++;
                    continue;
                }
                const srcStat = fs.statSync(srcFile);
                if (!archiveIsCurrent(srcStat, destFile)) {
                    if (index) {
                        try {
                            index.dbModule.markIndexPending(index.db, destFile); // before the copy can look current
                        }
                        catch (error) {
                            result.errors.push({
                                file: srcFile,
                                error: `Index progress not recorded; if this sync stops before indexing this file, later syncs will not index it (\`episodic-memory index --cleanup\` will): ${error instanceof Error ? error.message : String(error)}`
                            });
                        }
                    }
                    const stampError = copyToArchive(srcFile, destFile, srcStat);
                    result.copied++;
                    filesToIndex.push(destFile);
                    if (stampError) {
                        result.errors.push({
                            file: srcFile,
                            error: `Archive copy kept its copy time (Cursor transcripts fall back to it): ${stampError instanceof Error ? stampError.message : String(stampError)}`
                        });
                    }
                }
                else {
                    result.skipped++;
                    // Archived by an earlier sync that stopped before indexing it.
                    if (pendingIndex.has(destFile))
                        filesToIndex.push(destFile);
                }
                // Check if this file needs a summary (whether new, changed or already archived).
                // shouldQueueForSummary skips files that already have a real summary or
                // an empty zero-exchange sentinel, and retries stale error sentinels (#96).
                if (!options.skipSummaries) {
                    const summaryPath = destFile.replace('.jsonl', '-summary.txt');
                    if (shouldQueueForSummary(summaryPath) && !shouldSkipConversation(destFile)) {
                        // sessionId enables Claude session-resume summarization; when the
                        // filename has no UUID to extract (e.g. subagent transcripts named
                        // agent-<hex>.jsonl), queue anyway — summarizeConversation falls
                        // back to summarizing from the transcript text.
                        const sessionId = extractSessionIdFromPath(destFile) ?? undefined;
                        filesToSummarize.push({ path: destFile, sessionId });
                    }
                }
            }
            catch (error) {
                result.errors.push({
                    file: srcFile,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
    }
    // Index the files the walk copied or recorded as pending (unless skipIndex is set)
    if (!options.skipIndex && index && filesToIndex.length > 0) {
        const { parseConversation } = await import('./parser.js');
        // Load the embedding backend first. It can fail on hosts where sharp's
        // native binding (pulled in transitively by @huggingface/transformers)
        // can't dlopen libvips (#135). That must not abort the whole sync — copying
        // has already happened and summaries still need to run — so surface a
        // clear, actionable error and skip semantic indexing for this run instead
        // of throwing out of syncConversations (which would crash the SessionStart
        // hook that invokes it).
        let embeddings = null;
        try {
            embeddings = await import('./embeddings.js');
            await embeddings.initEmbeddings();
        }
        catch (error) {
            embeddings = null;
            result.errors.push({
                file: '(embeddings)',
                error: `Semantic indexing skipped — embedding backend unavailable: ${error instanceof Error ? error.message : String(error)}`,
            });
            console.error('episodic-memory: embedding backend failed to load; skipping semantic ' +
                'indexing this run (copying and summaries still run). See the error above.');
        }
        if (embeddings && index) {
            const { db: indexDb, dbModule: { insertExchange, clearIndexPending } } = index;
            const { generateExchangeEmbedding } = embeddings;
            const maxMessageBytes = getMaxMessageBytes();
            let oversizeSkipped = 0;
            for (const file of filesToIndex) {
                try {
                    // Check for DO NOT INDEX marker
                    if (shouldSkipConversation(file)) {
                        continue; // Skip indexing; the finally clause still clears its pending record
                    }
                    // High-water mark: index exchanges past the last line we've already
                    // covered. Transcript JSONLs are append-only, so MAX(line_end) tells
                    // us where to resume — without this, a grown transcript re-embeds
                    // every exchange on every sync (#152). Ported from indexer.ts.
                    const hw = indexDb.prepare('SELECT COALESCE(MAX(line_end), 0) as maxLine FROM exchanges WHERE archive_path = ?').get(file);
                    const maxIndexedLine = hw.maxLine;
                    const project = path.basename(path.dirname(file));
                    const exchanges = await parseConversation(file, project, file);
                    const newExchanges = maxIndexedLine > 0
                        ? exchanges.filter(e => e.lineStart > maxIndexedLine)
                        : exchanges;
                    for (const exchange of newExchanges) {
                        // Skip oversize single messages BEFORE embedding — a foreign
                        // summarizer's pasted transcript is noise, and embedding it is the
                        // expensive waste (#139).
                        if (isOversizeExchange(exchange, maxMessageBytes)) {
                            oversizeSkipped++;
                            continue;
                        }
                        const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
                        const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                        insertExchange(indexDb, exchange, embedding, toolNames);
                    }
                    result.indexed++;
                }
                catch (error) {
                    result.errors.push({
                        file,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
                finally {
                    try {
                        clearIndexPending(indexDb, file);
                    }
                    catch (error) {
                        result.errors.push({ file, error: error instanceof Error ? error.message : String(error) });
                    }
                }
            }
            if (oversizeSkipped > 0) {
                console.log(`  Skipped ${oversizeSkipped} oversize exchange(s) (> ${maxMessageBytes} bytes; set EPISODIC_MEMORY_MAX_MESSAGE_BYTES to change) — likely embedded-transcript payloads (#139)`);
            }
        }
    }
    // Copies not indexed this run (embedding backend unavailable) keep their
    // pending record, so a later sync indexes them.
    index?.db.close();
    // Generate summaries for files that need them
    if (!options.skipSummaries && filesToSummarize.length > 0) {
        const { parseConversation } = await import('./parser.js');
        const { summarizeConversation, classifySummaryFailure, isTrivialConversation } = await import('./summarizer.js');
        const summaryLimit = options.summaryLimit ?? 10;
        const toSummarize = filesToSummarize.slice(0, summaryLimit);
        const remaining = filesToSummarize.length - toSummarize.length;
        console.log(`Generating summaries for ${toSummarize.length} conversation(s)...`);
        if (remaining > 0) {
            console.log(`  (${remaining} more need summaries - will process on next sync)`);
        }
        // A global failure (an expired or missing Claude CLI login, an overloaded or
        // rate-limited service, an empty credit balance) hits every conversation the
        // same way, so the rest of this source's batch is not tried: its files get an
        // error sentinel naming the cause and retry after the retry interval
        // (EPISODIC_MEMORY_SUMMARY_ERROR_RETRY_HOURS, default 1 h). A suspect failure
        // (a timeout, another 5xx) can be one conversation's own, so it stops the
        // batch only when it repeats with no returned call in between.
        let stopMessage = null;
        let suspectInARow = 0;
        const suspectFailuresToStop = 2;
        for (const { path: filePath, sessionId } of toSummarize) {
            if (stopMessage !== null) {
                try {
                    const summaryPath = filePath.replace('.jsonl', '-summary.txt');
                    fs.writeFileSync(summaryPath, formatErrorSentinel(new Error(stopMessage)), 'utf-8');
                }
                catch { }
                result.errors.push({
                    file: filePath,
                    error: `Summary generation skipped: ${stopMessage}`,
                });
                continue;
            }
            try {
                const project = path.basename(path.dirname(filePath));
                const exchanges = await parseConversation(filePath, project, filePath);
                if (exchanges.length === 0) {
                    // Skip empty conversations — write an empty -summary.txt sentinel so they aren't re-queued forever
                    const summaryPath = filePath.replace('.jsonl', '-summary.txt');
                    fs.writeFileSync(summaryPath, '', 'utf-8');
                    continue;
                }
                console.log(`  Summarizing ${path.basename(filePath)} (${exchanges.length} exchanges)...`);
                const summary = await summarizeConversation(exchanges, sessionId);
                if (!isTrivialConversation(exchanges))
                    suspectInARow = 0;
                const summaryPath = filePath.replace('.jsonl', '-summary.txt');
                fs.writeFileSync(summaryPath, summary, 'utf-8');
                result.summarized++;
            }
            catch (error) {
                // Write a structured error sentinel (#96): distinct from the empty
                // zero-exchange sentinel so a stale failure can self-heal on the next
                // sync run past the retry threshold. The marker also keeps the error
                // text on disk for post-hoc diagnosis. Best-effort — if the sentinel
                // write itself fails, fall through and surface the original error.
                try {
                    const summaryPath = filePath.replace('.jsonl', '-summary.txt');
                    fs.writeFileSync(summaryPath, formatErrorSentinel(error), 'utf-8');
                }
                catch { }
                result.errors.push({
                    file: filePath,
                    error: `Summary generation failed: ${error instanceof Error ? error.message : String(error)}`
                });
                const failure = classifySummaryFailure(error);
                if (failure === null) {
                    suspectInARow = 0;
                }
                else if (failure.kind === 'suspect') {
                    suspectInARow++;
                }
                if (failure !== null && (failure.kind === 'global' || suspectInARow >= suspectFailuresToStop)) {
                    stopMessage =
                        `${failure.cause}; the remaining summaries retry after the retry interval ` +
                            '(EPISODIC_MEMORY_SUMMARY_ERROR_RETRY_HOURS, default 1 hour)';
                    result.summaryStop = failure.auth ? 'auth' : 'other';
                    console.error(`  Summarizing stopped: ${stopMessage}`);
                }
            }
        }
    }
    return result;
}
