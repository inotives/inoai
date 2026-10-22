import importlib.util
import json
import re
import sys
import tempfile
import unittest
import warnings
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "generate_dashboard.py"
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("generate_dashboard", SCRIPT)
dashboard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dashboard)


def write_task(root, task_id, title, status, dependencies):
    folder = root / "tasks" / f"T-{task_id[2:]}--task-{task_id[2:]}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "README.md").write_text(
        f"---\nid: {task_id}\nfeature: IP-0001\ntitle: {title}\nstatus: {status}\ndepends_on: [{', '.join(dependencies)}]\n---\n",
        encoding="utf-8",
    )


def make_feature_root(temp, project_name="Example Project", feature_id="IP-0001", feature_title="Test feature"):
    workspace = Path(temp) / "trinary-workspace"
    root = workspace / "features" / f"{feature_id}--test-feature"
    root.mkdir(parents=True)
    (workspace / "README.md").write_text(f"# Trinary Workspace\n\nProject name: {project_name}\n", encoding="utf-8")
    (root / "README.md").write_text(
        f"---\nid: {feature_id}\ntitle: {feature_title}\n---\n", encoding="utf-8"
    )
    return root


def write_handoff(root, task_id, filename, role, recipient, outcome, timestamp, summary=""):
    folder = root / "tasks" / f"T-{task_id[2:]}--task-{task_id[2:]}" / "handoffs"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / filename).write_text(
        f"# Handoff\n\n- Role: {role}\n- Timestamp (UTC): {timestamp}\n- Recipient: {recipient}\n- Outcome: {outcome}\n\n## Summary\n\n{summary}\n",
        encoding="utf-8",
    )


def write_handoff_text(root, task_id, filename, text):
    folder = root / "tasks" / f"T-{task_id[2:]}--task-{task_id[2:]}" / "handoffs"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / filename).write_text(text, encoding="utf-8")


