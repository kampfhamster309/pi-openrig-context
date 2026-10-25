// Tests for the OpenRig context-usage sidecar extension.
//
// They run without Pi: a fake `pi` object collects the registered handlers, a fake `ctx` supplies
// `getContextUsage()`, and every write goes to a temporary OPENRIG_HOME under the OS temp
// directory. Nothing here reads or writes a real OpenRig home or a real Pi configuration.

import test from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension, {
  contextUsageDirectory,
  createSidecarWriter,
  openrigHomeFromEnv,
  seatIsManaged,
  seatNameFromEnv,
  sidecarFilename,
  writeAtomic,
} from "../extensions/openrig-context-usage.ts";

const SEAT_KEYS = [
  "context_window",
  "session_id",
  "session_name",
  "occupant_generation",
  "transcript_path",
  "cost",
  "sampled_at",
];
const CONTEXT_WINDOW_KEYS = [
  "context_window_size",
  "used_percentage",
  "remaining_percentage",
  "total_input_tokens",
  "total_output_tokens",
  "current_usage",
];

function tempHome(t: { after: (fn: () => void) => void }): string {
  const dir = realFs.mkdtempSync(path.join(os.tmpdir(), "openrig-context-test-"));
  t.after(() => realFs.rmSync(dir, { recursive: true, force: true }));
  // A test must never reach a real OpenRig home.
  assert.ok(dir.startsWith(os.tmpdir()), "the test home must live under the OS temp directory");
  return dir;
}

/** A seat environment for a managed seat named `dev-test` under `home`. */
function seatEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    OPENRIG_HOME: home,
    PI_CODING_AGENT_DIR: path.join(home, "state", "pi", "dev-test", "agent"),
    OPENRIG_SESSION_NAME: "dev-test",
    ...extra,
  };
}

function writerFor(home: string, extra: Record<string, string> = {}) {
  return createSidecarWriter({ env: seatEnv(home, extra) });
}

function fakeCtx(
  usage: { tokens?: number | null; contextWindow?: number | null; percent?: number | null } | undefined,
  options: { throwOnGetContextUsage?: boolean; sessionId?: string | null; sessionFile?: string | null } = {},
): any {
  return {
    getContextUsage() {
      if (options.throwOnGetContextUsage) throw new Error("getContextUsage exploded");
      return usage;
    },
    sessionManager: {
      getSessionId: () => (options.sessionId === undefined ? "pi-native-session-1" : options.sessionId),
      getSessionFile: () => (options.sessionFile === undefined ? "/tmp/pi/session.jsonl" : options.sessionFile),
    },
  };
}

