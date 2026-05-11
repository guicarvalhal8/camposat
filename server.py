import argparse
import base64
import copy
import hashlib
import hmac
import json
import math
import os
import secrets
import sqlite3
from datetime import datetime, timedelta
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib import error as urllib_error, parse as urllib_parse, request as urllib_request


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SEED_PATH = DATA_DIR / "seed_state.json"
DB_PATH = DATA_DIR / "camposat.db"
SESSION_COOKIE_NAME = "camposat_session"
SESSIONS = {}

AUTH_SEED_USERS = [
    {
        "id": "AG-01",
        "name": "Marina Costa",
        "email": "marina@camposat.demo",
        "password": "camposat123",
        "farmName": "Fazenda Aurora",
        "whatsapp": "+55 65 99971-1221",
    },
    {
        "id": "AG-02",
        "name": "Rafael Gama",
        "email": "rafael@camposat.demo",
        "password": "camposat123",
        "farmName": "Fazenda Horizonte",
        "whatsapp": "+55 65 99931-8342",
    },
    {
        "id": "AG-03",
        "name": "Bianca Salles",
        "email": "bianca@camposat.demo",
        "password": "camposat123",
        "farmName": "Fazenda Cedro Alto",
        "whatsapp": "+55 64 99922-1840",
    },
    {
        "id": "AG-04",
        "name": "Ana Luiza Prado",
        "email": "ana@camposat.demo",
        "password": "camposat123",
        "farmName": "Fazenda Horizonte",
        "whatsapp": "+55 66 99912-4508",
    },
]


def now_label():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def normalize_email(value):
    return str(value or "").strip().lower()


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000).hex()
    return f"{salt}${digest}"


def verify_password(stored_password, candidate):
    try:
        salt, expected = stored_password.split("$", 1)
    except ValueError:
        return False
    candidate_hash = hash_password(candidate, salt).split("$", 1)[1]
    return hmac.compare_digest(expected, candidate_hash)


def public_user(user):
    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "farmName": user.get("farmName", ""),
        "whatsapp": user.get("whatsapp", ""),
        "createdAt": user.get("createdAt", ""),
    }


def load_seed_state():
    return json.loads(SEED_PATH.read_text(encoding="utf-8"))


def build_user_seed():
    created_at = now_label()
    return [
        {
            "id": item["id"],
            "name": item["name"],
            "email": normalize_email(item["email"]),
            "passwordHash": hash_password(item["password"]),
            "farmName": item["farmName"],
            "whatsapp": item["whatsapp"],
            "createdAt": created_at,
        }
        for item in AUTH_SEED_USERS
    ]


