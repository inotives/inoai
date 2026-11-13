import type { UiRoles } from "../api/read-model.js";

// Role picker test fixtures in the /api/ui-data `roles` shape (from the T-0007 prototype).

const list: UiRoles["list"] = [
  { id: "bad_name", name: null, summary: null, valid: false, reason: "invalid role id" },
  { id: "broken", name: null, summary: null, valid: false, reason: "missing or empty '## Instructions' section" },
  { id: "designer", name: "Designer", summary: "Shape screens and flows that are simple, consistent, and accessible.", valid: true, reason: null },
  { id: "leaky", name: null, summary: null, valid: false, reason: "secret-like text" },
  // A valid role whose name and summary look like markup. The page must show them as text.
  { id: "markup", name: "<img src=x onerror=alert(1)>", summary: "Summary with </script><script>alert(2)</script> & \"quotes\".", valid: true, reason: null },
  { id: "planner", name: "Planner", summary: "Turn a goal into a clear, ordered plan before any work starts.", valid: true, reason: null },
];

const copy = (): UiRoles["list"] => list.map((role) => ({ ...role }));

/** A fresh copy of a named scenario, so a test can change it freely. */
export function roleFixture(name: "equipped" | "not equipped" | "equipped invalid" | "equipped missing" | "empty"): UiRoles {
  switch (name) {
    case "equipped": return { equipped: "planner", list: copy() };
    case "not equipped": return { equipped: null, list: copy() };
    case "equipped invalid": return { equipped: "broken", list: copy() };
    case "equipped missing": return { equipped: "reviewer", list: copy() };
    case "empty": return { equipped: null, list: [] };
  }
}
