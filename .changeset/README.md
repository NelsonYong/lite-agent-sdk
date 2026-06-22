# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets). Hover over a file
to see what it does, or read the [docs](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md).

## Workflow

```bash
pnpm changeset        # describe a change → writes a markdown file here
pnpm version          # consume changesets → bump versions + update CHANGELOGs
pnpm release          # build, then publish (when you're ready to publish to a registry)
```

The four published SDK packages (`lite-agent-sdk` + `@lite-agent-sdk/*`) are **fixed**: they share one version and bump together.
`@lite-agent-sdk/example-cli` is ignored (private, never published).
