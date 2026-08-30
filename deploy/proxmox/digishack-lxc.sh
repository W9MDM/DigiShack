#!/usr/bin/env bash
#
# Create a DigiShack container on Proxmox VE, from the Proxmox host.
#
#   bash deploy/proxmox/digishack-lxc.sh
#   bash deploy/proxmox/digishack-lxc.sh --ctid 141 --hostname shack --cores 4
#
# What it does, in order: fetch a Debian 12 template if the host has not got one,
# create an unprivileged LXC, install Node 20, MariaDB, git and PM2 inside it, clone
# DigiShack, create the database, and hand over to `scripts/install.sh` — which is the
# same installer a bare-metal install uses, so there is exactly one install path to keep
# working.
#
# WHY LXC AND NOT A VM. The bridge binds a UDP socket and talks to radios over the
# network; none of that needs kernel isolation, and a container starts in a second and
# costs a few hundred megabytes. The one thing containers are genuinely worse at is
# multicast, which matters here — see FlexRadio discovery below.
#
# Idempotent in the ways that matter: it refuses to touch an existing CTID rather than
# reconfiguring it, and re-running the in-container install is safe because install.sh is.
#
# NOT a hardened production deployment. It gives the container a root password you set,
# runs DigiShack as root inside it, and exposes HTTP without TLS. For anything reachable
# from outside the shack LAN, put the NGINX config in deploy/nginx in front of it.

set -euo pipefail

# --------------------------------------------------------------------- defaults
CTID=""
HOSTNAME_="digishack"
# SIZED FROM A CONTAINER THAT RAN UNDERSIZED FOR A MONTH, not from a guess. At 2 cores /
# 2 GB the reference install measured: FT8 decode passes of 2.4-2.8 s against a 2.4 s
# budget (late decodes become late replies, which cost whole 30 s cycles), first calls
# landing 1.0-1.7 s late from CPU contention, and `next build` OOM-killed after it had
# already deleted the previous output - which is a downed site, not a slow one. Raising
# that container to 4+ cores and 4+ GB is what ended it.
#
# 2 cores / 2 GB still RUNS - decode fits most passes and 1 GB builds crawl through - so
# the minimums stay documented below, but they are a floor, not a recommendation.
CORES=4
MEMORY=4096        # MB. `next build` peaks past 1.5 GB ALONGSIDE the running app; 2048
                   # is the measured floor where a rebuild can OOM while the site serves.
DISK=12            # GB. The log itself is small; decode CSVs are what grow.
BRIDGE="vmbr0"
STORAGE=""         # auto-detected below
TEMPLATE_STORAGE="local"
REPO="https://github.com/W9MDM/DigiShack.git"
BRANCH="main"
TIMEZONE="$(cat /etc/timezone 2>/dev/null || echo UTC)"
DB_PASSWORD=""
ROOT_PASSWORD=""
START_AFTER=1

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --ctid N              Container ID (default: ask, offering Proxmox's next free id)
  --hostname NAME       Container hostname (default: ${HOSTNAME_})
  --cores N             CPU cores (default: ${CORES}; 2 is the measured floor - decode
                        passes take ~2.5 s of a 2.4 s budget there and replies slip cycles)
  --memory MB           RAM in MB (default: ${MEMORY}; below 4096 a rebuild can be
                        OOM-killed while the site is serving)
  --disk GB             Root disk in GB (default: ${DISK})
  --bridge NAME         Network bridge (default: ${BRIDGE})
  --storage NAME        Container storage (default: auto-detect)
  --repo URL            Git remote to clone (default: the public GitHub remote)
  --branch NAME         Branch to check out (default: ${BRANCH})
  --db-password PASS    MariaDB password for the digishack user (default: generated)
  --root-password PASS  Container root password (default: generated and printed)
  --no-start            Create the container but do not start or install
  -h, --help            This text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ctid) CTID="$2"; shift 2 ;;
    --hostname) HOSTNAME_="$2"; shift 2 ;;
    --cores) CORES="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --disk) DISK="$2"; shift 2 ;;
    --bridge) BRIDGE="$2"; shift 2 ;;
    --storage) STORAGE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --db-password) DB_PASSWORD="$2"; shift 2 ;;
    --root-password) ROOT_PASSWORD="$2"; shift 2 ;;
    --no-start) START_AFTER=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

# --------------------------------------------------------------------- output
if [ -t 1 ]; then
  R='\033[0;31m'; G='\033[0;32m'; Y='\033[0;33m'; B='\033[1m'; N='\033[0m'
else
  R=''; G=''; Y=''; B=''; N=''
fi
step() { printf "\n${B}==> %s${N}\n" "$1"; }
ok()   { printf "    ${G}ok${N}   %s\n" "$1"; }
warn() { printf "    ${Y}warn${N} %s\n" "$1"; }
die()  { printf "    ${R}fail${N} %s\n" "$1" >&2; exit 1; }

