# Running

Back to the [`@gamecrate/cli` README](../README.md).

This page follows one run from the command line to the exit code, then covers the commands
that watch, stop, and clean up after it. [Reference](reference.md) lists every flag.

## A launch, step by step

The subcommand slot defaults to `run`, so `gamecrate rimworld dev` and
`gamecrate run rimworld dev` do the same thing. Game arguments go after a bare `--` and nowhere
else.

A run does these things in order:

1. Fetches or clones every git-pinned mod the profile names. See
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
| `.stage/` | The staged mod tree, rebuilt on every launch |
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
layer over the game image once, with `-gamecrate` appended to its tag. That layer carries a
virtual X server and ImageMagick, and gamecrate rebuilds it when the base image changes.

What ends a run depends on the mode and on `--marker`:

| Run | Ends when |
| --- | --- |
| Any mode with `--marker` | The string appears in the log, exit `0`. `--timeout` seconds pass first, exit `6` |
| Screenshot, no marker | `--render-wait` seconds pass, then one frame is captured and the container stops |
| Headless, no marker | `--timeout` seconds pass, exit `0` |
| Headed, no marker | The game exits, or you close its window |

`--timeout` defaults to 420 seconds and `--render-wait` to 25. A screenshot run with a marker
grabs its frame when the marker appears. The frame lands at `<run dir>/<game>.png`. A
marker-less screenshot run whose capture fails exits `5`. Ctrl-C in any mode stops the container and exits `130`.

The game's own exit code passes through unchanged, except that anything outside `0` to `255`
reads as `1`.

## Build policy

Local mods carry C# sources, and a source newer than the assembly it compiled into means you
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

## One run per profile and instance

A profile and instance holds one lock while it runs. A second launch of the same one is refused
with exit `7`. The message names the container or the pid that holds it. `--replace` stops that run first,
through the same path `stop` uses, so the replaced run records `stopped`. `--no-replace` refuses
even when the profile asks for `replace: true`.

Two instances of one profile never meet at the lock. `--instance <name>` picks one you declared,
and a selected worktree derives one.

## Detached runs

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
without a word. `--no-detach` is the way past a configured default.

### Read the result with `wait`

A detached launch returns `0` to your shell as soon as gamecrate writes the lock. That says
the supervisor started, and nothing about how the game ended. **`wait` is how a script gets the
real exit code.** It blocks until the run ends, then exits with that code:

```sh
gamecrate rimworld dev --detach
gamecrate wait rimworld dev
echo $?
```

gamecrate sends no desktop notification when a detached run fails. Nothing pops up and nothing
writes to your terminal, so `wait`, `ps`, and the `last-exit.json` file are the only ways to
learn about it. That file sits at `.gamecrate/last-exit.json` inside the instance directory.
For a plain profile that is `<dataRoot>/<game>/<profile>`. For a worktree run the instance name
carries a hash of the worktree path, so read `instanceDir` from `--print-plan --json` rather
than computing it. Or use `wait`.

`wait` exits `2` when no run was ever recorded, and `7` when the lock holder died without
recording an exit. `7` means the lock is stale: `gamecrate stop <game> <profile>` clears it.

A supervisor that fails before Docker records `3`, `4`, `5` or `7`, and `wait` hands that code
back unchanged. Its own output goes to `supervisor.log` inside the run directory, unless
`--log` sent it elsewhere.

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

`gamecrate attach <game> <profile>` streams that run's captured output from the beginning of
the log. Ctrl-C stops the stream and leaves the game running. `gamecrate logs <game> <profile>
-f` follows the same log from the end instead. Both wait for a live run to open its log first,
because the lock exists before the log does. After two seconds of waiting they say so, and again
every thirty.

`gamecrate logs <game> <profile>` without `-f` prints every file from the last run, each line
prefixed with its filename. No run yet is exit `2`.

### Stop a run

`gamecrate stop <game> <profile>` signals the supervisor and waits up to 20 seconds for the
lock to be released. It clears the lock itself only when the holder died first; a live
supervisor releases its own. It exits `7` when the lock still names a live process after the
wait, and it does not look at the container to decide that.

A run whose supervisor is already dead takes a different path: `stop` stops the container
itself, clears the stale lock, and exits `0`. A profile with no lock at all prints `is not
running` and exits `0`.

## Headed runs on X11

A headed run retitles its own window to `<game> <profile>`, or `<game> <profile> / <instance>`,
and fixes what the window manager knows about it. That needs two programs on the host, and it
only happens when `settings.display` is `x11`. A Wayland client owns its own caption and close
button, so gamecrate leaves it alone.

gamecrate takes a snapshot of the open windows and starts the container. It then watches for
up to three minutes for a new window whose class matches the game executable. The first one that no
other gamecrate has claimed is adopted.

**`xprop` is load-bearing.** gamecrate writes its own pid onto the window it adopts, then reads
that pid back. That is how it tells its window apart from another run's. Without `xprop` it can
do neither, so two concurrent headed runs adopt the same window. Destroying that one window
tears down both containers, and the second run loses an unsaved game.

The titlebar X is the one close route that stays harmless without `xprop`. RimWorld claims
`WM_DELETE_WINDOW` and then ignores it, so that button does nothing until gamecrate strips the
claim. Stripping it takes `xprop`. Every other route to destroying the window, such as a window
manager shortcut or `xkill`, fires both teardowns.

With `xprop` installed, the strip is what makes the titlebar X end the run. The window manager
destroys the window, gamecrate sees it go, and stops that run's container. The run then exits
`0` with the reason `window-closed`.

A missing `wmctrl` costs more than the title. gamecrate warns and then skips the whole window
step, because the snapshot it needs comes from `wmctrl`. So the `WM_DELETE_WINDOW` strip never
runs even with `xprop` installed, the titlebar X goes back to doing nothing, and closing the
window no longer stops the container.

## Other subcommands

`gamecrate verify <game> [profile]` inspects the running container and lists what it bound:
each mod's host directory, its newest assembly, and whether sources are newer. A stale mod is
exit `8`. No running container is exit `5`.

`gamecrate clean <game> [profile]` wipes one tier. `--staging`, the default, removes `.stage`.
`--logs` removes the captured logs. Both act on one instance. `--all` removes the whole profile
directory, every instance and every save with it, so it counts the saves and refuses without
`--yes`.

`gamecrate clone <game> <src> <dst>` copies a profile's `game/` directory to a new profile with
`cp -a --reflink=auto`, which is constant time on a filesystem that supports reflink copies. An existing destination needs `--yes`.

`gamecrate shell <game> [profile]` starts the container with the same mounts and runs `bash`
instead of the game.

`gamecrate build <game>` pulls or builds the image and stops. Its `--pull` defaults to `always`,
where `run` defaults to `missing`.

`gamecrate fix-perms <game> [profile]` finds files under the profile tree that your uid does
not own, which happens when Docker creates a directory as root. It lists them and exits `5`
until you pass `--yes`, then it changes the owner where it can and removes any empty directory it cannot.
