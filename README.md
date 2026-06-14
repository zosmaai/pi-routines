# pi-routines

Cron-based task scheduling for [pi](https://github.com/earendil-works/pi). A faithful port of Claude Code's internal scheduling system, adapted to pi's extension API.

Schedule recurring or one-shot tasks that fire as user messages — letting the agent run periodic checks, maintenance, monitoring, or any repeating workflow.

## Install

### From npm

Add to your `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-routines"
  ]
}
```

### From source

```bash
git clone https://github.com/offbynan/pi-routines.git ~/repos/pi-routines
cd ~/repos/pi-routines && npm install
```

Then add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "~/repos/pi-routines"
  ]
}
```

Run `/reload` in pi to activate.

## What it does

Once loaded, pi-routines runs a background scheduler that:

- **Polls every 1 second** for tasks whose fire time has arrived
- **Fires tasks** by sending their prompt as a user message via `pi.sendUserMessage()`
- **Persists durable tasks** to `.pi/scheduled_tasks.json` (survives restarts)
- **Keeps session tasks in memory** (die with the session — used by `/loop`)
- **Prevents double-fire** across multiple pi instances via a PID-based lock file
- **Watches the task file** for external changes (hot-reload via chokidar)
- **Recovers missed tasks** — prompts you on startup if one-shot tasks fired while offline
- **Auto-expires** recurring tasks after 7 days of inactivity (configurable, or permanent)
- **Applies jitter** to prevent thundering-herd problems on exact schedule boundaries

## Tools

The extension gives the LLM three tools:

### `cron_create` — Schedule a task

```
Parameters:
  name       string   (required)  Short name for the task
  schedule   string   (required)  Cron expression, 5 or 6 fields
  prompt     string   (required)  Message sent when the task fires
  type       string   (optional)  "durable" (default) or "session"
  recurring  boolean  (optional)  true (default) or false for one-shot
  maxAgeDays number   (optional)  Auto-expire after N days, 0 = permanent (default: 7)
```

**Cron expression examples:**

| Expression | Meaning |
|---|---|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 9 * * mon-fri` | Weekdays at 9:00 AM |
| `0 0 1 * *` | First of every month at midnight |
| `30 */5 * * * *` | Every 5 minutes at :30 seconds (6-field) |

### `cron_delete` — Remove a task

```
Parameters:
  id   string   (required)  Task ID to delete
```

### `cron_list` — List tasks

```
Parameters:
  type   string   (optional)  "all" (default), "durable", or "session"
```

## Commands

### `/loop <interval> <prompt>`

Schedule a recurring session task **and execute it immediately**. The task lives only for the current session.

```
/loop 5m check git status and report uncommitted changes
/loop 1h run the full test suite and summarize results
/loop 30s check if the dev server is still responding
/loop 2d review open PRs and summarize
```

Supported intervals: `30s`, `5m`, `1h`, `2d` (seconds, minutes, hours, days).

## Architecture

```
src/
├── index.ts              Extension entry — session lifecycle wiring
├── cron.ts               Cron parser & next-run calculator (pure logic)
├── cronTasks.ts          Task storage: file-backed durable + in-memory session
├── cronTasksLock.ts      Cross-session PID lock (.pi/scheduled_tasks.lock)
├── cronScheduler.ts      1s poll loop, chokidar watcher, jitter engine
├── tools/
│   ├── cronCreate.ts     cron_create tool
│   ├── cronDelete.ts     cron_delete tool
│   └── cronList.ts       cron_list tool
└── commands/
    └── loop.ts           /loop command
```

### Lifecycle

1. On `session_start`, a `CronScheduler` is created which acquires a lock file and starts polling.
2. When a task's fire time arrives (with jitter applied), the scheduler calls `pi.sendUserMessage()` with the task's prompt.
3. Recurring tasks get their `nextRunAt` recomputed; one-shot tasks are removed after firing.
4. On `session_shutdown`, the lock is released and session tasks are cleaned up.
5. If the lock owner's process dies, another pi session detects this within 5 seconds and takes over.

### Jitter

Mirrors Claude Code's jitter logic:

- **Recurring tasks**: forward jitter — delayed by up to 10% of the interval (max 15 minutes). Deterministic per task ID.
- **One-shot tasks**: backward jitter — fired up to 90 seconds early when scheduled at :00 or :30 marks.

### Storage

- **Durable tasks**: `.pi/scheduled_tasks.json` — JSON file with `{ version: 1, tasks: [...] }`. Survives process restarts.
- **Session tasks**: in-memory `Map` — created by `/loop` or `cron_create` with `type: "session"`. Cleaned up on shutdown.
- **Lock file**: `.pi/scheduled_tasks.lock` — `{ pid, sessionId, acquiredAt }`. Probed every 5s by non-owners.

## Testing

```bash
npm test          # run all tests
npm run test:watch  # watch mode
npm run typecheck   # type-check without emitting
```

89 tests across 5 test files covering the cron parser, task store, lock, scheduler, and all three tools.

## License

MIT