class DashboardGenerationTests(unittest.TestCase):
    def test_reviewer_approval_formats_complete_cycle_time(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0005", "Descriptive approval", "done", [])
            write_task(root, "T-0009", "Bulleted verdict", "done", [])
            write_handoff(root, "T-0005", "20261018_030000--project-manager-handoff-1.md", "project-manager", "worker", "dispatched", "2026-10-18T03:00:00Z")
            write_handoff(root, "T-0009", "20261018_040000--project-manager-handoff-1.md", "project-manager", "worker", "dispatched", "2026-10-18T04:00:00Z")
            write_handoff_text(root, "T-0005", "20261018_033000--reviewer-handoff-1.md", "# Reviewer handoff\n\n- Role: reviewer\n- Timestamp (UTC): 2026-10-18T03:30:00Z\n- Recipient: project-manager\n- Outcome: Approved; implementation and focused checks satisfy the task criteria.\n")
            write_handoff_text(root, "T-0009", "20261018_043000--reviewer-handoff-1.md", "# Reviewer handoff\n\n- Role: reviewer\n- Timestamp (UTC): 2026-10-18T04:30:00Z\n- Recipient: project-manager\n- Outcome: Implementation and focused checks satisfy the task criteria.\n- Verdict: APPROVED\n")

            tasks = dashboard.load_tasks(root)
            by_id = {task["id"]: task for task in tasks}
            actual = {task_id: dashboard.task_cycle_time(by_id[task_id], "2026-10-18T05:00:00Z")["seconds"] for task_id in ("T-0005", "T-0009")}
            self.assertEqual(actual, {"T-0005": 1800, "T-0009": 1800})

    def test_task_cycle_time_uses_first_worker_dispatch_and_latest_approval(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Finished", "done", [])
            write_task(root, "T-0002", "Queued", "ready", ["T-0001"])
            write_handoff(root, "T-0001", "20261018_100000--project-manager-handoff-1.md", "project-manager", "worker", "dispatched", "2026-10-18T10:00:00Z")
            write_handoff(root, "T-0001", "20261018_103000--project-manager-handoff-2.md", "project-manager", "worker", "re-dispatched", "2026-10-18T10:30:00Z")
            write_handoff(root, "T-0001", "20261018_110000--reviewer-handoff-1.md", "reviewer", "project-manager", "changes_requested", "2026-10-18T11:00:00Z")
            write_handoff(root, "T-0001", "20261018_120000--reviewer-handoff-2.md", "reviewer", "project-manager", "approved", "2026-10-18T12:00:00Z")

            tasks = dashboard.load_tasks(root)
            page = dashboard.render_html(tasks, generated_at="2026-10-18T13:00:00Z")
            embedded = json.loads(re.search(r"const tasks = (\[.*?\]);", page).group(1))
            by_id = {task["id"]: task for task in embedded}

            self.assertEqual(by_id["T-0001"]["cycle_time"], {"seconds": 7200, "label": "2h"})
            self.assertEqual(by_id["T-0002"]["cycle_time"], {"seconds": None, "label": "Not started"})
            self.assertIn("Total task cycle time: <strong>2h</strong>", page)
            self.assertIn('field("Cycle time", task.cycle_time.label);', page)

    def test_running_task_uses_generation_time_and_invalid_dispatch_is_unavailable(self):
        running = {
            "id": "T-0001", "title": "Running", "status": "in_progress", "depends_on": [],
            "handoffs": [{"role": "project-manager", "recipient": "worker", "outcome": "dispatched", "sort_timestamp": "2026-10-18T10:00:00Z", "sequence": 1, "filename": "dispatch.md"}],
        }
        invalid = {
            "id": "T-0002", "title": "Invalid", "status": "done", "depends_on": [],
            "handoffs": [{"role": "project-manager", "recipient": "worker", "outcome": "dispatched", "sort_timestamp": "", "sequence": 1, "filename": "dispatch.md"}],
        }
        no_approval = {
            "id": "T-0003", "title": "No approval", "status": "done", "depends_on": [],
            "handoffs": [
                {"role": "project-manager", "recipient": "worker", "outcome": "dispatched", "sort_timestamp": "2026-10-18T10:00:00Z", "sequence": 1, "filename": "dispatch.md"},
                {"role": "project-manager", "recipient": "worker", "outcome": "Approved; task is done", "sort_timestamp": "2026-10-18T12:00:00Z", "sequence": 2, "filename": "pm-approval.md"},
                {"role": "reviewer", "recipient": "project-manager", "outcome": "changes_requested", "sort_timestamp": "2026-10-18T11:00:00Z", "sequence": 1, "filename": "review.md"},
            ],
        }

        self.assertEqual(dashboard.task_cycle_time(running, "2026-10-18T12:30:00Z"), {"seconds": 9000, "label": "2h 30m (ongoing)"})
        self.assertEqual(dashboard.task_cycle_time(invalid, "2026-10-18T12:30:00Z"), {"seconds": None, "label": "Time unavailable"})
        self.assertEqual(dashboard.task_cycle_time(no_approval, "2026-10-18T12:30:00Z"), {"seconds": None, "label": "Time unavailable"})
        self.assertEqual(dashboard.format_duration(45), "45s")
        self.assertEqual(dashboard.format_duration(183845), "2d 3h 4m")

    def test_cycle_time_breakdown_uses_hover_and_keyboard_details_without_visible_legend(self):
        tasks = [
            {"id": "T-0004", "title": "Not started", "status": "queued", "depends_on": [], "handoffs": []},
            {"id": "T-0001", "title": "Two hours", "status": "done", "depends_on": [], "handoffs": [
                {"role": "project-manager", "recipient": "worker", "outcome": "dispatched", "sort_timestamp": "2026-10-18T10:00:00Z", "sequence": 1, "filename": "dispatch.md"},
                {"role": "reviewer", "recipient": "project-manager", "outcome": "approved", "sort_timestamp": "2026-10-18T12:00:00Z", "sequence": 1, "filename": "approval.md"},
            ]},
            {"id": "T-0002", "title": "One hour", "status": "done", "depends_on": [], "handoffs": [
                {"role": "project-manager", "recipient": "worker", "outcome": "dispatched", "sort_timestamp": "2026-10-18T11:00:00Z", "sequence": 1, "filename": "dispatch.md"},
                {"role": "reviewer", "recipient": "project-manager", "outcome": "approved", "sort_timestamp": "2026-10-18T12:00:00Z", "sequence": 1, "filename": "approval.md"},
            ]},
            {"id": "T-0003", "title": "Zero time", "status": "done", "depends_on": [], "handoffs": [
                {"role": "project-manager", "recipient": "worker", "outcome": "dispatched", "sort_timestamp": "2026-10-18T12:00:00Z", "sequence": 1, "filename": "dispatch.md"},
                {"role": "reviewer", "recipient": "project-manager", "outcome": "approved", "sort_timestamp": "2026-10-18T12:00:00Z", "sequence": 1, "filename": "approval.md"},
            ]},
        ]
        for task in tasks:
            task["latest_handoff"] = {"sort_timestamp": max((item["sort_timestamp"] for item in task["handoffs"]), default="")}
            for handoff in task["handoffs"]:
                handoff["task_id"] = task["id"]
                handoff["task_title"] = task["title"]

        page = dashboard.render_html(tasks, generated_at="2026-10-18T12:00:00Z")
        embedded = json.loads(re.search(r"const tasks = (\[.*?\]);", page).group(1))
        self.assertEqual([(task["id"], task["cycle_time"]["seconds"], task["cycle_time"]["label"]) for task in embedded], [
            ("T-0004", None, "Not started"), ("T-0001", 7200, "2h"), ("T-0002", 3600, "1h"), ("T-0003", 0, "0s"),
        ])
        self.assertIn("Total task cycle time: <strong>3h</strong>", page)
        self.assertIn('role="img" aria-label="Task cycle time breakdown"', page)
        self.assertIn('id="cycle-time-popup" class="cycle-time-popup" role="tooltip"', page)
        self.assertIn('id="cycle-time-details" aria-label="Keyboard accessible task cycle times"', page)
        self.assertNotIn("cycle-time-legend", page)
        self.assertIn('"aria-label": `${task.id}: ${task.cycle_time.label}`', page)
        self.assertIn('title: `${task.id}: ${task.cycle_time.label}`', page)
        self.assertIn(".cycle-time-detail:focus", page)
        self.assertIn('timedTasks.forEach(task => append(cycleDetails, "button"', page)
        self.assertIn('const timedTasks = cycleTimeTasks.filter(task => task.cycle_time.seconds !== null);', page)
        self.assertIn('x: start / cycleTotal * 1000, width: task.cycle_time.seconds / cycleTotal * 1000', page)
        self.assertIn('fill: task.cycle_color', page)
        self.assertIn('segment.addEventListener("mouseenter", showCyclePopup)', page)
        self.assertIn('segment.addEventListener("focus", showCyclePopup)', page)
        self.assertIn('cyclePopup.textContent = `${task.id} · ${task.cycle_time.label}`', page)
        self.assertIn('const left = Math.max(popupWidth / 2 + 4, Math.min(target, bounds.width - popupWidth / 2 - 4));', page)
        self.assertIn('cyclePopup.style.left = `${left}px`', page)
        self.assertIn('pointer-events: none', page)
        self.assertIn('cyclePopup.classList.add("is-visible")', page)
        self.assertIn('cyclePopup.classList.remove("is-visible")', page)
        self.assertIn('.cycle-time-popup.is-visible', page)
        self.assertIn('`${task.id}: ${task.cycle_time.label}`', page)
        self.assertIn('timedTasks.map(task => `${task.id} ${task.cycle_time.label}`).join(", ")', page)

    def test_dashboard_header_uses_workspace_and_feature_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp, "Research & Development", "IP-0042", "A Better Viewer")
            write_task(root, "T-0001", "Start", "ready", [])
            write_task(root, "T-0002", "Finish", "queued", ["T-0001"])

            dashboard.generate(root)
            page = (root / "dashboard.html").read_text(encoding="utf-8")
            self.assertIn("<h1>Trinary-AGENTs Flow :: Research &amp; Development</h1>", page)
            self.assertIn("<p>IP-0042--A Better Viewer workflow viewer</p>", page)

    def test_dashboard_requires_a_human_supplied_project_name(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp, "<project name>")
            write_task(root, "T-0001", "Start", "ready", [])
            write_task(root, "T-0002", "Finish", "queued", ["T-0001"])

            with self.assertRaisesRegex(ValueError, "Project name: <name>.*ask the human"):
                dashboard.generate(root)

    def test_dashboard_header_escapes_custom_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp, "<script>alert(1)</script>", "IP-0003", "Research <Now> & Learn")
            write_task(root, "T-0001", "Start", "ready", [])
            write_task(root, "T-0002", "Finish", "queued", ["T-0001"])

            dashboard.generate(root)
            page = (root / "dashboard.html").read_text(encoding="utf-8")
            self.assertIn("<h1>Trinary-AGENTs Flow :: &lt;script&gt;alert(1)&lt;/script&gt;</h1>", page)
            self.assertIn("<p>IP-0003--Research &lt;Now&gt; &amp; Learn workflow viewer</p>", page)
            self.assertNotIn("<h1>Trinary-AGENTs Flow :: <script>", page)

    def test_multi_task_snapshot_and_updates_follow_readmes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Start", "ready", [])
            write_task(root, "T-0002", "Finish", "queued", ["T-0001"])
            self.assertEqual(dashboard.generate(root), "generated with 2 tasks")
            page = (root / "dashboard.html").read_text(encoding="utf-8")
            self.assertIn('"id":"T-0001"', page)
            self.assertIn('"status":"queued"', page)
            self.assertIn('"depends_on":["T-0001"]', page)
            self.assertIn('const element = isSvg ? document.createElementNS(svgNS, tag) : document.createElement(tag);', page)
            self.assertNotIn("d3@7/+esm", page)
            self.assertNotIn("d3.", page)
            self.assertNotIn('<meta http-equiv="refresh"', page)

            write_task(root, "T-0001", "Start", "done", [])
            write_task(root, "T-0002", "Finish", "ready", [])
            dashboard.generate(root)
            updated = (root / "dashboard.html").read_text(encoding="utf-8")
            self.assertIn('"status":"done"', updated)
            self.assertIn('"status":"ready"', updated)
            self.assertIn('"depends_on":[]', updated)
            self.assertNotIn('"source":"T-0001"', updated)

    def test_single_task_generates_dashboard_and_empty_feature_omits_it(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Only", "ready", [])

            self.assertEqual(dashboard.generate(root), "generated with 1 tasks")
            page = root / "dashboard.html"
            self.assertTrue(page.exists())
            self.assertIn("T-0001", page.read_text(encoding="utf-8"))

            (root / "tasks" / "T-0001--task-0001" / "README.md").unlink()
            self.assertEqual(dashboard.generate(root), "omitted")
            self.assertFalse(page.exists())

    def test_multi_task_refuses_to_overwrite_unmarked_dashboard(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Start", "ready", [])
            write_task(root, "T-0002", "Finish", "queued", ["T-0001"])
            page = root / "dashboard.html"
            original = "<!doctype html><title>Human dashboard</title>\n"
            page.write_text(original, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
                dashboard.generate(root)
            self.assertEqual(page.read_text(encoding="utf-8"), original)

    def test_all_embedded_json_is_script_safe_and_parseable(self):
        payload = "</script><script>alert(1)</script>"
        handoff = {
            "task_id": payload, "task_title": payload, "role": "Worker", "recipient": "project-manager",
            "outcome": payload, "verdict": "", "timestamp": "2026-10-18T01:00:00Z",
            "summary": payload, "content": payload, "filename": "handoff.md",
            "sort_timestamp": "2026-10-18T01:00:00Z", "sequence": 1,
        }
        tasks = [{
            "id": payload, "title": payload, "status": "ready", "depends_on": [],
            "handoffs": [handoff], "latest_handoff": handoff,
        }]
        page = dashboard.render_html(tasks)
        self.assertNotIn(payload, page)
        self.assertIn("\\u003c/script\\u003e", page)
        embedded = {
            name: re.search(rf"const {name} = (.*?);", page).group(1)
            for name in ("tasks", "dependencyLayout", "handoffs")
        }
        decoded = {name: json.loads(value) for name, value in embedded.items()}
        self.assertEqual(decoded["tasks"][0]["id"], payload)
        self.assertIn(payload, decoded["dependencyLayout"]["nodes"])
        self.assertEqual(decoded["handoffs"][0]["summary"], payload)

    def test_embedded_script_closing_task_id_is_safe_and_dependency_data_stays_valid(self):
        task_id = "</script><script>alert(1)</script>"
        tasks = [{"id": task_id, "title": "Malicious ID", "status": "ready", "depends_on": []}]
        page = dashboard.render_html(tasks)

        self.assertNotIn(task_id, page)
        self.assertIn("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e", page)
        embedded_tasks = json.loads(re.search(r"const tasks = (\[.*?\]);", page).group(1))
        dependency_layout = json.loads(re.search(r"const dependencyLayout = (\{.*?\});", page).group(1))
        self.assertEqual(embedded_tasks[0]["id"], task_id)
        self.assertIn(task_id, dependency_layout["nodes"])
        self.assertIn(task_id, dependency_layout["isolated_ids"])

    def test_latest_handoff_changes_owner_and_embedded_activity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Complete", "done", [])
            write_task(root, "T-0002", "Waiting", "in_progress", ["T-0001"])
            write_handoff(root, "T-0002", "20261017_100000--worker-handoff-1.md", "worker", "project-manager", "completed", "2026-10-17T10:00:00Z")
            write_handoff(root, "T-0002", "20261017_110000--project-manager-handoff-2.md", "project-manager", "reviewer", "dispatched", "2026-10-17T11:00:00Z")

            dashboard.generate(root)
            first = (root / "dashboard.html").read_text(encoding="utf-8")
            self.assertIn('"owner":"Completed"', first)
            self.assertIn('"owner":"Reviewer"', first)
            self.assertIn('"role":"project-manager","recipient":"reviewer","outcome":"dispatched","timestamp":"2026-10-17T11:00:00Z"', first)

            write_handoff(root, "T-0002", "20261017_110000--project-manager-handoff-2.md", "project-manager", "human", "blocked for input", "2026-10-17T11:00:00Z")
            dashboard.generate(root)
            updated = (root / "dashboard.html").read_text(encoding="utf-8")
            self.assertIn('"owner":"Human"', updated)
            self.assertIn('"outcome":"blocked for input"', updated)

    def test_handoff_detail_drawer_embeds_and_displays_source_as_text(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Handoff details", "review", [])
            write_task(root, "T-0002", "Next", "queued", ["T-0001"])
            source = "# Handoff\n\n- Outcome: reviewed\n\n<script>alert(1)</script> & <img src=x>"
            write_handoff_text(root, "T-0001", "20261018_120000--worker-handoff-1.md", source)

            dashboard.generate(root)
            page = (root / "dashboard.html").read_text(encoding="utf-8")
            handoffs = json.loads(re.search(r"const handoffs = (\[.*?\]);", page).group(1))

            self.assertEqual(handoffs[0]["content"], source)
            self.assertIn("\\u003cscript\\u003ealert(1)\\u003c/script\\u003e", page)
            self.assertIn('class: "btn btn-circle btn-ghost btn-xs handoff-detail-button"', page)
            self.assertIn('`Show full details for ${handoff.task_id} ${handoff.role} handoff`', page)
            self.assertIn('title: `Show full details for ${handoff.task_id} ${handoff.role} handoff`', page)
            self.assertIn('append(heading, "div", { class: "handoff-entry-heading" })', page)
            self.assertIn('append(detailButton, "svg", { class: "handoff-detail-icon"', page)
            self.assertIn('detailButton.addEventListener("click", () => openHandoffDetails(handoff))', page)
            self.assertNotIn('.text("Details")', page)
            self.assertIn('id="handoff-drawer-backdrop" class="handoff-drawer-backdrop" aria-hidden="true" inert', page)
            self.assertIn('role="dialog" aria-modal="true"', page)
            self.assertIn('aria-label="Close details"', page)
            self.assertIn('if (!drawer.contains(event.target)) closeHandoffDetails();', page)
            self.assertIn('drawerClose.addEventListener("click", closeHandoffDetails);', page)
            self.assertIn('document.querySelector(".dashboard").inert = true;', page)
            self.assertIn('drawerBackdrop.inert = true;', page)
            self.assertIn('document.querySelector("#handoff-drawer-source").textContent = content;', page)
            self.assertIn('handoff.content);', page)
            self.assertNotIn('handoff.content).html(', page)
            self.assertNotIn('#handoff-drawer-source").html(', page)
            app_script = re.search(r'<script>\n    const d3 = window\.d3;([\s\S]*?)\n  </script>', page)
            self.assertIsNotNone(app_script)
            self.assertNotIn('innerHTML', app_script.group(1))

    def test_latest_handoff_uses_numeric_sequence_when_timestamps_match(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Start", "done", [])
            write_task(root, "T-0002", "Continue", "in_progress", ["T-0001"])
            timestamp = "2026-10-17T12:00:00Z"
            write_handoff(root, "T-0002", "20261017_120000--worker-handoff-9.md", "worker", "reviewer", "older sequence", timestamp)
            write_handoff(root, "T-0002", "20261017_120000--worker-handoff-10.md", "worker", "human", "newer sequence", timestamp)

            dashboard.generate(root)
            page = (root / "dashboard.html").read_text(encoding="utf-8")
            self.assertIn('"owner":"Human"', page)
            self.assertIn('"role":"worker","recipient":"human","outcome":"newer sequence"', page)
            self.assertIn('"role":"worker","recipient":"reviewer","outcome":"older sequence"', page)

    def test_done_tasks_sort_by_latest_handoff_with_stable_ties_and_missing_times_last(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            for task_id in ("T-0001", "T-0002", "T-0003", "T-0004"):
                write_task(root, task_id, f"Task {task_id}", "done", [])
            write_handoff(root, "T-0001", "20261018_100000--reviewer-handoff-1.md", "reviewer", "project-manager", "approved", "2026-10-18T10:00:00Z")
            write_handoff(root, "T-0002", "20261018_100000--reviewer-handoff-1.md", "reviewer", "project-manager", "approved", "2026-10-18T10:00:00Z")
            write_handoff(root, "T-0003", "20261018_110000--reviewer-handoff-1.md", "reviewer", "project-manager", "approved", "2026-10-18T11:00:00Z")

            page = dashboard.render_html(dashboard.load_tasks(root))
            task_data = json.loads(re.search(r"const tasks = (\[.*?\]);", page).group(1))

            self.assertEqual([task["id"] for task in task_data], ["T-0003", "T-0001", "T-0002", "T-0004"])
            self.assertEqual(task_data[-1]["latest_handoff"]["sort_timestamp"], "")

    def test_done_tasks_compare_mixed_offsets_as_utc_instants(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Earlier instant", "done", [])
            write_task(root, "T-0002", "Later instant", "done", [])
            write_handoff(root, "T-0001", "20261018_100000--reviewer-handoff-1.md", "reviewer", "project-manager", "approved", "2026-10-18T10:00:00+02:00")
            write_handoff(root, "T-0002", "20261018_090000--reviewer-handoff-1.md", "reviewer", "project-manager", "approved", "2026-10-18T09:00:00Z")

            page = dashboard.render_html(dashboard.load_tasks(root))
            task_data = json.loads(re.search(r"const tasks = (\[.*?\]);", page).group(1))

            self.assertEqual([task["id"] for task in task_data], ["T-0002", "T-0001"])
            self.assertEqual(task_data[0]["latest_handoff"]["sort_timestamp"], "2026-10-18T09:00:00Z")
            self.assertEqual(task_data[1]["latest_handoff"]["sort_timestamp"], "2026-10-18T08:00:00Z")

    def test_legacy_bold_metadata_and_created_timestamp_are_parsed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Legacy", "in_progress", [])
            write_task(root, "T-0002", "Next", "queued", ["T-0001"])
            write_handoff_text(
                root,
                "T-0001",
                "20261018_000000--worker-handoff-1.md",
                "# Worker handoff\n\n**Created:** 2026-10-17 22:48:00 UTC  \n"
                "**Task:** T-0001 — Legacy\n**From:** Worker\n**To:** Project manager\n"
                "**Outcome:** Implementation complete; ready for independent review.\n",
            )

            handoff = dashboard.read_handoffs(
                root / "tasks" / "T-0001--task-0001" / "handoffs",
                {"id": "T-0001", "title": "Legacy"},
            )[0]

            self.assertEqual(handoff["role"], "Worker")
            self.assertEqual(handoff["recipient"], "Project manager")
            self.assertEqual(handoff["outcome"], "Implementation complete; ready for independent review.")
            self.assertEqual(handoff["timestamp"], "2026-10-17T22:48:00Z")

    def test_reviewer_verdict_and_missing_recipient_are_inferred(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Review", "review", [])
            write_task(root, "T-0002", "Next", "queued", ["T-0001"])
            write_handoff_text(
                root,
                "T-0001",
                "20261018_000557--reviewer-handoff-1.md",
                "VERDICT: APPROVED\n\n# Reviewer handoff\n\n"
                "- **Task:** T-0001 — Review\n- **From:** Reviewer\n"
                "- **Timestamp (Singapore):** 2026-10-18 00:05:57 (UTC+8)\n",
            )

            handoff = dashboard.read_handoffs(
                root / "tasks" / "T-0001--task-0001" / "handoffs",
                {"id": "T-0001", "title": "Review"},
            )[0]

            self.assertEqual(handoff["role"], "Reviewer")
            self.assertEqual(handoff["recipient"], "project-manager")
            self.assertEqual(handoff["outcome"], "approved")
            self.assertEqual(handoff["timestamp"], "2026-10-18T00:05:57+08:00")

    def test_missing_metadata_uses_neutral_fallbacks_and_filename_timestamp(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Needs a decision", "blocked", [])
            write_task(root, "T-0002", "Next", "queued", ["T-0001"])
            write_handoff_text(
                root,
                "T-0001",
                "20261018_012345--project-manager-handoff-2.md",
                "# Project manager handoff\n\n- Timestamp (UTC): not a timestamp\n",
            )

            handoff = dashboard.read_handoffs(
                root / "tasks" / "T-0001--task-0001" / "handoffs",
                {"id": "T-0001", "title": "Needs a decision"},
            )[0]

            self.assertEqual(handoff["role"], "Project Manager")
            self.assertEqual(handoff["recipient"], "")
            self.assertEqual(handoff["outcome"], "Handoff")
            self.assertEqual(handoff["timestamp"], "2026-10-18T01:23:45Z")
            self.assertNotIn("Not recorded", json.dumps(handoff))

    def test_legacy_handoff_filename_and_fields_are_included_with_warning(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Legacy handoff", "in_progress", [])
            write_handoff_text(
                root,
                "T-0001",
                "worker-summary.md",
                "# Worker handoff\n\n- Role: worker\n- Timestamp (UTC): 2026-10-18T03:00:00Z\n"
                "- Recipient: project-manager\n- Decision: Returned legacy record\n\n"
                "**Summary:** Included from a noncanonical filename.\n",
            )

            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                tasks = dashboard.load_tasks(root)

            handoffs = tasks[0]["handoffs"]
            self.assertEqual(len(handoffs), 1)
            self.assertEqual(handoffs[0]["outcome"], "Returned legacy record")
            self.assertEqual(handoffs[0]["summary"], "Included from a noncanonical filename.")
            self.assertTrue(any("worker-summary.md" in str(item.message) for item in caught))
            page = dashboard.render_html(tasks, generated_at="2026-10-18T04:00:00Z")
            embedded = json.loads(re.search(r"const handoffs = (\[.*?\]);", page).group(1))
            self.assertEqual(embedded[0]["filename"], "worker-summary.md")
            self.assertEqual(embedded[0]["summary"], "Included from a noncanonical filename.")

    def test_unreadable_and_unrecognized_handoffs_are_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Mixed handoffs", "in_progress", [])
            handoffs_dir = root / "tasks" / "T-0001--task-0001" / "handoffs"
            handoffs_dir.mkdir()
            (handoffs_dir / "20261018_010000--worker-handoff-1.md").write_bytes(b"\xff")
            write_handoff_text(
                root,
                "T-0001",
                "20261018_020000--reviewer-handoff-1.md",
                "# Unrecognized record\n\nNo metadata fields here.\n",
            )
            write_handoff(
                root,
                "T-0001",
                "20261018_030000--project-manager-handoff-1.md",
                "project-manager",
                "worker",
                "dispatched",
                "2026-10-18T03:00:00Z",
            )

            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                tasks = dashboard.load_tasks(root)

            messages = [str(item.message) for item in caught]
            self.assertTrue(any("Unable to read handoff file" in message for message in messages))
            self.assertTrue(any("Unrecognized handoff content" in message for message in messages))
            page = dashboard.render_html(tasks, generated_at="2026-10-18T04:00:00Z")
            embedded = json.loads(re.search(r"const handoffs = (\[.*?\]);", page).group(1))
            self.assertEqual(len(embedded), 2)
            self.assertNotIn("20261018_010000--worker-handoff-1.md", [item["filename"] for item in embedded])

    def test_kanban_routes_each_status_once_and_keeps_handoff_timeline(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            statuses = ["done", "in_progress", "review", "queued", "ready", "blocked", "changes_requested"]
            for index, status in enumerate(statuses, start=1):
                write_task(root, f"T-{index:04d}", f"Task {index}", status, [])
            write_handoff(root, "T-0001", "20261017_090000--worker-handoff-1.md", "worker", "project-manager", "completed", "2026-10-17T09:00:00Z", "Inspected the repository safely.")
            write_handoff(root, "T-0002", "20261017_110000--worker-handoff-9.md", "worker", "reviewer", "completed", "2026-10-17T11:00:00Z", "Generated the first dependency view.")
            write_handoff(root, "T-0003", "20261017_110000--reviewer-handoff-10.md", "reviewer", "project-manager", "changes_requested", "2026-10-17T11:00:00Z", "Requested a small layout correction.")
            write_handoff(root, "T-0006", "20261017_120000--project-manager-handoff-1.md", "project-manager", "project-manager", "awaiting human intervention", "2026-10-17T12:00:00Z", "Needs a human decision.")

            dashboard.generate(root)
            page = (root / "dashboard.html").read_text(encoding="utf-8")
            task_data = json.loads(re.search(r"const tasks = (\[.*?\]);", page).group(1))
            embedded = re.search(r"const handoffs = (\[.*?\]);", page).group(1)
            handoffs = json.loads(embedded)
            expected_lanes = ["Done", "Worker", "Reviewer", "Project manager", "Project manager", "Reviewer", "Worker"]
            self.assertEqual([task["lane"] for task in task_data], expected_lanes)
            self.assertEqual(len({task["id"] for task in task_data}), len(statuses))
            self.assertEqual(task_data[5]["owner"], "Human")
            self.assertEqual([item["task_id"] for item in handoffs], ["T-0006", "T-0003", "T-0002", "T-0001"])
            self.assertEqual(handoffs[1]["sequence"], 10)
            self.assertEqual(handoffs[1]["summary"], "Requested a small layout correction.")
            self.assertEqual([lane for lane in [task["lane"] for task in task_data] if lane == "Project manager"].count("Project manager"), 2)
            self.assertIn('const laneDefinitions = [', page)
            self.assertEqual(page.count('name: "Project manager"'), 1)
            self.assertEqual(page.count('name: "Worker"'), 1)
            self.assertEqual(page.count('name: "Reviewer"'), 1)
            self.assertEqual(page.count('name: "Done"'), 1)
            self.assertIn('task.lane === lane.name', page)
            self.assertIn('task-card-status', page)
            self.assertIn('task.status === "blocked" ? "task-card task-card-blocked" : "task-card"', page)
            self.assertIn('class: "task-card-alert"', page)
            self.assertIn('"Human action required")', page)
            self.assertIn(".task-card-blocked", page)
            self.assertIn('field("Owner", task.owner);', page)
            self.assertIn('field("Depends", task.depends_on.length ? task.depends_on.join(", ") : "None");', page)
            self.assertIn('task.latest_handoff.summary', page)
            self.assertIn('id="handoff-stack"', page)
            self.assertIn('class="card handoff-panel"', page)
            self.assertIn('id="kanban-board"', page)
            self.assertIn('class: "dependency-graph"', page)
            self.assertIn('class="dependency-panel"', page)
            self.assertIn('"marker-end": "url(#dependency-arrow)"', page)
            self.assertIn("${handoffs.length} handoffs", page)

    def test_owner_fallbacks_and_dashboard_overview_fields(self):
        empty_handoff = {"recipient": ""}
        self.assertEqual(dashboard.current_owner("done", empty_handoff), "Completed")
        self.assertEqual(dashboard.current_owner("blocked", empty_handoff), "Human")
        self.assertEqual(dashboard.current_owner("blocked", {"recipient": "project-manager"}), "Human")
        self.assertEqual(dashboard.current_owner("review", empty_handoff), "Reviewer")
        self.assertEqual(dashboard.current_owner("in_progress", empty_handoff), "Worker")
        self.assertEqual(dashboard.current_owner("ready", empty_handoff), "Project manager")
        self.assertEqual(dashboard.kanban_lane("queued"), "Project manager")
        self.assertEqual(dashboard.kanban_lane("blocked"), "Reviewer")
        self.assertEqual(dashboard.kanban_lane("changes_requested"), "Worker")
        self.assertEqual(dashboard.kanban_lane("review"), "Reviewer")
        self.assertEqual(dashboard.kanban_lane("done"), "Done")
        page = dashboard.render_html([])
        self.assertIn("Overall completion", page)
        self.assertIn('id="completion-progress"', page)
        self.assertIn('aria-labelledby="dependency-heading"', page)
        self.assertIn('id="dependency-heading">Dependency map</h2>', page)
        self.assertNotIn('id="status-counts"', page)
        self.assertNotIn('status-counts', page)
        self.assertIn('id="handoff-stack"', page)
        self.assertIn('task.latest_handoff.role', page)
        self.assertIn('task.latest_handoff.outcome', page)
        self.assertIn('task.latest_handoff.timestamp', page)
        self.assertIn("feature monitor", page)

    def test_dependency_map_uses_prerequisite_depth_and_draws_each_edge(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            write_task(root, "T-0001", "Independent root", "ready", [])
            write_task(root, "T-0002", "Second root", "queued", [])
            write_task(root, "T-0003", "A long title that should remain readable in the graph node", "in_progress", ["T-0001"])
            write_task(root, "T-0004", "Join both paths", "review", ["T-0001", "T-0002"])
            write_task(root, "T-0005", "Final task", "done", ["T-0003", "T-0004"])

            tasks = dashboard.load_tasks(root)
            page = dashboard.render_html(tasks)
            task_data = json.loads(re.search(r"const tasks = (\[.*?\]);", page).group(1))

            self.assertEqual({task["id"]: task["rank"] for task in task_data}, {
                "T-0001": 0, "T-0002": 0, "T-0003": 1, "T-0004": 1, "T-0005": 2,
            })
            self.assertEqual(sum(len(task["depends_on"]) for task in task_data), 5)
            self.assertIn('const edges = tasks.flatMap(task => task.depends_on.map(dependency => ({ source: dependency, target: task.id })))', page)
            self.assertIn('Prerequisites → dependent tasks', page)
            self.assertIn('role="region" aria-label="Task dependency flow diagram" tabindex="0"', page)
            self.assertIn('id="dependency-summary" class="sr-only"', page)
            self.assertIn('"aria-label": "Tasks and prerequisite relationships"', page)
            self.assertIn('"aria-hidden": "true"', page)
            self.assertIn('task.depends_on.length ? task.depends_on.join(", ") : "none"', page)
            self.assertIn('task.status.replaceAll("_", " ")', page)
            self.assertIn('overflow: auto; overscroll-behavior: contain', page)
            self.assertIn('const nodeWidth = 92, nodeHeight = 36', page)
            self.assertIn('const statusSymbols = { queued: "○", ready: "◇", needs_human: "?", waiting_human: "⌛", in_progress: "▶", changes_requested: "↻", review: "◷", blocked: "!", done: "✓" }', page)
            self.assertIn('class: "dependency-node-icon"', page)
            self.assertIn('data-status="blocked"', page)
            self.assertIn('class="dependency-legend" role="group" aria-label="Task status legend"', page)
            self.assertNotIn('dependency-node-title', page)
            self.assertNotIn('dependency-node-status', page)

    def test_dependency_layout_groups_only_isolated_tasks_and_caps_columns(self):
        with tempfile.TemporaryDirectory() as temp:
            root = make_feature_root(temp)
            for index in range(1, 9):
                write_task(root, f"T-{index:04d}", f"Isolated {index}", "ready", [])
            write_task(root, "T-0010", "Root with dependents", "ready", [])
            for index in range(11, 19):
                write_task(root, f"T-{index:04d}", f"Dependent {index}", "queued", ["T-0010"])

            tasks = dashboard.load_tasks(root)
            layout = dashboard.dependency_map_layout(tasks)
            positions = layout["nodes"]
            isolated_ids = {f"T-{index:04d}" for index in range(1, 9)}

            self.assertEqual(set(layout["isolated_ids"]), isolated_ids)
            self.assertNotIn("T-0010", layout["isolated_ids"])
            self.assertIsNotNone(layout["isolated_group"])
            self.assertGreater(positions["T-0010"]["x"], layout["isolated_group"]["x"] + layout["isolated_group"]["width"])

            dag_tasks = [task for task in tasks if task["id"] not in isolated_ids]
            by_rank_x = {}
            for task in dag_tasks:
                by_rank_x.setdefault(task["rank"], set()).add(positions[task["id"]]["x"])
            self.assertEqual(len(by_rank_x[1]), 3)
            for rank, xs in by_rank_x.items():
                for x in xs:
                    self.assertLessEqual(sum(positions[task["id"]]["x"] == x for task in dag_tasks), 3)
            self.assertGreater(layout["width"], 300)

            for task in dag_tasks:
                for dependency in task["depends_on"]:
                    self.assertLess(positions[dependency]["x"], positions[task["id"]]["x"])

            page = dashboard.render_html(tasks)
            self.assertIn('"Isolated tasks")', page)
            self.assertIn('class: "dependency-isolated-group"', page)
            self.assertIn('task.depends_on.length ? task.depends_on.join(", ") : "none"', page)

    def test_dark_theme_accessible_refresh_and_reduced_motion(self):
        page = dashboard.render_html([])
        self.assertIn('<html lang="en" data-theme="dark">', page)
        self.assertIn('aria-label="Toggle automatic dashboard refresh" aria-pressed="false"', page)
        self.assertIn('<svg class="refresh-icon" aria-hidden="true" width="20" height="20"', page)
        self.assertIn('.refresh-control[aria-pressed="true"] .refresh-icon', page)
        self.assertIn("animation: refresh-spin 1.5s linear infinite", page)
        self.assertIn("filter: brightness(0) invert(1)", page)
        self.assertIn("@media (prefers-reduced-motion: reduce)", page)
        self.assertIn('@media (prefers-reduced-motion: reduce) { .refresh-control[aria-pressed="true"] .refresh-icon { animation: none; } }', page)
        self.assertIn("Built with locally embedded DaisyUI styling and browser-native JavaScript.", page)
        self.assertNotIn("Flaticon", page)
        self.assertNotIn("D3.js", page)
        self.assertIn(".kanban-lane {", page)
        self.assertIn(".task-card {", page)

    def test_dashboard_runtime_assets_are_local_and_embedded(self):
        page = dashboard.render_html([])
        self.assertIn('<style id="daisyui-styles">', page)
        self.assertIn('/*! 🌼 daisyUI 5.7.50 - MIT License */', page)
        self.assertIsNone(re.search(r'\b(?:src|href)=["\']https?://', page, re.IGNORECASE))
        self.assertIsNone(re.search(r'url\(["\']?https?://', page, re.IGNORECASE))
        self.assertNotIn('type="module"', page)
        self.assertNotIn("@tailwindcss/browser", page)
        self.assertNotIn("flaticon.com", page)
        self.assertNotIn("cdn.jsdelivr.net", page)

    def test_dashboard_fills_viewport_and_kanban_scrolls_responsively(self):
        page = dashboard.render_html([])
        self.assertIn("height: 100vh; height: 100dvh", page)
        self.assertIn(".dashboard { box-sizing: border-box; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto;", page)
        self.assertIn(".kanban-board { display: grid; grid-template-columns: repeat(4, minmax(220px, 1fr));", page)
        self.assertIn(".kanban-board {", page)
        self.assertIn("overflow: auto;", page)
        self.assertIn(".kanban-lane-cards { display: grid; align-content: start;", page)
        self.assertNotIn('<meta http-equiv="refresh" content="5">', page)
        self.assertNotIn('d3.select(".graph")', page)
        self.assertNotIn('class="graph"', page)
        self.assertIn('refreshControl.addEventListener("click", () => setAutoRefreshEnabled(refreshControl.getAttribute("aria-pressed") !== "true"));', page)
        self.assertNotIn("onclick=", page)

    def test_auto_refresh_is_opt_in_persistent_and_toggleable(self):
        page = dashboard.render_html([])
        self.assertNotIn('<meta http-equiv="refresh"', page)
        self.assertIn('aria-label="Toggle automatic dashboard refresh" aria-pressed="false"', page)
        self.assertIn('.refresh-control[aria-pressed="true"] { border-color: rgba(74, 222, 128, .8); background: #16a34a;', page)
        self.assertIn('.refresh-control[aria-pressed="true"] .refresh-icon { animation: refresh-spin 1.5s linear infinite;', page)
        self.assertIn('const autoRefreshHash = "#auto-refresh";', page)
        self.assertIn('setAutoRefreshEnabled(window.location.hash === autoRefreshHash);', page)
        self.assertIn('window.setInterval(() => window.location.reload(), Number(refreshIntervalControl.value) * 1000)', page)
        self.assertIn('window.clearInterval(autoRefreshInterval)', page)
        self.assertIn('autoRefreshInterval = null', page)
        self.assertNotIn("sessionStorage", page)

    def test_auto_refresh_interval_is_adjustable_persistent_and_resets_timer(self):
        page = dashboard.render_html([])
        self.assertIn('id="refresh-interval" type="range" min="5" max="60" step="5" value="10"', page)
        self.assertIn('id="refresh-interval-value" class="refresh-interval-value" for="refresh-interval">10 sec', page)
        self.assertIn('const intervalParam = "refresh-interval";', page)
        self.assertIn('requestedInterval >= 5 && requestedInterval <= 60 && requestedInterval % 5 === 0 ? requestedInterval : 10', page)
        self.assertIn('url.searchParams.set(intervalParam, String(seconds));', page)
        self.assertIn('window.history.replaceState(null, "", url);', page)
        self.assertIn('refreshIntervalControl.addEventListener("input", updateRefreshInterval);', page)
        self.assertIn('window.clearInterval(autoRefreshInterval);', page)
        self.assertIn('window.setInterval(() => window.location.reload(), seconds * 1000)', page)
        self.assertIn('Number(refreshIntervalControl.value) * 1000', page)
        self.assertIn('const autoRefreshHash = "#auto-refresh";', page)
        self.assertIn('if (window.location.hash !== autoRefreshHash) window.location.hash = autoRefreshHash;', page)


if __name__ == "__main__":
    unittest.main()
