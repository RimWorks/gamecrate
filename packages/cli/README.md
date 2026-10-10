# @gamecrate/cli

[![npm](https://img.shields.io/npm/v/%40gamecrate%2Fcli)](https://www.npmjs.com/package/@gamecrate/cli)
[![npm downloads](https://img.shields.io/npm/dm/%40gamecrate%2Fcli)](https://www.npmjs.com/package/@gamecrate/cli)
[![MIT license](https://img.shields.io/npm/l/%40gamecrate%2Fcli)](../../LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Cryptiks_Mods-5865F2?logo=discord&logoColor=white)](https://discord.gg/tbcKN8e4mZ)

Run a modded game in a Docker container. Describe your profiles, then launch it by name. Each profile
gets its own settings, logs, and mod lists. Once a profile is set up, that is the whole command:

```sh
gamecrate run <profile>
```

## Before you start

Right now, this only works on Linux. It may work in WSL, but it hasn't been tested. You'll also need
Docker running, and a copy of the game. 

`gamecrate doctor` checks all three and reports every problem together.

## Set up your first profile

```sh
npm install -g @gamecrate/cli
gamecrate init
```

`init` installs the plugin for the game you want to use, and writes `~/.config/gamecrate/config.yml`.
It also offers to create a local `.gamecrate.yml` too, for a directory that holds a mod you are working
on.

The global file holds the general configuration and defaults, and a project's `.gamecrate.yml` gives the
specific configurations and profiles you use for a particular mod.

Where the game comes from is the one choice you have to make:

<details>
  <summary>The game is installed here</summary>

  gamecrate read-only binds your install into the container at `/game`. The image supplies a few
  extra things around it: a virtual display, the graphics drivers, and the system libraries the
  engine links. Point `gameFiles.host` at the install directory, and the runtime image takes care of
  itself:

  ```yaml
  plugins: ['@gamecrate/rimworld']
  games:
    rimworld:
      gameFiles:
        host: ~/.steam/steam/steamapps/common/RimWorld
      profiles:
        dev:
          mods: [concordlib.concord, yourname.yourmod] # more info on this coming later
  ```

  With no `image` block (the runtime), gamecrate pulls `ghcr.io/rimworks/gamecrate/runtime-base:1`. That is
  about 160 MB, so this path needs no multi-gigabyte download and no registry of your own. Steam
  keeps the game itself up to date. You are welcome to create your own runtime image if you need to add more to it,
  or just want your own.
</details>
OR
<details>
<summary>The game is not installed here, or you want isolated installs</summary>

You can also build an image containing the entire game, based on the gamecrate runtime image. Run
the commands below and gamecrate builds one for you:

```sh
gamecrate steam login
gamecrate steam build --game rimworld
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
        mods: [concordlib.concord, yourname.yourmod] # more info on this coming later
```

It tags the image with the game's own version, and with `:latest`

`run` pulls only when the image is missing, so a locally loaded image is left alone.
`gamecrate run dev --image <ref>` does the same thing for one run without touching the config.

[Configuration](packages/cli/docs/configuration.md) covers every key, and
[Game images](packages/cli/docs/images.md) covers the build.

</details>

### Where a mod id comes from

A name like `concordlib.concord` is the mod's own package id, read out of its manifest. gamecrate
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

`gamecrate mods <profile>` lists what a profile resolves to and names anything it cannot find. To pin
a mod gamecrate downloads itself, by workshop id or git URL, run `gamecrate mods add`.
[Mod sources](packages/cli/docs/mod-sources.md) covers every way to name one, and which copy
wins when two match.

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

You can use the `gamecrate help` command to find more info on the command-line tool itself. It also takes subcommands as arguments.

## Where to go next

| Read this | When you want to |
| --- | --- |
| [Configuration](docs/configuration.md) | Write the config file, load a plugin, define profiles, or set per-repository defaults |
| [Mod sources](docs/mod-sources.md) | Pin a mod to a directory, a git repository, or a workshop item gamecrate downloads, and learn which copy wins |
| [Running](docs/running.md) | Launch, run in the background, read the result, close a window, and clean up |
| [Game images](docs/images.md) | Build a launchable image from a game you own on Steam |
| [Reference](docs/reference.md) | Every subcommand, flag, environment variable, and exit code |
| [Writing a plugin](docs/plugins.md) | Teach gamecrate a new game |

[`@gamecrate/rimworld`](../rimworld) is the RimWorld plugin, and the one complete example of
the plugin contract.
