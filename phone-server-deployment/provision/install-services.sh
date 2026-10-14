#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
native_samboat=0
case "$#" in
    0) ;;
    1)
        case "$1" in
            --native-samboat-already-paired) native_samboat=1 ;;
            --help|-h)
                printf '%s\n' \
                    'Usage: bash install-services.sh [--native-samboat-already-paired]' \
                    'Opt in only after this phone has completed its own TLS ADB pairing.' \
                    'This installer does not pair devices or enable wireless debugging.'
                exit 0
                ;;
            *) printf '%s\n' 'Unknown option; use --help.' >&2; exit 2 ;;
        esac
        ;;
    *) printf '%s\n' 'Unexpected arguments; use --help.' >&2; exit 2 ;;
esac
test "$(id -u)" -ne 0 || { echo 'Ordinary Termux app user required.'; exit 1; }
test "${PREFIX:-}" = /data/data/com.termux/files/usr || exit 1
test "${HOME:-}" = /data/data/com.termux/files/home || exit 1
umask 077
app="$HOME/tidewyn-fleet"
test -f "$app/phone-server/server.mjs"
test -f "$app/phone-server/package-lock.json"
if [ "$native_samboat" -eq 1 ]; then
    test -f "$app/provision/native-chrome-bridge.mjs" || { echo 'Native Chrome bridge file is required.' >&2; exit 1; }
    test -x "$PREFIX/bin/adb" || { echo 'Termux android-tools must be installed before opting in.' >&2; exit 1; }
fi
for service in fleet-vnc fleet-wm fleet-sync; do
    test ! -e "$PREFIX/var/service/$service/run" || { echo "Existing $service requires a deliberate service update."; exit 1; }
done
cd "$app/phone-server"
npm ci --ignore-scripts --no-audit --no-fund
node "$app/provision/prepare-vnc.mjs"
mkdir -p "$HOME/.termux/boot"
for service in fleet-vnc fleet-wm fleet-sync; do
    mkdir -p "$PREFIX/var/service/$service/log" "$PREFIX/var/log/sv/$service"
    touch "$PREFIX/var/service/$service/down"
    printf 's1048576\nn3\n' > "$PREFIX/var/log/sv/$service/config"
    printf '#!/data/data/com.termux/files/usr/bin/sh\nexec /data/data/com.termux/files/usr/share/termux-services/svlogger\n' > "$PREFIX/var/service/$service/log/run"
    chmod 700 "$PREFIX/var/service/$service/log/run"
done
cat > "$PREFIX/var/service/fleet-vnc/run" <<'VNC'
#!/data/data/com.termux/files/usr/bin/sh
exec 2>&1
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:/system/bin"
export TMPDIR="$PREFIX/tmp"
export LANG=en_US.UTF-8
export XAUTHORITY="$HOME/.local/share/tidewyn-phone/Xauthority"
exec Xvnc :1 -geometry 1440x900 -depth 24 -localhost -nolisten tcp -auth "$XAUTHORITY" -SecurityTypes VncAuth -PasswordFile "$HOME/.vnc/fleet.passwd" -rfbport 5901 -AlwaysShared
VNC
cat > "$PREFIX/var/service/fleet-wm/run" <<'WM'
#!/data/data/com.termux/files/usr/bin/sh
exec 2>&1
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:/system/bin"
export TMPDIR="$PREFIX/tmp"
export LANG=en_US.UTF-8
export DISPLAY=:1
export XAUTHORITY="$HOME/.local/share/tidewyn-phone/Xauthority"
# Check the authenticated X connection on every restart, not only at boot.
until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do sleep 1; done
exec openbox
WM
cat > "$PREFIX/var/service/fleet-sync/run" <<'SYNC'
#!/data/data/com.termux/files/usr/bin/sh
exec 2>&1
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:/system/bin"
export TMPDIR="$PREFIX/tmp"
export LANG=en_US.UTF-8
export TZ=Asia/Shanghai
export DISPLAY=:1
export XAUTHORITY="$HOME/.local/share/tidewyn-phone/Xauthority"
export FLEET_PHONE_PORT=8788
export FLEET_PHONE_HOME="$HOME/.local/share/tidewyn-phone"
export FLEET_CHROMIUM_PATH="$PREFIX/bin/chromium-browser"
SYNC
if [ "$native_samboat" -eq 1 ]; then
    printf '%s\n' 'export FLEET_SAMBOAT_CDP_PORT=9222' 'export FLEET_SAMBOAT_BRIDGE=1' >> "$PREFIX/var/service/fleet-sync/run"
else
    # An unconfigured installation must not inherit native mode from the caller.
    printf '%s\n' 'unset FLEET_SAMBOAT_CDP_PORT FLEET_SAMBOAT_BRIDGE' >> "$PREFIX/var/service/fleet-sync/run"
fi
cat >> "$PREFIX/var/service/fleet-sync/run" <<'SYNC'
if [ ! -d /dev/shm ] || [ ! -w /dev/shm ]; then export FLEET_DISABLE_DEV_SHM=1; fi
# runit starts services independently. Wait for a working display and window
# manager, so boot order or a restarted Xvnc cannot race Chromium's launch.
until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 &&
    xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -Eq 'window id # 0x[0-9a-fA-F]+'; do
    sleep 1
done
cd "$HOME/tidewyn-fleet/phone-server"
exec node server.mjs
SYNC
chmod 700 "$PREFIX/var/service/fleet-vnc/run" "$PREFIX/var/service/fleet-wm/run" "$PREFIX/var/service/fleet-sync/run"
cat > "$HOME/.termux/boot/20-fleet-server" <<'BOOT'
#!/data/data/com.termux/files/usr/bin/sh
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:/system/bin"
termux-wake-lock
. "$PREFIX/etc/profile.d/start-services.sh"
sv-enable fleet-vnc
sv-enable fleet-wm
sv-enable fleet-sync
BOOT
chmod 700 "$HOME/.termux/boot/20-fleet-server"
printf '%s\n' 'Services and boot entry prepared. Run the boot entry inside Termux to start.'
