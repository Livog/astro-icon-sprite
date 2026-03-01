import type { AstroIntegration } from "astro";
import { readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { iconSprite, isLocalPath, resolveDir, type IconPluginOptions } from "./plugin";

const STACKS_INTEGRATION_NAME = "astro-stacks";

function scanSvgNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".svg"))
      .map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
}

export function scanAllIconNames(
  root: string,
  options: IconPluginOptions,
): Set<string> {
  const names = new Set<string>();

  const localDir = resolveDir(root, options.local ?? "src/icons");
  for (const name of scanSvgNames(localDir)) {
    names.add(name);
  }

  if (options.resolve) {
    for (const [prefix, dir] of Object.entries(options.resolve)) {
      const resolved = resolveDir(root, dir);
      for (const name of scanSvgNames(resolved)) {
        names.add(`${prefix}:${name}`);
      }
    }
  }

  return names;
}

export function generateIconDts(
  names: Set<string>,
  hasStacks: boolean,
): string {
  let dts = "export {}\n";

  dts += `\ndeclare module "virtual:icon-registry" {
  const registry: Record<string, { spriteId: string; viewBox: string; symbol: string }>;
  export default registry;
}\n`;

  if (names.size > 0) {
    const entries = [...names]
      .sort()
      .map((n) => `    ${JSON.stringify(n)}: true;`)
      .join("\n");
    dts += `\ndeclare module "astro-icon-sprite" {
  interface IconNames {
${entries}
  }
}\n`;
  }

  if (hasStacks) {
    dts += `\ndeclare module "astro-stacks" {
  interface StackNames {
    "iconSprite": true;
  }
}\n`;
  }

  return dts;
}

export default function astroIconSprite(
  options: IconPluginOptions = {},
): AstroIntegration {
  let dtsPath: string | undefined;
  let projectRoot: string | undefined;
  let lastSerialized: string | undefined;

  return {
    name: "astro-icon-sprite",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [
              iconSprite(options) as any,
              {
                name: "astro-icon-sprite-types",
                configureServer(server) {
                  if (!dtsPath || !projectRoot) return;

                  const watchDirs: string[] = [];
                  const localDir = resolveDir(
                    projectRoot,
                    options.local ?? "src/icons",
                  );
                  watchDirs.push(localDir);

                  if (options.resolve) {
                    for (const dir of Object.values(options.resolve)) {
                      if (isLocalPath(dir)) {
                        watchDirs.push(resolveDir(projectRoot, dir));
                      }
                    }
                  }

                  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

                  const handler = (file: string) => {
                    if (!file.endsWith(".svg")) return;
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(async () => {
                      const names = scanAllIconNames(projectRoot!, options);
                      const serialized = [...names].sort().join(",");
                      if (serialized === lastSerialized) return;
                      lastSerialized = serialized;
                      const hasStacks = true;
                      await writeFile(
                        dtsPath!,
                        generateIconDts(names, hasStacks),
                        "utf-8",
                      );
                      server.ws.send({ type: "full-reload" });
                    }, 200);
                  };

                  server.watcher.on("change", handler);
                  server.watcher.on("add", handler);
                  server.watcher.on("unlink", handler);
                },
              },
            ],
          },
        });
      },

      "astro:config:done": ({ config, injectTypes }) => {
        projectRoot = fileURLToPath(config.root);
        const hasStacks = config.integrations.some(
          (i: any) => i.name === STACKS_INTEGRATION_NAME,
        );

        if (!hasStacks) {
          console.warn(
            "[astro-icon-sprite] astro-stacks integration not found. Icons require astro-stacks middleware.",
          );
        }

        const names = scanAllIconNames(projectRoot, options);

        const result = injectTypes({
          filename: "types.d.ts",
          content: generateIconDts(names, hasStacks),
        });
        dtsPath = fileURLToPath(result);
        lastSerialized = [...names].sort().join(",");
      },
    },
  };
}
