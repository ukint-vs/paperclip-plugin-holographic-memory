import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Detect whether a module is being run directly as a script (vs imported by
// tests / other modules). The challenge: npm bin invocations create a
// symlink at e.g. /usr/local/bin/<bin-name> pointing at dist/<file>.js.
// argv[1] is the symlink path; `import.meta.url` resolves to the real path.
// Naive string equality (`argv1 === filename`) fails for symlinks. Naive
// regex on argv1 misses bin invocations because the bin basename has no
// relation to the source file basename. Regex on filename returns true
// whenever the module is imported (test runner pollution).
//
// realpathSync(argv1) resolves the symlink to the same real path as the
// loaded module. Both bin invocations and direct invocations match;
// imports-by-other-modules (where argv1 is the test runner) don't.
//
// 0.4.0 shipped scripts/setup-mcp.ts with the regex-on-argv1 variant and
// silently no-op'd for every npm-bin user.
export function isInvokedAsScript(importMetaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  let filename: string;
  try {
    filename = fileURLToPath(importMetaUrl);
  } catch {
    // Malformed/non-file URL — never expected in any production path.
    return false;
  }
  if (argv1 === filename) return true;
  // Apply realpathSync to both sides: macOS prefixes paths under /var with
  // /private (a system-level symlink); without resolving both, /var/foo and
  // realpath(/var/foo) won't string-match.
  try {
    return realpathSync(argv1) === realpathSync(filename);
  } catch {
    // argv1 or filename doesn't exist on disk (synthetic / removed). Not
    // an invocation we can verify; default to "no, don't run main()."
    return false;
  }
}
