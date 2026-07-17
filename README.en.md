# VMware Workstation MCP

A stdio MCP server for controlling VMware Workstation through `vmrun`.

This repository can live and run under WSL. VMware Workstation runs on the Windows host, and the server launches `vmrun.exe` from WSL. It can also run directly with Windows-side Node.js.

## Setup

```bash
npm install
```

If `vmrun.exe` is installed in the standard VMware Workstation location, it is detected automatically. If not, set `VMRUN_PATH`.
The `vmrun` product type defaults to VMware Workstation's `ws`. Set `VMRUN_TYPE` to change it.
When using `vmrun.exe` from WSL, commands are executed through Windows PowerShell by default. Set `VMRUN_USE_POWERSHELL=0` to execute it directly.
If your WSL-side Node.js cannot directly launch Windows executables, start the `vmrun` bridge on Windows and connect to it from the WSL MCP server with `VMRUN_BRIDGE_URL`.

Example from WSL:

```bash
export VMRUN_PATH="/mnt/c/Program Files (x86)/VMware/VMware Workstation/vmrun.exe"
npm start
```

Example from Windows:

```powershell
$env:VMRUN_PATH = "C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe"
npm start
```

Run only the bridge on Windows and the MCP server on WSL:

```powershell
$env:VMRUN_BRIDGE_TOKEN = "change-me"
$env:VMRUN_PATH = "C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe"
npm run bridge
```

```bash
export VMRUN_BRIDGE_URL="http://127.0.0.1:57931/"
export VMRUN_BRIDGE_TOKEN="change-me"
npm start
```

`VMRUN_BRIDGE_HOST` and `VMRUN_BRIDGE_PORT` change the bridge listen address. The default is `127.0.0.1:57931`.
`VMRUN_BRIDGE_MAX_BODY_BYTES` changes the maximum accepted JSON request size. The default is `65536` bytes.

Register the bridge to start at Windows logon with Task Scheduler:

```powershell
.\tools\register-vmrun-bridge-task.ps1 -Token "change-me"
```

## MCP Client Configuration Example

When starting with WSL-side Node.js:

```json
{
  "mcpServers": {
    "vmware-workstation": {
      "command": "node",
      "args": ["/path/to/vmware-workstation-mcp/src/index.js"],
      "env": {
        "VMRUN_PATH": "/mnt/c/Program Files (x86)/VMware/VMware Workstation/vmrun.exe"
      }
    }
  }
}
```

When using the Windows bridge from WSL:

```json
{
  "mcpServers": {
    "vmware-workstation": {
      "command": "node",
      "args": ["/path/to/vmware-workstation-mcp/src/index.js"],
      "env": {
        "VMRUN_BRIDGE_URL": "http://127.0.0.1:57931/",
        "VMRUN_BRIDGE_TOKEN": "change-me"
      }
    }
  }
}
```

When starting with Windows-side Node.js, use Windows paths for `command` and `args`.

## VM Discovery

`find_vms` searches these locations by default:

- `~/vmware`
- `~/VMs`
- `~/Documents/Virtual Machines`
- On WSL, `/mnt/c/Users/*/Documents/Virtual Machines`
- On WSL, common VM locations on additional drives such as `/mnt/d/Virtual Machines` and `/mnt/e/Virtual Machines`

Set `VMWARE_VMX_ROOTS` with path-separated values to fix the search locations.

```bash
export VMWARE_VMX_ROOTS="/mnt/c/Users/you/Documents/Virtual Machines:/mnt/d/vms"
```

Many VM operation tools accept `vmName` instead of `vmxPath`. `vmName` is an exact match against the `.vmx` file name or the `displayName` inside the VMX. Duplicates fail for safety.

```json
{
  "vmName": "Parrot72"
}
```

Explicit aliases, search roots, bridge settings, and policy can also be written in `vmware-mcp.config.json`. The template is `vmware-mcp.config.example.json`. Set `VMWARE_MCP_CONFIG` to use another path.

```bash
cp vmware-mcp.config.example.json vmware-mcp.config.json
export VMWARE_MCP_CONFIG=/path/to/vmware-mcp.config.json
```

`vmName` resolution caches VM discovery results. The default TTL is 300 seconds.

```bash
export VMWARE_VM_CACHE_TTL_MS=300000
export VMWARE_DISCOVERY_DEPTH=7
```

## Safety Settings

Start in read-only mode:

```bash
export VMWARE_MCP_READONLY=1
```

Use `VMWARE_ALLOWED_ACTIONS` for fine-grained allowlists. Values can be separated by commas, colons, or semicolons.

```bash
export VMWARE_ALLOWED_ACTIONS="start_vm,stop_vm"
```

Categories are also supported:

- `read`: status checks, VMX reads, snapshot listing, IP lookup, and similar read operations
- `power`: start, stop, suspend, reset, pause
- `snapshot`: create, revert, and delete snapshots
- `guest`: run programs inside the guest OS
- `guest_read`: list processes/directories and check existence inside the guest OS
- `file_transfer`: copy files between host and guest
- `shared_folder`: enable, add, and remove shared folders
- `vmx_edit`: edit VMX configuration files
- `raw`: `vmrun` escape hatch

Deny specific actions:

```bash
export VMWARE_DENIED_ACTIONS="vmrun,delete_snapshot"
```

Limit target VMX paths to specific roots:

```bash
export VMWARE_ALLOWED_ROOTS="/mnt/d/Virtual Machines:/mnt/e/Virtual Machines"
```

High-risk operations require `confirm`, such as `reset_vm`, `revert_to_snapshot`, `delete_snapshot`, `disable_shared_folders`, `remove_shared_folder`, `edit_vmx_config`, `run_guest_program_with_snapshot`, and `vmrun`.

## Provided Tools

The server provides tools for environment diagnosis, VM discovery/cache management, VM status/details, VMX reading/editing, power operations, snapshots, guest IP/tools checks, screen capture, shared folder management, guest program execution, guest process/directory/file checks, host/guest file copy, a snapshot-wrapped guest execution helper, and raw `vmrun` execution for advanced users.

Guest OS tools require VMware Tools to be running inside the guest and require guest OS credentials. MCP responses redact the `vmrun -gp` value, but this server still handles guest credentials, so run it only from trusted local MCP clients.

## Path Handling

When running from WSL, passing a VMX path such as `/mnt/c/.../vm.vmx` converts it to `C:\...\vm.vmx` before calling `vmrun.exe`. Windows paths also work as-is.