def open_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with open_db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                farm_name TEXT DEFAULT '',
                whatsapp TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS farms (
                id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                municipality TEXT DEFAULT '',
                whatsapp TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY(owner_user_id) REFERENCES users(id),
                UNIQUE(owner_user_id, name)
            );

            CREATE TABLE IF NOT EXISTS plots (
                id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                farm_id TEXT,
                name TEXT NOT NULL,
                farm_name TEXT NOT NULL,
                crop TEXT NOT NULL,
                hectares INTEGER NOT NULL,
                municipality TEXT NOT NULL,
                center_lat REAL NOT NULL,
                center_lon REAL NOT NULL,
                coordinates_text TEXT NOT NULL,
                agronomist TEXT NOT NULL,
                whatsapp TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                geometry_json TEXT,
                snapshots_json TEXT NOT NULL,
                alerts_json TEXT NOT NULL,
                FOREIGN KEY(owner_user_id) REFERENCES users(id),
                FOREIGN KEY(farm_id) REFERENCES farms(id)
            );

            CREATE TABLE IF NOT EXISTS alerts (
                id TEXT PRIMARY KEY,
                plot_id TEXT NOT NULL,
                plot_name TEXT NOT NULL,
                when_label TEXT NOT NULL,
                severity TEXT NOT NULL,
                sent INTEGER NOT NULL,
                summary TEXT NOT NULL,
                snapshot_id TEXT NOT NULL,
                FOREIGN KEY(plot_id) REFERENCES plots(id)
            );
            """
        )
        ensure_plot_farm_column(connection)
        ensure_plot_geometry_column(connection)
        backfill_farms(connection)

        user_count = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        plot_count = connection.execute("SELECT COUNT(*) FROM plots").fetchone()[0]
        if user_count == 0 and plot_count == 0:
            seed_database(connection)


def ensure_plot_farm_column(connection):
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(plots)").fetchall()}
    if "farm_id" not in columns:
        connection.execute("ALTER TABLE plots ADD COLUMN farm_id TEXT")
        connection.commit()


def ensure_plot_geometry_column(connection):
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(plots)").fetchall()}
    if "geometry_json" not in columns:
        connection.execute("ALTER TABLE plots ADD COLUMN geometry_json TEXT")
        connection.commit()


def set_meta(connection, key, value):
    connection.execute(
        """
        INSERT INTO meta(key, value)
        VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        """,
        (key, str(value)),
    )


def get_meta(connection, key, default=""):
    row = connection.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def touch_last_updated(connection):
    set_meta(connection, "lastUpdated", now_label())


def seed_database(connection):
    seed_state = load_seed_state()
    users = build_user_seed()
    owner_by_name = {user["name"]: user["id"] for user in users}

    connection.execute("DELETE FROM alerts")
    connection.execute("DELETE FROM plots")
    connection.execute("DELETE FROM farms")
    connection.execute("DELETE FROM users")
    connection.execute("DELETE FROM meta")

    for user in users:
        connection.execute(
            """
            INSERT INTO users(id, name, email, password_hash, farm_name, whatsapp, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user["id"],
                user["name"],
                user["email"],
                user["passwordHash"],
                user["farmName"],
                user["whatsapp"],
                user["createdAt"],
            ),
        )
        if user["farmName"]:
            ensure_farm(
                connection,
                user["id"],
                user["farmName"],
                municipality="",
                whatsapp=user["whatsapp"],
                created_at=user["createdAt"],
            )

    for plot in seed_state["plots"]:
        owner_user_id = owner_by_name.get(plot.get("agronomist"))
        center = plot.get("center") or {"lat": 0, "lon": 0}
        farm_id = ensure_farm(
            connection,
            owner_user_id,
            plot["farmName"],
            municipality=plot["municipality"],
            whatsapp=plot.get("whatsapp", ""),
        )
        connection.execute(
            """
            INSERT INTO plots(
                id, owner_user_id, farm_id, name, farm_name, crop, hectares, municipality,
                center_lat, center_lon, coordinates_text, agronomist, whatsapp, notes, geometry_json,
                snapshots_json, alerts_json
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                plot["id"],
                owner_user_id,
                farm_id,
                plot["name"],
                plot["farmName"],
                plot["crop"],
                int(plot["hectares"]),
                plot["municipality"],
                float(center["lat"]),
                float(center["lon"]),
                plot["coordinatesText"],
                plot["agronomist"],
                plot.get("whatsapp", ""),
                plot.get("notes", ""),
                json.dumps(plot.get("geometry"), ensure_ascii=False) if plot.get("geometry") else None,
                json.dumps(plot["snapshots"], ensure_ascii=False),
                json.dumps(plot.get("alerts", []), ensure_ascii=False),
            ),
        )

    for alert in seed_state["alerts"]:
        connection.execute(
            """
            INSERT INTO alerts(id, plot_id, plot_name, when_label, severity, sent, summary, snapshot_id)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                alert["id"],
                alert["plotId"],
                alert["plotName"],
                alert["when"],
                alert["severity"],
                1 if alert["sent"] else 0,
                alert["summary"],
                alert["snapshotId"],
            ),
        )

    set_meta(connection, "lastUpdated", seed_state["meta"]["lastUpdated"])
    set_meta(connection, "version", seed_state["meta"]["version"])
    connection.commit()


def seed_market_snapshot():
    return load_seed_state()["market"]


def seed_providers():
    return load_seed_state()["providers"]


def next_plot_id(connection):
    rows = connection.execute("SELECT id FROM plots").fetchall()
    ids = [int(row["id"].split("-")[1]) for row in rows]
    return f"TL-{max(ids, default=0) + 1:02d}"


def next_alert_id(connection):
    rows = connection.execute("SELECT id FROM alerts").fetchall()
    ids = [int(row["id"].split("-")[1]) for row in rows]
    return f"AL-{max(ids, default=3157) + 1}"


def next_user_id(connection):
    rows = connection.execute("SELECT id FROM users").fetchall()
    ids = [int(row["id"].split("-")[1]) for row in rows]
    return f"AG-{max(ids, default=0) + 1:02d}"


def next_farm_id(connection):
    rows = connection.execute("SELECT id FROM farms").fetchall()
    ids = [int(row["id"].split("-")[1]) for row in rows if "-" in row["id"]]
    return f"FM-{max(ids, default=0) + 1:02d}"


def row_to_user(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "passwordHash": row["password_hash"],
        "farmName": row["farm_name"],
        "whatsapp": row["whatsapp"],
        "createdAt": row["created_at"],
    }


def row_to_farm(row):
    plot_count = row["plot_count"] if "plot_count" in row.keys() else 0
    area_total = row["area_total"] if "area_total" in row.keys() else 0
    return {
        "id": row["id"],
        "ownerUserId": row["owner_user_id"],
        "name": row["name"],
        "municipality": row["municipality"],
        "whatsapp": row["whatsapp"],
        "createdAt": row["created_at"],
        "plotCount": int(plot_count or 0),
        "hectares": int(area_total or 0),
    }