# --------------------------------------------------------------------- host checks
step "Checking the Proxmox host"

command -v pct >/dev/null 2>&1 || die "pct not found — run this ON the Proxmox host, not inside a container"
command -v pvesm >/dev/null 2>&1 || die "pvesm not found — is this Proxmox VE?"
[ "$(id -u)" -eq 0 ] || die "must run as root on the Proxmox host"
ok "Proxmox VE tools present"

gen_pw() { openssl rand -base64 24 | tr -d '/+=' | cut -c1-20; }
[ -n "$DB_PASSWORD" ] || DB_PASSWORD="$(gen_pw)"
[ -n "$ROOT_PASSWORD" ] || { ROOT_PASSWORD="$(gen_pw)"; GENERATED_ROOT_PW=1; }

# Container ID.
#
# Proxmox knows which id is next and this asks IT rather than guessing, because a hand-
# rolled scan is wrong in two ways that matter on a real host: it only sees this node, so on
# a cluster it can pick an id another node has already taken, and it cannot see ids reserved
# but not yet created. `pvesh get /cluster/nextid` is the same call the web UI makes.
#
# The scan is kept only as a fallback for a host where pvesh is unavailable.
suggest_ctid() {
  local id
  id="$(pvesh get /cluster/nextid 2>/dev/null | tr -dc '0-9')"
  if [ -n "$id" ]; then
    printf '%s' "$id"
    return
  fi
  id=200
  while pct status "$id" >/dev/null 2>&1 || qm status "$id" >/dev/null 2>&1; do
    id=$((id + 1))
  done
  printf '%s' "$id"
}

if [ -z "$CTID" ]; then
  SUGGESTED="$(suggest_ctid)"
  # Ask, when there is somebody to ask. Creating a container is not reversible in the way a
  # config change is, and an operator who has a numbering convention should not have to
  # discover after the fact that this ignored it. Enter accepts the suggestion.
  if [ -t 0 ]; then
    printf "Container ID to use [%s]: " "$SUGGESTED"
    read -r CTID_INPUT || CTID_INPUT=""
    CTID="${CTID_INPUT:-$SUGGESTED}"
  else
    # No terminal — a pipe, or cloud-init. Take Proxmox's answer and say so.
    CTID="$SUGGESTED"
    ok "no terminal to prompt on; using Proxmox's next id ${CTID}"
  fi
fi

case "$CTID" in
  ''|*[!0-9]*) die "container ID must be a number, got '${CTID}'" ;;
esac
[ "$CTID" -ge 100 ] 2>/dev/null || die "container ID must be 100 or higher (Proxmox reserves below that)"

if pct status "$CTID" >/dev/null 2>&1 || qm status "$CTID" >/dev/null 2>&1; then
  die "ID ${CTID} is already in use — pick another, or destroy it first with: pct destroy ${CTID}"
fi
ok "using CTID ${CTID}"

# Storage that can actually hold a container root filesystem.
if [ -z "$STORAGE" ]; then
  STORAGE="$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}')"
  [ -n "$STORAGE" ] || die "no active storage accepts container rootdir — pass --storage"
  ok "storage ${STORAGE}"
else
  ok "storage ${STORAGE} (as given)"
fi

# --------------------------------------------------------------------- template
step "Debian 12 template"

TEMPLATE="$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk '/debian-12-standard/ {print $1; exit}')"
if [ -z "$TEMPLATE" ]; then
  warn "not downloaded yet — fetching"
  pveam update >/dev/null 2>&1 || warn "pveam update failed; trying the cached index"
  AVAILABLE="$(pveam available --section system | awk '/debian-12-standard/ {print $2; exit}')"
  [ -n "$AVAILABLE" ] || die "no debian-12-standard template available from pveam"
  pveam download "$TEMPLATE_STORAGE" "$AVAILABLE"
  TEMPLATE="${TEMPLATE_STORAGE}:vztmpl/${AVAILABLE}"
fi
ok "${TEMPLATE}"

# --------------------------------------------------------------------- create
step "Creating the container"

# Unprivileged, with nesting on. Nesting is needed because the install runs systemd
# services (MariaDB) inside the container.
pct create "$CTID" "$TEMPLATE" \
  --hostname "$HOSTNAME_" \
  --cores "$CORES" \
  --memory "$MEMORY" \
  --swap 512 \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  --unprivileged 1 \
  --features nesting=1 \
  --onboot 1 \
  --timezone "$TIMEZONE" \
  --password "$ROOT_PASSWORD" \
  --description "DigiShack — amateur radio logging and FT8/FT4 operating" \
  >/dev/null
ok "container ${CTID} created (${CORES} cores, ${MEMORY} MB, ${DISK} GB)"

if [ "$START_AFTER" -eq 0 ]; then
  printf "\n${Y}Created but not started (--no-start).${N}\n"
  printf "  Start it with:   pct start %s\n" "$CTID"
  printf "  Root password:   %s\n\n" "$ROOT_PASSWORD"
  exit 0
