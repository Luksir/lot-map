// The session frame, run as a command on small made-up transcripts. Run with: node --test companion/session-frame.test.mjs
// Plain JavaScript on purpose: `claude plugin test` loads every *.test.ts as a hooks module.
// Every fixture here is synthetic: no real transcript text is in this file.
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('./session-frame.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'session-frame-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const T0 = Date.parse('2026-01-01T10:00:00.000Z')
const at = s => new Date(T0 + s * 1000).toISOString()
const SID = '00000000-0000-4000-8000-000000000001'

const base = (s, extra) => ({ sessionId: SID, isSidechain: false, timestamp: at(s), ...extra })
const human = (s, text = 'please look at the build') =>
  base(s, { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } })
const call = (s, req, id, name, input, extra = {}) =>
  base(s, {
    type: 'assistant',
    requestId: req,
    message: { id: `msg_${req}`, model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
    ...extra,
  })
const answer = (s, req, extra = {}) =>
  base(s, {
    type: 'assistant',
    requestId: req,
    message: { id: `msg_${req}`, model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    ...extra,
  })
const result = (s, id, isError = false, extra = {}) =>
  base(s, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'output' }] }, ...extra })
const turnEnd = s => base(s, { type: 'system', subtype: 'turn_duration', durationMs: 1000 })

let n = 0
function transcript(rows, tail = '') {
  const path = join(dir, `t${++n}.jsonl`)
  writeFileSync(path, rows.map(r => `${JSON.stringify(r)}\n`).join('') + tail)
  return path
}

/** The command's exit code, its stdout, and the one JSON object on it. */
function run(args) {
  const ran = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  const lines = ran.stdout.trim().split('\n')
  assert.equal(lines.length, 1, `one JSON line on stdout, got: ${ran.stdout.slice(0, 200)} ${ran.stderr.slice(0, 400)}`)
  return { code: ran.status, out: ran.stdout, frame: JSON.parse(lines[0] ?? '') }
}
const frameOf = (path, nowS, extra = []) => run(['--transcript', path, '--now', String(T0 + nowS * 1000), ...extra])

test('a call with no result yet, written moments ago, reads as running', () => {
  const path = transcript([human(0), call(1, 'r1', 'tu1', 'Bash', { command: 'make test', description: 'Run the tests' })])
  const { code, frame } = frameOf(path, 5)
  assert.equal(code, 0)
  assert.equal(frame.schema, 1)
  assert.equal(frame.session_id, SID)
  assert.equal(frame.activity, 'running')
  assert.equal(frame.stale, false)
  const last = frame.rows[frame.rows.length - 1]
  assert.deepEqual([last?.mark, last?.station, last?.label, last?.status, last?.took_ms], ['●', 'shell', 'Run the tests', 'run', null])
  assert.match(frame.now_line, /^Shell: Run the tests/)
  assert.match(frame.svg, /^<svg /)
  assert.equal(frame.model, 'opus 5.5')
  assert.equal(frame.last_event_at, at(1))
})

test('a finished call and a failed call close with their times, and an ended turn reads as idle', () => {
  const path = transcript([
    human(0),
    call(1, 'r1', 'tu1', 'Read', { file_path: '/repo/src/app.ts' }),
    result(3, 'tu1'),
    call(4, 'r2', 'tu2', 'Bash', { command: 'false', description: 'Try the build' }),
    result(6, 'tu2', true),
    answer(7, 'r3'),
    turnEnd(8),
  ])
  const { code, frame } = frameOf(path, 9)
  assert.equal(code, 0)
  const files = frame.rows.find(r => r.station === 'files')
  assert.deepEqual([files?.mark, files?.label, files?.status, files?.took_ms], ['·', 'src/app.ts', 'ok', 2000])
  const shell = frame.rows.find(r => r.station === 'shell')
  assert.deepEqual([shell?.mark, shell?.status, shell?.took_ms], ['✕', 'err', 2000])
  const done = frame.rows[frame.rows.length - 1]
  assert.deepEqual([done?.station, done?.label, done?.took_ms], ['you', 'answer ready', 8000])
  assert.equal(frame.activity, 'idle')
  assert.equal(frame.stale, false)
  assert.equal(frame.counts.files, 1)
  assert.equal(frame.counts.shell, 1)
  assert.equal(frame.rows.some(r => r.status === 'run'), false)
})

test('a subagent call (isSidechain) starts from Agents, not from the main loop', () => {
  const side = { isSidechain: true, agentId: 'agent-1' }
  const path = transcript([
    human(0),
    call(1, 'r1', 'tu1', 'Agent', { description: 'Survey the parser', prompt: 'long instructions' }),
    call(2, 's1', 'tu2', 'Grep', { pattern: 'needle' }, side),
  ])
  const { frame } = frameOf(path, 4)
  const grep = frame.rows.find(r => r.station === 'files')
  assert.deepEqual([grep?.label, grep?.from, grep?.status], ['Grep', 'agents', 'run'])
  const sideStep = frame.rows.find(r => r.station === 'model' && r.from === 'agents')
  assert.match(sideStep?.label ?? '', /· subagent$/)
  const agent = frame.rows.find(r => r.station === 'agents')
  assert.deepEqual([agent?.label, agent?.from], ['Survey the parser', 'core'])
  assert.equal(frame.agents_running, 1)
  assert.equal(frame.activity, 'running')
})

