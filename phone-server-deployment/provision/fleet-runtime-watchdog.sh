#!/system/bin/sh
# Fixed-purpose root companion. Run with the already authorized Termux su.
# It neither grants app Root access nor changes cgroups/freezer/global settings.
# Install as /data/adb/tidewyn-fleet/runtime-watchdog.sh, root-owned 0700.
PATH=/system/bin
export PATH
umask 077
ROOT_DIR=/data/adb/tidewyn-fleet
PREFIX=/data/data/com.termux/files/usr
PREFS=/data/user/0/com.tidewyn.wirelessguardian/shared_prefs/guardian.xml
PIDFILE=$PREFIX/var/run/service-daemon.pid
LAST_REPAIR=-120
STOP=0

# Keep every Android command bounded, and do not lend our singleton lock to
# run-as/service-daemon's detached children. timeout kills only its own command.
bounded() { local seconds=$1; shift; /system/bin/timeout -k 2 "$seconds" "$@" 9>&-; }
read_file() { bounded 3 /system/bin/cat "$1"; }
owner() { bounded 3 /system/bin/stat -c %u "$1"; }
proc_exists() { [ -d "/proc/$1" ]; }
process_command() { bounded 3 /system/bin/tr '\000' '\n' < "/proc/$1/cmdline"; }
lock_command() { /system/bin/flock -n 9 9>&9; }
acquire_lock() {
    # Android mksh marks exec-opened descriptors close-on-exec. Explicit
    # 9>&9 above lends FD 9 only to flock, which locks the parent's same open
    # file description. Both contention and command errors remain nonzero;
    # neither may claim startup success or overwrite the active status file.
    local result
    lock_command 2>/dev/null; result=$?
    [ "$result" -eq 0 ] && return 0
    printf '%s\n' runtime_watchdog_lock_not_acquired >&2
    return "$result"
}
clock_seconds() {
    local uptime;uptime=$(read_file /proc/uptime) || return 1
    awk '{split($1,a,"."); if(a[1] ~ /^[0-9]+$/)print a[1]; else exit 1}' <<EOF
$uptime
EOF
}
numeric() { case "$1" in ''|*[!0-9]*|0|0[0-9]*) return 1;; esac; }

record() {
    # Only internal enum values enter the log; no command output or page data.
    local code=$1 now
    case "$code" in healthy|disabled|prefs_unavailable|identity_failed|scope_failed|probe_failed|rate_limited|repair_started|service_restore_failed|service_not_ready|supervisor_restore_failed|supervisor_not_ready|supervisor_ambiguous|pidfile_unsafe|pidfile_changed|services_discovering|recovered|stopped) ;;
        *) return 1;; esac
    now=$(date -u '+%Y-%m-%dT%H:%M:%SZ') || now=unknown
    printf '%s %s\n' "$now" "$code" > "$ROOT_DIR/status.tmp" && mv -f "$ROOT_DIR/status.tmp" "$ROOT_DIR/status.txt" || return 1
    # Bounded history, updated by the sole lock holder. Disk failure never
    # permits additional recovery or exposes raw diagnostic command output.
    if [ "$code" != "${LAST_CODE:-}" ]; then
        { tail -n 99 "$ROOT_DIR/events.log" 2>/dev/null; printf '%s %s\n' "$now" "$code"; } > "$ROOT_DIR/events.tmp" && mv -f "$ROOT_DIR/events.tmp" "$ROOT_DIR/events.log" || return 1
        LAST_CODE=$code
    fi
    return 0
}

enabled() {
    [ "$STOP" -eq 0 ] || return 1
    local xml
    xml=$(read_file "$PREFS") || return 2
    # Android SharedPreferences serializer uses this fixed boolean element.
    # Require a complete map and exactly one enabled entry. Missing, partial,
    # duplicate or unfamiliar representations fail closed until a later tick.
    awk '
      /^[[:space:]]*<map>[[:space:]]*$/ {if(state!=0)bad++;state=1;begin++;next}
      /^[[:space:]]*<\/map>[[:space:]]*$/ {if(state!=1)bad++;state=2;end++;next}
      /<\/?map[[:space:]>]/ {bad++}
      /name="enabled"/ {entries++; if(state!=1)bad++; if($0 ~ /^[[:space:]]*<boolean name="enabled" value="true"[[:space:]]*\/>[[:space:]]*$/) yes++; else if($0 ~ /^[[:space:]]*<boolean name="enabled" value="false"[[:space:]]*\/>[[:space:]]*$/) no++; else bad++}
      END {if(begin!=1||end!=1||state!=2||entries!=1||bad)exit 2; if(yes!=1||no)exit 1}' <<EOF
$xml
EOF
}

