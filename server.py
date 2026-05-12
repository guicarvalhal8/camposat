import argparse
import base64
import copy
import csv
import hashlib
import hmac
import io
import json
import math
import os
import secrets
import sqlite3
import subprocess
import unicodedata
from datetime import datetime, timedelta
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from PIL import Image
from urllib.parse import parse_qs, urlparse
from urllib import error as urllib_error, parse as urllib_parse, request as urllib_request


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SEED_PATH = DATA_DIR / "seed_state.json"
DB_PATH = DATA_DIR / "camposat.db"
MARKET_CACHE_PATH = DATA_DIR / "market_cache.json"
ENV_PATH = ROOT / ".env.local"
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


def load_local_env(path=ENV_PATH):
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key:
            os.environ.setdefault(key, value)


load_local_env()


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
    providers = copy.deepcopy(load_seed_state()["providers"])
    satellite = providers.get("satellite", {})
    weather = providers.get("weather", {})
    satellite["name"] = "Sentinel Hub"
    satellite["mode"] = "real-preview" if REGISTRY.satellite_images.enabled else "aguardando-credencial"
    satellite["status"] = "ready" if REGISTRY.satellite_images.enabled else "pending"
    satellite["note"] = (
        "Credenciais encontradas. O app pode buscar cena real e NDVI do talhao."
        if REGISTRY.satellite_images.enabled
        else "Falta configurar SENTINELHUB_CLIENT_ID e SENTINELHUB_CLIENT_SECRET no .env.local."
    )
    weather["name"] = "Open-Meteo"
    weather["mode"] = "forecast-api"
    weather["status"] = "ready"
    weather["note"] = "Clima real por coordenada com fallback local se a consulta externa falhar."
    providers["satellite"] = satellite
    providers["weather"] = weather
    return providers


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
    def generate(self, plot, status, ndvi, captured_at=None):
        base_temp = 25 if plot["crop"] == "Soja" else 27
        rain = 14 if status == "green" else 5 if status == "yellow" else 1
        humidity = 81 if status == "green" else 66 if status == "yellow" else 54
        wind = 7 if status == "green" else 12 if status == "yellow" else 15
        recent_rain = 18 if status == "green" else 9 if status == "yellow" else 4
        forecast = [
            {"label": "Amanha", "date": "", "tempMaxC": round(base_temp + 1.2, 1), "tempMinC": round(base_temp - 5.4, 1), "rainMm": round(max(0, rain - 2), 1), "windKmh": round(wind + 1.5, 1)},
            {"label": "Dia 2", "date": "", "tempMaxC": round(base_temp + 2.0, 1), "tempMinC": round(base_temp - 4.8, 1), "rainMm": round(max(0, rain + 1), 1), "windKmh": round(wind + 2.4, 1)},
            {"label": "Dia 3", "date": "", "tempMaxC": round(base_temp + 0.8, 1), "tempMinC": round(base_temp - 5.9, 1), "rainMm": round(max(0, rain - 1), 1), "windKmh": round(wind + 0.8, 1)},
        ]
        risk_bundle = self._build_operational_risks(ndvi, recent_rain, humidity, wind, forecast)
        return {
            "tempC": round(base_temp + (0.6 - ndvi) * 10, 1),
            "rainMm": rain,
            "humidity": humidity,
            "windKmh": wind,
            "recentRainMm": recent_rain,
            "forecast": forecast,
            "fieldRisk": risk_bundle["overall"],
            "operationalRisks": risk_bundle["details"],
            "source": "Simulacao local do CampoSat",
            "sourceMode": "fallback",
            "observedAt": captured_at or now_label(),
        }

    def _build_field_risk(self, ndvi, recent_rain, humidity, wind, forecast):
        rainy_days = sum(1 for day in forecast if day["rainMm"] >= 10)
        score = 0
        reasons = []
        if ndvi < 0.55:
            score += 2
            reasons.append("a lavoura ja mostra sinal mais fraco")
        elif ndvi < 0.68:
            score += 1
            reasons.append("a lavoura pede acompanhamento")
        if recent_rain >= 25:
            score += 1
            reasons.append("choveu bastante nos ultimos dias")
        if rainy_days >= 2:
            score += 2
            reasons.append("ha mais chuva prevista na sequencia")
        if wind >= 18:
            score += 1
            reasons.append("o vento pode atrapalhar a operacao")
        if humidity >= 85:
            score += 1
            reasons.append("a umidade alta pode alongar a janela de cuidado")
        if score >= 4:
            return {"level": "high", "label": "Risco alto", "note": f"Vale segurar a operacao e monitorar de perto porque {', '.join(reasons)}."}
        if score >= 2:
            return {"level": "medium", "label": "Risco moderado", "note": f"Da para operar com cuidado porque {', '.join(reasons)}."}
        return {"level": "low", "label": "Risco baixo", "note": "O clima desta rodada nao indica trava importante para a operacao de campo."}

    def _build_operational_risks(self, ndvi, recent_rain, humidity, wind, forecast):
        details = {
            "fieldVisit": self._build_field_visit_risk(recent_rain, humidity, forecast),
            "application": self._build_application_risk(humidity, wind, forecast),
            "crop": self._build_crop_risk(ndvi, recent_rain, forecast),
        }
        overall = self._compose_overall_risk(details)
        return {"overall": overall, "details": details}

    def _build_field_visit_risk(self, recent_rain, humidity, forecast):
        rain_next = sum((day.get("rainMm") or 0) for day in forecast[:2])
        if recent_rain >= 25 or rain_next >= 20:
            return {
                "level": "high",
                "label": "Entrada em campo delicada",
                "note": "O solo pode estar pesado ou voltar a molhar rapido, entao vale evitar entrada agora."
            }
        if recent_rain >= 12 or humidity >= 85 or rain_next >= 8:
            return {
                "level": "medium",
                "label": "Entrada em campo com cuidado",
                "note": "Da para entrar, mas vale checar lama, umidade do solo e a chuva prevista."
            }
        return {
            "level": "low",
            "label": "Entrada em campo tranquila",
            "note": "Nao ha sinal forte de solo encharcado ou chuva imediata atrapalhando a vistoria."
        }

    def _build_application_risk(self, humidity, wind, forecast):
        rain_next = sum((day.get("rainMm") or 0) for day in forecast[:2])
        max_wind = max([wind] + [(day.get("windKmh") or 0) for day in forecast[:2]])
        if max_wind >= 20 or rain_next >= 12:
            return {
                "level": "high",
                "label": "Aplicacao pouco segura",
                "note": "Vento ou chuva prevista podem derrubar a qualidade da aplicacao e aumentar perda."
            }
        if max_wind >= 14 or humidity >= 85 or rain_next >= 5:
            return {
                "level": "medium",
                "label": "Aplicacao pedindo cuidado",
                "note": "Vale revisar janela, deriva e chance de chuva antes de aplicar."
            }
        return {
            "level": "low",
            "label": "Aplicacao em boa janela",
            "note": "Vento e chuva nao mostram trava importante para aplicacao nesta rodada."
        }

    def _build_crop_risk(self, ndvi, recent_rain, forecast):
        hot_days = sum(1 for day in forecast if (day.get("tempMaxC") or 0) >= 31)
        rainy_days = sum(1 for day in forecast if (day.get("rainMm") or 0) >= 10)
        if ndvi < 0.55 or (recent_rain <= 5 and hot_days >= 2) or rainy_days >= 3:
            return {
                "level": "high",
                "label": "Lavoura sob mais pressao",
                "note": "A lavoura merece acompanhamento mais de perto por sinal de estresse ou clima apertado."
            }
        if ndvi < 0.68 or hot_days >= 2 or recent_rain >= 25:
            return {
                "level": "medium",
                "label": "Lavoura pedindo acompanhamento",
                "note": "Ainda nao parece critico, mas o clima pode apertar e vale observar a resposta da area."
            }
        return {
            "level": "low",
            "label": "Lavoura em situacao estavel",
            "note": "Nao ha sinal forte de clima pressionando a lavoura neste momento."
        }

    def _compose_overall_risk(self, details):
        highest = max(details.values(), key=lambda item: self._risk_rank(item.get("level")))
        if highest.get("level") == "high":
            return {
                "level": "high",
                "label": "Risco alto",
                "note": "Pelo menos uma frente esta apertada agora. Vale olhar entrada, aplicacao e resposta da lavoura antes de agir."
            }
        if highest.get("level") == "medium":
            return {
                "level": "medium",
                "label": "Risco moderado",
                "note": "Ha pontos pedindo cuidado, mas ainda existe janela para operar com revisao antes."
            }
        return {
            "level": "low",
            "label": "Risco baixo",
            "note": "O clima desta rodada nao indica trava importante para a operacao de campo."
        }

    def _risk_rank(self, level):
        if level == "high":
            return 3
        if level == "medium":
            return 2
        return 1


