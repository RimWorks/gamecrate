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

Neither package sits on npm yet, so build from a clone:

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

The [`@gamecrate/cli` README](packages/cli) has a config you can copy and the full subcommand
list. It also spells out how the loader merges your file over a plugin's defaults.

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
vale README.md packages/cli/README.md packages/rimworld/README.md
```
