#!/usr/bin/env python3
"""openjig: one command to get back to your rigs, like typing `herdr`.

  openjig          open Herdr with every running rig, on mission control (the kernel)
  openjig <rig>    open Herdr on that rig (restarting it first if it is stopped)
  openjig menu     clickable menu: jump in, restart, stop, or start a new rig in a project

Every choice runs an ordinary `rig` / `herdr` command, printed before it runs.
Rigs open as Herdr workspaces; pick between them in Herdr's sidebar afterwards.
"""

import curses
import json
import os
import shlex
import shutil
import subprocess
import sys
import urllib.request

DAEMON = os.environ.get("OPENRIG_URL", "http://127.0.0.1:7433").rstrip("/")
PROJECT_ROOTS = os.environ.get("OPENJIG_PROJECT_ROOTS", "~/Documents/GitHub").split(":")


def run(args):
    print("$ " + shlex.join(args), flush=True)
    return subprocess.run(args).returncode == 0


def capture_json(args):
    try:
        return json.loads(subprocess.run(args, capture_output=True, text=True).stdout)
    except (json.JSONDecodeError, TypeError):
        return None


def daemon_up():
    try:
        urllib.request.urlopen(DAEMON + "/healthz", timeout=3)
        return True
    except Exception:
        return False


def ensure_daemon():
    """Start a stopped daemon or use the documented stop/start recovery for a wedged one."""
    if daemon_up():
        return True
    status = subprocess.run(["rig", "daemon", "status"], capture_output=True, text=True)
    detail = f"{status.stdout}\n{status.stderr}".lower()
    if "unresponsive" in detail or "unhealthy" in detail:
        print("openjig: daemon is unhealthy; restarting the control plane (preserving any live tmux sessions).", flush=True)
        if not run(["rig", "daemon", "stop"]):
            return False
    return run(["rig", "daemon", "start"])


def rigs():
    return [r for r in capture_json(["rig", "ps", "--json"]) or [] if not r.get("isArchived")]


def jcode_starters():
    try:
        with urllib.request.urlopen(DAEMON + "/api/specs/library", timeout=5) as resp:
            entries = json.load(resp)
    except Exception:
        return []
    names = sorted(e["name"] for e in entries if e.get("kind") == "rig" and e["name"].endswith("-jcode"))
    summaries = {e["name"]: " ".join((e.get("summary") or "").split()) for e in entries}
    boiler = "every agent seat runs on jcode with a model sized to its role. "
    return [(n, summaries[n].split(boiler, 1)[-1]) for n in names]


def projects():
    found = []
    for root in PROJECT_ROOTS:
        root = os.path.expanduser(root)
        if os.path.isdir(root):
            for name in os.listdir(root):
                path = os.path.join(root, name)
                if os.path.exists(os.path.join(path, ".git")):
                    found.append((os.path.getmtime(path), path))
    return [p for _, p in sorted(found, reverse=True)]


def herdr_workspace(rig):
    """The rig's workspace, keyed by its tab label (the sidebar shows just the rig name)."""
    key = f"openrig:rig:{rig}#"
    rows = (herdr_json(["tab", "list"]).get("tabs") or []) + (herdr_json(["workspace", "list"]).get("workspaces") or [])
    return next((r for r in rows if (r.get("label") or "").startswith(key)), None)


def rig_by_name(name):
    return next((r for r in rigs() if r["name"] == name), None)


def herdr_json(args):
    return (capture_json(["herdr", *args]) or {}).get("result") or {}


def add_mission_control(workspace):
    """Put OpenRig's operator view (rig tui) beside the agents, unless it is already there."""
    panes = herdr_json(["pane", "list", "--workspace", workspace]).get("panes") or []
    if not panes or any(p.get("label") in ("mission control", "operator.human") for p in panes):
        return
    pane = herdr_json(["pane", "split", panes[0]["pane_id"], "--direction", "right", "--no-focus"]).get("pane")
    if pane:
        subprocess.run(["herdr", "pane", "rename", pane["pane_id"], "mission control"], capture_output=True)
        subprocess.run(["herdr", "pane", "run", pane["pane_id"], "rig tui"], capture_output=True)


def reset_scroll_mode():
    """A seat left in tmux scroll/view mode shows a frozen screen; put every rig seat back to live."""
    out = subprocess.run(["tmux", "list-panes", "-a", "-F", "#{session_name} #{pane_in_mode}"],
                         capture_output=True, text=True).stdout
    for line in out.splitlines():
        session, _, in_mode = line.rpartition(" ")
        if "@" in session and in_mode == "1":
            subprocess.run(["tmux", "copy-mode", "-q", "-t", session], capture_output=True)


