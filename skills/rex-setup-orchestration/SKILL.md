---
name: rex-setup-orchestration
description: Set up a project's AI team. Creates the team agents for one project, their roles and the flow work moves through, modeled on the Rex Desk team (a manager routes, a tester finds the cause, a builder fixes, a reviewer checks, the person decides).
---

# Set up a project's AI team

Use this when the person asks to apply the Rex Desk orchestration to one of their projects: it creates that project's team agents, gives each a clear role, and sets the flow work moves through. Agents are created, never deleted here.

Only the main agent (Rex Agent) runs this, with `desk_create_specialist`. Confirm the plan with the person before creating anything.

## Steps

1. Pick the project. If the person did not name one, read the project list (`desk_memory("index")`) and ask which project with `desk_ask`. The project must be one that is already set up.
2. Read the project so the roles fit what it is today: `desk_memory("<project>")`, its README or AGENTS.md, and its recent git log. A project with a user interface needs a web/UI role; a library or API may not.
3. Decide a small team. The Rex Desk team is the template, scaled to the project:
   - **Manager**: reads the task list and routes each piece of work; for bigger work opens a room to agree the plan first.
   - **Tester / QA**: uses the app like a real person, on every surface it ships, and finds the cause of a bug.
   - **Builder**: writes and fixes the code and runs the tests again. Add a separate **Web/UI** builder only if the project has its own UI.
   - **Code reviewer**: reviews each change locally before the person's OK. Name or purpose must say it reviews code, so the team wires it in.
   Keep it to the roles the project really needs. Do not invent extra agents.
4. Show the person the planned team (names and one-line roles) and get their OK with `desk_ask` before creating.
5. Create each agent with `desk_create_specialist`: pass `project`, a short human `name` that suits the project, a plain `purpose` (what the project is and what this agent does), and `rules` that carry the flow and the project's commit and review rules. Put anything you are unsure of in `unsure`.
6. Set the flow in each agent's rules and in the project's playbook (use the `rex-setup-playbook` skill): the manager routes; big work gets a meeting room first; the tester finds the cause; the builder fixes and tests; the reviewer reviews; the person says "push"; the builder ships. Nothing reaches users without the person's OK.
7. Tell the person who was created and what each one does, in a few plain lines.

Keep every name and role in English. No secrets in rules. Start small; the person can add agents later.
