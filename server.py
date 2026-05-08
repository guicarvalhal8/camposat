import argparse
import copy
import json
import shutil
from datetime import datetime, timedelta
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SEED_PATH = DATA_DIR / "seed_state.json"
STATE_PATH = DATA_DIR / "state.json"


def now_label():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def ensure_state_file():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not STATE_PATH.exists():
        shutil.copyfile(SEED_PATH, STATE_PATH)


def load_seed_state():
    return json.loads(SEED_PATH.read_text(encoding="utf-8"))


def load_state():
    ensure_state_file()
    return json.loads(STATE_PATH.read_text(encoding="utf-8"))


def save_state(state):
    state["meta"]["lastUpdated"] = now_label()
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


class MockWeatherProvider:
    def generate(self, plot, status, ndvi):
        base_temp = 25 if plot["crop"] == "Soja" else 27
        rain = 14 if status == "green" else 5 if status == "yellow" else 1
        humidity = 81 if status == "green" else 66 if status == "yellow" else 54
        wind = 7 if status == "green" else 12 if status == "yellow" else 15
        return {
            "tempC": round(base_temp + (0.6 - ndvi) * 10, 1),
            "rainMm": rain,
            "humidity": humidity,
            "windKmh": wind
        }


class MockMarketProvider:
    def snapshot(self, current_market):
        market = copy.deepcopy(current_market)
        market["updatedAt"] = now_label()
        return market


class MockWhatsAppProvider:
    def dispatch(self, severity):
        return severity in {"Alta", "Media"}


class MockSatelliteProvider:
    def __init__(self, weather_provider):
        self.weather_provider = weather_provider

    def analyze_plot(self, plot, alert_count):
        latest = plot["snapshots"][-1]
        last_date = datetime.strptime(latest["capturedAt"], "%Y-%m-%d %H:%M")
        captured_at = (last_date + timedelta(days=5)).strftime("%Y-%m-%d %H:%M")
        next_snapshot = copy.deepcopy(latest)
        next_snapshot["id"] = f"SN-{plot['id'].replace('-', '')}-{len(plot['snapshots']) + 1:02d}"
        next_snapshot["capturedAt"] = captured_at
        next_snapshot["sceneId"] = f"S2-DEMO-{plot['id']}-{len(plot['snapshots']) + 1:02d}"
        next_snapshot["cloudCoverage"] = max(2, latest["cloudCoverage"] - 1 if latest["status"] == "green" else latest["cloudCoverage"] + 1)

        if latest["status"] == "red":
            ndvi = max(0.28, round(latest["ndvi"] - 0.03, 2))
            next_snapshot["delta"] = round(ndvi - latest["ndvi"], 2)
            next_snapshot["ndvi"] = ndvi
            next_snapshot["status"] = "red"
            next_snapshot["affectedAreaHa"] = latest["affectedAreaHa"] + 3
            next_snapshot["issue"] = "Nova queda confirmada no setor central com expansao para a borda sul."
            next_snapshot["hotspot"]["radius"] = min(44, latest["hotspot"]["radius"] + 4)
            next_snapshot["hotspot"]["x"] = max(34, latest["hotspot"]["x"] - 2)
            next_snapshot["hotspot"]["label"] = "Hotspot em ampliacao"
        elif latest["status"] == "yellow":
            ndvi = max(0.41, round(latest["ndvi"] - 0.04, 2))
            next_snapshot["delta"] = round(ndvi - latest["ndvi"], 2)
            next_snapshot["ndvi"] = ndvi
            next_snapshot["status"] = "red" if ndvi < 0.52 else "yellow"
            next_snapshot["affectedAreaHa"] = latest["affectedAreaHa"] + (4 if next_snapshot["status"] == "red" else 2)
            next_snapshot["issue"] = (
                "A area em observacao piorou e cruzou o limiar de alerta alto."
                if next_snapshot["status"] == "red"
                else "Persistencia de sinal amarelo no setor sudoeste."
            )
            next_snapshot["hotspot"]["radius"] = min(36, latest["hotspot"]["radius"] + 3)
            next_snapshot["hotspot"]["label"] = "Setor com estresse"
        else:
            ndvi = min(0.87, round(latest["ndvi"] + 0.02, 2))
            next_snapshot["delta"] = round(ndvi - latest["ndvi"], 2)
            next_snapshot["ndvi"] = ndvi
            next_snapshot["status"] = "green"
            next_snapshot["affectedAreaHa"] = max(0, latest["affectedAreaHa"] - 1)
            next_snapshot["issue"] = "Vigor consistente e sem sinais de estresse acima do limiar."
            next_snapshot["hotspot"]["radius"] = max(6, latest["hotspot"]["radius"] - 1)
            next_snapshot["hotspot"]["label"] = "Monitoramento normal"

        next_snapshot["weather"] = self.weather_provider.generate(plot, next_snapshot["status"], next_snapshot["ndvi"])
        return next_snapshot


