export function windowsPathToWsl(path) {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
  if (!match) {
    return path;
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

export function wslPathToWindows(path) {
  const match = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(path);
  if (!match) {
    return path;
  }
  return `${match[1].toUpperCase()}:\\${match[2].replaceAll("/", "\\")}`;
}

export function normalizePathForCompare(path) {
  const normalized = String(path)
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  return normalized || "/";
}

export function pathsEqual(left, right) {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

export function pathIsInsideRoot(path, root) {
  const normalizedPath = normalizePathForCompare(path);
  const normalizedRoot = normalizePathForCompare(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function parseVmx(text) {
  const config = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([^=]+?)\s*=\s*"(.*)"\s*$/.exec(trimmed);
    if (match) {
      config[match[1].trim()] = match[2].replace(/\\"/g, "\"");
    }
  }
  return config;
}

export function updateVmxText(raw, updates) {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingEol = raw.endsWith("\n");
  const keys = new Set(Object.keys(updates));
  const seen = new Set();
  const lines = raw.replace(/\r?\n$/, "").split(/\r?\n/).map(line => {
    const match = /^([^=]+?)\s*=/.exec(line.trim());
    if (!match) {
      return line;
    }
    const key = match[1].trim();
    if (!keys.has(key)) {
      return line;
    }
    seen.add(key);
    return `${key} = "${String(updates[key]).replaceAll("\"", "\\\"")}"`;
  });
  for (const key of keys) {
    if (!seen.has(key)) {
      lines.push(`${key} = "${String(updates[key]).replaceAll("\"", "\\\"")}"`);
    }
  }
  return `${lines.join(eol)}${hasTrailingEol ? eol : ""}`;
}

export function parseRunningVms(output) {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.toLowerCase().startsWith("total running vms:"));
}

export function parseSnapshots(output) {
  return output
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .filter(line => !line.toLowerCase().startsWith("total snapshots:"));
}

export function redactVmrunArgs(args) {
  return args.map((arg, index) => args[index - 1] === "-gp" ? "[redacted]" : arg);
}

export function requireConfirmation(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Confirmation required: set confirm to "${expected}".`);
  }
}

export function coerceTimeoutMs(value, fallback = 120000, { min = 1000, max = 900000 } = {}) {
  const timeoutMs = Number(value ?? fallback);
  if (!Number.isFinite(timeoutMs) || timeoutMs < min || timeoutMs > max) {
    throw new Error(`timeoutMs must be a number between ${min} and ${max}.`);
  }
  return timeoutMs;
}
