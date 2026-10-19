#!/usr/bin/env bash
# LFCP-03-068: the side-by-side frames and the short demo from the showcase
# frames (the artifact's screenshots/showcase). Needs ffmpeg.
#   test/native/showcase/build-media.sh <frames dir> <output dir>
# Output: NN-name-pair-{light,dark}.png (Alex left, Sam right), demo.mp4, demo.gif.
set -euo pipefail
in=${1:?frames dir}
out=${2:?output dir}
mkdir -p "$out"
cp "$in"/*.png "$out"/

for mode in light dark; do
  for a in "$in"/*-alex-"$mode".png; do
    [ -e "$a" ] || continue
    b="${a%-alex-"$mode".png}-sam-$mode.png"
    name=$(basename "${a%-alex-"$mode".png}")
    ffmpeg -v error -y -i "$a" -i "$b" -filter_complex "hstack=inputs=2" "$out/$name-pair-$mode.png"
  done
done

# The demo, light theme, 2 -> 3 -> 4: invite, join, insert, then A's edit seen by B.
# Each frame 2.5 s, 960 px wide for the invite, join and insert frames, the pair 1920 -> 960 wide.
frames=(05-invite-link 06-join-field 07-join-ready-to-insert 08-insert-preview 09-inserted 10-sync-a-to-b-pair 11-sync-b-to-a-pair)
list=$(mktemp)
for f in "${frames[@]}"; do
  src="$out/$f-light.png"
  [ -e "$src" ] || src="$out/${f%-pair}-pair-light.png"
  [ -e "$src" ] || { echo "missing $f" >&2; exit 1; }
  printf "file '%s'\nduration 2.5\n" "$src" >> "$list"
done
last=$(tail -2 "$list" | head -1 | sed "s/file '\(.*\)'/\1/")
printf "file '%s'\n" "$last" >> "$list"
vf="scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=white,fps=15,format=yuv420p"
ffmpeg -v error -y -f concat -safe 0 -i "$list" -vf "$vf" -c:v libx264 -crf 28 -movflags +faststart "$out/demo.mp4"
ffmpeg -v error -y -f concat -safe 0 -i "$list" -vf "${vf%,format=yuv420p},scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" "$out/demo.gif"
rm -f "$list"
ls -l "$out/demo.mp4" "$out/demo.gif"
