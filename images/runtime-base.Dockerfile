# Public, game-free base for a gamecrate runnable image. It holds no game files:
# `gamecrate steam build` appends a linux depot on top at /game, and
# .github/workflows/images.yml publishes the result. This layer supplies xvfb plus
# the X11/GL/audio native libs a Unity game (e.g. RimWorld's RimWorldLinux) needs
# to start headless.
#
# Contains NO game files and is safe to publish publicly.
FROM ubuntu:24.04

LABEL org.opencontainers.image.source="https://github.com/RimWorks/gamecrate"

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        imagemagick \
        libasound2t64 \
        libgl1 \
        libglu1-mesa \
        libgtk-3-0 \
        libnss3 \
        libpulse0 \
        libsdl2-2.0-0 \
        libx11-6 \
        libxcursor1 \
        libxext6 \
        libxi6 \
        libxinerama1 \
        libxrandr2 \
        libxrender1 \
        locales \
        x11-apps \
        xdotool \
        xserver-xephyr \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=C.UTF-8

# supplies a display and the native deps. a game with no headless mode still needs
# your own test-runner mod.
COPY scripts/headless-common.sh /usr/local/lib/headless-common.sh
COPY --chmod=755 scripts/run-headless.sh /usr/local/bin/run-headless
COPY --chmod=755 scripts/run-headed.sh /usr/local/bin/run-headed

# no USER: run-headless needs root to chown the mount parents, then drops to uid 1000.
# ubuntu:24.04 ships a stock user at uid 1000, so reclaim it first.
RUN userdel --remove ubuntu 2>/dev/null; useradd --create-home --uid 1000 app
ENV HOME=/home/app

WORKDIR /game
