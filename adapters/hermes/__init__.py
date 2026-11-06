"""Hermes provider: profile-local sessions, shared local memory service."""
import hashlib
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)


class UserMemoryProvider(MemoryProvider):
    @property
    def name(self):
        return "user-memory"

    def is_available(self):
        return (Path(__file__).parent / "connection.json").is_file()

    def initialize(self, session_id, **kwargs):
        connection = json.loads((Path(__file__).parent / "connection.json").read_text())
        self.home = Path(connection["home"])
        self.profile = hashlib.sha256(str(kwargs["hermes_home"]).encode()).hexdigest()[:12]
        self.session_id = session_id
        self.cwd = kwargs.get("cwd")
        if not isinstance(self.cwd, str):
            self.cwd = None
        self.primary = kwargs.get("agent_context", "primary") == "primary"

    def request(self, endpoint, body):
        config = json.loads((self.home / "config.json").read_text())
        token = (self.home / "token").read_text().strip()
        req = Request(f"http://127.0.0.1:{config['port']}/v1/{endpoint}",
                      data=json.dumps(body).encode(),
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        with urlopen(req, timeout=1.2) as response:
            return json.load(response)

    def prefetch(self, query, *, session_id=""):
        try:
            return self.request("recall", {"agent": "hermes", "sessionId": f"{self.profile}:{session_id or self.session_id}",
                                          **({"cwd": self.cwd} if self.cwd else {}), "query": query[:16000]})["context"]
        except (OSError, ValueError, KeyError) as error:
            logger.warning("公共记忆召回失败: %s", error)
            return ""

    def sync_turn(self, user_content, assistant_content, *, session_id="", messages=None, turn_author=None):
        if not self.primary or os.environ.get("UMEM_WORKER") == "1" or (turn_author or {}).get("is_bot"):
            return
        session = f"{self.profile}:{session_id or self.session_id}"
        turn = uuid.uuid4().hex
        events = []
        for role, content in [("user", user_content), ("assistant", assistant_content)]:
            if not content or "<user-memory-context>" in content:
                continue
            content = re.sub(r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b", "[已隐去凭据]", content)
            content = re.sub(r"\b(Bearer\s+)[A-Za-z0-9._~-]{12,}", r"\1[已隐去凭据]", content, flags=re.I)
            content = re.sub(r"((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+", r"\1[已隐去凭据]", content, flags=re.I)
            events.append({"id": f"hermes:{session}:{turn}:{role}", "agent": "hermes", "sessionId": session,
                           **({"cwd": self.cwd} if self.cwd else {}), "role": role, "content": content[:32000],
                           "at": datetime.now(timezone.utc).isoformat(), "injected": False, "worker": False})
        if events:
            directory = self.home / "spool"
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            temporary = directory / f"{turn}.tmp"
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as output:
                json.dump(events, output, ensure_ascii=False)
            temporary.replace(directory / f"{turn}.json")

    def on_session_switch(self, new_session_id, **kwargs):
        self.session_id = new_session_id

    def get_tool_schemas(self):
        return []  # 主动写入通过同一安装包的 MCP 工具完成。


def register(ctx):
    ctx.register_memory_provider(UserMemoryProvider())
