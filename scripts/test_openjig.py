#!/usr/bin/env python3
"""Focused tests for the local OpenJig launcher recovery path."""

import unittest
from types import SimpleNamespace
from unittest.mock import call, patch

import openjig


class EnsureDaemonTests(unittest.TestCase):
    def test_healthy_daemon_is_left_untouched(self):
        with patch.object(openjig, "daemon_up", return_value=True), patch.object(openjig.subprocess, "run") as proc, patch.object(openjig, "run") as command:
            self.assertTrue(openjig.ensure_daemon())
        proc.assert_not_called()
        command.assert_not_called()

    def test_stopped_daemon_is_started_without_stop(self):
        status = SimpleNamespace(stdout="Daemon not running", stderr="")
        with patch.object(openjig, "daemon_up", return_value=False), patch.object(openjig.subprocess, "run", return_value=status), patch.object(openjig, "run", return_value=True) as command:
            self.assertTrue(openjig.ensure_daemon())
        command.assert_called_once_with(["rig", "daemon", "start"])

    def test_unresponsive_daemon_uses_documented_stop_then_start(self):
        status = SimpleNamespace(stdout="process present but UNHEALTHY: unresponsive", stderr="")
        with patch.object(openjig, "daemon_up", return_value=False), patch.object(openjig.subprocess, "run", return_value=status), patch.object(openjig, "run", side_effect=[True, True]) as command:
            self.assertTrue(openjig.ensure_daemon())
        self.assertEqual(command.call_args_list, [
            call(["rig", "daemon", "stop"]),
            call(["rig", "daemon", "start"]),
        ])

    def test_failed_stop_does_not_attempt_second_start(self):
        status = SimpleNamespace(stdout="process present but UNHEALTHY: unresponsive", stderr="")
        with patch.object(openjig, "daemon_up", return_value=False), patch.object(openjig.subprocess, "run", return_value=status), patch.object(openjig, "run", return_value=False) as command:
            self.assertFalse(openjig.ensure_daemon())
        command.assert_called_once_with(["rig", "daemon", "stop"])


class ManagedHerdrSpaceTests(unittest.TestCase):
    """The daemon keeps one space per rig; openjig must find it and not build a second one."""

    def test_finds_managed_space_by_rig_name(self):
        spaces = {"workspaces": [{"workspace_id": "wAM", "label": "urc"}]}
        with patch.object(openjig, "herdr_json", side_effect=lambda a: spaces if a[0] == "workspace" else {"tabs": []}):
            self.assertEqual(openjig.herdr_workspace("urc")["workspace_id"], "wAM")

    def test_still_finds_older_keyed_space(self):
        def fake(args):
            if args[0] == "tab":
                return {"tabs": [{"workspace_id": "w1", "label": "openrig:rig:urc#l1/0"}]}
            return {"workspaces": [{"workspace_id": "w1", "label": "something"}]}
        with patch.object(openjig, "herdr_json", side_effect=fake):
            self.assertEqual(openjig.herdr_workspace("urc")["workspace_id"], "w1")

    def test_managed_views_leave_rig_spaces_alone(self):
        running = [{"name": "urc", "status": "running"}, {"name": "kernel", "status": "running"}]
        with patch.object(openjig, "reset_scroll_mode"), patch.object(openjig, "ensure_kernel"), \
                patch.object(openjig, "rigs", return_value=running), \
                patch.object(openjig, "managed_views_on", return_value=True), \
                patch.object(openjig, "herdr_workspace", return_value={"workspace_id": "wAM"}), \
                patch.object(openjig, "run") as command, patch.object(openjig, "add_mission_control") as mission, \
                patch.object(openjig, "focus_talk_pane"), patch.object(openjig.subprocess, "run"), \
                patch.dict(openjig.os.environ, {"HERDR_ENV": "1"}):
            openjig.show_in_herdr("urc")
        command.assert_not_called()
        mission.assert_not_called()


if __name__ == "__main__":
    unittest.main()
