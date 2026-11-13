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

## Scope and status

The native session plugin is unchanged. This companion is an initial visual prototype. Integration into a live owner dashboard, collector changes, global plugin installation, and fleet rollout are separate steps. Research findings are in [FORK_REVIEW.md](../docs/FORK_REVIEW.md).

MIT, under the repository license. Upstream lot-map is by Aleksei Volodin. The companion's independent owner graph does not import collectors from the compared forks.
