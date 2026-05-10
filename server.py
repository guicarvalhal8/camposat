import argparse
import copy
import hashlib
import hmac
import json
import secrets
import sqlite3
from datetime import datetime, timedelta
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


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
        "farmName": "Fazenda Santa Helena",
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

            CREATE TABLE IF NOT EXISTS plots (
                id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
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
                snapshots_json TEXT NOT NULL,
                alerts_json TEXT NOT NULL,
                FOREIGN KEY(owner_user_id) REFERENCES users(id)
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

        user_count = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        plot_count = connection.execute("SELECT COUNT(*) FROM plots").fetchone()[0]
        if user_count == 0 and plot_count == 0:
            seed_database(connection)


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

    for plot in seed_state["plots"]:
        owner_user_id = owner_by_name.get(plot.get("agronomist"))
        center = plot.get("center") or {"lat": 0, "lon": 0}
        connection.execute(
            """
            INSERT INTO plots(
                id, owner_user_id, name, farm_name, crop, hectares, municipality,
                center_lat, center_lon, coordinates_text, agronomist, whatsapp, notes,
                snapshots_json, alerts_json
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                plot["id"],
                owner_user_id,
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


def row_to_plot(row):
    return {
        "id": row["id"],
        "ownerUserId": row["owner_user_id"],
        "name": row["name"],
        "farmName": row["farm_name"],
        "crop": row["crop"],
        "hectares": row["hectares"],
        "municipality": row["municipality"],
        "center": {"lat": row["center_lat"], "lon": row["center_lon"]},
        "coordinatesText": row["coordinates_text"],
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


def fetch_plot_by_id(connection, plot_id):
    row = connection.execute("SELECT * FROM plots WHERE id = ?", (plot_id,)).fetchone()
    return row_to_plot(row) if row else None


def fetch_portfolio_plots(connection, user_id):
    rows = connection.execute(
        "SELECT * FROM plots WHERE owner_user_id = ? ORDER BY id ASC",
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
        SET owner_user_id = ?, name = ?, farm_name = ?, crop = ?, hectares = ?, municipality = ?,
            center_lat = ?, center_lon = ?, coordinates_text = ?, agronomist = ?, whatsapp = ?, notes = ?,
            snapshots_json = ?, alerts_json = ?
        WHERE id = ?
        """,
        (
            plot["ownerUserId"],
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


class ProviderRegistry:
    def __init__(self):
        self.weather = MockWeatherProvider()
        self.market = MockMarketProvider()
        self.whatsapp = MockWhatsAppProvider()
        self.satellite = MockSatelliteProvider(self.weather)


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
    center = {
        "lat": float(payload.get("lat", 0)),
        "lon": float(payload.get("lon", 0)),
    }
    base_ndvi = 0.72 if crop == "Soja" else 0.68
    initial_weather = REGISTRY.weather.generate({"crop": crop}, "green", base_ndvi)

    plot = {
        "id": plot_id,
        "ownerUserId": user["id"],
        "name": payload.get("plotName", "").strip(),
        "farmName": payload.get("farmName", user.get("farmName", "Novo cadastro")).strip() or user.get("farmName", "Novo cadastro"),
        "crop": crop,
        "hectares": int(payload.get("hectares", 0)),
        "municipality": payload.get("municipality", "Novo municipio").strip() or "Novo municipio",
        "center": center,
        "coordinatesText": f"{center['lat']:.4f}, {center['lon']:.4f}",
        "agronomist": user["name"],
        "whatsapp": payload.get("whatsapp", "").strip() or user.get("whatsapp", ""),
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
            }
        ],
        "alerts": [],
    }

    connection.execute(
        """
        INSERT INTO plots(
            id, owner_user_id, name, farm_name, crop, hectares, municipality,
            center_lat, center_lon, coordinates_text, agronomist, whatsapp, notes,
            snapshots_json, alerts_json
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            plot["id"],
            plot["ownerUserId"],
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
            json.dumps(plot["snapshots"], ensure_ascii=False),
            json.dumps(plot["alerts"], ensure_ascii=False),
        ),
    )
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


class CampoSatHandler(SimpleHTTPRequestHandler):
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