def row_to_plot(row):
    farm_name = row["resolved_farm_name"] if "resolved_farm_name" in row.keys() and row["resolved_farm_name"] else row["farm_name"]
    return {
        "id": row["id"],
        "ownerUserId": row["owner_user_id"],
        "farmId": row["farm_id"],
        "name": row["name"],
        "farmName": farm_name,
        "crop": row["crop"],
        "hectares": row["hectares"],
        "municipality": row["municipality"],
        "center": {"lat": row["center_lat"], "lon": row["center_lon"]},
        "coordinatesText": row["coordinates_text"],
        "geometry": json.loads(row["geometry_json"]) if row["geometry_json"] else None,
        "agronomist": row["agronomist"],
        "whatsapp": row["whatsapp"],
        "notes": row["notes"],
        "snapshots": json.loads(row["snapshots_json"]),
        "alerts": json.loads(row["alerts_json"]),
    }


def row_to_alert(row):
    return {
        "id": row["id"],
        "plotId": row["plot_id"],
        "plotName": row["plot_name"],
        "when": row["when_label"],
        "severity": row["severity"],
        "sent": bool(row["sent"]),
        "summary": row["summary"],
        "snapshotId": row["snapshot_id"],
    }


def fetch_user_by_id(connection, user_id):
    row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return row_to_user(row) if row else None


def fetch_user_by_email(connection, email):
    row = connection.execute("SELECT * FROM users WHERE email = ?", (normalize_email(email),)).fetchone()
    return row_to_user(row) if row else None


def fetch_farm_by_owner_and_name(connection, owner_user_id, farm_name):
    row = connection.execute(
        """
        SELECT *
        FROM farms
        WHERE owner_user_id = ? AND lower(name) = lower(?)
        """,
        (owner_user_id, farm_name),
    ).fetchone()
    return row_to_farm(row) if row else None


def ensure_farm(connection, owner_user_id, farm_name, municipality="", whatsapp="", created_at=None):
    name = str(farm_name or "").strip()
    if not owner_user_id or not name:
        return None

    existing = fetch_farm_by_owner_and_name(connection, owner_user_id, name)
    if existing:
        if (municipality and not existing["municipality"]) or (whatsapp and not existing["whatsapp"]):
            connection.execute(
                """
                UPDATE farms
                SET municipality = CASE WHEN municipality = '' THEN ? ELSE municipality END,
                    whatsapp = CASE WHEN whatsapp = '' THEN ? ELSE whatsapp END
                WHERE id = ?
                """,
                (municipality, whatsapp, existing["id"]),
            )
        return existing["id"]

    farm_id = next_farm_id(connection)
    connection.execute(
        """
        INSERT INTO farms(id, owner_user_id, name, municipality, whatsapp, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
        """,
        (
            farm_id,
            owner_user_id,
            name,
            municipality,
            whatsapp,
            created_at or now_label(),
        ),
    )
    return farm_id


def backfill_farms(connection):
    dirty = False
    user_rows = connection.execute("SELECT * FROM users").fetchall()
    for row in user_rows:
        user = row_to_user(row)
        if user["farmName"]:
            farm_id = ensure_farm(
                connection,
                user["id"],
                user["farmName"],
                municipality="",
                whatsapp=user["whatsapp"],
                created_at=user["createdAt"],
            )
            dirty = dirty or bool(farm_id)

    plot_rows = connection.execute("SELECT id, owner_user_id, farm_id, farm_name, municipality, whatsapp FROM plots").fetchall()
    for row in plot_rows:
        farm_id = ensure_farm(
            connection,
            row["owner_user_id"],
            row["farm_name"],
            municipality=row["municipality"],
            whatsapp=row["whatsapp"],
        )
        if farm_id and row["farm_id"] != farm_id:
            connection.execute("UPDATE plots SET farm_id = ? WHERE id = ?", (farm_id, row["id"]))
            dirty = True

    if dirty:
        connection.commit()


def fetch_plot_by_id(connection, plot_id):
    row = connection.execute(
        """
        SELECT plots.*, farms.name AS resolved_farm_name
        FROM plots
        LEFT JOIN farms ON farms.id = plots.farm_id
        WHERE plots.id = ?
        """,
        (plot_id,),
    ).fetchone()
    return row_to_plot(row) if row else None


def fetch_portfolio_farms(connection, user_id):
    rows = connection.execute(
        """
        SELECT
            farms.*,
            COUNT(plots.id) AS plot_count,
            COALESCE(SUM(plots.hectares), 0) AS area_total
        FROM farms
        LEFT JOIN plots ON plots.farm_id = farms.id
        WHERE farms.owner_user_id = ?
        GROUP BY farms.id
        ORDER BY farms.name COLLATE NOCASE ASC
        """,
        (user_id,),
    ).fetchall()
    return [row_to_farm(row) for row in rows]


