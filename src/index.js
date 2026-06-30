#!/usr/bin/env node

import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, delimiter, dirname, join, sep } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  windowsPathToWsl,
  wslPathToWindows,
  parseVmx,
  updateVmxText,
  parseRunningVms,
  parseSnapshots,
  redactVmrunArgs,
  requireConfirmation,
  coerceTimeoutMs,
  pathsEqual,
  pathIsInsideRoot
} from "./utils.js";

const isWindows = platform() === "win32";
const isWsl = !isWindows && detectWsl();

const SOFT_HARD = z.enum(["soft", "hard"]);
const GUEST_CREDENTIALS = {
  guestUser: z.string().min(1).describe("Guest OS username."),
  guestPassword: z.string().min(1).describe("Guest OS password.")
};
const VM_REF = {
  vmxPath: z.string().min(1).optional().describe("Path to a .vmx file. WSL /mnt/c paths are accepted."),
  vmName: z.string().min(1).optional().describe("VM alias, matching the .vmx basename or VMX displayName.")
};
const CONFIRM = {
  confirm: z.string().optional().describe("Required confirmation token for high-risk operations.")
};
const config = loadConfig();
const vmCache = {
  expiresAt: 0,
  rootsKey: "",
  maxDepth: 0,
  vms: []
};

function detectWsl() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return true;
  }
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function loadConfig() {
  const candidates = [
    process.env.VMWARE_MCP_CONFIG,
    join(process.cwd(), "vmware-mcp.config.json")
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, "utf8"));
    } catch (error) {
      if (process.env.VMWARE_MCP_CONFIG === candidate) {
        throw error;
      }
    }
  }
  return {};
}

function configValue(path, fallback) {
  let value = config;
  for (const part of path.split(".")) {
    value = value?.[part];
  }
  return value ?? fallback;
}

function text(content) {
  return { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content, null, 2) }] };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}


function pathForVmrun(path) {
  return isWsl ? wslPathToWindows(path) : path;
}

function pathForHost(path) {
  return isWsl ? windowsPathToWsl(path) : path;
}

function executableCandidates() {
  const fromEnv = process.env.VMRUN_PATH ? [process.env.VMRUN_PATH] : [];
  if (isWindows) {
    return [
      ...fromEnv,
      "C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe",
      "C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe",
      "vmrun.exe"
    ];
  }
  if (isWsl) {
    return [
      ...fromEnv.map(windowsPathToWsl),
      "/mnt/c/Program Files (x86)/VMware/VMware Workstation/vmrun.exe",
      "/mnt/c/Program Files/VMware/VMware Workstation/vmrun.exe",
      "vmrun.exe"
    ];
  }
  return [...fromEnv, "vmrun"];
}

