"""在群聊里发“uno / 炸金花 / 斗地主”，MaiBot 开桌并回一条入桌链接。

服务端会固定给 MaiBot 留一个自动出牌座位。本插件只负责开桌和发链接，
不参与出牌，也不派生玩家 token。
"""

from __future__ import annotations

import asyncio
import hmac
import json
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp
from aiohttp import web

from maibot_sdk import Command, HookHandler, MaiBotPlugin
from maibot_sdk.types import ErrorPolicy, HookMode, HookOrder

from .config import BiscaPluginConfig
from .server_runtime import LocalServer
from .tunnel import Tunnel

_GAMES = {
    "uno": ("uno", "UNO", 4),
    "炸金花": ("zjh", "炸金花", 4),
    "斗地主": ("ddz", "斗地主", 3),
}
_PARTY_CMD = re.compile(
    r"^\s*(?:开始|来|开|开一局|开一桌|打|来一局|打一局|来把)?\s*"
    r"(?P<game>uno|炸金花|斗地主)\s*$",
    re.IGNORECASE,
)

# 对局策略：只在牌局进行中的模型请求里注入，局外不出现。
# 键是 engine key（ddz/zjh/uno），插件配置 [bisca.strategy_prompts] 可整条覆盖。
_DEFAULT_STRATEGY = {
    "ddz": (
        "你正在打斗地主。叫分时按手牌强度（王/2/炸弹/A）决定，不要永远不叫。"
        "只根据当前牌局选合法动作：农民不要压队友的牌，"
        "队友快走完时让队友接；跟牌出能压住的最小牌，领出先走长牌型，"
        "尽量不拆炸弹，对手只剩一两张时改用大牌压住。"
        "不要每手都出最小的牌：需要抢回出牌权时用中等牌压，残局可以留一手、"
        "换一种领出节奏，让对手猜不到。"
    ),
    "zjh": (
        "你正在打炸金花。强牌（豹子/顺金/金花）主动加注；"
        "中等牌（顺子/对子/A、K 高的散牌）可以跟或小加。"
        "跟注不超过自己筹码 5% 时至少跟一注，不要一看牌就弃；"
        "只有面对超过自己筹码 10% 的加注、且自己只是小散牌时才弃。"
        "小牌在人少、位置好时可以偶尔加注诈唬，把大牌逼走。"
        "第一圈过后，中强牌想收池时可以花当前注比牌，优先挑筹码少或闷牌的对手；"
        "弱牌不要比，强牌也不必每手都比。闷牌最多跟一两手，注额大了就看牌或弃。"
        "只输出合法动作。"
    ),
    "uno": (
        "你正在打 UNO。有能出的牌就先出，优先出功能牌或能减少手牌的花色；"
        "没牌可出才摸牌。只输出合法动作。"
    ),
}
_STRATEGY_MAX = 600
_GAME_TTL_SECONDS = 6 * 3600


