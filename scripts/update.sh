#!/usr/bin/env bash
#
# DigiShack upgrade.
#
#   ./scripts/update.sh              # pull, migrate, build, reload
#   ./scripts/update.sh --no-pull    # skip git pull (already updated)
#   ./scripts/update.sh --backup     # mysqldump before migrating
#
# Refuses to run with uncommitted changes, so a local edit can't be silently
# clobbered by the pull.

set -euo pipefail

cd "$(dirname "$0")/.."

DO_PULL=1
DO_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) DO_PULL=0 ;;
    --backup)  DO_BACKUP=1 ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) printf "Unknown option: %s\n" "$arg" >&2; exit 1 ;;
  esac
done

if [ -t 1 ]; then
  R='\033[0;31m'; G='\033[0;32m'; Y='\033[0;33m'; B='\033[1m'; N='\033[0m'
else
  R=''; G=''; Y=''; B=''; N=''
fi
step() { printf "\n${B}==> %s${N}\n" "$1"; }
ok()   { printf "    ${G}ok${N}   %s\n" "$1"; }
warn() { printf "    ${Y}warn${N} %s\n" "$1"; }
die()  { printf "    ${R}fail${N} %s\n" "$1" >&2; exit 1; }

[ -f .env ] || die "no .env — run ./scripts/install.sh first"

VERSION_BEFORE="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"

# --- pull -----------------------------------------------------------------
if [ "$DO_PULL" -eq 1 ]; then
  step "Fetching updates"
  command -v git >/dev/null 2>&1 || die "git not found (use --no-pull if you update another way)"

  # NPM-MANAGED FILES ARE RECLAIMED, NOT PROTECTED.
  #
  # This refused every update on another operator's station, forever, with:
  #
  #     ==> Fetching updates
  #      M package-lock.json
  #      M package.json
  #         fail working tree has uncommitted changes — commit, stash, or use --no-pull
  #
  # He had hand-edited nothing. `npm install` during first-time setup resolves and
  # rewrites the lockfile, and a different npm version normalises package.json — so an
  # untouched installation goes dirty simply by having been installed, and then declines
  # every release after it with no way out but a shell and some git knowledge. He sat four
  # releases behind a frequency-guard fix because of these two lines.
  #
  # `lib/update/runner.ts` fixed exactly this — see its NPM_MANAGED comment, which quotes
  # the same two filenames. The shell path never learned it, and the shell path is the one
  # the README documents for other operators.
  #
  # They are build inputs owned by the repository. Nobody hand-edits them on a deployed
  # install and the incoming version is authoritative. Everything else still blocks: a
  # modified source file is a real edit and is what this guard was written to protect.
  DIRTY="$(git status --porcelain | grep -vE '[ /](package|package-lock)\.json$' || true)"
  if [ -n "$DIRTY" ]; then
    printf '%s\n' "$DIRTY"
    die "working tree has uncommitted changes — commit, stash, or use --no-pull"
  fi

  # Discarded because `git merge --ff-only` REFUSES outright when a tracked file it would
  # touch has local modifications. Without this the merge fails and reports a diverged
  # branch, which is not what happened and points nowhere useful.
  #
  # Reclaiming exactly what the filter above forgave, taken from git rather than assumed:
  # a hardcoded `package.json package-lock.json` would forgive a nested one and then fail
  # to restore it, which is the same broken merge with an even stranger explanation.
  NPM_DIRTY="$(git status --porcelain | grep -E '[ /](package|package-lock)\.json$' | cut -c4- || true)"
  if [ -n "$NPM_DIRTY" ]; then
    printf '%s\n' "$NPM_DIRTY" | while IFS= read -r f; do
      [ -n "$f" ] && git checkout -- "$f"
    done
    ok "reclaimed $(printf '%s' "$NPM_DIRTY" | tr '\n' ' ')— npm rewrites these, the incoming version wins"
  fi

  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  # GIT_TERMINAL_PROMPT=0 so a credential problem FAILS instead of hanging.
  #
  # This update runs unattended on other operators' machines. The public repo needs no
  # credentials, so the normal path never asks — but git's behaviour when it does ask is the
  # problem: on a 401 it runs `credential reject` and DELETES the stored credential, so the
  # next attempt has nothing to offer, tries to prompt, and with no terminal attached it
  # waits. The update does not fail, it stops, and an operator watching a script that has
  # printed nothing for ten minutes has no way to tell those apart.
  #
  # With this set, git returns a real error immediately and the message below names the
  # branch it could not reach. Costs nothing when credentials are not needed, which is
  # almost always.
  GIT_TERMINAL_PROMPT=0 git pull --ff-only origin "$BRANCH"     || die "could not pull origin/$BRANCH — check the network, or that this checkout still points at a repository you can read"
  ok "pulled origin/$BRANCH"
