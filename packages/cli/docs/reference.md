# Reference

Back to the [`@gamecrate/cli` README](../README.md).

Every subcommand, flag, environment variable, and exit code. `gamecrate help <subcommand>`
prints the same flags with one line each.

## A first run

```sh
gamecrate init              # pick a game, install its plugin, write a config
gamecrate doctor            # check Docker, the game directory, and permissions
gamecrate run dev --detach  # launch in the background
gamecrate ps                # every run going right now
gamecrate logs dev -f       # follow the output of one
gamecrate stop dev          # stop it and free the profile
```

`init` writes a placeholder for the image reference and the game directory, so edit those before
`doctor`.

Working on a mod between runs:

```sh
gamecrate run dev --use yourname.yourmod=~/src/yourmod --build
gamecrate verify dev
```

`verify` exits `8` when a bound mod's sources are newer than its assemblies.

## Subcommands

**A profile declares its own game.** For a command that takes no profile, gamecrate reads the
`game:` key in the nearest `.gamecrate.yml`, or takes the only game you configured. `--game`
overrides both, and settles it when two games declare the same profile name.

| Subcommand | What it does |
| --- | --- |
| `run [profile]` | Resolve, stage, and launch |
| `list` | Games, profiles, and where each profile came from |
| `mods [profile]` | The resolved mod set: source kind plus absolute path |
| `mods add <source>` | Pin a mod into a library from a path, a workshop id, or a git URL |
| `mods rm <id>...` | Drop library pins by package id |
| `mods sync [id]...` | Fetch every git and workshop source again, fixed pins too |
| `init` | Pick a game, install its plugin, and write a config to start from |
| `doctor` | Preflight: Docker, CDI, registry auth, game dirs, scan roots, permissions, workshop root |
| `clean [profile]` | Tiered wipe of a profile |
| `clone <src> <dst>` | Reflink-copy a profile's `game/` directory, which holds its saves |
| `logs [profile]` | Print the last run's captured logs. `-f` follows the live run instead |
| `attach [profile]` | Stream a detached run's output from the start. Ctrl-C leaves the game running |
| `wait [profile]` | Block until a detached run ends, then exit with its code |
| `ps` | Every live run: game, profile/instance, mode, pid, container, then uptime or status |
| `stop [profile]` | Stop a detached run and release its lock |
| `build [profile]` | Build or pull the runtime image, no launch |
| `steam build` | Download the game from Steam and append it onto a runtime base as an image |
| `steam login` | Sign in to Steam once and store the session for `steam build` |
| `shell [profile]` | Same mounts, bash instead of the game |
| `verify [profile]` | What the running container bound, and whether it looks current |
| `refs [profile]` | Print a directory of the game's managed assemblies for a mod project to reference |
| `config edit` | Open the global config in `$VISUAL` or `$EDITOR`, validate on save |
| `fix-perms [profile]` | Chown foreign-owned files back to the caller |
| `help [topic]` | Help for a subcommand, a subverb, or a game |
| `completion <bash\|zsh>` | Print a shell completion script |
| `version` | Print the version |

`gamecrate` on its own prints help. It never launches, even in a directory whose
`.gamecrate.yml` declares a game. Use `gamecrate run` for that.

`gamecrate help <game>` lists that game's profiles and modes, and `gamecrate help <profile>`
prints the page for the game that declares it. `gamecrate help mods add` prints one subverb's
own flags. A namespace such as `steam` or `config` prints its subverbs when you
give it none.