class ProviderRegistry:
    def __init__(self):
        self.weather = MockWeatherProvider()
        self.market = MockMarketProvider()
        self.whatsapp = MockWhatsAppProvider()
        self.satellite = MockSatelliteProvider(self.weather)


REGISTRY = ProviderRegistry()


def bootstrap_payload(state):
    payload = copy.deepcopy(state)
    payload["market"] = REGISTRY.market.snapshot(state["market"])
    return payload


def next_plot_id(state):
    ids = [int(plot["id"].split("-")[1]) for plot in state["plots"]]
    return f"TL-{max(ids) + 1:02d}"


def next_alert_id(state):
    ids = [int(alert["id"].split("-")[1]) for alert in state["alerts"]]
    return f"AL-{max(ids) + 1}"


def severity_from_status(status):
    if status == "red":
        return "Alta"
    if status == "yellow":
        return "Media"
    return "Baixa"


def append_alert_if_needed(state, plot, snapshot):
    severity = severity_from_status(snapshot["status"])
    if severity == "Baixa":
        return None

    alert_id = next_alert_id(state)
    sent = REGISTRY.whatsapp.dispatch(severity)
    if severity == "Alta":
        summary = f"Queda adicional para NDVI {snapshot['ndvi']:.2f}. Revisar {snapshot['affectedAreaHa']} ha com urgencia."
    else:
        summary = f"Anomalia persistente com NDVI {snapshot['ndvi']:.2f} e foco em {snapshot['affectedAreaHa']} ha."

    alert = {
        "id": alert_id,
        "plotId": plot["id"],
        "plotName": plot["name"],
        "when": snapshot["capturedAt"],
        "severity": severity,
        "sent": sent,
        "summary": summary,
        "snapshotId": snapshot["id"]
    }
    plot["alerts"].insert(0, {
        "id": alert_id,
        "when": snapshot["capturedAt"],
        "severity": severity,
        "sent": sent,
        "summary": summary,
        "snapshotId": snapshot["id"]
    })
    state["alerts"].insert(0, alert)
    return alert


