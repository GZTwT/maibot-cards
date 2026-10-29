"""按需起 cloudflared 快速隧道，给群友一个能点开的 https 地址。

只做三件事：确保 cloudflared 在跑、从日志里抓出 https://xxx.trycloudflare.com、
闲置一段时间后自己关掉。找不到二进制会自动下载到 /tmp，装完插件不用手动准备。
隧道挂了下次开桌会自动重启换新地址。
"""

from __future__ import annotations

import asyncio
import os
import platform
import re
import shutil
from pathlib import Path

import aiohttp

_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
_RUNTIME_BIN = "/tmp/bisca-cloudflared"
_DOWNLOAD = "https://github.com/cloudflare/cloudflared/releases/latest/download/"
# 老部署手动放好的二进制，有就先用它，别白下载一遍
_BUNDLED_BIN = Path(__file__).resolve().parent / "bin" / "cloudflared-linux-amd64"


def _asset_name() -> str:
    arch = platform.machine().lower()
    arch = "arm64" if arch in ("aarch64", "arm64") else "amd64"
    if os.name == "nt":
        return f"cloudflared-windows-{arch}.exe"
    if platform.system() == "Darwin":
        return f"cloudflared-darwin-{arch}.tgz"
    return f"cloudflared-linux-{arch}"


class Tunnel:
    def __init__(
        self,
        target: str,
        bin_path: str = "",
        idle_seconds: float = 1800.0,
        logger=None,
    ) -> None:
        self._target = target
        self._bin = bin_path
        self._idle = max(60.0, float(idle_seconds))
        self._log = logger
        self._proc: asyncio.subprocess.Process | None = None
        self._url = ""
        self._last_used = 0.0
        self._lock = asyncio.Lock()
        self._watch: asyncio.Task | None = None

    def _note(self, msg: str) -> None:
        if self._log is not None:
            try:
                self._log.info(msg)
            except Exception:  # noqa: BLE001 - 日志失败不影响隧道
                pass

    async def _ensure_exe(self) -> str:
        """返回可执行的 cloudflared：优先用现成的，没有就下载到 /tmp。"""
        if os.access(_RUNTIME_BIN, os.X_OK):
            return _RUNTIME_BIN
        bin_path = self._bin or (str(_BUNDLED_BIN) if _BUNDLED_BIN.exists() else "")
        if bin_path:
            if not os.path.exists(bin_path):
                raise RuntimeError(f"配置的 cloudflared 路径不存在：{bin_path}")
            # 插件目录在 Windows 盘上，没执行位；复制到 /tmp 再 chmod。
            shutil.copyfile(bin_path, _RUNTIME_BIN)
            os.chmod(_RUNTIME_BIN, 0o755)
            return _RUNTIME_BIN
        await self._download()
        return _RUNTIME_BIN

    async def _download(self) -> None:
        url = _DOWNLOAD + _asset_name()
        if url.endswith(".tgz"):
            raise RuntimeError("macOS 请先解包 cloudflared 并在配置里填 cloudflared_path")
        self._note("下载 cloudflared：" + url)
        tmp = _RUNTIME_BIN + ".part"
        timeout = aiohttp.ClientTimeout(total=180.0)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"cloudflared 下载失败 HTTP {resp.status}")
                with open(tmp, "wb") as fh:
                    async for chunk in resp.content.iter_chunked(1 << 16):
                        fh.write(chunk)
        os.chmod(tmp, 0o755)
        os.replace(tmp, _RUNTIME_BIN)

    async def url(self) -> str:
        """返回可用地址；隧道没起/已死就重起。失败抛 RuntimeError。"""
        async with self._lock:
            if self._proc is not None and self._proc.returncode is None and self._url:
                self._last_used = asyncio.get_running_loop().time()
                return self._url
            await self._stop_locked()
            self._proc = await asyncio.create_subprocess_exec(
                await self._ensure_exe(),
                "tunnel",
                "--url",
                self._target,
                "--no-autoupdate",
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                url = await asyncio.wait_for(self._read_url(), timeout=45.0)
            except Exception:
                await self._stop_locked()
                raise
            self._url = url
            self._last_used = asyncio.get_running_loop().time()
            self._watch = asyncio.create_task(self._idle_watch())
            self._note("bisca tunnel up: " + url)
            return url

    async def _read_url(self) -> str:
        assert self._proc is not None and self._proc.stderr is not None
        while True:
            line = await self._proc.stderr.readline()
            if not line:
                raise RuntimeError("cloudflared 退出了，没拿到隧道地址")
            found = _URL_RE.search(line.decode("utf-8", "ignore"))
            if found:
                return found.group(0)

    async def _idle_watch(self) -> None:
        loop = asyncio.get_running_loop()
        try:
            while True:
                await asyncio.sleep(60)
                if loop.time() - self._last_used > self._idle:
                    self._note("bisca tunnel idle, closing")
                    await self.stop()
                    return
        except asyncio.CancelledError:
            return

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_locked()

    async def _stop_locked(self) -> None:
        if self._watch is not None:
            self._watch.cancel()
            self._watch = None
        proc, self._proc = self._proc, None
        self._url = ""
        if proc is not None and proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                proc.kill()
