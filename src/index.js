#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, delimiter, dirname, join, sep } from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const isWindows = platform() === "win32";
const isWsl = !isWindows && detectWsl();

const SOFT_HARD = z.enum(["soft", "hard"]);
const GUEST_CREDENTIALS = {
  guestUser: z.string().min(1).describe("Guest OS username."),
  guestPassword: z.string().min(1).describe("Guest OS password.")
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

function text(content) {
  return { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content, null, 2) }] };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

function windowsPathToWsl(path) {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
  if (!match) {
    return path;
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function wslPathToWindows(path) {
  const match = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(path);
  if (!match) {
    return path;
  }
  return `${match[1].toUpperCase()}:\\${match[2].replaceAll("/", "\\")}`;
}

function pathForVmrun(path) {
  return isWsl ? wslPathToWindows(path) : path;
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
  const vmrunType = process.env.VMRUN_TYPE ?? "ws";
  return vmrunType ? ["-T", vmrunType, ...args] : args;
}

function powershellPath() {
  return process.env.POWERSHELL_PATH ?? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
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

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function redactVmrunArgs(args) {
  return args.map((arg, index) => args[index - 1] === "-gp" ? "[redacted]" : arg);
}

function bridgeUrl() {
  return process.env.VMRUN_BRIDGE_URL;
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
      ...(process.env.VMRUN_BRIDGE_TOKEN ? { authorization: `Bearer ${process.env.VMRUN_BRIDGE_TOKEN}` } : {})
    },
    body: JSON.stringify({
      args,
      timeoutMs: options.timeoutMs ?? Number(process.env.VMRUN_TIMEOUT_MS ?? 120000)
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
  const shellCommand = [powershellPath(), ...powershellArgs].map(quoteShell).join(" ");
  return {
    command: "/bin/sh",
    args: ["-lc", shellCommand],
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
  const timeoutMs = options.timeoutMs ?? Number(process.env.VMRUN_TIMEOUT_MS ?? 120000);

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

function parseRunningVms(output) {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.toLowerCase().startsWith("total running vms:"));
}

function parseSnapshots(output) {
  return output
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .filter(line => !line.toLowerCase().startsWith("total snapshots:"));
}

function parseVmx(text) {
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

function vmSummary(vmxPath, runningVms = []) {
  const hostPath = isWsl ? windowsPathToWsl(vmxPath) : vmxPath;
  return {
    name: basename(hostPath, ".vmx"),
    hostPath,
    vmrunPath: pathForVmrun(hostPath),
    directory: dirname(hostPath),
    running: runningVms.includes(pathForVmrun(hostPath)) || runningVms.includes(hostPath)
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

function configuredRoots() {
  if (process.env.VMWARE_VMX_ROOTS) {
    return process.env.VMWARE_VMX_ROOTS.split(delimiter).filter(Boolean);
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

async function safeListRunningVms() {
  try {
    const result = await runVmrun(["list"]);
    return parseRunningVms(result.stdout);
  } catch {
    return [];
  }
}

function vmxSchema(description = "Path to a .vmx file. WSL /mnt/c paths are accepted.") {
  return z.string().min(1).describe(description);
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
      vmrunType: process.env.VMRUN_TYPE ?? "ws",
      vmrunUsePowershell: vmrun ? usePowershellBridge(vmrun) : false,
      powershellPath: vmrun && usePowershellBridge(vmrun) ? powershellPath() : undefined,
      vmrunTimeoutMs: Number(process.env.VMRUN_TIMEOUT_MS ?? 120000)
    });
  } catch (error) {
    return toolError(error);
  }
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
  const scanRoots = roots?.length ? roots : configuredRoots();
  const vms = await discoverVms(scanRoots, maxDepth);
  const runningVms = await safeListRunningVms();
  return text({ roots: scanRoots, count: vms.length, vms: vms.map(vmxPath => vmSummary(vmxPath, runningVms)) });
});

server.registerTool("get_vm_status", {
  title: "Get VM Status",
  description: "Show whether a VM is running and return basic path information.",
  inputSchema: { vmxPath: vmxSchema() },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath }) => {
  try {
    const result = await runVmrun(["list"]);
    const runningVms = parseRunningVms(result.stdout);
    return text({ ...vmSummary(vmxPath, runningVms), runningVms });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("read_vmx_config", {
  title: "Read VMX Config",
  description: "Read selected metadata from a VMX file without starting the VM.",
  inputSchema: {
    vmxPath: vmxSchema(),
    includeAll: z.boolean().default(false).describe("Return all parsed VMX keys. Defaults to a concise summary.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, includeAll }) => {
  try {
    const hostPath = isWsl ? windowsPathToWsl(vmxPath) : vmxPath;
    const raw = await readFile(hostPath, "utf8");
    const config = parseVmx(raw);
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

server.registerTool("list_running_vms", {
  title: "List Running VMs",
  description: "List currently running VMware VMs.",
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async () => {
  try {
    const result = await runVmrun(["list"]);
    return text({ count: parseRunningVms(result.stdout).length, vms: parseRunningVms(result.stdout), raw: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("start_vm", {
  title: "Start VM",
  description: "Start a VMware VM.",
  inputSchema: {
    vmxPath: vmxSchema(),
    mode: z.enum(["gui", "nogui"]).default("gui")
  },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, mode }) => {
  try {
    const result = await runVmrun(["start", pathForVmrun(vmxPath), mode]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("stop_vm", {
  title: "Stop VM",
  description: "Stop a VMware VM.",
  inputSchema: {
    vmxPath: vmxSchema(),
    mode: SOFT_HARD.default("soft")
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, mode }) => {
  try {
    const result = await runVmrun(["stop", pathForVmrun(vmxPath), mode]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("suspend_vm", {
  title: "Suspend VM",
  description: "Suspend a VMware VM.",
  inputSchema: {
    vmxPath: vmxSchema(),
    mode: SOFT_HARD.default("soft")
  },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, mode }) => {
  try {
    const result = await runVmrun(["suspend", pathForVmrun(vmxPath), mode]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("reset_vm", {
  title: "Reset VM",
  description: "Reset a VMware VM.",
  inputSchema: {
    vmxPath: vmxSchema(),
    mode: SOFT_HARD.default("soft")
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, mode }) => {
  try {
    const result = await runVmrun(["reset", pathForVmrun(vmxPath), mode]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("pause_vm", {
  title: "Pause VM",
  description: "Pause a running VMware VM.",
  inputSchema: { vmxPath: vmxSchema() },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath }) => {
  try {
    const result = await runVmrun(["pause", pathForVmrun(vmxPath)]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("unpause_vm", {
  title: "Unpause VM",
  description: "Unpause a VMware VM.",
  inputSchema: { vmxPath: vmxSchema() },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath }) => {
  try {
    const result = await runVmrun(["unpause", pathForVmrun(vmxPath)]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("list_snapshots", {
  title: "List Snapshots",
  description: "List snapshots for a VMware VM.",
  inputSchema: {
    vmxPath: vmxSchema(),
    showTree: z.boolean().default(false)
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, showTree }) => {
  try {
    const args = ["listSnapshots", pathForVmrun(vmxPath)];
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
    vmxPath: vmxSchema(),
    name: z.string().min(1).describe("Snapshot name.")
  },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, name }) => {
  try {
    const result = await runVmrun(["snapshot", pathForVmrun(vmxPath), name]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("revert_to_snapshot", {
  title: "Revert To Snapshot",
  description: "Revert a VMware VM to a snapshot.",
  inputSchema: {
    vmxPath: vmxSchema(),
    name: z.string().min(1).describe("Snapshot name.")
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, name }) => {
  try {
    const result = await runVmrun(["revertToSnapshot", pathForVmrun(vmxPath), name]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("delete_snapshot", {
  title: "Delete Snapshot",
  description: "Delete a VMware VM snapshot.",
  inputSchema: {
    vmxPath: vmxSchema(),
    name: z.string().min(1).describe("Snapshot name.")
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, name }) => {
  try {
    const result = await runVmrun(["deleteSnapshot", pathForVmrun(vmxPath), name]);
    return text({ ok: true, stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("guest_run_program", {
  title: "Run Program In Guest",
  description: "Run a program inside the guest OS through VMware Tools.",
  inputSchema: {
    vmxPath: vmxSchema(),
    ...GUEST_CREDENTIALS,
    programPath: z.string().min(1).describe("Program path inside the guest OS."),
    arguments: z.array(z.string()).default([]).describe("Arguments passed to the guest program."),
    noWait: z.boolean().default(false).describe("Return before the guest process exits."),
    activeWindow: z.boolean().default(false).describe("Run with an active window where supported."),
    interactive: z.boolean().default(false).describe("Run interactively where supported."),
    timeoutMs: z.number().int().min(1000).max(900000).optional()
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, guestUser, guestPassword, programPath, arguments: programArgs, noWait, activeWindow, interactive, timeoutMs }) => {
  try {
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
    const result = await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "runProgramInGuest",
      pathForVmrun(vmxPath),
      ...flags,
      programPath,
      ...programArgs
    ], { timeoutMs });
    return text({ ok: true, stdout: result.stdout, stderr: result.stderr });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("guest_list_processes", {
  title: "List Guest Processes",
  description: "List processes inside the guest OS through VMware Tools.",
  inputSchema: {
    vmxPath: vmxSchema(),
    ...GUEST_CREDENTIALS
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, guestUser, guestPassword }) => {
  try {
    const result = await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "listProcessesInGuest",
      pathForVmrun(vmxPath)
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
    vmxPath: vmxSchema(),
    hostPath: z.string().min(1).describe("Destination image path on the host. WSL /mnt/c paths are accepted.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, hostPath }) => {
  try {
    const result = await runVmrun(["captureScreen", pathForVmrun(vmxPath), pathForVmrun(hostPath)]);
    return text({ ok: true, hostPath, vmrunHostPath: pathForVmrun(hostPath), stdout: result.stdout });
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("guest_list_directory", {
  title: "List Guest Directory",
  description: "List a directory inside the guest OS through VMware Tools.",
  inputSchema: {
    vmxPath: vmxSchema(),
    ...GUEST_CREDENTIALS,
    guestPath: z.string().min(1).describe("Directory path inside the guest OS.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, guestUser, guestPassword, guestPath }) => {
  try {
    const result = await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "listDirectoryInGuest",
      pathForVmrun(vmxPath),
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
    vmxPath: vmxSchema(),
    ...GUEST_CREDENTIALS,
    guestPath: z.string().min(1).describe("File path inside the guest OS.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, guestUser, guestPassword, guestPath }) => {
  try {
    await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "fileExistsInGuest",
      pathForVmrun(vmxPath),
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
    vmxPath: vmxSchema(),
    ...GUEST_CREDENTIALS,
    guestPath: z.string().min(1).describe("Directory path inside the guest OS.")
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}, async ({ vmxPath, guestUser, guestPassword, guestPath }) => {
  try {
    await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "directoryExistsInGuest",
      pathForVmrun(vmxPath),
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
    vmxPath: vmxSchema(),
    ...GUEST_CREDENTIALS,
    guestPath: z.string().min(1).describe("Source file path inside the guest OS."),
    hostPath: z.string().min(1).describe("Destination path on the host. WSL /mnt/c paths are accepted.")
  },
  annotations: { destructiveHint: false, openWorldHint: false }
}, async ({ vmxPath, guestUser, guestPassword, guestPath, hostPath }) => {
  try {
    const result = await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "copyFileFromGuestToHost",
      pathForVmrun(vmxPath),
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
    vmxPath: vmxSchema(),
    ...GUEST_CREDENTIALS,
    hostPath: z.string().min(1).describe("Source path on the host. WSL /mnt/c paths are accepted."),
    guestPath: z.string().min(1).describe("Destination file path inside the guest OS.")
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ vmxPath, guestUser, guestPassword, hostPath, guestPath }) => {
  try {
    const result = await runVmrun([
      ...guestAuthArgs({ guestUser, guestPassword }),
      "copyFileFromHostToGuest",
      pathForVmrun(vmxPath),
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
    timeoutMs: z.number().int().min(1000).max(900000).optional()
  },
  annotations: { destructiveHint: true, openWorldHint: false }
}, async ({ args, timeoutMs }) => {
  try {
    const converted = args.map(arg => arg.toLowerCase().endsWith(".vmx") ? pathForVmrun(arg) : arg);
    const result = await runVmrun(converted, { timeoutMs });
    return text({ ok: true, stdout: result.stdout, stderr: result.stderr, command: result.command });
  } catch (error) {
    return toolError(error);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
