"""Run with Python's standard library; the host ABC is replaced by a contract fixture."""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from pathlib import Path

host_module = types.ModuleType("agent.memory_provider")
host_module.MemoryProvider = object
sys.modules["agent.memory_provider"] = host_module


class ProviderTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="umem-hermes-")
        self.root = Path(self.temporary.name)
        self.home = self.root / "memory"
        self.plugin = self.root / "plugin"
        self.plugin.mkdir()
        shutil.copy(Path(__file__).parents[1] / "adapters/hermes/__init__.py", self.plugin / "__init__.py")
        (self.plugin / "connection.json").write_text(json.dumps({"home": str(self.home)}))
        spec = importlib.util.spec_from_file_location("user_memory_test", self.plugin / "__init__.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def tearDown(self):
        self.temporary.cleanup()

    def create(self, profile="one", **kwargs):
        provider = self.module.UserMemoryProvider()
        provider.initialize("same-session", hermes_home=str(self.root / profile), **kwargs)
        return provider

    def events(self):
        return [event for file in (self.home / "spool").glob("*.json") for event in json.loads(file.read_text())]

    def test_profiles_and_cwd_are_bound_to_instances(self):
        first = self.create("one", cwd=str(self.root))
        second = self.create("two", agent_workspace="hermes")
        first.sync_turn("使用中文", "明白")
        second.sync_turn("使用英文", "明白")
        events = self.events()
        self.assertEqual(len({e["sessionId"] for e in events}), 2)
        self.assertEqual(sum("cwd" in e for e in events), 2)

    def test_nonprimary_bot_and_injected_data_not_saved(self):
        self.create(agent_context="subagent").sync_turn("subagent", "result")
        provider = self.create()
        provider.sync_turn("bot", "answer", turn_author={"is_bot": True})
        provider.sync_turn("<user-memory-context>injected</user-memory-context>", "")
        self.assertEqual(self.events(), [])

    def test_recall_binding_session_switch_and_redaction(self):
        provider = self.create()
        calls = []
        provider.request = lambda endpoint, body: (calls.append((endpoint, body)) or {"context": "回忆"})
        provider.on_session_switch("new-session")
        self.assertEqual(provider.prefetch("问题"), "回忆")
        self.assertTrue(calls[0][1]["sessionId"].endswith(":new-session"))
        self.assertNotIn("cwd", calls[0][1])
        provider.sync_turn("secret=abcde sk-abcdefghijklmnopqr", "收到")
        self.assertNotIn("abcde", json.dumps(self.events()))

    def test_offline_recall_does_not_prevent_later_capture(self):
        provider = self.create(cwd=str(self.root))

        def offline(endpoint, body):
            raise OSError("service offline")

        provider.request = offline
        with self.assertLogs(provider.__class__.__module__, level="WARNING"):
            self.assertEqual(provider.prefetch("问题"), "")
        provider.sync_turn("真实偏好", "收到")
        self.assertEqual([event["role"] for event in self.events()], ["user", "assistant"])

    def test_worker_turn_does_not_create_spool_files(self):
        provider = self.create()
        with patch.dict(os.environ, {"UMEM_WORKER": "1"}):
            provider.sync_turn("worker input", "worker output")
        self.assertFalse((self.home / "spool").exists())


if __name__ == "__main__":
    unittest.main()
