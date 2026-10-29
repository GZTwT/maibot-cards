"""内置服务自检：起服务 -> 开一桌 -> 校验 inviteUrl -> 关掉。

改完 bisca_server/ 或 server_runtime.py 之后跑一次：
    python maibot-plugin/tools/smoke_embed.py
"""

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import aiohttp  # noqa: E402

from server_runtime import LocalServer  # noqa: E402


async def main() -> int:
    data = Path(tempfile.mkdtemp(prefix="bisca-smoke-"))
    server = LocalServer(data, chat_port=18098)
    try:
        url = await server.start()
        assert server.internal_key, "internal_key 没生成"
        assert (data / "password.txt").exists(), "登录密码没落盘"
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                url + "/cards/api/party",
                json={"game": "zjh", "host_name": "自检", "public_url": "https://example.com"},
                headers={"x-internal-key": server.internal_key},
            ) as resp:
                body = await resp.json()
                assert resp.status == 200, f"开桌失败 HTTP {resp.status} {body}"
            invite = str(body.get("inviteUrl") or "")
            assert invite.startswith("https://example.com/cards/party.html"), invite
            # 有密码时匿名进大厅必须被挡住，否则隧道一开就是 open mode
            async with session.get(url + "/cards/api/rooms") as resp:
                assert resp.status == 403, f"没密码也能进大厅：HTTP {resp.status}"
        print("OK", url, "room", body.get("code"))
        return 0
    finally:
        await server.stop()
        shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