def fetch_portfolio_plots(connection, user_id):
    rows = connection.execute(
        """
        SELECT plots.*, farms.name AS resolved_farm_name
        FROM plots
        LEFT JOIN farms ON farms.id = plots.farm_id
        WHERE plots.owner_user_id = ?
        ORDER BY plots.id ASC
        """,
        (user_id,),
    ).fetchall()
    return [row_to_plot(row) for row in rows]


def fetch_portfolio_alerts(connection, user_id):
    rows = connection.execute(
        """
        SELECT alerts.*
        FROM alerts
        INNER JOIN plots ON plots.id = alerts.plot_id
        WHERE plots.owner_user_id = ?
        ORDER BY alerts.when_label DESC, alerts.id DESC
        """,
        (user_id,),
    ).fetchall()
    return [row_to_alert(row) for row in rows]


def save_plot(connection, plot):
    center = plot["center"]
    connection.execute(
        """
        UPDATE plots
        SET owner_user_id = ?, farm_id = ?, name = ?, farm_name = ?, crop = ?, hectares = ?, municipality = ?,
            center_lat = ?, center_lon = ?, coordinates_text = ?, agronomist = ?, whatsapp = ?, notes = ?,
            geometry_json = ?, snapshots_json = ?, alerts_json = ?
        WHERE id = ?
        """,
        (
            plot["ownerUserId"],
            plot.get("farmId"),
            plot["name"],
            plot["farmName"],
            plot["crop"],
            int(plot["hectares"]),
            plot["municipality"],
            float(center["lat"]),
            float(center["lon"]),
            plot["coordinatesText"],
            plot["agronomist"],
            plot.get("whatsapp", ""),
            plot.get("notes", ""),
            json.dumps(plot.get("geometry"), ensure_ascii=False) if plot.get("geometry") else None,
            json.dumps(plot["snapshots"], ensure_ascii=False),
            json.dumps(plot.get("alerts", []), ensure_ascii=False),
            plot["id"],
        ),
    )


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
            "windKmh": wind,
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

    def analyze_plot(self, plot):
        latest = plot["snapshots"][-1]
        last_date = datetime.strptime(latest["capturedAt"], "%Y-%m-%d %H:%M")
        captured_at = (last_date + timedelta(days=5)).strftime("%Y-%m-%d %H:%M")
        next_snapshot = copy.deepcopy(latest)
        next_snapshot["id"] = f"SN-{plot['id'].replace('-', '')}-{len(plot['snapshots']) + 1:02d}"
        next_snapshot["capturedAt"] = captured_at
        next_snapshot["sceneId"] = f"S2-DEMO-{plot['id']}-{len(plot['snapshots']) + 1:02d}"
        next_snapshot["cloudCoverage"] = max(
            2,
            latest["cloudCoverage"] - 1 if latest["status"] == "green" else latest["cloudCoverage"] + 1,
        )

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


class SentinelHubImageProvider:
    def __init__(self):
        self.client_id = os.getenv("SENTINELHUB_CLIENT_ID", "").strip()
        self.client_secret = os.getenv("SENTINELHUB_CLIENT_SECRET", "").strip()
        self.process_url = os.getenv("SENTINELHUB_PROCESS_URL", "https://services.sentinel-hub.com/api/v1/process").strip()
        self.token_url = os.getenv("SENTINELHUB_TOKEN_URL", "https://services.sentinel-hub.com/oauth/token").strip()
        self._token = None
        self._token_expires_at = None

    @property
    def enabled(self):
        return bool(self.client_id and self.client_secret)

    def _get_token(self):
        if not self.enabled:
            return None
        if self._token and self._token_expires_at and datetime.utcnow() < self._token_expires_at:
            return self._token

        body = urllib_parse.urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }
        ).encode("utf-8")
        request = urllib_request.Request(
            self.token_url,
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib_request.urlopen(request, timeout=25) as response:
            payload = json.loads(response.read().decode("utf-8"))
        token = payload.get("access_token")
        expires_in = int(payload.get("expires_in", 0) or 0)
        if not token:
            return None
        self._token = token
        self._token_expires_at = datetime.utcnow() + timedelta(seconds=max(0, expires_in - 60))
        return token

    def fetch_preview(self, plot, snapshot):
        if not self.enabled:
            return None
        token = self._get_token()
        if not token:
            return None

        bbox = build_plot_bbox(plot)
        if not bbox:
            return None

        captured = datetime.strptime(snapshot["capturedAt"], "%Y-%m-%d %H:%M")
        time_from = (captured - timedelta(days=20)).strftime("%Y-%m-%dT00:00:00Z")
        time_to = captured.strftime("%Y-%m-%dT23:59:59Z")
        payload = {
            "input": {
                "bounds": {
                    "bbox": bbox,
                    "properties": {"crs": "http://www.opengis.net/def/crs/OGC/1.3/CRS84"},
                },
                "data": [
                    {
                        "type": "sentinel-2-l2a",
                        "dataFilter": {
                            "timeRange": {"from": time_from, "to": time_to},
                            "mosaickingOrder": "leastCC",
                        },
                    }
                ],
            },
            "output": {
                "width": 640,
                "height": 640,
                "responses": [{"identifier": "default", "format": {"type": "image/png"}}],
            },
            "evalscript": """
//VERSION=3
function setup() {
  return {
    input: [{
      bands: ["B02", "B03", "B04"]
    }],
    output: {
      bands: 3,
      sampleType: "AUTO"
    }
  };
}

function evaluatePixel(sample) {
  return [2.5 * sample.B04, 2.5 * sample.B03, 2.5 * sample.B02];
}
""".strip(),
        }
        request = urllib_request.Request(
            self.process_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "image/png",
            },
            method="POST",
        )
        try:
            with urllib_request.urlopen(request, timeout=40) as response:
                image_bytes = response.read()
        except (urllib_error.HTTPError, urllib_error.URLError, TimeoutError):
            return None

        if not image_bytes:
            return None

        encoded = base64.b64encode(image_bytes).decode("ascii")
        return {
            "imageDataUrl": f"data:image/png;base64,{encoded}",
            "imageMode": "real-preview",
            "analysisSource": "Sentinel-2 L2A via Sentinel Hub",
            "imageNote": "Imagem real buscada para apoiar a vistoria visual. Os indicadores do CampoSat ainda seguem o fluxo atual de analise.",
        }


