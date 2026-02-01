#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BIN_NAME="peertopeervideo-server-android"
BIN_PATH="${ROOT_DIR}/${BIN_NAME}"
CERT_FILE="${ROOT_DIR}/server.crt"
KEY_FILE="${ROOT_DIR}/server.key"

if [ ! -x "${BIN_PATH}" ]; then
  echo "Binary not found or not executable: ${BIN_PATH}"
  echo "Build with: make build-android"
  exit 1
fi

LOG_DIR="${TMPDIR:-/tmp}"
if [ ! -w "${LOG_DIR}" ]; then
  LOG_DIR="${HOME}/tmp"
  mkdir -p "${LOG_DIR}"
fi

LOG_FILE="${LOG_DIR}/peertopeervideo.log"
MAX_BYTES=$((5 * 1024 * 1024))
MAX_FILES=5

rotate_logs() {
  if [ -f "${LOG_FILE}" ]; then
    size=$(wc -c < "${LOG_FILE}" | tr -d ' ')
    if [ "${size}" -ge "${MAX_BYTES}" ]; then
      ts=$(date +"%Y%m%d-%H%M%S")
      mv "${LOG_FILE}" "${LOG_FILE}.${ts}"
    fi
  fi

  # Keep only the most recent rotated logs.
  ls -t "${LOG_FILE}."* 2>/dev/null | tail -n +"$((MAX_FILES + 1))" | xargs -r rm -f
}

rotate_logs

if [ -f "${CERT_FILE}" ] && [ -f "${KEY_FILE}" ]; then
  export TLS_CERT="${CERT_FILE}"
  export TLS_KEY="${KEY_FILE}"
  echo "Using TLS cert ${CERT_FILE} and key ${KEY_FILE}"
fi

echo "Starting server, logging to ${LOG_FILE}"
nohup "${BIN_PATH}" >> "${LOG_FILE}" 2>&1 &
echo "PID: $!"
