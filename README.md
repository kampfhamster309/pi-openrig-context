# pi-openrig-context

A Pi extension that writes a seat's context usage where OpenRig already looks for it, so a Pi seat
shows a context percentage instead of `? —`.

Pi knows its own context usage (`ctx.getContextUsage()`). OpenRig reads context usage from a
sidecar file that, until now, only Claude Code seats and OpenRig's own stub runtime produced. This
extension closes that gap from the Pi side.

It has no runtime dependencies — Node built-ins only — and it never imports OpenRig. It depends on
the file contract below, which is the whole coupling between the two repositories.

## What it writes

One file per seat:

```text
$OPENRIG_HOME/state/context-usage/<seat>.json
```

`<seat>.json` is the seat's OpenRig session name with every character outside `[A-Za-z0-9@._-]`
replaced by `_`, which is the rule OpenRig uses to name these files.

The seat is found the way the OpenRig heartbeat extension finds it: OpenRig sets
`PI_CODING_AGENT_DIR` to `$OPENRIG_HOME/state/pi/<seat>/agent`, so the seat is the name of that
directory's parent. `OPENRIG_SESSION_NAME` covers a seat launched without that directory, and a
plain Pi session with neither falls back to `pi-<pid>` rather than writing under someone else's
name. `OPENRIG_HOME` falls back to `~/.openrig`.

The body is the shape OpenRig's `ContextUsageStore` reads:

```json
{
  "context_window": {
    "context_window_size": 200000,
    "used_percentage": 20,
    "remaining_percentage": 80,
    "total_input_tokens": 40000,
    "total_output_tokens": null,
    "current_usage": { "runtime": "pi", "tokens": 40000, "context_window": 200000, "percent": 20 }
  },
  "session_id": "pi-native-session-id",
  "session_name": "dev-build@my-rig",
  "occupant_generation": "…",
  "transcript_path": "/path/to/pi/session.jsonl",
  "cost": null,
  "sampled_at": "2026-10-25T09:53:07.582Z"
}
```

Where a value comes from:

| field | source |
| --- | --- |
| `context_window_size` | `getContextUsage().contextWindow` |
| `used_percentage` | `getContextUsage().percent`, clamped to 0..100 and rounded to a whole number |
| `remaining_percentage` | `100 - used_percentage` |
| `total_input_tokens` | `getContextUsage().tokens` — what is in the window |
| `total_output_tokens` | always `null`: Pi's context usage does not split output out |
| `current_usage` | the raw Pi reading, tagged `runtime: "pi"` for provenance |
| `session_id` | `ctx.sessionManager.getSessionId()` |
| `session_name` | the seat name, as above |
| `occupant_generation` | `OPENRIG_OCCUPANT_GENERATION`, set by OpenRig at launch |
| `transcript_path` | `ctx.sessionManager.getSessionFile()` |
| `cost` | always `null`: Pi's context usage carries no cost figure |
| `sampled_at` | this write's timestamp |

An unknown value stays `null`. It never becomes `0`, because a zero reads as an empty context.

## When it writes

Three moments, and nothing else:

- `session_start`
- `turn_end` — that is, after each model call
- `session_compact`

`turn_end` and not `message_end`, deliberately: Pi awaits extensions before it persists the assistant
message, so at `message_end` the context still lacks the very call being reported and every reading
would lag one call behind — Pi would show 95% while the sidecar said 40%. `turn_end` is dispatched
only once the message has a persisted entry, which is the reading Pi itself shows.

Nothing is written while tokens stream, so the extension adds no per-token work to the seat. Two
writes of the same percentage within one second collapse into one; a changed percentage always
writes, and a compaction always writes because the reading it replaces is the one that must not
survive.

The percentage is written rounded to a whole number. Pi computes `tokens / contextWindow * 100`,
which is a float such as `39.900000000000006`, and OpenRig prints `used_percentage` as written in
`rig ps --nodes`, `rig whoami` and `rig usage` (only the TUI rounds). Claude's status line and
OpenRig's own Codex normaliser hand over whole numbers, so the writer rounds to keep a Pi seat in the
same shape. The exact figure stays in `current_usage.percent`.

Pi reports an unknown context immediately after a compaction, before the next model response. In
that case the extension writes an explicit "no reading" sample (`used_percentage: null`) rather
than leaving the pre-compaction percentage standing as if it were still current — a stale 95% after
a compaction is worse than an honest unknown. At the other two moments, an unknown reading writes
nothing at all, so a good sample is never replaced by an empty one.

## No seat, no file

A plain Pi session that loaded this extension from a user extensions directory is not an OpenRig
seat. Writing anyway would put a file named `pi-<pid>.json` under `~/.openrig/state/context-usage/`
— one per process, never cleaned, read by no seat. So the extension registers nothing at all when it
cannot name a real seat.

