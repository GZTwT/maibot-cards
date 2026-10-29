"""内置牌桌服务：插件自己拉起打包好的 Node 服务，装完插件就能开桌。

只有 `base_url` 留空时才用；填了外部地址（例如 docker 里的 bisca 容器）就完全走外部。
端口、internal_key、登录密码都在这里自己管，起不来只降级并在群里报错，不拖垮插件。
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import sys
from collections import deque
from pathlib import Path

import aiohttp

_HERE = Path(__file__).resolve().parent
_SERVER_JS = _HERE / "bisca_server" / "cards" / "server.cjs"
_START_TIMEOUT = 30.0


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _node_exe(custom: str) -> str:
    """找 node：配置项 -> PATH -> nodejs-wheel-binaries -> 当前 venv。"""
    if custom and Path(custom).exists():
        return custom
    found = shutil.which("node")
    if found:
        return found
    exe = "node.exe" if os.name == "nt" else "node"
    cands = [Path(sys.executable).parent / exe]
    try:
        import nodejs_wheel  # type: ignore[import-not-found]

        root = Path(nodejs_wheel.__file__).resolve().parent
        cands.append(root / exe if os.name == "nt" else root / "bin" / exe)
    except Exception:  # noqa: BLE001 - 没装这个包就试下一个候选
        pass
    for cand in cands:
        if cand.exists():
            return str(cand)
    raise RuntimeError(
        "找不到 node 运行时：请在配置里填 node_path，或安装依赖 nodejs-wheel-binaries"
    )


class LocalServer:
    """打包在插件里的牌桌服务进程。"""

    def __init__(
        self,
        data_dir: Path,
        *,
        port: int = 0,
        password: str = "",
        chat_port: int = 8098,
        node_path: str = "",
        logger=None,
    ) -> None:
        self._data = Path(data_dir)
        self._want_port = port
        self._password_override = password
        self._chat_port = chat_port
        self._node_path = node_path
        self._logger = logger
        self._port = 0
        self._key = ""
        self._proc: asyncio.subprocess.Process | None = None
        self._pump_task: asyncio.Task | None = None
        self._tail: deque[str] = deque(maxlen=12)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._port}" if self._port else ""

    @property
    def internal_key(self) -> str:
        return self._key

    def running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def start(self) -> str:
        if self.running():
            return self.url
        if not _SERVER_JS.exists():
            raise RuntimeError(f"内置牌桌服务文件缺失：{_SERVER_JS}")
        self._key = self._ensure_config()
        self._port = self._want_port or _free_port()
        node = _node_exe(self._node_path)
        env = dict(os.environ)
        env.update({
            "PORT": str(self._port),
            "HOST": "127.0.0.1",
            "BISCA_DATA_DIR": str(self._data),
            "BISCA_PASSWORD": self._ensure_password(),
            "MAIBOT_CHAT_URL": f"http://127.0.0.1:{self._chat_port}",
            "MAIBOT_AGENT_URL": f"http://127.0.0.1:{self._chat_port}/bisca/move",
            "MAIBOT_AGENT_KEY": self._key,
        })
        self._tail.clear()
        self._proc = await asyncio.create_subprocess_exec(
            node,
            str(_SERVER_JS),
            cwd=str(_SERVER_JS.parent),
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        self._pump_task = asyncio.create_task(self._pump())
        try:
            await self._wait_ready()
        except Exception:
            await self.stop()
            raise
        self._note(f"bisca 内置服务已启动 {self.url}，数据目录 {self._data}")
        return self.url

    async def stop(self) -> None:
        proc, self._proc = self._proc, None
        pump, self._pump_task = self._pump_task, None
        if pump is not None:
            pump.cancel()
        if proc is None or proc.returncode is not None:
            return
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()

    def _note(self, msg: str) -> None:
        if self._logger is not None:
            try:
                self._logger.info(msg)
            except Exception:  # noqa: BLE001 - 日志失败不影响服务
                pass

    def _ensure_config(self) -> str:
        """在服务启动前写好 internal_key，服务端会沿用；顺便拿到同一个 key。"""
        self._data.mkdir(parents=True, exist_ok=True)
        file = self._data / "config.json"
        data: dict[str, object] = {}
        if file.exists():
            try:
                loaded = json.loads(file.read_text("utf-8"))
                if isinstance(loaded, dict):
                    data = loaded
            except (OSError, ValueError):
                # 坏文件留证据，别直接覆盖用户手改过的配置
                file.replace(file.with_suffix(".json.bad"))
        key = str(data.get("internal_key") or "")
        if len(key) < 16:
            key = os.urandom(24).hex()
            data["internal_key"] = key
            file.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
        return key

    def _ensure_password(self) -> str:
        """没配密码就生成一个落盘：公网隧道出去时不能是 open mode。"""
        if self._password_override:
            return self._password_override
        file = self._data / "password.txt"
        if file.exists():
            try:
                saved = file.read_text("utf-8").strip()
                if len(saved) >= 8:
                    return saved
            except OSError:
                pass
        password = os.urandom(12).hex()
        file.write_text(password, "utf-8")
        try:
            os.chmod(file, 0o600)
        except OSError:
            pass
        return password

    async def _wait_ready(self) -> None:
        deadline = asyncio.get_running_loop().time() + _START_TIMEOUT
        timeout = aiohttp.ClientTimeout(total=2.0)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            while True:
                if self._proc is not None and self._proc.returncode is not None:
                    raise RuntimeError("内置牌桌服务退出了：" + " | ".join(self._tail))
                try:
                    async with session.get(self.url + "/cards/api/rooms") as resp:
                        if resp.status in (200, 403):
                            return
                except (aiohttp.ClientError, asyncio.TimeoutError):
                    pass
                if asyncio.get_running_loop().time() > deadline:
                    raise RuntimeError("内置牌桌服务启动超时：" + " | ".join(self._tail))
                await asyncio.sleep(0.4)

    async def _pump(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        while True:
            line = await proc.stdout.readline()
            if not line:
                return
            text = line.decode("utf-8", "ignore").strip()
            if not text:
                continue
            self._tail.append(text[:300])
            if self._logger is not None:
                self._logger.debug("bisca server: %s", text[:300])