function fakePi(): {
  handlers: () => string[];
  on: (event: string, handler: (...args: any[]) => void) => void;
  emit: (event: string, ...args: any[]) => any;
} {
  const handlers = new Map<string, (...args: any[]) => void>();
  return {
    handlers: () => [...handlers.keys()],
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event, ...args) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler registered for ${event}`);
      return handler(...args);
    },
  };
}

function readSample(file: string): any {
  return JSON.parse(realFs.readFileSync(file, "utf-8"));
}

/** A filesystem double that records the order of operations and can fail on demand. */
function recordingFs(options: { failOn?: "write" | "rename" | "mkdir" } = {}) {
  const ops: string[] = [];
  const files = new Map<string, string>();
  return {
    ops,
    files,
    mkdirSync(dir: string) {
      ops.push(`mkdir:${dir}`);
      if (options.failOn === "mkdir") throw new Error("mkdir exploded");
    },
    writeFileSync(file: string, data: string) {
      ops.push(`write:${file}`);
      if (options.failOn === "write") throw new Error("write exploded");
      files.set(file, data);
    },
    renameSync(from: string, to: string) {
      ops.push(`rename:${from}->${to}`);
      if (options.failOn === "rename") throw new Error("rename exploded");
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    unlinkSync(file: string) {
      ops.push(`unlink:${file}`);
      files.delete(file);
    },
  };
}

// -- where the file goes ---------------------------------------------------------------

test("the sidecar path follows OpenRig's contract: <home>/state/context-usage/<seat>.json", (t) => {
  const home = tempHome(t);
  const writer = writerFor(home);
  assert.equal(writer.seat, "dev-test");
  assert.equal(writer.dir, contextUsageDirectory(home));
  assert.equal(writer.dir, path.join(home, "state", "context-usage"));
  assert.equal(writer.file, path.join(home, "state", "context-usage", "dev-test.json"));
});

test("the seat name is found the way the heartbeat extension finds it", () => {
  assert.equal(
    seatNameFromEnv({ PI_CODING_AGENT_DIR: "/h/state/pi/dev-build@my-rig/agent" }),
    "dev-build@my-rig",
  );
  // A directory that is not a seat's agent dir does not name a seat; the session name does.
  assert.equal(seatNameFromEnv({ PI_CODING_AGENT_DIR: "/h/state/pi", OPENRIG_SESSION_NAME: "s" }), "s");
  assert.equal(seatNameFromEnv({ OPENRIG_SESSION_NAME: "solo-seat" }), "solo-seat");
  assert.match(seatNameFromEnv({}), /^pi-\d+$/);
  // A path ending in `agent` always names the seat, whatever is above it — the heartbeat's rule,
  // kept identical so the two extensions never disagree about who a sample belongs to.
  assert.equal(seatNameFromEnv({ PI_CODING_AGENT_DIR: "/h/pi/agent", OPENRIG_SESSION_NAME: "s" }), "pi");
  assert.equal(openrigHomeFromEnv({ OPENRIG_HOME: "/h" }), "/h");
});

test("the filename is sanitized exactly as OpenRig sanitizes it", () => {
  assert.equal(sidecarFilename("dev-build@claude-pi-duo"), "dev-build@claude-pi-duo.json");
  assert.equal(sidecarFilename("weird/name with spaces"), "weird_name_with_spaces.json");
});

// -- what the file says ----------------------------------------------------------------

test("a sample carries the shape OpenRig reads, with the reading it was given", (t) => {
  const home = tempHome(t);
  const writer = writerFor(home, { OPENRIG_OCCUPANT_GENERATION: "gen-00007" });
  const wrote = writer.write(fakeCtx({ tokens: 40_000, contextWindow: 200_000, percent: 20 }), "model_call");

  assert.equal(wrote, true);
  const sample = readSample(writer.file);
  assert.deepEqual(Object.keys(sample).sort(), [...SEAT_KEYS].sort());
  assert.deepEqual(Object.keys(sample.context_window).sort(), [...CONTEXT_WINDOW_KEYS].sort());
  assert.equal(sample.context_window.context_window_size, 200_000);
  assert.equal(sample.context_window.used_percentage, 20);
  assert.equal(sample.context_window.remaining_percentage, 80);
  assert.equal(sample.context_window.total_input_tokens, 40_000);
  assert.equal(sample.context_window.total_output_tokens, null);
  assert.deepEqual(sample.context_window.current_usage, {
    runtime: "pi",
    tokens: 40_000,
    context_window: 200_000,
    percent: 20,
  });
  assert.equal(sample.session_id, "pi-native-session-1");
  assert.equal(sample.session_name, "dev-test");
  assert.equal(sample.occupant_generation, "gen-00007");
  assert.equal(sample.transcript_path, "/tmp/pi/session.jsonl");
  assert.equal(sample.cost, null);
  assert.ok(!Number.isNaN(Date.parse(sample.sampled_at)), "sampled_at is a parseable timestamp");
});

test("the percentage is written rounded, as Claude's and Codex's writers write it", (t) => {
  const home = tempHome(t);
  const writer = writerFor(home);
  // Pi computes tokens / contextWindow * 100, which is a float. OpenRig prints used_percentage as
  // written in `rig ps --nodes`, `rig whoami` and `rig usage`; only the TUI rounds. Whole numbers
  // keep a Pi seat in the shape every other writer produces.
  writer.write(fakeCtx({ tokens: 79_800, contextWindow: 200_000, percent: 39.900000000000006 }), "model_call");
  const sample = readSample(writer.file);
  assert.equal(sample.context_window.used_percentage, 40);
  assert.equal(sample.context_window.remaining_percentage, 60);
  // The exact figure is kept where it is provenance, not a display value.
  assert.equal(sample.context_window.current_usage.percent, 39.900000000000006);
});

test("a percentage outside 0..100 is clamped, so a reader never sees -4% or 120%", (t) => {
  const home = tempHome(t);
  const low = writerFor(home);
  low.write(fakeCtx({ tokens: 0, contextWindow: 100, percent: -4 }), "model_call");
  assert.equal(readSample(low.file).context_window.used_percentage, 0);

  const high = writerFor(tempHome(t));
  high.write(fakeCtx({ tokens: 300, contextWindow: 100, percent: 120 }), "model_call");
  assert.equal(readSample(high.file).context_window.used_percentage, 100);
  assert.equal(readSample(high.file).context_window.remaining_percentage, 0);
});

test("no reading writes nothing rather than writing a zero", (t) => {
  const home = tempHome(t);
  const writer = writerFor(home);
  for (const ctx of [
    fakeCtx(undefined),
    fakeCtx({ tokens: null, contextWindow: 200_000, percent: null }),
  ]) {
    assert.equal(writer.write(ctx, "model_call"), false);
    assert.equal(writer.write(ctx, "session_start"), false);
  }
  assert.equal(realFs.existsSync(writer.file), false, "no sidecar for a reading that does not exist");
});

test("a compaction replaces a reading that is no longer true", (t) => {
  const home = tempHome(t);
  const writer = writerFor(home);
  writer.write(fakeCtx({ tokens: 190_000, contextWindow: 200_000, percent: 95 }), "model_call");
  assert.equal(readSample(writer.file).context_window.used_percentage, 95);

  // Pi reports an unknown context right after a compaction, before the next model response.
  const wrote = writer.write(fakeCtx({ tokens: null, contextWindow: 200_000, percent: null }), "compaction");
  assert.equal(wrote, true);
  const sample = readSample(writer.file);
  assert.equal(sample.context_window.used_percentage, null, "unknown, not the retired 95%");
  assert.equal(sample.context_window.total_input_tokens, null);
  assert.equal(sample.context_window.context_window_size, 200_000);
});

test("a missing session id or transcript path does not lose the reading", (t) => {
  const home = tempHome(t);
  const writer = writerFor(home);
  writer.write(fakeCtx({ tokens: 10, contextWindow: 100, percent: 10 }, { sessionId: null, sessionFile: null }), "model_call");
  const sample = readSample(writer.file);
  assert.equal(sample.session_id, null);
  assert.equal(sample.transcript_path, null);
  assert.equal(sample.context_window.used_percentage, 10);
});

// -- how the file is written -----------------------------------------------------------

test("the sidecar is replaced atomically: a temp file in its own directory, then a rename", (t) => {
  const home = tempHome(t);
  const fs = recordingFs();
  const writer = createSidecarWriter({ env: seatEnv(home), fs });

  assert.equal(writer.write(fakeCtx({ tokens: 1, contextWindow: 100, percent: 1 }), "model_call"), true);

  const mkdirs = fs.ops.filter((op) => op.startsWith("mkdir:"));
  const writes = fs.ops.filter((op) => op.startsWith("write:"));
  const renames = fs.ops.filter((op) => op.startsWith("rename:"));
  assert.equal(mkdirs.length, 1, "the directory is created once");
  assert.equal(writes.length, 1, "exactly one file is written");
  assert.equal(renames.length, 1, "the write lands by rename");

  const tmp = writes[0].slice("write:".length);
  assert.notEqual(tmp, writer.file, "the temp file is not the sidecar itself");
  assert.equal(path.dirname(tmp), path.dirname(writer.file), "the temp file is on the same filesystem");
  assert.match(path.basename(tmp), /^dev-test\.json\.\d+\..+\.tmp$/);
  assert.equal(renames[0], `rename:${tmp}->${writer.file}`);
  // The double never touched the disk, so the sample is read back from it rather than from the file.
  assert.deepEqual(JSON.parse(fs.files.get(writer.file) ?? "{}").context_window.used_percentage, 1);
});

test("a second sample replaces the first and leaves no temp file behind", (t) => {
  const home = tempHome(t);
  const writer = writerFor(home);
  writer.write(fakeCtx({ tokens: 1, contextWindow: 100, percent: 1 }), "model_call");
  writer.write(fakeCtx({ tokens: 50, contextWindow: 100, percent: 50 }), "model_call");

  assert.equal(readSample(writer.file).context_window.used_percentage, 50);
  assert.deepEqual(realFs.readdirSync(writer.dir), ["dev-test.json"], "no temp or partial files");
});

test("a failed write removes its temp file and reports nothing further", (t) => {
  const home = tempHome(t);
  const fs = recordingFs({ failOn: "write" });
  const logs: string[] = [];
  const writer = createSidecarWriter({ env: seatEnv(home), fs, log: (line) => logs.push(line) });

  assert.equal(writer.write(fakeCtx({ tokens: 1, contextWindow: 100, percent: 1 }), "model_call"), false);
  assert.ok(fs.ops.some((op) => op.startsWith("unlink:")), "the temp file is cleaned up");
  assert.ok(!fs.ops.some((op) => op.startsWith("rename:")), "nothing is renamed into place");
  assert.equal(realFs.existsSync(writer.file), false);
  assert.equal(logs.length, 1);
});

test("a failed rename removes its temp file too", (t) => {
  const home = tempHome(t);
  const fs = recordingFs({ failOn: "rename" });
  const logs: string[] = [];
  const writer = createSidecarWriter({ env: seatEnv(home), fs, log: (line) => logs.push(line) });

  assert.equal(writer.write(fakeCtx({ tokens: 1, contextWindow: 100, percent: 1 }), "model_call"), false);
  assert.ok(fs.ops.some((op) => op.startsWith("unlink:")));
  assert.equal(logs.length, 1);
});

test("writeAtomic removes the temp file when the rename fails on a real filesystem", (t) => {
  const home = tempHome(t);
  const dir = contextUsageDirectory(home);
  realFs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "target.json");
  // Renaming onto a directory fails, which stands in for any rename failure.
  realFs.mkdirSync(file, { recursive: true });
  assert.throws(() => writeAtomic(realFs as any, file, { context_window: {}, sampled_at: "x" } as any));
  assert.deepEqual(
    realFs.readdirSync(dir).filter((name) => name !== "target.json"),
    [],
    "no temp file survives a failed rename",
  );
});

// -- nothing here may break the seat ---------------------------------------------------

test("a throwing getContextUsage breaks nothing and keeps the last good sample", (t) => {
  const home = tempHome(t);
  const logs: string[] = [];
  const writer = createSidecarWriter({ env: seatEnv(home), log: (line) => logs.push(line) });
  writer.write(fakeCtx({ tokens: 100, contextWindow: 1000, percent: 10 }), "model_call");
  const before = realFs.readFileSync(writer.file, "utf-8");

  const threw = (() => {
    try {
      writer.write(fakeCtx(undefined, { throwOnGetContextUsage: true }), "model_call");
      return false;
    } catch {
      return true;
    }
  })();

  assert.equal(threw, false, "write() swallows the failure");
  assert.equal(realFs.readFileSync(writer.file, "utf-8"), before, "the previous sample is untouched");
  assert.equal(logs.length, 1, "the failure is at most logged");
  assert.match(logs[0], /model_call/);
});

test("a throwing read at a compaction still retires the reading it replaces", (t) => {
  const home = tempHome(t);
  const logs: string[] = [];
  const writer = createSidecarWriter({ env: seatEnv(home), log: (line) => logs.push(line) });
  writer.write(fakeCtx({ tokens: 190_000, contextWindow: 200_000, percent: 95 }), "model_call");
  assert.equal(readSample(writer.file).context_window.used_percentage, 95);

  // The read itself fails. Nothing escapes, and the stale 95% does not survive the compaction.
  assert.equal(writer.write(fakeCtx(undefined, { throwOnGetContextUsage: true }), "compaction"), true);
  const sample = readSample(writer.file);
  assert.equal(sample.context_window.used_percentage, null);
  assert.equal(sample.context_window.context_window_size, null);
  assert.equal(logs.length, 1, "the failed read is logged");
});

test("the reading is taken at turn_end, after Pi has saved the call it reports", (t) => {
  const home = tempHome(t);
  const saved = {
    OPENRIG_HOME: process.env.OPENRIG_HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    OPENRIG_SESSION_NAME: process.env.OPENRIG_SESSION_NAME,
  };
  try {
    process.env.OPENRIG_HOME = home;
    process.env.PI_CODING_AGENT_DIR = path.join(home, "state", "pi", "dev-test", "agent");
    process.env.OPENRIG_SESSION_NAME = "dev-test";

    const pi = fakePi();
    extension(pi);
    const file = path.join(home, "state", "context-usage", "dev-test.json");

    // Pi awaits extensions BEFORE it persists the assistant message, so at message_end the
    // projection still lacks the call being reported. The fake reproduces that: the reading only
    // advances when the message is saved, and turn_end is the event Pi dispatches afterwards (it
    // refuses to fire without a persisted entry). Sampling at message_end would leave every reading
    // one model call behind, which is what the review measured: Pi at 95%, sidecar at 40%.
    const projection = { tokens: 80_000, contextWindow: 200_000, percent: 40 };
    const ctx = {
      getContextUsage: () => ({ ...projection }),
      sessionManager: { getSessionId: () => "s", getSessionFile: () => "/s.jsonl" },
    };

    pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.equal(readSample(file).context_window.used_percentage, 40);

    // The model answers; the message is not saved yet, so the projection has not moved.
    assert.ok(
      !pi.handlers().includes("message_end"),
      "message_end must not be sampled: the call it reports is not persisted yet",
    );

    // Pi saves the message, then dispatches turn_end with the projection moved on.
    projection.tokens = 190_700;
    projection.percent = 95.35;
    pi.emit("turn_end", { type: "turn_end", message: { role: "assistant" }, willContinue: false }, ctx);

    assert.equal(readSample(file).context_window.used_percentage, 95, "the current call reaches the sidecar");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a throwing sessionManager lookup costs only the field it guards", (t) => {
  const home = tempHome(t);
  const ctx = fakeCtx({ tokens: 10, contextWindow: 100, percent: 10 });
  ctx.sessionManager.getSessionId = () => {
    throw new Error("session id exploded");
  };
  const writer = writerFor(home);
  assert.equal(writer.write(ctx, "model_call"), true);
  const sample = readSample(writer.file);
  assert.equal(sample.session_id, null);
  assert.equal(sample.context_window.used_percentage, 10);
});

test("an OPENRIG_HOME that cannot hold the file is logged, not thrown", (t) => {
  const home = tempHome(t);
  const blocker = path.join(home, "blocker");
  realFs.writeFileSync(blocker, "a file where a directory was needed");
  const logs: string[] = [];
  const writer = createSidecarWriter({
    env: {
      OPENRIG_HOME: path.join(blocker, "state"),
      PI_CODING_AGENT_DIR: path.join(home, "state/pi/dev-test/agent"),
    },
    log: (line) => logs.push(line),
  });
  assert.equal(writer.write(fakeCtx({ tokens: 1, contextWindow: 100, percent: 1 }), "model_call"), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /model_call/);
});

// -- who the writer will write for -----------------------------------------------------

test("a plain Pi session writes nothing at all, not even a file under the default home", (t) => {
  const home = tempHome(t);
  const logs: string[] = [];
  // No seat-shaped PI_CODING_AGENT_DIR and no OPENRIG_SESSION_NAME: the name would fall back to
  // pi-<pid> and the home to ~/.openrig, which is a file no seat ever reads.
  const writer = createSidecarWriter({
    env: { HOME: home },
    log: (line) => logs.push(line),
  });
  assert.equal(writer.managed, false);
  assert.match(writer.seat, /^pi-\d+$/);
  assert.equal(writer.write(fakeCtx({ tokens: 1, contextWindow: 100, percent: 1 }), "model_call"), false);
  assert.equal(writer.write(fakeCtx({ tokens: 1, contextWindow: 100, percent: 1 }), "session_start"), false);
  assert.equal(realFs.existsSync(contextUsageDirectory(home)), false, "no directory is created either");
});

test("the operator's own ~/.pi/agent is not a seat, even though it ends in `agent`", (t) => {
  const home = tempHome(t);
  const plain = { HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent") };
  assert.equal(seatIsManaged(plain), false);
  const writer = createSidecarWriter({ env: plain });
  assert.equal(writer.managed, false);
  assert.equal(writer.write(fakeCtx({ tokens: 1, contextWindow: 100, percent: 1 }), "model_call"), false);
  assert.equal(realFs.existsSync(contextUsageDirectory(home)), false);
});

test("seatIsManaged accepts the shapes OpenRig launches and rejects the ones it does not", () => {
  assert.equal(seatIsManaged({ PI_CODING_AGENT_DIR: "/h/state/pi/dev-build@my-rig/agent" }), true);
  assert.equal(seatIsManaged({ PI_CODING_AGENT_DIR: "/h/state/omp/dev-build@my-rig/agent" }), true);
  assert.equal(seatIsManaged({ OPENRIG_SESSION_NAME: "solo-seat" }), true);
  // A plain session's own agent directory, and anything that is not under a pi/omp state root.
  assert.equal(seatIsManaged({ PI_CODING_AGENT_DIR: "/home/op/.pi/agent" }), false);
  assert.equal(seatIsManaged({ PI_CODING_AGENT_DIR: "/somewhere/else/agent" }), false);
  assert.equal(seatIsManaged({ PI_CODING_AGENT_DIR: "/h/state/pi/.hidden/agent" }), false);
  assert.equal(seatIsManaged({ PI_CODING_AGENT_DIR: "/h/state/pi/agent" }), false);
  assert.equal(seatIsManaged({ PI_CODING_AGENT_DIR: "", OPENRIG_SESSION_NAME: "" }), false);
  assert.equal(seatIsManaged({}), false);
});

test("the extension registers nothing for a plain Pi session", () => {
  const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, OPENRIG_SESSION_NAME: process.env.OPENRIG_SESSION_NAME, OPENRIG_HOME: process.env.OPENRIG_HOME };
  try {
    process.env.PI_CODING_AGENT_DIR = "/home/op/.pi/agent";
    delete process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_HOME = "/home/op/.openrig";
    const pi = fakePi();
    extension(pi);
    assert.deepEqual(pi.handlers(), [], "no handlers, so no file can be written");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// -- how often it writes ---------------------------------------------------------------

test("the same reading twice in a row is one write; a changed reading always writes", (t) => {
  const home = tempHome(t);
  let clock = 1_000_000;
  const writer = createSidecarWriter({ env: seatEnv(home), now: () => clock, minIntervalMs: 1000 });

  assert.equal(writer.write(fakeCtx({ tokens: 10, contextWindow: 100, percent: 10 }), "model_call"), true);
  clock += 10;
  assert.equal(writer.write(fakeCtx({ tokens: 10, contextWindow: 100, percent: 10 }), "model_call"), false);
  clock += 10;
  assert.equal(writer.write(fakeCtx({ tokens: 20, contextWindow: 100, percent: 20 }), "model_call"), true);
  clock += 10;
  // A compaction is never throttled: the reading it replaces must not survive.
  assert.equal(writer.write(fakeCtx({ tokens: null, contextWindow: 100, percent: null }), "compaction"), true);
  clock += 10;
  assert.equal(writer.write(fakeCtx({ tokens: 20, contextWindow: 100, percent: 20 }), "model_call"), true);
});

// -- the extension's own registration --------------------------------------------------

test("the extension registers session start, turn end and compaction, and its handlers never throw", (t) => {
  const home = tempHome(t);
  const saved = {
    OPENRIG_HOME: process.env.OPENRIG_HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    OPENRIG_SESSION_NAME: process.env.OPENRIG_SESSION_NAME,
    OPENRIG_OCCUPANT_GENERATION: process.env.OPENRIG_OCCUPANT_GENERATION,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // The default export reads the process environment, so the test owns a private one.
  process.env.OPENRIG_HOME = home;
  process.env.PI_CODING_AGENT_DIR = path.join(home, "state", "pi", "dev-test", "agent");
  process.env.OPENRIG_SESSION_NAME = "dev-test";
  delete process.env.OPENRIG_OCCUPANT_GENERATION;

  const pi = fakePi();
  extension(pi);
  assert.deepEqual(
    [...pi.handlers()].sort(),
    ["session_compact", "session_start", "turn_end"],
  );

  const good = fakeCtx({ tokens: 10, contextWindow: 100, percent: 10 });
  const bad = fakeCtx(undefined, { throwOnGetContextUsage: true });
  const file = path.join(home, "state", "context-usage", "dev-test.json");

  pi.emit("session_start", { type: "session_start", reason: "startup" }, good);
  assert.equal(readSample(file).context_window.used_percentage, 10);

  pi.emit(
    "turn_end",
    { type: "turn_end", message: { role: "assistant" }, willContinue: false },
    fakeCtx({ tokens: 90, contextWindow: 100, percent: 90 }),
  );
  assert.equal(readSample(file).context_window.used_percentage, 90);

  pi.emit("session_compact", { type: "session_compact", reason: "manual", willRetry: false }, good);

  for (const ctx of [bad, undefined, {}, fakeCtx(undefined)]) {
    assert.doesNotThrow(() => pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx));
    assert.doesNotThrow(() => pi.emit("turn_end", { type: "turn_end", willContinue: false }, ctx));
    assert.doesNotThrow(() => pi.emit("session_compact", { type: "session_compact", reason: "manual" }, ctx));
  }
});

test("a broken pi object does not take the factory down", () => {
  assert.doesNotThrow(() => extension({} as any));
  assert.doesNotThrow(() => extension(null as any));
});
