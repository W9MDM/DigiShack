#!/usr/bin/env bash
# Restart a tier that has stopped answering, even though its process is still alive.
#
# WHY THIS EXISTS, and it is not hypothetical — it cost three days of operating.
#
# On 3 September at 23:37 the bridge's audio watchdog decided to restart the process. It
# logged the decision, sent the alert email, and then stopped. Its last line:
#
#     23:37:39  [flex] DAX stream rebuilt as 4000008
#     23:37:57  [alerts] emailed k9xyz@example.com: Bridge restarted itself (receiver audio
#               stopped)
#
# and nothing after it, for 3 days 9 hours. The process stayed up the whole time, so PM2 saw
# a healthy application and never cycled it. No QSOs, no stream, no alert — the station was
# simply off, and it was found by the operator asking why nothing had streamed.
#
# THE PART THAT MATTERS: both code paths involved are bounded ON PAPER. `stop()` kills ffmpeg
# and gives it three seconds before SIGKILL, then resolves either way; the watchdog races its
# alert against a three-second timer and then calls `process.exit(1)` from a 250 ms
# `setTimeout`. Neither can hang by inspection, and yet the process sat there for three days
# — which means whatever wedged it also stopped timers from firing, and a fix reasoned out
# from those two functions would be a guess dressed as a diagnosis.
#
# So this does not try to out-think the wedge. It asks the only question that cannot be
# answered wrongly from inside a wedged process — "does it still answer?" — from outside it.
# PM2 checks whether a process EXISTS. Nothing checked whether it still WORKS.
#
# Install (see scripts/install.sh, which does this):
#     * * * * * /opt/digishack/scripts/healthcheck.sh
#
# Absolute paths throughout, because cron's PATH is
# /usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin and a script that dies on
# `pm2: not found` is a health check that reports health by saying nothing.

set -uo pipefail

STATE_DIR=/var/lib/digishack/health
LOG_TAG=digishack-health
CURL=/usr/bin/curl
PM2=/usr/bin/pm2
LOGGER=/usr/bin/logger

# THREE CONSECUTIVE FAILURES, at one minute apart, before anything is restarted. A single
# miss is a deploy, a rebuild, or the twenty seconds the bridge takes to attach to the radio
# — restarting on one of those would turn every deploy into two restarts.
FAILS_BEFORE_RESTART=3

# AND AT MOST THIS MANY RESTARTS AN HOUR. If a tier cannot start at all, restarting it every
# three minutes for ever fights PM2's own crash-loop handling and floods the log with the
# same failure. Past the cap this keeps complaining and stops acting, which is the right way
# round: a human needs to see a crash loop, not have it papered over.
MAX_RESTARTS_PER_HOUR=4

mkdir -p "$STATE_DIR" 2>/dev/null || true

note() { "$LOGGER" -t "$LOG_TAG" -- "$*"; }

# Restarts inside the last hour, counted from the timestamps we appended.
recent_restarts() {
  local f="$STATE_DIR/$1.restarts" cutoff
  [ -f "$f" ] || { echo 0; return; }
  cutoff=$(date -d '1 hour ago' +%s 2>/dev/null || echo 0)
  local n=0 line ts
  while IFS= read -r line; do
    ts=$(date -d "$line" +%s 2>/dev/null || echo 0)
    [ "$ts" -ge "$cutoff" ] && n=$((n + 1))
  done < "$f"
  echo "$n"
}

check() {
  local name=$1 url=$2 proc=$3
  local fails_file="$STATE_DIR/$name.fails"
  local fails

  # `-f` so an HTTP error status counts as a failure, not as a reply. A 500 from a tier that
  # has lost its database is not health, and this used to be the kind of distinction that
  # made a green check meaningless.
  if "$CURL" -sf -o /dev/null --max-time 10 "$url"; then
    fails=$(cat "$fails_file" 2>/dev/null || echo 0)
    # Only announce the recovery if it had actually been failing, so a healthy box is silent.
    if [ "${fails:-0}" -gt 0 ]; then
      note "$name answered again after $fails consecutive failure(s)"
    fi
    echo 0 > "$fails_file"
    return 0
  fi

  fails=$(( $(cat "$fails_file" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" > "$fails_file"
  note "$name did not answer $url ($fails consecutive)"

  [ "$fails" -lt "$FAILS_BEFORE_RESTART" ] && return 1

  local recent
  recent=$(recent_restarts "$name")
  if [ "$recent" -ge "$MAX_RESTARTS_PER_HOUR" ]; then
    note "$name still dead after $recent restart(s) this hour — NOT restarting again; this needs a human"
    return 1
  fi

  note "restarting $proc after $fails consecutive failures (restart $((recent + 1)) this hour)"
  # RESTART, and record it whether or not PM2 reports success: a failed restart is exactly
  # the case the hourly cap exists to notice.
  "$PM2" restart "$proc" >/dev/null 2>&1
  date -Is >> "$STATE_DIR/$name.restarts"
  echo 0 > "$fails_file"
  return 1
}

# ONE AT A TIME. Cron fires every minute and a restart takes longer than that, so without
# the lock a slow restart would overlap the next run and be restarted again mid-start.
exec 9> "$STATE_DIR/.lock"
if ! /usr/bin/flock -n 9; then
  note "a previous run is still going; skipping this minute"
  exit 0
fi

# THE BRIDGE FIRST, because it is the one that owns the radio and the one that wedged. Its
# /status is a real answer from the code that matters — it is served by the same event loop
# that runs the decoder and the schedule, so a reply proves that loop is turning.
check bridge http://127.0.0.1:3101/status digishack-bridge

# The web tier too. Nothing watched it either, and it was once down for five and a half
# hours before the operator noticed.
check web http://127.0.0.1:3000/api/health digishack-web

exit 0
