import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  windowsPathToWsl,
  wslPathToWindows,
  parseVmx,
  updateVmxText,
  parseRunningVms,
  parseSnapshots,
  redactVmrunArgs,
  requireConfirmation,
  normalizePathForCompare,
  pathsEqual,
  pathIsInsideRoot,
  coerceTimeoutMs
} from "./utils.js";

describe("windowsPathToWsl", () => {
  it("converts C:\\ path", () => {
    assert.equal(windowsPathToWsl("C:\\Users\\foo\\bar.vmx"), "/mnt/c/Users/foo/bar.vmx");
  });
  it("converts lowercase drive letter", () => {
    assert.equal(windowsPathToWsl("d:\\VMs\\test.vmx"), "/mnt/d/VMs/test.vmx");
  });
  it("converts forward-slash Windows paths", () => {
    assert.equal(windowsPathToWsl("C:/Program Files/VMware/vm.vmx"), "/mnt/c/Program Files/VMware/vm.vmx");
  });
  it("returns non-Windows paths unchanged", () => {
    assert.equal(windowsPathToWsl("/mnt/c/foo"), "/mnt/c/foo");
    assert.equal(windowsPathToWsl("relative/path"), "relative/path");
  });
});

describe("wslPathToWindows", () => {
  it("converts /mnt/c/ path", () => {
    assert.equal(wslPathToWindows("/mnt/c/Users/foo/bar.vmx"), "C:\\Users\\foo\\bar.vmx");
  });
  it("converts /mnt/d/ path", () => {
    assert.equal(wslPathToWindows("/mnt/d/VMs/test.vmx"), "D:\\VMs\\test.vmx");
  });
  it("returns non-WSL paths unchanged", () => {
    assert.equal(wslPathToWindows("C:\\already\\windows"), "C:\\already\\windows");
    assert.equal(wslPathToWindows("/home/user/file"), "/home/user/file");
  });
  it("roundtrips with windowsPathToWsl", () => {
    const original = "C:\\Users\\test\\vm.vmx";
    assert.equal(wslPathToWindows(windowsPathToWsl(original)), original);
  });
});

describe("parseVmx", () => {
  it("parses key=value pairs", () => {
    const result = parseVmx('.encoding = "UTF-8"\ndisplayName = "My VM"');
    assert.equal(result[".encoding"], "UTF-8");
    assert.equal(result.displayName, "My VM");
  });
  it("skips comment lines", () => {
    const result = parseVmx("# this is a comment\ndisplayName = \"VM\"");
    assert.equal(Object.keys(result).length, 1);
  });
  it("skips blank lines", () => {
    const result = parseVmx("\n\ndisplayName = \"VM\"\n\n");
    assert.equal(Object.keys(result).length, 1);
  });
  it("handles escaped quotes in values", () => {
    const result = parseVmx('displayName = "foo \\"bar\\" baz"');
    assert.equal(result.displayName, 'foo "bar" baz');
  });
  it("handles dotted keys", () => {
    const result = parseVmx('ethernet0.connectionType = "nat"');
    assert.equal(result["ethernet0.connectionType"], "nat");
  });
  it("handles CRLF line endings", () => {
    const result = parseVmx("displayName = \"VM\"\r\nmemsize = \"2048\"");
    assert.equal(result.displayName, "VM");
    assert.equal(result.memsize, "2048");
  });
});

describe("updateVmxText", () => {
  const base = 'displayName = "Old"\nmemsize = "1024"\nguestOS = "ubuntu"';

  it("updates an existing key", () => {
    const result = updateVmxText(base, { displayName: "New" });
    assert.ok(result.includes('displayName = "New"'));
    assert.ok(result.includes('memsize = "1024"'));
  });
  it("appends a new key", () => {
    const result = updateVmxText(base, { numvcpus: "4" });
    assert.ok(result.includes('numvcpus = "4"'));
  });
  it("escapes double quotes in values", () => {
    const result = updateVmxText(base, { displayName: 'has "quotes"' });
    assert.ok(result.includes('displayName = "has \\"quotes\\""'));
  });
  it("preserves LF line endings", () => {
    const lf = "a = \"1\"\nb = \"2\"";
    assert.ok(!updateVmxText(lf, { a: "x" }).includes("\r\n"));
  });
  it("preserves CRLF line endings (Bug 3 regression)", () => {
    const crlf = "a = \"1\"\r\nb = \"2\"";
    const result = updateVmxText(crlf, { a: "x" });
    assert.ok(result.includes("\r\n"), "Should preserve CRLF");
  });
  it("updates multiple keys at once", () => {
    const result = updateVmxText(base, { displayName: "X", memsize: "4096" });
    assert.ok(result.includes('displayName = "X"'));
    assert.ok(result.includes('memsize = "4096"'));
  });
  it("appends before a single trailing newline", () => {
    const result = updateVmxText('displayName = "Old"\n', { memsize: "2048" });
    assert.equal(result, 'displayName = "Old"\nmemsize = "2048"\n');
  });
});

