#!/usr/bin/env bash
# Tries the Linux packages the Desktop installers workflow just built, on a clean GitHub machine (never on a person's
# computer: it installs and removes Rex Desk system-wide).
#   .deb:      apt install, open, wait for the server, write a marker in the data; install a copy with a higher version
#              over it (an upgrade), check the version and that the marker is kept; apt remove
#   AppImage:  open it and wait for the server (its self-update is covered by test/updates.test.js)
# Usage: bash scripts/try-installers.sh <folder with the built packages>
set -euo pipefail
built=${1:?folder with the built packages}
deb=$(find "$built" -name '*.deb' | head -1)
appimage=$(find "$built" -name '*.AppImage' | head -1)
[ -n "$deb" ] && [ -n "$appimage" ] || { echo "The build has no .deb or no .AppImage."; exit 1; }
echo "Packages: $(basename "$deb"), $(basename "$appimage")"

sudo apt-get update -qq
# xvfb: a screen for the window. libfuse2t64: what an AppImage needs to mount itself on Ubuntu 24.04.
sudo apt-get install -y -qq xvfb xauth curl libfuse2t64 >/dev/null

data="$HOME/.local/share/Rex Desk"
# Closes the window and its server: the server outlives the window on purpose, so it is stopped by the id it wrote.
stop() {
  pkill -x rex-desk || true; pkill -f 'AppImage' || true
  [ -f "$data/runtime.lock" ] && kill "$(cat "$data/runtime.lock")" 2>/dev/null || true
  sleep 3
}
wait_server() {
  local label=$1
  for _ in $(seq 1 80); do
    if curl -fsS -o /dev/null -m 5 http://127.0.0.1:4317/api/boot; then echo "$label: server answered"; return 0; fi
    sleep 3
  done
  echo "$label: the server did not answer within 4 minutes"
  for log in "$data"/server*.log; do [ -f "$log" ] && { echo "--- $log"; tail -40 "$log"; }; done
  return 1
}
open_app() { # <label> <command...>
  local label=$1; shift
  nohup xvfb-run -a "$@" >/tmp/rex-desk-window.log 2>&1 &
  wait_server "$label" || { echo '--- window'; tail -40 /tmp/rex-desk-window.log; exit 1; }
}

# ----- .deb -----
sudo apt-get install -y "$(realpath "$deb")"
version=$(dpkg-query -W -f '${Version}' rex-desk)
echo "deb: installed rex-desk $version, program $(command -v rex-desk)"
[ -d "/usr/lib/Rex Desk/payload" ] || { echo "deb: /usr/lib/Rex Desk/payload is missing"; exit 1; }
grep -q 'Exec=rex-desk' /usr/share/applications/*.desktop && echo 'deb: menu entry present'
open_app "deb $version" rex-desk
mkdir -p "$data" && echo kept > "$data/try-marker.txt"
stop

# An upgrade: the same package with a higher version installed over the first one, as apt does with a real new release.
work=$(mktemp -d)
dpkg-deb -R "$deb" "$work/pkg"
next="$version.1"
sed -i "s/^Version: .*/Version: $next/" "$work/pkg/DEBIAN/control"
dpkg-deb --build --root-owner-group "$work/pkg" "$work/rex-desk-next.deb" >/dev/null
sudo apt-get install -y "$work/rex-desk-next.deb"
[ "$(dpkg-query -W -f '${Version}' rex-desk)" = "$next" ] || { echo "deb: upgrade did not take"; exit 1; }
echo "deb: upgraded to $next"
open_app "deb $next" rex-desk
[ -f "$data/try-marker.txt" ] && echo 'deb: data kept' || { echo 'deb: data written before the upgrade is gone'; exit 1; }
stop
sudo apt-get remove -y rex-desk
[ ! -e /usr/bin/rex-desk ] || { echo 'deb: remove left /usr/bin/rex-desk'; exit 1; }
echo 'deb: removed'
rm -rf "$data"

# ----- AppImage -----
chmod +x "$appimage"
open_app 'AppImage' "$(realpath "$appimage")"
stop
echo 'All Linux package checks passed.'
