import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";

export interface IconPluginOptions {
  resolve?: Record<string, string>;
  local?: string;
}

interface CompiledIcon {
  spriteId: string;
  viewBox: string;
  symbol: string;
}

const VIRTUAL_ID = "virtual:icon-registry";
const RESOLVED_ID = "\0virtual:icon-registry";

const SCANNABLE_EXTS = /\.(astro|tsx?|jsx?|svelte|vue|html|mdx?)$/;
const ID_CLEAN = /[^a-zA-Z0-9_-]/g;
const SVG_OPEN = /^[\s\S]*?<svg[^>]*>/;
const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

const SVG_TAG_EXCLUDE = new Set([
  "xmlns", "xmlns:xlink", "version", "class", "style",
  "width", "height", "id", "x", "y",
]);
const SVG_ATTR_RE = /\b([\w:-]+)\s*=\s*["']([^"']*)["']/g;

function isLocalPath(dir: string): boolean {
  return /^(\.{0,2}\/|src\/)/.test(dir);
}

function resolveDir(root: string, dir: string): string {
  if (isLocalPath(dir)) return path.resolve(root, dir);
  return path.resolve(root, "node_modules", dir);
}

function sanitizeSvg(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("<script"))
    raw = raw.replace(/<script[\s>][\s\S]*?(<\/script>|$)/gi, "");
  if (lower.includes("<style"))
    raw = raw.replace(/<style[\s>][\s\S]*?(<\/style>|$)/gi, "");
  if (lower.includes("<foreignobject"))
    raw = raw.replace(/<foreignObject[\s>][\s\S]*?(<\/foreignObject>|$)/gi, "");
  if (lower.includes("<set") || lower.includes("<animate"))
    raw = raw.replace(/<(set|animate|animateTransform|animateMotion)\s[^>]*\/?>/gi, "");
  if (lower.includes(" on"))
    raw = raw.replace(/\s+on\w+\s*=\s*(?:["'][^"']*["']|[^\s>]+)/gi, "");
  if (lower.includes("javascript:") || lower.includes("data:"))
    raw = raw.replace(/\s+(href|xlink:href)\s*=\s*["']\s*(javascript|data):[^"']*["']/gi, "");
  return raw;
}

function parseSvgTag(svgTag: string): { viewBox: string; attrs: string } {
  let viewBox = "0 0 24 24";
  let attrs = "";
  for (const m of svgTag.matchAll(SVG_ATTR_RE)) {
    if (m[1] === "viewBox") { viewBox = m[2]; continue; }
    if (!SVG_TAG_EXCLUDE.has(m[1])) attrs += ` ${m[1]}="${m[2]}"`;
  }
  return { viewBox, attrs };
}

function compileIcon(name: string, rawSvg: string): CompiledIcon {
  const spriteId = "icon-" + name.replace(/:/g, "--").replace(ID_CLEAN, "");
  const svgTagMatch = SVG_OPEN.exec(rawSvg);
  const { viewBox, attrs } = svgTagMatch ? parseSvgTag(svgTagMatch[0]) : { viewBox: "0 0 24 24", attrs: "" };
  const openEnd = svgTagMatch ? svgTagMatch[0].length : 0;
  const closeStart = rawSvg.lastIndexOf("</svg>");
  const inner = rawSvg.slice(openEnd, closeStart === -1 ? undefined : closeStart);
  return { spriteId, viewBox, symbol: `<symbol id="${spriteId}" viewBox="${viewBox}"${attrs}>${inner}</symbol>` };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanSvgs(dir: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!fs.existsSync(dir)) return result;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".svg")) continue;
    const name = file.slice(0, -4);
    result.set(name, sanitizeSvg(fs.readFileSync(path.join(dir, file), "utf-8")));
  }
  return result;
}

let sourceFilesCache: string[] | null = null;

