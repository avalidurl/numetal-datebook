#!/usr/bin/env bash
# Ishtar (datebook matchmaker) VPS bootstrap — Hetzner + Tailscale + OpenClaw, hardened.
# Adapted from the intel-vps bootstrap; canonical for Ishtar's box.
# Design: ~/Obsidian/zettelkasten/projects/numetal/ishtar/  (datebook-v0-architecture.md, inference-economics.md)
#
# Zone A box (PUBLIC, adversarial agent): NO wallet-capable keys, EVER.
# Only scoped model keys + read-only data keys. Ishtar reads untrusted agent/web content by design.
#
# Usage (as root on fresh Ubuntu 24.04 / Debian 12):
#   bash bootstrap.sh setup                          # phase 1: packages, user, tailscale, node, docker, openclaw
#   tailscale up --ssh --hostname=ishtar             # interactive (browser auth) — run yourself
#   # ...verify `ssh ishtar` works from the Mac over the tailnet, THEN:
#   bash bootstrap.sh lockdown                       # phase 2: ufw deny-all-in, sshd hardening, enable service
set -euo pipefail

AGENT_USER="${AGENT_USER:-ishtar}"
TS_HOSTNAME="${TS_HOSTNAME:-ishtar}"
GATEWAY_PORT="18789"
NODE_MAJOR="22"

phase="${1:-}"
[[ "$phase" == "setup" || "$phase" == "lockdown" ]] || { echo "usage: bootstrap.sh setup|lockdown"; exit 1; }
[[ "$(id -u)" -eq 0 ]] || { echo "run as root"; exit 1; }

# ---------------------------------------------------------------- setup
if [[ "$phase" == "setup" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y && apt-get upgrade -y
  apt-get install -y curl git ca-certificates ufw unattended-upgrades openssl

  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

  id "$AGENT_USER" &>/dev/null || adduser --disabled-password --gecos "" "$AGENT_USER"

  command -v tailscale &>/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
  command -v docker &>/dev/null || curl -fsSL https://get.docker.com | sh
  usermod -aG docker "$AGENT_USER"

  if ! command -v node &>/dev/null || [[ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  fi
  npm install -g openclaw@latest

  # Hardened config: loopback bind, token auth, docker sandbox (all/agent),
  # workspaceAccess NONE (Ishtar reads adversarial content — tools never touch the workspace),
  # host-mutation tool groups denied. Provider/model (scoped LLM-only key) added later.
  CFG_DIR="/home/${AGENT_USER}/.openclaw"
  CFG="${CFG_DIR}/openclaw.json"
  if [[ ! -f "$CFG" ]]; then
    mkdir -p "$CFG_DIR"
    TOKEN="$(openssl rand -hex 32)"
    cat >"$CFG" <<EOF
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "auth": { "mode": "token", "token": "${TOKEN}" }
  },
  "agents": {
    "defaults": {
      "sandbox": { "mode": "all", "scope": "agent", "workspaceAccess": "none" }
    }
  },
  "tools": { "deny": ["group:automation", "group:runtime", "group:fs"] }
}
EOF
    chown -R "${AGENT_USER}:${AGENT_USER}" "$CFG_DIR"
    chmod 700 "$CFG_DIR"; chmod 600 "$CFG"
  fi

  cat >/etc/systemd/system/openclaw.service <<EOF
[Unit]
Description=OpenClaw gateway (Ishtar — datebook matchmaker)
After=network-online.target tailscaled.service docker.service
Wants=network-online.target

[Service]
User=${AGENT_USER}
ExecStart=$(command -v openclaw) gateway --port ${GATEWAY_PORT}
Restart=always
RestartSec=5
Environment=NODE_ENV=production
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload

  cat <<'NEXT'

== setup done — DO THESE IN ORDER ==
1. tailscale up --ssh --hostname=ishtar          (browser auth)
2. Attach a Hetzner Cloud Firewall with ZERO inbound rules (done via hcloud from the Mac)
3. From the Mac, verify:  ssh ishtar              (tailnet / MagicDNS)
4. bash bootstrap.sh lockdown
NEXT
fi

# ------------------------------------------------------------- lockdown
if [[ "$phase" == "lockdown" ]]; then
  tailscale status &>/dev/null || { echo "tailscale not up — aborting lockdown"; exit 1; }

  ufw default deny incoming
  ufw default allow outgoing
  ufw allow in on tailscale0
  ufw --force enable

  cat >/etc/ssh/sshd_config.d/99-ishtar-hardening.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin no
AllowTcpForwarding local
EOF
  systemctl restart ssh || systemctl restart sshd

  systemctl enable --now openclaw

  cat <<'DONE'

== locked down ==
- Inbound: cloud firewall (zero rules) + ufw deny-in; access = tailnet only.
- Next (as the ishtar user, over tailnet):
  1. Scoped model key (NO wallet-capable key, NO transaction key).
  2. Wire it into openclaw.json provider/model (Flash-class default; strong model for gambits/rationale).
  3. Squid egress allowlist (deny-by-default): api.openai.com, .anthropic.com,
     .numetal.xyz, .workers.dev, .slack.com, api.cdp.coinbase.com, x402.org
     -> the inference-router/x402 exits.
  4. systemctl restart openclaw
  5. tailscale serve --bg --https=443 http://127.0.0.1:18789  -> UI tailnet-only (NEVER funnel)
  6. openclaw security audit
DONE
fi