check_scope() {
    [ "$(bounded 3 /system/bin/id -u)" = 0 ] || return 1
    local groups;groups=$(read_file "/proc/$$/cgroup") || return 1
    awk -F: 'NF!=3 || $3!="/" {bad=1} END {exit (NR==0||bad)}' <<EOF
$groups
EOF
}

identity() {
    local packages uid run_uid
    packages=$(bounded 5 /system/bin/cmd package list packages -U com.termux) || return 1
    uid=$(awk '/^package:com\.termux uid:[0-9]+$/ {n++; sub(/^.*uid:/,""); v=$0} END {if(n==1)print v; else exit 1}' <<EOF
$packages
EOF
    ) || return 1
    numeric "$uid" && [ "$uid" -ge 10000 ] && [ "$uid" -lt 100000 ] || return 1
    [ "$(owner /data/data/com.termux)" = "$uid" ] || return 1
    run_uid=$(bounded 5 /system/bin/run-as com.termux /system/bin/id -u) || return 1
    [ "$run_uid" = "$uid" ] || return 1
    TERMUX_UID=$uid
}

process_token() {
    local pid=$1 stat_data status_data ids start
    numeric "$pid" || return 1
    proc_exists "$pid" || return 1
    stat_data=$(read_file "/proc/$pid/stat") || return 2
    # /proc stat comm may contain spaces/parentheses; fields after the last )
    # start at field 3, making starttime the twentieth remaining field.
    start=$(awk '{sub(/^.*\) /,""); if(NF>=20 && $20~/^[0-9]+$/)print $20; else exit 1}' <<EOF
$stat_data
EOF
    ) || return 2
    [ -n "$start" ] || return 2
    status_data=$(read_file "/proc/$pid/status") || return 2
    ids=$(awk '/^Uid:/ {print $2":"$3":"$4":"$5}' <<EOF
$status_data
EOF
    ) || return 2
    [ -n "$ids" ] || return 2
    [ "$ids" = "$TERMUX_UID:$TERMUX_UID:$TERMUX_UID:$TERMUX_UID" ] || return 1
    printf '%s:%s\n' "$pid" "$start"
}

matches_process() {
    local pid=$1 role=$2 first last command executable
    first=$(process_token "$pid") || return $?
    command=$(process_command "$pid") || return 2
    case "$role" in
        termux) [ "$command" = com.termux ] || return 1;;
        supervisor)
            executable=$(bounded 3 /system/bin/readlink "/proc/$pid/exe") || return 2
            # A package upgrade can unlink the live executable; ambiguity
            # must not authorize starting a second supervisor over it.
            [ "$executable" = "$PREFIX/bin/runsvdir (deleted)" ] && return 2
            [ "$executable" = "$PREFIX/bin/runsvdir" ] || return 2
            awk -v bin="$PREFIX/bin/runsvdir" -v dir="$PREFIX/var/service" 'NR==1 {if($0!=bin&&$0!="runsvdir")bad=1} NR==2 {if($0!=dir)bad=1} END {exit(NR!=2||bad)}' <<EOF
$command
EOF
            [ "$?" -eq 0 ] || return 2;;
        *) return 1;;
    esac
    last=$(process_token "$pid") || return $?
    [ "$first" = "$last" ] || return 2
    MATCH_TOKEN=$first
}

foreground_pid() {
    # Only the actual TermuxService block can provide its foreground state.
    awk '
      /^[[:space:]]*\* ServiceRecord/ {active=($0~/com\.termux\/\.app\.TermuxService[[:space:]}]/); if(active)n++}
      active && /app=ProcessRecord\{[^}]* [0-9]+:com\.termux\// {v=$0; sub(/^.* /,"",v); sub(/:com\.termux\/.*$/,"",v); pid=v}
      active && /isForeground=true([[:space:]]|$)/ {fg=1}
      END {if(n==1&&fg&&pid~/^[1-9][0-9]*$/)print pid; else exit 1}'
}

read_service_state() {
    local services power pid token
    services=$(bounded 5 /system/bin/dumpsys activity services com.termux) || return 2
    power=$(bounded 5 /system/bin/dumpsys power) || return 2
    # Android mksh may use external printf: passing dumpsys output as one
    # argument can exceed Linux MAX_ARG_STRLEN. Feed all text through stdin.
    # Capture + check dumpsys separately so its timeout cannot become absence.
    pid=$(foreground_pid <<EOF
$services
EOF
    ) || return 1
    matches_process "$pid" termux || return $?
    token=$MATCH_TOKEN
    # Historical ACQ/REL events and DISABLED locks cannot count as a held lock.
    awk -v uid="$TERMUX_UID" -v pid="$pid" '
      /^[[:space:]]*PARTIAL_WAKE_LOCK[[:space:]]/ && /\047termux:service-wakelock\047/ && !/DISABLED/ {
        if(index($0,"(uid="uid" pid="pid")"))found=1
      } END {exit !found}' <<EOF
$power
EOF
    [ "$?" -eq 0 ] || return 1
    local current
    current=$(process_token "$pid") || return $?
    [ "$current" = "$token" ] || return 2
    TERMUX_FGS_PID=$pid; TERMUX_FGS_TOKEN=$token
}

