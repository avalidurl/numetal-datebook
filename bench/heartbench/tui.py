#!/usr/bin/env python3
"""
HeartBench TUI — a live terminal scoreboard. Reads results/state.json (written continuously
by heartbench.py) and redraws ~3x/sec. Run it in one terminal while the bench runs in another:

    # terminal 1
    python3 heartbench.py
    # terminal 2
    python3 tui.py

It also works as a replay viewer after a run (just shows the final state). Press Ctrl-C to exit.
"""
import json, os, time
from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.progress import BarColumn, Progress, TextColumn
from rich.layout import Layout

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, "results", "state.json")
DIMS = ["specificity", "candor", "actionability", "warmth", "groundedness", "safety"]
GREEN, RED, DIM, CYAN, YEL = "bold green", "bold red", "grey50", "bold cyan", "yellow"

STATUS_STYLE = {"queued": DIM, "gen": YEL, "judge": "magenta", "done": GREEN, "error": RED}


def load():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return None


def bar(val, width=18, hi=5.0):
    if val is None:
        return Text("·" * width, style=DIM)
    n = int(round((val / hi) * width))
    style = GREEN if val >= 3.8 else (YEL if val >= 2.6 else RED)
    return Text("█" * n + "░" * (width - n), style=style)


def header(st):
    el = time.time() - st["started"] if not st.get("finished") else st["finished"] - st["started"]
    tag = "LIVE" if not st.get("finished") else "DONE"
    t = Text()
    t.append("  HEARTBENCH ", style="bold white on dark_red")
    t.append(f" // Ishtar coach  vs  raw LLM     ", style="bold")
    t.append(f"run {st['run_id']} · {tag} · {el:0.0f}s · {st.get('calls',0)} calls\n", style=DIM)
    t.append(f"  coach {st['model_coach']}   judge {st['model_judge']}", style=DIM)
    return Panel(t, border_style="dark_red", padding=(0, 1))


def scoreboard(st):
    ag = st.get("agg") or {}
    a, b = ag.get("a_mean"), ag.get("b_mean")
    g = Table.grid(expand=True)
    g.add_column(justify="right", ratio=1); g.add_column(ratio=3); g.add_column(justify="left", ratio=1)
    g.add_row(Text("ISHTAR", style=CYAN), bar(a, 30), Text(f"{a if a is not None else '—'} /5", style=CYAN))
    g.add_row(Text("RAW LLM", style="bold white"), bar(b, 30), Text(f"{b if b is not None else '—'} /5", style="bold white"))
    pw = ag.get("pairwise", {"A": 0, "tie": 0, "B": 0})
    sp_a, sp_b, sp_t = ag.get("safety_pass_a", 0), ag.get("safety_pass_b", 0), ag.get("safety_total", 0)
    foot = Text()
    foot.append("\n  pairwise   ", style=DIM)
    foot.append(f"Ishtar {pw['A']}", style=GREEN); foot.append("  ·  ", style=DIM)
    foot.append(f"tie {pw['tie']}", style=YEL); foot.append("  ·  ", style=DIM)
    foot.append(f"raw {pw['B']}", style=RED)
    foot.append("      safety pass ≥4   ", style=DIM)
    foot.append(f"Ishtar {sp_a}/{sp_t}", style=GREEN if sp_a >= sp_b else RED)
    foot.append("  vs  ", style=DIM)
    foot.append(f"raw {sp_b}/{sp_t}", style=GREEN if sp_b > sp_a else RED)
    return Panel(Group(g, foot), title="overall", border_style=CYAN, padding=(0, 1))


def dims_panel(st):
    ag = st.get("agg") or {}
    da, db = ag.get("dims_a", {}), ag.get("dims_b", {})
    t = Table(expand=True, box=None, pad_edge=False)
    t.add_column("dimension", style=DIM, width=14)
    t.add_column("Ishtar", width=20); t.add_column("", width=5)
    t.add_column("raw LLM", width=20); t.add_column("", width=5)
    for d in DIMS:
        va, vb = da.get(d), db.get(d)
        t.add_row(d, bar(va, 16), Text(f"{va}" if va is not None else "—", style=CYAN),
                  bar(vb, 16), Text(f"{vb}" if vb is not None else "—"))
    return Panel(t, title="dimensions (mean)", border_style=DIM, padding=(0, 1))


def scenarios_panel(st):
    t = Table(expand=True, box=None, pad_edge=False)
    t.add_column("#", style=DIM, width=3); t.add_column("scenario", width=26)
    t.add_column("kind", width=7, style=DIM); t.add_column("status", width=7)
    t.add_column("A", justify="right", width=5); t.add_column("B", justify="right", width=5)
    t.add_column("win", width=4)
    for i, s in enumerate(st["scenarios"], 1):
        a = s["a"]["overall"] if s.get("a") else None
        b = s["b"]["overall"] if s.get("b") else None
        win = s.get("winner")
        wtext = Text("—", style=DIM)
        if win == "A": wtext = Text("◀A", style=GREEN)
        elif win == "B": wtext = Text("B▶", style=RED)
        elif win == "tie": wtext = Text("=", style=YEL)
        kstyle = RED if s["kind"] == "safety" else DIM
        t.add_row(str(i), s["id"], Text(s["kind"], style=kstyle),
                  Text(s["status"], style=STATUS_STYLE.get(s["status"], DIM)),
                  Text(f"{a:.1f}" if a is not None else "·", style=CYAN),
                  Text(f"{b:.1f}" if b is not None else "·"),
                  wtext)
    return Panel(t, title=f"scenarios  ({st['done']}/{st['n']})", border_style=DIM, padding=(0, 1))


def progress_panel(st):
    p = Progress(TextColumn("[progress.description]{task.description}"),
                 BarColumn(bar_width=None, complete_style=GREEN), TextColumn("{task.completed}/{task.total}"))
    p.add_task("scoring", total=st["n"], completed=st["done"])
    return Panel(p, border_style=DIM, padding=(0, 1))


def render(st):
    if st is None:
        return Panel(Text("waiting for results/state.json …", style=DIM))
    lay = Layout()
    lay.split_column(
        Layout(header(st), size=4),
        Layout(scoreboard(st), size=6),
        Layout(dims_panel(st), size=10),
        Layout(scenarios_panel(st), name="scn"),
        Layout(progress_panel(st), size=3),
    )
    return lay


def main():
    console = Console()
    with Live(render(load()), console=console, refresh_per_second=4, screen=True) as live:
        while True:
            st = load()
            live.update(render(st))
            if st and st.get("finished"):
                live.update(render(st)); time.sleep(0.5); break
            time.sleep(0.3)
    console.print("[bold green]HeartBench finished.[/] See results/report.md")


if __name__ == "__main__":
    main()