class ProviderRegistry:
    def __init__(self):
        self.weather = MockWeatherProvider()
        self.market = MockMarketProvider()
        self.whatsapp = MockWhatsAppProvider()
        self.satellite = MockSatelliteProvider(self.weather)
        self.satellite_images = SentinelHubImageProvider()


REGISTRY = ProviderRegistry()


def severity_from_status(status):
    if status == "red":
        return "Alta"
    if status == "yellow":
        return "Media"
    return "Baixa"


def portfolio_payload(connection, user):
    return {
        "meta": {
            "lastUpdated": get_meta(connection, "lastUpdated", now_label()),
            "version": int(get_meta(connection, "version", "1")),
        },
        "providers": seed_providers(),
        "market": REGISTRY.market.snapshot(seed_market_snapshot()),
        "farms": fetch_portfolio_farms(connection, user["id"]),
        "plots": fetch_portfolio_plots(connection, user["id"]),
        "alerts": fetch_portfolio_alerts(connection, user["id"]),
        "auth": {"user": public_user(user)},
    }


def append_alert_if_needed(connection, plot, snapshot):
    severity = severity_from_status(snapshot["status"])
    if severity == "Baixa":
        return None

    alert_id = next_alert_id(connection)
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
        "snapshotId": snapshot["id"],
    }
    plot["alerts"].insert(
        0,
        {
            "id": alert_id,
            "when": snapshot["capturedAt"],
            "severity": severity,
            "sent": sent,
            "summary": summary,
            "snapshotId": snapshot["id"],
        },
    )
    connection.execute(
        """
        INSERT INTO alerts(id, plot_id, plot_name, when_label, severity, sent, summary, snapshot_id)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            alert["id"],
            alert["plotId"],
            alert["plotName"],
            alert["when"],
            alert["severity"],
            1 if alert["sent"] else 0,
            alert["summary"],
            alert["snapshotId"],
        ),
    )
    return alert


def create_plot(connection, payload, user):
    plot_id = next_plot_id(connection)
    crop = payload.get("crop", "Soja")
    geometry = normalize_polygon_geometry(payload.get("geometry"))
    lat_value = payload.get("lat")
    lon_value = payload.get("lon")
    center = {
        "lat": float(lat_value) if lat_value not in (None, "") else 0.0,
        "lon": float(lon_value) if lon_value not in (None, "") else 0.0,
    }
    if geometry:
        centroid = centroid_from_geometry(geometry)
        if centroid:
            center = centroid
    base_ndvi = 0.72 if crop == "Soja" else 0.68
    initial_weather = REGISTRY.weather.generate({"crop": crop}, "green", base_ndvi)
    farm_name = payload.get("farmName", user.get("farmName", "Novo cadastro")).strip() or user.get("farmName", "Novo cadastro")
    municipality = payload.get("municipality", "Novo municipio").strip() or "Novo municipio"
    whatsapp = payload.get("whatsapp", "").strip() or user.get("whatsapp", "")
    farm_id = ensure_farm(
        connection,
        user["id"],
        farm_name,
        municipality=municipality,
        whatsapp=whatsapp,
    )

    plot = {
        "id": plot_id,
        "ownerUserId": user["id"],
        "farmId": farm_id,
        "name": payload.get("plotName", "").strip(),
        "farmName": farm_name,
        "crop": crop,
        "hectares": int(payload.get("hectares", 0)),
        "municipality": municipality,
        "center": center,
        "coordinatesText": f"{center['lat']:.4f}, {center['lon']:.4f}",
        "geometry": geometry,
        "agronomist": user["name"],
        "whatsapp": whatsapp,
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
                    {"id": "A4", "fill": "#7fd786", "stroke": "#ceffd0"},
                ],
                "hotspot": {"x": 68, "y": 52, "radius": 8, "label": "Sem risco"},
                "imageDataUrl": None,
                "imageMode": "demo",
                "analysisSource": "Simulacao local do CampoSat",
                "imageNote": "Primeiro processamento criado localmente. A imagem real pode entrar quando a integracao externa estiver configurada.",
            }
        ],
        "alerts": [],
    }

    enrich_snapshot_visual(plot, plot["snapshots"][0])

    connection.execute(
        """
        INSERT INTO plots(
            id, owner_user_id, farm_id, name, farm_name, crop, hectares, municipality,
            center_lat, center_lon, coordinates_text, agronomist, whatsapp, notes, geometry_json,
            snapshots_json, alerts_json
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            plot["id"],
            plot["ownerUserId"],
            plot["farmId"],
            plot["name"],
            plot["farmName"],
            plot["crop"],
            plot["hectares"],
            plot["municipality"],
            plot["center"]["lat"],
            plot["center"]["lon"],
            plot["coordinatesText"],
            plot["agronomist"],
            plot["whatsapp"],
            plot["notes"],
            json.dumps(plot["geometry"], ensure_ascii=False) if plot.get("geometry") else None,
            json.dumps(plot["snapshots"], ensure_ascii=False),
            json.dumps(plot["alerts"], ensure_ascii=False),
        ),
    )
    touch_last_updated(connection)
    connection.commit()
    return plot