find_supervisor() {
    local pids pid count=0 seen=0
    # pidof status 1 means no process; distinguish it from a command timeout.
    pids=$(bounded 3 /system/bin/pidof runsvdir); local result=$?
    [ "$result" -le 1 ] || return 2
    SUPERVISOR_PID=; SUPERVISOR_TOKEN=
    for pid in $pids; do
        seen=$((seen+1)); [ "$seen" -le 16 ] || return 2
        numeric "$pid" || return 2
        matches_process "$pid" supervisor; local match=$?
        if [ "$match" -eq 0 ]; then
            count=$((count+1)); SUPERVISOR_PID=$pid; SUPERVISOR_TOKEN=$MATCH_TOKEN
        elif [ "$match" -ne 1 ]; then return 2; fi
    done
    [ "$count" -le 1 ] || return 3
    [ "$count" -eq 1 ]
}

check_pidfile() {
    local original
    [ ! -L "$PIDFILE" ] || return 1
    [ -e "$PIDFILE" ] || return 0
    [ -f "$PIDFILE" ] && [ "$(owner "$PIDFILE")" = "$TERMUX_UID" ] || return 1
    original=$(read_file "$PIDFILE") || return 1
    numeric "$original" || return 1
    # Never remove a pidfile: the ordinary boot path may replace it at any
    # instant. Existing service-daemon start uses start-stop-daemon -S -p and
    # -x together, so a stale/reused PID of another executable is not a match.
    # The live /proc scan independently prevents starting over a wrong file.
    return 0
}

network_capable_termux() {
    local permissions status current
    permissions=$(bounded 5 /system/bin/dumpsys package com.termux) || return 1
    awk '/^[[:space:]]*android\.permission\.INTERNET: granted=true([[:space:],]|$)/ {found=1} END {exit !found}' <<EOF
$permissions
EOF
    [ "$?" -eq 0 ] || return 1
    # Only inherit inet when the actual foreground app already owns it.
    # Never grant Android permissions or infer them from requested permissions.
    read_service_state || return 1
    status=$(read_file "/proc/$TERMUX_FGS_PID/status") || return 1
    awk '/^Groups:/ {for(i=2;i<=NF;i++)if($i==3003)found=1} END {exit !found}' <<EOF
$status
EOF
    [ "$?" -eq 0 ] || return 1
    current=$(process_token "$TERMUX_FGS_PID") || return 1
    [ "$current" = "$TERMUX_FGS_TOKEN" ]
}

start_supervisor() {
    # Source the existing supported start path. It starts runsvdir only;
    # do not use sv up/enable/restart or alter intentional service down files.
    network_capable_termux && enabled || return 1
    # Android run-as inherits its caller's supplementary groups. A root-only
    # caller loses inet, leaving live Node processes unable to resolve DNS.
    # Restore only already-granted inet in this fixed child, then let run-as
    # drop all UIDs/GIDs and choose the normal run-as SELinux context.
    bounded 8 /system/bin/su -g 0 -G 3003 -c 'exec /system/bin/run-as com.termux /system/bin/sh' <<'TERMUX_START'
      uid=$(/system/bin/id -u) || exit 77
      owner=$(/system/bin/stat -c %u /data/data/com.termux) || exit 77
      case "$uid" in ""|*[!0-9]*) exit 77;; esac
      [ "$uid" -ge 10000 ] && [ "$uid" -lt 100000 ] && [ "$uid" = "$owner" ] || exit 77
      groups=$(/system/bin/id -G) || exit 77
      shared=$((uid+40000)); inet=0
      for group in $groups; do
        case "$group" in 3003)inet=1;;"$uid"|"$shared");;*)exit 77;;esac
      done
      [ "$inet" -eq 1 ] || exit 77
      export HOME=/data/data/com.termux/files/home PREFIX=/data/data/com.termux/files/usr
      export PATH="$PREFIX/bin:/system/bin"
      test -f "$PREFIX/etc/profile.d/start-services.sh" || exit 1
      . "$PREFIX/etc/profile.d/start-services.sh"
TERMUX_START
}

