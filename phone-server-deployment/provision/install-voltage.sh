#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
test "${HOME:-}" = /data/data/com.termux/files/home
test "${PREFIX:-}" = /data/data/com.termux/files/usr
test "$(id -u)" -ne 0
umask 077
app="$HOME/tidewyn-fleet"
node --check "$app/phone-server/voltage.mjs"
test ! -e "$PREFIX/var/service/fleet-voltage/run" || { echo 'Existing voltage service requires explicit update'; exit 1; }
mkdir -p "$PREFIX/var/service/fleet-voltage/log" "$PREFIX/var/log/sv/fleet-voltage" "$HOME/.termux/boot"
touch "$PREFIX/var/service/fleet-voltage/down"
printf 's1048576\nn3\n' > "$PREFIX/var/log/sv/fleet-voltage/config"
printf '#!/data/data/com.termux/files/usr/bin/sh\nexec /data/data/com.termux/files/usr/share/termux-services/svlogger\n' > "$PREFIX/var/service/fleet-voltage/log/run"
cat > "$PREFIX/var/service/fleet-voltage/run" <<'SERVICE'
#!/data/data/com.termux/files/usr/bin/sh
exec 2>&1
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:/system/bin"
export TMPDIR="$PREFIX/tmp"
export TZ=Asia/Shanghai
cd "$HOME/tidewyn-fleet/phone-server"
exec node voltage.mjs
SERVICE
cat > "$HOME/.termux/boot/21-fleet-voltage" <<'BOOT'
#!/data/data/com.termux/files/usr/bin/sh
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:/system/bin"
termux-wake-lock
. "$PREFIX/etc/profile.d/start-services.sh"
sv-enable fleet-voltage
BOOT
chmod 700 "$PREFIX/var/service/fleet-voltage/run" "$PREFIX/var/service/fleet-voltage/log/run" "$HOME/.termux/boot/21-fleet-voltage"
# runsvdir discovers new service directories asynchronously.
"$HOME/.termux/boot/21-fleet-voltage" || true
for attempt in $(seq 1 20); do
    if sv status "$PREFIX/var/service/fleet-voltage" 2>/dev/null | grep -q '^run:'; then exit 0; fi
    sv up "$PREFIX/var/service/fleet-voltage" >/dev/null 2>&1 || true
    sleep 1
done
echo 'Voltage service did not start within 20 seconds' >&2
exit 1
