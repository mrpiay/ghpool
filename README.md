# ghpool

A real-time feed of GitHub's global activity, inspired by [mempool.space](https://mempool.space).

ghpool originated as a real-world use case for [worktrace](https://github.com/Pedro-Oub/worktrace) — a way to test and validate its functionality against a continuous, unpredictable data source.

Every open PR across GitHub is like a transaction waiting to be confirmed. ghpool surfaces that stream live — pull requests, stars, issues, forks, and releases as they happen across every public repo on GitHub — using the public GitHub Events API. Optionally, every session can be recorded to a local SQLite database via [worktrace](https://github.com/Pedro-Oub/worktrace), making the feed queryable after the fact. Pass `--no-record` to run as a pure live feed with nothing written to disk.

```
10:03:43  PR  merged (1) by bartoszruta26 (1) · 3m
          bartoszruta26-droid/Book-parser  [+592 -0]
          Update from task e5210d51

10:03:43  PR  opened (1) by pharo-contributor (1) · 3m
          pharo-spec/NewTools  [+61 -1]
          [Method Browser] Refactoring command migration

10:04:32  *   starred (1) by darylwui (1) · 4m
          darylwui/plsfundme

10:04:47  FK  forked (1) by tsurantino (1) · 4m
          torvalds/linux

10:05:01  RL  published (1) by vercel (1) · 5m
          vercel/next.js
          v14.2.3
```

---

## What makes this different

Most GitHub tools show *your* activity or *your org's*. ghpool watches all of GitHub — every public repo, every language, every timezone.

- **Live stream** — pull requests, stars, issues, forks, and releases appear as they happen, every 5 seconds
- **Persistent history** (optional) — sessions are recorded to a local SQLite database via worktrace, pass `--no-record` to skip
- **Queryable** — replay any session, filter by repo, action, or user, compute merge rates over time

---

## Web app

**[ghp●●l](https://mrpiay.github.io/ghpool/)** — the browser version. No install needed.

- **Feed tab** — same live stream as the terminal, runs entirely in the browser using the GitHub Events API
- **Viewer tab** — drop your `worktrace.db` file to browse sessions, explore events, and run prebuilt or custom SQL queries against your recorded data

The web app doesn’t record to a database — for persistent history, use the terminal version with worktrace. The viewer is where you explore what you recorded.

---

## Quick start

**1. Clone and install**

```bash
git clone https://github.com/mrpiay/ghpool.git
cd ghpool
python -m venv .venv
source .venv/Scripts/activate   # Windows Git Bash
pip install -r requirements.txt
```

**2. Get a GitHub token** (free, no scopes needed)

GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → no scopes → generate.

**3. Create `.env`**

```
GITHUB_TOKEN=ghp_yourtoken123abc
```

**4. Run**

```bash
python ghpool.py             # record session to SQLite
python ghpool.py --no-record # live feed only, nothing written to disk
```

---

## Two-terminal setup (recommended)

Open two terminals side by side for the best experience (activate the venv in both).

**Terminal A** — the live stream:
```bash
python ghpool.py
```

**Terminal B** — watch the raw event feed as it's written to the database:
```bash
worktrace tail --type pr.*
```

Or focus on a specific repo:
```bash
worktrace tail --resource gh/torvalds/linux
```

Or watch only merges:
```bash
worktrace tail --type pr.merged
```

---

## Query your history

```bash
# list all sessions
worktrace runs --tag github

# inspect a full session — every poll and PR event
worktrace show-run <id-prefix>
```

```python
from worktrace import query
from collections import Counter

# most active users across all sessions
counts = Counter()
for e in query.events(type_prefix="pr.*"):
    counts[e.data.get("user", "?")] += 1
for user, n in counts.most_common(10):
    print(f"{n:>6}  {user}")

# spot bots — users with suspiciously high counts
BOTS = {"dependabot", "renovate", "github-actions"}
for e in query.events(type_prefix="pr.opened"):
    if e.data.get("user") in BOTS:
        print(f"bot: {e.data['user']}  {e.resource_uri.replace('gh/', '')}")

# largest PRs ever seen (most lines changed)
events = sorted(
    query.events(type_prefix="pr.*"),
    key=lambda e: e.data.get("added", 0) + e.data.get("deleted", 0),
    reverse=True,
)
for e in events[:10]:
    total = e.data.get("added", 0) + e.data.get("deleted", 0)
    print(f"{total:>8} lines  {e.resource_uri.replace('gh/','')}  {e.data.get('title','')[:50]}")

# merge ratio — what fraction of closed PRs were merged?
actions = Counter(e.type for e in query.events(type_prefix="pr.*"))
ratio = actions["pr.merged"] / max(1, actions["pr.merged"] + actions["pr.closed"])
print(f"merge ratio: {ratio:.0%}")
```

---

## Documentation

- [TUTORIAL.md](TUTORIAL.md) — full walkthrough: motivation, setup, terminal usage, what gets recorded, and all queries
- [Web app](https://mrpiay.github.io/ghpool/) — live feed and worktrace session viewer in the browser
---

## Built on

- [worktrace](https://github.com/Pedro-Oub/worktrace) by Pedro-Oub — workflow memory for Python scripts
- [GitHub Events API](https://docs.github.com/en/rest/activity/events) — public, free, no special scopes required
- [sql.js](https://github.com/sql-js/sql.js) — SQLite compiled to WebAssembly, powers the web viewer
