import type { UiRoles } from "../api/read-model.js";

// Fixture data for the role picker prototype (T-0007). It uses the `roles`
// read-model shape from /api/ui-data. Only the role preview server embeds it.

const plannerText = `# Role: Planner

Turn a goal into a clear, ordered plan before any work starts.

## Instructions

- Restate the goal and the expected result in one or two sentences.
- List assumptions and open decisions.
- Do not change files unless the owner asks you to.

## Workflow

1. Read the relevant files and notes before you plan.
2. Draft the plan as numbered steps with a check for each step.
3. Ask the owner to approve or change the plan.
`;

const designerText = `# Role: Designer

Shape screens and flows that are simple, consistent, and accessible.

## Instructions

- Start from the user's task, not from the widgets.
- Reuse existing styles and components.

## Workflow

1. Sketch the flow in words.
2. Propose one layout and explain the tradeoffs.
`;

// A valid role whose name and summary look like markup. The page must show them as text.
const markupText = `# Role: <img src=x onerror=alert(1)>

Summary with </script><script>alert(2)</script> & "quotes".

## Instructions

- <b>Not bold</b>: this line is plain text.

## Workflow

1. Check that nothing above ran or rendered as HTML.
`;

const list: UiRoles["list"] = [
  { id: "bad_name", name: null, summary: null, valid: false, reason: "invalid role id" },
  { id: "broken", name: null, summary: null, valid: false, reason: "missing or empty '## Instructions' section" },
  { id: "designer", name: "Designer", summary: "Shape screens and flows that are simple, consistent, and accessible.", valid: true, reason: null, text: designerText },
  { id: "leaky", name: null, summary: null, valid: false, reason: "secret-like text" },
  { id: "markup", name: "<img src=x onerror=alert(1)>", summary: "Summary with </script><script>alert(2)</script> & \"quotes\".", valid: true, reason: null, text: markupText },
  { id: "planner", name: "Planner", summary: "Turn a goal into a clear, ordered plan before any work starts.", valid: true, reason: null, text: plannerText },
];

const copy = (): UiRoles["list"] => list.map((role) => ({ ...role }));

/** Named fixture scenarios. The first one is shown first. */
export const roleFixtures: Record<string, UiRoles> = {
  equipped: { equipped: "planner", list: copy() },
  "not equipped": { equipped: null, list: copy() },
  "equipped invalid": { equipped: "broken", list: copy() },
  "equipped missing": { equipped: "reviewer", list: copy() },
  empty: { equipped: null, list: [] },
};