describe("parseRunningVms", () => {
  it("parses VM paths from vmrun list output", () => {
    const output = "Total running VMs: 2\nC:\\VMs\\vm1.vmx\nC:\\VMs\\vm2.vmx";
    const result = parseRunningVms(output);
    assert.deepEqual(result, ["C:\\VMs\\vm1.vmx", "C:\\VMs\\vm2.vmx"]);
  });
  it("filters the header line", () => {
    const result = parseRunningVms("Total running VMs: 0\n");
    assert.deepEqual(result, []);
  });
  it("filters blank lines", () => {
    const result = parseRunningVms("\n/path/vm.vmx\n\n");
    assert.deepEqual(result, ["/path/vm.vmx"]);
  });
  it("handles CRLF output", () => {
    const result = parseRunningVms("Total running VMs: 1\r\n/path/vm.vmx\r\n");
    assert.deepEqual(result, ["/path/vm.vmx"]);
  });
});

describe("parseSnapshots", () => {
  it("parses snapshot names", () => {
    const output = "Total snapshots: 2\nclean\npost-install";
    const result = parseSnapshots(output);
    assert.deepEqual(result, ["clean", "post-install"]);
  });
  it("filters the header line", () => {
    const result = parseSnapshots("Total snapshots: 0");
    assert.deepEqual(result, []);
  });
  it("filters blank lines", () => {
    const result = parseSnapshots("\nsnap1\n\nsnap2\n");
    assert.deepEqual(result, ["snap1", "snap2"]);
  });
});

describe("redactVmrunArgs", () => {
  it("redacts the argument following -gp", () => {
    const result = redactVmrunArgs(["-gu", "user", "-gp", "secret", "runProgramInGuest"]);
    assert.deepEqual(result, ["-gu", "user", "-gp", "[redacted]", "runProgramInGuest"]);
  });
  it("does not redact other arguments", () => {
    const args = ["list"];
    assert.deepEqual(redactVmrunArgs(args), ["list"]);
  });
  it("handles -gp at the end (no value following)", () => {
    const result = redactVmrunArgs(["-gp"]);
    assert.deepEqual(result, ["-gp"]);
  });
});

describe("requireConfirmation", () => {
  it("does not throw when tokens match", () => {
    assert.doesNotThrow(() => requireConfirmation("delete_snapshot", "delete_snapshot"));
  });
  it("throws when tokens do not match", () => {
    assert.throws(
      () => requireConfirmation("wrong", "delete_snapshot"),
      /Confirmation required.*delete_snapshot/
    );
  });
  it("throws when confirm is undefined", () => {
    assert.throws(
      () => requireConfirmation(undefined, "reset_vm"),
      /Confirmation required.*reset_vm/
    );
  });
});

describe("path comparison helpers", () => {
  it("normalizes separators, case, and trailing slashes", () => {
    assert.equal(normalizePathForCompare("C:\\VMs\\Demo\\"), "c:/vms/demo");
  });
  it("compares Windows paths case-insensitively", () => {
    assert.equal(pathsEqual("C:\\VMs\\Demo.vmx", "c:/vms/demo.vmx"), true);
  });
  it("checks root containment on path boundaries", () => {
    assert.equal(pathIsInsideRoot("/mnt/d/Virtual Machines/Demo/Demo.vmx", "/mnt/d/Virtual Machines"), true);
    assert.equal(pathIsInsideRoot("/mnt/d/Virtual Machines 2/Demo.vmx", "/mnt/d/Virtual Machines"), false);
  });
});

describe("coerceTimeoutMs", () => {
  it("returns fallback when value is absent", () => {
    assert.equal(coerceTimeoutMs(undefined, 5000), 5000);
  });
  it("accepts numeric strings", () => {
    assert.equal(coerceTimeoutMs("3000"), 3000);
  });
  it("rejects invalid values", () => {
    assert.throws(() => coerceTimeoutMs("NaN"), /timeoutMs/);
    assert.throws(() => coerceTimeoutMs(0), /timeoutMs/);
  });
});
