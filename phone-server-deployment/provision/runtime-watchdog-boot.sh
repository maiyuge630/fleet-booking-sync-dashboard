#!/system/bin/sh
# KernelSU late_start entry, fixed-purpose and non-blocking.
# Installed as /data/adb/service.d/90-tidewyn-fleet.sh.
# The companion verifies UID, private installation directory, cgroup scope,
# enabled preference and its own kernel lock before any recovery operation.
exec /system/bin/setsid /system/bin/nohup /system/bin/sh \
  /data/adb/tidewyn-fleet/runtime-watchdog.sh \
  </dev/null >/dev/null 2>&1 &