def update_plot(connection, payload, user, plot_id):
    plot = get_owned_plot(connection, user, plot_id)
    if not plot:
        return None

    crop = payload.get("crop", plot.get("crop", "Soja"))
    geometry = normalize_polygon_geometry(payload.get("geometry"))
    lat_value = payload.get("lat")
    lon_value = payload.get("lon")
    center = {
        "lat": float(lat_value) if lat_value not in (None, "") else float(plot["center"]["lat"]),
        "lon": float(lon_value) if lon_value not in (None, "") else float(plot["center"]["lon"]),
    }
    if geometry:
        centroid = centroid_from_geometry(geometry)
        if centroid:
            center = centroid

    farm_name = payload.get("farmName", plot["farmName"]).strip() or plot["farmName"]
    municipality = payload.get("municipality", plot["municipality"]).strip() or plot["municipality"]
    whatsapp = payload.get("whatsapp", plot.get("whatsapp", "")).strip() or plot.get("whatsapp", "")
    farm_id = ensure_farm(
        connection,
        user["id"],
        farm_name,
        municipality=municipality,
        whatsapp=whatsapp,
    )

    plot.update(
        {
            "farmId": farm_id,
            "name": payload.get("plotName", plot["name"]).strip() or plot["name"],
            "farmName": farm_name,
            "crop": crop,
            "hectares": int(payload.get("hectares", plot["hectares"])),
            "municipality": municipality,
            "center": center,
            "coordinatesText": f"{center['lat']:.4f}, {center['lon']:.4f}",
            "geometry": geometry,
            "agronomist": user["name"],
            "whatsapp": whatsapp,
            "notes": payload.get("notes", plot.get("notes", "")).strip(),
        }
    )

    save_plot(connection, plot)
    touch_last_updated(connection)
    connection.commit()
    return plot


def get_owned_plot(connection, user, plot_id):
    plot = fetch_plot_by_id(connection, plot_id)
    if not plot or plot.get("ownerUserId") != user["id"]:
        return None
    return plot


def analyze_plot(connection, user, plot_id):
    plot = get_owned_plot(connection, user, plot_id)
    if not plot:
        return None, None
    snapshot = REGISTRY.satellite.analyze_plot(plot)
    enrich_snapshot_visual(plot, snapshot)
    plot["snapshots"].append(snapshot)
    alert = append_alert_if_needed(connection, plot, snapshot)
    save_plot(connection, plot)
    touch_last_updated(connection)
    connection.commit()
    return plot, alert


def build_session_cookie(session_id):
    return f"{SESSION_COOKIE_NAME}={session_id}; Path=/; HttpOnly; SameSite=Lax"


def build_clear_session_cookie():
    return f"{SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"


def _close_ring(ring):
    if not ring:
        return []
    normalized = [[float(pair[0]), float(pair[1])] for pair in ring]
    if normalized[0] != normalized[-1]:
        normalized.append(normalized[0])
    return normalized