A seat is recognised when `PI_CODING_AGENT_DIR` has the shape OpenRig launches —
`…/state/pi/<seat>/agent`, or `…/state/omp/<seat>/agent` for an Oh My Pi seat — or when
`OPENRIG_SESSION_NAME` is set **and** `OPENRIG_RUNTIME` is `pi` or `omp`. The operator's own
`~/.pi/agent` ends in `agent` too, but it is not under a `pi` state root, so it is not a seat and
nothing is written.

The runtime check is there because OpenRig sets `OPENRIG_SESSION_NAME` in *every* seat's environment,
for every runtime. A plain `pi` started from inside a Claude Code seat's shell therefore inherits that
seat's name; taking it would overwrite the sidecar OpenRig reads as that Claude seat's own usage, and a
wrong-but-plausible number is worse than none. So an inherited name counts only under a Pi or omp
runtime, and a non-seat-shaped `PI_CODING_AGENT_DIR` never lends its grandparent directory name. This
deliberately departs from the heartbeat extension's naming fallback: the heartbeat writes a different,
harmless file, while a sidecar under a borrowed name is read as another seat's data.

## Failure behaviour

Telemetry must not be able to break a session, so every failure is swallowed: a
`getContextUsage()` that throws, a session manager whose getters throw, a directory that cannot be
created, a disk that is full. The last good sample is left in place, the write reports failure
internally, and nothing reaches the seat. The one exception is a compaction: there the retired
reading is the thing that must not survive, so a failed read still writes the explicit unknown
sample rather than leaving a stale percentage standing.

Failures are logged only when you ask for it:

```bash
OPENRIG_CONTEXT_TELEMETRY_DEBUG=1 pi
```

Lines go to stderr as `[openrig][context-usage] …`. Without that variable the extension is silent.

## Install

Any of these is enough; pick the scope you want. Pi loads TypeScript extensions directly, so there is
nothing to build.

**One run, to try it:**

```bash
pi --extension ./extensions/openrig-context-usage.ts
```

**Your own Pi seats** — drop it in the user extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/openrig-context-usage.ts ~/.pi/agent/extensions/
```

**As a package** (this repository is a Pi package; `package.json` declares the extension):

```bash
pi install /path/to/pi-openrig-context
```

**One OpenRig seat, or a seat inside a container image.** A seat managed by OpenRig keeps its own Pi
directory at `$OPENRIG_HOME/state/pi/<seat>/agent`, so its extensions directory is
`$OPENRIG_HOME/state/pi/<seat>/agent/extensions`. Pi's own mechanism reaches exactly that seat too:

```bash
PI_CODING_AGENT_DIR="$OPENRIG_HOME/state/pi/<seat>/agent" pi install /path/to/pi-openrig-context
```

Either way it is one seat, and it is the shape a pod image or a kit would follow.

> Installing into `~/.pi/agent` changes your own plain Pi sessions, not OpenRig's seats: a managed
> seat runs with its own `PI_CODING_AGENT_DIR` and resolves its user extensions from there. A plain
> session that loads this extension writes nothing at all (see "No seat, no file"), so this is a
> question of whose sessions get a reading, not of stray files.

How OpenRig should deliver this extension to the seats it starts — and whether it should provision it
automatically the way it provisions a Claude Code seat's collector — is an OpenRig-side decision, so
this repository does not assume an answer. OpenRig does not depend on this repository in any
direction; the sidecar file is the entire interface.

## Verify it

1. Start a Pi seat that loaded the extension and send it one message.
2. Read the sidecar:

   ```bash
   cat "$OPENRIG_HOME/state/context-usage/<seat>.json"
   ```

   `used_percentage` should match the percentage Pi itself shows, and `sampled_at` should be recent.
3. Compact the session and read it again: the sample is refreshed, and it matches Pi's own reading
   once the next model call has been made.
4. On the OpenRig side, the seat's context percentage comes from this file. OpenRig reads this
   sidecar for Claude Code and stub seats today; the matching OpenRig change is what makes its
   context monitor include Pi seats, show them in the fleet summary and `rig usage`, and keep a Pi
   sample out of the compaction path.

## Tests

```bash
npm test
```

They run without Pi: a fake `pi` collects the registered handlers, a fake `ctx` supplies
`getContextUsage()`, and every write goes to a temporary `OPENRIG_HOME` under the OS temp
directory. They cover the path and the field shape, the sanitised filename, the seat-name resolution,
the write-then-rename replacement and its temp-file cleanup, a `getContextUsage()` that throws, a
filesystem that fails, the unknown-reading rules, and the throttle.

Node 22.6 or newer (the tests use Node's built-in test runner with TypeScript type-stripping).

## Layout

```text
extensions/openrig-context-usage.ts   the extension
test/openrig-context-usage.test.ts    the tests
```

## License

MIT. See [LICENSE](LICENSE).
