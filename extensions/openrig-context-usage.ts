// OpenRig context-usage sidecar for a Pi seat.
//
// Writes `$OPENRIG_HOME/state/context-usage/<seat>.json` from `ctx.getContextUsage()` so OpenRig
// can show a Pi seat's context percentage the way it shows one for any other runtime. The file
// shape is the sidecar OpenRig already reads for Claude Code seats and for its own stub runtime;
// it is reproduced here on purpose instead of imported, so this repository depends on a file
// contract and not on OpenRig's source.
//
// Node built-ins only. Pi loads this file with jiti from the seat's extensions directory, and the
// seat's session must not come to depend on anything this extension cannot do with the process it
// is already in.
//
// Every failure is swallowed, and logged only when OPENRIG_CONTEXT_TELEMETRY_DEBUG is set. A
// telemetry writer that can break a model call is not telemetry.

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";

/** What `ctx.getContextUsage()` reports. Pi returns `undefined` when it has nothing, and a null
 *  `percent`/`tokens` when the context size is not known yet (for example just after a compaction,
 *  before the next model response). */
export interface PiContextUsage {
  tokens?: number | null;
  contextWindow?: number | null;
  percent?: number | null;
}

/** The sidecar OpenRig reads. Field names and the null-vs-missing rule follow the collector OpenRig
 *  provisions for Claude Code seats (`claude-statusline-context.cjs`). */
export interface SidecarSample {
  context_window: {
    context_window_size: number | null;
    used_percentage: number | null;
    remaining_percentage: number | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    current_usage: unknown;
  };
  session_id: string | null;
  session_name: string | null;
  occupant_generation: string | null;
  transcript_path: string | null;
  cost: null;
  sampled_at: string;
}

/** The filesystem surface this extension needs, so a test can watch or break it. */
export interface FsLike {
  mkdirSync: (path: string, options: { recursive: boolean }) => unknown;
  writeFileSync: (path: string, data: string, encoding?: string) => unknown;
  renameSync: (from: string, to: string) => unknown;
  unlinkSync: (path: string) => unknown;
}

export type WriteReason = "session_start" | "model_call" | "compaction";
/** Two writes of the same reading inside this window are one write. Only ever consulted between
 *  model calls, so a seat that is merely idle still stops refreshing — nothing schedules a write. */
const MIN_INTERVAL_MS = 1000;

/** Mirrors OpenRig's `telemetrySidecarFilename`: anything outside `[A-Za-z0-9@._-]` becomes `_`. */
export function sidecarFilename(sessionName: string): string {
  return `${sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_")}.json`;
}

/** Mirrors OpenRig's `contextUsageDirectory`. */
export function contextUsageDirectory(openrigHome: string): string {
  return nodePath.join(openrigHome, "state", "context-usage");
}

/** The seat name, found the way the OpenRig heartbeat extension finds it: OpenRig sets
 *  `PI_CODING_AGENT_DIR` to `$OPENRIG_HOME/state/pi/<seat>/agent`, so the grandparent directory
 *  name is the seat. `OPENRIG_SESSION_NAME` covers a seat launched without that directory, and the
 *  pid keeps a plain Pi session (no OpenRig) from writing under somebody else's name. */
export function seatNameFromEnv(env: Record<string, string | undefined>): string {
  const dir = env.PI_CODING_AGENT_DIR;
  if (dir && nodePath.basename(dir) === "agent") return nodePath.basename(nodePath.dirname(dir));
  return env.OPENRIG_SESSION_NAME || `pi-${process.pid}`;
}

/** True when the environment names a seat somebody will read.
 *
 *  A plain Pi session that loaded this extension from a user extensions directory has neither a
 *  seat-shaped `PI_CODING_AGENT_DIR` nor `OPENRIG_SESSION_NAME`, so the name would fall back to
 *  `pi-<pid>` and the home to `~/.openrig`. That is a file no seat ever reads, left behind once per
 *  process and never cleaned. Writing it is not telemetry, so nothing is written at all.
 *
 *  The shape matters. OpenRig points a seat at `$OPENRIG_HOME/state/pi/<seat>/agent` (an omp seat
 *  uses `state/omp/<seat>/agent`), so the seat directory sits directly under a `pi` or `omp` state
 *  root. The operator's own `~/.pi/agent` ends in `agent` too, but its seat-name candidate would be
 *  `.pi` - a dot-directory, and not under a `pi` root - so it is not a seat. Requiring the root
 *  segment is what keeps a plain session from writing one file per run into the operator's real
 *  `~/.openrig`. */
