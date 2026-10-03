# Running

Back to the [`@gamecrate/cli` README](../README.md).

This page follows one run to its exit code. [Reference](reference.md) lists every flag.

## A launch, step by step

| Step | Does | Fails with |
| --- | --- | --- |
| 1 | Fetches or clones every git-pinned mod the profile lists. See [Mod sources](mod-sources.md#git-sources) | |
| 2 | Builds the mod index and resolves the profile into a mod set, collecting every problem | `4` |
| 3 | Preflight: Docker, the image, the CDI spec when `gpu` is on, the game directory, every bind source, the display | `5` |
| 4 | Builds stale local C# mods, per the build policy | `5` |
| 5 | Pulls or builds the image, per `--pull` | |
| 6 | Wipes and rebuilds the staging tree, writes the mods config and prefs, starts the container | |

Two flags stop after step 3. `--dry-run` prints `<game> <profile>: N mods resolve cleanly`, and
`--print-plan` prints the plan instead. Neither writes anything, and both still ask a remote for
the default branch of an unpinned git entry. Game arguments go after a bare `--`. See [Subcommands](reference.md#subcommands) for two
games sharing a profile name.

## Where things land

Everything a profile writes hangs off `<dataRoot>/<game>/<profile>`, and an instance sits at
`<profile>/instances/<name>`. `dataRoot` is a top-level config key, default
`~/.local/share/gamecrate`.

- `game/` is the game's data directory: saves, the mods config, prefs.
- `config/` holds the XDG config, data, and cache directories the engine sees. Every instance
  shares one.
- `.stage/` is the staged mod tree. Every launch rebuilds it, and the container gets it read-only.
- `logs/runs/<timestamp>/` is one directory per run: `stdout.log`, the engine log, a screenshot.
- `logs/current` symlinks to the newest run.
- `.gamecrate/lock` exists while a run is up.
- `.gamecrate/last-exit.json` records what the last supervised run returned.
- `.gamecrate/launches.jsonl` holds one line per launch: image digest, mods, worktrees.

Every launch keeps the ten newest run directories and deletes the rest. Set `prune.keepRuns` to
change that number, and see [Pruning old runs](#pruning-old-runs) for the sweep that covers
everything else. The container is named `gamecrate-<game>-<profile>`, plus `-<instance>` for an
instance.

## Modes and how a run ends

`--mode` picks `headed`, `headless`, or `screenshot`, and a plugin declares which its game
supports. The last two need an X server. For those, gamecrate builds a thin layer over the game
image, tagged `-gamecrate`, that holds a virtual X server and ImageMagick. A new base image
rebuilds it.

- Headed ends when the game exits, or when you close its window.
- Headless ends after `--timeout` seconds, exit `0`.
- Screenshot waits `--render-wait` seconds, grabs a frame to `<run dir>/<game>-<timestamp>.png`,
  then stops. A failed capture gives `5`.
- `--marker`, in any mode, ends the run at exit `0` once that text reaches the log, `6` on timeout.
  A screenshot run grabs its frame then.

A game hands back its own code, unless it falls outside `0` to `255`, which becomes `1`. Ctrl-C
gives `130` and stops the container. [Reference](reference.md#exit-codes) lists the rest.

## Build policy

A C# source newer than the assembly it compiled into means stale code. Resolution checks every
local mod including git clones and worktrees. A failed build stops the launch with exit `5`.

There are three policies. `auto`, the default, builds every local mod that looks stale, counting a
mod with sources and no assembly at all. `always` builds every local mod with a `.csproj` or
`.slnx`. `never` builds nothing.

- `--build` selects `always`, and `--no-build` selects `never`.
- `build:` on the profile sets the default policy for that profile.
- `--no-stale-check` silences the stale warning, which otherwise prints whether or not a build
  ran. The check itself still runs.

## The mod loop

```sh
gamecrate run dev --use yourname.yourmod=~/src/yourmod --build
gamecrate verify dev
```

`verify` inspects the running container and lists each bound mod's host directory, its newest
assembly, and whether the sources are newer. A stale mod is exit `8`, no running container exit `5`.

## Passing arguments to the game

```sh
gamecrate run dev -- -WatchShader
```

For an argument you want on every launch, write `settings.gameArgs` instead. It concatenates
across layers rather than replacing, in this order:

1. The top-level `defaults`
2. The game
3. The profile
4. The instance
5. The command line, after `--`

See [Settings](configuration.md#settings). gamecrate never reads these, so an unknown argument is
the game's problem rather than a config error.

## One run per profile and instance

A profile and instance holds one lock while it runs. A second launch of the same one is refused
with exit `7`. The message gives the container or the pid that holds it.

- `--replace` stops that run first, down the same path `stop` takes, so the older run records
  `stopped`.
- `--no-replace` refuses even when the profile asks for `replace: true`.
- `--instance <name>` picks one of the instances you declared, which never meet at the lock.
- `--worktree <path>` derives an instance name of its own from the checkout you selected.

## Detached runs

```sh
gamecrate run dev --detach
gamecrate wait dev
```

`--detach` re-executes gamecrate as a background supervisor. It writes the lock with that
supervisor's pid, prints `<game> <profile> -> <container> (pid <n>)`, and returns the prompt. The
supervisor records the exit and writes to `supervisor.log` in the run directory, unless `--log`
names a path. `--no-detach` turns a configured default off.

`--detach` on `shell`, `--dry-run`, or `--print-plan` fails with exit `2`, and those three ignore a
config's `detach: true` without a word.

| Command | Does | Exits |
| --- | --- | --- |
| `ps` | Lists every run going now | |
| `attach <profile>` | Streams the captured output from the start of the log. Ctrl-C leaves the game running | |
| `logs <profile>` | Prints every file from the last run, each line prefixed with its filename | `2` with no run yet |
| `logs <profile> -f` | Follows the same log from the end | |
| `wait <profile>` | Blocks until the run ends | The run's own code. `2` when no run was ever recorded. `7` when the holder died without recording an exit, which means a stale lock that `stop` clears |
| `stop <profile>` | Signals the supervisor, then waits up to 20 seconds for the lock | `0` or `7`, as below |

All six take `--instance <name>`, `--worktree <path>`, and `--json`, and so do `verify` and
`clean`.

**`wait` is how a script gets the real exit code.** A detached launch returns `0` at the lock,
which says nothing about how the game ended. `wait` hands back the game's own code, or the code
from a supervisor that failed before Docker. [Reference](reference.md#exit-codes) has the table. No
desktop notification fires on a failure, so `wait`, `ps`, and `.gamecrate/last-exit.json` are the
only ways to learn about it.

### What `ps` prints

```
rimworld  mpf/simulator-test  headless  1474870  gamecrate-rimworld-mpf-simulator-test  Up 7 minutes
```

The columns are game, profile with its instance, mode, supervisor pid, container, and uptime. A
run holding a lock with no container yet reads `starting`. A lock with no live supervisor reads
`orphaned`, and `ps` tells you to run `stop`.

`attach` and `logs -f` both wait for a live run to open its log. After two seconds they say so,
and again every thirty.

### How `stop` clears a lock

| Lock holder | What `stop` does | Exits |
| --- | --- | --- |
| A live supervisor | Signals it and waits. The supervisor releases its own lock | `0` |
| A live supervisor still holding after 20 seconds | Nothing more. It does not look at the container to decide this | `7` |
| A supervisor that already died | Stops the container itself and clears the stale lock | `0` |
| Nothing | Prints `is not running` | `0` |

## The live dashboard

A headed run on a real terminal shows a live dashboard instead of scrolling output. A clean exit
closes it, and so does stopping the run yourself.

- `/` opens the filter, then you type. Every letter counts as text while the filter is open, so `q`
  types a `q`. Enter keeps the filter, and Escape clears it.
- `g` and `G` jump to the top or the bottom.
- `r` switches between records and raw output.
- Arrows, Page Up, Page Down, Home, and End scroll the pane.
- `q` and Ctrl-C stop the run and quit.

`--plain` scrolls the output instead, as do `--json`, `--marker`, `--detach`, `-q`, the `shell`
subcommand, and any mode other than `headed`. No terminal on standard input or output, `TERM` unset
or `dumb`, and a detected CI do the same. `CI=false` forces the dashboard on inside a pipeline, and
`NO_COLOR` drops the colours but keeps the layout.

## Headed runs on X11

gamecrate touches a window only when `settings.display` is `x11`, since a Wayland client owns its
own caption and close button. `xprop` marks the window with gamecrate's pid and strips RimWorld's
claim on `WM_DELETE_WINDOW`, so the titlebar X ends the run with exit `0` and the reason
`window-closed`. `wmctrl` retitles it to `<game> <profile>`, or `<game> <profile> / <instance>`.
gamecrate warns and skips the window step when either one is missing.

## Pruning old runs

A launch trims run directories for the profile it is launching, and nothing else. `gamecrate prune`
sweeps every game, profile, and instance under `dataRoot`, so it takes no profile.

```sh
gamecrate prune --dry-run
gamecrate prune
```

| Deletes | When | Config key |
| --- | --- | --- |
| A run directory under `logs/runs/` | It is past the newest `keepRuns`, or older than `maxAgeDays` | `prune.keepRuns`, `prune.maxAgeDays` |
| `.gamecrate/lock` | Its process is gone and its container is not running | `prune.locks` |
| A workshop item under the steamcmd download root | Nothing has touched it in `maxAgeDays` days | `prune.downloads` |
| A container labelled `gamecrate.game` | It has exited | `prune.containers` |

The newest run directory a profile has always survives, whatever the two numbers say. That keeps
`gamecrate logs` working on a profile you have not launched in months.

Deleting a workshop item also deletes the `appworkshop_<appid>.acf` file beside it. The mod index
caches against that file. Leaving it would keep a cached record pointing at a directory that is
gone. steamcmd writes a fresh `.acf` and re-downloads the item when a profile next needs it.

```jsonc
{
  "prune": {
    "keepRuns": 10,
    "maxAgeDays": 30,
    "locks": true,
    "downloads": true,
    "containers": true
  }
}
```

`--keep <count>` and `--older-than <days>` override the two numbers for one run. `--dry-run` lists
every target and deletes none of them. `--json` prints the same list as JSON. The exit code is `0`,
or `5` when something refused to delete.

### Running prune on a schedule

Weekly is enough for most setups. A systemd user timer is the better of the two options. It logs to
the journal, and `Persistent=true` catches up on a sweep the machine missed while it was off.

`~/.config/systemd/user/gamecrate-prune.service`:

```ini
[Unit]
Description=Prune old gamecrate runs

[Service]
Type=oneshot
ExecStart=%h/.bun/bin/gamecrate prune
```

`~/.config/systemd/user/gamecrate-prune.timer`:

```ini
[Unit]
Description=Prune old gamecrate runs every week

[Timer]
OnCalendar=weekly
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now gamecrate-prune.timer
systemctl --user list-timers gamecrate-prune.timer
journalctl --user -u gamecrate-prune
```

For cron instead, one line in `crontab -e`:

```cron
0 4 * * 0 /home/you/.bun/bin/gamecrate prune >> /tmp/gamecrate-prune.log 2>&1
```

Two things bite on cron. It runs with a short `PATH` and no login shell, so write the absolute path
that `which gamecrate` prints. And it has no desktop session, so rootless Docker needs
`DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock` set in the crontab, or the container sweep finds
nothing and the rest still runs. Both setups need the same `dataRoot` your interactive shell uses,
which means the same user and the same config file.

## Other subcommands

`gamecrate clean [profile]` deletes one tier:

| Flag | Deletes | Reaches |
| --- | --- | --- |
| `--staging`, the default | `.stage`, the staged copies of the mods | One instance |
| `--logs` | The logs the runs captured | One instance |
| `--downloads` | This game's workshop downloads, keeping the steamcmd install itself | The whole game |
| `--all` | The whole profile directory **and** this game's workshop downloads | Every instance and every save. It counts the saves and refuses with exit `2` until you pass `--yes` |

| Command | Does | Notes |
| --- | --- | --- |
| `clone <src> <dst>` | Copies a profile's `game/` directory to a new profile with `cp -a --reflink=auto` | An existing destination needs `--yes` |
| `shell [profile]` | Starts the container with the same mounts and runs `bash` instead of the game | Takes the same lock a run does, so `--replace` stops whatever holds the profile |
| `build [profile]` | Pulls or builds the image and stops | Its `--pull` defaults to `always`, where `run` defaults to `missing` |
| `fix-perms [profile]` | Lists files under the profile tree that your uid does not own, which happens when Docker creates a directory as root | Exits `5` until you pass `--yes`. Then it changes the owner where it can and removes any empty directory it cannot |