function getSourceFiles(root: string): string[] {
  if (sourceFilesCache) return sourceFilesCache;
  try {
    const stdout = execSync("git ls-files --cached --others --exclude-standard", {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    sourceFilesCache = stdout
      .trim()
      .split("\n")
      .filter((f) => f && SCANNABLE_EXTS.test(f))
      .map((f) => path.resolve(root, f));
  } catch {
    sourceFilesCache = walkSourceFiles(root);
  }
  return sourceFilesCache;
}

function walkSourceFiles(dir: string, results: string[] = [], depth = 0): string[] {
  if (depth > 20 || !fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, results, depth + 1);
    } else if (SCANNABLE_EXTS.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function scanUsedIcons(root: string, prefixes: string[]): Map<string, Set<string>> {
  const used = new Map(prefixes.map((p) => [p, new Set<string>()] as const));
  if (prefixes.length === 0) return used;

  const escaped = prefixes.map(escapeRegex);
  const pattern = new RegExp(
    `(${escaped.join("|")}):([A-Za-z0-9_-]+)`,
    "g",
  );

  for (const file of getSourceFiles(root)) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const match of content.matchAll(pattern)) {
      used.get(match[1])?.add(match[2]);
    }
  }

  return used;
}

function createIconReader(dir: string) {
  let realDir: string;
  let dirPrefix: string;
  try {
    realDir = fs.realpathSync(dir);
    dirPrefix = realDir + path.sep;
  } catch {
    return () => null;
  }

  return (name: string): string | null => {
    if (!SAFE_NAME.test(name)) return null;
    try {
      const real = fs.realpathSync(path.resolve(realDir, `${name}.svg`));
      if (!real.startsWith(dirPrefix)) return null;
      return sanitizeSvg(fs.readFileSync(real, "utf-8"));
    } catch {
      return null;
    }
  };
}

function buildRegistry(
  root: string,
  options: IconPluginOptions,
): Record<string, CompiledIcon> {
  const registry: Record<string, CompiledIcon> = Object.create(null);
  const localDir = resolveDir(root, options.local ?? "src/icons");

  for (const [name, svg] of scanSvgs(localDir)) {
    registry[name] = compileIcon(name, svg);
  }

  if (options.resolve) {
    const prefixes = Object.keys(options.resolve);
    const used = scanUsedIcons(root, prefixes);

    for (const [prefix, dir] of Object.entries(options.resolve)) {
      const resolved = resolveDir(root, dir);
      if (!fs.existsSync(resolved)) {
        console.warn(`[icons] Directory not found: ${resolved}`);
        continue;
      }

      if (isLocalPath(dir)) {
        for (const [name, svg] of scanSvgs(resolved)) {
          const key = `${prefix}:${name}`;
          registry[key] = compileIcon(key, svg);
        }
      } else {
        const readIcon = createIconReader(resolved);
        const icons = used.get(prefix) ?? new Set();
        for (const name of icons) {
          const svg = readIcon(name);
          if (svg) {
            const key = `${prefix}:${name}`;
            registry[key] = compileIcon(key, svg);
          } else {
            console.warn(`[icons] Icon not found: ${prefix}:${name} (${resolved}/${name}.svg)`);
          }
        }
      }
    }
  }

  return registry;
}

export function iconSprite(options: IconPluginOptions = {}): Plugin {
  let root: string;
  let registry: Record<string, CompiledIcon>;
  let registryJson: string;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let devServer: ViteDevServer | null = null;
  let prefixPattern: RegExp | null = null;
  let iconReaders: Map<string, (name: string) => string | null> | null = null;

  function invalidate() {
    const json = JSON.stringify(registry);
    if (json === registryJson) return;
    registryJson = json;
    if (devServer) {
      const mod = devServer.moduleGraph.getModuleById(RESOLVED_ID);
      if (mod) devServer.moduleGraph.invalidateModule(mod);
      devServer.ws.send({ type: "full-reload" });
    }
  }

  function rebuildSvgs() {
    sourceFilesCache = null;
    registry = buildRegistry(root, options);
    invalidate();
  }

  return {
    name: "vite-plugin-icon-sprite",

    configResolved(config) {
      root = config.root;
      registry = buildRegistry(root, options);
      registryJson = JSON.stringify(registry);

      if (options.resolve) {
        const prefixes = Object.keys(options.resolve);
        if (prefixes.length > 0) {
          prefixPattern = new RegExp(
            `(${prefixes.map(escapeRegex).join("|")}):([A-Za-z0-9_-]+)`,
            "g",
          );
          iconReaders = new Map();
          for (const [prefix, dir] of Object.entries(options.resolve)) {
            if (!isLocalPath(dir)) {
              const resolved = resolveDir(root, dir);
              if (fs.existsSync(resolved)) {
                iconReaders.set(prefix, createIconReader(resolved));
              }
            }
          }
        }
      }
    },

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
    },

    load(id) {
      if (id === RESOLVED_ID) {
        return `export default ${registryJson};`;
      }
    },

    transform: {
      filter: { id: SCANNABLE_EXTS },
      handler(code: string, id: string) {
        if (!prefixPattern || !iconReaders || id.includes("/node_modules/")) return null;

        const prefixes = Object.keys(options.resolve!);
        if (!prefixes.some((p) => code.includes(p + ":"))) return null;

        let changed = false;
        for (const m of code.matchAll(prefixPattern)) {
          const key = `${m[1]}:${m[2]}`;
          if (key in registry) continue;

          const reader = iconReaders.get(m[1]);
          if (!reader) continue;

          const svg = reader(m[2]);
          if (svg) {
            registry[key] = compileIcon(key, svg);
            changed = true;
          }
        }

        if (changed) invalidate();
        return null;
      },
    },

    buildEnd() {
      if (debounceTimer) clearTimeout(debounceTimer);
    },

    configureServer(server: ViteDevServer) {
      devServer = server;

      const watchDirs: string[] = [];
      const localDir = resolveDir(root, options.local ?? "src/icons");
      if (fs.existsSync(localDir)) watchDirs.push(localDir);

      if (options.resolve) {
        for (const dir of Object.values(options.resolve)) {
          if (isLocalPath(dir)) {
            const resolved = resolveDir(root, dir);
            if (fs.existsSync(resolved)) watchDirs.push(resolved);
          }
        }
      }

      if (watchDirs.length > 0) server.watcher.add(watchDirs);

      server.watcher.on("all", (event, file) => {
        if (file.endsWith(".svg") && watchDirs.some((d) => file.startsWith(d))) {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(rebuildSvgs, 200);
        }
      });
    },
  };
}