export function seatIsManaged(env: Record<string, string | undefined>): boolean {
  const dir = env.PI_CODING_AGENT_DIR;
  if (dir && nodePath.basename(dir) === "agent") {
    const seatDir = nodePath.dirname(dir);
    const seat = nodePath.basename(seatDir);
    const root = nodePath.basename(nodePath.dirname(seatDir));
    if ((root === "pi" || root === "omp") && seat !== "" && !seat.startsWith(".")) return true;
  }
  return Boolean(nonEmptyString(env.OPENRIG_SESSION_NAME));
}

export function openrigHomeFromEnv(env: Record<string, string | undefined>): string {
  return env.OPENRIG_HOME || nodePath.join(env.HOME || "", ".openrig");
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A getter on Pi's context object is a foreign call: it may be absent or throw. */
function safeStringCall(call: () => unknown): string | null {
  try {
    return nonEmptyString(call());
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function defaultLog(env: Record<string, string | undefined>): (line: string) => void {
  return (line: string) => {
    if (!env.OPENRIG_CONTEXT_TELEMETRY_DEBUG) return;
    try {
      process.stderr.write(`[openrig][context-usage] ${line}\n`);
    } catch {
      /* a broken stderr is not a reason to fail a session */
    }
  };
}

/** Builds the sidecar body for one observation. `percent === null` means "no reading": the usage
 *  fields stay null rather than becoming a zero, because a zero reads as an empty context.
 *
 *  The percentage is rounded. Pi computes `tokens / contextWindow * 100`, which is a float such as
 *  39.900000000000006, and OpenRig prints `used_percentage` as written in `rig ps --nodes`,
 *  `rig whoami` and `rig usage` (only the TUI rounds). Claude's statusline and OpenRig's own Codex
 *  normaliser both hand over whole numbers, so the writer rounds to keep a Pi seat in the same shape.
 *  The exact figure stays in `current_usage.percent`. */
export function buildSample(input: {
  seat: string;
  env: Record<string, string | undefined>;
  ctx: any;
  usage: PiContextUsage | undefined;
  percent: number | null;
  atMs: number;
}): SidecarSample {
  const usage = input.usage;
  // A reading outside the window is still reported inside it: a reader must never see -4% or 120%.
  const percent = input.percent === null ? null : Math.round(clampPercentage(input.percent));
  const tokens = percent === null ? null : finiteNumber(usage?.tokens);
  return {
    context_window: {
      context_window_size: finiteNumber(usage?.contextWindow),
      used_percentage: percent,
      remaining_percentage: percent === null ? null : clampPercentage(100 - percent),
      total_input_tokens: tokens,
      // Pi's context usage describes what is in the window, not a billed input/output split.
      total_output_tokens: null,
      current_usage: usage
        ? {
            runtime: "pi",
            tokens: finiteNumber(usage.tokens),
            context_window: finiteNumber(usage.contextWindow),
            percent: finiteNumber(usage.percent),
          }
        : null,
    },
    session_id: safeStringCall(() => input.ctx?.sessionManager?.getSessionId?.()),
    session_name: input.seat,
    occupant_generation: nonEmptyString(input.env.OPENRIG_OCCUPANT_GENERATION),
    transcript_path: safeStringCall(() => input.ctx?.sessionManager?.getSessionFile?.()),
    // Pi's context usage carries no cost figure, and an absent one is not zero.
    cost: null,
    sampled_at: new Date(input.atMs).toISOString(),
  };
}

/** Write-then-rename, so a reader never sees a half-written sidecar. */
export function writeAtomic(fs: FsLike, file: string, sample: SidecarSample): void {
  const dir = nodePath.dirname(file);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(sample), "utf-8");
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file was never created, or is already gone */
    }
    throw error;
  }
}

