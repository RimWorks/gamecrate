# Game images

Back to the [`@gamecrate/cli` README](../README.md).

`gamecrate steam build` downloads a game you own from Steam and appends it onto a published
runtime base. The result is one OCI (Open Container Initiative) image that a headless launch can
run.

gamecrate never publishes a game image. Steam binaries are not yours to redistribute, so keeping
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
gamecrate steam build --game rimworld --load
```

`--load` keeps the image on this machine, which is what you want to launch it yourself.
`--push` sends it to a registry instead, so CI or another machine can pull it. Without either flag
gamecrate assumes `--load`.

Both write to the name you give in `--image`, or to `games.<game>.image.ref` in the config when
you leave the flag out. That name includes the registry, so `--image ghcr.io/you/rimworld-game`
pushes to GitHub's registry. Credentials come from `GAMECRATE_REGISTRY_USER` and
`GAMECRATE_REGISTRY_PASSWORD`, and a `--push` with neither set fails before the download starts.

One command builds the whole matrix: every branch times every variant the plugin declares. A
branch is a Steam release channel, a variant is one image recipe the plugin declares under
`variants[]`, and one pair of the two is a *cell*. Narrow the matrix with `--beta` and
`--variant`, both repeatable.

```sh
gamecrate steam build --game rimworld --beta public --variant linux --load
```

`--variant` only accepts a name the plugin declares. `--beta` takes any Steam branch name,
because Steam owns the branch list and gamecrate has no way to read it. A branch the plugin
declares keeps its settings. One it does not declare builds with defaults, under moving tags
scoped by its own name.

`--alias <tag>` puts one more [moving tag](#tags) on every cell built, which is how a project
tracks a build by a name of your own:

```sh
gamecrate steam build --game rimworld --alias current --load
```

## Watching a build

On a real terminal, `steam build` draws a row for every cell before any work starts, then fills
each row in as that cell runs. A row shows the variant, the base image it appends onto, a
progress bar, and what the cell is doing. steamcmd's own byte counts drive the bar, and its
output feeds one line under the rows rather than scrolling them away.

The board needs a terminal on both standard input and standard output, a `TERM` other than
`dumb`, and no CI variable set. `--json` and `--plain` turn it off as well. Without the board,
the same progress scrolls as plain lines. The summary table prints after the board closes, so a
pipe reads the summary either way.

## What a plugin declares

The plugin ships the matrix under `steamBuild`. Branches are the Steam channels to build. A
variant sets which platform's depot steamcmd downloads, and which runtime base the game appends
onto. Your config adds to that. `branches` concatenates rather than replaces, so declaring a
private beta of your own does not mean copying the plugin's list.

A variant with `base: none` is a reference image. Nothing runnable sits under it, so `--push`
is the only way to build one and `--load` alone skips it.

## Tags

Each cell writes one immutable tag and several moving ones. A moving tag follows the newest
build that fits it. gamecrate writes the exact version first, so a run that dies halfway never
leaves `latest` on a build with no exact tag.

For version `1.6.4871` on the default branch and the default variant:

```
1.6.4871  1.6.4871-linux        the exact build
latest    latest-linux          follows the newest build
1  1-linux  1.6  1.6-linux      every prefix of the version
```

Another branch scopes all of its moving tags by name, so `beta` writes `latest-beta` and
`2.0-beta`. Two branches on one repository can never race for the same tag. An alias is the
exception. A name from `--alias`, or from the branch's own `tags` list, stays unscoped on
purpose. That is how a bare `stable` can follow whichever branch you point it at.

## Skipping work

gamecrate compares the build id Steam publishes against the `steam.buildid` label on the image
that is already there. When they match, the cell skips and downloads nothing. A scheduled job
therefore costs seconds rather than gigabytes.

A skipped cell moves its moving tags onto the image already there. So an alias you add with
`--alias` after the last real build still lands, even on a branch that skips every run. The
cell then lists those tags. The list carries no exact version, because the cell downloaded no
build to read one from. Its first entry is the tag gamecrate read the build id off, and that
one stays where it already was.

One skip happens earlier than that. A `base: none` variant built without `--push` is skipped
before the tag step, so it moves no tags at all.

`--force` builds anyway.

## Checking for a newer build

A launch compares the image's `steam.buildid` label against what Steam publishes, then offers to
rebuild. The check costs about four seconds and needs a Steam session. So it runs at most once
every six hours per image. An image gamecrate did not build is never checked at all.

```json
{ "image": { "ref": "ghcr.io/you/rimworld-game", "updates": { "check": true, "everyHours": 6 } } }
```

`check: false` turns it off. `everyHours: 0` checks every launch.

A rebuild downloads the game again, so gamecrate asks before starting one. Decline it and the
launch continues on the image you have. With no terminal to answer, such as a detached run, a
CI run, or `--json`, it warns and does the same.

## Launching what you built

```sh
gamecrate run dev --image ghcr.io/you/rimworld-game:1.6
```

Or pin it to a profile with `gameVersion`, described in
[Configuration](configuration.md#profiles).

Either route reads the game out of the image. That covers the core game and its official
expansions. gamecrate copies their manifests out of the image once per image id and caches them,
so it never needs a local install to resolve them.

## Referencing the game's assemblies

A mod project compiles against the game's own DLLs. `refs` prints a directory holding them,
pulled out of the image you built:

```sh
gamecrate refs --game rimworld
```

The path goes to standard output on its own, so a build step can capture it. The image digest
and the assembly count go to standard error.

`refs` resolves the image the same way a launch does. Run it from a directory whose
`.gamecrate.yml` pins a `gameVersion`, and you get that build's assemblies. `--image <ref>`
overrides both. Without this, a project could compile against one build while the container
runs another.

Extraction runs once per image digest and is cached after. gamecrate keeps two symlinks into it:

| link | follows |
| --- | --- |
| `~/.cache/gamecrate/refs/current/<game>` | the newest extraction, whichever it was |
| `~/.cache/gamecrate/refs/version/<game>/<major.minor>` | that game version, and nothing else |

**Point a project at the version link, not at `current`.** Every `gamecrate refs` run moves
`current`, including one from another terminal or another repository, so a project that follows
it compiles against whatever ran last. The version link only moves when that same version is
extracted again. The version comes from the game's own `Version.txt`, so a build gets
`refs/version/rimworld/1.6` without naming a digest.

A project file can point at either path directly:

```xml
<PropertyGroup>
  <GameRefs>$(HOME)/.cache/gamecrate/refs/version/rimworld/1.6</GameRefs>
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

Name each assembly, never the whole directory. Most of what the image ships is the .NET runtime,
so a `*.dll` glob hands the compiler a second `corlib` and thousands of `CS0518` errors.

Where the assemblies sit inside the image differs between game versions, so a plugin declares
the candidate directories under `managed`. gamecrate probes them in order and takes the first
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
