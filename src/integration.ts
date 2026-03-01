import type { AstroIntegration } from "astro";
import { iconSprite, type IconPluginOptions } from "./plugin";

export default function astroIconSprite(options: IconPluginOptions = {}): AstroIntegration {
  return {
    name: "astro-icon-sprite",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({ vite: { plugins: [iconSprite(options) as any] } });
      },
      "astro:config:done": ({ config }) => {
        const hasStacks = config.integrations.some((i: any) => i.name === "astro-stacks");
        if (!hasStacks) {
          console.warn("[astro-icon-sprite] astro-stacks integration not found. Icons require astro-stacks middleware.");
        }
      },
    },
  };
}
