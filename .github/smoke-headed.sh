#!/bin/sh
# Runs inside the container, as the game would. Proves the nested server accepts injected input.
set -eu

# a reading with no client attached is worthless: an X server snaps the pointer to the centre
# when its last client disconnects, so the move looks lost when it landed
xeyes -geometry 100x100+5+5 >/dev/null 2>&1 &
holder=$!
sleep 2
kill -0 "$holder" 2>/dev/null || { echo "smoke: no client held the nested display" >&2; exit 1; }

# read from a second process. chained into one xdotool it echoes the target back optimistically
# and reports success whether or not the pointer moved
xdotool mousemove 300 200
sleep 0.4
first=$(xdotool getmouselocation --shell | grep -E '^(X|Y)=' | tr '\n' ' ')
xdotool mousemove 55 66
sleep 0.4
second=$(xdotool getmouselocation --shell | grep -E '^(X|Y)=' | tr '\n' ' ')

echo "first=$first second=$second display=$DISPLAY"
case "$first" in *"X=300 Y=200"*) ;; *) echo "smoke: first move did not stick" >&2; exit 1 ;; esac
case "$second" in *"X=55 Y=66"*) ;; *) echo "smoke: second move did not stick" >&2; exit 1 ;; esac
echo "smoke: XTEST reaches the nested server"
