# VMware Workstation MCP

VMware Workstation を `vmrun` 経由で操作する stdio MCP サーバーです。

このリポジトリは WSL 上に置いて実行できます。VMware Workstation は Windows ホスト側にあり、サーバーは WSL から `vmrun.exe` を起動します。Windows 側の Node.js で直接実行することもできます。

## セットアップ

```bash
npm install
```

`vmrun.exe` が標準の VMware Workstation インストール先にあれば自動検出します。見つからない場合は `VMRUN_PATH` を指定してください。
`vmrun` の product type は既定で VMware Workstation の `ws` を使います。変更したい場合は `VMRUN_TYPE` を指定してください。
WSL で `vmrun.exe` を使う場合は、既定で Windows PowerShell 経由で実行します。直接実行したい場合は `VMRUN_USE_POWERSHELL=0` を指定してください。
WSL 側 Node.js から Windows exe を直接起動できない環境では、Windows 側で `vmrun` bridge を起動し、WSL 側 MCP サーバーから `VMRUN_BRIDGE_URL` で接続してください。

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

Windows 側で bridge だけ起動し、MCP サーバーは WSL 側で動かす例:

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

`VMRUN_BRIDGE_HOST` と `VMRUN_BRIDGE_PORT` で bridge の listen 先を変更できます。既定は `127.0.0.1:57931` です。

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

Windows bridge を使う場合の WSL 側 MCP 設定例:

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

Windows 側の Node.js で起動する場合は `command` と `args` を Windows パスにしてください。

## VM 検出

`find_vms` は次の場所を既定で探します。

- `~/vmware`
- `~/VMs`
- `~/Documents/Virtual Machines`
- WSL の場合は `/mnt/c/Users/*/Documents/Virtual Machines`
- WSL の場合は `/mnt/d/Virtual Machines`, `/mnt/e/Virtual Machines` などの一般的な別ドライブ上の VM 置き場

検索場所を固定したい場合は `VMWARE_VMX_ROOTS` にパス区切りで指定できます。

```bash
export VMWARE_VMX_ROOTS="/mnt/c/Users/you/Documents/Virtual Machines:/mnt/d/vms"
```

## 提供ツール

- `server_info`: 検出した `vmrun` と既定検索ルートを表示します。
- `find_vms`: `.vmx` ファイルを検索し、実行中かどうかも返します。
- `get_vm_status`: 指定 VM の実行状態とパス情報を表示します。
- `read_vmx_config`: `.vmx` ファイルから表示名、ゲスト OS、メモリ、CPU などを読み取ります。
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
- `capture_screen`: VM の画面をホスト上の画像ファイルに保存します。
- `guest_run_program`: VMware Tools 経由でゲスト OS 内のプログラムを実行します。
- `guest_list_processes`: ゲスト OS 内のプロセス一覧を取得します。
- `guest_list_directory`: ゲスト OS 内のディレクトリを一覧します。
- `guest_file_exists`: ゲスト OS 内のファイル存在確認をします。
- `guest_directory_exists`: ゲスト OS 内のディレクトリ存在確認をします。
- `copy_file_from_guest`: ゲスト OS からホストへファイルをコピーします。
- `copy_file_to_guest`: ホストからゲスト OS へファイルをコピーします。
- `vmrun`: 明示した `vmrun` 引数を実行する上級者向けツールです。

ゲスト OS 操作系ツールは VMware Tools がゲスト内で動作しており、ゲスト OS のユーザー名とパスワードを渡せる場合に使えます。
MCP の応答では `vmrun -gp` の値を伏せますが、ゲスト認証情報を扱うため、このサーバーは信頼できるローカル MCP クライアントからだけ起動してください。

## パスの扱い

WSL から実行している場合、VMX パスに `/mnt/c/.../vm.vmx` のような WSL パスを渡すと、`C:\...\vm.vmx` に変換して `vmrun.exe` に渡します。Windows パスをそのまま渡しても動作します。
