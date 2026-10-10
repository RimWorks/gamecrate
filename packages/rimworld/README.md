# @gamecrate/rimworld

[![npm](https://img.shields.io/npm/v/%40gamecrate%2Frimworld)](https://www.npmjs.com/package/@gamecrate/rimworld)
[![npm downloads](https://img.shields.io/npm/dm/%40gamecrate%2Frimworld)](https://www.npmjs.com/package/@gamecrate/rimworld)
[![MIT license](https://img.shields.io/npm/l/%40gamecrate%2Frimworld)](../../LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Cryptiks_Mods-5865F2?logo=discord&logoColor=white)](https://discord.gg/tbcKN8e4mZ)

This is the RimWorld plugin for [`@gamecrate/cli`](../cli). It holds everything required for
gamecrate to set up and run RimWorld inside Docker containers.

## Install

```sh
npm install -g @gamecrate/cli
gamecrate init
```

Pick `rimworld` when `init` asks. It installs this package and writes
`~/.config/gamecrate/config.yml` with the plugin already listed:

```yaml
plugins: ['@gamecrate/rimworld']
```

## What the plugin handles

It reads `About/About.xml` for each mod, which gives gamecrate the package id, the display
name, the dependencies, and the load-order hints.

It writes `Config/ModsConfig.xml` with the active package ids in load order, lowercased, plus
the known DLC and the engine's build number.

It merges `Config/Prefs.xml`. Your own prefs survive, and gamecrate overwrites only six keys:
`screenWidth`, `screenHeight`, `devMode`, `runInBackground`, `fullscreen`, and
`resetModsConfigOnCrash`. `fullscreen: False` is what puts the game in a window, and
`resetModsConfigOnCrash: False` stops the engine wiping your mod list after a crash. gamecrate
also writes anything you put in `settings.prefsExtra`.

It writes a mod's own settings file before a launch, so a profile can turn a mod on with the
options it needs. Those land in the game's `Config` directory. See
[Configuration](../cli/docs/configuration.md) for the `modSettings` block.

## What the plugin already knows

The defaults cover facts that hold for every copy of RimWorld:

- the Linux executable name and the Steam app id `294100`
- the three display modes and the `.rws` save extension
- the core package id `ludeon.rimworld` and the five official DLC ids

It also mounts the install at `/game`, puts the data directory at `/data`, and stages mods into
`/game/Mods`. The plugin sets `settings.network` to `host`, because a
mod that runs its own web server binds loopback inside the container where a published port
cannot reach it. It also sets `ignoresWmDelete`, because the engine claims the window close
event and then drops it.

## What you still have to write

Anything about your machine stays in your config:

| Key | Why the plugin cannot know it |
| --- | --- |
| `gameFiles.host` | Where you installed RimWorld |
| `image.ref` and `image.acquire` | Only for an image that carries the game. A mounted install pulls the built-in runtime |
| `workshopRoot` | Where Steam put the workshop content, or `null` |
| `scanRoots` | Which directories hold your local mods |
| `library` | Which mod each pin resolves to. `gamecrate mods add` writes this |
| `profiles` | Which mods each profile loads |

A full example:

```yaml
plugins: ['@gamecrate/rimworld']
games:
  rimworld:
    gameFiles:
      host: ~/games/RimWorld
    workshopRoot: ~/.steam/steam/steamapps/workshop/content/294100
    scanRoots:
      - path: ~/projects/mods
        maxDepth: 2
    profiles:
      dev:
        mods: [brrainz.harmony, yourname.yourmod]
```

Then launch it:

```sh
gamecrate run dev
```

## Building an image from Steam

If you own RimWorld on Steam but have no install on this host, build the image instead. The
plugin declares three variants:

| Variant | Gives you |
| --- | --- |
| `linux` | The native Linux build |
| `windows` | The Windows build, run through Proton |
| `linux-ref` | The managed DLLs and `Version.txt` only, for referencing from a csproj |

```sh
gamecrate steam login
gamecrate steam build --game rimworld --variant linux --load
```

To reference the game's DLLs from a csproj without a local install:

```sh
gamecrate refs --game rimworld
```

## Overriding a default

Any key you write replaces the plugin's value for that key. Watch out for arrays: yours
replaces the plugin's list rather than adding to it. The plugin sets `scanRoots` to an empty
list, so writing your own is a replacement:

```yaml
    scanRoots:
      - path: ~/projects/mods
        maxDepth: 2
```

[Configuration](../cli/docs/configuration.md#arrays-replace-instead-of-merging)
covers the merge rules and the two arrays that concatenate instead.
