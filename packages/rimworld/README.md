# @gamecrate/rimworld

gamecrate launches a modded game inside a Docker container. You describe a profile once in one
config file, then run it by name. Each profile gets its own save directory, its own logs, and
only the mods it lists.

The tool knows nothing about any one game. A plugin supplies the file formats and the engine
facts, so the core stays the same for every title.

This package is the RimWorld plugin for [`@gamecrate/cli`](../cli). It teaches gamecrate three
RimWorld file formats plus a handful of engine facts. gamecrate then runs the game with the
mods a profile lists.

The package default-exports one `GamePlugin` object. It claims the game name `rimworld`, which
is the word you type on the command line.

## Install

Neither package sits on npm yet. Build from a clone of the monorepo, then point your config at
the built file:

```sh
git clone https://github.com/RimWorks/gamecrate.git
cd gamecrate
npm install
npm run build
```

```jsonc
// ~/.config/gamecrate/profiles.json
{
  "plugins": ["~/src/gamecrate/packages/rimworld/dist/index.js"]
}
```

Once the package reaches npm, install it next to your config and use the bare name instead:

```sh
cd ~/.config/gamecrate
npm init -y
npm install @gamecrate/rimworld
```

```jsonc
{
  "plugins": ["@gamecrate/rimworld"]
}
```

## What the plugin handles

It reads `About/About.xml` for each mod, which gives gamecrate the package id, the display
name, the dependencies, and the load-order hints.

It writes `Config/ModsConfig.xml` with the active package ids in load order, lowercased, plus
the known expansions and the engine's build number.

It merges `Config/Prefs.xml`. Your own prefs survive, and gamecrate overwrites only the keys it
owns. Those are the screen size, dev mode, and a few more. `fullscreen: False` is what puts the
game in a window.

It parses `Version.txt`. RimWorld writes strings like `1.6.4871 rev598`, and the number after
`rev` is the build number that `ModsConfig.xml` wants.

## What the plugin already knows

The defaults cover facts that hold for every copy of RimWorld:

- the Linux executable name and the Steam app id `294100`
- the three display modes and the `.rws` save extension
- the core package id `ludeon.rimworld` and the five official DLC ids

It also mounts the install at `/game`, puts the data directory at `/data`, and stages mods into
`/game/Mods`.

Two defaults are worth knowing about. The plugin sets `settings.network` to `host`, because a
mod that runs its own web server binds loopback inside the container where a published port
cannot reach it. It also sets `ignoresWmDelete`, because the engine claims the window close
event and then drops it.

## What you still have to write

Anything about your machine stays in your config:

| Key | Why the plugin cannot know it |
| --- | --- |
| `gameFiles.host` | Where you installed RimWorld |
| `image.ref` and `image.acquire` | Which runtime image you pull or build |
| `workshopRoot` | Where Steam put the workshop content, or `null` |
| `scanRoots` | Which directories hold your local mods |
| `profiles` | Which mods each profile loads |

A full example:

```jsonc
{
  "plugins": ["@gamecrate/rimworld"],
  "games": {
    "rimworld": {
      "gameFiles": { "host": "~/games/RimWorld" },
      "image": { "ref": "ghcr.io/your-org/rimworld:1.6", "acquire": "pull" },
      "workshopRoot": "~/.steam/steam/steamapps/workshop/content/294100",
      "scanRoots": [{ "path": "~/projects/mods", "maxDepth": 2 }],
      "profiles": {
        "dev": { "mods": ["brrainz.harmony", "yourname.yourmod"] }
      }
    }
  }
}
```

Then launch it:

```sh
gamecrate rimworld dev
```

## Overriding a default

Any key you write replaces the plugin's value for that key. Watch out for arrays: yours
replaces the plugin's list rather than adding to it. To run with a sixth DLC, copy all five ids
out of the plugin and add the new one. The [`@gamecrate/cli` README](../cli) covers the merge
rules and the one exception, which is the settings ladder.
