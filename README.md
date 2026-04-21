# ghpool

A real-time feed of GitHub's global pull request stream, inspired by [mempool.space](https://mempool.space).

Every open PR across GitHub is like a transaction waiting to be confirmed. ghpool surfaces that stream live — who's opening, merging, and closing PRs right now, across every public repo on GitHub — and stores a queryable history of it using [worktrace](https://github.com/Pedro-Oub/worktrace).

```
10:03:43  merged (3/3m)
          bartoszruta26-droid/Book-parser  bartoszruta26 (1/3m)  [+592 -0]
          Update from task e5210d51

10:03:43  opened (7/3m)
          pharo-spec/NewTools  pharo-contributor (2/3m)  [+61 -1]
          [Method Browser] Refactoring command migration

10:04:32  merged (4/4m)
          mthines/gw-tools  mthines (1/4m)  [+34 -3]
          fix(shell): validate nav marker path exists before cd

10:04:47  opened (8/4m)
          darylwui/plsfundme  darylwui (1/4m)  [+607 -0]
          Add Singpass Myinfo KYC design spec
```

---

## What makes this different

Most GitHub PR tools show *your* PRs or *your org's* PRs. ghpool watches all of GitHub — every public repo, every language, every timezone — and builds a timeline you can query.

- **Live stream** — new PRs appear as they happen, every 5 seconds
- **Persistent history** — every session is stored in a local SQLite database via worktrace
- **Queryable** — replay any session, filter by repo, action, or user, compute merge rates over time

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
python ghpool.py
```

---

## Two-terminal setup (recommended)

Open two terminals side by side for the best experience.

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

- [TUTORIAL.md](TUTORIAL.md) — full walkthrough: motivation, code explained line by line, all queries, terminal setup
- [WORKTRACE.md](WORKTRACE.md) — worktrace integration reference: what gets recorded and how to query it
---

## Built on

- [worktrace](https://github.com/Pedro-Oub/worktrace) by Pedro-Oub — workflow memory for Python scripts
- [GitHub Events API](https://docs.github.com/en/rest/activity/events) — public, free, no special scopes required
