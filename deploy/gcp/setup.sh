#!/usr/bin/env bash
# One-time: a static IP, a firewall rule for 80/443 and an e2-medium VM that installs Docker and 4 GB of swap.
# deploy/gcp/setup.sh [vm] [zone]   (needs `gcloud auth login` and a project with billing or trial credit)
set -euo pipefail
vm="${1:-swarm}"
zone="${2:-us-central1-a}"
region="${zone%-*}"

gcloud services enable compute.googleapis.com
gcloud compute addresses describe "$vm-ip" --region "$region" >/dev/null 2>&1 \
  || gcloud compute addresses create "$vm-ip" --region "$region"
ip="$(gcloud compute addresses describe "$vm-ip" --region "$region" --format='value(address)')"
gcloud compute firewall-rules describe allow-web >/dev/null 2>&1 \
  || gcloud compute firewall-rules create allow-web --allow tcp:80,tcp:443 --target-tags web

gcloud compute instances create "$vm" --zone "$zone" --machine-type e2-medium \
  --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud --boot-disk-size 30GB \
  --address "$ip" --tags web --metadata startup-script='#!/bin/bash
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi'

# sslip.io resolves 1-2-3-4.sslip.io to 1.2.3.4: a free hostname, so Caddy can get a certificate.
echo "VM $vm is at $ip  →  https://${ip//./-}.sslip.io"
