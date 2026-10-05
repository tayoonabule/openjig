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


if __name__ == "__main__":
    unittest.main()
