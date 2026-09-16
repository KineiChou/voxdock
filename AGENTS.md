# VoxDock development

- Keep changes scoped to one issue or cohesive feature branch.
- Use TypeScript/Node 24, pnpm, and the published contracts; keep native adapters isolated.
- Only maintainers integrate into main. Workers commit their assigned branch and report evidence.
- Main must remain buildable and tested for the capabilities it claims.
- Run the smallest meaningful checks. Do not contact real accounts or paid services in ordinary tests.
- Keep README capability status and relevant docs aligned with implemented behavior.
- Record significant decisions and real defects in engineering docs; never invent validation results.
- Do not add product brainstorming, personal background, credentials, raw private conversations, or unrelated parent-project documents.
- Never log secrets, raw credentials, QR sessions, or full private payloads. Audio is not persisted by default.
- Call side effects require durable identity and explicit target binding; uncertain outcomes never trigger blind redial.
- Do not import private parent project paths in code or public documentation.