def focus_talk_pane(workspace):
    """Put the cursor in the seat you talk to: the kernel's operator.agent, else the rig's first agent."""
    panes = herdr_json(["pane", "list", "--workspace", workspace]).get("panes") or []
    agents = [p for p in panes if p.get("label") not in ("mission control", "operator.human")]
    pick = next((p for p in agents if p.get("label") == "operator.agent"), agents[0] if agents else None)
    if pick:
        subprocess.run(["herdr", "agent", "focus", pick["pane_id"]], capture_output=True)


KERNEL_SEATS = ("advisor.lead", "operator.agent", "queue.worker")
JCODE_STATE = os.path.expanduser("~/.openrig/state/jcode")
SHELLS = {"zsh", "-zsh", "bash", "-bash", "sh", "fish", "login"}


def latest_jcode_session(seat):
    """The seat's most recent saved jcode session id from the OpenRig db, or None."""
    db = os.path.expanduser("~/.openrig/openrig.sqlite")
    q = ("select s.resume_token from sessions s join nodes n on n.id=s.node_id join rigs r on r.id=n.rig_id "
         f"where r.name='kernel' and n.logical_id='{seat}' and s.resume_type='jcode_id' "
         "and s.resume_token is not null order by s.created_at desc limit 1")
    out = subprocess.run(["sqlite3", db, q], capture_output=True, text=True).stdout.strip()
    if out and os.path.exists(os.path.expanduser(f"~/.jcode/sessions/{out}.json")):
        return out
    return None


def relay_path():
    rig_bin = os.path.realpath(shutil.which("rig") or "")
    root = os.path.dirname(os.path.dirname(rig_bin))  # .../@openrig/cli
    p = os.path.join(root, "daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs")
    return p if os.path.exists(p) else None


def launch_bare_seat(node):
    """A jcode seat whose tmux pane is just a shell (restore was held): start jcode there
    exactly as the daemon would, resuming its saved session under its policy model."""
    session = node["canonicalSessionName"]
    cmd = subprocess.run(["tmux", "display", "-p", "-t", session, "#{pane_current_command}"],
                         capture_output=True, text=True).stdout.strip()
    if cmd not in SHELLS:
        return
    runtime = os.path.join(JCODE_STATE, session, "runtime")
    os.makedirs(runtime, exist_ok=True)
    sock = os.path.join(runtime, "jcode.sock")
    env = f"JCODE_RUNTIME_DIR={shlex.quote(runtime)}"
    relay = relay_path()
    hooks = "".join(f" JCODE_HOOK_{e}={shlex.quote('node ' + shlex.quote(relay))}"
                    for e in ("TURN_START", "TURN_END", "SESSION_START", "SESSION_END")) if relay else ""
    model = node.get("model")
    resume = latest_jcode_session(node["logicalId"])
    line = (f"if [ -S {shlex.quote(sock)} ]; then {env} jcode server stop --force >/dev/null 2>&1; fi && "
            f"{env} JCODE_TEMP_SERVER=1 JCODE_DEBUG_SOCKET=1{hooks} jcode --no-update --no-selfdev "
            f"-C {shlex.quote(node.get('cwd') or os.path.expanduser('~/.openrig/workspace'))}"
            + (f" -m {shlex.quote(model)}" if model else "")
            + (f" --resume {shlex.quote(resume)}" if resume else ""))
    print(f"openjig: starting {node['logicalId']} in {session}" + (f" (resuming {resume})" if resume else " (fresh)"), flush=True)
    subprocess.run(["tmux", "send-keys", "-t", session, "-l", line], capture_output=True)
    subprocess.run(["tmux", "send-keys", "-t", session, "Enter"], capture_output=True)
    if resume and model:
        pin_model(runtime, resume, model)


def pin_model(runtime, session_id, model):
    """jcode --resume keeps the model saved in the session and ignores -m, so switch it to
    the OpenRig policy model over the seat's debug socket once the server is up."""
    import socket, time
    sock_path = os.path.join(runtime, "jcode-debug.sock")
    msg = json.dumps({"type": "debug_command", "id": 1, "command": f"set_model:{model}",
                      "session_id": session_id}) + "\n"
    time.sleep(2)  # let any previous seat server finish stopping first
    for _ in range(40):
        time.sleep(0.5)
        try:
            s = socket.socket(socket.AF_UNIX)
            s.settimeout(10)
            s.connect(sock_path)
            s.sendall(msg.encode())
            reply = json.loads(s.recv(65536).decode().splitlines()[0])
            s.close()
            if reply.get("ok"):
                print(f"openjig: {session_id} pinned to {model}", flush=True)
                return
        except Exception:
            pass
    print(f"openjig: could not pin {session_id} to {model}; use /model in that seat", flush=True)


