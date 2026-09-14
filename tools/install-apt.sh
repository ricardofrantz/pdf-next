#!/bin/sh
# Add the pdf-next apt repository and install the package.
# Run as root: curl -fsSL https://raw.githubusercontent.com/ricardofrantz/pdf-next/main/tools/install-apt.sh | sudo sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "run this as root (sudo sh)" >&2
  exit 1
fi

install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://ricardofrantz.github.io/pdf-next/pdf-next.asc \
  | tee /etc/apt/keyrings/pdf-next.asc >/dev/null
echo "deb [signed-by=/etc/apt/keyrings/pdf-next.asc] https://ricardofrantz.github.io/pdf-next stable main" \
  >/etc/apt/sources.list.d/pdf-next.list
apt-get update
apt-get install -y pdf-next
echo "pdf-next is installed."