services_ready() {
    local statuses service line
    statuses=$(bounded 5 /system/bin/run-as com.termux /data/data/com.termux/files/usr/bin/sv status \
      /data/data/com.termux/files/usr/var/service/fleet-vnc \
      /data/data/com.termux/files/usr/var/service/fleet-wm \
      /data/data/com.termux/files/usr/var/service/fleet-sync \
      /data/data/com.termux/files/usr/var/service/fleet-voltage 2>/dev/null) || return 1
    for service in fleet-vnc fleet-wm fleet-sync fleet-voltage; do
        line=$(awk -v p="$PREFIX/var/service/$service:" 'index($0,"run: "p)==1||index($0,"down: "p)==1 {n++;value=$0} END {if(n==1)print value;else exit 1}' <<EOF
$statuses
EOF
        ) || return 1
        case "$line" in
            run:*) ;;
            down:*) [ -e "$PREFIX/var/service/$service/down" ] || return 1;;
            *) return 1;;
        esac
    done
    # This proves supervision discovery/current run-or-intentional-down only,
    # not HTTP availability, platform login or a successful order sync.
}

cycle() {
    local allow service supervisor now i
    enabled; allow=$?
    if [ "$allow" -ne 0 ]; then
        [ "$allow" -eq 1 ] && record disabled || record prefs_unavailable
        return
    fi
    check_scope || { record scope_failed; return; }
    identity || { record identity_failed; return; }
    read_service_state; service=$?
    find_supervisor; supervisor=$?
    [ "$service" -le 1 ] && [ "$supervisor" -le 1 ] || {
        [ "$supervisor" -eq 3 ] && record supervisor_ambiguous || record probe_failed; return;
    }
    if [ "$service" -eq 0 ] && [ "$supervisor" -eq 0 ]; then
        services_ready && record healthy || record services_discovering
        return
    fi
    now=$(clock_seconds) || { record probe_failed; return; }
    numeric "$now" || { record probe_failed; return; }
    [ "$now" -ge "$LAST_REPAIR" ] && [ "$((now-LAST_REPAIR))" -ge 120 ] || { record rate_limited; return; }
    enabled || { record disabled; return; }
    # Log before mutation; lack of writable diagnostics is a closed failure.
    record repair_started || return
    LAST_REPAIR=$now
    if [ "$service" -ne 0 ]; then
        enabled || { record disabled; return; }
        bounded 8 /system/bin/am start-foreground-service --user 0 -n com.termux/.app.TermuxService -a com.termux.service_wake_lock >/dev/null 2>&1 || { record service_restore_failed; return; }
        i=0
        while [ "$i" -lt 4 ]; do
            enabled || { record disabled; return; }
            read_service_state && break
            i=$((i+1)); sleep 1
        done
        [ "$i" -lt 4 ] || { record service_not_ready; return; }
    fi
    # Re-evaluate after service startup: another normal boot path may already
    # have created runsvdir. A matching process always prevents another start.
    find_supervisor; supervisor=$?
    if [ "$supervisor" -eq 1 ]; then
        enabled || { record disabled; return; }
        check_pidfile || { record pidfile_unsafe; return; }
        find_supervisor; supervisor=$?
        if [ "$supervisor" -eq 1 ]; then
            enabled || { record disabled; return; }
            start_supervisor || { record supervisor_restore_failed; return; }
        elif [ "$supervisor" -ne 0 ]; then record probe_failed; return; fi
    elif [ "$supervisor" -ne 0 ]; then record probe_failed; return; fi
    # runsvdir discovers its services asynchronously; allow a bounded window.
    i=0
    while [ "$i" -lt 10 ]; do
        enabled || { record disabled; return; }
        if find_supervisor && services_ready; then record recovered; return; fi
        i=$((i+1)); sleep 2
    done
    record supervisor_not_ready
}

main() {
    [ "$#" -eq 0 ] || exit 64
    [ "$(bounded 3 /system/bin/id -u)" = 0 ] || exit 77
    [ -d "$ROOT_DIR" ] && [ ! -L "$ROOT_DIR" ] && [ "$(owner "$ROOT_DIR")" = 0 ] && [ "$(bounded 3 /system/bin/stat -c %a "$ROOT_DIR")" = 700 ] || exit 78
    # Root-only directory provisioned by installation, never follow a lock
    # symlink or trust a PID file for singleton identity.
    [ ! -L "$ROOT_DIR/watchdog.lock" ] || exit 78
    exec 9>"$ROOT_DIR/watchdog.lock" || exit 78
    acquire_lock || exit $?
    check_scope 9>&- || { record scope_failed 9>&-; exit 78; }
    trap 'STOP=1' TERM INT HUP
    while [ "$STOP" -eq 0 ]; do
        # The shell saves/restores FD 9 close-on-exec for function redirection;
        # no diagnostic, sleep, timeout or detached service inherits the lock.
        cycle 9>&-
        [ "$STOP" -eq 0 ] && sleep 30 9>&-
    done
    record stopped 9>&-
}

main "$@"
