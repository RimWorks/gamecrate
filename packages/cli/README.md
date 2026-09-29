# @gamecrate/cli

[![npm](https://img.shields.io/npm/v/%40gamecrate%2Fcli)](https://www.npmjs.com/package/@gamecrate/cli)
[![npm downloads](https://img.shields.io/npm/dm/%40gamecrate%2Fcli)](https://www.npmjs.com/package/@gamecrate/cli)
[![MIT license](https://img.shields.io/npm/l/%40gamecrate%2Fcli)](../../LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Cryptiks_Mods-5865F2?logo=discord&logoColor=white)](https://discord.gg/tbcKN8e4mZ)

gamecrate launches a modded game inside a Docker container. You describe a profile once in one
config file, then run it by name. Each profile gets its own save directory, its own logs, and
only the mods it lists.

The tool knows nothing about any one game. A plugin supplies the file formats and the engine
facts, so the core stays the same for every title.

This package is the `gamecrate` command itself. It resolves a profile to a mod set, stages that
set, and launches the game. Without at least one plugin, it has no games to run.

You need Docker, a Linux host, and a copy of the game.

## Install

```sh
npm install -g @gamecrate/cli
gamecrate init
```

`init` asks which game you want, installs that game's plugin, and writes
`~/.config/gamecrate/config.yml`. Add `--project` to also write a `.gamecrate.yml` beside a mod
you are working on.

The file it writes points at a placeholder image and game directory, so edit those two before
your first launch:

```yaml
plugins: ['@gamecrate/rimworld']
games:
  rimworld:
    gameFiles:
      host: ~/games/RimWorld
    profiles:
      dev:
        mods: [brrainz.harmony, yourname.yourmod]
```

[Configuration](docs/configuration.md#where-the-game-comes-from) covers pointing at a game
image instead, which drops the `gameFiles.host` line. It also covers the two ways to point at a
plugin. [Mod sources](docs/mod-sources.md) covers the other ways to point at a mod.

## First launch

```sh
gamecrate doctor
gamecrate run dev --print-plan
gamecrate run dev
```

`doctor` checks Docker, the image, the game directory, and the workshop root before anything
launches. When a config uses workshop items, it also reports which steamcmd it found and the
directories downloaded items land in.

`--print-plan` shows what a launch would do without starting it.

## Day to day

```sh
gamecrate run dev --detach                 # launch and get the prompt back
gamecrate ps                               # what is running, and for how long
gamecrate attach dev                       # watch it. Ctrl-c leaves the game running
gamecrate logs dev -f                      # follow this run's log
gamecrate stop dev                         # free the profile
```

To point one mod at a working checkout and compile it before the launch:

```sh
gamecrate run dev --use yourname.yourmod=~/projects/mods/yourmod --build
```

Every subcommand takes `--json`, which prints a machine-readable result instead of text.

## Documentation

| Read this | When you want to |
| --- | --- |
| [Configuration](docs/configuration.md) | Write the config file, load a plugin, define profiles, or set per-repository defaults |
| [Mod sources](docs/mod-sources.md) | Pin a mod to a directory, a git repository, or a workshop item gamecrate downloads, and learn which copy wins |
| [The `mods` commands](docs/mods-commands.md) | Add, remove, and sync library pins from the command line |
| [Running](docs/running.md) | Launch, run in the background, read the result, close a window, and clean up |
| [Game images](docs/images.md) | Build a launchable image from a game you own on Steam |
| [Reference](docs/reference.md) | Every subcommand, flag, environment variable, and exit code |
| [Writing a plugin](docs/plugins.md) | Teach gamecrate a new game |

[`@gamecrate/rimworld`](../rimworld) is the RimWorld plugin, and the one complete example of
the plugin contract.
