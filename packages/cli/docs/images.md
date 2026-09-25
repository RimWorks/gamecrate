# Game images

Back to the [`@gamecrate/cli` README](../README.md).

`gamecrate steam build` downloads a game you own from Steam and appends it onto a published
runtime base. The result is one OCI image that a headless launch can run.

Gamecrate never publishes a game image. Steam binaries are not yours to redistribute, so keeping
a built image private is your job.

## Sign in once

```sh
gamecrate steam login
```

That prompts for your username, password, and any Steam Guard code, then stores the session.
`steam build` reads it and never prompts. On a runner with no session on disk, pass
`STEAM_CONFIG_VDF` instead: `steam login --print` writes the same session as base64, which you
store as a secret.

## Build

```sh
gamecrate steam build rimworld --load
```

`--load` puts the image in your local Docker daemon. `--push` sends it to a registry, and
without either flag gamecrate assumes `--load`.

One command builds the whole matrix: every branch times every variant the plugin declares. Narrow
it with `--beta` and `--variant`, both repeatable.

```sh
gamecrate steam build rimworld --beta public --variant linux --load
```

## What a plugin declares

A plugin supplies the game facts, so you write only what is yours. The `steamBuild` block holds
the matrix:

```json
{
  "games": {
    "rimworld": {
      "steamBuild": {
        "branches": [
          { "name": "public", "tags": ["stable"] },
          { "name": "beta", "password": true, "executable": { "linux": "./GameAlt" } }
        ]
      }
    }
  }
}
```

| Key | What it does |
| --- | --- |
| `branches[].name` | The Steam branch to install. It becomes part of every tag, so it takes the Docker tag character set |
| `branches[].password` | `true` refuses the build early when the branch needs a password and none is set |
| `branches[].tags` | Extra moving tags for this branch, beside the version and `latest` forms |
| `branches[].executable` | The launcher for this branch, keyed by variant name, when it differs from the plugin's |
| `variants[].name` | The tag suffix for this variant |
| `variants[].depot` | `linux`, `windows`, or `macos`. The depot to download, which is separate from the image platform |
| `variants[].base` | `xvfb` for a launchable image, `proton` to run a Windows build under Wine, `none` for a reference image that never runs |
| `variants[].include` | Subpaths to include. Empty means the whole game |

`branches` is one of two arrays that concatenate rather than replace, so adding a beta does not
mean copying the plugin's list.

## Tags

Each cell writes one immutable tag and several moving ones. The exact version comes first,
because a moving tag must never point at an image before the exact one exists.

For version `1.6.4871` on the default branch and the default variant:

```
1.6.4871  1.6.4871-linux        the exact build
latest    latest-linux          follows the newest build
1  1-linux  1.6  1.6-linux      every prefix of the version
```

Another branch scopes all of its moving tags by name, so `beta` writes `latest-beta` and
`2.0-beta`. Two branches on one repository can never race for the same tag. A `tags` entry you
write is the exception: it is unscoped on purpose, which is how a bare `stable` can follow
whichever branch you point it at.

## Skipping work

Gamecrate compares the build id Steam publishes against the `steam.buildid` label on the image
that is already there. When they match, the cell skips and downloads nothing. A scheduled job
therefore costs seconds rather than gigabytes.

`--force` builds anyway.

## Checking for a newer build

A launch compares the image's `steam.buildid` label against what Steam publishes, then offers to
rebuild. The check costs about four seconds and needs a Steam session. So it runs at most once
every six hours per image. An image gamecrate did not build is never checked at all.

```json
{ "image": { "ref": "ghcr.io/you/rimworld-game", "updates": { "check": true, "everyHours": 6 } } }
```

`check: false` turns it off. `everyHours: 0` checks every launch.

A rebuild downloads the game again, so gamecrate asks first. `--yes` answers for you. With no
terminal to ask, such as a detached or CI run, it warns and launches on the image you have.

## Launching what you built

```sh
gamecrate rimworld --image ghcr.io/you/rimworld-game:1.6
```

Or pin it to a profile with `gameVersion`, described in
[Configuration](configuration.md#profiles).

Either route reads the game out of the image. That covers the core game and its official
expansions. Gamecrate copies their manifests out of the image once per image id and caches them,
so it never needs a local install to resolve them.

## Referencing the game's assemblies

A mod project compiles against the game's own DLLs. `refs` prints a directory holding them,
pulled out of the image you built:

```sh
gamecrate refs rimworld
```

The path goes to standard output on its own, so a build step can capture it. The image digest
and the assembly count go to standard error.

Extraction runs once per image digest and is cached after. Gamecrate also keeps a stable
symlink at `~/.cache/gamecrate/refs/current/<game>`, which always points at the newest
extraction. A project file can point at that path directly:

```xml
<PropertyGroup>
  <GameRefs>$(HOME)/.cache/gamecrate/refs/current/rimworld</GameRefs>
</PropertyGroup>

<ItemGroup>
  <Reference Include="Assembly-CSharp">
    <HintPath>$(GameRefs)/Assembly-CSharp.dll</HintPath>
    <Private>False</Private>
  </Reference>
</ItemGroup>
```

Keep `<Private>False</Private>`. Without it, MSBuild copies the game's DLLs into your build
output and they end up in a Workshop upload.

Where the assemblies live inside the image differs between game versions, so a plugin declares
the candidate directories under `managed`. Gamecrate probes them in order and takes the first
one holding a DLL.

## Credentials

Every credential comes from the environment, never from a flag. A flag value is readable in the
process list on a shared machine.

| Variable | For |
| --- | --- |
| `STEAM_USERNAME` | The account that owns the game |
| `STEAM_CONFIG_VDF` | base64 of a logged-in session, for a runner with nothing on disk |
| `STEAM_BRANCH_PASSWORD_<BRANCH>` | One private beta's password. Uppercase the name, dashes become underscores |
| `GAMECRATE_REGISTRY_USER` | The registry username for `--push` |
| `GAMECRATE_REGISTRY_PASSWORD` | The registry token for `--push` |

A beta password reaches `steamcmd` through a `+runscript` file at mode 0600, so it stays out of
the argument list as well.

A `--push` with no credentials anywhere fails before the download starts, rather than after it.
