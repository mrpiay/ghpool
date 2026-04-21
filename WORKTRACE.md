# ghpool — worktrace integration

How ghpool uses worktrace, what gets recorded, and how to query it.

---

## Overview

Every time you run `ghpool.py` it creates one **run** in worktrace. Inside that run, every poll cycle and every PR event is recorded as a structured **event**. Every poll cycle also writes a **snapshot** of the aggregate session state. Stop the script with Ctrl+C and the run closes cleanly.

Run for an hour → you have a queryable timeline of GitHub's PR stream for that hour.

---

## What gets recorded

### Run
One per script execution.

```
name:     ghpool
tags:     ["github", "prs"]
metadata: {"poll_interval": 5, "token": true}
```

### Events

| Type | Resource | Data | When |
|---|---|---|---|
| `session.start` | — | `seeded_events`, `seeded_prs` | Script launches |
| `session.seed_failed` | — | `error` | Seed fetch fails |
| `poll.start` | `github/events` | — | Each poll cycle begins |
| `poll.done` | `github/events` | `total_events`, `new_prs`, `poll_number` | Each poll cycle ends |
| `poll.failed` | `github/events` | `error` | API call fails |
| `pr.opened` | `gh/<owner/repo>` | `title`, `user`, `added`, `deleted` | New PR detected |
| `pr.merged` | `gh/<owner/repo>` | same | Merge detected |
| `pr.closed` | `gh/<owner/repo>` | same | Close detected |
| `pr.labeled` | `gh/<owner/repo>` | same | Label action detected |
| `pr.synchronize` | `gh/<owner/repo>` | same | Push to open PR |
| `session.end` | — | `poll_count`, `total_prs`, `by_action` | Ctrl+C |

### Snapshot (every poll cycle)

```
resource: gh/pr-stream
kind:     activity
data:
  poll_count:             int   — how many polls so far this session
  total_prs_this_session: int   — total PR events seen
  by_action:              dict  — {"opened": 12, "merged": 8, "closed": 3, ...}
  top_repos:              dict  — top 10 repos by PR event count
```

---

## CLI queries

```bash
# list all ghpool sessions
worktrace runs --tag github

# inspect a session — see every poll and PR event
worktrace show-run <id-prefix>

# watch events live in a second terminal while ghpool runs
worktrace tail
worktrace tail --type pr.*          # only PR events
worktrace tail --type poll.*        # only poll cycles
worktrace tail --resource gh/facebook/react   # one repo
```

---

## Python query API

```python
from worktrace import query

# --- events ---

# all PR events ever recorded
query.events(type_prefix="pr.*")

# only merges
query.events(type_prefix="pr.merged")

# all activity on a specific repo
query.events(resource="gh/torvalds/linux")

# failed poll cycles
query.events(type_prefix="poll.failed")

# everything from the last 2 hours
query.events(since="-2h")

# all PR events from a specific session
query.events(type_prefix="pr.*", run_id="<full-run-id>")

# --- snapshots ---

# full time-series of session activity snapshots
query.snapshots(resource="gh/pr-stream")

# snapshots from a specific session
query.snapshots(resource="gh/pr-stream", run_id="<full-run-id>")

# --- runs ---

# all sessions
query.runs(tag="github")

# only sessions that completed without errors
query.runs(tag="github", status="success")

# sessions from the last day
query.runs(tag="github", since="-1d")
```

---

## Example: replay a session's PR stream

```python
from worktrace import query

run_id = "<your-run-id>"
events = query.events(type_prefix="pr.*", run_id=run_id)

for e in events:
    repo = e.resource_uri.replace("gh/", "")
    print(f"{e.timestamp[11:19]}  {e.type:<20}  {repo:<40}  {e.data.get('title','')[:50]}")
```

## Example: top repos across all sessions

```python
from worktrace import query
from collections import Counter

counts = Counter()
for s in query.snapshots(resource="gh/pr-stream", kind="activity"):
    for repo, n in s.data.get("top_repos", {}).items():
        counts[repo] += n

for repo, total in counts.most_common(20):
    print(f"{total:>6}  {repo}")
```

## Example: merge rate over time

```python
from worktrace import query

for s in query.snapshots(resource="gh/pr-stream", kind="activity"):
    merges = s.data.get("by_action", {}).get("merged", 0)
    polls  = s.data.get("poll_count", 1)
    print(f"{s.timestamp[11:19]}  merges/poll: {merges/polls:.2f}")
```

---

## Data location

All data lives at `~/.worktrace/worktrace.db` — a local SQLite file.
Delete it to start fresh. No server, no account, no sync.
