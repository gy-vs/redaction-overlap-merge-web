# Redaction Review Studio

Local workbench for redaction findings.

Run `npm install`, then `npm run dev`.

## Redaction planning

All ranges are UTF-16 code-unit offsets into the document content of a fixed
revision. The server owns that content: plans and application are computed
against the stored revision (`409 revision_conflict` on a stale pin), never
against client-mutated text, so coordinates cannot go stale between preview
and apply.

- `POST /api/documents/:id/redactions/plan` — body `{revision, findings, decisions, resolutions?}`.
  Builds the canonical span set for accepted findings:
  - containment: the outer strategy dominates; inner findings are kept as
    audit references (`sources`) on the resulting span;
  - partial overlap with the same strategy: merged;
  - partial overlap with conflicting strategies: returned as
    `{status:'conflict', conflicts}` — never guessed. Resolve by re-planning
    with `resolutions: [{conflictId, strategy}]`;
  - adjacency: merged only when strategies match, otherwise kept separate;
  - zero-length ranges apply as pure insertions.
- `POST /api/documents/:id/redactions/apply` — same body. Fails with
  `422 unresolved_conflicts` until every conflict is resolved. Applies the
  canonical spans by streaming slices over the original content (no coordinate
  is ever reused after a replacement shifts the text) and responds with
  `{revision, spans, output, leaks}`, where `leaks` lists any accepted
  original that survived in the output.

The frontend recomputes the plan after every decision change; a stale preview
never overwrites a newer decision.