def ensure_kernel():
    """The kernel (at least advisor.lead) must always be up when openjig runs."""
    k = rig_by_name("kernel")
    if k and k.get("status") != "running":
        run(["rig", "up", "kernel", "--existing", "--yes"])
    for n in capture_json(["rig", "ps", "--nodes", "--rig", "kernel", "--json"]) or []:
        if n.get("runtime") == "jcode" and n.get("logicalId") in KERNEL_SEATS:
            if n.get("sessionStatus") != "running":
                continue
            launch_bare_seat(n)


def reattach_dead_tiles(rig, workspace):
    """Herdr restores tiles after a restart, but the `tmux attach` inside them is gone, leaving
    an empty shell. Re-run the attach in any seat tile that is sitting at a bare shell."""
    sessions = {n["canonicalSessionName"] for n in capture_json(["rig", "ps", "--nodes", "--rig", rig, "--json"]) or []
                if n.get("sessionStatus") == "running" and n.get("canonicalSessionName")}
    for p in herdr_json(["pane", "list", "--workspace", workspace]).get("panes") or []:
        target = (p.get("label") or "").replace(".", "-") + "@" + rig
        if target not in sessions:
            continue
        info = herdr_json(["pane", "process-info", "--pane", p["pane_id"]]).get("process_info") or {}
        procs = info.get("foreground_processes") or []
        if procs and all(x.get("name") in SHELLS or x.get("cmdline") in SHELLS for x in procs):
            subprocess.run(["herdr", "pane", "run", p["pane_id"],
                            f"tmux attach -f ignore-size -t {shlex.quote(target)}"], capture_output=True)


def show_in_herdr(rig=None):
    """Give each running rig a Herdr workspace with mission control, jump to `rig`, attach Herdr."""
    reset_scroll_mode()
    ensure_kernel()
    for r in rigs():
        if r.get("status") != "running":
            continue
        w = herdr_workspace(r["name"])
        if not w or missing_tiles(r["name"], w["workspace_id"]):
            # New rig, or seats with no tile (added later, or a tile was closed): OpenRig
            # opens it, adding any missing seats in a new tab and leaving existing tiles alone.
            run(["rig", "terminal", "open", r["name"], "--provider", "herdr"])
            w = herdr_workspace(r["name"])
        if w:
            reattach_dead_tiles(r["name"], w["workspace_id"])
            add_mission_control(w["workspace_id"])
    # With no rig named, land on the kernel: its operator.human tile is mission control.
    target = herdr_workspace(rig or "kernel")
    if target:
        subprocess.run(["herdr", "workspace", "focus", target["workspace_id"]], capture_output=True)
        focus_talk_pane(target["workspace_id"])
    if not os.environ.get("HERDR_ENV"):  # already inside Herdr: the sidebar updates by itself
        os.execvp("herdr", ["herdr"])


def missing_tiles(rig, workspace):
    """True when a running seat of `rig` has no tile in its Herdr workspace."""
    seats = {n["logicalId"] for n in capture_json(["rig", "ps", "--nodes", "--rig", rig, "--json"]) or []
             if n.get("sessionStatus") == "running"}
    tiles = {p.get("label") for p in herdr_json(["pane", "list", "--workspace", workspace]).get("panes") or []}
    return bool(seats - tiles)


def open_rig(name):
    """Start `name` if it is stopped, then jump in. Returns False if it does not exist."""
    rig = rig_by_name(name)
    if not rig:
        return False
    if rig.get("status") == "running" or run(["rig", "up", name, "--existing", "--yes"]):
        show_in_herdr(name)
    return True


def start_agent(cwd):
    """"+ one jcode agent": a one-seat rig named after the project, any number of these can
    exist at once since each gets its own name (unlike the fixed-name starters)."""
    name = os.path.basename(os.path.normpath(cwd))
    if not open_rig(name) and run(["rig", "create", name, "--runtime", "jcode", "--cwd", cwd]):
        show_in_herdr(name)


def start_starter(name, cwd):
    """Starter rigs have a fixed name, so only one can run at a time across all projects."""
    existing = rig_by_name(name)
    if existing and existing.get("status") == "running":
        print(f'openjig: {name} is already running in another project; '
              f'use "one jcode agent" for a second project')
        show_in_herdr(name)
        return
    if run(["rig", "up", name, "--cwd", cwd, "--yes"]):
        show_in_herdr(name)


# ------------------------------------------------------------------ clickable menu


