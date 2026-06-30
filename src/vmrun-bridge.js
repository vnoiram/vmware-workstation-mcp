#!/usr/bin/env node

import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import { platform } from "node:os";
import { spawn } from "node:child_process";
import { coerceTimeoutMs, redactVmrunArgs } from "./utils.js";

const isWindows = platform() === "win32";
const host = process.env.VMRUN_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.VMRUN_BRIDGE_PORT ?? 57931);
const token = process.env.VMRUN_BRIDGE_TOKEN;
const maxBodyBytes = Number(process.env.VMRUN_BRIDGE_MAX_BODY_BYTES ?? 65536);

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
  return [...fromEnv, "vmrun"];
}

async function canExecute(path) {
  if (path.includes("/") || path.includes("\\")) {
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
  throw new Error("vmrun executable was not found. Set VMRUN_PATH.");
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new Error(`Request body is too large. Limit is ${maxBodyBytes} bytes.`);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

async function runVmrun(args, timeoutMs) {
  const vmrun = await resolveVmrun();
  const effectiveTimeoutMs = coerceTimeoutMs(timeoutMs);
  return new Promise((resolve, reject) => {
    const child = spawn(vmrun, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`vmrun timed out after ${effectiveTimeoutMs} ms: ${redactVmrunArgs(args).join(" ")}`));
    }, effectiveTimeoutMs);

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
      const result = {
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        command: [vmrun, ...redactVmrunArgs(args)]
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n");
      reject(new Error(`vmrun exited with code ${code}: ${redactVmrunArgs(args).join(" ")}${detail ? `\n${detail}` : ""}`));
    });
  });
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || request.url !== "/") {
      writeJson(response, 404, { ok: false, error: "Not found." });
      return;
    }
    if (token && request.headers.authorization !== `Bearer ${token}`) {
      writeJson(response, 401, { ok: false, error: "Unauthorized." });
      return;
    }

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!Array.isArray(body.args) || !body.args.every(arg => typeof arg === "string")) {
      writeJson(response, 400, { ok: false, error: "Expected JSON body with string array field: args." });
      return;
    }
    let timeoutMs;
    try {
      timeoutMs = coerceTimeoutMs(body.timeoutMs ?? process.env.VMRUN_TIMEOUT_MS);
    } catch (error) {
      writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const result = await runVmrun(body.args, timeoutMs);
    writeJson(response, 200, { ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(response, 500, { ok: false, error: message });
  }
});

server.on("error", error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.error(`vmrun bridge listening on http://${host}:${port}/`);
});
