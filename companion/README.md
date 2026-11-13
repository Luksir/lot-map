# Owner snapshot viewer

`owner-view.html` is a small, read-only browser companion for persistent-owner relationships. It uses lot-map's radial visual language but represents owners rather than stations within one Claude session.

## Running the preview

Serve `owner-view.html` beside a private `owner-snapshot.json` on an existing protected web host. Open the HTML page. It requests that one JSON file on the same origin, does not contact any external service, and does not change agents or their records. No framework, package installation, new server, watcher, or daemon is required.

The data file is deliberately excluded from Git. Keep it outside a public checkout in normal use, and publish only the page and selected sanitized data to an audience already authorized to see it. A missing or invalid file should show an unavailable state rather than invented activity.

This is a snapshot prototype, not continuous telemetry. The capture time and the older source observation times remain visible. A page reload reads the same snapshot until an authorized existing producer replaces it.

## Data contract

The page expects `schema_version: 1`, `mode: "snapshot"`, a UTC `captured_at`, and the following arrays. See the page's adapter for field-level rendering.

- `owners`: stable role IDs and display names, runtime and current session identity, recorded and observed activity states, source observation time, and owner start time.
- `relationships`: relationships declared by the existing owner register; these are not observed conversations.
- `routing`: grouped routing decisions, including source and target roles where resolved, timestamps and counts. Permission to route does not prove sending or receipt.
- `requests`: numbered request observations with source and target identities where resolved, first observation time, and optional collector-matched reply metadata. Matching is not independently verified work completion.
- `source`: health, coverage limits and source timestamps.

Unresolved identities remain unresolved. Historical events should be attributed using identity history at the event time rather than silently reassigned to today's session. Raw messages, prompts, command lines, credentials and transcript content are unnecessary for this view.

## Session frame

`session-frame.ts` turns one Claude Code transcript, named by the caller, into the lot-map picture of that session as one JSON object, so a dashboard can show a session as a live map without loading the plugin into it. It reads only that file: it never picks "the newest" session and never lists a folder. It makes no network requests, writes no files, starts no processes and needs no npm package (Node 24, built-ins only).

```bash
node companion/session-frame.ts --transcript /path/to/session.jsonl [--tail-bytes N] [--now <epoch ms>] \
    [--theme dark|light] [--stale-after-s N] [--language en]
```

- `--tail-bytes` (default 8 MiB): read only the end of the file, from its first whole line. Counts and rows cover that part only.
- `--now`: the time to judge freshness and draw the picture at (default: the clock).
- `--theme`: without it the picture follows the viewer's light or dark preference (`auto`).
- `--stale-after-s` (default 600): how long unfinished work counts as running without a new transcript row.
- `--language`: one of the plugin's languages for the map and rows (`en`, `ru`, `es`, `fr`, `de`, `it`, `pt`).

Tests: `node --test companion/session-frame.test.mjs` (or plain `node --test` from the repository root). They are plain JavaScript because `claude plugin test` loads every `*.test.ts` as a hooks module, and they run the command on small synthetic transcripts.

### Contract

Exit 0 and one JSON line on stdout:

| Field | Meaning |
| --- | --- |
| `schema` | `1` |
| `session_id` | the session id the rows carry, or `null` |
| `svg` | `drawMap(board, now, setup)` from the plugin's own `hooks/draw.ts` |
| `now_line` | `describeNow(board, strings)`; when stale it is prefixed `Activity unknown: no new transcript row for …. Last seen:` |
| `rows` | `foldRows()` of the board, newest last, at most 16: `{mark, station, label, from, status, times, took_ms, started_at}`. `station` is the station id, `from` is `core`, `agents` or `inbound`, `took_ms` is `null` while a call runs, and an answer's row carries the whole turn's time as the pane does |
| `context_pct` | always `null` from a transcript: it records tokens, not the window's size |
| `model` | short model name of the main loop (`opus 5.5`) or `null` |
| `counts` | calls per station inside the part that was read |
| `agents_running` | subagents started and not reported finished |
| `last_event_at` | time of the newest row read |
| `observed_at` | when the command ran |
| `activity` | `running`, `idle` or `unknown` |
| `stale` | `true` when unfinished work has had no new row for longer than `--stale-after-s` |
| `coverage` | plain sentences: what part was read and what a transcript cannot show |

Exit 2 and `{"error": "..."}` for a missing, unreadable or empty transcript, a tail with no whole line, a file with no timed rows, or bad arguments. There is no partial picture.

**Honest state.** A call without a result is `run` only while the newest row is younger than `--stale-after-s`. Past that, `activity` is `unknown`, `stale` is `true`, such rows read `status: "unknown"` with mark `?` (the one value outside the plugin's own `run|ok|err|block` and `● · ✕ ◆`), and the picture is drawn still (reduced motion) as of the last row. A session whose last turn ended and has nothing open is `idle`, however old.

**Labels.** Every label comes from the plugin's `classify` or its own words, so the mod's privacy rule holds: a name, never content (no command line, query, file text, or path beyond its last two parts). The command adds no label of its own.

### What a transcript shows and does not

- Turns: a person's message (or a message another session sent in) opens a turn; the `turn_duration` system row ends it. The summary written after a compaction is not a message; the compaction is a row on Model.
- Subagents: rows marked `isSidechain` start from Agents. Subagents that write their own transcript files are not read; their work shows as the `Agent` call that started them, open until its result or its task notification.
- Hooks: only what the transcript records: a check of 400 ms or more before a call, a hook that stopped a call, and context a hook added at session start or to a message. Permission asks and hook output are not shown.
- Between a tool result and the model's next written step nothing is open on the board, so `now_line` may say nothing is running while `activity` is `running` (the turn has not ended).
- Calls that began before the part read are not shown; their results are counted in `coverage`.

### Where the ideas come from

All MIT, from forks of alexeyw/lot-map; no fork code was run, and the header of `session-frame.ts` says the same.

- [Samuel-VV-NL/lot-map](https://github.com/Samuel-VV-NL/lot-map/blob/main/companion/server.mjs): transcript to Board, the frame `{svg, now, session, rows}`, and adding `.ts` to the plugin's extensionless imports (rewritten with `node:module` `registerHooks`, limited to imports from `hooks/`). Not used: its newest-session targeting, HTTP server, browser launch and Wiki station.
- [chrisw-impactlab/lot-map `dev-session-viewer`](https://github.com/chrisw-impactlab/lot-map/tree/dev-session-viewer): viewing one named session and its subagents from the transcript, steps keyed by request id, the turn's end and compaction rows.
- [isbeorn/lot-map](https://github.com/isbeorn/lot-map/blob/main/codex/activity.ts): unfinished activity with old evidence reads unknown, drawn as of the last evidence. Its timing lanes (`drawLanes`) are not built here, so the `lanes` key is absent: they would need a renderer that upstream does not have.

## Scope and status

The native session plugin is unchanged. This companion is an initial visual prototype. Integration into a live owner dashboard, collector changes, global plugin installation, and fleet rollout are separate steps. Research findings are in [FORK_REVIEW.md](../docs/FORK_REVIEW.md).

MIT, under the repository license. Upstream lot-map is by Aleksei Volodin. The companion's independent owner graph does not import collectors from the compared forks.
