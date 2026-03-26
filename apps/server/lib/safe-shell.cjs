const DEFAULT_SHELL_WHITELIST = [
  /^git status\b/i,
  /^git diff\b/i,
  /^npm test\b/i,
  /^npm run build\b/i,
  /^dotnet --info\b/i,
  /^dotnet --version\b/i,
  /^dotnet build\b/i
];

function getExtraShellPrefixes() {
  return String(process.env.A11_SHELL_ALLOWLIST || '')
    .split(/[\r\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isShellAllowed(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  const normalized = cmd.trim();
  if (!normalized) return false;

  if (DEFAULT_SHELL_WHITELIST.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const lowered = normalized.toLowerCase();
  return getExtraShellPrefixes().some((prefix) => lowered.startsWith(prefix.toLowerCase()));
}

function getShellAllowlistSummary() {
  return {
    defaultExamples: [
      'git status',
      'git diff',
      'npm test',
      'npm run build',
      'dotnet --info',
      'dotnet --version',
      'dotnet build'
    ],
    extraPrefixes: getExtraShellPrefixes()
  };
}

function assertShellAllowed(cmd, label = 'command') {
  if (isShellAllowed(cmd)) return;

  const summary = getShellAllowlistSummary();
  const allowed = [...summary.defaultExamples, ...summary.extraPrefixes];
  throw new Error(`${label} not allowed by whitelist: "${cmd}". Allowed prefixes/examples: ${allowed.join(', ')}`);
}

module.exports = {
  isShellAllowed,
  assertShellAllowed,
  getShellAllowlistSummary
};
