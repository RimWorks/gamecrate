# gamecrate

[![@gamecrate/cli on npm](https://img.shields.io/npm/v/%40gamecrate%2Fcli?label=%40gamecrate%2Fcli)](https://www.npmjs.com/package/@gamecrate/cli)
[![@gamecrate/rimworld on npm](https://img.shields.io/npm/v/%40gamecrate%2Frimworld?label=%40gamecrate%2Frimworld)](https://www.npmjs.com/package/@gamecrate/rimworld)
[![MIT license](https://img.shields.io/npm/l/%40gamecrate%2Fcli)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Cryptiks_Mods-5865F2?logo=discord&logoColor=white)](https://discord.gg/tbcKN8e4mZ)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=RimWorks_gamecrate&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=RimWorks_gamecrate)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=RimWorks_gamecrate&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=RimWorks_gamecrate)

Run a modded game in a Docker container. Describe a profile once, then launch it by name.

Each profile gets its own saves, its own logs, and only the mods it lists. Nothing leaks between
profiles, so a broken mod set never touches a working one.

Once a profile is set up, that is the whole command:

```sh
gamecrate run dev
```

## Before you start

You need three things:

| Requirement | Why |
| --- | --- |
| Docker, running, and reachable as you | The game runs in a container |
| Linux | The container shares your display, your user id, and your graphics device |
| A copy of the game | Either a directory on this host, or an image you can pull |

`gamecrate doctor` checks all three and reports every problem together.

## Set up your first profile

```sh
npm install -g @gamecrate/cli
gamecrate init
```

`init` asks which game you want, installs that game's plugin with `npm install -g`, and writes
`~/.config/gamecrate/config.yml`. It offers a project `.gamecrate.yml` too, for a directory that
holds a mod you are working on. Pass `--project` to write that file without being asked.

What it writes is a skeleton: a `plugins` line, one empty profile, and placeholder paths for
the game and the image. Fill those in before your first launch.

Where the game comes from is the one choice you have to make. Pick the row that matches your
machine:

| Your situation | What you write |
| --- | --- |
| The game is installed on this host | `gameFiles.host`, plus a runtime image to pull |
| The game is not installed here | `gameFiles.source: image`, and an image you built from Steam |

### The game is installed here

gamecrate binds your install into the container at `/game`, read-only. The image supplies the
runtime around it: a virtual display, the graphics drivers, and the system libraries the engine
links. Point `gameFiles.host` at the install directory, and the runtime image takes care of
itself:

```yaml
plugins: ['@gamecrate/rimworld']
games:
  rimworld:
    gameFiles:
      host: ~/.steam/steam/steamapps/common/RimWorld
    profiles:
      dev:
        mods: [brrainz.harmony, yourname.yourmod]
```

With no `image` block, gamecrate pulls `ghcr.io/rimworks/gamecrate/runtime-base:1`. That is
about 160 MB, so this path needs no multi-gigabyte download and no registry of your own. Steam
keeps the game itself up to date.

### Where a mod id comes from

A name like `brrainz.harmony` is the mod's own package id, read out of its manifest. gamecrate
builds an index of every mod it can see, then matches each name in `mods` against it. It looks
in four places:

| Source | Holds |
| --- | --- |
| The `Data` directory in your install | The core game and its official DLC |
| `workshopRoot` | Everything Steam downloaded for you |
| `scanRoots` | Directories of your own, like a folder of checkouts |
| The download directory | Anything `gamecrate mods add` pulled down for you |

The config here names none of the last three, so only the core game resolves. Add the ones you
have:

```yaml
    workshopRoot: ~/.steam/steam/steamapps/workshop/content/294100
    scanRoots:
      - path: ~/projects/mods
        maxDepth: 2
```

`gamecrate mods dev` lists what a profile resolves to and names anything it cannot find. To pin
a mod gamecrate downloads itself, by workshop id or git URL, use
[the `mods` commands](packages/cli/docs/mods-commands.md).
[Mod sources](packages/cli/docs/mod-sources.md) covers every way to name one, and which copy
wins when two match.

This path runs a native Linux build. A Windows build needs Proton, and gamecrate reaches that
only through an image it built itself, so use `steam build` below.

### The game is not installed here, or you want isolated installs

Build an image from a game you own on Steam. `--load` puts it straight into your local Docker
daemon, so nothing gets pushed to a registry:

```sh
gamecrate steam login
gamecrate steam build --game rimworld --variant linux --load
```

The game lives inside that image, so drop `gameFiles.host` and set `source: image` instead:

```yaml
plugins: ['@gamecrate/rimworld']
games:
  rimworld:
    gameFiles:
      source: image
    image:
      ref: rimworld:1.6
      acquire: pull
    profiles:
      dev:
        mods: [brrainz.harmony, yourname.yourmod]
```

`run` pulls only when the image is missing, so a locally loaded image is left alone.
`gamecrate run dev --image <ref>` does the same thing for one run without touching the config.

[Configuration](packages/cli/docs/configuration.md) covers every key, and
[Game images](packages/cli/docs/images.md) covers the build.

## Launch it

```sh
gamecrate doctor              # every reason a launch could fail, reported together
gamecrate run dev --print-plan  # every path, mod and bind, without starting anything
gamecrate run dev
```

You can also run it detached, and have commands to manage the container after it is detached:

```sh
gamecrate run dev --detach
gamecrate ps                  # what is running, and how long it has been up
gamecrate logs dev -f         # follow this run's log
gamecrate stop dev            # free the profile
```

To point one mod at a working checkout and compile it first:

```sh
gamecrate run dev --use yourname.yourmod=~/projects/yourmod --build
```

`gamecrate` on its own prints help. `gamecrate help <subcommand>` lists its flags, and
`gamecrate help <game>` lists that game's profiles.

## Where to go next

| Read this | When you want to |
| --- | --- |
| [Configuration](packages/cli/docs/configuration.md) | Write the config file, load a plugin, or set per-repository defaults |
| [Mod sources](packages/cli/docs/mod-sources.md) | Pin a mod to a directory, a git repository, or a workshop item |
| [Running](packages/cli/docs/running.md) | Launch, watch the live dashboard, run in the background, clean up |
| [The `mods` commands](packages/cli/docs/mods-commands.md) | Add, remove, and sync library pins from the command line |
| [Reference](packages/cli/docs/reference.md) | Every subcommand, flag, environment variable, and exit code |

<details>
<summary>More topics</summary>

| Read this | When you want to |
| --- | --- |
| [Game images](packages/cli/docs/images.md) | Build a launchable image from a game you own on Steam |
| [Writing a plugin](packages/cli/docs/plugins.md) | Teach gamecrate a new game |

</details>

## How it works

gamecrate knows nothing about any one game. A plugin supplies the file formats and the engine
facts, so the core serves every title.

| Package | Contents |
| --- | --- |
| [`@gamecrate/cli`](packages/cli) | The `gamecrate` command, the config loader, and the plugin contract |
| [`@gamecrate/rimworld`](packages/rimworld) | The RimWorld plugin, and the one complete example of the contract |

<details>
<summary>Build from a clone</summary>

Use this to run an unreleased change. The build needs [bun](https://bun.sh) and Node 22 or newer.

```sh
git clone https://github.com/RimWorks/gamecrate.git
cd gamecrate
npm install
npm run build
npm install -g ./packages/cli
```

The build writes `packages/cli/dist/gamecrate.js` for Node, and `packages/cli/dist/gamecrate` as
a standalone binary.

[AGENTS.md](AGENTS.md) covers the architecture, the plugin contract, the test commands, and the
rules for a change.

</details>
