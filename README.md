# gamecrate

gamecrate launches a modded game inside a Docker container. You describe a profile once in one
config file, then run it by name. Each profile gets its own save directory, its own logs, and
only the mods it lists.

The tool knows nothing about any one game. A plugin supplies the file formats and the engine
facts, so the core stays the same for every title.

## Packages

| Package | Contents |
| --- | --- |
| [`@gamecrate/cli`](packages/cli) | The `gamecrate` command, the config loader, and the plugin contract |
| [`@gamecrate/rimworld`](packages/rimworld) | The RimWorld plugin: `About.xml`, `ModsConfig.xml`, and `Prefs.xml` |

## Install

```sh
npm install -g @gamecrate/cli @gamecrate/rimworld
```

To run an unreleased change, build from a clone instead:

```sh
git clone https://github.com/RimWorks/gamecrate.git
cd gamecrate
npm install
npm run build
npm install -g ./packages/cli
```

The build step needs [bun](https://bun.sh). It writes `packages/cli/dist/gamecrate.js` for Node
and `packages/cli/dist/gamecrate` as a standalone binary.

## Quick start

Put your games and profiles in `~/.config/gamecrate/profiles.yml`, or in `profiles.json` if you
prefer JSON, then launch one:

```sh
gamecrate rimworld dev
```

The [`@gamecrate/cli` README](packages/cli) has a config you can copy and links to the rest:

| Topic | Where |
| --- | --- |
| Config file, plugins, profiles, per-repository defaults | [Configuration](packages/cli/docs/configuration.md) |
| Library pins, git sources, which copy of a mod wins | [Mod sources](packages/cli/docs/mod-sources.md) |
| `mods add`, `mods rm`, `mods sync` | [The `mods` commands](packages/cli/docs/mods-commands.md) |
| Launching, detached runs, windows, cleanup | [Running](packages/cli/docs/running.md) |
| Building a game image from Steam | [Game images](packages/cli/docs/images.md) |
| Subcommands, flags, environment variables, exit codes | [Reference](packages/cli/docs/reference.md) |
| Teaching gamecrate a new game | [Writing a plugin](packages/cli/docs/plugins.md) |

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

Prose goes through [Vale](https://vale.sh). Fetch the Google package once, then check the docs:

```sh
vale sync
vale README.md packages/cli/README.md packages/cli/docs packages/rimworld/README.md
```
