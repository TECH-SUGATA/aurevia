#!/usr/bin/env python3
"""Aurevia Raspberry Pi client.

First run: registers this Pi with the Aurevia server and shows a pairing code.
Type that code in the Aurevia app (Me tab) to link the Pi to your account.
After that it sends sensor readings and runs the pump when the server asks.

    python3 aurevia_pi.py              # real hardware
    python3 aurevia_pi.py --simulate   # fake sensors (no GPIO needed)
    python3 aurevia_pi.py --reset      # forget the pairing and start over
"""
import argparse, glob, json, os, random, statistics, threading, time, urllib.error, urllib.request

SERVER = os.getenv("AUREVIA_SERVER", "").rstrip("/")
CONF_DIR = os.path.expanduser(os.getenv("AUREVIA_HOME", "~/.aurevia"))
CONF = os.path.join(CONF_DIR, "device.json")
INTERVAL = int(os.getenv("INTERVAL", "10"))

PUMP_PIN = int(os.getenv("PUMP_PIN", "17"))               # BCM number (physical pin 11)
PUMP_ACTIVE_LOW = os.getenv("PUMP_ACTIVE_LOW", "1") == "1"  # most relay boards switch ON with LOW
ML_PER_SEC = float(os.getenv("ML_PER_SEC", "5"))          # measure your pump: ml delivered per second
MAX_PUMP_SECONDS = 60                                     # safety cap per watering

MOIST_DRY_V = float(os.getenv("MOIST_DRY_V", "2.60"))     # sensor in open air
MOIST_WET_V = float(os.getenv("MOIST_WET_V", "1.20"))     # sensor in a glass of water
PH_V7 = float(os.getenv("PH_V7", "2.50"))                 # voltage in pH 7.00 buffer
PH_V4 = float(os.getenv("PH_V4", "3.04"))                 # voltage in pH 4.00 buffer


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Hardware:
    def __init__(self):
        import board, busio
        import adafruit_ads1x15.ads1115 as ADS
        from adafruit_ads1x15.analog_in import AnalogIn
        from gpiozero import OutputDevice
        ads = ADS.ADS1115(busio.I2C(board.SCL, board.SDA))
        self.moist = AnalogIn(ads, ADS.P0)   # soil moisture sensor on A0
        self.ph = AnalogIn(ads, ADS.P1)      # pH module on A1
        self.relay = OutputDevice(PUMP_PIN, active_high=not PUMP_ACTIVE_LOW, initial_value=False)
        self.lock = threading.Lock()

    @staticmethod
    def _median(chan, n=7):
        vals = []
        for _ in range(n):
            vals.append(chan.voltage)
            time.sleep(0.05)
        return statistics.median(vals)

    def read(self):
        m = (MOIST_DRY_V - self._median(self.moist)) / (MOIST_DRY_V - MOIST_WET_V) * 100
        volt_per_ph = (PH_V4 - PH_V7) / 3
        ph = 7 - (self._median(self.ph) - PH_V7) / volt_per_ph
        files = glob.glob("/sys/bus/w1/devices/28-*/w1_slave")
        if not files:
            raise RuntimeError("DS18B20 not found. Enable 1-Wire and check wiring.")
        raw = open(files[0]).read()
        if "YES" not in raw:
            raise RuntimeError("DS18B20 CRC error")
        t = int(raw.split("t=")[-1]) / 1000
        return {"moisture": round(min(100, max(0, m)), 1), "temperature": round(t, 1), "ph": round(min(14, max(0, ph)), 2)}

    def pump(self, seconds):
        if not self.lock.acquire(blocking=False):
            return  # already watering
        try:
            log(f"Pump ON for {seconds:.0f}s")
            self.relay.on()
            time.sleep(seconds)
        finally:
            self.relay.off()
            self.lock.release()
            log("Pump OFF")

    def close(self):
        self.relay.off()


class Simulator:
    def __init__(self):
        self.m, self.t, self.ph = 62.0, 24.0, 6.4

    def read(self):
        self.m = max(15, self.m - random.uniform(0.2, 1.5))
        self.t = min(32, max(18, self.t + random.uniform(-.4, .4)))
        self.ph = min(7.4, max(5.6, self.ph + random.uniform(-.05, .05)))
        return {"moisture": round(self.m, 1), "temperature": round(self.t, 1), "ph": round(self.ph, 2)}

    def pump(self, seconds):
        log(f"[sim] Pump ON for {seconds:.0f}s")
        self.m += 25

    def close(self):
        pass


def request(path, body=None, token=None):
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(SERVER + "/api" + path, data=json.dumps(body or {}).encode(), method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def show_code(code):
    pretty = f"{code[:4]}-{code[4:]}"
    print("\n" + "=" * 46, f"  PAIRING CODE:  {pretty}",
          "  Open Aurevia > Me > enter this code.", f"  Server: {SERVER}", "=" * 46 + "\n", sep="\n", flush=True)


def load_conf():
    try:
        return json.load(open(CONF))
    except (OSError, ValueError):
        return {}


def save_conf(conf):
    os.makedirs(CONF_DIR, exist_ok=True)
    with open(CONF, "w") as f:
        json.dump(conf, f)
    os.chmod(CONF, 0o600)


def main():
    global SERVER
    ap = argparse.ArgumentParser()
    ap.add_argument("--simulate", action="store_true", help="use fake sensors")
    ap.add_argument("--once", action="store_true", help="send one reading and exit")
    ap.add_argument("--reset", action="store_true", help="forget the pairing and exit")
    args = ap.parse_args()

    if args.reset:
        if os.path.exists(CONF):
            os.remove(CONF)
        print("Pairing removed. Run again to get a new code.")
        return
    conf = load_conf()
    SERVER = SERVER or conf.get("server", "")
    if not SERVER:
        raise SystemExit("Set AUREVIA_SERVER, e.g. AUREVIA_SERVER=https://aurevia.example.com")

    hw = Simulator() if args.simulate else Hardware()
    log("Aurevia Pi client started", "(simulation)" if args.simulate else "", "->", SERVER)
    shown, claimed_before = None, False
    try:
        while True:
            try:
                if not conf.get("token") or conf.get("server") != SERVER:
                    reg = request("/device/register")
                    conf = {"server": SERVER, "token": reg["device_token"]}
                    save_conf(conf)
                    shown = None
                reading = hw.read()
                res = request("/device/readings", reading, conf["token"])
                if not res.get("claimed"):
                    if res["pairing_code"] != shown:
                        shown = res["pairing_code"]
                        show_code(shown)
                else:
                    if not claimed_before:
                        log("Paired with your Aurevia account.")
                        claimed_before = True
                    log(reading, res["health"]["label"])
                    pump = res.get("pump", {})
                    if pump.get("run"):
                        secs = min(pump["ml"] / ML_PER_SEC, MAX_PUMP_SECONDS)
                        threading.Thread(target=hw.pump, args=(secs,), daemon=True).start()
            except urllib.error.HTTPError as e:
                if e.code in (401, 410):  # removed in the app: start over with a fresh code
                    log("This Pi was removed from your account. Requesting a new pairing code.")
                    conf, claimed_before = {}, False
                else:
                    log("Server error:", e.code)
            except (urllib.error.URLError, OSError) as e:
                log("Server unreachable, will retry:", e)
            except Exception as e:  # sensor problem: never send bad data
                log("Sensor error:", e)
            if args.once:
                break
            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        pass
    finally:
        hw.close()


if __name__ == "__main__":
    main()