async function canExecute(path) {
  if (path.includes(sep) || path.includes("/")) {
    try {
      const mode = path.toLowerCase().endsWith(".exe") ? fsConstants.F_OK : fsConstants.X_OK;
      await access(path, mode);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

async function resolveVmrun() {
  for (const candidate of executableCandidates()) {
    if (await canExecute(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "vmrun executable was not found. Set VMRUN_PATH to VMware Workstation's vmrun.exe path."
  );
}

function vmrunArgs(args) {
  const vmrunType = process.env.VMRUN_TYPE ?? configValue("vmrunType", "ws");
  return vmrunType ? ["-T", vmrunType, ...args] : args;
}

function powershellPath() {
  return process.env.POWERSHELL_PATH ?? configValue("powershellPath", "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
}

function usePowershellBridge(vmrun) {
  if (!isWsl) {
    return false;
  }
  if (process.env.VMRUN_USE_POWERSHELL) {
    return !["0", "false", "no"].includes(process.env.VMRUN_USE_POWERSHELL.toLowerCase());
  }
  return vmrun.toLowerCase().endsWith(".exe");
}

function quotePowershell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function bridgeUrl() {
  return process.env.VMRUN_BRIDGE_URL ?? configValue("bridge.url", configValue("bridgeUrl", undefined));
}

function bridgeToken() {
  return process.env.VMRUN_BRIDGE_TOKEN ?? configValue("bridge.token", undefined);
}

async function runVmrunBridge(args, options = {}) {
  const url = bridgeUrl();
  if (!url) {
    throw new Error("VMRUN_BRIDGE_URL is not set.");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bridgeToken() ? { authorization: `Bearer ${bridgeToken()}` } : {})
    },
    body: JSON.stringify({
      args,
      timeoutMs: coerceTimeoutMs(options.timeoutMs ?? process.env.VMRUN_TIMEOUT_MS)
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const message = payload.error || `vmrun bridge returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return {
    code: payload.code ?? 0,
    stdout: payload.stdout ?? "",
    stderr: payload.stderr ?? "",
    command: payload.command ?? ["vmrun", ...redactVmrunArgs(args)]
  };
}

function vmrunInvocation(vmrun, args) {
  const displayArgs = redactVmrunArgs(args);
  if (!usePowershellBridge(vmrun)) {
    return { command: vmrun, args, display: [vmrun, ...displayArgs] };
  }

  const vmrunWindowsPath = pathForVmrun(vmrun);
  const command = `& ${[vmrunWindowsPath, ...args].map(quotePowershell).join(" ")}; exit $LASTEXITCODE`;
  const displayCommand = `& ${[vmrunWindowsPath, ...displayArgs].map(quotePowershell).join(" ")}; exit $LASTEXITCODE`;
  const powershellArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command];
  return {
    command: powershellPath(),
    args: powershellArgs,
    display: [powershellPath(), "-Command", displayCommand]
  };
}

async function runVmrun(args, options = {}) {
  const finalArgs = vmrunArgs(args);
  if (bridgeUrl()) {
    return await runVmrunBridge(finalArgs, options);
  }

  const vmrun = await resolveVmrun();
  const invocation = vmrunInvocation(vmrun, finalArgs);
  const displayArgs = redactVmrunArgs(finalArgs);
  const timeoutMs = coerceTimeoutMs(options.timeoutMs ?? process.env.VMRUN_TIMEOUT_MS);

  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`vmrun timed out after ${timeoutMs} ms: ${displayArgs.join(" ")}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim(), command: invocation.display };
      if (code === 0) {
        resolve(result);
        return;
      }
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n");
      reject(new Error(`vmrun exited with code ${code}: ${displayArgs.join(" ")}${detail ? `\n${detail}` : ""}`));
    });
  });
}


function vmSummary(vmxPath, runningVms = []) {
  const hostPath = isWsl ? windowsPathToWsl(vmxPath) : vmxPath;
  const vmrunPath = pathForVmrun(hostPath);
  return {
    name: basename(hostPath, ".vmx"),
    hostPath,
    vmrunPath,
    directory: dirname(hostPath),
    running: runningVms.some(runningPath => pathsEqual(pathForHost(runningPath), hostPath) || pathsEqual(runningPath, vmrunPath))
  };
}

function guestAuthArgs({ guestUser, guestPassword }) {
  return ["-gu", guestUser, "-gp", guestPassword];
}

function parseGuestDirectory(output) {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function envList(name) {
  const value = process.env[name];
  if (value) {
    return value.split(/[,:;]/).map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function envPathList(name) {
  const value = process.env[name];
  if (value) {
    return value.split(delimiter).map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function isTruthyEnv(name) {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").toLowerCase());
}

function operationPolicy() {
  return {
    readonly: isTruthyEnv("VMWARE_MCP_READONLY") || Boolean(configValue("policy.readonly", false)),
    allowedActions: envList("VMWARE_ALLOWED_ACTIONS").length ? envList("VMWARE_ALLOWED_ACTIONS") : configValue("policy.allowedActions", []),
    deniedActions: envList("VMWARE_DENIED_ACTIONS").length ? envList("VMWARE_DENIED_ACTIONS") : configValue("policy.deniedActions", []),
    allowedRoots: envPathList("VMWARE_ALLOWED_ROOTS").length ? envPathList("VMWARE_ALLOWED_ROOTS") : configValue("policy.allowedRoots", [])
  };
}

function enforceOperation({ action, category, mutates = false, vmxPath }) {
  const policy = operationPolicy();
  const actionTokens = [action, category].filter(Boolean);

  if (policy.readonly && mutates) {
    throw new Error(`Operation ${action} is blocked by VMWARE_MCP_READONLY=1.`);
  }
  if (policy.deniedActions.some(denied => actionTokens.includes(denied))) {
    throw new Error(`Operation ${action} is blocked by VMWARE_DENIED_ACTIONS.`);
  }
  if (policy.allowedActions.length > 0 && !policy.allowedActions.some(allowed => actionTokens.includes(allowed))) {
    throw new Error(`Operation ${action} is not allowed by VMWARE_ALLOWED_ACTIONS.`);
  }
  if (vmxPath && policy.allowedRoots.length > 0) {
    const hostPath = pathForHost(vmxPath);
    const allowed = policy.allowedRoots.some(root => pathIsInsideRoot(hostPath, pathForHost(root)));
    if (!allowed) {
      throw new Error(`VM path is outside VMWARE_ALLOWED_ROOTS: ${pathForHost(vmxPath)}`);
    }
  }
}


function cacheTtlMs() {
  return Number(process.env.VMWARE_VM_CACHE_TTL_MS ?? configValue("cache.ttlMs", 300000));
}

function discoveryDepth() {
  return Number(process.env.VMWARE_DISCOVERY_DEPTH ?? configValue("discoveryDepth", 7));
}

function configuredRoots() {
  if (process.env.VMWARE_VMX_ROOTS) {
    return process.env.VMWARE_VMX_ROOTS.split(delimiter).filter(Boolean);
  }
  const configured = configValue("searchRoots", undefined);
  if (Array.isArray(configured) && configured.length > 0) {
    return configured;
  }

  const roots = [
    join(homedir(), "vmware"),
    join(homedir(), "VMs"),
    join(homedir(), "Documents", "Virtual Machines")
  ];
  if (isWsl) {
    roots.push("/mnt/c/Users");
    for (const drive of ["d", "e"]) {
      roots.push(`/mnt/${drive}/Virtual Machines`, `/mnt/${drive}/VMs`, `/mnt/${drive}/vmware`);
    }
  }
  return roots;
}

async function existingSearchRoots(roots) {
  const found = [];
  for (const root of roots) {
    try {
      const info = await stat(root);
      if (info.isDirectory()) {
        found.push(root);
      }
    } catch {
      // Missing default roots are expected.
    }
  }
  return found;
}

async function findVmxFiles(root, maxDepth, results) {
  if (maxDepth < 0) {
    return;
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".vmx")) {
      results.push(path);
      continue;
    }
    if (entry.isDirectory()) {
      await findVmxFiles(path, maxDepth - 1, results);
    }
  }
}

async function discoverVms(roots, maxDepth) {
  const existing = await existingSearchRoots(roots);
  const results = [];
  for (const root of existing) {
    const depth = isWsl && root === "/mnt/c/Users" ? Math.max(maxDepth, 4) : maxDepth;
    await findVmxFiles(root, depth, results);
  }
  return [...new Set(results)].sort();
}

async function refreshVmCache(roots = configuredRoots(), maxDepth = discoveryDepth()) {
  const vms = await discoverVms(roots, maxDepth);
  vmCache.expiresAt = Date.now() + cacheTtlMs();
  vmCache.rootsKey = JSON.stringify(roots);
  vmCache.maxDepth = maxDepth;
  vmCache.vms = vms;
  return vmCache;
}

async function cachedVms(roots = configuredRoots(), maxDepth = discoveryDepth(), force = false) {
  const rootsKey = JSON.stringify(roots);
  if (!force && vmCache.expiresAt > Date.now() && vmCache.rootsKey === rootsKey && vmCache.maxDepth === maxDepth) {
    return vmCache.vms;
  }
  const refreshed = await refreshVmCache(roots, maxDepth);
  return refreshed.vms;
}

async function readVmxConfig(vmxPath) {
  const hostPath = pathForHost(vmxPath);
  const raw = await readFile(hostPath, "utf8");
  return { hostPath, raw, config: parseVmx(raw) };
}


async function runGuestProgram({ vmxPath, guestUser, guestPassword, programPath, programArgs = [], noWait = false, activeWindow = false, interactive = false, timeoutMs }) {
  const flags = [];
  if (noWait) {
    flags.push("-noWait");
  }
  if (activeWindow) {
    flags.push("-activeWindow");
  }
  if (interactive) {
    flags.push("-interactive");
  }
  return await runVmrun([
    ...guestAuthArgs({ guestUser, guestPassword }),
    "runProgramInGuest",
    pathForVmrun(vmxPath),
    ...flags,
    programPath,
    ...programArgs
  ], { timeoutMs });
}

async function resolveVmReference({ vmxPath, vmName }) {
  if (vmxPath) {
    return pathForHost(vmxPath);
  }
  if (!vmName) {
    throw new Error("Specify either vmxPath or vmName.");
  }

  const aliases = configValue("aliases", {});
  if (aliases && typeof aliases === "object" && aliases[vmName]) {
    return pathForHost(aliases[vmName]);
  }

  const roots = configuredRoots();
  const maxDepth = discoveryDepth();
  const vmxFiles = await cachedVms(roots, maxDepth);
  const wanted = vmName.toLowerCase();
  const matches = [];
  for (const candidate of vmxFiles) {
    const baseName = basename(candidate, ".vmx").toLowerCase();
    if (baseName === wanted) {
      matches.push({ vmxPath: candidate, match: "basename" });
      continue;
    }
    try {
      const { config } = await readVmxConfig(candidate);
      if ((config.displayName ?? "").toLowerCase() === wanted) {
        matches.push({ vmxPath: candidate, match: "displayName" });
      }
    } catch {
      // Ignore unreadable candidates during alias resolution.
    }
  }

  if (matches.length === 0) {
    throw new Error(`No VM matched vmName "${vmName}". Use find_vms to inspect available aliases.`);
  }
  if (matches.length > 1) {
    throw new Error(`VM name "${vmName}" is ambiguous: ${matches.map(match => match.vmxPath).join(", ")}`);
  }
  return pathForHost(matches[0].vmxPath);
}

function checkPort(host, port, timeoutMs = 5000) {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const done = open => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForCondition(check, { timeoutMs = 120000, intervalMs = 3000 }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    last = await check();
    if (last?.ready) {
      return last;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms.${last?.message ? ` Last state: ${last.message}` : ""}`);
}

async function safeListRunningVms() {
  try {
    const result = await runVmrun(["list"]);
    return parseRunningVms(result.stdout);
  } catch {
    return [];
  }
}

async function waitForVmReadiness(resolvedVmxPath, { waitForTools, waitForIp, port, timeoutMs, intervalMs }) {
  return await waitForCondition(async () => {
    const state = { ready: true };
    if (waitForTools) {
      try {
        const tools = await runVmrun(["checkToolsState", pathForVmrun(resolvedVmxPath)]);
        state.toolsState = tools.stdout;
        if (!/running|installed/i.test(tools.stdout)) {
          return { ready: false, message: `tools=${tools.stdout}` };
        }
      } catch (error) {
        return { ready: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    if (waitForIp || port) {
      try {
        const ip = await runVmrun(["getGuestIPAddress", pathForVmrun(resolvedVmxPath)]);
        state.ipAddress = ip.stdout;
        if (!ip.stdout) {
          return { ready: false, message: "guest IP is empty" };
        }
      } catch (error) {
        return { ready: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    if (port) {
      const open = await checkPort(state.ipAddress, port, Math.min(intervalMs, 5000));
      state.port = port;
      state.portOpen = open;
      if (!open) {
        return { ready: false, message: `port ${port} is closed` };
      }
    }
    return state;
  }, { timeoutMs, intervalMs });
}

function vmxSchema(description = "Path to a .vmx file. WSL /mnt/c paths are accepted.") {
  return z.string().min(1).describe(description);
}

async function vmDetails(vmxPath, options = {}) {
  const hostPath = pathForHost(vmxPath);
  const runningVms = options.runningVms ?? await safeListRunningVms();
  const summary = vmSummary(hostPath, runningVms);
  let configSummary;
  try {
    const { config } = await readVmxConfig(hostPath);
    configSummary = {
      displayName: config.displayName,
      guestOS: config.guestOS,
      memsize: config.memsize,
      numvcpus: config.numvcpus,
      firmware: config.firmware,
      ethernet0ConnectionType: config["ethernet0.connectionType"]
    };
  } catch (error) {
    configSummary = { error: error instanceof Error ? error.message : String(error) };
  }

  const details = { ...summary, config: configSummary };
  if (options.includeSnapshots) {
    try {
      const result = await runVmrun(["listSnapshots", pathForVmrun(hostPath)]);
      details.snapshots = parseSnapshots(result.stdout);
    } catch (error) {
      details.snapshotsError = error instanceof Error ? error.message : String(error);
    }
  }
  if (options.includeGuestIp && summary.running) {
    try {
      const result = await runVmrun(["getGuestIPAddress", pathForVmrun(hostPath)]);
      details.guestIpAddress = result.stdout;
    } catch (error) {
      details.guestIpAddressError = error instanceof Error ? error.message : String(error);
    }
  }
  if (options.includeToolsState && summary.running) {
    try {
      const result = await runVmrun(["checkToolsState", pathForVmrun(hostPath)]);
      details.toolsState = result.stdout;
    } catch (error) {
      details.toolsStateError = error instanceof Error ? error.message : String(error);
    }
  }
  return details;
}

const server = new McpServer({
  name: "vmware-workstation-mcp",
  version: "0.1.0"
});

server.registerTool("server_info", {
  title: "Server Info",
  description: "Show vmrun detection and VM search settings.",
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async () => {
  try {
    const vmrun = bridgeUrl() ? undefined : await resolveVmrun();
    return text({
      vmrun,
      bridgeUrl: bridgeUrl(),
      isWsl,
      isWindows,
      searchRoots: configuredRoots(),
      operationPolicy: operationPolicy(),
      vmrunType: process.env.VMRUN_TYPE ?? "ws",
      vmrunUsePowershell: vmrun ? usePowershellBridge(vmrun) : false,
      powershellPath: vmrun && usePowershellBridge(vmrun) ? powershellPath() : undefined,
      vmrunTimeoutMs: Number(process.env.VMRUN_TIMEOUT_MS ?? 120000)
    });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("diagnose_environment", {
  title: "Diagnose Environment",
  description: "Check Node, WSL, vmrun/bridge, search roots, policy, and running VM visibility.",
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async () => {
  const diagnostics = {
    node: process.version,
    platform: platform(),
    isWsl,
    bridgeUrl: bridgeUrl(),
    configLoaded: Object.keys(config).length > 0,
    searchRoots: [],
    policy: operationPolicy(),
    vmrun: undefined,
    runningVms: undefined,
    errors: []
  };
  try {
    diagnostics.vmrun = bridgeUrl() ? "bridge" : await resolveVmrun();
  } catch (error) {
    diagnostics.errors.push(error instanceof Error ? error.message : String(error));
  }
  for (const root of configuredRoots()) {
    try {
      const info = await stat(root);
      diagnostics.searchRoots.push({ root, exists: true, directory: info.isDirectory() });
    } catch {
      diagnostics.searchRoots.push({ root, exists: false });
    }
  }
  try {
    enforceOperation({ action: "diagnose_environment", category: "read" });
    const result = await runVmrun(["list"]);
    diagnostics.runningVms = parseRunningVms(result.stdout);
  } catch (error) {
    diagnostics.errors.push(error instanceof Error ? error.message : String(error));
  }
  return text(diagnostics);
});

server.registerTool("find_vms", {
  title: "Find VMs",
  description: "Find VMware .vmx files under configured or provided roots.",
  inputSchema: {
    roots: z.array(z.string().min(1)).optional().describe("Directories to scan. Defaults to VMWARE_VMX_ROOTS or common VMware locations."),
    maxDepth: z.number().int().min(0).max(12).default(5).describe("Maximum directory depth to scan.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ roots, maxDepth }) => {
  try {
    enforceOperation({ action: "find_vms", category: "read" });
    const scanRoots = roots?.length ? roots : configuredRoots();
    const vms = await discoverVms(scanRoots, maxDepth);
    const runningVms = await safeListRunningVms();
    return text({ roots: scanRoots, count: vms.length, vms: vms.map(vmxPath => vmSummary(vmxPath, runningVms)) });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("refresh_vm_cache", {
  title: "Refresh VM Cache",
  description: "Refresh the discovered VM cache used by vmName alias resolution.",
  inputSchema: {
    roots: z.array(z.string().min(1)).optional(),
    maxDepth: z.number().int().min(0).max(12).default(discoveryDepth())
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ roots, maxDepth }) => {
  try {
    enforceOperation({ action: "refresh_vm_cache", category: "read" });
    const refreshed = await refreshVmCache(roots?.length ? roots : configuredRoots(), maxDepth);
    return text({ count: refreshed.vms.length, expiresAt: new Date(refreshed.expiresAt).toISOString(), roots: JSON.parse(refreshed.rootsKey), vms: refreshed.vms });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("list_vm_cache", {
  title: "List VM Cache",
  description: "Show the current VM discovery cache.",
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async () => {
  try {
    enforceOperation({ action: "list_vm_cache", category: "read" });
    return text({
      count: vmCache.vms.length,
      expiresAt: vmCache.expiresAt ? new Date(vmCache.expiresAt).toISOString() : undefined,
      maxDepth: vmCache.maxDepth,
      roots: vmCache.rootsKey ? JSON.parse(vmCache.rootsKey) : [],
      vms: vmCache.vms
    });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("get_vm_status", {
  title: "Get VM Status",
  description: "Show whether a VM is running and return basic path information.",
  inputSchema: { ...VM_REF },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "get_vm_status", category: "read", vmxPath: resolvedVmxPath });
    const result = await runVmrun(["list"]);
    const runningVms = parseRunningVms(result.stdout);
    return text({ ...vmSummary(resolvedVmxPath, runningVms), runningVms });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("get_vm_details", {
  title: "Get VM Details",
  description: "Return VM alias/path info, VMX metadata, optional snapshots, guest IP, and Tools state.",
  inputSchema: {
    ...VM_REF,
    includeSnapshots: z.boolean().default(true),
    includeGuestIp: z.boolean().default(false),
    includeToolsState: z.boolean().default(false)
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, includeSnapshots, includeGuestIp, includeToolsState }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "get_vm_details", category: "read", vmxPath: resolvedVmxPath });
    return text(await vmDetails(resolvedVmxPath, { includeSnapshots, includeGuestIp, includeToolsState }));
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("read_vmx_config", {
  title: "Read VMX Config",
  description: "Read selected metadata from a VMX file without starting the VM.",
  inputSchema: {
    ...VM_REF,
    includeAll: z.boolean().default(false).describe("Return all parsed VMX keys. Defaults to a concise summary.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, includeAll }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "read_vmx_config", category: "read", vmxPath: resolvedVmxPath });
    const { hostPath, config } = await readVmxConfig(resolvedVmxPath);
    const summary = {
      displayName: config.displayName,
      guestOS: config.guestOS,
      memsize: config.memsize,
      numvcpus: config.numvcpus,
      firmware: config.firmware,
      ethernet0ConnectionType: config["ethernet0.connectionType"],
      hostPath,
      vmrunPath: pathForVmrun(hostPath)
    };
    return text(includeAll ? { summary, config } : summary);
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("edit_vmx_config", {
  title: "Edit VMX Config",
  description: "Edit common VMX settings. The VM should be powered off before changing hardware settings.",
  inputSchema: {
    ...VM_REF,
    displayName: z.string().min(1).optional(),
    memoryMb: z.number().int().min(4).optional(),
    numVcpus: z.number().int().min(1).optional(),
    guestOS: z.string().min(1).optional(),
    ethernet0ConnectionType: z.string().min(1).optional(),
    extra: z.record(z.string(), z.string()).optional().describe("Additional raw VMX key/value updates."),
    dryRun: z.boolean().default(true),
    ...CONFIRM
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, displayName, memoryMb, numVcpus, guestOS, ethernet0ConnectionType, extra, dryRun, confirm }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    if (!dryRun) {
      requireConfirmation(confirm, "edit_vmx_config");
    }
    enforceOperation({ action: "edit_vmx_config", category: "vmx_edit", mutates: !dryRun, vmxPath: resolvedVmxPath });
    const updates = { ...(extra ?? {}) };
    if (displayName !== undefined) updates.displayName = displayName;
    if (memoryMb !== undefined) updates.memsize = String(memoryMb);
    if (numVcpus !== undefined) updates.numvcpus = String(numVcpus);
    if (guestOS !== undefined) updates.guestOS = guestOS;
    if (ethernet0ConnectionType !== undefined) updates["ethernet0.connectionType"] = ethernet0ConnectionType;
    if (Object.keys(updates).length === 0) {
      throw new Error("No VMX updates were provided.");
    }
    const { hostPath, raw } = await readVmxConfig(resolvedVmxPath);
    const updated = updateVmxText(raw, updates);
    if (!dryRun) {
      await writeFile(hostPath, updated, "utf8");
    }
    return text({ ok: true, dryRun, hostPath, updates });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("list_running_vms", {
  title: "List Running VMs",
  description: "List currently running VMware VMs.",
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async () => {
  try {
    enforceOperation({ action: "list_running_vms", category: "read" });
    const result = await runVmrun(["list"]);
    const vms = parseRunningVms(result.stdout);
    return text({ count: vms.length, vms, raw: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("start_vm", {
  title: "Start VM",
  description: "Start a VMware VM.",
  inputSchema: {
    ...VM_REF,
    mode: z.enum(["gui", "nogui"]).default("gui")
  },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, vmName, mode }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "start_vm", category: "power", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun(["start", pathForVmrun(resolvedVmxPath), mode]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("start_vm_and_wait", {
  title: "Start VM And Wait",
  description: "Start a VM, then wait for VMware Tools, guest IP, and optionally a TCP port.",
  inputSchema: {
    ...VM_REF,
    mode: z.enum(["gui", "nogui"]).default("gui"),
    waitForTools: z.boolean().default(true),
    waitForIp: z.boolean().default(true),
    port: z.number().int().min(1).max(65535).optional(),
    timeoutMs: z.number().int().min(1000).max(900000).default(180000),
    intervalMs: z.number().int().min(500).max(60000).default(3000)
  },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, vmName, mode, waitForTools, waitForIp, port, timeoutMs, intervalMs }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "start_vm_and_wait", category: "power", mutates: true, vmxPath: resolvedVmxPath });
    await runVmrun(["start", pathForVmrun(resolvedVmxPath), mode]);
    const waitResult = await waitForVmReadiness(resolvedVmxPath, { waitForTools, waitForIp, port, timeoutMs, intervalMs });
    return text({ ok: true, vmxPath: resolvedVmxPath, ...waitResult });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("wait_for_guest_ready", {
  title: "Wait For Guest Ready",
  description: "Wait for an already-started VM to report VMware Tools, guest IP, and optionally a TCP port.",
  inputSchema: {
    ...VM_REF,
    waitForTools: z.boolean().default(true),
    waitForIp: z.boolean().default(true),
    port: z.number().int().min(1).max(65535).optional(),
    timeoutMs: z.number().int().min(1000).max(900000).default(180000),
    intervalMs: z.number().int().min(500).max(60000).default(3000)
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, waitForTools, waitForIp, port, timeoutMs, intervalMs }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "wait_for_guest_ready", category: "read", vmxPath: resolvedVmxPath });
    const waitResult = await waitForVmReadiness(resolvedVmxPath, { waitForTools, waitForIp, port, timeoutMs, intervalMs });
    return text({ ok: true, vmxPath: resolvedVmxPath, ...waitResult });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("stop_vm", {
  title: "Stop VM",
  description: "Stop a VMware VM.",
  inputSchema: {
    ...VM_REF,
    mode: SOFT_HARD.default("soft"),
    ...CONFIRM
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, mode, confirm }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    if (mode === "hard") {
      requireConfirmation(confirm, "stop_vm");
    }
    enforceOperation({ action: "stop_vm", category: "power", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun(["stop", pathForVmrun(resolvedVmxPath), mode]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("suspend_vm", {
  title: "Suspend VM",
  description: "Suspend a VMware VM.",
  inputSchema: {
    ...VM_REF,
    mode: SOFT_HARD.default("soft")
  },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, vmName, mode }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "suspend_vm", category: "power", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun(["suspend", pathForVmrun(resolvedVmxPath), mode]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("reset_vm", {
  title: "Reset VM",
  description: "Reset a VMware VM.",
  inputSchema: {
    ...VM_REF,
    mode: SOFT_HARD.default("soft"),
    ...CONFIRM
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, mode, confirm }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    requireConfirmation(confirm, "reset_vm");
    enforceOperation({ action: "reset_vm", category: "power", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun(["reset", pathForVmrun(resolvedVmxPath), mode]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("pause_vm", {
  title: "Pause VM",
  description: "Pause a running VMware VM.",
  inputSchema: { ...VM_REF },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, vmName }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "pause_vm", category: "power", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun(["pause", pathForVmrun(resolvedVmxPath)]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("unpause_vm", {
  title: "Unpause VM",
  description: "Unpause a VMware VM.",
  inputSchema: { ...VM_REF },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, vmName }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "unpause_vm", category: "power", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun(["unpause", pathForVmrun(resolvedVmxPath)]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("list_snapshots", {
  title: "List Snapshots",
  description: "List snapshots for a VMware VM.",
  inputSchema: {
    ...VM_REF,
    showTree: z.boolean().default(false)
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, showTree }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "list_snapshots", category: "read", vmxPath: resolvedVmxPath });
    const args = ["listSnapshots", pathForVmrun(resolvedVmxPath)];
    if (showTree) {
      args.push("showTree");
    }
    const result = await runVmrun(args);
    return text({ snapshots: parseSnapshots(result.stdout), raw: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("create_snapshot", {
  title: "Create Snapshot",
  description: "Create a snapshot for a VMware VM.",
  inputSchema: {
    ...VM_REF,
    name: z.string().min(1).describe("Snapshot name.")
  },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, vmName, name }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "create_snapshot", category: "snapshot", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun(["snapshot", pathForVmrun(resolvedVmxPath), name]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("revert_to_snapshot", {
  title: "Revert To Snapshot",
  description: "Revert a VMware VM to a snapshot.",
  inputSchema: {
    ...VM_REF,
    name: z.string().min(1).describe("Snapshot name."),
    ...CONFIRM
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, name, confirm }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    requireConfirmation(confirm, "revert_to_snapshot");
    enforceOperation({ action: "revert_to_snapshot", category: "snapshot", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun(["revertToSnapshot", pathForVmrun(resolvedVmxPath), name]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("delete_snapshot", {
  title: "Delete Snapshot",
  description: "Delete a VMware VM snapshot.",
  inputSchema: {
    ...VM_REF,
    name: z.string().min(1).describe("Snapshot name."),
    ...CONFIRM
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, name, confirm }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    requireConfirmation(confirm, "delete_snapshot");
    enforceOperation({ action: "delete_snapshot", category: "snapshot", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun(["deleteSnapshot", pathForVmrun(resolvedVmxPath), name]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("get_guest_ip_address", {
  title: "Get Guest IP Address",
  description: "Get the guest OS IP address through VMware Tools.",
  inputSchema: {
    ...VM_REF,
    wait: z.boolean().default(false).describe("Wait for an IP address if VMware Tools supports it.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, wait }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "get_guest_ip_address", category: "read", vmxPath: resolvedVmxPath });
    const args = ["getGuestIPAddress", pathForVmrun(resolvedVmxPath)];
    if (wait) {
      args.push("-wait");
    }
    const result = await runVmrun(args);
    return text({ ipAddress: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("check_guest_port", {
  title: "Check Guest Port",
  description: "Check whether a TCP port is reachable on the guest. Uses guest IP lookup unless host is provided.",
  inputSchema: {
    ...VM_REF,
    host: z.string().min(1).optional().describe("Host/IP to check. If omitted, getGuestIPAddress is used."),
    port: z.number().int().min(1).max(65535),
    timeoutMs: z.number().int().min(100).max(60000).default(5000)
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, host, port, timeoutMs }) => {
  try {
    const resolvedVmxPath = host ? undefined : await resolveVmReference({ vmxPath, vmName });
    if (resolvedVmxPath) {
      enforceOperation({ action: "check_guest_port", category: "read", vmxPath: resolvedVmxPath });
    } else {
      enforceOperation({ action: "check_guest_port", category: "read" });
    }
    const targetHost = host ?? (await runVmrun(["getGuestIPAddress", pathForVmrun(resolvedVmxPath)])).stdout;
    const open = await checkPort(targetHost, port, timeoutMs);
    return text({ host: targetHost, port, open });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("check_tools_state", {
  title: "Check Tools State",
  description: "Check the VMware Tools state for a VM.",
  inputSchema: { ...VM_REF },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "check_tools_state", category: "read", vmxPath: resolvedVmxPath });
    const result = await runVmrun(["checkToolsState", pathForVmrun(resolvedVmxPath)]);
    return text({ toolsState: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("enable_shared_folders", {
  title: "Enable Shared Folders",
  description: "Enable VMware shared folders for a VM.",
  inputSchema: {
    ...VM_REF,
    runtime: z.boolean().default(false).describe("Enable only for the current VM runtime session.")
  },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, vmName, runtime }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "enable_shared_folders", category: "shared_folder", mutates: true, vmxPath: resolvedVmxPath });
    const args = ["enableSharedFolders", pathForVmrun(resolvedVmxPath)];
    if (runtime) {
      args.push("runtime");
    }
    const result = await runVmrun(args);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("disable_shared_folders", {
  title: "Disable Shared Folders",
  description: "Disable VMware shared folders for a VM.",
  inputSchema: {
    ...VM_REF,
    runtime: z.boolean().default(false).describe("Disable only for the current VM runtime session."),
    ...CONFIRM
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, runtime, confirm }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    requireConfirmation(confirm, "disable_shared_folders");
    enforceOperation({ action: "disable_shared_folders", category: "shared_folder", mutates: true, vmxPath: resolvedVmxPath });
    const args = ["disableSharedFolders", pathForVmrun(resolvedVmxPath)];
    if (runtime) {
      args.push("runtime");
    }
    const result = await runVmrun(args);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("add_shared_folder", {
  title: "Add Shared Folder",
  description: "Add a host-guest shared folder to a VM.",
  inputSchema: {
    ...VM_REF,
    shareName: z.string().min(1).describe("Shared folder name visible to the guest."),
    hostPath: z.string().min(1).describe("Host directory path. WSL /mnt/c paths are accepted.")
  },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, vmName, shareName, hostPath }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "add_shared_folder", category: "shared_folder", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun(["addSharedFolder", pathForVmrun(resolvedVmxPath), shareName, pathForVmrun(hostPath)]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("remove_shared_folder", {
  title: "Remove Shared Folder",
  description: "Remove a host-guest shared folder from a VM.",
  inputSchema: {
    ...VM_REF,
    shareName: z.string().min(1).describe("Shared folder name."),
    ...CONFIRM
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, shareName, confirm }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    requireConfirmation(confirm, "remove_shared_folder");
    enforceOperation({ action: "remove_shared_folder", category: "shared_folder", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun(["removeSharedFolder", pathForVmrun(resolvedVmxPath), shareName]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("guest_run_program", {
  title: "Run Program In Guest",
  description: "Run a program inside the guest OS through VMware Tools.",
  inputSchema: {
    ...VM_REF,
    ...GUEST_CREDENTIALS,
    programPath: z.string().min(1).describe("Program path inside the guest OS."),
    arguments: z.array(z.string()).default([]).describe("Arguments passed to the guest program."),
    noWait: z.boolean().default(false).describe("Return before the guest process exits."),
    activeWindow: z.boolean().default(false).describe("Run with an active window where supported."),
    interactive: z.boolean().default(false).describe("Run interactively where supported."),
    timeoutMs: z.number().int().min(1000).max(900000).optional()
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, guestUser, guestPassword, programPath, arguments: programArgs, noWait, activeWindow, interactive, timeoutMs }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "guest_run_program", category: "guest", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runGuestProgram({ vmxPath: resolvedVmxPath, guestUser, guestPassword, programPath, programArgs, noWait, activeWindow, interactive, timeoutMs });
    return text({ ok: true, stdout: result.stdout, stderr: result.stderr });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("run_guest_program_with_snapshot", {
  title: "Run Guest Program With Snapshot",
  description: "Create a snapshot, run a guest program, then optionally delete or revert the snapshot.",
  inputSchema: {
    ...VM_REF,
    ...GUEST_CREDENTIALS,
    snapshotName: z.string().min(1).optional(),
    programPath: z.string().min(1),
    arguments: z.array(z.string()).default([]),
    revertOnFailure: z.boolean().default(true),
    deleteSnapshotOnSuccess: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(900000).optional(),
    ...CONFIRM
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, guestUser, guestPassword, snapshotName, programPath, arguments: programArgs, revertOnFailure, deleteSnapshotOnSuccess, timeoutMs, confirm }) => {
  const name = snapshotName ?? `mcp-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    requireConfirmation(confirm, "run_guest_program_with_snapshot");
    enforceOperation({ action: "run_guest_program_with_snapshot", category: "guest", mutates: true, vmxPath: resolvedVmxPath });
    await runVmrun(["snapshot", pathForVmrun(resolvedVmxPath), name]);
    try {
      const runResult = await runGuestProgram({
        vmxPath: resolvedVmxPath,
        guestUser,
        guestPassword,
        programPath,
        programArgs,
        timeoutMs
      });
      if (deleteSnapshotOnSuccess) {
        await runVmrun(["deleteSnapshot", pathForVmrun(resolvedVmxPath), name]);
      }
      return text({ ok: true, snapshotName: name, deletedSnapshot: deleteSnapshotOnSuccess, stdout: runResult.stdout, stderr: runResult.stderr });
    } catch (error) {
      if (revertOnFailure) {
        await runVmrun(["revertToSnapshot", pathForVmrun(resolvedVmxPath), name]);
      }
      throw error;
    }
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("guest_list_processes", {
  title: "List Guest Processes",
  description: "List processes inside the guest OS through VMware Tools.",
  inputSchema: {
    ...VM_REF,
    ...GUEST_CREDENTIALS
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, guestUser, guestPassword }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "guest_list_processes", category: "guest_read", vmxPath: resolvedVmxPath });
    const result = await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "listProcessesInGuest",
      pathForVmrun(resolvedVmxPath)
    ]);
    return text({ raw: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("capture_screen", {
  title: "Capture Screen",
  description: "Capture the VM screen to a host image file.",
  inputSchema: {
    ...VM_REF,
    hostPath: z.string().min(1).describe("Destination image path on the host. WSL /mnt/c paths are accepted.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, hostPath }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "capture_screen", category: "read", vmxPath: resolvedVmxPath });
    const result = await runVmrun(["captureScreen", pathForVmrun(resolvedVmxPath), pathForVmrun(hostPath)]);
    return text({ ok: true, hostPath, vmrunHostPath: pathForVmrun(hostPath), stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("guest_list_directory", {
  title: "List Guest Directory",
  description: "List a directory inside the guest OS through VMware Tools.",
  inputSchema: {
    ...VM_REF,
    ...GUEST_CREDENTIALS,
    guestPath: z.string().min(1).describe("Directory path inside the guest OS.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, guestUser, guestPassword, guestPath }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "guest_list_directory", category: "guest_read", vmxPath: resolvedVmxPath });
    const result = await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "listDirectoryInGuest",
      pathForVmrun(resolvedVmxPath),
      guestPath
    ]);
    return text({ entries: parseGuestDirectory(result.stdout), raw: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("guest_file_exists", {
  title: "Guest File Exists",
  description: "Check whether a file exists inside the guest OS through VMware Tools.",
  inputSchema: {
    ...VM_REF,
    ...GUEST_CREDENTIALS,
    guestPath: z.string().min(1).describe("File path inside the guest OS.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, guestUser, guestPassword, guestPath }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "guest_file_exists", category: "guest_read", vmxPath: resolvedVmxPath });
    await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "fileExistsInGuest",
      pathForVmrun(resolvedVmxPath),
      guestPath
    ]);
    return text({ exists: true, guestPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/does not exist|not found|Unable to check/i.test(message)) {
      return text({ exists: false, guestPath, message });
    }
    return toolError(error);
  }
});

server.registerTool("guest_directory_exists", {
  title: "Guest Directory Exists",
  description: "Check whether a directory exists inside the guest OS through VMware Tools.",
  inputSchema: {
    ...VM_REF,
    ...GUEST_CREDENTIALS,
    guestPath: z.string().min(1).describe("Directory path inside the guest OS.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, guestUser, guestPassword, guestPath }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "guest_directory_exists", category: "guest_read", vmxPath: resolvedVmxPath });
    await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "directoryExistsInGuest",
      pathForVmrun(resolvedVmxPath),
      guestPath
    ]);
    return text({ exists: true, guestPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/does not exist|not found|Unable to check/i.test(message)) {
      return text({ exists: false, guestPath, message });
    }
    return toolError(error);
  }
});

server.registerTool("copy_file_from_guest", {
  title: "Copy File From Guest",
  description: "Copy a file from the guest OS to the host through VMware Tools.",
  inputSchema: {
    ...VM_REF,
    ...GUEST_CREDENTIALS,
    guestPath: z.string().min(1).describe("Source file path inside the guest OS."),
    hostPath: z.string().min(1).describe("Destination path on the host. WSL /mnt/c paths are accepted.")
  },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, vmName, guestUser, guestPassword, guestPath, hostPath }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "copy_file_from_guest", category: "file_transfer", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "copyFileFromGuestToHost",
      pathForVmrun(resolvedVmxPath),
      guestPath,
      pathForVmrun(hostPath)
    ]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("copy_file_to_guest", {
  title: "Copy File To Guest",
  description: "Copy a file from the host to the guest OS through VMware Tools.",
  inputSchema: {
    ...VM_REF,
    ...GUEST_CREDENTIALS,
    hostPath: z.string().min(1).describe("Source path on the host. WSL /mnt/c paths are accepted."),
    guestPath: z.string().min(1).describe("Destination file path inside the guest OS.")
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, vmName, guestUser, guestPassword, hostPath, guestPath }) => {
  try {
    const resolvedVmxPath = await resolveVmReference({ vmxPath, vmName });
    enforceOperation({ action: "copy_file_to_guest", category: "file_transfer", mutates: true, vmxPath: resolvedVmxPath });
    const result = await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "copyFileFromHostToGuest",
      pathForVmrun(resolvedVmxPath),
      pathForVmrun(hostPath),
      guestPath
    ]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("vmrun", {
  title: "Run vmrun",
  description: "Run explicit vmrun arguments. Advanced escape hatch for commands not covered by dedicated tools.",
  inputSchema: {
    args: z.array(z.string()).min(1).describe("Arguments passed to vmrun, excluding the vmrun executable itself."),
    timeoutMs: z.number().int().min(1000).max(900000).optional(),
    ...CONFIRM
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ args, timeoutMs, confirm }) => {
  try {
    requireConfirmation(confirm, "vmrun");
    enforceOperation({ action: "vmrun", category: "raw", mutates: true });
    const converted = args.map(arg => arg.toLowerCase().endsWith(".vmx") ? pathForVmrun(arg) : arg);
    const result = await runVmrun(converted, { timeoutMs });
    return text({ ok: true, stdout: result.stdout, stderr: result.stderr, command: result.command });
  } catch (error) {
    return toolError(error);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
