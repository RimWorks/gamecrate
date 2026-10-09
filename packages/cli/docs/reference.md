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

<!-- generated:subcommands -->

### Start a game and control a run

- `run [profile]`: Stage a profile's mods and start the game
- `attach [profile]`: Watch a background run. Ctrl-c leaves the game running
- `wait [profile]`: Wait for a background run to end, then exit with its code
- `ps`: List the runs going now with their profile and uptime
- `stop [profile]`: Stop a background run and free the profile it holds
- `shell [profile]`: Open a bash prompt in the container, with the same mods

### See what a profile gives you

- `list`: List the games and profiles, and where each is defined
- `mods [profile]`: List the mods a profile loads, or edit the library behind it
  - `mods add <source>`: Add one mod source to the library
  - `mods rm <id>...`: Remove mod sources from the library by id
  - `mods sync [id]...`: Fetch each git, release, and workshop source again
- `refs [profile]`: Print a path to the game's DLLs, to reference from a csproj
- `logs [profile]`: Print the log the last run captured
- `verify [profile]`: Check which mods a live run loaded, and whether they are current

### Build images and mods

- `build [profile]`: Build or pull the runtime image without starting the game
- `steam`: Build a game image from Steam, or log in to Steam
  - `steam build`: Download the game from Steam and build an image
  - `steam login`: Save a Steam session so a build can download the game

### Clean up and check your setup

- `init`: Set up a config: pick a game, install its plugin, write a profile
- `doctor`: Check docker, logins, game folders, and permissions
- `clean [profile]`: Delete a profile's staged mods, logs, saves, or downloads
- `prune`: Delete old run logs, dead locks, stale downloads, and exited containers
- `clone <src> <dst>`: Copy one profile's saves and settings to another profile
- `config`: Read and edit the gamecrate config files
  - `config edit`: Open the global config in an editor and check it on save
- `fix-perms [profile]`: Give yourself back any profile file another user owns

### About gamecrate itself

- `help [topic]`: Show help for a subcommand or a game
- `version`: Print the gamecrate version
- `completion <bash|zsh>`: Print a completion script for bash or zsh

<!-- /generated:subcommands -->

A few of those do more than one line says. `doctor` checks Docker, the Container Device
Interface, registry auth, game directories, scan roots, permissions, and the workshop root, and
reports them together. `clone` reflink-copies a profile's `game/` directory, which is where its
saves live. `ps` prints game, profile or instance, mode, pid, container, then uptime or status.
`config edit` opens the file in `$VISUAL` or `$EDITOR` and validates it on save.

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

