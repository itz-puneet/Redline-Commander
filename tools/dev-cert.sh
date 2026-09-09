#!/usr/bin/env bash
#
# Generates a self-signed certificate for testing wss:// locally.
#
#   tools/dev-cert.sh [output-dir]     defaults to server/.state/dev-cert
#
# FOR DEVELOPMENT ONLY. A self-signed certificate proves nothing about who
# the server is, so browsers and the Godot client both reject it unless told
# to trust this exact certificate. For a real deployment use a certificate
# from a CA - Let's Encrypt is free - or terminate TLS at a reverse proxy.
# See docs/DEPLOYMENT.md.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${1:-$repo_root/server/.state/dev-cert}"
host="${REDLINE_CERT_HOST:-localhost}"

if ! command -v openssl >/dev/null 2>&1; then
  echo "dev-cert: openssl is not installed" >&2
  exit 1
fi

mkdir -p "$out_dir"

# stderr is kept: discarding it under `set -e` meant an OpenSSL too old for
# -addext, or a hostname openssl would not accept, aborted the script with no
# explanation at all - and live-check.sh discards this script's stdout too.
if ! openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$out_dir/key.pem" \
  -out "$out_dir/cert.pem" \
  -days 365 \
  -subj "/CN=$host" \
  -addext "subjectAltName=DNS:$host,DNS:localhost,IP:127.0.0.1"
then
  echo "dev-cert: openssl failed (see the error above)." >&2
  echo "dev-cert: -addext needs OpenSSL 1.1.1 or newer; yours is:" >&2
  openssl version >&2 || true
  exit 1
fi

chmod 600 "$out_dir/key.pem"

echo "dev-cert: wrote $out_dir/cert.pem and key.pem (CN=$host, 365 days)"
echo
echo "Run the server with TLS:"
echo "  REDLINE_TLS_CERT=$out_dir/cert.pem \\"
echo "  REDLINE_TLS_KEY=$out_dir/key.pem \\"
echo "  npm start"
echo
echo "The client must be told to trust this certificate - it is not signed by"
echo "any CA. See Net.trust_certificate_file() and docs/DEPLOYMENT.md."