else
  warn "skipping git pull"
fi

# --- backup ---------------------------------------------------------------
if [ "$DO_BACKUP" -eq 1 ]; then
  step "Backing up the database"
  command -v mysqldump >/dev/null 2>&1 || die "mysqldump not found"

  # Parse mysql://user:pass@host:port/db out of DATABASE_URL using shell
  # expansion only — no dotenv, no node. Splits on the LAST '@' so a password
  # containing an encoded '@' still parses, and percent-decodes user and password.
  DB_URL="$(grep -E '^[[:space:]]*DATABASE_URL[[:space:]]*=' .env | tail -1 |
            sed -e 's/^[^=]*=//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
                -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  [ -n "$DB_URL" ] || die "DATABASE_URL not found in .env"

  # Percent-decoding via node rather than a printf '%b' trick: the shell
  # substitution needed for that swallows the backslash, silently leaving
  # "%40" as "x40" and handing mysqldump the wrong password. node is
  # guaranteed present — this is a Node application.
  urldecode() {
    node -e 'process.stdout.write(decodeURIComponent(process.argv[1]))' "$1"
  }

  REST="${DB_URL#*://}"
  CREDS="${REST%@*}"          # everything before the last '@'
  HOSTDB="${REST##*@}"        # everything after the last '@'

  DB_USER="$(urldecode "${CREDS%%:*}")"
  case "$CREDS" in
    *:*) DB_PASS="$(urldecode "${CREDS#*:}")" ;;
    *)   DB_PASS="" ;;
  esac

  HOSTPORT="${HOSTDB%%/*}"
  DB_NAME="${HOSTDB#*/}"
  DB_NAME="${DB_NAME%%\?*}"   # drop any ?connection_limit=... query

  DB_HOST="${HOSTPORT%%:*}"
  case "$HOSTPORT" in
    *:*) DB_PORT="${HOSTPORT##*:}" ;;
    *)   DB_PORT=3306 ;;
  esac

  [ -n "$DB_NAME" ] || die "could not parse a database name out of DATABASE_URL"
  ok "target ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

  mkdir -p backups
  STAMP="$(date -u +%Y%m%d-%H%M%S)"
  OUT="backups/digishack-${DB_NAME}-${STAMP}.sql"

  MYSQL_PWD="$DB_PASS" mysqldump \
    --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
    --single-transaction --quick --routines \
    "$DB_NAME" > "$OUT"

  gzip -f "$OUT"
  ok "wrote ${OUT}.gz"
else
  warn "no backup taken (pass --backup to dump first)"
fi

# --- dependencies ---------------------------------------------------------
step "Installing dependencies"
npm ci
ok "npm ci"

# --- migrations -----------------------------------------------------------
step "Applying database migrations"
PENDING="$(npx prisma migrate status 2>&1 || true)"
if printf '%s' "$PENDING" | grep -qi "following migration.*have not yet been applied\|not yet been applied"; then
  npx prisma migrate deploy || die "migration failed — the app was NOT reloaded"
  ok "migrations applied"
else
  ok "schema already up to date"
fi

# --- build ----------------------------------------------------------------
step "Building"
npm run build
ok "build complete"

# --- verify ---------------------------------------------------------------
step "Running checks"
npm run typecheck && ok "typecheck clean" || warn "typecheck reported problems"
npm run check:adif >/dev/null 2>&1 && ok "ADIF checks pass" || warn "ADIF checks failed"

# --- reload ---------------------------------------------------------------
step "Reloading"
if command -v pm2 >/dev/null 2>&1 && pm2 describe digishack-web >/dev/null 2>&1; then
  # reload, not restart: zero-downtime for in-flight requests.
  pm2 reload ecosystem.config.js --update-env
  pm2 save >/dev/null 2>&1 || true
  ok "PM2 reloaded"
else
  warn "no PM2 process named digishack-web — start it with: pm2 start ecosystem.config.js"
fi

VERSION_AFTER="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"

printf "\n${G}${B}Update complete.${N}  %s -> %s\n" "$VERSION_BEFORE" "$VERSION_AFTER"
printf "  Changes:  CHANGELOG.md\n"
printf "  Logs:     pm2 logs digishack-web\n\n"
