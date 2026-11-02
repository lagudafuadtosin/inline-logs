/**
 * Processes that are tools, not the user's app. Their own children (the app
 * itself) still get the hook. Matched against the script path Node was
 * started with.
 */
const TOOL_SCRIPTS = [
  /[\\/]node_modules[\\/](npm|pnpm|yarn|corepack|@yarnpkg[\\/][^\\/]+|node-gyp|nodemon|concurrently|npm-run-all2?|turbo|lerna|nx|@nx[\\/][^\\/]+|husky|lint-staged|wait-on|cross-env|dotenv-cli)[\\/]/i,
  /[\\/]node_modules[\\/]\.bin[\\/](npm|npx|pnpm|pnpx|yarn|corepack|nodemon|concurrently|npm-run-all2?|run-s|run-p|turbo|lerna|nx|cross-env|dotenv)(\.c?js)?$/i,
  // tsx's own CLI only starts a child node with the real script in it.
  /[\\/]node_modules[\\/]tsx[\\/]dist[\\/]cli\.[cm]?js$/i,
  /[\\/]node_modules[\\/]\.bin[\\/]tsx$/i,
  // Global installs of package managers.
  /[\\/](npm-cli|npx-cli|pnpm|pnpx|yarn)\.c?js$/i,
  // VS Code's own command line (code --install-extension and friends) runs on
  // its Electron as Node, which reads NODE_OPTIONS too.
  /[\\/]resources[\\/]app[\\/]out[\\/]cli\.js$/i,
  // A program compiled with bun build --compile (Claude Code is one) reads
  // BUN_OPTIONS too. Its script lives in Bun's built-in file system.
  /^(B:[\\/]~BUN|[\\/]\$bunfs)[\\/]/i,
];

export function isToolProcess(argv1: string | undefined): boolean {
  if (!argv1) return false;
  return TOOL_SCRIPTS.some((r) => r.test(argv1));
}

