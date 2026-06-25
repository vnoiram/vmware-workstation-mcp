# VMware Workstation MCP

VMware Workstation を `vmrun` 経由で操作する stdio MCP サーバーです。

このリポジトリは WSL 上に置いて実行できます。VMware Workstation は Windows ホスト側にあり、サーバーは WSL から `vmrun.exe` を起動します。Windows 側の Node.js で直接実行することもできます。

## セットアップ

```bash
npm install
```

`vmrun.exe` が標準の VMware Workstation インストール先にあれば自動検出します。見つからない場合は `VMRUN_PATH` を指定してください。

WSL から起動する例:

```bash
export VMRUN_PATH="/mnt/c/Program Files (x86)/VMware/VMware Workstation/vmrun.exe"
npm start
```

Windows から起動する例:

```powershell
$env:VMRUN_PATH = "C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe"
npm start
```

## MCP クライアント設定例

WSL 側の Node.js で起動する場合:

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

Windows 側の Node.js で起動する場合は `command` と `args` を Windows パスにしてください。

## VM 検出

`find_vms` は次の場所を既定で探します。

- `~/vmware`
- `~/VMs`
- `~/Documents/Virtual Machines`
- WSL の場合は `/mnt/c/Users/*/Documents/Virtual Machines`

検索場所を固定したい場合は `VMWARE_VMX_ROOTS` にパス区切りで指定できます。

```bash
export VMWARE_VMX_ROOTS="/mnt/c/Users/you/Documents/Virtual Machines:/mnt/d/vms"
```

## 提供ツール

- `server_info`: 検出した `vmrun` と既定検索ルートを表示します。
- `find_vms`: `.vmx` ファイルを検索します。
- `list_running_vms`: 実行中 VM を取得します。
- `start_vm`: VM を起動します。
- `stop_vm`: VM を停止します。
- `suspend_vm`: VM をサスペンドします。
- `reset_vm`: VM をリセットします。
- `pause_vm`: VM を一時停止します。
- `unpause_vm`: VM の一時停止を解除します。
- `list_snapshots`: スナップショット一覧を取得します。
- `create_snapshot`: スナップショットを作成します。
- `revert_to_snapshot`: スナップショットへ戻します。
- `delete_snapshot`: スナップショットを削除します。
- `vmrun`: 明示した `vmrun` 引数を実行する上級者向けツールです。

## パスの扱い

WSL から実行している場合、VMX パスに `/mnt/c/.../vm.vmx` のような WSL パスを渡すと、`C:\...\vm.vmx` に変換して `vmrun.exe` に渡します。Windows パスをそのまま渡しても動作します。
