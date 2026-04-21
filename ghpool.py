"""
ghpool — live GitHub PR stream with worktrace history

Polls the GitHub public Events API every 5 seconds, filters for
PullRequestEvents, displays them as a live feed, and records everything
to a local SQLite database via worktrace.

Usage:
    python ghpool.py

Requires a .env file with GITHUB_TOKEN=<your token>.
See README.md for setup instructions.
"""

import os
import time
import requests
from collections import Counter
from dotenv import load_dotenv
from rich.console import Console
import worktrace as wt

load_dotenv()

TOKEN = os.getenv("GITHUB_TOKEN")
HEADERS = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}
POLL_INTERVAL = 5  # seconds — safe with token, change to 60 without

console = Console()
seen: set[str] = set()          # event IDs already displayed — prevents duplicates across polls
action_counts: Counter = Counter()  # running tally of PR actions this session
repo_counts: Counter = Counter()    # running tally of repos by PR activity
poll_count = 0


# ---------------------------------------------------------------------------
# GitHub API
# ---------------------------------------------------------------------------

def fetch_events() -> list[dict]:
    """Fetch the latest 100 public GitHub events."""
    r = requests.get(
        "https://api.github.com/events",
        headers={**HEADERS, "Accept": "application/vnd.github+json"},
        params={"per_page": 100},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()


def fetch_pr_details(url: str) -> dict:
    """Fetch the full PR object from its API URL.

    The events payload sometimes omits title, user, and line counts.
    This fills in the gaps when needed.
    """
    try:
        r = requests.get(url, headers={**HEADERS, "Accept": "application/vnd.github+json"}, timeout=8)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {}


def parse_pr(event: dict) -> dict | None:
    """Extract a clean PR dict from a raw GitHub event.

    Returns None for non-PR events or events with unrecoverable missing data.
    Falls back to fetch_pr_details() if the events payload is incomplete.
    """
    if event.get("type") != "PullRequestEvent":
        return None
    try:
        pr = event["payload"]["pull_request"]
        title = (pr.get("title") or "").strip()
        user = (pr.get("user") or {}).get("login", "")
        added = pr.get("additions")
        deleted = pr.get("deletions")

        # the events API sometimes returns incomplete payloads — fetch the full PR if needed
        if not title or not user or added is None:
            details = fetch_pr_details(pr.get("url", ""))
            title = title or (details.get("title") or "")
            user = user or (details.get("user") or {}).get("login", "?")
            added = added if added is not None else details.get("additions", 0)
            deleted = deleted if deleted is not None else details.get("deletions", 0)

        return {
            "id": event["id"],
            "action": event["payload"].get("action", "?"),
            "repo": event["repo"]["name"],
            "title": title[:80],
            "added": added or 0,
            "deleted": deleted or 0,
            "user": user,
            "time": event["created_at"][11:19],  # HH:MM:SS from ISO timestamp
        }
    except (KeyError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

ACTION_COLOR = {
    "opened": "green",
    "merged": "magenta",
    "closed": "red",
    "reopened": "yellow",
    "synchronize": "cyan",  # new commits pushed to an open PR
    "labeled": "blue",
    "assigned": "yellow",
}


def render_pr(pr: dict) -> None:
    """Print one PR as a two-line card to the terminal."""
    color = ACTION_COLOR.get(pr["action"], "white")
    size = f"[dim]+{pr['added']} -{pr['deleted']}[/dim]"
    console.print(
        f"[dim]{pr['time']}[/dim]  [{color}]{pr['action']}[/{color}]  "
        f"[bold]{pr['repo']}[/bold]  [dim]{pr['user']}[/dim]"
    )
    if pr["title"]:
        console.print(f"  {pr['title']}  {size}")
    console.print()


# ---------------------------------------------------------------------------
# worktrace helpers
# ---------------------------------------------------------------------------

def record_poll(run: wt.Run, new_prs: list[dict], total_events: int) -> None:
    """Write one poll cycle to worktrace: a poll.done event, one pr.* event
    per new PR, and a snapshot of the full session state.

    The snapshot is what builds the queryable time-series — every poll adds
    one row, so you can later compare activity across minutes or hours.
    """
    global poll_count
    poll_count += 1

    # update session-level counters
    for pr in new_prs:
        action_counts[pr["action"]] += 1
        repo_counts[pr["repo"]] += 1

    # record that this poll cycle completed
    wt.event(
        "poll.done",
        resource="github/events",
        data={
            "total_events": total_events,
            "new_prs": len(new_prs),
            "poll_number": poll_count,
        },
        run=run,
    )

    # one event per PR — queryable by repo via resource="gh/owner/repo"
    for pr in new_prs:
        wt.event(
            f"pr.{pr['action']}",
            resource=f"gh/{pr['repo']}",
            data={
                "title": pr["title"],
                "user": pr["user"],
                "added": pr["added"],
                "deleted": pr["deleted"],
            },
            run=run,
        )

    # snapshot of session aggregate state — one per poll, stacks up over time
    wt.snapshot(
        resource="gh/pr-stream",
        kind="activity",
        data={
            "poll_count": poll_count,
            "total_prs_this_session": sum(action_counts.values()),
            "by_action": dict(action_counts),
            "top_repos": dict(repo_counts.most_common(10)),
        },
        run=run,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    console.print("[bold]ghpool[/bold] — live GitHub PR stream  [dim](Ctrl+C to stop)[/dim]\n")
    console.print("[dim]Each PR is shown as two lines:[/dim]")
    console.print("[dim]  HH:MM:SS  ACTION  owner/repo  username[/dim]")
    console.print("[dim]  PR title  +added -deleted lines[/dim]")
    console.print()
    console.print(
        f"[dim]Actions: "
        f"[green]opened[/green]  "
        f"[magenta]merged[/magenta]  "
        f"[red]closed[/red]  "
        f"[cyan]synchronize[/cyan]  "
        f"[blue]labeled[/blue]  "
        f"[yellow]assigned/reopened[/yellow][/dim]"
    )
    console.print()

    # open a worktrace run for this session
    run = wt.start_run(
        name="ghpool",
        tags=["github", "prs"],
        metadata={"poll_interval": POLL_INTERVAL, "token": bool(TOKEN)},
    )

    # seed: fetch current events, show existing PRs, mark all as seen
    # without this, the first poll would dump up to 100 events at once
    try:
        initial = fetch_events()
        token_status = "[green]token loaded[/green]" if TOKEN else "[red]no token — unauthenticated[/red]"
        console.print(f"[dim]{token_status} · {len(initial)} events fetched[/dim]\n")
        initial_prs = [parse_pr(e) for e in initial]
        initial_prs = [p for p in initial_prs if p]
        for e in initial:
            seen.add(e["id"])
        for pr in initial_prs:
            render_pr(pr)
        wt.event("session.start", data={"seeded_events": len(initial), "seeded_prs": len(initial_prs)}, run=run)
        console.print(f"[dim]Watching for new events every {POLL_INTERVAL}s...[/dim]\n")
    except Exception as ex:
        wt.event("session.seed_failed", data={"error": str(ex)}, run=run)
        console.print(f"[red]Failed to seed: {ex}[/red]")

    try:
        while True:
            time.sleep(POLL_INTERVAL)
            wt.event("poll.start", resource="github/events", run=run)
            try:
                events = fetch_events()
            except Exception as ex:
                wt.event("poll.failed", resource="github/events", data={"error": str(ex)}, run=run)
                console.print(f"[red]fetch error: {ex}[/red]")
                continue

            # collect only events we haven't seen before
            new_prs = []
            for e in events:
                if e["id"] in seen:
                    continue
                seen.add(e["id"])
                pr = parse_pr(e)
                if pr:
                    new_prs.append(pr)

            record_poll(run, new_prs, len(events))

            for pr in new_prs:
                render_pr(pr)

    except KeyboardInterrupt:
        console.print("\n[dim]stopped.[/dim]")
        # close the run cleanly with final session totals
        wt.event(
            "session.end",
            data={
                "poll_count": poll_count,
                "total_prs": sum(action_counts.values()),
                "by_action": dict(action_counts),
            },
            run=run,
        )
        wt.end_run(run, status="success")
