#!/usr/bin/env bash
# Ship the last commit to the VM and rebuild: deploy/gcp/deploy.sh [vm] [zone]
# Only committed files are sent; the VM keeps its own .env in /opt/swarm/.env.
set -euo pipefail
vm="${1:-swarm}"
zone="${2:-us-central1-a}"
root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git -C "$root" archive --format=tar.gz -o "$tmp/app.tgz" HEAD
gcloud compute scp "$tmp/app.tgz" "$vm:/tmp/app.tgz" --zone "$zone"
gcloud compute ssh "$vm" --zone "$zone" --command 'set -e
  sudo rm -rf /opt/swarm/next && sudo mkdir -p /opt/swarm/next && sudo tar -xzf /tmp/app.tgz -C /opt/swarm/next
  sudo cp /opt/swarm/.env /opt/swarm/next/deploy/gcp/.env
  sudo rm -rf /opt/swarm/app && sudo mv /opt/swarm/next /opt/swarm/app
  cd /opt/swarm/app/deploy/gcp && sudo docker compose up -d --build --remove-orphans && sudo docker image prune -f >/dev/null'
echo "deployed $(git -C "$root" rev-parse --short HEAD)"
