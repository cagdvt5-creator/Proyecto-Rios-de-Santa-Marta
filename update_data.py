#!/usr/bin/env python3
"""Build a compact static hydrometeorological snapshot for GitHub Pages.

The browser should not download large IDEAM open-data tables directly. This script
runs in GitHub Actions, retrieves the latest records, estimates a simple response
lag when enough data are available, and writes data/latest.json.

The parser intentionally accepts changing column names because Socrata datasets
can expose localized field names. Any field it cannot identify is ignored and the
previous/demo snapshot remains usable.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "latest.json"

DATASETS = {
    "hourly_flow": "79gx-f3v5",
    "daily_flow": "jxnq-r3i9",
    "precipitation": "s54a-sgyg",
}

RIVERS = {
    "manzanares": {
        "name": "Río Manzanares",
        "flow_station": "15017060",
        "rain_stations": ["15010501", "15010010"],
        "fallback_response": [3, 6],
    },
    "gaira": {
        "name": "Río Gaira",
        "flow_station": "15017030",
        "rain_stations": ["15010010", "15017030"],
        "fallback_response": [4, 8],
    },
    "guachaca": {
        "name": "Río Guachaca",
        "flow_station": "15017040",
        "rain_stations": ["15010300", "1509500118"],
        "fallback_response": [3, 7],
    },
}


def http_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "pulso-hidrico-santa-marta/2.0"})
    with urllib.request.urlopen(req, timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


def socrata(dataset: str, query: str, limit: int = 5000):
    params = {
        "$q": query,
        "$limit": str(limit),
    }
    url = f"https://www.datos.gov.co/resource/{dataset}.json?{urllib.parse.urlencode(params)}"
    return http_json(url)


def pick_key(row: dict, patterns: list[str]):
    lowered = {str(k).lower(): k for k in row}
    for pattern in patterns:
        for key_lower, original in lowered.items():
            if pattern in key_lower:
                return original
    return None


def as_float(value):
    if value is None or value == "":
        return None
    try:
        return float(str(value).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None


def as_datetime(row: dict):
    key = pick_key(row, [
        "fecha_hora", "fecha y hora", "datetime", "timestamp", "fecha", "date", "tiempo", "hora"
    ])
    if key is None:
        # Fallback: first ISO/date-like string.
        for k, value in row.items():
            s = str(value)
            if re.search(r"20\d\d[-/]\d\d[-/]\d\d", s):
                key = k
                break
    if key is None:
        return None
    raw = str(row[key]).strip()
    if not raw:
        return None
    raw = raw.replace("Z", "+00:00")
    for candidate in (raw, raw.split(".")[0]):
        try:
            d = datetime.fromisoformat(candidate)
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            return d.astimezone(timezone.utc)
        except ValueError:
            pass
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw[:10], fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def numeric_measure(row: dict, patterns: list[str]):
    key = pick_key(row, patterns)
    if key is not None:
        return as_float(row[key])
    # fallback to a numeric column with a measurement-like name
    for k, value in row.items():
        if any(p in str(k).lower() for p in patterns):
            n = as_float(value)
            if n is not None:
                return n
    return None


def station_text(row: dict):
    parts = []
    for k, value in row.items():
        lk = str(k).lower()
        if any(p in lk for p in ("estacion", "station", "nombre", "codigo", "corriente", "rio", "cauce")):
            parts.append(str(value))
    return " | ".join(parts).upper()


def parse_flow(rows, station_code: str):
    parsed = []
    for row in rows:
        text = station_text(row)
        if station_code not in text and text and station_code[-4:] not in text:
            continue
        when = as_datetime(row)
        flow = numeric_measure(row, ["caudal", "q_media", "q_medio", "q", "flow"])
        if when and flow is not None:
            parsed.append((when, flow))
    parsed.sort(key=lambda x: x[0])
    return parsed


def parse_rain(rows, station_codes: list[str]):
    parsed = []
    for row in rows:
        text = station_text(row)
        if station_codes and not any(code in text or code[-4:] in text for code in station_codes):
            continue
        when = as_datetime(row)
        rain = numeric_measure(row, ["precipitacion", "precipitación", "lluvia", "valor", "precip"])
        if when and rain is not None:
            parsed.append((when, rain))
    parsed.sort(key=lambda x: x[0])
    return parsed


def safe_latest(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {
            "version": 2,
            "generated_at": None,
            "status": "DEMO",
            "hydrology": {},
            "rainfall": {},
            "forecast": {},
        }


def daily_values(series):
    buckets = defaultdict(list)
    for when, value in series:
        buckets[when.date().isoformat()].append(value)
    return {day: sum(vals) / len(vals) for day, vals in buckets.items()}


def estimate_daily_lag(flow_series, rain_series):
    """Very small transparent model: lag with strongest correlation between rain and next-day flow change.

    It intentionally returns None rather than invent a result when there is not enough overlap.
    """
    if len(flow_series) < 20 or len(rain_series) < 20:
        return None
    flow_daily = daily_values(flow_series)
    rain_daily = daily_values(rain_series)
    common = sorted(set(flow_daily) & set(rain_daily))
    if len(common) < 14:
        return None

    x = [rain_daily[d] for d in common]
    flow = [flow_daily[d] for d in common]
    # Use day-to-day flow changes; correlate with rainfall on previous days.
    changes = [flow[i] - flow[i - 1] for i in range(1, len(flow))]
    days = common[1:]
    best = None
    for lag_days in range(0, 4):
        pairs = []
        for idx, day in enumerate(days):
            source_idx = idx - lag_days
            if source_idx >= 0:
                pairs.append((x[source_idx], changes[idx]))
        if len(pairs) < 10:
            continue
        a = [p[0] for p in pairs]
        b = [p[1] for p in pairs]
        ma = sum(a) / len(a)
        mb = sum(b) / len(b)
        va = sum((v - ma) ** 2 for v in a)
        vb = sum((v - mb) ** 2 for v in b)
        if va <= 0 or vb <= 0:
            continue
        corr = sum((a[i] - ma) * (b[i] - mb) for i in range(len(a))) / math.sqrt(va * vb)
        score = abs(corr)
        if best is None or score > best[0]:
            best = (score, lag_days)
    if not best or best[0] < 0.2:
        return None
    center = best[1] * 24
    return {
        "responseMin": max(1, center - 6),
        "responseMax": center + 6,
        "correlation": round(best[0], 2),
        "resolution": "daily",
    }


def fetch_forecast():
    url = (
        "https://api.open-meteo.com/v1/forecast?"
        "latitude=11.2408&longitude=-74.2110&timezone=America%2FBogota&"
        "forecast_days=3&past_days=1&"
        "hourly=precipitation,precipitation_probability,rain,temperature_2m&"
        "current=precipitation,rain,temperature_2m"
    )
    data = http_json(url)
    hourly = data.get("hourly", {})
    times = hourly.get("time", [])
    precip = hourly.get("precipitation", [])
    now = datetime.now(timezone.utc).timestamp()
    last24 = 0.0
    next24 = 0.0
    for t, p in zip(times, precip):
        try:
            dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
            ts = dt.timestamp()
        except ValueError:
            continue
        p = as_float(p) or 0.0
        if now - 24 * 3600 < ts <= now:
            last24 += p
        if now < ts <= now + 24 * 3600:
            next24 += p
    return {
        "next24_mm": round(next24, 1),
        "last24_mm": round(last24, 1),
        "source": "Open-Meteo",
        "hourly": {"time": times, "precipitation": precip, "probability": hourly.get("precipitation_probability", [])},
    }


def main():
    previous = safe_latest(OUT)
    previous_hydro = previous.get("hydrology", {})
    updated = {
        **previous,
        "version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "PARTIAL",
        "sources": {
            "hydrology": "IDEAM / Datos Abiertos Colombia",
            "weather": "Open-Meteo",
        },
    }

    any_live = False
    for key, cfg in RIVERS.items():
        station = cfg["flow_station"]
        rows = []
        try:
            rows = socrata(DATASETS["hourly_flow"], station, 5000)
        except Exception as e:
            print(f"WARN hourly flow {key}: {e}")
        if not rows:
            try:
                rows = socrata(DATASETS["daily_flow"], station, 5000)
            except Exception as e:
                print(f"WARN daily flow {key}: {e}")
        flow_series = parse_flow(rows, station)
        item = dict(previous_hydro.get(key, {}))
        if flow_series:
            latest_dt, latest_value = flow_series[-1]
            prev_value = flow_series[-2][1] if len(flow_series) > 1 else latest_value
            delta_pct = ((latest_value - prev_value) / prev_value * 100) if prev_value else 0.0
            item.update({
                "name": cfg["name"],
                "flow": round(latest_value, 3),
                "delta_pct": round(delta_pct, 2),
                "date": latest_dt.isoformat(),
                "source": "IDEAM",
                "station": station,
            })
            any_live = True

            rain_rows = []
            for rain_station in cfg["rain_stations"]:
                try:
                    rain_rows.extend(socrata(DATASETS["precipitation"], rain_station, 3000))
                except Exception as e:
                    print(f"WARN rain {key} {rain_station}: {e}")
            rain_series = parse_rain(rain_rows, cfg["rain_stations"])
            calibration = estimate_daily_lag(flow_series, rain_series)
            if calibration:
                item.update({"calibrated": True, **calibration, "calibrationNote": "Estimación automática a partir de la correlación lluvia–cambio de caudal en datos diarios."})
            else:
                item.update({"calibrated": False, "responseMin": cfg["fallback_response"][0], "responseMax": cfg["fallback_response"][1], "calibrationNote": "Sin suficientes datos coincidentes para calibración automática."})
        updated["hydrology"][key] = item

    try:
        weather = fetch_forecast()
        updated["rainfall"]["santa_marta"] = {"last24_mm": weather["last24_mm"], "source": "Open-Meteo"}
        updated["forecast"] = {"next24_mm": weather["next24_mm"], "source": "Open-Meteo", "hourly": weather["hourly"]}
        any_live = True
    except Exception as e:
        print(f"WARN weather: {e}")

    updated["status"] = "LIVE" if any_live else "DEMO"
    OUT.write_text(json.dumps(updated, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUT} status={updated['status']}")


if __name__ == "__main__":
    main()
