# game-free base. `gamecrate steam build` appends a WINDOWS depot on top at /game,
# and .github/workflows/images.yml publishes this image.
FROM ubuntu:24.04

# links the ghcr package back to the repo, and is the provenance trail for the
# GE-Proton build pinned below.
LABEL org.opencontainers.image.source="https://github.com/RimWorks/gamecrate"

ENV DEBIAN_FRONTEND=noninteractive

# Pinned so an image rebuild cannot silently change the wine underneath a test run.
ARG PROTON_VERSION=GE-Proton10-34
# from the release's own .sha512sum, so a version bump forces a new value here.
ARG PROTON_SHA512=9fd0b2cfbd501c0b5c892239c392c7283a029b5e5d5a77d3f85b0ce190d555456241a18eebca16b53f094b403499201c13550a3f0b9b365e1a5eb5737cbb7303

# DXVK needs a Vulkan driver, so mesa's lavapipe supplies one on a GPU-less runner.
# wine's own OpenGL path is no fallback: it hangs RimWorld on boot, real display or not.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libasound2t64 \
        libfreetype6 \
        libgl1 \
        libglu1-mesa \
        libgtk-3-0 \
        libnss3 \
        libpulse0 \
        libsdl2-2.0-0 \
        libvulkan1 \
        libx11-6 \
        libxcomposite1 \
        libxcursor1 \
        libxext6 \
        libxi6 \
        libxinerama1 \
        libxrandr2 \
        libxrender1 \
        locales \
        mesa-vulkan-drivers \
        python3 \
        vulkan-tools \
        xdotool \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=C.UTF-8

RUN mkdir -p /opt/proton \
    && curl -fsSL --proto '=https' --proto-redir '=https' "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/${PROTON_VERSION}/${PROTON_VERSION}.tar.gz" -o /tmp/proton.tar.gz \
    && echo "${PROTON_SHA512}  /tmp/proton.tar.gz" | sha512sum -c - \
    && tar -xzf /tmp/proton.tar.gz -C /opt/proton --strip-components=1 \
    && rm /tmp/proton.tar.gz \
    && test -x /opt/proton/proton

# `run-headless-windows <game.exe> <args...>`, the Windows twin of run-headless.
COPY scripts/headless-common.sh /usr/local/lib/headless-common.sh
COPY --chmod=755 scripts/run-headless-windows.sh /usr/local/bin/run-headless-windows

# same uid 1000 reclaim and root-then-drop as runtime-base-xvfb.Dockerfile
RUN userdel --remove ubuntu 2>/dev/null; useradd --create-home --uid 1000 app
ENV HOME=/home/app

WORKDIR /game