class BiscaPlugin(MaiBotPlugin):
    config_model = BiscaPluginConfig

    async def on_load(self) -> None:
        self._tunnel: Tunnel | None = None
        self._tunnel_target = ""
        self._chat_runner: web.AppRunner | None = None
        # 内置牌桌服务（base_url 留空时用）；起不来只是开桌报错，插件照常加载
        self._local: LocalServer | None = None
        self._local_url = ""
        self._local_key = ""
        # stream_id -> {game, until}；只在对局进行中影响模型请求
        self._games: dict[str, dict[str, Any]] = {}
        # stream_id -> 已吐槽过的房号，避免 game_over 和关桌重复发群
        self._summary_sent: dict[str, str] = {}
        await self._start_chat_server()
        await self._sync_local_server()
        self.ctx.logger.info("maibot_cards loaded: group table links ready")

    async def on_unload(self) -> None:
        if self._chat_runner is not None:
            await self._chat_runner.cleanup()
            self._chat_runner = None
        if self._tunnel is not None:
            await self._tunnel.stop()
            self._tunnel = None
        if self._local is not None:
            await self._local.stop()
            self._local = None
            self._local_url = ""
        self.ctx.logger.info("maibot_cards unloaded")

    async def on_config_update(
        self, scope: str, config_data: dict[str, object], version: str
    ) -> None:
        del scope, config_data, version
        await self._sync_local_server()

    async def _sync_local_server(self) -> None:
        """base_url 留空就保证内置服务在跑；填了外部地址就关掉它。"""
        cfg = self._settings()
        wanted = (
            cfg is not None
            and bool(getattr(cfg, "enabled", True))
            and not str(getattr(cfg, "base_url", "") or "").strip()
        )
        if not wanted:
            if self._local is not None:
                await self._local.stop()
                self._local = None
                self._local_url = ""
            return
        if self._local is not None and self._local.running():
            return
        try:
            port = int(getattr(cfg, "server_port", 0) or 0)
        except (TypeError, ValueError):
            port = 0
        try:
            chat_port = int(getattr(cfg, "chat_port", 8098) or 8098)
        except (TypeError, ValueError):
            chat_port = 8098
        self._local = LocalServer(
            self._server_data_dir(),
            port=port if 1 <= port <= 65535 else 0,
            password=str(getattr(cfg, "password", "") or ""),
            chat_port=chat_port,
            node_path=str(getattr(cfg, "node_path", "") or "").strip(),
            logger=self.ctx.logger,
        )
        try:
            self._local_url = await self._local.start()
            self._local_key = self._local.internal_key
        except (OSError, RuntimeError) as exc:
            self._local_url = ""
            self._local_key = ""
            self.ctx.logger.error("bisca 内置服务启动失败：%s", exc)

    def _server_data_dir(self) -> Path:
        base = getattr(getattr(self.ctx, "paths", None), "data_dir", None)
        root = Path(base) if base else Path(__file__).resolve().parent / "data"
        custom = str(getattr(self._settings(), "server_data_dir", "") or "").strip()
        if custom:
            return Path(custom)
        return root / "server"

    def _settings(self) -> Any:
        return getattr(self.config, "bisca", None)

    def _base(self) -> str:
        cfg = self._settings()
        raw = str(getattr(cfg, "base_url", "") or "").strip()
        if not raw:
            return self._local_url
        # 兼容旧插件写法里带 /cards/api 的 base_url。
        return re.sub(r"/cards/api/?$", "", raw.rstrip("/"))

    def _key(self) -> str:
        # 内置服务在跑时以它自己生成的 key 为准（外部地址才用配置里的）
        if self._local_key:
            return self._local_key
        cfg = self._settings()
        return str(getattr(cfg, "internal_key", "") or "").strip() if cfg else ""

    def _mark_game(self, stream_id: str, game: str) -> None:
        key = str(stream_id or "").strip()
        if key and game:
            self._games[key] = {"game": game, "until": time.time() + _GAME_TTL_SECONDS}

    def _clear_game(self, stream_id: str) -> None:
        self._games.pop(str(stream_id or "").strip(), None)

    def _game_for(self, stream_id: str) -> str:
        rec = self._games.get(str(stream_id or "").strip())
        if not rec:
            return ""
        if float(rec.get("until") or 0) < time.time():
            self._games.pop(str(stream_id or "").strip(), None)
            return ""
        return str(rec.get("game") or "")

    def _strategy_for(self, game: str) -> str:
        cfg = self._settings()
        custom = getattr(cfg, "strategy_prompts", None) if cfg is not None else None
        if isinstance(custom, dict):
            text = str(custom.get(game) or "").strip()
            if text:
                return text[:_STRATEGY_MAX]
        return _DEFAULT_STRATEGY.get(game, "")[:_STRATEGY_MAX]

    async def _create(
        self, game: str, host_name: str, public_url: str = "", stream_id: str = ""
    ) -> dict[str, Any]:
        cfg = self._settings()
        if cfg is None or not cfg.enabled:
            raise RuntimeError("群聊开桌功能已在插件配置里关闭")
        base = self._base()
        key = self._key()
        if not base or not key:
            raise RuntimeError(
                "牌桌服务不可用：base_url 留空时会自动起内置服务，起不来请看日志里的"
                "「bisca 内置服务启动失败」；用外部服务则要填 base_url 和 internal_key"
            )
        try:
            timeout = max(3.0, min(float(getattr(cfg, "request_timeout", 10.0)), 30.0))
        except (TypeError, ValueError):
            timeout = 10.0

        headers = {"content-type": "application/json", "x-internal-key": key}
        body = {"game": game, "host_name": host_name or "群友"}
        if stream_id:
            body["stream_id"] = stream_id
        public = (
            public_url or str(getattr(cfg, "public_url", "") or "")
        ).strip().rstrip("/")
        if not public and bool(getattr(cfg, "tunnel_enabled", True)):
            public = await self._tunnel_url(base, cfg)
        if public:
            body["public_url"] = public
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=timeout)
        ) as session:
            async with session.post(
                base + "/cards/api/party", json=body, headers=headers
            ) as resp:
                raw = await resp.text()
                if resp.status != 200:
                    detail = raw.strip().replace("\n", " ")[:120]
                    raise RuntimeError(f"Bisca 开桌失败 HTTP {resp.status} {detail}")
                try:
                    data = json.loads(raw)
                except ValueError as exc:
                    raise RuntimeError("Bisca 返回的不是 JSON") from exc
        if not isinstance(data, dict) or not data.get("inviteUrl"):
            raise RuntimeError("Bisca 没有返回入桌链接")
        return data

    async def _password_required(self, base: str) -> bool:
        """公网放出去之前确认 Bisca 设了密码：没凭证访问大厅应当 403。"""
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=5.0)
            ) as session:
                async with session.get(base + "/cards/api/rooms") as resp:
                    return resp.status == 403
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
            self.ctx.logger.warning("bisca auth probe failed: %s", exc)
            return False

    def _rooms_path(self) -> Path | None:
        """每个群最近开的桌记在这，插件重启后也还能关。"""
        base = getattr(getattr(self.ctx, "paths", None), "data_dir", None)
        return Path(base) / "last_rooms.json" if base else None

    def _remember(self, group: str, code: str) -> None:
        path = self._rooms_path()
        if not path or not group or not code:
            return
        try:
            data = json.loads(path.read_text("utf-8")) if path.exists() else {}
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        data[group] = {"code": code, "at": int(time.time())}
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
        except OSError as exc:
            self.ctx.logger.warning("bisca remember room failed: %s", exc)

    def _recall(self, group: str) -> str:
        path = self._rooms_path()
        if not path or not group or not path.exists():
            return ""
        try:
            data = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            return ""
        item = data.get(group) if isinstance(data, dict) else None
        return str((item or {}).get("code") or "")

    async def _close_room(self, code: str) -> None:
        base = self._base()
        key = self._key()
        if not base or not key:
            raise RuntimeError("牌桌服务不可用，没法关桌")
        headers = {"content-type": "application/json", "x-internal-key": key}
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=10.0)
        ) as session:
            async with session.post(
                base + "/cards/api/rooms/" + code + "/close",
                json={}, headers=headers,
            ) as resp:
                if resp.status not in (200, 404):
                    detail = (await resp.text()).strip().replace("\n", " ")[:120]
                    raise RuntimeError(f"关桌失败 HTTP {resp.status} {detail}")

    async def _tunnel_url(self, base: str, cfg: Any) -> str:
        """没配固定 public_url 时，现起一条 cloudflared 隧道（缺二进制会自动下载）。"""
        try:
            minutes = float(getattr(cfg, "tunnel_idle_minutes", 30) or 30)
        except (TypeError, ValueError):
            minutes = 30.0
        if not await self._password_required(base):
            self.ctx.logger.warning(
                "Bisca 没设 BISCA_PASSWORD（open mode），拒绝开公网隧道"
            )
            return ""
        if self._tunnel is None or self._tunnel_target != base:
            self._tunnel = Tunnel(
                base,
                bin_path=str(getattr(cfg, "cloudflared_path", "") or "").strip(),
                idle_seconds=minutes * 60.0,
                logger=self.ctx.logger,
            )
            self._tunnel_target = base
        try:
            return await self._tunnel.url()
        except (OSError, RuntimeError, asyncio.TimeoutError) as exc:
            self.ctx.logger.warning("bisca tunnel failed: %s", exc)
            return ""

    async def _reply(self, text: str, stream_id: str) -> None:
        if not stream_id:
            raise RuntimeError("MaiBot 没有得到当前群聊的 stream_id")
        sent = await asyncio.wait_for(
            self.ctx.send.text(text=text, stream_id=stream_id), timeout=10.0
        )
        if sent is False:
            raise RuntimeError("MaiBot 发送群消息失败")

    # ── 牌桌聊天 / 共享记忆（给 Bisca 服务端回调）──────────────────────────
    # 端口只挂在 docker 内网，用 internal_key 鉴权；不经过公网隧道。

    @staticmethod
    def _has_marker(items: list[Any], marker: str) -> bool:
        for item in items:
            if not isinstance(item, dict):
                continue
            parts = item.get("parts")
            if not isinstance(parts, list):
                continue
            for part in parts:
                if isinstance(part, dict) and marker in str(part.get("text", "")):
                    return True
        return False

    @staticmethod
    def _inject_system(items: list[Any], text: str) -> list[dict[str, Any]]:
        updated: list[dict[str, Any]] = []
        injected = False
        for item in items:
            if not injected and isinstance(item, dict) and item.get("item_type") == "SystemMessageItem":
                parts = item.get("parts")
                if isinstance(parts, list):
                    item = dict(item)
                    item["parts"] = [*parts, {"type": "text", "text": text}]
                    injected = True
            updated.append(item)
        if not injected:
            updated.insert(0, {
                "item_type": "SystemMessageItem",
                "meta": {
                    "item_id": uuid.uuid4().hex,
                    "logical_turn_id": None,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
                "parts": [{"type": "text", "text": text}],
            })
        return updated

    @HookHandler(
        "maisaka.replyer.before_model_request",
        name="bisca_game_strategy",
        description="牌局进行中按 stream_id 注入当前游戏策略；局外不注入。",
        mode=HookMode.BLOCKING,
        order=HookOrder.LATE,
        timeout_ms=2000,
        error_policy=ErrorPolicy.SKIP,
    )
    async def inject_game_strategy(self, **kwargs: Any) -> dict[str, Any]:
        stream_id = str(kwargs.get("session_id") or "")
        game = self._game_for(stream_id)
        if not game:
            return {"action": "continue"}
        strategy = self._strategy_for(game)
        if not strategy:
            return {"action": "continue"}
        items = kwargs.get("items")
        if not isinstance(items, list) or not items:
            return {"action": "continue"}
        marker = f"[bisca-strategy:{game}]"
        if self._has_marker(items, marker):
            return {"action": "continue"}
        merged = dict(kwargs)
        merged["items"] = self._inject_system(items, f"{marker}\n{strategy}")
        self.ctx.logger.info(
            "bisca strategy injected: stream=%s game=%s", stream_id, game
        )
        return {"action": "continue", "modified_kwargs": merged}

    async def _handle_move(self, request: web.Request) -> web.Response:
        if not self._chat_authed(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"move": None, "error": "bad json"}, status=400)
        if not isinstance(data, dict):
            return web.json_response({"move": None})
        game = str(data.get("game") or "").strip().lower()
        stream_id = str(data.get("stream_id") or "").strip()
        if stream_id and game:
            self._mark_game(stream_id, game)
        lines = data.get("moveLines")
        if not isinstance(lines, list) or not lines:
            return web.json_response({"move": None, "error": "no legal moves"})
        numbered = "\n".join(
            f"p{i + 1}. {str(text)[:160]}" for i, text in enumerate(lines[:30])
        )
        briefing = str(data.get("briefing") or "")[:3000]
        game_name = str(data.get("gameName") or game or "牌局")
        strategy = self._strategy_for(game)
        hand = data.get("hand") if isinstance(data.get("hand"), dict) else {}
        tactics = data.get("tactics") if isinstance(data.get("tactics"), dict) else {}
        extra = []
        if hand:
            extra.append(
                f"当前牌力：{str(hand.get('label') or '')}"
                f"（档 {str(tactics.get('tier') or '')}）"
            )
        if tactics:
            try:
                extra.append(
                    f"底池赔率约 {float(tactics.get('odds') or 0):.2f}，"
                    f"位置 {float(tactics.get('position') or 0):.2f}"
                )
            except (TypeError, ValueError):
                pass
            opps = []
            for opp in (tactics.get("opponents") or []):
                if not isinstance(opp, dict):
                    continue
                tag = str(opp.get("name") or opp.get("id") or "")[:16]
                if opp.get("foldRate") is not None:
                    tag += f" 弃{float(opp.get('foldRate') or 0) * 100:.0f}%"
                opps.append(tag)
            if opps:
                extra.append("对手：" + " / ".join(opps))
        prompt = (
            f"你在和群友打{game_name}，现在是你的回合。\n"
            f"{strategy}\n"
            + ("\n".join(extra) + "\n" if extra else "")
            + f"牌桌简报：\n{briefing}\n"
            f"合法动作（编号）：\n{numbered}\n"
            '只输出一个 JSON：{"choice": 编号}，编号是上面的 p 后面的数字；'
            "不要解释，不要输出其他内容。"
        )
        try:
            temp = 0.4 if game == "zjh" else (0.55 if game == "ddz" else 0.3)
            out = await asyncio.wait_for(
                self.ctx.llm.generate(prompt, temperature=temp, max_tokens=80),
                timeout=8.0,
            )
        except Exception as exc:  # noqa: BLE001
            self.ctx.logger.warning("bisca move generate error: %r", exc)
            return web.json_response({"move": None, "error": "generate failed"})
        answer = ""
        if isinstance(out, dict):
            answer = str(out.get("response") or out.get("text") or "")
        match = re.search(r'"choice"\s*:\s*(\d+)', answer) or re.search(r"\b(\d+)\b", answer)
        if not match:
            return web.json_response({"move": None, "error": "no choice"})
        idx = int(match.group(1))
        if idx < 1 or idx > min(len(lines), 30):
            return web.json_response({"move": None, "error": "choice out of range"})
        self.ctx.logger.info(
            "bisca move: game=%s stream=%s choice=p%s", game, stream_id, idx
        )
        return web.json_response({"move": f"p{idx}"})

    async def _start_chat_server(self) -> None:
        cfg = self._settings()
        if cfg is None or not bool(getattr(cfg, "chat_enabled", True)):
            return
        try:
            port = int(getattr(cfg, "chat_port", 8098) or 8098)
        except (TypeError, ValueError):
            port = 8098
        if not 1 <= port <= 65535:
            port = 8098
        app = web.Application(client_max_size=64 * 1024)
        app.router.add_get("/bisca/ping", self._handle_ping)
        app.router.add_post("/bisca/chat", self._handle_chat)
        app.router.add_post("/bisca/move", self._handle_move)
        runner = web.AppRunner(app)
        try:
            await runner.setup()
            await web.TCPSite(runner, "0.0.0.0", port).start()
        except OSError as exc:
            await runner.cleanup()
            self.ctx.logger.warning("bisca chat bridge 启动失败（:%s）：%s", port, exc)
            return
        self._chat_runner = runner
        self.ctx.logger.info("bisca chat bridge listening on :%s", port)

    async def _handle_ping(self, request: web.Request) -> web.Response:
        del request
        return web.json_response({"ok": True})

    def _chat_authed(self, request: web.Request) -> bool:
        key = self._key()
        given = request.headers.get("x-internal-key", "")
        return bool(key) and hmac.compare_digest(given, key)

    async def _append_memory(self, stream_id: str, text: str, source: str) -> None:
        try:
            resp = await asyncio.wait_for(
                self.ctx.maisaka.context.append(
                    stream_id=stream_id,
                    segments=[{"type": "text", "content": text}],
                    visible_text=text,
                    source_kind=source,
                ),
                timeout=6.0,
            )
            if isinstance(resp, dict) and resp.get("success") is False:
                self.ctx.logger.warning(
                    "bisca memory append failed: %s", resp.get("error")
                )
        except Exception as exc:  # noqa: BLE001 - 记忆失败不能拖垮聊天
            self.ctx.logger.warning("bisca memory append error: %r", exc)

    async def _say_group(self, text: str, stream_id: str) -> None:
        if not text or not stream_id:
            return
        try:
            await asyncio.wait_for(
                self.ctx.send.text(text=text, stream_id=stream_id), timeout=10.0
            )
        except Exception as exc:  # noqa: BLE001
            self.ctx.logger.warning("bisca group summary send failed: %r", exc)

    async def _send_summary(
        self,
        stream_id: str,
        room_name: str,
        game_name: str,
        logs: list[str],
        chats: list[str],
        result: dict[str, Any],
    ) -> None:
        players = result.get("players") if isinstance(result.get("players"), list) else []
        scores = "，".join(
            f"{str(p.get('name') or '?')} "
            f"{p.get('chips') if p.get('chips') is not None else p.get('score', 0)}"
            for p in players if isinstance(p, dict)
        ) or "无"
        last = result.get("lastResults")
        winners = last.get("winners") if isinstance(last, dict) else None
        if isinstance(winners, list) and winners:
            win_text = "、".join(
                f"{str(w.get('name') or '?')} +{w.get('gain', 0)}"
                for w in winners if isinstance(w, dict)
            )
        else:
            winner = str(result.get("winner") or "")
            name = next(
                (str(p.get("name")) for p in players
                 if isinstance(p, dict) and str(p.get("id") or "") == winner),
                "",
            )
            win_text = name or winner or "这局打完了"
        prompt = (
            f"你是 MaiBot，刚和群友打完一局{game_name or '牌局'}。\n"
            f"过程：{' / '.join(logs[-8:]) or '没有记录'}\n"
            f"结果：{win_text}；筹码/得分：{scores}\n"
            f"最近聊天：{' / '.join(chats[-4:]) or '无'}\n"
            "用群聊口吻吐槽这局的过程和结果，1-2 句，不超过80字；"
            "不要列点、不要解释规则、不要提不在场上的人、不要加引号。"
        )
        say = ""
        try:
            out = await asyncio.wait_for(
                self.ctx.llm.generate(prompt, temperature=0.9, max_tokens=120),
                timeout=8.0,
            )
            answer = ""
            if isinstance(out, dict):
                answer = str(out.get("response") or out.get("text") or "")
            say = " ".join(answer.split()).strip().strip('"“”')[:100]
        except Exception as exc:  # noqa: BLE001
            self.ctx.logger.warning("bisca summary generate error: %r", exc)
        if not say:
            return
        self.ctx.logger.info("bisca summary: %s", say[:100])
        await self._append_memory(
            stream_id, f"【牌桌·{room_name}】MaiBot：{say}", "bisca_game_summary"
        )
        await self._say_group(say, stream_id)

    async def _summarize_room(self, stream_id: str, code: str) -> None:
        """关桌时补一条群吐槽；已经因 game_over 发过就跳过。"""
        if not stream_id or not code or self._summary_sent.get(stream_id) == code:
            return
        base = self._base()
        key = self._key()
        if not base or not key:
            return
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=6.0)
            ) as session:
                async with session.get(
                    base + "/cards/api/rooms/" + code + "/state",
                    headers={"x-internal-key": key},
                ) as resp:
                    if resp.status != 200:
                        return
                    data = await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError) as exc:
            self.ctx.logger.warning("bisca close summary fetch failed: %r", exc)
            return
        if not isinstance(data, dict):
            return
        st = data.get("state") if isinstance(data.get("state"), dict) else {}
        if not st.get("players"):
            return
        players = [
            {
                "id": p.get("id"), "name": p.get("name"),
                "chips": p.get("chips"), "score": p.get("score"),
                "isLandlord": p.get("isLandlord"),
            }
            for p in (st.get("players") or []) if isinstance(p, dict)
        ]
        result = {
            "winner": st.get("winner") or st.get("roundWinner"),
            "lastResults": st.get("lastResults"),
            "players": players,
        }
        logs = [
            str(item.get("text")) for item in (st.get("log") or [])
            if isinstance(item, dict) and item.get("text")
        ][-8:]
        chats = [
            f"{c.get('name')}：{c.get('text')}"
            for c in (data.get("chat") or [])
            if isinstance(c, dict) and c.get("text")
        ][-4:]
        self._summary_sent[stream_id] = code
        room_name = str(data.get("name") or code)
        game_name = str(data.get("gameName") or data.get("game") or "")
        # 关桌不等模型：拿完快照就后台生成并发送
        asyncio.create_task(
            self._send_summary(stream_id, room_name, game_name, logs, chats, result)
        )

    async def _handle_chat(self, request: web.Request) -> web.Response:
        if not self._chat_authed(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001 - 坏 JSON 只回空，不抛给服务端
            return web.json_response({"error": "bad json"}, status=400)
        if not isinstance(data, dict):
            return web.json_response({"text": ""})

        stream_id = str(data.get("stream_id") or "").strip()
        if not stream_id:
            return web.json_response({"text": ""})
        event = str(data.get("event") or "chat").strip().lower()
        if event == "game_over":
            # 整场结束：停止把牌局策略注入这个群的模型请求
            self._clear_game(stream_id)
        room = data.get("room") if isinstance(data.get("room"), dict) else {}
        room_name = (str(room.get("name") or "牌桌").strip() or "牌桌")[:32]
        game_name = str(room.get("gameName") or room.get("game") or "").strip()[:16]
        text = str(data.get("text") or "").strip()[:200]
        reply_to = data.get("reply_to") if isinstance(data.get("reply_to"), dict) else {}
        reply_name = str(reply_to.get("name") or "").strip()[:16]
        phase = str(data.get("phase") or "").strip()
        try:
            round_no = int(data.get("round") or 0)
        except (TypeError, ValueError):
            round_no = 0
        logs = [
            str(x)[:120] for x in (data.get("log") or []) if str(x).strip()
        ][-4:]
        chats = []
        for item in (data.get("chat") or []):
            if not isinstance(item, dict):
                continue
            who = str(item.get("name") or "群友")[:16]
            said = str(item.get("text") or "").strip()[:80]
            if said:
                chats.append(f"{who}：{said}")
        chats = chats[-4:]
        result = data.get("result") if isinstance(data.get("result"), dict) else {}

        if event == "chat":
            summary = f"【牌桌·{room_name}】{reply_name}：{text}" if reply_name and text \
                else f"【牌桌·{room_name}】{chats[-1] if chats else text}"
        elif event == "game_over":
            summary = f"【牌桌·{room_name}】整场结束：" + "；".join(
                logs[-2:] or ["打完了"]
            )
        elif event == "round_over":
            summary = f"【牌桌·{room_name}】第 {round_no or '?'} 局结束：" + "；".join(
                logs[-2:] or ["一局打完"]
            )
        else:
            summary = f"【牌桌·{room_name}】{text or event}"
        await self._append_memory(stream_id, summary, "bisca_game")

        if event == "game_over":
            code = str(room.get("code") or "")
            if code and self._summary_sent.get(stream_id) == code:
                return web.json_response({"text": ""})
            if code:
                self._summary_sent[stream_id] = code
            await self._send_summary(
                stream_id, room_name, game_name, logs, chats, result
            )
        return web.json_response({"text": ""})

    @Command(
        "bisca_party",
        description="群聊开一桌 Bisca 牌，MaiBot 自动入座",
        pattern=r"^\s*(?:开始|来|开|开一局|开一桌|打|来一局|打一局|来把)?\s*"
        r"(?P<game>uno|炸金花|斗地主)\s*$",
    )
    async def party(
        self,
        stream_id: str = "",
        user_name: str = "",
        text: str = "",
        matched_groups: Any = None,
        public_url: str = "",
        **kwargs: Any,
    ) -> tuple[bool, str, bool]:
        try:
            groups = matched_groups if isinstance(matched_groups, dict) else {}
            word = str(groups.get("game") or "").strip()
            if not word:
                matched = _PARTY_CMD.match(str(text or ""))
                word = matched.group("game") if matched else ""
            normalized = word.lower()
            if not normalized:
                raise ValueError("牌名没有识别出来")
            game, label, capacity = _GAMES.get(normalized, ("uno", "UNO", 4))
        except Exception:
            return False, "无法识别牌型", True

        try:
            data = await self._create(game, user_name or "群友", public_url, stream_id)
        except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError, OSError) as exc:
            self.ctx.logger.warning("bisca party failed: %s", exc)
            await self._reply("牌桌暂时开不出来，稍后再试一次。", stream_id)
            return False, "Bisca 开桌失败", True

        room = str(data.get("code") or "")
        url = str(data.get("inviteUrl") or "")
        if room and stream_id:
            self._remember(str(stream_id), room)
            self._mark_game(str(stream_id), game)
        reply = (
            f"{label}桌开好了，房号 {room}（{capacity} 人桌，MaiBot 已入座）。\n"
            f"点开链接直接入座，MaiBot 已经在桌上：\n{url}"
        )
        try:
            await self._reply(reply, stream_id)
        except (asyncio.TimeoutError, RuntimeError, OSError) as exc:
            self.ctx.logger.warning("bisca reply failed: %s", exc)
            return False, "Bisca 已开桌，但群聊回复失败", True
        return True, f"已开 {label} 桌 {room}", True


    @Command(
        "bisca_close",
        description="关掉本群最近开的那桌牌",
        pattern=r"^\s*(?:关|关掉|关闭|解散|结束)\s*(?:桌|牌桌|牌局|房间|这桌)?\s*$",
    )
    async def close_table(
        self, stream_id: str = "", **kwargs: Any
    ) -> tuple[bool, str, bool]:
        code = self._recall(str(stream_id or ""))
        if not code:
            await self._reply("本群没有开着的牌桌记录，发 uno / 炸金花 / 斗地主 就能开一桌。", stream_id)
            return False, "没有可关的桌", True
        try:
            await self._summarize_room(str(stream_id or ""), code)
        except Exception as exc:  # noqa: BLE001 - 总结失败不影响关桌
            self.ctx.logger.warning("bisca close summary failed: %r", exc)
        try:
            await self._close_room(code)
        except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError, OSError) as exc:
            self.ctx.logger.warning("bisca close failed: %s", exc)
            await self._reply("牌桌没关掉，稍后再试，或到大厅手动关。", stream_id)
            return False, "关桌失败", True
        self._clear_game(str(stream_id or ""))
        await self._reply(f"牌桌 {code} 已关。想再打就发 uno / 炸金花 / 斗地主。", stream_id)
        return True, f"已关 {code}", True

    @Command(
        "bisca_reopen",
        description="关掉本群旧桌再开一桌",
        pattern=r"^\s*(?:重开|重新开|再来一桌|重来|换一桌)\s*(?P<game>uno|炸金花|斗地主)\s*$",
    )
    async def reopen(
        self,
        stream_id: str = "",
        user_name: str = "",
        matched_groups: Any = None,
        **kwargs: Any,
    ) -> tuple[bool, str, bool]:
        code = self._recall(str(stream_id or ""))
        if code:
            try:
                await self._close_room(code)
            except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError, OSError) as exc:
                self.ctx.logger.warning("bisca reopen close failed: %s", exc)
        return await self.party(
            stream_id=stream_id, user_name=user_name, matched_groups=matched_groups
        )


def create_plugin() -> BiscaPlugin:
    """Runner 通过此工厂函数实例化插件。"""
    return BiscaPlugin()

