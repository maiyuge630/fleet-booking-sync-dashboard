#!/data/data/com.termux/files/usr/bin/bash
# Run as the ordinary Termux app user after its official bootstrap has finished.
set -euo pipefail
test "$(id -u)" -ne 0 || { echo 'Run this inside Termux as its ordinary app user.'; exit 1; }
test "${PREFIX:-}" = /data/data/com.termux/files/usr || { echo 'Unexpected Termux prefix.'; exit 1; }
test "${HOME:-}" = /data/data/com.termux/files/home || { echo 'Unexpected Termux home.'; exit 1; }
umask 077
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y -o Dpkg::Options::=--force-confold upgrade
apt-get install -y x11-repo
apt-get update
apt-get install -y nodejs-lts npm chromium tigervnc termux-services android-tools
apt-get install -y --no-install-recommends openbox xorg-xauth xorg-xdpyinfo xorg-xprop
node --version
npm --version
command -v chromium-browser
command -v Xvnc
command -v vncpasswd
command -v openbox
command -v xauth
command -v xdpyinfo
command -v xprop
printf '%s\n' 'Official Termux runtime installed. Browser service is not yet started.'
