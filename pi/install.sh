#!/usr/bin/env bash
# Aurevia Pi installer. The app (Me tab) shows the exact command to run, with your server and repo filled in.
set -euo pipefail

REPO="${AUREVIA_REPO:-}"
DIR="${AUREVIA_DIR:-$HOME/aurevia}"
SERVER="${AUREVIA_SERVER:-}"
[ -n "$REPO" ] || { echo "Set AUREVIA_REPO=https://github.com/OWNER/aurevia.git (the app shows the full command)."; exit 1; }

if [ -z "$SERVER" ]; then
  [ -r /dev/tty ] || { echo "Set AUREVIA_SERVER=https://your-server and run again."; exit 1; }
  read -rp "Aurevia server address (e.g. https://aurevia.example.com): " SERVER </dev/tty
fi
SERVER="${SERVER%/}"
case "$SERVER" in http://*|https://*) ;; *) echo "Server address must start with http:// or https://"; exit 1;; esac

echo "== 1/5 System packages"
sudo apt-get update
sudo apt-get install -y git python3-venv python3-dev build-essential i2c-tools

echo "== 2/5 Enable I2C and 1-Wire (for the sensors)"
sudo raspi-config nonint do_i2c 0 || true
sudo raspi-config nonint do_onewire 0 || true

echo "== 3/5 Download Aurevia"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$DIR"; fi

echo "== 4/5 Python libraries"
cd "$DIR/pi"
python3 -m venv venv
./venv/bin/pip install --quiet -r requirements.txt

echo "== 5/5 Start on boot"
mkdir -p "$HOME/.aurevia"
[ -f "$HOME/.aurevia/aurevia.env" ] || cat > "$HOME/.aurevia/aurevia.env" <<ENV
AUREVIA_SERVER=$SERVER
# Calibration (see README): uncomment and edit after measuring your sensors.
#MOIST_DRY_V=2.60
#MOIST_WET_V=1.20
#PH_V7=2.50
#PH_V4=3.04
#ML_PER_SEC=5
#PUMP_PIN=17
#PUMP_ACTIVE_LOW=1
ENV
sed "s#__USER__#$(whoami)#g; s#__DIR__#$DIR#g; s#__HOME__#$HOME#g" aurevia-pi.service | sudo tee /etc/systemd/system/aurevia-pi.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now aurevia-pi

echo
echo "Installed. Your pairing code appears in a few seconds:"
sleep 8
journalctl -u aurevia-pi -n 15 --no-pager | grep -A4 "PAIRING CODE" || echo "Run:  journalctl -u aurevia-pi -f"
echo
echo "Then open $SERVER > Me > Connect device and type the code."
echo "(If you just enabled I2C/1-Wire for the first time, reboot once: sudo reboot)"