class OpenMeteoWeatherProvider:
    FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
    REQUEST_TIMEOUT = 16
    COMMAND_TIMEOUT = 18
    CACHE_TTL_SECONDS = 30 * 60

    def __init__(self, fallback_provider):
        self.fallback_provider = fallback_provider
        self._cache = {}

    def generate(self, plot, status, ndvi, captured_at=None):
        center = (plot or {}).get("center") or {}
        lat = float(center.get("lat") or 0)
        lon = float(center.get("lon") or 0)
        if not lat and not lon:
            return self.fallback_provider.generate(plot, status, ndvi, captured_at)

        cache_key = f"{lat:.3f},{lon:.3f}"
        cached = self._cache.get(cache_key)
        now_ts = datetime.now().timestamp()
        if cached and (now_ts - cached["ts"]) < self.CACHE_TTL_SECONDS:
            return copy.deepcopy(cached["payload"])

        live_weather = self._fetch_weather(lat, lon)
        if not live_weather:
            return self.fallback_provider.generate(plot, status, ndvi, captured_at)

        risk_bundle = self.fallback_provider._build_operational_risks(
            ndvi,
            live_weather["recentRainMm"],
            live_weather["humidity"],
            live_weather["windKmh"],
            live_weather["forecast"],
        )
        payload = {
            "tempC": live_weather["tempC"],
            "rainMm": live_weather["rainMm"],
            "humidity": live_weather["humidity"],
            "windKmh": live_weather["windKmh"],
            "recentRainMm": live_weather["recentRainMm"],
            "forecast": live_weather["forecast"],
            "fieldRisk": risk_bundle["overall"],
            "operationalRisks": risk_bundle["details"],
            "source": "Open-Meteo",
            "sourceMode": "official",
            "observedAt": live_weather["observedAt"],
        }
        self._cache[cache_key] = {"ts": now_ts, "payload": copy.deepcopy(payload)}
        return payload

    def _fetch_weather(self, lat, lon):
        params = {
            "latitude": lat,
            "longitude": lon,
            "timezone": "auto",
            "forecast_days": 4,
            "past_days": 3,
            "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation",
            "daily": "precipitation_sum,temperature_2m_max,temperature_2m_min,wind_speed_10m_max",
            "temperature_unit": "celsius",
            "wind_speed_unit": "kmh",
            "precipitation_unit": "mm",
        }
        url = f"{self.FORECAST_URL}?{urllib_parse.urlencode(params)}"
        payload = self._download_json(url)
        if not payload:
            return None

        current = payload.get("current") or {}
        daily = payload.get("daily") or {}
        daily_precip = daily.get("precipitation_sum") or []
        daily_time = daily.get("time") or []
        daily_temp_max = daily.get("temperature_2m_max") or []
        daily_temp_min = daily.get("temperature_2m_min") or []
        daily_wind_max = daily.get("wind_speed_10m_max") or []
        temp_c = self._safe_float(current.get("temperature_2m"))
        humidity = self._safe_float(current.get("relative_humidity_2m"))
        wind_kmh = self._safe_float(current.get("wind_speed_10m"))
        rain_mm = self._safe_float(daily_precip[0] if daily_precip else current.get("precipitation"))
        if temp_c is None or humidity is None or wind_kmh is None or rain_mm is None:
            return None
        current_date = str(current.get("time") or "").split("T")[0]
        try:
            current_index = daily_time.index(current_date)
        except ValueError:
            current_index = 0
        recent_rain = round(sum(self._safe_float(value) or 0.0 for value in daily_precip[max(0, current_index - 3):current_index]), 1)
        forecast = []
        for index in range(current_index + 1, min(len(daily_time), current_index + 4)):
            forecast.append(
                {
                    "label": self._forecast_label(daily_time[index], index - current_index),
                    "date": daily_time[index],
                    "tempMaxC": round(self._safe_float(daily_temp_max[index]) or 0.0, 1),
                    "tempMinC": round(self._safe_float(daily_temp_min[index]) or 0.0, 1),
                    "rainMm": round(self._safe_float(daily_precip[index]) or 0.0, 1),
                    "windKmh": round(self._safe_float(daily_wind_max[index]) or 0.0, 1),
                }
            )
        return {
            "tempC": round(temp_c, 1),
            "rainMm": round(rain_mm, 1),
            "humidity": int(round(humidity)),
            "windKmh": round(wind_kmh, 1),
            "recentRainMm": recent_rain,
            "forecast": forecast,
            "observedAt": str(current.get("time") or now_label()).replace("T", " "),
        }

    def _download_json(self, url):
        fetchers = (
            lambda: self._download_with_urllib(url),
            lambda: self._download_with_curl(url),
            lambda: self._download_with_powershell(url),
        )
        for fetcher in fetchers:
            payload = fetcher()
            if isinstance(payload, dict) and not payload.get("error"):
                return payload
        return None

    def _download_with_urllib(self, url):
        request = urllib_request.Request(
            url,
            headers={"User-Agent": "CampoSat/1.0"},
            method="GET",
        )
        try:
            with urllib_request.urlopen(request, timeout=self.REQUEST_TIMEOUT) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib_error.HTTPError, urllib_error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
            return None

    def _download_with_curl(self, url):
        command = [
            "curl.exe",
            "-L",
            "--silent",
            "--show-error",
            "--max-time",
            str(self.COMMAND_TIMEOUT),
            url,
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=self.COMMAND_TIMEOUT + 2,
                check=False,
            )
        except Exception:
            return None
        if result.returncode != 0:
            return None
        try:
            return json.loads((result.stdout or "").lstrip("\ufeff"))
        except (json.JSONDecodeError, ValueError):
            return None

    def _download_with_powershell(self, url):
        command = [
            "powershell",
            "-NoProfile",
            "-Command",
            (
                "$ProgressPreference='SilentlyContinue'; "
                f"(Invoke-WebRequest -UseBasicParsing '{url}' -TimeoutSec {self.COMMAND_TIMEOUT}).Content"
            ),
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=self.COMMAND_TIMEOUT + 3,
                check=False,
            )
        except Exception:
            return None
        if result.returncode != 0:
            return None
        try:
            return json.loads((result.stdout or "").lstrip("\ufeff"))
        except (json.JSONDecodeError, ValueError):
            return None

    def _safe_float(self, value):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def _forecast_label(self, iso_date, offset):
        try:
            parsed = datetime.strptime(str(iso_date), "%Y-%m-%d")
            if offset == 1:
                return "Amanha"
            return parsed.strftime("%d/%m")
        except ValueError:
            return f"Dia {offset}"


