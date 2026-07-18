import { HomeLayout as BasicHomeLayout } from "@rspress/core/theme-original";
import type { ComponentProps } from "react";

const install = "pnpm add @lite-agent/sdk @lite-agent/provider zod";

const example = `import { query } from "@lite-agent/sdk";
import { anthropic } from "@lite-agent/provider";

for await (const ev of query({
  prompt: "List the files here and summarize this project.",
  model: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  modelName: "claude-sonnet-4-6",
  cwd: process.cwd(),
})) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
}`;

function Quickstart() {
  return (
    <div className="la-home-quickstart">
      <pre className="la-home-quickstart__cmd">
        <code>{install}</code>
      </pre>
      <pre className="la-home-quickstart__code">
        <code>{example}</code>
      </pre>
    </div>
  );
}

export function HomeLayout(props: ComponentProps<typeof BasicHomeLayout>) {
  return <BasicHomeLayout {...props} afterFeatures={<Quickstart />} />;
}

export * from "@rspress/core/theme-original";