def menu(stdscr, title, rows, hint):
    """rows: ("head", text) or ("item", label, detail, value). Click, arrows or type to filter."""
    curses.curs_set(0)
    curses.mousemask(curses.ALL_MOUSE_EVENTS | curses.REPORT_MOUSE_POSITION)
    curses.mouseinterval(0)
    query, index, top = "", 0, 0
    while True:
        shown = [r for r in rows if r[0] == "head" and not query
                 or r[0] == "item" and query.lower() in (r[1] + " " + r[2]).lower()]
        items = [i for i, r in enumerate(shown) if r[0] == "item"]
        index = max(0, min(index, len(items) - 1))
        h, w = stdscr.getmaxyx()
        body = h - 4
        current = items[index] if items else 0
        top = min(max(top, current - body + 1), current) if items else 0
        stdscr.erase()
        stdscr.addnstr(0, 0, title, w - 1, curses.A_BOLD)
        stdscr.addnstr(1, 0, (f"filter: {query}" if query else hint), w - 1, curses.A_DIM)
        for y, row in enumerate(shown[top:top + body]):
            if row[0] == "head":
                stdscr.addnstr(3 + y, 0, row[1], w - 1, curses.A_BOLD | curses.A_UNDERLINE)
            else:
                attr = curses.A_REVERSE if top + y == current else curses.A_NORMAL
                stdscr.addnstr(3 + y, 0, f"  {row[1]:<30} {row[2]}"[: w - 1].ljust(w - 1), w - 1, attr)
        if not items:
            stdscr.addnstr(3, 2, "nothing matches", w - 3, curses.A_DIM)
        stdscr.refresh()
        key = stdscr.get_wch()
        if key == curses.KEY_MOUSE:
            try:
                _, _, my, _, bstate = curses.getmouse()
            except curses.error:
                continue
            if bstate & getattr(curses, "BUTTON4_PRESSED", 0):
                index -= 1
            elif bstate & getattr(curses, "BUTTON5_PRESSED", 0x200000):
                index += 1
            elif bstate & (curses.BUTTON1_CLICKED | curses.BUTTON1_RELEASED | curses.BUTTON1_PRESSED):
                row = top + my - 3
                if 0 <= row < len(shown) and shown[row][0] == "item":
                    return shown[row][3]
        elif key in ("\n", "\r", curses.KEY_ENTER) and items:
            return shown[current][3]
        elif key == curses.KEY_UP:
            index -= 1
        elif key == curses.KEY_DOWN:
            index += 1
        elif key in (curses.KEY_BACKSPACE, "\x7f", "\b"):
            query = query[:-1]
        elif key == "\x1b" or (key == "q" and not query):
            return None
        elif isinstance(key, str) and key.isprintable():
            query, index = query + key, 0


def home(stdscr):
    while True:
        rows = []
        current = rigs()
        if current:
            rows.append(("head", "Your rigs  (click to jump in)"))
            for r in current:
                running = r.get("status") == "running"
                seats = f"{r.get('runningCount', 0)}/{r.get('nodeCount', 0)} agents"
                rows.append(("item", ("● " if running else "○ ") + r["name"],
                             f"{seats} · {r.get('status')}" + ("" if running else " · click to restart"),
                             ("rig", r["name"])))
        rows.append(("head", "Start a new rig in a project"))
        rows.append(("item", "+ one jcode agent", "one seat, any project, any number at once", ("new", None)))
        for name, summary in jcode_starters():
            rows.append(("item", "+ " + name, summary[:80], ("new", name)))
        choice = menu(stdscr, "openjig", rows, "click or ↑↓ + enter · type to filter · q quit")
        if choice is None:
            return None
        if choice[0] == "rig":
            name = choice[1]
            actions = [("item", "Jump in", "open it in Herdr (restarts it if stopped)", ("open", name)),
                       ("item", "Stop", f"rig down {name} (agents saved, restart any time)", ("stop", name))]
            picked = menu(stdscr, name, actions, "click or enter · esc back")
            if picked:
                return picked
            continue
        cwd = menu(stdscr, f"Start {choice[1]} in which project?",
                   [("item", os.path.basename(p), p, p) for p in projects()] +
                   [("item", "(current directory)", os.getcwd(), os.getcwd())],
                   "click or enter · type to filter · esc back")
        if cwd:
            return ("start", choice[1], cwd)


def main(argv):
    if argv[:1] in (["-h"], ["--help"]):
        return print(__doc__)
    for tool in ("rig", "herdr"):
        if not shutil.which(tool):
            sys.exit(f"openjig: `{tool}` is not on PATH. See OPENJIG.md.")
    if not ensure_daemon():
        sys.exit(1)
    if not argv:
        return show_in_herdr()
    if argv[0] != "menu":
        if not open_rig(argv[0]):
            known = ", ".join(sorted(r["name"] for r in rigs())) or "none"
            sys.exit(f"openjig: no rig named {argv[0]}. Your rigs: {known}")
        return
    os.environ.setdefault("ESCDELAY", "25")  # make Esc feel instant in curses
    choice = curses.wrapper(home)
    if not choice:
        return
    kind, name = choice[0], choice[1]
    if kind == "stop":
        run(["rig", "down", name])
    elif kind == "start":
        if name is None:
            start_agent(choice[2])
        else:
            start_starter(name, choice[2])
    else:
        open_rig(name)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        pass
