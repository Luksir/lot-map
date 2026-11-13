# Fork review

Research date: **2026-11-13**. Baseline: upstream [lot-map 0.6.0](https://github.com/alexeyw/lot-map/commit/d3102bf5f16d13b1a3061eb6e63ab10c27e6907d), commit `d3102bf5f16d13b1a3061eb6e63ab10c27e6907d`.

## Coverage

The [public fork listing](https://api.github.com/repos/alexeyw/lot-map/forks?per_page=100) returned **70 visible forks** while upstream advertised 72. All 70 default branches were compared with the pinned baseline: **7 contained ahead commits; 63 were identical or behind**, with no comparison errors. All **114 visible branches** were listed, and 19 additional unique heads were compared.

Ahead counts describe Git history, not feature quality. Squash-merged contribution branches can remain ahead after their features enter upstream. Private, unavailable or subsequently changed work is outside this snapshot.

## Additions worth examining

| Fork | Source-observed addition | Assessment |
| --- | --- | --- |
| [Command Mesh](https://github.com/Deemer15/command-mesh) | Multi-provider grid, browser dashboard, timeline, filtering and event inspector | Useful overview design. Its documented timeout-based completion, attribution shortcuts and prompt/argument retention need separate review. |
| [isbeorn](https://github.com/isbeorn/lot-map) | Timing lanes, subagent lanes, Codex MCP App, explicit session selection, pause and stale-state handling | Strong patterns for session identity and uncertainty. The Codex adapter is additional infrastructure. |
| [Samuel-VV-NL](https://github.com/Samuel-VV-NL/lot-map/blob/main/companion/server.mjs) | Small browser companion and Wiki station | Smallest standalone browser presentation inspected. Its newest-session selection and transcript-only coverage are unsuitable as general coordination semantics. |
| [nick-monto](https://github.com/nick-monto/pi-lot-map) | pi/omp adapters, browser SVG view and session-named windows | Useful browser/session presentation; provider-specific integration. |
| [dgfisher2021](https://github.com/dgfisher2021/claude-code-lot-map) | Terminal raster, Chromium pictures and separate Sixel window | Broader terminal compatibility, with extra processes and dependencies. |
| [davidkinsler](https://github.com/davidkinsler/lot-map/commits/main/) | Station drilldowns, operation labels and redraw-on-change | Useful interaction ideas; some historical Windows fixes already entered upstream. |
| [harrywkeppler](https://github.com/harrywkeppler/lot-map/commits/main/) | Animated particle orb | Decorative extension with limited operational value. |

### Notable work outside default branches

- [chrisw-impactlab: dev-session-viewer](https://github.com/chrisw-impactlab/lot-map/tree/dev-session-viewer#viewer): explicit selection of another session and its subagents. Transcript-only coverage omits context capacity and hook details.
- [zeeneddie: feat/werkinzicht](https://github.com/zeeneddie/lot-map/blob/feat/werkinzicht/CHANGELOG.md): configured, loaded and used capabilities; instruction origins, missing MCP reasons and skill-to-file relationships. Its optional `askWhy` changes the system prompt; [privacy documentation](https://github.com/zeeneddie/lot-map/blob/feat/werkinzicht/PRIVACY.md) also describes retained model-summary snippets.
- [bimtauer: herdr-omp](https://github.com/bimtauer/lot-map/blob/herdr-omp/herdr/README.md): native Herdr/OMP view. [markdotdigital: antigravity](https://github.com/markdotdigital/lot-map/tree/antigravity): Antigravity sidecar. Both are separate provider integrations.
- [buddyatkins: terminal-all](https://github.com/buddyatkins/lot-map/tree/terminal-all): alternate terminal layouts. Its narrower [picture contribution](https://github.com/alexeyw/lot-map/pull/33) is already upstream. [Obsessi0n](https://github.com/Obsessi0n/lot-map/tree/rpg) also has braille and dungeon-style experiments.
- [PR49](https://github.com/alexeyw/lot-map/pull/49): proposed automatic light-terminal theme fix. [PR42](https://github.com/alexeyw/lot-map/pull/42): proposed SVG accessibility attribute.
- [PR38](https://github.com/alexeyw/lot-map/pull/38) is **closed, unmerged**: the maintainer identified an unconnected adapter and ineffective reduced-motion behavior. It is not evidence of working multi-host support.

The independently published [Ume derivative](https://github.com/wallyborba/ume-lot-map) is outside GitHub's fork network and changes branding, palette, logo and typography.

## Recommended direction

Research judgment: retain the current upstream baseline and borrow narrow presentation patterns: **browser rendering, explicit session selection, timing lanes and drilldowns**. No persistent-owner interaction graph backed by existing coordination records was identified in this scan.

Samuel's companion uses Node built-ins and the existing renderer, requires Node 22.18 or later, and carries the [MIT license](https://github.com/Samuel-VV-NL/lot-map/blob/main/LICENSE). Its presentation contract is `{svg, now, session, rows}`; collecting transcripts is separable from drawing. The current [renderer facade](https://github.com/alexeyw/lot-map/blob/main/hooks/map.ts) and [Board types](https://github.com/alexeyw/lot-map/blob/main/types/index.d.ts) remain reusable. Preserve attribution when reusing code.

Owner relationships should be a distinct view: a session's tool stations, subagents, declared relationships, observed messages and completed outcomes mean different things. Evidence age and missing coverage must remain visible.

## Adopted in this fork

The plugin itself (`hooks/`, `.claude-plugin/`, `types/`) is kept identical to upstream 0.6.0, so upstream releases merge without conflicts. What was adopted lives in `companion/session-frame.ts`, a read-only command that draws one named transcript with the plugin's own renderer ([usage and contract](../companion/README.md#session-frame)):

| Idea | From | How it is used here |
| --- | --- | --- |
| The map in a browser: a frame of `{svg, now, session, rows}` built from a transcript | [Samuel-VV-NL](https://github.com/Samuel-VV-NL/lot-map/blob/main/companion/server.mjs) | The frame contract and the resolver that lets Node load the plugin's files. No server, no polling, no browser launch: the caller asks for a frame when it wants one. |
| Viewing another, explicitly named session | [chrisw-impactlab: dev-session-viewer](https://github.com/chrisw-impactlab/lot-map/tree/dev-session-viewer#viewer) | The transcript is always named by the caller. The command never picks "the newest session" and never lists a folder. Helper calls start from the Agents station. |
| Unfinished work that has gone quiet reads as unknown, not as running | [isbeorn](https://github.com/isbeorn/lot-map) | `activity: unknown` and `stale: true` after ten minutes without a new row; the picture is drawn still, as of the last row. |

Left out, with the reason:

- **Timing lanes** (isbeorn): upstream has no lane renderer, so this would be a second drawing to maintain. The rows carry start time and duration, which a page can lay out itself.
- **Station drilldowns** (davidkinsler): they change the plugin's pane. A page that shows the frame can open a row on its own.
- **Other providers and terminals** (Command Mesh, pi/omp, Herdr, Antigravity, terminal rasters): separate integrations with their own processes and dependencies.
- **Collectors that guess** (newest-session targeting, timeout-based completion, attribution to the last provider): they state more than the records prove.
- **`askWhy`** (zeeneddie): it changes the system prompt, and the mod must watch and change nothing.
- **Open upstream pull requests** ([#49](https://github.com/alexeyw/lot-map/pull/49), [#42](https://github.com/alexeyw/lot-map/pull/42)): they belong to upstream's own review; they arrive here with the release that merges them.

Checked on Claude Code 2.1.323/Linux and Node 24: the plugin's 71 tests and validation still pass with the companion in the tree; the command's 12 tests pass; a 115 MB transcript is drawn in under a second from its last 8 MiB.

## Verification boundary

Fork findings above come from source, diffs, documentation and PR discussions; these extensions were **not installed or runtime-validated in this review**.

Separately, the pinned upstream baseline passed plugin validation and **71 tests on Claude Code 2.1.323/Linux**. Validation reported a marketplace-description warning. Those checks do not establish that any fork extension or owner-view integration works.
