---
name: rex-setup-playbook
description: Write a project's first playbook. Creates a project's starting workflow rules (branch, pull request target, testing, review, commit format, what never to touch) with desk_learn_workflow, so every agent on it works the same way.
---

# Write a project's first playbook

Use this to create a project's playbook from nothing: its workflow rules, the way the Rex Desk team has them. Agents can already update a playbook, but nothing creates the first one. Each rule is saved with `desk_learn_workflow(project, rule)` and every agent on that project reads it from then on.

## Steps

1. Pick the project. If none was named, read `desk_memory("index")` and ask with `desk_ask`.
2. Read what rules already exist: `desk_workflow("<project>")`. Only add what is missing; do not repeat a rule that is already there.
3. Learn how work is done. Ask the person the few things a playbook needs, or infer from the repo and confirm:
   - Which branch new work starts from, and what pull requests target.
   - How it is tested, and who reviews before it ships.
   - The commit message format.
   - What must never be touched, and anything that needs the person's OK (paid services, pushes).
4. Save each answer as one short rule with `desk_learn_workflow` (pass `project`). One line each, English, no secrets. A good starter set, shaped to the person's answers:
   - Start new work from the base branch and open pull requests into it.
   - One commit per task, in the team's format: `type(area): #TaskID, short summary, AgentName`.
   - Every change is tested, and the proof is shared with the person.
   - Every code change is reviewed before the person's OK.
   - Any UI change: send before and after screenshots and wait for the person's OK.
   - Nothing ships without the person's OK; the person says "push".
   - No paid services without the person's OK.
5. Read the playbook back with `desk_workflow` and show the person the rules you saved, in a few plain lines, so they can correct any.

Keep rules short and general. Save a fact, not a story. Never save keys, tokens or passwords.
