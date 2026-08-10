import ipaddress
import os

import geoip2.database
import geoip2.errors

from app.core.config import settings

_reader: "geoip2.database.Reader | None" = None
_reader_checked = False


def _get_reader():
    """Lazily opens the local MaxMind GeoLite2 database — a live third-party geolocation
    API would work too, but this avoids sending candidate IPs to yet another external
    service and avoids a per-lookup network dependency. No-ops (returns None) if the
    database isn't configured rather than failing the request it's called from."""
    global _reader, _reader_checked
    if _reader_checked:
        return _reader
    _reader_checked = True
    if settings.geoip_db_path and os.path.exists(settings.geoip_db_path):
        try:
            _reader = geoip2.database.Reader(settings.geoip_db_path)
        except Exception:
            _reader = None
    return _reader


def resolve_region(ip: str | None) -> str | None:
    """Best-effort 'City, Country' lookup. Returns None if the database isn't configured,
    the IP is private/local (dev/loopback), or the address can't be resolved — callers must
    treat None as "no signal," never as a mismatch."""
    if not ip:
        return None
    reader = _get_reader()
    if reader is None:
        return None
    try:
        if ipaddress.ip_address(ip).is_private:
            return None
        response = reader.city(ip)
        parts = [p for p in (response.city.name, response.country.name) if p]
        return ", ".join(parts) or None
    except (ValueError, geoip2.errors.AddressNotFoundError, geoip2.errors.GeoIP2Error):
        return None


def is_location_mismatch(resolved_region: str | None, stated_location: str | None) -> bool:
    """True only on a clear disjoint mismatch — IP geolocation is inherently approximate
    (VPNs, mobile carriers, corporate NAT), so this must stay a soft/reviewable signal, never
    a hard rule. Same substring-overlap tolerance as knockout.py's location check, since
    resolved regions and resume-stated locations rarely match exactly
    (e.g. "Bengaluru, India" vs "Bangalore")."""
    if not resolved_region or not stated_location:
        return False

    resolved_parts = [p.strip().lower() for p in resolved_region.split(",") if p.strip()]
    stated_parts = [p.strip().lower() for p in stated_location.split(",") if p.strip()]
    if not resolved_parts or not stated_parts:
        return False

    return not any(r in s or s in r for r in resolved_parts for s in stated_parts)