def create_plot(state, payload):
    plot_id = next_plot_id(state)
    crop = payload.get("crop", "Soja")
    center = {
        "lat": float(payload.get("lat", 0)),
        "lon": float(payload.get("lon", 0))
    }
    base_ndvi = 0.72 if crop == "Soja" else 0.68
    initial_weather = REGISTRY.weather.generate(payload, "green", base_ndvi)

    plot = {
        "id": plot_id,
        "name": payload.get("plotName", "").strip(),
        "farmName": payload.get("farmName", "Novo cadastro").strip() or "Novo cadastro",
        "crop": crop,
        "hectares": int(payload.get("hectares", 0)),
        "municipality": payload.get("municipality", "Novo municipio").strip() or "Novo municipio",
        "center": center,
        "coordinatesText": f"{center['lat']:.4f}, {center['lon']:.4f}",
        "agronomist": payload.get("agronomist", "").strip(),
        "whatsapp": payload.get("whatsapp", "").strip(),
        "notes": payload.get("notes", "").strip(),
        "snapshots": [
            {
                "id": f"SN-{plot_id.replace('-', '')}-01",
                "capturedAt": now_label(),
                "ndvi": base_ndvi,
                "delta": 0.0,
                "status": "green",
                "affectedAreaHa": 0,
                "issue": "Primeiro processamento aguardando nova janela do satelite.",
                "cloudCoverage": 11,
                "source": "Sentinel-2 L2A",
                "resolutionM": 10,
                "sceneId": f"S2-DEMO-{plot_id}-01",
                "weather": initial_weather,
                "zones": [
                    {"id": "A1", "fill": "#8cdf8a", "stroke": "#d8ffd8"},
                    {"id": "A2", "fill": "#80d88d", "stroke": "#cfffd3"},
                    {"id": "A3", "fill": "#93dd97", "stroke": "#dbffe0"},
                    {"id": "A4", "fill": "#7fd786", "stroke": "#ceffd0"}
                ],
                "hotspot": {"x": 68, "y": 52, "radius": 8, "label": "Sem risco"}
            }
        ],
        "alerts": []
    }
    state["plots"].insert(0, plot)
    return plot


def analyze_plot(state, plot_id):
    plot = next((item for item in state["plots"] if item["id"] == plot_id), None)
    if not plot:
        return None, None
    snapshot = REGISTRY.satellite.analyze_plot(plot, len(state["alerts"]))
    plot["snapshots"].append(snapshot)
    alert = append_alert_if_needed(state, plot, snapshot)
    return plot, alert


class CampoSatHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        return

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json({"ok": True, "time": now_label()})
            return

        if parsed.path == "/api/bootstrap":
            state = load_state()
            self.send_json(bootstrap_payload(state))
            return

        if parsed.path == "/api/alerts":
            state = load_state()
            query = parse_qs(parsed.query)
            q = query.get("q", [""])[0].strip().lower()
            severity = query.get("severity", ["all"])[0]
            alerts = state["alerts"]
            if q:
                alerts = [
                    alert for alert in alerts
                    if q in f"{alert['plotName']} {alert['summary']} {alert['when']}".lower()
                ]
            if severity != "all":
                alerts = [alert for alert in alerts if alert["severity"] == severity]
            self.send_json({"alerts": alerts})
            return

        if parsed.path in {"/", "/index.html"}:
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length) if length else b"{}"
        payload = json.loads(raw_body.decode("utf-8")) if raw_body else {}

        if parsed.path == "/api/plots":
            state = load_state()
            plot = create_plot(state, payload)
            save_state(state)
            self.send_json({"plot": plot}, status=HTTPStatus.CREATED)
            return

        if parsed.path == "/api/analyze":
            state = load_state()
            plot, alert = analyze_plot(state, payload.get("plotId"))
            if not plot:
                self.send_json({"error": "Talhao nao encontrado."}, status=HTTPStatus.NOT_FOUND)
                return
            save_state(state)
            self.send_json({"plot": plot, "alert": alert})
            return

        if parsed.path == "/api/analyze-batch":
            state = load_state()
            plot_ids = payload.get("plotIds", [])
            updated = []
            alerts = []
            for plot_id in plot_ids:
                plot, alert = analyze_plot(state, plot_id)
                if plot:
                    updated.append(plot["id"])
                if alert:
                    alerts.append(alert["id"])
            save_state(state)
            self.send_json({"updated": updated, "alerts": alerts})
            return

        if parsed.path == "/api/reset":
            state = load_seed_state()
            save_state(state)
            self.send_json({"ok": True})
            return

        self.send_json({"error": "Rota nao encontrada."}, status=HTTPStatus.NOT_FOUND)

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description="CampoSat local server")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    ensure_state_file()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), CampoSatHandler)
    print(f"CampoSat running at http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