test('a background subagent stays open until its notification reports it finished', () => {
  const path = transcript([
    human(0),
    call(1, 'r1', 'tu1', 'Agent', { description: 'Check the docs', run_in_background: true }),
    result(2, 'tu1', false, { toolUseResult: { status: 'async_launched', agentId: 'bg-agent-7' } }),
    answer(3, 'r2'),
    turnEnd(4),
  ])
  const going = frameOf(path, 5).frame
  assert.equal(going.rows.find(r => r.station === 'agents')?.status, 'run')
  assert.equal(going.activity, 'running')
  const notified = transcript([
    human(0),
    call(1, 'r1', 'tu1', 'Agent', { description: 'Check the docs', run_in_background: true }),
    result(2, 'tu1', false, { toolUseResult: { status: 'async_launched', agentId: 'bg-agent-7' } }),
    answer(3, 'r2'),
    turnEnd(4),
    base(30, { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification><task-id>bg-agent-7</task-id><status>completed</status><summary>secret summary</summary></task-notification>' } }),
  ])
  const done = frameOf(notified, 31).frame
  assert.equal(done.rows.find(r => r.station === 'agents')?.status, 'ok')
  assert.equal(done.agents_running, 0)
  assert.equal(done.activity, 'idle')
  assert.equal(done.counts.you, 2, 'the notification is no new message')
})

test('the summary written after a compaction is not a message from a person', () => {
  const path = transcript([
    human(0),
    answer(1, 'r1'),
    turnEnd(2),
    base(10, { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto' } }),
    base(9, { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation. Summary of private work.' } }),
  ])
  const { out, frame } = frameOf(path, 11)
  assert.equal(frame.rows.filter(r => r.label === 'new message').length, 1)
  assert.equal(frame.counts.you, 2, 'one message and one answer')
  assert.ok(frame.rows.some(r => r.station === 'model' && r.label === 'compacting context'))
  assert.equal(frame.activity, 'idle')
  assert.equal(out.includes('Summary of private work'), false)
})

test('an unfinished call whose newest row is older than --stale-after-s reads unknown and stale, not running', () => {
  const path = transcript([human(0), call(1, 'r1', 'tu1', 'Bash', { command: 'sleep 9999', description: 'Wait for the deploy' })])
  const { code, frame } = frameOf(path, 1 + 601)
  assert.equal(code, 0)
  assert.equal(frame.activity, 'unknown')
  assert.equal(frame.stale, true)
  const last = frame.rows[frame.rows.length - 1]
  assert.deepEqual([last?.status, last?.mark], ['unknown', '?'])
  assert.equal(frame.rows.some(r => r.status === 'run'), false)
  assert.match(frame.now_line, /^Activity unknown: no new transcript row for 10 min\. Last seen: Shell: Wait for the deploy/)
  assert.ok(frame.coverage.some(c => /not confirmed as running/.test(c)))
  // A shorter limit, the same file: stale sooner.
  assert.equal(frameOf(path, 1 + 61, ['--stale-after-s', '60']).frame.stale, true)
  assert.equal(frameOf(path, 1 + 59, ['--stale-after-s', '60']).frame.activity, 'running')
})

test('an idle session stays idle however old its last row is', () => {
  const path = transcript([human(0), answer(1, 'r1'), turnEnd(2)])
  const { frame } = frameOf(path, 86_400)
  assert.deepEqual([frame.activity, frame.stale], ['idle', false])
})

test('a missing, empty or unreadable transcript and bad arguments exit 2 with an error object', () => {
  const missing = run(['--transcript', join(dir, 'no-such-file.jsonl')])
  assert.equal(missing.code, 2)
  assert.deepEqual(missing.frame, { error: 'transcript not found' })
  const emptyPath = transcript([])
  assert.equal(run(['--transcript', emptyPath]).code, 2)
  assert.equal(run(['--transcript', emptyPath]).frame.error, 'transcript is empty')
  const garbage = transcript([], 'not json at all\n{"also": "no time"}\n')
  assert.equal(run(['--transcript', garbage]).code, 2)
  assert.equal(run(['--transcript', dir]).frame.error, 'transcript is not a regular file')
  assert.equal(run([]).code, 2)
  assert.equal(run(['--transcript', garbage, '--theme', 'purple']).code, 2)
  assert.equal(run(['--transcript', garbage, '--tail-bytes', '-5']).code, 2)
  assert.equal(run(['--transcript', garbage, '--wat', '1']).code, 2)
})

test('a tail that starts mid-line drops that line, and a half-written last line is left for the next read', () => {
  const rows = [human(0), call(1, 'r1', 'tu1', 'Read', { file_path: '/a/b/c.txt' }), result(2, 'tu1'), answer(3, 'r2'), turnEnd(4)]
  const whole = rows.map(r => `${JSON.stringify(r)}\n`).join('')
  const lastTwo = rows.slice(-2).map(r => `${JSON.stringify(r)}\n`).join('')
  const half = '{"type":"assistant","timestamp":"2026-01-01T10:00:0'
  const path = transcript(rows, half)
  // Cut five bytes into the third row from the end: that row is dropped, the last two are read.
  const cut = Buffer.byteLength(lastTwo) + Buffer.byteLength(JSON.stringify(rows[2])) + 1 - 5 + Buffer.byteLength(half)
  const { code, frame } = frameOf(path, 5, ['--tail-bytes', String(cut)])
  assert.equal(code, 0)
  assert.match(frame.coverage[0] ?? '', /^Read the last .* from the first whole line: 2 rows with a time/)
  assert.ok(frame.coverage.some(c => /still being written/.test(c)))
  assert.equal(frame.coverage.some(c => /could not be read/.test(c)), false)
  assert.equal(frame.counts.files, undefined, 'the call before the cut is not counted')
  assert.equal(frame.activity, 'idle')
  // Whole file: everything is read.
  const all = frameOf(path, 5, ['--tail-bytes', String(Buffer.byteLength(whole) + 1000)]).frame
  assert.match(all.coverage[0] ?? '', /^Read the whole file/)
  assert.equal(all.counts.files, 1)
})

test('no label or any other part of the frame holds a command line, a query, file text or a path beyond its last two parts', () => {
  const path = transcript([
    human(0, 'my password is hunter2-PERSON-TEXT'),
    call(1, 'r1', 'tu1', 'Bash', { command: 'deploy --token=sk-live-TOPSECRET-4242 --to prod', description: 'Ship it' }),
    result(2, 'tu1'),
    call(3, 'r2', 'tu2', 'Write', { file_path: '/home/someone/private-project/deep/notes.txt', content: 'FILE-CONTENT-SECRET-77' }),
    result(4, 'tu2'),
    call(5, 'r3', 'tu3', 'Grep', { pattern: 'GREP-PATTERN-SECRET' }),
    result(6, 'tu3'),
    call(7, 'r4', 'tu4', 'WebFetch', { url: 'https://user:PASSWORD-SECRET@example.com/path/SECRET-PATH?q=QUERY-SECRET', prompt: 'PROMPT-SECRET' }),
    result(8, 'tu4'),
    call(9, 'r5', 'tu5', 'Bash', { command: 'cat /etc/SHADOW-SECRET | head' }),
    result(10, 'tu5'),
    call(11, 'r6', 'tu6', 'Agent', { description: 'Look around', prompt: 'AGENT-PROMPT-SECRET' }),
  ])
  const { code, out, frame } = frameOf(path, 12)
  assert.equal(code, 0)
  for (const secret of ['hunter2', 'sk-live', 'TOPSECRET', 'FILE-CONTENT', 'private-project', 'GREP-PATTERN', 'PASSWORD-SECRET', 'SECRET-PATH', 'QUERY-SECRET', 'PROMPT-SECRET', 'SHADOW-SECRET', '/etc/', 'someone']) {
    assert.equal(out.includes(secret), false, `the frame holds ${secret}`)
  }
  const labels = frame.rows.map(r => r.label)
  for (const expected of ['Ship it', 'deep/notes.txt', 'Grep', 'example.com', 'cat', 'Look around']) assert.ok(labels.includes(expected), `missing label ${expected}: ${labels.join(' | ')}`)
})

test('only the named transcript is read, never a newer file beside it', () => {
  const named = transcript([human(0), answer(1, 'r1'), turnEnd(2)])
  transcript([{ ...human(50), sessionId: '00000000-0000-4000-8000-0000000000ff' }])
  const { frame } = frameOf(named, 60)
  assert.equal(frame.session_id, SID)
  assert.equal(frame.last_event_at, at(2))
})

test('a call a hook refused reads as blocked, with the hook on its own station', () => {
  const path = transcript([
    human(0),
    call(1, 'r1', 'tu1', 'Bash', { command: 'make deploy', description: 'Ship it' }),
    result(2, 'tu1', true, { permissionDecision: { decision: 'reject', source: 'hook', reasonType: 'hook' }, toolDenialKind: 'permission-rule' }),
  ])
  const { frame } = frameOf(path, 3)
  assert.equal(frame.rows.find(r => r.station === 'shell')?.status, 'block')
  const hook = frame.rows.find(r => r.station === 'hooks')
  assert.deepEqual([hook?.label, hook?.status], ['stopped Bash', 'block'])
})