fi

pct start "$CTID" >/dev/null
ok "started"

# Wait for the network. DHCP plus systemd takes a few seconds, and every command below
# needs DNS.
step "Waiting for the network"
for i in $(seq 1 30); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then
    ok "DNS resolves after ${i}s"
    break
  fi
  sleep 1
  [ "$i" -lt 30 ] || die "no network in the container after 30s — check bridge ${BRIDGE} and DHCP"
done

# --------------------------------------------------------------------- inside
step "Installing inside the container (this takes a few minutes)"

# One heredoc, run as a script inside the container. Written to a file rather than piped
# so a failure reports a line number that means something.
pct exec "$CTID" -- bash -c 'cat > /root/digishack-bootstrap.sh' <<BOOTSTRAP
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "==> apt update and base packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates git build-essential mariadb-server openssl >/dev/null

echo "==> Node 20 (NodeSource)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

echo "==> PM2"
npm install -g pm2 >/dev/null 2>&1

echo "==> MariaDB"
systemctl enable --now mariadb >/dev/null 2>&1
# Idempotent: CREATE ... IF NOT EXISTS, and the grant is re-applied harmlessly.
mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS digishack CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'digishack'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER 'digishack'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON digishack.* TO 'digishack'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "==> Fetching DigiShack"
if [ -d /opt/digishack/.git ]; then
  git -C /opt/digishack fetch --quiet origin
  git -C /opt/digishack checkout --quiet "${BRANCH}"
  git -C /opt/digishack pull --quiet --ff-only
else
  git clone --quiet --branch "${BRANCH}" "${REPO}" /opt/digishack
fi
cd /opt/digishack

echo "==> .env"
# install.sh creates .env from the example and generates SETTINGS_KEY, but it cannot
# know the database password. Write DATABASE_URL first so it does not stop and ask.
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
fi
if grep -qE '^\s*DATABASE_URL' .env; then
  sed -i "s#^\s*DATABASE_URL.*#DATABASE_URL=\"mysql://digishack:${DB_PASSWORD}@127.0.0.1:3306/digishack\"#" .env
else
  echo "DATABASE_URL=\"mysql://digishack:${DB_PASSWORD}@127.0.0.1:3306/digishack\"" >> .env
fi

echo "==> Handing over to scripts/install.sh"
# The same installer a bare-metal install uses: dependencies, migrations, build, PM2.
# One install path, so there is only one thing to keep working.
bash scripts/install.sh

echo "==> PM2 at boot"
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
pm2 save >/dev/null 2>&1 || true
BOOTSTRAP

pct exec "$CTID" -- bash /root/digishack-bootstrap.sh
ok "install finished"

# --------------------------------------------------------------------- report
IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
IP="${IP:-<no address yet>}"

printf "\n${G}${B}DigiShack is installed in container %s.${N}\n\n" "$CTID"
printf "  Web:            http://%s:3000  (first visit goes to /setup)\n" "$IP"
printf "  Shell:          pct enter %s\n" "$CTID"
printf "  Logs:           pct exec %s -- pm2 logs\n" "$CTID"
printf "  App directory:  /opt/digishack\n"
printf "  Upgrade later:  pct exec %s -- bash -c 'cd /opt/digishack && ./scripts/update.sh'\n\n" "$CTID"

printf "${B}Credentials${N} — store these somewhere; they are not written down anywhere else:\n"
if [ "${GENERATED_ROOT_PW:-0}" = "1" ]; then
  printf "  container root:   %s\n" "$ROOT_PASSWORD"
fi
printf "  MariaDB digishack: %s\n\n" "$DB_PASSWORD"

printf "${B}Two things specific to running this in a container${N}\n\n"

printf "  ${Y}1. The clock is the host's clock, and FT8 cares.${N}\n"
printf "     A container cannot set its own time. FT8 tolerates roughly a second of\n"
printf "     error, so if the host's clock drifts, decoding degrades and nobody decodes\n"
printf "     you — a failure that reads exactly like a dead band. Fix NTP on the\n"
printf "     PROXMOX HOST, not in here:\n"
printf "       timedatectl set-ntp true && timedatectl status\n\n"

printf "  ${Y}2. FlexRadio discovery uses multicast, which containers are bad at.${N}\n"
printf "     Auto-discovery may well not see the radio. Set the address explicitly in\n"
printf "     Settings -> FlexRadio (flex.host) and leave discovery off. A networked\n"
printf "     Icom is unaffected: it is plain unicast UDP to an address you configure.\n\n"

printf "  Then: Settings -> Digital -> Decode source (flex / icom / wsjtx), and read\n"
printf "  docs/getting-started.md. If you are using an Icom, read docs/icom.md first —\n"
printf "  one setting in the radio's own menu will otherwise cost you an evening.\n\n"
