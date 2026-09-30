# Game images

Back to the [`@gamecrate/cli` README](../README.md).

`gamecrate steam build` downloads a game you own from Steam and appends it onto a published runtime
base. The result is one OCI (Open Container Initiative) image a headless launch can run.
gamecrate never publishes a game image. Steam binaries are not yours to redistribute, so keeping one
private is your job.

## Sign in once

```sh
gamecrate steam login
```

That prompts for your username, password, and any Steam Guard code, then stores it.
`steam build` reads it and never prompts. On a runner with no session on disk, pass
`STEAM_CONFIG_VDF` instead: `steam login --print` writes it as base64 for a secret.

## Build

```sh
gamecrate steam build --game rimworld
```

Every build loads the image into the local docker daemon. Adding `--push` also sends it to a
registry, so CI or another machine can pull it.

The name comes from `--image`, or `games.<game>.image.ref` in the config. It includes the
registry, so `--image ghcr.io/you/rimworld-game` pushes to GitHub's registry.

One command builds the whole matrix: every branch times every variant the plugin declares. A branch
is a Steam release channel. A variant is one image recipe, declared under `variants[]`, with a
`base` of `linux`, `windows`, or `none`. One pair of a branch and a variant is a *cell*.

```sh
gamecrate steam build --game rimworld --beta public --variant linux --alias current
```

| Flag | Does | Notes |
| --- | --- | --- |
| `--variant <name>` | Build only this variant | Repeatable. Only a name the plugin declares |
| `--beta <name>` | Build only this Steam branch | Repeatable. Any name, because Steam owns the branch list |
| `--alias <tag>` | Add one [moving tag](#tags) to every cell built | Repeatable. How a project tracks a build under a name of your own |
| `--force` | Build even when the [gate](#skipping-work) says to skip | |
| `--no-load` | Keep no local image | Pair it with `--push` on a runner, which has no room for one |

A branch the plugin declares keeps its settings. One it does not declare builds with defaults, under
moving tags scoped by its own name.

## Tags

Each cell writes one immutable tag and several moving ones. A moving tag follows the newest build
that fits it. gamecrate writes the exact version first, so a run that dies halfway never leaves
`latest` on a build with no exact tag.

For version `1.6.4871` on the default branch and the default variant:

```
1.6.4871  1.6.4871-linux        the exact build
latest    latest-linux          follows the newest build
1  1-linux  1.6  1.6-linux      every prefix of the version
```

The bare forms belong to the default branch and the default variant. Every other cell carries its
own suffix, so `beta` writes `latest-beta` and `2.0-beta`, and two branches never race for the same
tag. An alias is the exception: a name from `--alias`, or the branch's own `tags` list, stays
unscoped. A bare `stable` follows whichever branch you point it at.

## Skipping unnecessary builds

gamecrate compares the build id Steam publishes against the `steam.buildid` label on the image
already there. When they match, the cell skips and downloads nothing, saving time.

A build skipped by the buildid gate still re-applies its moving tags to the image already there,
so an alias from `--alias` lands. A `base: none` variant built without `--push` is skipped before
the tag step, and lists no tags, because it builds nothing to tag.

## Checking for a newer build

A launch compares the image's `steam.buildid` label against what Steam publishes, then offers to
rebuild. The check costs about four seconds and needs a Steam session, so it runs at most once every
six hours per image. An image gamecrate did not build is never checked.

```json
{ "image": { "ref": "ghcr.io/you/rimworld-game", "updates": { "check": true, "everyHours": 6 } } }
```

`check: false` turns it off, and `everyHours: 0` checks every launch. A rebuild downloads the game
again, so gamecrate asks first. Decline and the launch continues on the image you have. A detached
run, a CI run, or `--json` cannot answer, so it warns and continues.

## Launching what you built

```sh
gamecrate run dev --image ghcr.io/you/rimworld-game:1.6
```

Or pin it to a profile with `gameVersion`, described in
[Configuration](configuration.md#profiles). Either route reads the game out of the image, which
covers the core game and its official expansions. gamecrate caches their manifests once per image
id, so it never needs a local install.

## Referencing the game's assemblies

```sh
gamecrate refs --game rimworld
```

That prints one directory of the game's DLLs to standard output, so a build step can capture it.
The digest and the assembly count go to standard error.

Point a project at the `refs/version/<game>/<major.minor>` link, not at `refs/current/<game>`, which
every `refs` run moves.

## Credentials

Every credential comes from the environment, never from a flag. A flag value is readable in the
process list.

- `STEAM_USERNAME` is the account that owns the game.
- `STEAM_CONFIG_VDF` is base64 of a logged-in session, for a runner with nothing on disk.
- `STEAM_BRANCH_PASSWORD_<BRANCH>` is one private beta's password. Uppercase the name, and dashes
  become underscores.
- `GAMECRATE_REGISTRY_USER` is the registry username for `--push`.
- `GAMECRATE_REGISTRY_PASSWORD` is the registry token for `--push`.

A beta password reaches `steamcmd` through a `+runscript` file at mode 0600, so it stays out of the
argument list as well. A `--push` with no registry credentials fails before the download starts.
