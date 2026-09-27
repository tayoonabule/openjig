# openjig in plain English

One Mac, one cmux window, Herdr inside it, jcode agents doing the work. This page
covers the four words you need and the handful of commands you actually use.

## The four words

- **Rig**: a team of AI agents running in the background. Each agent is a "seat".
  Rigs keep running when you close the terminal. The `kernel` rig is always there: it's
  OpenRig's own helper team, not one of your projects. Leave it alone.
- **Project**: one of your repos, registered so OpenRig can show its plan.
- **Mission**: a big goal inside a project ("ship the billing page"). It's a folder.
- **Slice**: one small, checkable piece of a mission ("add the invoice table").
  Also a folder, with a spec, a progress checklist and a place for proof.

Rigs do the work. Projects, missions and slices are just the written plan the agents
read. You can use rigs without ever creating a mission.

## Everyday: get back to work

```bash
openjig
```

Opens Herdr with every running rig. Each rig is one workspace in Herdr's sidebar, with
its agents on the left and **mission control** (OpenRig's operator view, `rig tui`) on
the right. Click between workspaces to switch projects. That's the whole "switching" story.

- `openjig <rig>` jumps straight to one rig, restarting it first if it's stopped.
- `openjig menu` is a clickable list: jump in, restart, stop, or start a new rig.
- Closing a Herdr tab does **not** stop the agents. `rig down <rig>` stops them (their
  conversations are saved), and `openjig <rig>` brings them back with their memory intact.
- `rig ps` lists what's running.

## Start agents on a project

In `openjig menu`, under **Start a new rig in a project**:

- **+ one jcode agent**: one agent in the repo you pick, named after the repo. Use
  this for most projects. Run it once per project.
- **+ first-project-jcode** or **+ implementation-pair-jcode**: a ready-made pair
  (a builder and a checker). Each of these can only run in one project at a time.

The same without the menu:

```bash
rig create my-repo --runtime jcode --cwd ~/Documents/GitHub/my-repo
rig terminal open my-repo --provider herdr
```

Talk to an agent by typing in its Herdr tile, or from anywhere with
`rig send <seat> "message"` (seat names are in `rig ps --nodes`).

## Give a project a plan (optional)

Do this once per repo:

```bash
rig config init-workspace --root ~/Documents/GitHub/my-repo
```

That sets up the plan folders and adds the repo to your project list. Then, from
anywhere inside the repo, create a mission and a slice in it:

```bash
cd ~/Documents/GitHub/my-repo
rig scope mission create billing-page --intent "Ship the billing page"
rig scope slice create billing-page invoice-table --intent "Show past invoices"
```

That creates `missions/billing-page/slices/01-invoice-table/` in the repo. Fill in its
`SPEC.md` (what "done" means), or ask the agent to. Agents started in that repo find
the mission and slice by themselves.

Handy follow-ups (run inside the repo):

```bash
rig scope mission ls
rig scope slice ls --mission billing-page
rig scope slice progress 01-invoice-table --mission billing-page --add "table renders" --status done
```

In practice you rarely type these. Tell the agent "work on slice invoice-table and keep
its PROGRESS.md up to date" and it uses them itself.

## See the plan

```bash
rig tui
```

Type `:scopes` (the screen is labelled PROJECTS), pick a project, then a mission, to
see its slices and their status. The web UI (`rig ui open`) shows the same thing
under **Project**.

## Models

Each seat runs the model its rig pins. Change one with
`rig seat set-model <seat> <model>` (`jcode model list` shows what you can use). The
new model applies the next time that seat starts fresh.

## If something looks wrong

- `rig doctor` checks the install.
- `rig ps --nodes --rig <rig>` shows each seat's state.
- `rig capture <seat>` prints what's on that agent's screen.