Every flag and the subcommands that take it. A value flag given twice is a usage error unless it
is marked repeatable. [Environment variables](#environment-variables) lists the ones that stand
in for a flag.

<!-- generated:flags -->

| Flag | Subcommands | What it does |
| --- | --- | --- |
| `--alias <tag>` | `steam build` | One more moving tag to put on each branch built. Repeatable. |
| `--all` | `clean` | Delete the whole profile and the game downloads (needs --yes) |
| `--asset <glob>` | `mods add` | Which release asset to unpack, like *.zip |
| `--base <ref>` | `steam build` | Build on this runtime base instead of the published one |
| `--beta <name>` | `steam build` | Build only this Steam branch. Repeatable. |
| `--branch <name>` | `mods add` | Follow this git branch |
| `--build` | `run` | Compile the local C# mods before launching |
| `--ci` | `run`, `mods`, `refs`, `clean`, `logs`, `attach`, `wait`, `stop`, `build`, `verify` | Use the `ci` profile, or `modless` when no config names one, and leave the mod build to the workflow |
| `--commit <sha>` | `mods add` | Pin to this git commit |
| `--detach` | `run` | Run in the background and give the prompt back |
| `--docker-arg <arg>` | `run`, `shell` | One extra argument to pass to docker run. Repeatable. |
| `--downloads` | `clean` | Delete this game's workshop downloads, keeping steamcmd |
| `--dry-run` | `run`, `prune`, `fix-perms` | Resolve and check everything, write nothing |
| `-f, --follow` | `logs` | Keep printing as the run writes more |
| `--force` | `mods add`, `steam build` | Overwrite an existing mod entry, or rebuild an image anyway |
| `--game <name>` | every subcommand | The game to act on, when no profile says which |
| `--git <url>` | `mods add` | Clone the mod from this git repository |
| `--global` | `mods add`, `mods rm` | Write to the global config in ~/.config/gamecrate |
| `-h, --help` | every subcommand | Show this help |
| `--image <ref>` | `run`, `refs`, `build`, `steam build` | The image to launch, or the repository a steam build tags |
| `--instance <name>` | `run`, `clean`, `logs`, `attach`, `wait`, `stop`, `shell`, `verify` | Run a second named copy with its own saves, logs, and container |
| `--json` | every subcommand | Print JSON instead of text |
| `--keep <count>` | `prune` | How many run log directories each profile keeps |
| `--log <path>` | `run`, `shell` | Also write everything the run prints to this file |
| `--logs` | `clean` | Delete the logs the runs captured |
| `--marker <str>` | `run` | Exit 0 as soon as this text appears in the game log |
| `--mod <id>` | `run`, `mods`, `shell` | Add one more mod to what the profile loads. Repeatable. |
| `--mode <headed\|headless\|screenshot>` | `run` | Show a game window, hide it, or take one screenshot |
| `--network <none\|bridge\|host>` | `run` | The container's network. host lets a mod serve a port |
| `--no-build` | `run` | Never compile, even when a mod's DLL is out of date |
| `--no-detach` | `run` | Stay in the foreground, whatever the config asks for |
| `--no-load` | `steam build` | Skip the docker daemon and keep no local image. Use it on a CI runner with --push |
| `--no-replace` | `run` | Refuse to launch when this profile already runs |
| `--no-stale-check` | `run` | Do not warn when a mod's code is newer than its DLL |
| `--no-steam` | `run` | Run without steam, and load the game's steamless mod |
| `--no-worktree` | `run`, `clean`, `logs`, `attach`, `wait`, `stop`, `shell`, `verify` | Ignore the current git checkout and $GAMECRATE_WORKTREE |
| `--older-than <days>` | `prune` | Treat anything this many days old as old enough to delete |
| `--only <id>` | `run`, `mods`, `shell` | Load only these mods and none of the rest. Repeatable. |
| `--path <dir>` | `mods add` | Take the mod from this directory |
| `--plain` | `run`, `steam build` | Plain scrolling output instead of the live dashboard |
| `--platform <os/arch>` | `steam build` | The os and arch the built manifest claims. Default `linux/amd64`. |
| `--plugin <spec>` | `steam build` | Name the plugin package to use. Repeatable. |
| `--print` | `steam login` | Also print the session as base64 |
| `--print-plan` | `run` | Print what the launch would do instead of launching |
| `--project` | `mods add`, `mods rm`, `init` | Write to the .gamecrate config beside your code |
| `--pull <always\|missing\|never>` | `run`, `build` | When to pull the runtime image from its registry |
| `--push` | `steam build` | Push the built image to a registry |
| `-q, --quiet` | `run`, `shell` | Print nothing to the terminal. --log still gets everything |
| `--release <owner/repo>` | `mods add` | Download the mod from this GitHub repository's releases |
| `--render-wait <seconds>` | `run` | Seconds to let the game draw before the screenshot |
| `--replace` | `run`, `shell` | Stop whatever already holds this profile, then launch |
| `--resolution <width>x<height>` | `run` | Set the game window size, like 1920x1080 |
| `--root` | `run`, `shell` | Run as root in the container instead of as you |
| `--sort <topo\|none>` | `run`, `mods` | Load order: as the profile lists them, or by dependency |
| `--staging` | `clean` | Delete the staged copies of the mods only (the default) |
| `--steam` | `run` | Bind the host's running steam client in, and use its network |
| `--subdir <path>` | `mods add` | The mod folder inside the repository |
| `--tag <name>` | `mods add` | Pin to this git tag |
| `--timeout <seconds>` | `run` | Stop a marker or headless run after this many seconds |
| `--use <packageId>=<path>` | `run`, `shell` | Load this one mod from this directory, whatever the profile says. Repeatable. |
| `--username <name>` | `steam login` | Use this username and skip the prompt |
| `--variant <name>` | `steam build` | Build only this image variant. Repeatable. |
| `--without <id>` | `run`, `mods`, `shell` | Leave one mod out of what the profile loads. Repeatable. |
| `--workshop <id>` | `mods add` | Take the mod from this Steam Workshop item |
| `--worktree <path>` | `run`, `clean`, `logs`, `attach`, `wait`, `stop`, `shell`, `verify` | Load mods from this git checkout, in its own instance ($GAMECRATE_WORKTREE). Repeatable. |
| `-y, --yes` | `init`, `clean`, `clone`, `fix-perms` | Answer yes to the confirmation prompt |

<!-- /generated:flags -->

Some of those carry a rule the one-line summary has no room for:

- `--timeout` bounds a run with a `--marker`, in any mode, and a `--mode headless` run without
one. A `--mode screenshot` run with no marker is bounded by `--render-wait` instead, and a headed
run by its window, so neither of those reads it. Default 420. `--render-wait` defaults to 25.
- `--pull` defaults to `missing` on `run` and `always` on `build`.
- `--no-stale-check` drops the warning, not the check. A source must beat its assembly by more
than a second to count, because one build writes both within microseconds of each other.
- `--docker-arg` is the one flag whose value may start with a dash. Each one passes exactly one
argument to `docker run`, so a docker flag and its value take two of them:
`--docker-arg -v --docker-arg /host/out:/out`. The same rule holds for a `dockerArgs` list in a
config file, where every element is one argument.
- `--worktree` is repeatable and an earlier flag outranks a later one. `--no-worktree` cancels
worktree promotion completely: the current directory, `$GAMECRATE_WORKTREE`, a `--worktree` flag
you also typed, and an instance's configured `worktree`.
- `mods add` takes exactly one of `--path`, `--workshop` or `--git`, and at most one of
`--branch`, `--tag` or `--commit`. Both `add` and `rm` need `--global` or `--project`. `mods rm`
has no `--force`: a missing id always fails.
- `steam build` always loads what it built into the local docker daemon, `--push` or not.
`--no-load` skips that. A CI runner that only publishes wants it, or it keeps a game-sized image
it never runs.
- `--image` sets the target repository for `steam build`, without a tag. On `run`, `build` and
`refs` it uses that exact reference instead of the configured one, and reads the game out of the
image.
- `clean` defaults to `--staging`. `--all` deletes saves and downloads, so it needs `--yes`.
`--downloads` drops the game's workshop items and keeps `steamcmd` itself.
- `--quiet` still lets the reason a run failed reach you, and a `--log` file still receives
everything.

Pairs that contradict each other are usage errors: `--build` with `--no-build`, `--replace` with
`--no-replace`, `--detach` with `--no-detach`, and `--detach` with either `--dry-run` or
`--print-plan`.

## Environment variables

Each variable stands in for one flag, and only when you leave that flag off:

<!-- generated:variables -->

- `GAMECRATE_INSTANCE` for `--instance`
- `GAMECRATE_MODE` for `--mode`
- `GAMECRATE_MARKER` for `--marker`
- `GAMECRATE_TIMEOUT` for `--timeout`
- `GAMECRATE_RENDER_WAIT` for `--render-wait`
- `GAMECRATE_NETWORK` for `--network`
- `GAMECRATE_PULL` for `--pull`
- `GAMECRATE_BUILD` for `--build`
- `GAMECRATE_SORT` for `--sort`
- `GAMECRATE_ROOT` for `--root`

<!-- /generated:variables -->

A value goes through the flag's own parser, so a bad one fails the way a bad flag does.
`GAMECRATE_ROOT` reads `1`, `true`, or `yes` as on. A `.gamecrate` file's keys sit below both:
flag, then variable, then file.

`GAMECRATE_WORKTREE` picks a worktree to promote, and `--no-worktree` cancels it. The value
`off` reads as unset.

`XDG_CONFIG_HOME` moves the config directory and `XDG_CACHE_HOME` moves the workshop scan
cache. `VISUAL` and `EDITOR` name the editor `config edit` opens.

`steam build` reads its credentials from the environment and never from a flag, because a flag
value is readable in the process list on a shared machine:

- `STEAM_USERNAME` is the Steam account that owns the game.
- `STEAM_CONFIG_VDF_B64` is base64 of a logged-in `config.vdf`, for a runner with no session on
disk.
- `STEAM_CONFIG_VDF` is the path to a file holding that session, as base64 or as a raw
`config.vdf`. `STEAM_CONFIG_VDF_B64` outranks it.
- `STEAM_BRANCH_PASSWORD_<BRANCH>` is the password for one private beta. The branch name goes
uppercase, with dashes as underscores.
- `STEAM_BRANCH_PASSWORD` is a fallback password, used only when you build a single branch.
- `GAMECRATE_REGISTRY_USER` is the registry username for `--push`.
- `GAMECRATE_REGISTRY_PASSWORD` is the registry token for `--push`.

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
