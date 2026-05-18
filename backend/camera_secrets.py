"""
Local RTSP camera credentials and single-frame capture.

Requires ``ffmpeg`` on PATH. Replace host, path, and credentials for your network;
do not ship real credentials in source for anything beyond local demos.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from urllib.parse import quote

logger = logging.getLogger(__name__)

# --- Local network Tapo fixture — change for your network ---
RTSP_HOST = "10.0.0.218"
RTSP_PORT = 554
RTSP_USER = "tapo_camera_001"
RTSP_PASS = "test12345"  # noqa: S105 — intentional demo secret per product request
# Tapo often exposes /stream1 (main) or /stream2 (sub); stream2 confirmed working on demo LAN.
RTSP_PATH = "/stream2"


def rtsp_url() -> str:
    u = quote(RTSP_USER, safe="")
    p = quote(RTSP_PASS, safe="")
    return f"rtsp://{u}:{p}@{RTSP_HOST}:{RTSP_PORT}{RTSP_PATH}"


def grab_rtsp_frame_png(timeout_sec: float = 15.0) -> bytes:
    """
    Capture one PNG frame from RTSP via ffmpeg (stdout).
    Raises RuntimeError on failure (missing ffmpeg, connection, wrong path).
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not installed or not on PATH — required for RTSP capture.")

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        "tcp",
        "-i",
        rtsp_url(),
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "-",
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout_sec + 8.0,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Timed out waiting for a frame from the camera.") from exc

    if proc.returncode != 0 or not proc.stdout:
        err = (proc.stderr or b"").decode("utf-8", errors="replace")[:500]
        logger.warning("ffmpeg RTSP failed rc=%s stderr=%s", proc.returncode, err)
        raise RuntimeError(
            "Could not read a frame from the camera. Check RTSP URL, path (/stream1 vs /stream2), "
            "and that this machine can reach the camera on the LAN."
        )
    n = len(proc.stdout)
    logger.info(
        "camera_secrets: RTSP frame captured ok host=%s path=%s png_bytes=%s",
        RTSP_HOST,
        RTSP_PATH,
        n,
    )
    return proc.stdout


async def grab_rtsp_frame_png_async(timeout_sec: float = 15.0) -> bytes:
    return await asyncio.to_thread(grab_rtsp_frame_png, timeout_sec)
