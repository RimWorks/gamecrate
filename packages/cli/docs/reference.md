# Reference

Back to the [`@gamecrate/cli` README](../README.md).

Every subcommand, flag, environment variable, and exit code. `gamecrate help <subcommand>`
prints the same flags with one line each.

## Subcommands

The subcommand slot defaults to `run`, so `gamecrate rimworld dev` and
`gamecrate run rimworld dev` do the same thing.

| Subcommand | What it does |
| --- | --- |
| `run <game> [profile]` | Resolve, stage, and launch |
| `list [game]` | Games, profiles, and where each profile came from |
| `mods <game> [profile]` | The resolved mod set: source kind plus absolute path |
| `mods add <game> <source>` | Pin a mod into a library from a path, a workshop id, or a git URL |
| `mods rm <game> <id>...` | Drop library pins by package id |
| `mods sync [game] [id]...` | Fetch every git-pinned clone, fixed pins too |
| `doctor` | Preflight: Docker, CDI, registry auth, game dirs, scan roots, permissions, workshop root |
| `clean <game> [profile]` | Tiered wipe of a profile |
| `clone <game> <src> <dst>` | Reflink-copy a profile's precious tier |
| `logs <game> [profile]` | Print the last run's captured logs. `-f` follows the live run instead |
| `attach <game> [profile]` | Stream a detached run's output from the start. Ctrl-C leaves the game running |
| `wait <game> [profile]` | Block until a detached run ends, then exit with its code |
| `ps` | Every live run: game, profile/instance, mode, pid, container, then uptime or status |
| `stop <game> [profile]` | Stop a detached run and release its lock |
| `build <game>` | Build or pull the runtime image, no launch |
| `shell <game> [profile]` | Same mounts, bash instead of the game |
| `verify <game> [profile]` | What the running container bound, and whether it looks current |
| `config edit` | Open the global config in `$VISUAL` or `$EDITOR`, validate on save |
| `fix-perms <game> [profile]` | Chown foreign-owned files back to the caller |
| `help [topic]` | Help for a subcommand or a game |
| `version` | Print the version |

`gamecrate help <game>` lists that game's profiles and modes. `gamecrate help completion bash`
and `gamecrate help completion zsh` print a shell completion script.

Game arguments go after a bare `--` and nowhere else. A first word that is neither a game nor
a subcommand fails with `<word> is not a game or a subcommand`, with a did-you-mean when one is
close.

## Flags

`--json` and `--help` apply everywhere. A value flag given twice is a usage error, unless the
flag is marked repeatable.

Mod set:

- `--mod <id>` adds a mod to the profile set. Repeatable.
- `--without <id>` drops a mod from the resolved set. Repeatable.
- `--only <id>` restricts the resolved set to these mods. Repeatable.
- `--use <packageId>=<path>` forces one mod to load from a directory. Repeatable.
- `--sort <topo|none>` picks a topological sort, the default, or the profile order.

Library writes. Only `--global` and `--project` reach `mods rm`; the rest are `mods add` only:

- `--path <dir>`, `--workshop <id>`, and `--git <url>` are the three source kinds. `mods add`
  takes exactly one.
- `--branch <name>`, `--tag <name>`, and `--commit <sha>` pin a `--git` source. Pick one.
- `--subdir <path>` starts the manifest walk below the repository root.
- `--global` writes the global config, `--project` the nearest `.gamecrate` file. `add` and `rm`
  need one of the two.
- `--force` overwrites a pin that is already there. `mods rm` has no force: a missing id always
  fails.

Worktrees and instances:

- `--worktree <path>` promotes mods from a linked git worktree, in its own instance. Repeatable,
  and earlier flags outrank later ones.
- `--no-worktree` turns worktree promotion off completely. It ignores the current directory,
  `$GAMECRATE_WORKTREE`, any `--worktree` flag you also typed, and an instance's configured
  `worktree`.