def normalize_polygon_geometry(value):
    if not isinstance(value, dict):
        return None
    if value.get("type") == "Polygon":
        coordinates = value.get("coordinates") or []
        if not coordinates or not isinstance(coordinates[0], list):
            return None
        outer_candidate = coordinates[0]
        if outer_candidate and isinstance(outer_candidate[0], (int, float)):
            outer_candidate = coordinates
        ring = [pair for pair in outer_candidate if isinstance(pair, (list, tuple)) and len(pair) >= 2]
        if len(ring) < 3:
            return None
        return {"type": "Polygon", "coordinates": [_close_ring(ring)]}
    if value.get("type") == "Feature":
        return normalize_polygon_geometry(value.get("geometry"))
    if value.get("type") == "FeatureCollection":
        for feature in value.get("features") or []:
            geometry = normalize_polygon_geometry(feature)
            if geometry:
                return geometry
    return None


def centroid_from_geometry(geometry):
    ring = ((geometry or {}).get("coordinates") or [[]])[0]
    if not ring:
        return None
    unique = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    if not unique:
        return None
    lat = sum(float(pair[1]) for pair in unique) / len(unique)
    lon = sum(float(pair[0]) for pair in unique) / len(unique)
    return {"lat": lat, "lon": lon}


def geometry_bounds(geometry):
    ring = ((geometry or {}).get("coordinates") or [[]])[0]
    if not ring:
        return None
    min_lon = min(float(pair[0]) for pair in ring)
    max_lon = max(float(pair[0]) for pair in ring)
    min_lat = min(float(pair[1]) for pair in ring)
    max_lat = max(float(pair[1]) for pair in ring)
    return (min_lon, min_lat, max_lon, max_lat)


def build_plot_bbox(plot):
    geometry = normalize_polygon_geometry(plot.get("geometry"))
    if geometry:
        bounds = geometry_bounds(geometry)
        if bounds:
            return list(bounds)

    center = plot.get("center") or {}
    lat = float(center.get("lat", 0) or 0)
    lon = float(center.get("lon", 0) or 0)
    if not lat and not lon:
        return None

    hectares = max(1.0, float(plot.get("hectares", 1) or 1))
    half_side_meters = max(110, ((hectares * 10000) ** 0.5) / 2)
    lat_delta = half_side_meters / 111320
    lon_delta = half_side_meters / (111320 * max(0.2, abs(math.cos((lat * math.pi) / 180))))
    return [lon - lon_delta, lat - lat_delta, lon + lon_delta, lat + lat_delta]


def enrich_snapshot_visual(plot, snapshot):
    live_preview = REGISTRY.satellite_images.fetch_preview(plot, snapshot)
    if live_preview:
        snapshot.update(live_preview)
        return
    snapshot.setdefault("imageDataUrl", None)
    snapshot.setdefault("imageMode", "demo")
    snapshot.setdefault("analysisSource", "Simulacao local do CampoSat")
    snapshot.setdefault(
        "imageNote",
        "Sem credencial externa configurada, a analise segue usando o fluxo local e a imagem real aparece apenas no mapa base.",
    )


class CampoSatHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        return

    def parse_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length) if length else b"{}"
        return json.loads(raw_body.decode("utf-8")) if raw_body else {}

    def current_user(self):
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        morsel = cookie.get(SESSION_COOKIE_NAME)
        if not morsel:
            return None
        session_id = morsel.value
        user_id = SESSIONS.get(session_id)
        if not user_id:
            return None
        with open_db() as connection:
            return fetch_user_by_id(connection, user_id)

    def require_user(self):
        user = self.current_user()
        if not user:
            self.send_json({"error": "Autenticacao necessaria."}, status=HTTPStatus.UNAUTHORIZED)
            return None
        return user

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/health":
            self.send_json({"ok": True, "time": now_label()})
            return

        if parsed.path == "/api/auth/session":
            user = self.require_user()
            if not user:
                return
            self.send_json({"user": public_user(user)})
            return

        if parsed.path == "/api/bootstrap":
            user = self.require_user()
            if not user:
                return
            with open_db() as connection:
                self.send_json(portfolio_payload(connection, user))
            return

        if parsed.path == "/api/alerts":
            user = self.require_user()
            if not user:
                return
            with open_db() as connection:
                alerts = fetch_portfolio_alerts(connection, user["id"])
            query = parse_qs(parsed.query)
            q = query.get("q", [""])[0].strip().lower()
            severity = query.get("severity", ["all"])[0]
            if q:
                alerts = [
                    alert
                    for alert in alerts
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
        payload = self.parse_body()

        if parsed.path == "/api/auth/login":
            with open_db() as connection:
                user = fetch_user_by_email(connection, payload.get("email"))
            password = str(payload.get("password") or "")
            if not user or not verify_password(user["passwordHash"], password):
                self.send_json({"error": "E-mail ou senha invalidos."}, status=HTTPStatus.UNAUTHORIZED)
                return
            session_id = secrets.token_urlsafe(32)
            SESSIONS[session_id] = user["id"]
            self.send_json(
                {"user": public_user(user)},
                extra_headers={"Set-Cookie": build_session_cookie(session_id)},
            )
            return

        if parsed.path == "/api/auth/register":
            name = str(payload.get("name") or "").strip()
            email = normalize_email(payload.get("email"))
            password = str(payload.get("password") or "")
            farm_name = str(payload.get("farmName") or "").strip()
            whatsapp = str(payload.get("whatsapp") or "").strip()

            if not name or not email or not password:
                self.send_json({"error": "Preencha nome, e-mail e senha."}, status=HTTPStatus.BAD_REQUEST)
                return
            if len(password) < 6:
                self.send_json({"error": "A senha precisa ter pelo menos 6 caracteres."}, status=HTTPStatus.BAD_REQUEST)
                return

            with open_db() as connection:
                if fetch_user_by_email(connection, email):
                    self.send_json({"error": "Ja existe uma conta cadastrada com esse e-mail."}, status=HTTPStatus.CONFLICT)
                    return

                user = {
                    "id": next_user_id(connection),
                    "name": name,
                    "email": email,
                    "passwordHash": hash_password(password),
                    "farmName": farm_name,
                    "whatsapp": whatsapp,
                    "createdAt": now_label(),
                }
                connection.execute(
                    """
                    INSERT INTO users(id, name, email, password_hash, farm_name, whatsapp, created_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user["id"],
                        user["name"],
                        user["email"],
                        user["passwordHash"],
                        user["farmName"],
                        user["whatsapp"],
                        user["createdAt"],
                    ),
                )
                if user["farmName"]:
                    ensure_farm(
                        connection,
                        user["id"],
                        user["farmName"],
                        municipality="",
                        whatsapp=user["whatsapp"],
                        created_at=user["createdAt"],
                    )
                connection.commit()

            session_id = secrets.token_urlsafe(32)
            SESSIONS[session_id] = user["id"]
            self.send_json(
                {"user": public_user(user)},
                status=HTTPStatus.CREATED,
                extra_headers={"Set-Cookie": build_session_cookie(session_id)},
            )
            return

        if parsed.path == "/api/auth/logout":
            cookie = SimpleCookie()
            cookie.load(self.headers.get("Cookie", ""))
            morsel = cookie.get(SESSION_COOKIE_NAME)
            if morsel:
                SESSIONS.pop(morsel.value, None)
            self.send_json({"ok": True}, extra_headers={"Set-Cookie": build_clear_session_cookie()})
            return

        user = self.require_user()
        if not user:
            return

        if parsed.path == "/api/plots":
            with open_db() as connection:
                plot_id = str(payload.get("plotId") or "").strip()
                if plot_id:
                    plot = update_plot(connection, payload, user, plot_id)
                    if not plot:
                        self.send_json({"error": "Talhao nao encontrado."}, status=HTTPStatus.NOT_FOUND)
                        return
                    self.send_json({"plot": plot})
                    return

                plot = create_plot(connection, payload, user)
            self.send_json({"plot": plot}, status=HTTPStatus.CREATED)
            return

        if parsed.path == "/api/analyze":
            with open_db() as connection:
                plot, alert = analyze_plot(connection, user, payload.get("plotId"))
            if not plot:
                self.send_json({"error": "Talhao nao encontrado."}, status=HTTPStatus.NOT_FOUND)
                return
            self.send_json({"plot": plot, "alert": alert})
            return

        if parsed.path == "/api/analyze-batch":
            with open_db() as connection:
                plot_ids = payload.get("plotIds", [])
                updated = []
                alerts = []
                for plot_id in plot_ids:
                    plot, alert = analyze_plot(connection, user, plot_id)
                    if plot:
                        updated.append(plot["id"])
                    if alert:
                        alerts.append(alert["id"])
            self.send_json({"updated": updated, "alerts": alerts})
            return

        if parsed.path == "/api/reset":
            with open_db() as connection:
                seed_database(connection)
            self.send_json({"ok": True})
            return

        self.send_json({"error": "Rota nao encontrada."}, status=HTTPStatus.NOT_FOUND)

    def do_PUT(self):
        parsed = urlparse(self.path)
        payload = self.parse_body()
        user = self.require_user()
        if not user:
            return

        if parsed.path.startswith("/api/plots/"):
            plot_id = parsed.path.rsplit("/", 1)[-1]
            with open_db() as connection:
                plot = update_plot(connection, payload, user, plot_id)
            if not plot:
                self.send_json({"error": "Talhao nao encontrado."}, status=HTTPStatus.NOT_FOUND)
                return
            self.send_json({"plot": plot})
            return

        self.send_json({"error": "Rota nao encontrada."}, status=HTTPStatus.NOT_FOUND)

    def send_json(self, payload, status=HTTPStatus.OK, extra_headers=None):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description="CampoSat local server")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    init_db()
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
