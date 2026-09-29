# Running

Back to the [`@gamecrate/cli` README](../README.md).

This page follows one run from the command line to the exit code, then covers the commands
that watch, stop, and clean up after it. [Reference](reference.md) lists every flag.

## A launch, step by step

Game arguments go after a bare `--` and nowhere else. See
[Subcommands](reference.md#subcommands) for what happens when two games share a profile name.

A run does these things in order:

1. Fetches or clones every git-pinned mod the profile lists. See
[Mod sources](mod-sources.md#git-sources).
2. Builds the mod index and resolves the profile into a mod set. Every problem is collected and
reported together, with exit `4`.
3. Runs the preflight checks: Docker, the image, the CDI spec when `gpu` is on, the game
directory, every bind source, and the display. Problems here are exit `5`.
4. Builds stale local C# mods, per the build policy.
5. Pulls or builds the image, per `--pull`.
6. Wipes and rebuilds the staging tree, writes the mods config and prefs files, and starts the
container.

`--dry-run` stops after step 3 and prints `<game> <profile>: N mods resolve cleanly`.
`--print-plan` stops at the same point and prints the plan instead. Neither writes anything.
Both still ask a remote for the default branch of an unpinned git entry.

## Where things land

Everything a profile writes hangs off `<dataRoot>/<game>/<profile>`. `dataRoot` defaults to
`~/.local/share/gamecrate` and is a top-level config key. An instance lives one level down, at
`<profile>/instances/<name>`.

| Path | Holds |
| --- | --- |
| `game/` | The game's data directory: saves, the mods config, prefs |
| `config/` | The XDG config, data, and cache directories the engine sees. Shared by every instance |
| `.stage/` | The staged mod tree, rebuilt on every launch, bound read-only into the container |
| `logs/runs/<timestamp>/` | One directory per run: `stdout.log`, the engine log, a screenshot |
| `logs/current` | A symlink to the newest run |
| `.gamecrate/lock` | Held while a run is up |
| `.gamecrate/last-exit.json` | What the last supervised run returned |
| `.gamecrate/launches.jsonl` | One line per launch: image digest, mods, worktrees |

gamecrate keeps the ten newest run directories and deletes the rest. The container is named
`gamecrate-<game>-<profile>`, with `-<instance>` appended for an instance.

## Modes and how a run ends

`--mode` picks `headed`, `headless`, or `screenshot`. A plugin declares which modes its game
supports. Headless and screenshot runs need an X server in the image. gamecrate builds a thin
layer over the game image once, with `-gamecrate` appended to its tag. That layer holds a
virtual X server and ImageMagick, and gamecrate rebuilds it when the base image changes.

What ends a run depends on the mode and on `--marker`:

| Run | Ends when |
| --- | --- |
| Any mode with `--marker` | The string appears in the log, exit `0`. `--timeout` seconds pass first, exit `6` |
| Screenshot, no marker | `--render-wait` seconds pass, then one frame is captured and the container stops |
| Headless, no marker | `--timeout` seconds pass, exit `0` |
| Headed, no marker | The game exits, or you close its window |

`--timeout` defaults to 420 seconds and `--render-wait` to 25. A screenshot run with a marker
grabs its frame when the marker appears. The frame lands at `<run dir>/<game>-<timestamp>.png`, so
copies of several runs never collide. A marker-less screenshot run whose capture fails exits `5`.
Ctrl-C in any mode stops the container and exits `130`.

The game's own exit code passes through unchanged. A container killed by a signal reports no
code at all, so gamecrate reports `128+n` instead: `137` for SIGKILL, `143` for SIGTERM. Any
other code outside `0` to `255` reads as `1`.

## Build policy

Local mods hold C# sources, and a source newer than the assembly it compiled into means you
are about to run stale code. Resolution checks every local mod, including git clones and
worktrees.

| Policy | Builds |
| --- | --- |
| `auto`, the default | Every local mod that looks stale. A mod with sources and no assembly at all counts |
| `always` | Every local mod with a `.csproj` or `.slnx` |
| `never` | Nothing |

`--build` means `always`, `--no-build` means `never`, and `build:` on the profile sets the
default. A failed build stops the launch with exit `5`. The stale warning prints whether or not
a build ran, unless you pass `--no-stale-check`. That flag only silences the warning; the check
still runs.

## The mod loop

```sh
gamecrate run dev --use yourname.yourmod=~/src/yourmod --build
gamecrate verify dev
```

Edit the mod and launch again. `verify` inspects the running container and lists what it bound:
each mod's host directory, its newest assembly, and whether the sources are newer. A stale mod
is exit `8`, so a script catches a run that loaded old code. No running container is exit `5`.

## Passing arguments to the game

Anything after a bare `--` goes to the game, not to gamecrate:

```sh
gamecrate run dev -- -WatchShader
```

For an argument you want on every launch, write `settings.gameArgs` instead. It works at any
layer of the config:

```yaml
defaults:
  settings:
    gameArgs: ['-WatchShader']       # every game, every profile
games:
  rimworld:
    profiles:
      dev:
        settings:
          gameArgs: ['-savedatafolder=/data']   # this profile only
```

`gameArgs` is one of two settings that **concatenate** instead of replacing, so each layer adds
to the earlier ones rather than wiping them. The order is the top-level `defaults`, the game,
the profile, the instance, then the command line. Launch `dev` with `-- -quicktest` and the game
gets all three, in that order: `-WatchShader`, `-savedatafolder=/data`, `-quicktest`.

gamecrate never reads these. An argument the game does not know is the game's problem, not a
config error. Check the game's own log when one does nothing.

## One run per profile and instance

A profile and instance holds one lock while it runs. A second launch of the same one is refused
with exit `7`. The message gives the container or the pid that holds it. `--replace` stops that
run first, through the same path `stop` uses, so the replaced run records `stopped`.
`--no-replace` refuses even when the profile asks for `replace: true`.

Two instances of one profile never meet at the lock. `--instance <name>` picks one you declared,
and a selected worktree derives one.

## Detached runs

The whole background loop is five commands:

```sh
gamecrate run dev --detach
gamecrate ps
gamecrate attach dev
gamecrate logs dev -f
gamecrate stop dev
```

`--detach` re-executes gamecrate as a background supervisor. It writes the lock with that
supervisor's pid, prints `<game> <profile> -> <container> (pid <n>)`, and gives you the prompt
back. The supervisor owns the run from there. It builds stale mods, pulls or builds the image,
stages the mods, starts the container, and records the exit.

Three things refuse a `--detach` you typed, and each says so with exit `2`:

- `shell` needs the terminal that `--detach` gives up.
- `--dry-run` has no run to supervise.
- `--print-plan` has no run to supervise.

The refusal is for the flag, not for detaching. A `detach: true` in a profile or a repo config
is a default, so `shell`, `--dry-run` and `--print-plan` ignore it and run in the foreground
without a word. `--no-detach` turns a configured default off.

### Read the result with `wait`

A detached launch returns `0` to your shell as soon as gamecrate writes the lock. That says
the supervisor started, and nothing about how the game ended. **`wait` is how a script gets the
real exit code.** It blocks until the run ends, then exits with that code:

```sh
gamecrate run dev --detach
gamecrate wait dev
echo $?
```

gamecrate sends no desktop notification when a detached run fails. Nothing pops up and nothing
writes to your terminal, so `wait`, `ps`, and the `last-exit.json` file are the only ways to
learn about it. That file sits at `.gamecrate/last-exit.json` inside the instance directory.
For a plain profile that is `<dataRoot>/<game>/<profile>`. For a worktree run the instance name
includes a hash of the worktree path, so read `instanceDir` from `--print-plan --json` rather
than computing it. Or use `wait`.

`wait` exits `2` when no run was ever recorded, and `7` when the lock holder died without
recording an exit. `7` means the lock is stale: `gamecrate stop <profile>` clears it.

A supervisor that fails before Docker records `3`, `4`, `5` or `7`, and `wait` hands that code
back unchanged. Its own output goes to `supervisor.log` inside the run directory, unless you
pass a path with `--log`.

### Watch a run that is already going

```sh
gamecrate ps
```

```
rimworld  mpf/simulator-test  headless  1474870  gamecrate-rimworld-mpf-simulator-test  Up 7 minutes
```

The columns are game, profile with its instance, mode, supervisor pid, container, and
uptime. A run that holds a lock but has no container yet reads `starting`, because staging and
the image come before `docker run`. A lock with no live supervisor reads `orphaned`, and
`ps` tells you to run `stop`.

`gamecrate attach <profile>` streams that run's captured output from the beginning of
the log. Ctrl-C stops the stream and leaves the game running. `gamecrate logs <profile>
-f` follows the same log from the end instead. Both wait for a live run to open its log first,
because the lock exists before the log does. After two seconds of waiting they say so, and again
every thirty.

`gamecrate logs <profile>` without `-f` prints every file from the last run, each line
prefixed with its filename. No run yet is exit `2`.

### Stop a run

`gamecrate stop <profile>` signals the supervisor and waits up to 20 seconds for the
lock to be released. It clears the lock itself only when the holder died first; a live
supervisor releases its own. It exits `7` when the lock still points at a live process after the
wait, and it does not look at the container to decide that.

A run whose supervisor is already dead takes a different path: `stop` stops the container
itself, clears the stale lock, and exits `0`. A profile with no lock at all prints `is not
running` and exits `0`.

`attach`, `logs`, `wait`, `stop`, `verify`, and `clean` all take `--instance <name>` and
`--worktree <path>`, so each one acts on the same instance the run does. They also take `--json`
to print machine-readable output instead of text.

## The live dashboard

A headed run on a real terminal shows a dashboard instead of scrolling output. The header gives
the game, the profile, and the container. Below it are the elapsed time, the container's CPU and
memory, and the host's GPU and VRAM.

The log pane keeps the colours the game wrote. Press `/` to filter it, then type. While the
filter is open, every letter is text, so `q` types a `q`. Press Enter to keep the filter, or
Escape to clear it.

| Key | Does |
| --- | --- |
| `/` | Open the filter |
| `g`, `G` | Jump to the top or the bottom |
| `r` | Switch between records and raw output |
| Arrows, Page Up, Page Down, Home, End | Scroll the pane |
| `q`, Ctrl-C | Stop the run and quit |

### The record pane

RimLogging, a RimWorld logging mod, can write every log line a second time as one JSON object
per line. That sink ships
turned off, so gamecrate turns it on for you. A launch whose profile loads RimLogging writes
`RollingJson` into the mod's own settings file first.

When the records start to arrive, the footer offers `r`. Press it and the pane switches to one
row per record, with the time, the level, and the channel on the left.

An exception is one row, not the twenty stack lines raw output gives you. The pane's own rule
says `records` or `log`, and the count on the right says `records` or `lines`, so you can always
tell which pane you are in. The filter works the same in both.

A profile that loads no record-writing mod never offers the key, and the pane stays on raw output.

The game's `records` block in the config names the mod, the directory it writes to, and the
settings that turn its JSON sink on. The RimWorld plugin sets all of it, so you write that block
only for a different game or a different mod.

When the game exits non-zero, the dashboard stays up so you can read what happened. The header
shows the exit code and the footer changes to `run ended, q to close`. A clean exit closes the
dashboard at once, and so does stopping the run yourself.

gamecrate scrolls the output instead of drawing a dashboard when any of these is true:

- You passed `--plain`, `--quiet`, `--json`, `--marker`, or `--detach`
- The subcommand is `shell`, which needs the terminal for bash
- The mode is not `headed`
- Standard input or standard output is not a terminal, `TERM` is unset or `dumb`, or CI is
detected

Set `CI=false` to force the dashboard on inside a pipeline. `NO_COLOR` turns the colours off and
leaves the layout.

`--log <path>` writes everything a foreground run prints to that file as well as to the
terminal, and `run` and `shell` both take it. `-q` prints nothing to the terminal, and `--log`
still gets every line.

GPU and VRAM are host-wide figures. Docker reports no GPU usage per container, so gamecrate does
not invent one.

## Headed runs on X11

A headed run retitles its own window to `<game> <profile>`, or `<game> <profile> / <instance>`.
That takes `xprop` and `wmctrl` on the host, and only happens when `settings.display` is `x11`.
A Wayland client owns its own caption and close button, so gamecrate leaves it alone.

`xprop` also strips RimWorld's claim on `WM_DELETE_WINDOW`, which is what makes the titlebar X
end the run. The run then exits `0` with the reason `window-closed`.

**Install `xprop` before you start two headed runs at once.** gamecrate marks the window it
adopts with its own pid, and that mark is the only thing that tells two runs' windows apart.
Without it both runs adopt the same window, so destroying that window tears down both containers
and the second run loses an unsaved game.

A missing `wmctrl` skips the window step altogether, with a warning. The titlebar X then does
nothing, and closing the window leaves the container running.

## Other subcommands

`gamecrate clean [profile]` deletes one tier:

| Flag | Deletes |
| --- | --- |
| `--staging`, the default | `.stage`, the staged copies of the mods |
| `--logs` | The logs the runs captured |
| `--downloads` | This game's workshop downloads, keeping the steamcmd install itself |
| `--all` | The whole profile directory **and** this game's workshop downloads |

`--staging` and `--logs` act on one instance. `--all` takes every instance, every save, and the
workshop downloads, so it counts the saves and refuses with exit `2` until you pass `--yes`.
Re-downloading a large workshop set costs more than the disk it frees, so reach for `--logs` or
`--staging` first.

`gamecrate clone <src> <dst>` copies a profile's `game/` directory to a new profile with `cp -a
--reflink=auto`, which is constant time on a filesystem that supports reflink copies. An existing
destination needs `--yes`.

`gamecrate shell [profile]` starts the container with the same mounts and runs `bash`
instead of the game. It takes the same lock a run does, so `--replace` stops whatever holds the
profile first.

`gamecrate build [profile]` pulls or builds the image and stops. Its `--pull` defaults to
`always`, where `run` defaults to `missing`.

`gamecrate fix-perms [profile]` finds files under the profile tree that your uid does not own,
which happens when Docker creates a directory as root. It lists them and exits `5` until you pass
`--yes`, then it changes the owner where it can and removes any empty directory it cannot.
