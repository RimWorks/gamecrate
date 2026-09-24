# @gamecrate/cli

gamecrate launches a modded game inside a Docker container. You describe a profile once in one
config file, then run it by name. Each profile gets its own save directory, its own logs, and
only the mods it lists.

The tool knows nothing about any one game. A plugin supplies the file formats and the engine
facts, so the core stays the same for every title.

This package is the `gamecrate` command itself. It resolves a profile to a mod set, stages that
set, and launches the game. Without at least one plugin, it has no games to run.

## Install

```sh
npm install -g @gamecrate/cli @gamecrate/rimworld
```

To run an unreleased change, build it from a clone of the monorepo instead:

```sh
git clone https://github.com/RimWorks/gamecrate.git
cd gamecrate
npm install
npm run build
npm install -g ./packages/cli
```

That build needs [bun](https://bun.sh) and Node 22 or newer.

## First launch

Write `~/.config/gamecrate/profiles.yml`. This is the smallest RimWorld config that runs:

```yaml
plugins: ['@gamecrate/rimworld']
# Optional. Without it, gamecrate uses steamcmd from PATH, then a Docker image.
steamcmd:
  path: ~/.local/bin/steamcmd
games:
  rimworld:
    # The plugin already says source: mount and container: /game.
    gameFiles:
      host: ~/games/RimWorld
    image:
      ref: ghcr.io/your-org/rimworld:1.6
      acquire: pull
    # Optional. Only for workshop items a Steam install already downloaded.
    workshopRoot: ~/.steam/steam/steamapps/workshop/content/294100
    scanRoots:
      - path: ~/projects/mods
        maxDepth: 2
    profiles:
      dev:
        mods: [brrainz.harmony, yourname.yourmod]
```

The bare name `@gamecrate/rimworld` only resolves once the package is installed next to the
config. [Configuration](docs/configuration.md#how-plugins-resolve) shows both ways to point at
a plugin. A workshop item reaches a profile two ways: gamecrate downloads it with steamcmd, or
it reads an existing Steam install under `workshopRoot`. Both keys are optional, and
[Mod sources](docs/mod-sources.md) covers the choice. Then:

```sh
gamecrate doctor
gamecrate rimworld dev
```

`doctor` checks Docker, the image, the game directory, and the workshop root before anything
launches. When a config uses workshop items, it also reports which steamcmd it found and the
directories downloaded items land in. The second line resolves the `dev` profile, stages its
two mods, and starts the game.
`gamecrate rimworld dev --print-plan` shows what it would do without launching.

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