export interface WriterOptions {
  env?: Record<string, string | undefined>;
  fs?: FsLike;
  now?: () => number;
  log?: (line: string) => void;
  minIntervalMs?: number;
}

/**
 * One sidecar writer for one seat. `write()` reports whether it wrote and never throws: a Pi
 * telemetry writer that can break a model call is not a telemetry writer.
 */
export function createSidecarWriter(options: WriterOptions = {}) {
  const env = options.env ?? process.env;
  const fs = options.fs ?? (nodeFs as unknown as FsLike);
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? defaultLog(env);
  const minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;

  const seat = seatNameFromEnv(env);
  const managed = seatIsManaged(env);
  const dir = contextUsageDirectory(openrigHomeFromEnv(env));
  const file = nodePath.join(dir, sidecarFilename(seat));

  let lastWriteAt = Number.NaN;
  let lastPercent: number | null = null;

  function write(ctx: any, reason: WriteReason): boolean {
    // No seat, no file. See seatIsManaged.
    if (!managed) return false;

    let usage: PiContextUsage | undefined;
    let readFailed = false;
    try {
      usage = ctx?.getContextUsage?.() as PiContextUsage | undefined;
    } catch (error) {
      // A throwing read is a failed observation. Away from a compaction the write is skipped, so the
      // previous sample stands instead of being replaced by nothing.
      readFailed = true;
      log(`${reason}: getContextUsage failed for ${seat}: ${errorMessage(error)}`);
      // At a compaction the retired reading is the thing that must not survive, so an unknown sample
      // still goes down.
      if (reason !== "compaction") return false;
    }

    try {
      const rawPercent = readFailed ? null : finiteNumber(usage?.percent);
      const percent = rawPercent === null ? null : clampPercentage(rawPercent);
      if (percent === null && reason !== "compaction") {
        // Nothing to say. Keep the last real reading instead of replacing it with a null one.
        return false;
      }
      // A compaction always writes: the reading it replaces is the one that must not survive.
      if (reason !== "compaction" && percent === lastPercent && now() - lastWriteAt < minIntervalMs) {
        return false;
      }

      writeAtomic(fs, file, buildSample({ seat, env, ctx, usage, percent, atMs: now() }));
      lastWriteAt = now();
      lastPercent = percent;
      return true;
    } catch (error) {
      log(`${reason}: could not write the context-usage sidecar for ${seat}: ${errorMessage(error)}`);
      return false;
    }
  }

  return { seat, dir, file, managed, write };
}

/**
 * Pi extension entry point. Registers the three moments worth a sample: session start, the end of
 * each model call, and the end of a compaction. Nothing streams - a token-by-token writer would
 * only make the seat slower.
 *
 * `turn_end`, not `message_end`: Pi awaits extensions before it persists the assistant message, so
 * at `message_end` the context still lacks the very call being reported and every reading would lag
 * one call behind. `turn_end` is dispatched only once the message has a persisted entry (Pi refuses
 * to fire it otherwise), which is the reading Pi itself shows.
 */
export default function openrigContextUsage(pi: any): void {
  try {
    const writer = createSidecarWriter();
    if (!writer.managed) {
      // A plain Pi session, not an OpenRig seat: register nothing rather than leave a file under a
      // name no seat reads.
      return;
    }

    pi.on("session_start", (_event: any, ctx: any) => {
      writer.write(ctx, "session_start");
    });

    pi.on("turn_end", (_event: any, ctx: any) => {
      writer.write(ctx, "model_call");
    });

    pi.on("session_compact", (_event: any, ctx: any) => {
      writer.write(ctx, "compaction");
    });
  } catch (error) {
    // A factory that throws would take the session with it.
    try {
      defaultLog(process.env)(`could not start the context-usage sidecar writer: ${errorMessage(error)}`);
    } catch {
      /* nothing left to try */
    }
  }
}