class ConabMarketProvider:
    WEEKLY_UF_URL = "https://portaldeinformacoes.conab.gov.br/downloads/arquivos/PrecosSemanalUF.txt"
    MONTHLY_UF_URL = "https://portaldeinformacoes.conab.gov.br/downloads/arquivos/PrecosMensalUF.txt"
    COVERAGE_UF = "GO"
    REQUEST_TIMEOUT = 18
    COMMAND_TIMEOUT = 20

    TRACKED_PRODUCTS = [
        {
            "slug": "soy",
            "category": "sales",
            "productId": "4744",
            "product": "SOJA",
            "classification": "EM GRAOS",
            "label": "Soja saca 60kg",
            "multiplier": 60.0,
            "unitLabel": "por saca de 60 kg",
            "sourcePriority": ["weekly", "monthly"],
        },
        {
            "slug": "corn",
            "category": "sales",
            "productId": "4742",
            "product": "MILHO",
            "classification": "EM GRAOS",
            "label": "Milho saca 60kg",
            "multiplier": 60.0,
            "unitLabel": "por saca de 60 kg",
            "sourcePriority": ["weekly", "monthly"],
        },
        {
            "slug": "sorghum",
            "category": "sales",
            "productId": "4745",
            "product": "SORGO",
            "classification": "EM GRAOS",
            "label": "Sorgo saca 60kg",
            "multiplier": 60.0,
            "unitLabel": "por saca de 60 kg",
            "sourcePriority": ["weekly", "monthly"],
        },
        {
            "slug": "soy-seed",
            "category": "purchases",
            "productId": "11764",
            "product": "SEMENTE DE SOJA",
            "classification": "INTACTA RR2 PRO",
            "label": "Semente de soja",
            "multiplier": 1.0,
            "unitLabel": "por kg",
            "sourcePriority": ["monthly", "weekly"],
        },
        {
            "slug": "corn-seed",
            "category": "purchases",
            "productId": "13959",
            "product": "SEMENTE DE MILHO",
            "classification": "PRECOCE",
            "label": "Semente de milho",
            "multiplier": 1.0,
            "unitLabel": "por kg",
            "sourcePriority": ["monthly", "weekly"],
        },
        {
            "slug": "urea",
            "category": "purchases",
            "productId": "4579",
            "product": "UREIA",
            "classification": "NAO INFORMADO",
            "label": "Ureia",
            "multiplier": 1.0,
            "unitLabel": "por kg",
            "sourcePriority": ["monthly", "weekly"],
        },
        {
            "slug": "map-fertilizer",
            "category": "purchases",
            "productId": "11909",
            "product": "MAP",
            "classification": "11-52-0",
            "label": "MAP",
            "multiplier": 1.0,
            "unitLabel": "por kg",
            "sourcePriority": ["monthly", "weekly"],
        },
        {
            "slug": "potassium-chloride",
            "category": "purchases",
            "productId": "4541",
            "product": "CLORETO DE POTASSIO",
            "classification": "NAO INFORMADO",
            "label": "Cloreto de potassio",
            "multiplier": 1.0,
            "unitLabel": "por kg",
            "sourcePriority": ["monthly", "weekly"],
        },
    ]

    PREFERRED_LEVELS = ["RECEBIDO P/ PR", "PAGO PELO PROD", "ATACADO", "VAREJO"]

    def __init__(self):
        self._latest_feed = None

    def snapshot(self, current_market):
        if self._latest_feed and self._latest_feed.get("overview"):
            return copy.deepcopy(self._latest_feed["overview"])
        market = copy.deepcopy(current_market)
        market["updatedAt"] = now_label()
        return market

    def fetch_market_feed(self):
        profiles = self._source_profiles()
        rows_by_kind = {}
        for candidate in profiles:
            rows_by_kind[candidate["kind"]] = self._fetch_rows(candidate)

        if not any(rows_by_kind.values()):
            cached_feed = self._load_cached_feed()
            if cached_feed:
                self._latest_feed = copy.deepcopy(cached_feed)
                return cached_feed
            return None

        items = [self._build_item(rows_by_kind, config) for config in self.TRACKED_PRODUCTS]
        available_items = [item for item in items if item.get("available")]
        if not available_items:
            cached_feed = self._load_cached_feed()
            if cached_feed:
                self._latest_feed = copy.deepcopy(cached_feed)
                return cached_feed
            return None

        latest_period = max(
            (item["rawPeriodKey"] for item in available_items),
            key=lambda period: (period.get("year", 0), period.get("month", 0), period.get("week", 0)),
            default=None,
        )
        updated_at = now_label()
        overview = {
            "updatedAt": updated_at,
            "soy": self._build_overview_item(items, "soy"),
            "corn": self._build_overview_item(items, "corn"),
        }
        live_kinds = {item.get("sourceKind") for item in available_items if item.get("sourceKind")}
        uses_weekly = "weekly" in live_kinds
        uses_monthly = "monthly" in live_kinds
        feed = {
            "title": "Mercado em Goias",
            "description": self._build_feed_description(uses_weekly, uses_monthly),
            "coverageLabel": "Goias",
            "coverageNote": self._build_feed_coverage_note(uses_weekly, uses_monthly),
            "sourceLabel": self._build_feed_source_label(uses_weekly, uses_monthly),
            "sourceNote": self._build_feed_source_note(uses_weekly, uses_monthly),
            "sourceMode": "official",
            "sourceKind": self._build_feed_source_kind(uses_weekly, uses_monthly),
            "periodLabel": latest_period["label"] if latest_period else "",
            "updatedAt": updated_at,
            "items": items,
            "overview": overview,
        }
        self._latest_feed = copy.deepcopy(feed)
        self._save_cached_feed(feed)
        return feed

    def _source_profiles(self):
        return [
            {
                "kind": "weekly",
                "url": self.WEEKLY_UF_URL,
                "description": "Aqui ficam os principais precos organizados para leitura rapida. Hoje a cobertura esta focada em Goias e pronta para crescer depois.",
                "coverageNote": "Nesta primeira fase, a aba acompanha referencias semanais da Conab para Goias.",
                "sourceLabel": "Conab - Precos agropecuarios semanal por UF",
                "sourceNote": "Usamos o arquivo semanal oficial da Conab por UF e filtramos os itens mais relevantes para a rotina do app em Goias.",
            },
            {
                "kind": "monthly",
                "url": self.MONTHLY_UF_URL,
                "description": "Nesta rodada usamos a base oficial mensal da Conab para manter a aba oficial mesmo quando o arquivo semanal nao responde.",
                "coverageNote": "Nesta primeira fase, a aba acompanha referencias oficiais da Conab para Goias. Quando o semanal falha, usamos o mensal.",
                "sourceLabel": "Conab - Precos agropecuarios mensal por UF",
                "sourceNote": "O arquivo semanal nao respondeu nesta tentativa. Usamos a base mensal oficial da Conab por UF para manter a aba com referencia oficial.",
            },
        ]

    def _build_feed_description(self, uses_weekly, uses_monthly):
        if uses_weekly and uses_monthly:
            return "Venda e compra aparecem juntas nesta aba. Hoje os precos de venda usam a base semanal da Conab e os itens de compra usam a base mensal oficial."
        if uses_weekly:
            return "Venda e compra aparecem juntas nesta aba. Nesta rodada a leitura oficial veio pela base semanal da Conab."
        if uses_monthly:
            return "Venda e compra aparecem juntas nesta aba. Nesta rodada a leitura oficial veio pela base mensal da Conab."
        return "Aqui ficam os principais precos organizados para leitura rapida."

    def _build_feed_coverage_note(self, uses_weekly, uses_monthly):
        if uses_weekly and uses_monthly:
            return "Nesta fase, venda usa referencia semanal e compra usa referencia mensal, sempre focadas em Goias."
        if uses_monthly:
            return "Nesta fase, a aba acompanha referencias oficiais mensais da Conab para Goias."
        return "Nesta fase, a aba acompanha referencias oficiais da Conab para Goias."

    def _build_feed_source_label(self, uses_weekly, uses_monthly):
        if uses_weekly and uses_monthly:
            return "Conab - semanal e mensal por UF"
        if uses_monthly:
            return "Conab - Precos agropecuarios mensal por UF"
        return "Conab - Precos agropecuarios semanal por UF"

    def _build_feed_source_note(self, uses_weekly, uses_monthly):
        if uses_weekly and uses_monthly:
            return "Para ficar mais util no dia a dia, a aba mistura venda pela base semanal oficial e compras pela base mensal oficial da Conab."
        if uses_monthly:
            return "Nesta rodada usamos a base mensal oficial da Conab para manter a aba atualizada."
        return "Usamos o arquivo semanal oficial da Conab por UF e filtramos os itens mais relevantes para a rotina do app em Goias."

    def _build_feed_source_kind(self, uses_weekly, uses_monthly):
        if uses_weekly and uses_monthly:
            return "weekly-monthly"
        if uses_monthly:
            return "monthly"
        if uses_weekly:
            return "weekly"
        return ""

    def _fetch_rows(self, source_profile):
        content = self._download_content(source_profile["url"])
        if not content:
            return []

        reader = csv.DictReader(content.splitlines(), delimiter=";")
        rows = []
        for raw_row in reader:
            row = {key.strip(): (value or "").strip() for key, value in raw_row.items()}
            if row.get("uf") != self.COVERAGE_UF:
                continue
            row["_product_key"] = self._normalize_key(row.get("produto"))
            row["_classification_key"] = self._normalize_key(row.get("classificao_produto"))
            row["_level_key"] = self._normalize_key(row.get("dsc_nivel_comercializacao"))
            row["_source_kind"] = source_profile["kind"]
            rows.append(row)
        return rows

    def _download_content(self, url):
        fetchers = (
            lambda: self._download_with_urllib(url),
            lambda: self._download_with_curl(url),
            lambda: self._download_with_powershell(url),
        )
        for fetcher in fetchers:
            content = fetcher()
            if content and "produto" in content.lower():
                return content
        return ""

    def _download_with_urllib(self, url):
        request = urllib_request.Request(
            url,
            headers={"User-Agent": "CampoSat/1.0"},
            method="GET",
        )
        try:
            with urllib_request.urlopen(request, timeout=self.REQUEST_TIMEOUT) as response:
                return response.read().decode("utf-8-sig", errors="replace")
        except Exception:
            return ""

    def _download_with_curl(self, url):
        command = [
            "curl.exe",
            "-L",
            "--silent",
            "--show-error",
            "--max-time",
            str(self.COMMAND_TIMEOUT),
            url,
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=self.COMMAND_TIMEOUT + 2,
                check=False,
            )
        except Exception:
            return ""
        if result.returncode != 0:
            return ""
        return (result.stdout or "").lstrip("\ufeff")

    def _download_with_powershell(self, url):
        command = [
            "powershell",
            "-NoProfile",
            "-Command",
            (
                "$ProgressPreference='SilentlyContinue'; "
                f"(Invoke-WebRequest -UseBasicParsing '{url}' -TimeoutSec {self.COMMAND_TIMEOUT}).Content"
            ),
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=self.COMMAND_TIMEOUT + 3,
                check=False,
            )
        except Exception:
            return ""
        if result.returncode != 0:
            return ""
        return (result.stdout or "").lstrip("\ufeff")

    def _save_cached_feed(self, feed):
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            payload = {
                "savedAt": now_label(),
                "feed": feed,
            }
            MARKET_CACHE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            return

    def _load_cached_feed(self):
        if not MARKET_CACHE_PATH.exists():
            return None
        try:
            payload = json.loads(MARKET_CACHE_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        feed = payload.get("feed")
        if not isinstance(feed, dict):
            return None

        cached_feed = copy.deepcopy(feed)
        saved_at = payload.get("savedAt") or cached_feed.get("updatedAt") or now_label()
        cached_feed["sourceMode"] = "official-cache"
        cached_feed["sourceLabel"] = "Conab - ultima leitura oficial salva"
        cached_feed["sourceNote"] = (
            "A consulta ao arquivo oficial nao respondeu agora. Mantivemos a ultima leitura oficial salva para a aba continuar util."
        )
        cached_feed["cacheSavedAt"] = saved_at
        cached_feed["description"] = (
            "Esta rodada abriu a ultima leitura oficial salva da Conab. Assim voce continua vendo uma referencia oficial recente mesmo sem resposta ao vivo."
        )
        cached_feed["items"] = [self._mark_item_as_cached(item) for item in cached_feed.get("items", [])]
        return cached_feed

    def _mark_item_as_cached(self, item):
        updated_item = copy.deepcopy(item)
        updated_item["sourceMode"] = "official-cache"
        return updated_item

    def _build_item(self, rows_by_kind, config):
        matching = []
        source_kind = ""
        for preferred_kind in config.get("sourcePriority", ["weekly", "monthly"]):
            rows = rows_by_kind.get(preferred_kind) or []
            if not rows:
                continue
            matching = self._matching_rows(rows, config)
            if matching:
                source_kind = preferred_kind
                break

        if not matching:
            for rows in rows_by_kind.values():
                matching = self._matching_rows(rows, config)
                if matching:
                    source_kind = matching[0].get("_source_kind", "")
                    break

        if not matching:
            return {
                "slug": config["slug"],
                "category": config.get("category", "sales"),
                "label": config["label"],
                "available": False,
                "note": "A fonte oficial ainda nao trouxe esse item para a cobertura atual em Goias.",
                "source": "Conab",
                "sourceMode": "official",
                "history": [],
                "unitLabel": config.get("unitLabel", ""),
            }

        return self._build_item_from_matching(matching, config, source_kind or matching[0].get("_source_kind", ""))

    def _matching_rows(self, rows, config):
        config_product_id = str(config.get("productId") or "").strip()
        if config_product_id:
            matching = [row for row in rows if str(row.get("id_produto") or "").strip() == config_product_id]
        else:
            matching = [
                row
                for row in rows
                if row.get("_product_key") == self._normalize_key(config["product"])
                and row.get("_classification_key", "").startswith(self._normalize_key(config["classification"]))
            ]
        return matching

    def _build_item_from_matching(self, matching, config, source_kind):
        chosen_level = None
        level_rows = []
        for level in self.PREFERRED_LEVELS:
            level_key = self._normalize_key(level)
            candidate_rows = [row for row in matching if level_key and level_key in row.get("_level_key", "")]
            if candidate_rows:
                chosen_level = level
                level_rows = candidate_rows
                break
        if not level_rows:
            level_rows = matching
            chosen_level = self._clean_label(matching[0].get("dsc_nivel_comercializacao")) or "Referencia oficial"

        ordered_rows = sorted(level_rows, key=self._period_sort_key)
        latest = ordered_rows[-1]
        previous = ordered_rows[-2] if len(ordered_rows) > 1 else None
        current_value = self._parse_decimal(latest.get("valor_produto_kg"))
        previous_value = self._parse_decimal(previous.get("valor_produto_kg")) if previous else current_value
        current_price = round(current_value * config["multiplier"], 2)
        previous_price = round(previous_value * config["multiplier"], 2)
        change = round(current_price - previous_price, 2)
        period = self._period_label(latest)
        history = [
            {
                "label": self._short_period_label(row),
                "price": round(self._parse_decimal(row.get("valor_produto_kg")) * config["multiplier"], 2),
            }
            for row in ordered_rows[-4:]
        ]
        return {
            "slug": config["slug"],
            "category": config.get("category", "sales"),
            "label": config["label"],
            "available": True,
            "price": current_price,
            "previousPrice": previous_price,
            "change": change,
            "referenceLabel": self._title_label(chosen_level),
            "periodLabel": period,
            "summary": self._describe_change(change, chosen_level),
            "source": self._source_label_for_kind(source_kind),
            "sourceMode": "official",
            "sourceKind": source_kind,
            "history": history,
            "unitLabel": config.get("unitLabel", ""),
            "rawPeriodKey": {
                "year": int(latest.get("ano") or 0),
                "month": int(latest.get("mes") or 0),
                "week": int(latest.get("semana") or 0),
                "label": period,
            },
        }

    def _source_label_for_kind(self, source_kind):
        if source_kind == "monthly":
            return "Conab - mensal por UF"
        return "Conab - semanal por UF"

    def _build_overview_item(self, items, slug):
        item = next((entry for entry in items if entry.get("slug") == slug and entry.get("available")), None)
        if not item:
            return {
                "label": "Indisponivel",
                "price": 0,
                "change": 0,
                "source": "Conab - semanal por UF",
            }
        return {
            "label": item["label"],
            "price": item["price"],
            "change": item["change"],
            "source": "Conab - semanal por UF",
        }

    def _period_sort_key(self, row):
        return (
            int(row.get("ano") or 0),
            int(row.get("mes") or 0),
            int(row.get("semana") or 0),
        )

    def _period_label(self, row):
        if row.get("_source_kind") == "monthly":
            month = int(row.get("mes") or 0)
            year = int(row.get("ano") or 0)
            return f"{month:02d}/{year}" if month and year else "Mes nao informado"
        return row.get("data_inicial_final_semana") or "Periodo nao informado"

    def _short_period_label(self, row):
        if row.get("_source_kind") == "monthly":
            return self._period_label(row)
        raw = self._period_label(row)
        start = raw.split(" - ")[0].strip()
        pieces = start.split("-")
        if len(pieces) == 3:
            day, month, _year = pieces
            return f"{day}/{month}"
        return start or "Periodo"

    def _parse_decimal(self, value):
        normalized = str(value or "0").strip().replace(".", "").replace(",", ".")
        try:
            return float(normalized)
        except ValueError:
            return 0.0

    def _describe_change(self, change, chosen_level):
        level = self._clean_label(chosen_level).lower() if chosen_level else "referencia oficial"
        if change > 0:
            return f"Subiu em relacao ao periodo anterior dentro de {level}."
        if change < 0:
            return f"Caiu em relacao ao periodo anterior dentro de {level}."
        return f"Ficou no mesmo nivel no recorte de {level}."

    def _normalize_key(self, value):
        text = str(value or "").strip().upper().replace("?", "A")
        text = unicodedata.normalize("NFD", text)
        text = "".join(char for char in text if unicodedata.category(char) != "Mn")
        return " ".join(text.split())

    def _clean_label(self, value):
        text = str(value or "").replace("?", "a").strip()
        return " ".join(text.split())

    def _title_label(self, value):
        label = self._clean_label(value).lower()
        return " ".join(part.capitalize() for part in label.split())


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
        self.stats_url = os.getenv("SENTINELHUB_STATS_URL", "https://services.sentinel-hub.com/api/v1/statistics").strip()
        self.token_url = os.getenv("SENTINELHUB_TOKEN_URL", "https://services.sentinel-hub.com/oauth/token").strip()
        self._token = None
        self._token_expires_at = None

    @property
    def enabled(self):
        return bool(
            self.client_id
            and self.client_secret
            and "cole_seu" not in self.client_id.lower()
            and "cole_seu" not in self.client_secret.lower()
        )

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
        try:
            with urllib_request.urlopen(request, timeout=25) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib_error.HTTPError, urllib_error.URLError, TimeoutError, json.JSONDecodeError):
            return None
        token = payload.get("access_token")
        expires_in = int(payload.get("expires_in", 0) or 0)
        if not token:
            return None
        self._token = token
        self._token_expires_at = datetime.utcnow() + timedelta(seconds=max(0, expires_in - 60))
        return token

    def _run_process(self, token, bbox, time_from, time_to, evalscript, width=640, height=640):
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
                "width": width,
                "height": height,
                "responses": [{"identifier": "default", "format": {"type": "image/png"}}],
            },
            "evalscript": evalscript.strip(),
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
        with urllib_request.urlopen(request, timeout=40) as response:
            return response.read()

    def _suggestion_timerange(self):
        time_to = datetime.utcnow()
        time_from = time_to - timedelta(days=35)
        return (
            time_from.strftime("%Y-%m-%dT00:00:00Z"),
            time_to.strftime("%Y-%m-%dT23:59:59Z"),
        )

    def _fetch_ndvi_mask_bytes(self, token, bbox, time_from, time_to, width=320, height=320):
        evalscript = """
//VERSION=3
function setup() {
  return {
    input: [{
      bands: ["B04", "B08", "CLD", "dataMask"]
    }],
    output: {
      bands: 1,
      sampleType: "AUTO"
    }
  };
}

function evaluatePixel(sample) {
  if (sample.dataMask === 0 || sample.CLD > 60) return [0];
  let ndvi = index(sample.B08, sample.B04);
  let normalized = (ndvi + 0.1) / 0.9;
  normalized = Math.max(0, Math.min(1, normalized));
  return [normalized];
}
        """
        return self._run_process(token, bbox, time_from, time_to, evalscript, width=width, height=height)

    def _fetch_rgb_bytes(self, token, bbox, time_from, time_to, width=320, height=320):
        evalscript = """
//VERSION=3
function setup() {
  return {
    input: [{
      bands: ["B02", "B03", "B04", "dataMask"]
    }],
    output: {
      bands: 4,
      sampleType: "AUTO"
    }
  };
}

function evaluatePixel(sample) {
  return [2.3 * sample.B04, 2.3 * sample.B03, 2.3 * sample.B02, sample.dataMask];
}
"""
        return self._run_process(token, bbox, time_from, time_to, evalscript, width=width, height=height)

    def suggest_geometry(self, plot):
        if not self.enabled:
            return {"ok": False, "reason": "sentinel-unavailable"}
        token = self._get_token()
        if not token:
            return {"ok": False, "reason": "token-unavailable"}
        bbox = build_bbox_from_center(plot.get("center") or {}, plot.get("hectares", 1), expansion=2.2)
        if not bbox:
            return {"ok": False, "reason": "missing-center"}
        time_from, time_to = self._suggestion_timerange()
        try:
            image_bytes = self._fetch_ndvi_mask_bytes(token, bbox, time_from, time_to)
            rgb_bytes = self._fetch_rgb_bytes(token, bbox, time_from, time_to)
        except (urllib_error.HTTPError, urllib_error.URLError, TimeoutError):
            return {"ok": False, "reason": "imagery-unreachable"}
        if not image_bytes:
            return {"ok": False, "reason": "empty-image"}
        try:
            geometry, diagnostics = infer_geometry_from_ndvi_mask(image_bytes, bbox, plot.get("hectares", 1), rgb_bytes=rgb_bytes)
        except Exception:
            return {"ok": False, "reason": "image-parse-failed"}
        if not geometry:
            return {"ok": False, "reason": "no-region-found"}
        geometry = snap_polygon_to_straight_edges(geometry)
        geometry = scale_geometry_to_target_area(geometry, plot.get("hectares", 1))
        geometry = snap_polygon_to_straight_edges(geometry)
        diagnostics["measuredHectares"] = round(geometry_area_hectares(geometry), 1)
        diagnostics["targetHectares"] = float(plot.get("hectares", 0) or 0)
        diagnostics["source"] = "Sentinel-2 L2A via Sentinel Hub"
        diagnostics["mode"] = "image-guided"
        diagnostics["shapeMode"] = "straight-edge-aware"
        return {"ok": True, "geometry": geometry, "diagnostics": diagnostics}

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
        rgb_evalscript = """
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
"""
        ndvi_evalscript = """
//VERSION=3
function setup() {
  return {
    input: [{
      bands: ["B04", "B08", "dataMask"]
    }],
    output: {
      bands: 4,
      sampleType: "AUTO"
    }
  };
}

function evaluatePixel(sample) {
  let ndvi = index(sample.B08, sample.B04);
  if (ndvi < 0.2) return [0.75, 0.18, 0.16, sample.dataMask];
  if (ndvi < 0.4) return [0.95, 0.64, 0.22, sample.dataMask];
  if (ndvi < 0.6) return [0.92, 0.86, 0.26, sample.dataMask];
  if (ndvi < 0.75) return [0.4, 0.79, 0.37, sample.dataMask];
  return [0.16, 0.63, 0.34, sample.dataMask];
}
"""
        try:
            image_bytes = self._run_process(token, bbox, time_from, time_to, rgb_evalscript)
            ndvi_bytes = self._run_process(token, bbox, time_from, time_to, ndvi_evalscript)
        except (urllib_error.HTTPError, urllib_error.URLError, TimeoutError):
            return None

        if not image_bytes:
            return None

        encoded = base64.b64encode(image_bytes).decode("ascii")
        ndvi_encoded = base64.b64encode(ndvi_bytes).decode("ascii") if ndvi_bytes else None
        return {
            "imageDataUrl": f"data:image/png;base64,{encoded}",
            "ndviImageDataUrl": f"data:image/png;base64,{ndvi_encoded}" if ndvi_encoded else None,
            "imageMode": "real-preview",
            "analysisSource": "Sentinel-2 L2A via Sentinel Hub",
            "imageNote": "Imagem real buscada para apoiar a vistoria visual. Quando disponivel, o painel tambem traz a camada visual de NDVI da mesma cena.",
        }

    def fetch_ndvi_stats(self, plot, snapshot):
        if not self.enabled:
            return None
        token = self._get_token()
        if not token:
            return None

        geometry = build_plot_aoi(plot)
        bbox = build_plot_bbox(plot)
        if not geometry or not bbox:
            return None

        captured = datetime.strptime(snapshot["capturedAt"], "%Y-%m-%d %H:%M")
        time_from = (captured - timedelta(days=20)).strftime("%Y-%m-%dT00:00:00Z")
        time_to = captured.strftime("%Y-%m-%dT23:59:59Z")
        evalscript = """
//VERSION=3
function setup() {
  return {
    input: [{
      bands: ["B04", "B08", "CLD", "dataMask"]
    }],
    output: [
      { id: "ndvi", bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}

function evaluatePixel(sample) {
  let validMask = sample.dataMask;
  if (sample.CLD > 60) {
    validMask = 0;
  }
  return {
    ndvi: [index(sample.B08, sample.B04)],
    dataMask: [validMask]
  };
}
"""
        payload = {
            "input": {
                "bounds": {
                    "bbox": bbox,
                    "geometry": geometry,
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
            "aggregation": {
                "timeRange": {"from": time_from, "to": time_to},
                "aggregationInterval": {"of": "P1D"},
                "resx": 10,
                "resy": 10,
                "evalscript": evalscript.strip(),
            },
            "calculations": {
                "ndvi": {
                    "statistics": {
                        "default": {
                            "statistics": ["mean", "stDev", "sampleCount", "min", "max"]
                        }
                    }
                }
            },
        }
        request = urllib_request.Request(
            self.stats_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib_request.urlopen(request, timeout=40) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (urllib_error.HTTPError, urllib_error.URLError, TimeoutError, json.JSONDecodeError):
            return None

        intervals = data.get("data") or []
        if not intervals:
            return None
        outputs = intervals[-1].get("outputs") or {}
        ndvi_stats = ((outputs.get("ndvi") or {}).get("bands") or {}).get("B0") or {}
        stats = (ndvi_stats.get("stats") or {})
        if stats.get("mean") is None:
            return None
        return {
            "meanNdvi": round(float(stats.get("mean")), 2),
            "minNdvi": round(float(stats.get("min", stats.get("mean"))), 2),
            "maxNdvi": round(float(stats.get("max", stats.get("mean"))), 2),
            "sampleCount": int(stats.get("sampleCount", 0) or 0),
        }


class ProviderRegistry:
    def __init__(self):
        self.weather_fallback = MockWeatherProvider()
        self.weather = OpenMeteoWeatherProvider(self.weather_fallback)
        self.market = ConabMarketProvider()
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


def geometry_area_hectares(geometry):
    ring = ((geometry or {}).get("coordinates") or [[]])[0]
    if len(ring) < 4:
        return 0.0
    unique = ring[:-1] if ring[0] == ring[-1] else ring
    if len(unique) < 3:
        return 0.0
    center = centroid_from_geometry(geometry)
    if not center:
        return 0.0
    meters_per_degree_lat = 111320
    meters_per_degree_lon = max(1.0, 111320 * math.cos((center["lat"] * math.pi) / 180))
    twice_area = 0.0
    for index, current in enumerate(unique):
        nxt = unique[(index + 1) % len(unique)]
        x1 = (float(current[0]) - center["lon"]) * meters_per_degree_lon
        y1 = (float(current[1]) - center["lat"]) * meters_per_degree_lat
        x2 = (float(nxt[0]) - center["lon"]) * meters_per_degree_lon
        y2 = (float(nxt[1]) - center["lat"]) * meters_per_degree_lat
        twice_area += x1 * y2 - x2 * y1
    return abs(twice_area / 2.0) / 10000.0


def scale_geometry_to_target_area(geometry, target_hectares):
    target_hectares = max(0.0, float(target_hectares or 0))
    measured = geometry_area_hectares(geometry)
    if not target_hectares or not measured:
        return geometry
    factor = math.sqrt(target_hectares / measured)
    factor = max(0.72, min(1.38, factor))
    if abs(factor - 1.0) < 0.02:
        return geometry
    center = centroid_from_geometry(geometry)
    if not center:
        return geometry
    scaled_ring = []
    for lon, lat in ((geometry.get("coordinates") or [[]])[0][:-1]):
        scaled_ring.append([
            center["lon"] + (float(lon) - center["lon"]) * factor,
            center["lat"] + (float(lat) - center["lat"]) * factor,
        ])
    return {"type": "Polygon", "coordinates": [_close_ring(scaled_ring)]}


def geometry_to_local_xy(geometry):
    center = centroid_from_geometry(geometry)
    if not center:
        return None, None
    meters_per_degree_lat = 111320
    meters_per_degree_lon = max(1.0, 111320 * math.cos((center["lat"] * math.pi) / 180))
    ring = ((geometry or {}).get("coordinates") or [[]])[0]
    unique = ring[:-1] if ring and ring[0] == ring[-1] else ring
    points = [
        (
            (float(lon) - center["lon"]) * meters_per_degree_lon,
            (float(lat) - center["lat"]) * meters_per_degree_lat,
        )
        for lon, lat in unique
    ]
    return center, points


def local_xy_to_geometry(center, points):
    if not center or not points:
        return None
    meters_per_degree_lat = 111320
    meters_per_degree_lon = max(1.0, 111320 * math.cos((center["lat"] * math.pi) / 180))
    ring = [
        [
            center["lon"] + (float(x) / meters_per_degree_lon),
            center["lat"] + (float(y) / meters_per_degree_lat),
        ]
        for x, y in points
    ]
    return {"type": "Polygon", "coordinates": [_close_ring(ring)]}


def point_line_distance(point, start, end):
    px, py = point
    x1, y1 = start
    x2, y2 = end
    dx = x2 - x1
    dy = y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    proj_x = x1 + t * dx
    proj_y = y1 + t * dy
    return math.hypot(px - proj_x, py - proj_y)


def simplify_local_points(points, tolerance=24.0):
    if len(points) <= 4:
        return points[:]

    def recurse(segment_points):
        if len(segment_points) <= 2:
            return segment_points
        start = segment_points[0]
        end = segment_points[-1]
        max_distance = -1.0
        split_index = None
        for index in range(1, len(segment_points) - 1):
            distance = point_line_distance(segment_points[index], start, end)
            if distance > max_distance:
                max_distance = distance
                split_index = index
        if max_distance <= tolerance or split_index is None:
            return [start, end]
        left = recurse(segment_points[: split_index + 1])
        right = recurse(segment_points[split_index:])
        return left[:-1] + right

    simplified = recurse(points + [points[0]])[:-1]
    return simplified if len(simplified) >= 4 else points[:]


def rotate_xy(point, angle_radians):
    x, y = point
    cos_a = math.cos(angle_radians)
    sin_a = math.sin(angle_radians)
    return (x * cos_a - y * sin_a, x * sin_a + y * cos_a)


def unrotate_xy(point, angle_radians):
    return rotate_xy(point, -angle_radians)


def dominant_segment_angle(points):
    best_angle = 0.0
    best_weight = -1.0
    for index, current in enumerate(points):
        nxt = points[(index + 1) % len(points)]
        dx = nxt[0] - current[0]
        dy = nxt[1] - current[1]
        length = math.hypot(dx, dy)
        if length < 5:
            continue
        angle = math.atan2(dy, dx)
        normalized = ((angle + math.pi / 4) % (math.pi / 2)) - math.pi / 4
        if length > best_weight:
            best_weight = length
            best_angle = normalized
    return best_angle


def snap_polygon_to_straight_edges(geometry):
    center, local_points = geometry_to_local_xy(geometry)
    if not center or len(local_points) < 4:
        return geometry

    simplified = simplify_local_points(local_points, tolerance=26.0)
    base_angle = dominant_segment_angle(simplified)
    rotated = [rotate_xy(point, base_angle) for point in simplified]
    snapped = []
    for index, point in enumerate(rotated):
        prev_point = rotated[index - 1]
        next_point = rotated[(index + 1) % len(rotated)]
        current_x, current_y = point
        prev_dx = current_x - prev_point[0]
        prev_dy = current_y - prev_point[1]
        next_dx = next_point[0] - current_x
        next_dy = next_point[1] - current_y

        use_vertical = abs(prev_dx) < abs(prev_dy) or abs(next_dx) < abs(next_dy)
        use_horizontal = abs(prev_dy) <= abs(prev_dx) or abs(next_dy) <= abs(next_dx)

        if use_vertical and not use_horizontal:
            snapped.append((round(current_x / 6.0) * 6.0, current_y))
            continue
        if use_horizontal and not use_vertical:
            snapped.append((current_x, round(current_y / 6.0) * 6.0))
            continue

        snapped_x = round(current_x / 6.0) * 6.0
        snapped_y = round(current_y / 6.0) * 6.0
        snapped.append((snapped_x, snapped_y))

    cleaned = []
    for point in snapped:
        if not cleaned or math.hypot(point[0] - cleaned[-1][0], point[1] - cleaned[-1][1]) > 8:
            cleaned.append(point)
    if len(cleaned) < 4:
        cleaned = snapped

    unrotated = [unrotate_xy(point, base_angle) for point in cleaned]
    result = local_xy_to_geometry(center, unrotated)
    return result or geometry


def build_bbox_from_center(center, hectares, expansion=1.0):
    lat = float(center.get("lat", 0) or 0)
    lon = float(center.get("lon", 0) or 0)
    if not lat and not lon:
        return None
    hectares = max(1.0, float(hectares or 1))
    half_side_meters = max(110.0, ((hectares * 10000) ** 0.5) / 2.0) * max(1.0, float(expansion or 1.0))
    lat_delta = half_side_meters / 111320
    lon_delta = half_side_meters / (111320 * max(0.2, abs(math.cos((lat * math.pi) / 180))))
    return [lon - lon_delta, lat - lat_delta, lon + lon_delta, lat + lat_delta]


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


def build_plot_aoi(plot):
    geometry = normalize_polygon_geometry(plot.get("geometry"))
    if geometry:
        return geometry
    bbox = build_plot_bbox(plot)
    if not bbox:
        return None
    min_lon, min_lat, max_lon, max_lat = bbox
    return {
        "type": "Polygon",
        "coordinates": [[
            [min_lon, min_lat],
            [max_lon, min_lat],
            [max_lon, max_lat],
            [min_lon, max_lat],
            [min_lon, min_lat],
        ]],
    }


def build_plot_for_suggestion(payload, user):
    lat_value = payload.get("lat")
    lon_value = payload.get("lon")
    center = {
        "lat": float(lat_value) if lat_value not in (None, "") else 0.0,
        "lon": float(lon_value) if lon_value not in (None, "") else 0.0,
    }
    geometry = normalize_polygon_geometry(payload.get("geometry"))
    if geometry:
        centroid = centroid_from_geometry(geometry)
        if centroid:
            center = centroid
    return {
        "id": "PLOT-SUGGESTION",
        "name": str(payload.get("plotName") or "Area em edicao").strip() or "Area em edicao",
        "farmName": str(payload.get("farmName") or user.get("farmName") or "Fazenda").strip() or "Fazenda",
        "crop": str(payload.get("crop") or "Soja").strip() or "Soja",
        "hectares": max(1, int(float(payload.get("hectares", 0) or 0) or 1)),
        "municipality": str(payload.get("municipality") or "").strip(),
        "center": center,
        "geometry": geometry,
        "agronomist": user.get("name", ""),
        "whatsapp": user.get("whatsapp", ""),
        "notes": str(payload.get("notes") or "").strip(),
    }


def enrich_snapshot_visual(plot, snapshot):
    live_preview = REGISTRY.satellite_images.fetch_preview(plot, snapshot)
    if live_preview:
        snapshot.update(live_preview)
    live_stats = REGISTRY.satellite_images.fetch_ndvi_stats(plot, snapshot)
    if live_stats:
        previous_ndvi = float(snapshot.get("ndvi", live_stats["meanNdvi"]))
        snapshot["ndvi"] = live_stats["meanNdvi"]
        snapshot["delta"] = round(snapshot["ndvi"] - previous_ndvi, 2)
        snapshot["ndviStats"] = live_stats
        snapshot["analysisSource"] = "Sentinel-2 L2A via Sentinel Hub"
        snapshot["imageMode"] = "real-preview"
        if snapshot["ndvi"] < 0.52:
            snapshot["status"] = "red"
        elif snapshot["ndvi"] < 0.68:
            snapshot["status"] = "yellow"
        else:
            snapshot["status"] = "green"
        if live_stats["sampleCount"] > 0:
            snapshot["issue"] = f"NDVI medio real calculado com {live_stats['sampleCount']} pixels validos nesta cena."
        return
    snapshot.setdefault("imageDataUrl", None)
    snapshot.setdefault("ndviImageDataUrl", None)
    snapshot.setdefault("imageMode", "demo")
    snapshot.setdefault("analysisSource", "Simulacao local do CampoSat")
    snapshot.setdefault(
        "imageNote",
        "Sem credencial externa configurada, a analise segue usando o fluxo local e a imagem real aparece apenas no mapa base.",
    )
    snapshot.setdefault("ndviStats", None)


def infer_geometry_from_ndvi_mask(image_bytes, bbox, target_hectares, rgb_bytes=None):
    image = Image.open(io.BytesIO(image_bytes)).convert("L")
    width, height = image.size
    pixels = image.load()
    rgb_image = Image.open(io.BytesIO(rgb_bytes)).convert("RGBA") if rgb_bytes else None
    rgb_pixels = rgb_image.load() if rgb_image else None
    center_x = width // 2
    center_y = height // 2

    # Find the brightest usable seed close to the center so the flood fill starts inside the crop when possible.
    seed_x, seed_y = center_x, center_y
    best_value = -1
    for dy in range(-18, 19):
        for dx in range(-18, 19):
            x = min(width - 1, max(0, center_x + dx))
            y = min(height - 1, max(0, center_y + dy))
            value = int(pixels[x, y])
            distance_penalty = abs(dx) + abs(dy)
            score = value - distance_penalty * 1.2
            if score > best_value:
                best_value = score
                seed_x, seed_y = x, y

    bbox_width_m = abs(bbox[2] - bbox[0]) * 111320 * max(0.2, abs(math.cos((((bbox[1] + bbox[3]) / 2) * math.pi) / 180)))
    bbox_height_m = abs(bbox[3] - bbox[1]) * 111320
    bbox_area_ha = max(1.0, (bbox_width_m * bbox_height_m) / 10000.0)
    target_pixels = max(12, int((float(target_hectares or 1) / bbox_area_ha) * width * height))

    best_mask = None
    best_threshold = None
    best_score = None
    best_region_size = 0

    for threshold in range(210, 54, -10):
        if int(pixels[seed_x, seed_y]) < threshold:
            continue
        mask, region_size = flood_fill_region(pixels, width, height, seed_x, seed_y, threshold)
        if region_size < 10:
            continue
        relative_error = abs(region_size - target_pixels) / max(1, target_pixels)
        compactness_penalty = region_edge_penalty(mask, width, height)
        score = relative_error + compactness_penalty
        if best_score is None or score < best_score:
            best_score = score
            best_mask = mask
            best_threshold = threshold
            best_region_size = region_size

    if not best_mask:
        return None, {"reason": "no-crop-region"}

    polygon = radial_polygon_from_mask(best_mask, width, height, bbox, seed_x, seed_y, pixels, rgb_pixels)
    if not polygon:
        return None, {"reason": "no-polygon"}

    diagnostics = {
        "seedPixel": [seed_x, seed_y],
        "seedValue": int(pixels[seed_x, seed_y]),
        "threshold": int(best_threshold),
        "targetPixels": int(target_pixels),
        "regionPixels": int(best_region_size),
        "bboxAreaHa": round(bbox_area_ha, 1),
        "edgeMode": "vegetation-and-texture" if rgb_pixels else "vegetation-only",
    }
    return polygon, diagnostics


def flood_fill_region(pixels, width, height, seed_x, seed_y, threshold):
    queue = [(seed_x, seed_y)]
    visited = set()
    region = set()
    while queue:
        x, y = queue.pop()
        if (x, y) in visited:
            continue
        visited.add((x, y))
        if x < 0 or y < 0 or x >= width or y >= height:
            continue
        if int(pixels[x, y]) < threshold:
            continue
        region.add((x, y))
        queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return region, len(region)


def region_edge_penalty(mask, width, height):
    if not mask:
        return 1.0
    touches_edge = sum(
        1
        for x, y in mask
        if x in (0, width - 1) or y in (0, height - 1)
    )
    return min(0.6, touches_edge / max(1, len(mask)))


def rgba_luma(pixel):
    red, green, blue = float(pixel[0]), float(pixel[1]), float(pixel[2])
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def radial_polygon_from_mask(mask, width, height, bbox, seed_x, seed_y, ndvi_pixels, rgb_pixels):
    if not mask:
        return None
    average_x = sum(x for x, _ in mask) / len(mask)
    average_y = sum(y for _, y in mask) / len(mask)
    max_radius = int(math.hypot(width, height))
    points = []
    for angle_index in range(24):
        angle = (2 * math.pi * angle_index) / 24.0
        last_inside = None
        best_point = None
        best_score = -1.0
        inside_run = 0
        for radius in range(2, max_radius):
            prev_x = int(round(seed_x + math.cos(angle) * (radius - 1)))
            prev_y = int(round(seed_y + math.sin(angle) * (radius - 1)))
            x = int(round(average_x + math.cos(angle) * radius))
            y = int(round(average_y + math.sin(angle) * radius))
            if x < 0 or y < 0 or x >= width or y >= height or (x, y) not in mask:
                if inside_run > 5:
                    break
                continue
            if prev_x < 0 or prev_y < 0 or prev_x >= width or prev_y >= height:
                break
            last_inside = (x, y)
            inside_run += 1

            ndvi_now = int(ndvi_pixels[x, y])
            ndvi_prev = int(ndvi_pixels[prev_x, prev_y])
            ndvi_drop = max(0.0, (ndvi_prev - ndvi_now) / 255.0)

            rgb_contrast = 0.0
            if rgb_pixels:
                rgb_now = rgba_luma(rgb_pixels[x, y])
                rgb_prev = rgba_luma(rgb_pixels[prev_x, prev_y])
                rgb_contrast = abs(rgb_now - rgb_prev) / 255.0

            ahead_x = int(round(seed_x + math.cos(angle) * (radius + 2)))
            ahead_y = int(round(seed_y + math.sin(angle) * (radius + 2)))
            boundary_bonus = 0.0
            if ahead_x < 0 or ahead_y < 0 or ahead_x >= width or ahead_y >= height or (ahead_x, ahead_y) not in mask:
                boundary_bonus = 0.42

            distance_bias = (radius / max_radius) * 0.12
            score = (rgb_contrast * 0.9) + (ndvi_drop * 1.25) + boundary_bonus + distance_bias
            if score > best_score:
                best_score = score
                best_point = (x, y)

        chosen = best_point or last_inside
        if chosen:
            points.append(pixel_to_lnglat(chosen[0], chosen[1], width, height, bbox))
    deduped = []
    for point in points:
        if not deduped or abs(point[0] - deduped[-1][0]) > 1e-6 or abs(point[1] - deduped[-1][1]) > 1e-6:
            deduped.append(point)
    if len(deduped) < 5:
        return None
    return {"type": "Polygon", "coordinates": [_close_ring(deduped)]}


def pixel_to_lnglat(x, y, width, height, bbox):
    min_lon, min_lat, max_lon, max_lat = bbox
    lon = min_lon + (x / max(1, width - 1)) * (max_lon - min_lon)
    lat = max_lat - (y / max(1, height - 1)) * (max_lat - min_lat)
    return [round(lon, 6), round(lat, 6)]


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
            self.send_json(
                {
                    "ok": True,
                    "time": now_label(),
                    "integrations": {
                        "sentinelHubConfigured": REGISTRY.satellite_images.enabled,
                        "envFilePresent": ENV_PATH.exists(),
                    },
                }
            )
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

        if parsed.path == "/api/market":
            user = self.require_user()
            if not user:
                return
            market_feed = REGISTRY.market.fetch_market_feed()
            if market_feed:
                self.send_json(market_feed)
                return

            seed_market = seed_market_snapshot()
            fallback_items = [
                {
                    "slug": "soy",
                    "category": "sales",
                    "label": seed_market["soy"]["label"],
                    "available": True,
                    "price": seed_market["soy"]["price"],
                    "change": seed_market["soy"]["change"],
                    "referenceLabel": "Referencia local",
                    "periodLabel": seed_market.get("updatedAt", now_label()),
                    "summary": "A fonte externa nao respondeu nesta tentativa, entao mantivemos a ultima referencia local.",
                    "source": seed_market["soy"]["source"],
                    "sourceMode": "fallback",
                    "history": [],
                    "unitLabel": "por saca de 60 kg",
                },
                {
                    "slug": "corn",
                    "category": "sales",
                    "label": seed_market["corn"]["label"],
                    "available": True,
                    "price": seed_market["corn"]["price"],
                    "change": seed_market["corn"]["change"],
                    "referenceLabel": "Referencia local",
                    "periodLabel": seed_market.get("updatedAt", now_label()),
                    "summary": "A fonte externa nao respondeu nesta tentativa, entao mantivemos a ultima referencia local.",
                    "source": seed_market["corn"]["source"],
                    "sourceMode": "fallback",
                    "history": [],
                    "unitLabel": "por saca de 60 kg",
                },
                {
                    "slug": "sorghum",
                    "category": "sales",
                    "label": "Sorgo saca 60kg",
                    "available": False,
                    "note": "Ainda nao existe referencia pronta no fallback local para esse item.",
                    "source": "Fallback local do CampoSat",
                    "sourceMode": "fallback",
                    "history": [],
                    "unitLabel": "por saca de 60 kg",
                },
                {
                    "slug": "soy-seed",
                    "category": "purchases",
                    "label": "Semente de soja",
                    "available": False,
                    "note": "As compras dependem da leitura oficial da Conab para aparecer aqui.",
                    "source": "Fallback local do CampoSat",
                    "sourceMode": "fallback",
                    "history": [],
                    "unitLabel": "por kg",
                },
                {
                    "slug": "corn-seed",
                    "category": "purchases",
                    "label": "Semente de milho",
                    "available": False,
                    "note": "As compras dependem da leitura oficial da Conab para aparecer aqui.",
                    "source": "Fallback local do CampoSat",
                    "sourceMode": "fallback",
                    "history": [],
                    "unitLabel": "por kg",
                },
                {
                    "slug": "urea",
                    "category": "purchases",
                    "label": "Ureia",
                    "available": False,
                    "note": "As compras dependem da leitura oficial da Conab para aparecer aqui.",
                    "source": "Fallback local do CampoSat",
                    "sourceMode": "fallback",
                    "history": [],
                    "unitLabel": "por kg",
                },
                {
                    "slug": "map-fertilizer",
                    "category": "purchases",
                    "label": "MAP",
                    "available": False,
                    "note": "As compras dependem da leitura oficial da Conab para aparecer aqui.",
                    "source": "Fallback local do CampoSat",
                    "sourceMode": "fallback",
                    "history": [],
                    "unitLabel": "por kg",
                },
                {
                    "slug": "potassium-chloride",
                    "category": "purchases",
                    "label": "Cloreto de potassio",
                    "available": False,
                    "note": "As compras dependem da leitura oficial da Conab para aparecer aqui.",
                    "source": "Fallback local do CampoSat",
                    "sourceMode": "fallback",
                    "history": [],
                    "unitLabel": "por kg",
                },
            ]
            self.send_json(
                {
                    "title": "Mercado em Goias",
                    "description": "A rota do Mercado tentou usar a fonte oficial e caiu para o fallback local nesta rodada.",
                    "coverageLabel": "Goias",
                    "coverageNote": "Por enquanto, a aba acompanha apenas referencias de Goias.",
                    "sourceLabel": "Fallback local do CampoSat",
                    "sourceNote": "Quando a fonte externa da Conab nao responde, o backend entrega as referencias locais para manter a aba usavel.",
                    "sourceMode": "fallback",
                    "updatedAt": now_label(),
                    "items": fallback_items,
                    "overview": REGISTRY.market.snapshot(seed_market),
                }
            )
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

        if parsed.path == "/api/suggest-geometry":
            plot = build_plot_for_suggestion(payload, user)
            suggestion = REGISTRY.satellite_images.suggest_geometry(plot)
            if suggestion.get("ok"):
                self.send_json(
                    {
                        "geometry": suggestion["geometry"],
                        "suggestion": suggestion.get("diagnostics", {}),
                    }
                )
                return
            self.send_json(
                {
                    "geometry": None,
                    "suggestion": {
                        "mode": "fallback-local",
                        "reason": suggestion.get("reason", "unavailable"),
                        "source": "Fluxo local do CampoSat",
                    },
                }
            )
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
