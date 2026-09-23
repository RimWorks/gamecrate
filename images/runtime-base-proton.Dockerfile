# game-free base. `gamecrate steam build` appends a WINDOWS depot on top at /game,
# and .github/workflows/images.yml publishes this image.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Pinned so an image rebuild cannot silently change the wine underneath a test run.
ARG PROTON_VERSION=GE-Proton10-34
# from the release's own .sha512sum, so a version bump forces a new value here.
ARG PROTON_SHA512=9fd0b2cfbd501c0b5c892239c392c7283a029b5e5d5a77d3f85b0ce190d555456241a18eebca16b53f094b403499201c13550a3f0b9b365e1a5eb5737cbb7303

# A Windows build, because the game encoding its films runs under wine and resolves
# ffmpeg against the Windows PATH.
ARG FFMPEG_BUILD=autobuild-2026-09-06-13-06
ARG FFMPEG_ZIP=ffmpeg-N-126435-gf93cd72dde-win64-gpl.zip
# from the release's own checksums.sha256, same deal.
ARG FFMPEG_SHA256=cd75d5135fdd98f386043607179f4d5d471dee1707dc63509e292dff170586f3

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
        unzip \
        vulkan-tools \
        xdotool \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=C.UTF-8

RUN mkdir -p /opt/proton /opt/ffmpeg \
    && curl -fsSL --proto '=https' --proto-redir '=https' "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/${PROTON_VERSION}/${PROTON_VERSION}.tar.gz" -o /tmp/proton.tar.gz \
    && echo "${PROTON_SHA512}  /tmp/proton.tar.gz" | sha512sum -c - \
    && tar -xzf /tmp/proton.tar.gz -C /opt/proton --strip-components=1 \
    && rm /tmp/proton.tar.gz \
    && test -x /opt/proton/proton \
    && curl -fsSL --proto '=https' --proto-redir '=https' "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BUILD}/${FFMPEG_ZIP}" -o /tmp/ffmpeg.zip \
    && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.zip" | sha256sum -c - \
    && unzip -j /tmp/ffmpeg.zip '*/bin/ffmpeg.exe' -d /opt/ffmpeg \
    && rm /tmp/ffmpeg.zip \
    && test -f /opt/ffmpeg/ffmpeg.exe

# `run-headless-windows <game.exe> <args...>`, the Windows twin of run-headless.
COPY scripts/headless-common.sh /usr/local/lib/headless-common.sh
COPY --chmod=755 scripts/run-headless-windows.sh /usr/local/bin/run-headless-windows

# same uid 1000 reclaim and root-then-drop as runtime-base-xvfb.Dockerfile
RUN userdel --remove ubuntu 2>/dev/null; useradd --create-home --uid 1000 app
ENV HOME=/home/app

WORKDIR /game
