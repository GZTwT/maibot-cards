from maibot_sdk import Field, PluginConfigBase


def _label(text: str, hint: str = "", **extra: object) -> dict[str, object]:
    """配置页展示用：中文标签 + 下方提示。"""
    data: dict[str, object] = {"label": text}
    if hint:
        data["hint"] = hint
    data.update(extra)
    return {"json_schema_extra": data}


class BiscaSection(PluginConfigBase):
    """牌桌服务：默认用插件内置服务（装完即用），填了外部地址就走外部服务。"""

    __ui_label__ = "牌桌服务"
    __ui_icon__ = "cards"
    __ui_order__ = 0

    enabled: bool = Field(
        default=True,
        description="关闭后群里发「炸金花 / 斗地主 / UNO」不会开桌",
        **_label("启用群聊开桌"),
    )
    base_url: str = Field(
        default="",
        description="留空 = 用插件自带的内置牌桌服务；填了就连接这个地址（例如 docker 里的 http://bisca:8081）",
        **_label("外部服务地址", "自建 Bisca 服务才需要填，一般留空", placeholder="http://bisca:8081"),
    )
    public_url: str = Field(
        default="",
        description="群友手机可访问的固定地址，例如 https://games.example.com；留空则每次开桌现起 cloudflared 隧道",
        **_label("公开访问地址", "有反向代理/域名时填，比临时隧道稳定", placeholder="https://games.example.com"),
    )
    internal_key: str = Field(
        default="",
        description="外部服务的 internal_key（来自它的 data/config.json）；用内置服务时留空，插件会自己读写",
        **_label("内部通道密钥", "仅外部服务需要；内置服务自动管理"),
    )
    password: str = Field(
        default="",
        description="网页登录密码；留空则自动生成并保存在内置服务数据目录的 password.txt",
        **_label("网页登录密码", "邀请链接不需要密码，只有直接打开大厅才要"),
    )
    server_port: int = Field(
        default=0,
        description="内置服务监听端口；0 = 自动挑一个空闲端口（只绑 127.0.0.1）",
        **_label("内置服务端口", "填 0 自动分配，一般不用改"),
    )
    server_data_dir: str = Field(
        default="",
        description="内置服务的房间与配置目录；留空 = 插件数据目录下的 server",
        **_label("内置服务数据目录", "留空即可"),
    )
    node_path: str = Field(
        default="",
        description="node 可执行文件路径；留空自动依次找 PATH、nodejs-wheel-binaries、当前虚拟环境",
        **_label("node 路径", "插件已声明 nodejs-wheel-binaries 依赖，一般留空"),
    )
    tunnel_enabled: bool = Field(
        default=True,
        description="public_url 留空时是否自动起 cloudflared 临时隧道，给群友一个 https 链接",
        **_label("自动公网隧道"),
    )
    tunnel_idle_minutes: int = Field(
        default=30,
        description="隧道闲置多少分钟后自动关闭，下次开桌会换新地址",
        **_label("隧道闲置关闭（分钟）"),
    )
    cloudflared_path: str = Field(
        default="",
        description="cloudflared 可执行文件路径；留空首次开桌自动下载到 /tmp",
        **_label("cloudflared 路径", "自动下载失败时手动准备再填这里"),
    )
    chat_enabled: bool = Field(
        default=True,
        description="是否让 MaiBot 在牌桌里接话，并把牌局记忆写回 QQ 群",
        **_label("牌桌聊天与记忆"),
    )
    chat_port: int = Field(
        default=8098,
        description="Bisca 服务回调 MaiBot 聊天的本机端口，不用对公网开放",
        **_label("聊天回调端口"),
    )
    request_timeout: float = Field(
        default=10.0,
        description="调用牌桌服务的超时秒数（3~30）",
        **_label("请求超时（秒）"),
    )
    strategy_prompts: dict[str, str] = Field(
        default_factory=dict,
        description='按游戏覆盖策略提示词，键 ddz/zjh/uno，例如 {"zjh": "..."}；留空用内置默认',
        **_label("策略提示词覆盖", "高级项，留空用内置默认"),
    )


class PluginSection(PluginConfigBase):
    """宿主保留节：启用开关与配置版本。"""

    __ui_label__ = "插件"
    __ui_order__ = 1

    enabled: bool = Field(
        default=True, description="插件总开关", **_label("启用插件")
    )
    config_version: str = Field(
        default="1.0.0",
        description="配置版本，供运行时做兼容校验",
        **_label("配置版本", hidden=True),
    )


class BiscaPluginConfig(PluginConfigBase):
    plugin: PluginSection = Field(default_factory=PluginSection)
    bisca: BiscaSection = Field(default_factory=BiscaSection)