- `--instance <name>` runs under a named sub-profile with its own saves, logs, and container.

Display and lifetime:

- `--mode <headed|headless|screenshot>` chooses how the game displays. Default `headed`.
- `--resolution <width>x<height>` overrides the game resolution.
- `--marker <str>` exits 0 as soon as that string appears in the log.
- `--timeout <seconds>` bounds a run with a `--marker`, in any mode, and a `--mode headless`
  run without one. A `--mode screenshot` run with no marker is bounded by `--render-wait`
  instead, and a headed run by its window, so neither of those reads this. Default 420.
- `--render-wait <seconds>` sets the settle time before a screenshot. Default 25.

Container and build:

- `--network <none|bridge|host>` sets the container network mode.
- `--pull <always|missing|never>` decides when to pull the runtime image. `run` defaults to
  `missing`, `build` to `always`.
- `--build` compiles local C# mods first. `--no-build` never compiles, even when an assembly
  looks stale.
- `--no-stale-check` drops the warning about sources newer than assemblies. The check still runs.
- `--docker-arg <arg>` adds one argv element to `docker run`. Repeatable, and the one flag whose
  value may start with a dash.
- `--root` runs as root instead of mapping your uid.
- `--replace` stops whatever holds this profile and instance, then launches. `--no-replace`
  refuses instead.
- `--detach` launches in the background. `--no-detach` stays in the foreground, whatever the
  profile or the repo config asks for.

Output and dry runs:

- `--dry-run` resolves and validates fully, then writes nothing.
- `--print-plan` prints the resolved launch plan instead of launching.
- `--log <path>` routes launch output to one file. `run` and `shell` read it.
- `--json` switches to machine-readable output.
- `-f`, `--follow` keeps printing as the run writes. `logs` takes it.

`clean` adds three tier flags: `--staging` (the default), `--logs`, and `--all`. `--all` deletes
saves, so it needs `--yes`. `clone` and `fix-perms` take `--yes` too, and `fix-perms` takes
`--dry-run`.

Pairs that contradict each other are usage errors: `--build` with `--no-build`, `--replace` with
`--no-replace`, `--detach` with `--no-detach`, and `--detach` with either `--dry-run` or
`--print-plan`.

## Environment variables

Each variable stands in for one flag, and only when you leave that flag off:

`GAMECRATE_INSTANCE`, `GAMECRATE_MODE`, `GAMECRATE_MARKER`, `GAMECRATE_TIMEOUT`,
`GAMECRATE_RENDER_WAIT`, `GAMECRATE_NETWORK`, `GAMECRATE_PULL`, `GAMECRATE_BUILD`,
`GAMECRATE_SORT`, `GAMECRATE_ROOT`.

A value goes through the flag's own parser, so a bad one fails the way a bad flag does.
`GAMECRATE_ROOT` reads `1`, `true`, or `yes` as on. A `.gamecrate` file's keys sit below both:
flag, then variable, then file.

`GAMECRATE_WORKTREE` names a worktree to promote, and `--no-worktree` cancels it. The value
`off` reads as unset.

`XDG_CONFIG_HOME` moves the config directory and `XDG_CACHE_HOME` moves the workshop scan
cache. `VISUAL` and `EDITOR` name the editor `config edit` opens.

## Exit codes

- `0` success
- `1` the game itself failed
- `2` usage error
- `3` config error
- `4` resolution error
- `5` environment problem, such as a missing Docker
- `6` the marker never appeared before the timeout
- `7` refused, because this profile and instance already run. `wait` and `stop` use it for a
  lock whose holder is gone, or one that does not let go
- `8` `verify` found a stale mod
- `130` interrupted

`wait` exits with whatever code the detached run recorded, which is any code in this list
except `8`, since only `verify` returns that and `verify` is never supervised.
A supervisor that fails before Docker records `3`, `4`, `5` or `7`.
`wait` hands that code back unchanged.
So a script must handle the whole list, not only the four codes a finished game uses.