Game arguments go after a bare `--` and nowhere else, or in `settings.gameArgs`. See
[Passing arguments to the game](running.md#passing-arguments-to-the-game). A first word that is
not a subcommand fails, and a profile or game name says which subcommand you wanted.

Each flag belongs to the subcommands that list it below. A flag used elsewhere is a usage error
that points at the subcommand that does take it, so `gamecrate run dev --push` fails with
`run does not take --push`.

## Flags

`--game`, `--json`, and `--help` apply everywhere. A value flag given twice is a usage error,
unless the flag is marked repeatable.

- `--game <name>` picks the game to act on. Use it when no profile says which and no config
default settles it.

Several flags below reach more than one subcommand:

| Flag | Subcommands that take it |
| --- | --- |
| `--mod`, `--without`, `--only` | `run`, `shell`, `mods` |
| `--sort` | `run`, `mods` |
| `--use` | `run`, `shell` |
| `--instance`, `--worktree`, `--no-worktree` | `run`, `shell`, `clean`, `logs`, `attach`, `wait`, `stop`, `verify` |
| `--image` | `run`, `build`, `refs`, `steam build` |
| `--yes` | `init`, `clean`, `clone`, `fix-perms` |

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
A source must beat its assembly by more than a second to count. One build writes both within
microseconds of each other, and that is not a stale build.
- `--docker-arg <arg>` adds one argv element to `docker run`. Repeatable, and the one flag whose
value may start with a dash.
- `--root` runs as root instead of mapping your uid.
- `--replace` stops whatever holds this profile and instance, then launches. `shell` takes it
too. `--no-replace` refuses instead, and only `run` takes that.
- `--detach` launches in the background. `--no-detach` stays in the foreground, whatever the
profile or the repo config asks for.

Steam images. `steam build` takes every flag in this list, and `run`, `build` and `refs` take
`--image`:

- `--image <ref>` sets the target repository for `steam build`, without a tag. On `run`,
`build` and `refs` it uses that exact ref instead of the configured one, and reads the game
out of the image.
- `--beta <name>` builds only that Steam branch. Repeatable. Default: every branch the plugin
declares.
- `--variant <name>` builds only that image variant. Repeatable. Default: every variant.
- `--alias <tag>` puts one more [moving tag](images.md#tags) on each branch built. Repeatable.
- `--plugin <spec>` picks the plugin package to build with. Repeatable.
- `--load` loads the result into the local Docker daemon. `--push` sends it to a registry.
Without either, `--load` is assumed.
- `--base <ref>` overrides the published runtime base a variant appends onto.
- `--platform <os/arch>` sets what the manifest claims. Default `linux/amd64`.
- `--force` rebuilds even when the published build id already matches the image's label.

`steam login` takes two of its own:

- `--print` also prints the session as base64, for a CI secret.
- `--username <name>` skips the username prompt.

Output and dry runs:

- `--dry-run` resolves and validates fully, then writes nothing.
- `--print-plan` prints the resolved launch plan instead of launching.
- `--log <path>` writes a copy of the launch output to a file. The terminal still gets it.
`run` and `shell` read this flag.
- `-q`, `--quiet` drops the terminal copy. A `--log` file still receives everything, and the
reason a run failed still reaches you.
- `--plain` turns off the live dashboard and scrolls the output instead. `run` and `steam build`
read it.
- `--json` switches to machine-readable output.
- `-f`, `--follow` keeps printing as the run writes. `logs` takes it.

`clean` adds four tier flags: `--staging` (the default), `--logs`, `--downloads`, and `--all`.
`--downloads` drops the game's workshop items and keeps `steamcmd` itself. `--all` deletes saves
and the downloads, so it needs `--yes`. `clone` and `fix-perms` take `--yes` too, and `fix-perms`
takes `--dry-run`.

`init` takes `--yes` and `--project`. `--project` writes the `.gamecrate` file beside your code
instead of the global config.

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

`GAMECRATE_WORKTREE` picks a worktree to promote, and `--no-worktree` cancels it. The value
`off` reads as unset.

`XDG_CONFIG_HOME` moves the config directory and `XDG_CACHE_HOME` moves the workshop scan
cache. `VISUAL` and `EDITOR` name the editor `config edit` opens.

`steam build` reads its credentials from the environment and never from a flag, because a flag
value is readable in the process list on a shared machine:

| Variable | What it holds |
| --- | --- |
| `STEAM_USERNAME` | The Steam account that owns the game |
| `STEAM_CONFIG_VDF` | base64 of a logged-in `config.vdf`, for a runner with no session on disk |
| `STEAM_BRANCH_PASSWORD_<BRANCH>` | The password for one private beta. The branch name goes uppercase, with dashes as underscores |
| `STEAM_BRANCH_PASSWORD` | A fallback password, used only when you build a single branch |
| `GAMECRATE_REGISTRY_USER` | The registry username for `--push` |
| `GAMECRATE_REGISTRY_PASSWORD` | The registry token for `--push` |

A beta password reaches `steamcmd` through a `+runscript` file at mode 0600, so it never appears
in an argument list either.

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
- `128+n` a child died on signal `n`. `137` is SIGKILL and `143` is SIGTERM, which is what a
container stopped by `--replace` returns

`wait` hands back whatever code the detached run recorded, unchanged. That is any code in this
list except `8`, since only `verify` returns that and `verify` is never supervised. A supervisor
that fails before Docker records `3`, `4`, `5` or `7`, so a script has to handle the whole
list.
