#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { printf 'Run this installer as root.\n' >&2; exit 1; }
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
id safehouse >/dev/null
install -d -o safehouse -g safehouse -m 700 /var/lib/safehouse/maintenance
install -d -o root -g safehouse -m 750 /var/lib/safehouse-maintenance
install -o root -g root -m 700 kernel-cache-helper.py /usr/local/sbin/safehouse-kernel-cache-helper
printf '{"version":1,"cooldownSeconds":300}\n' > /var/lib/safehouse-maintenance/installed.json
chown root:safehouse /var/lib/safehouse-maintenance/installed.json
chmod 640 /var/lib/safehouse-maintenance/installed.json
cat > /etc/systemd/system/safehouse-kernel-cache.service <<'EOF'
[Unit]
Description=Fixed SAFEHOUSE Linux file-cache reclamation action
[Service]
Type=oneshot
User=root
ExecStart=/usr/local/sbin/safehouse-kernel-cache-helper
TimeoutStartSec=45
UMask=0027
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
RestrictAddressFamilies=AF_UNIX
ReadWritePaths=/var/lib/safehouse-maintenance /var/lib/safehouse/maintenance /proc/sys/vm/drop_caches
MemoryMax=64M
EOF
cat > /etc/systemd/system/safehouse-kernel-cache.path <<'EOF'
[Unit]
Description=Watch for an owner-authorized SAFEHOUSE cache reclamation request
[Path]
PathExists=/var/lib/safehouse/maintenance/kernel-cache.request
Unit=safehouse-kernel-cache.service
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now safehouse-kernel-cache.path
printf 'Installed fixed-action Linux cache helper; panel remains unprivileged.\n'
