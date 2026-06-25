#!/usr/bin/env node

import { access, readdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join, sep } from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const isWindows = platform() === "win32";
const isWsl = !isWindows && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

const SOFT_HARD = z.enum(["soft", "hard"]);

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
      await access(path, fsConstants.X_OK);
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

async function runVmrun(args, options = {}) {
  const vmrun = await resolveVmrun();
  const timeoutMs = options.timeoutMs ?? Number(process.env.VMRUN_TIMEOUT_MS ?? 120000);

  return await new Promise((resolve, reject) => {
    const child = spawn(vmrun, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`vmrun timed out after ${timeoutMs} ms: ${args.join(" ")}`));
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
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim(), command: [vmrun, ...args] };
      if (code === 0) {
        resolve(result);
        return;
      }
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n");
      reject(new Error(`vmrun exited with code ${code}: ${args.join(" ")}${detail ? `\n${detail}` : ""}`));
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
    const vmrun = await resolveVmrun();
    return text({
      vmrun,
      isWsl,
      isWindows,
      searchRoots: configuredRoots(),
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
  return text({ roots: scanRoots, count: vms.length, vms });
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
