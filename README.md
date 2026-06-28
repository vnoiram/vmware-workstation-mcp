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

Windows ログオン時に bridge を自動起動する Task Scheduler 登録例:

```powershell
.\tools\register-vmrun-bridge-task.ps1 -Token "change-me"
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

多くの VM 操作ツールは `vmxPath` の代わりに `vmName` も受け付けます。`vmName` は `.vmx` のファイル名、または VMX 内の `displayName` と完全一致する名前です。重複した場合は安全のためエラーになります。

```json
{
  "vmName": "Parrot72"
}
```

明示エイリアス、検索ルート、bridge、policy は `vmware-mcp.config.json` にも書けます。雛形は `vmware-mcp.config.example.json` です。別パスを使う場合は `VMWARE_MCP_CONFIG` を指定してください。

```bash
cp vmware-mcp.config.example.json vmware-mcp.config.json
export VMWARE_MCP_CONFIG=/path/to/vmware-mcp.config.json
```

`vmName` 解決は VM 探索結果をキャッシュします。既定 TTL は 300 秒です。

```bash
export VMWARE_VM_CACHE_TTL_MS=300000
export VMWARE_DISCOVERY_DEPTH=7
```

## 安全設定

読み取り専用で起動する場合:

```bash
export VMWARE_MCP_READONLY=1
```

操作を細かく許可する場合は `VMWARE_ALLOWED_ACTIONS` を使います。値はカンマ、コロン、セミコロン区切りです。

```bash
export VMWARE_ALLOWED_ACTIONS="start_vm,stop_vm"
```

カテゴリ単位でも指定できます。

- `read`: 状態確認、VMX 読み取り、スナップショット一覧、IP 取得など
- `power`: 起動、停止、サスペンド、リセット、一時停止
- `snapshot`: スナップショット作成、復元、削除
- `guest`: ゲスト OS 内でのプログラム実行
- `guest_read`: ゲスト OS 内のプロセス/ディレクトリ/存在確認
- `file_transfer`: ホストとゲスト間のファイルコピー
- `shared_folder`: 共有フォルダの有効化、追加、削除
- `vmx_edit`: VMX 設定ファイルの編集
- `raw`: `vmrun` escape hatch

特定操作を禁止する場合:

```bash
export VMWARE_DENIED_ACTIONS="vmrun,delete_snapshot"
```

操作対象の VMX パスを特定ルート配下に制限する場合:

```bash
export VMWARE_ALLOWED_ROOTS="/mnt/d/Virtual Machines:/mnt/e/Virtual Machines"
```

高リスク操作には `confirm` が必要です。

- `reset_vm`: `confirm: "reset_vm"`
- `revert_to_snapshot`: `confirm: "revert_to_snapshot"`
- `delete_snapshot`: `confirm: "delete_snapshot"`
- `disable_shared_folders`: `confirm: "disable_shared_folders"`
- `remove_shared_folder`: `confirm: "remove_shared_folder"`
- `edit_vmx_config`: `confirm: "edit_vmx_config"`
- `run_guest_program_with_snapshot`: `confirm: "run_guest_program_with_snapshot"`
- `vmrun`: `confirm: "vmrun"`

## 提供ツール

- `server_info`: 検出した `vmrun` と既定検索ルートを表示します。
- `diagnose_environment`: Node/WSL/vmrun/bridge/検索ルート/policy/実行中 VM を診断します。
- `find_vms`: `.vmx` ファイルを検索し、実行中かどうかも返します。
- `refresh_vm_cache`: VM 探索キャッシュを更新します。
- `list_vm_cache`: VM 探索キャッシュを表示します。
- `get_vm_status`: 指定 VM の実行状態とパス情報を表示します。
- `get_vm_details`: 実行状態、VMX メタデータ、スナップショット、IP、Tools 状態をまとめて表示します。
- `read_vmx_config`: `.vmx` ファイルから表示名、ゲスト OS、メモリ、CPU などを読み取ります。
- `edit_vmx_config`: VMX の表示名、メモリ、CPU、ゲスト OS、ネットワーク種別などを編集します。
- `list_running_vms`: 実行中 VM を取得します。
- `start_vm`: VM を起動します。
- `start_vm_and_wait`: VM 起動後、Tools/IP/任意ポートが使えるまで待ちます。
- `stop_vm`: VM を停止します。
- `suspend_vm`: VM をサスペンドします。
- `reset_vm`: VM をリセットします。
- `pause_vm`: VM を一時停止します。
- `unpause_vm`: VM の一時停止を解除します。
- `list_snapshots`: スナップショット一覧を取得します。
- `create_snapshot`: スナップショットを作成します。
- `revert_to_snapshot`: スナップショットへ戻します。
- `delete_snapshot`: スナップショットを削除します。
- `get_guest_ip_address`: VMware Tools 経由でゲスト OS の IP アドレスを取得します。
- `check_guest_port`: ゲスト IP または指定ホストの TCP ポート疎通を確認します。
- `check_tools_state`: VMware Tools の状態を確認します。
- `capture_screen`: VM の画面をホスト上の画像ファイルに保存します。
- `enable_shared_folders`: 共有フォルダ機能を有効化します。
- `disable_shared_folders`: 共有フォルダ機能を無効化します。
- `add_shared_folder`: ホストディレクトリをゲストへ共有します。
- `remove_shared_folder`: 共有フォルダを削除します。
- `guest_run_program`: VMware Tools 経由でゲスト OS 内のプログラムを実行します。
- `guest_list_processes`: ゲスト OS 内のプロセス一覧を取得します。
- `guest_list_directory`: ゲスト OS 内のディレクトリを一覧します。
- `guest_file_exists`: ゲスト OS 内のファイル存在確認をします。
- `guest_directory_exists`: ゲスト OS 内のディレクトリ存在確認をします。
- `copy_file_from_guest`: ゲスト OS からホストへファイルをコピーします。
- `copy_file_to_guest`: ホストからゲスト OS へファイルをコピーします。
- `run_guest_program_with_snapshot`: 実行前 snapshot、失敗時 revert、成功時 snapshot 削除を選べるゲスト実行ラッパーです。
- `vmrun`: 明示した `vmrun` 引数を実行する上級者向けツールです。

ゲスト OS 操作系ツールは VMware Tools がゲスト内で動作しており、ゲスト OS のユーザー名とパスワードを渡せる場合に使えます。
MCP の応答では `vmrun -gp` の値を伏せますが、ゲスト認証情報を扱うため、このサーバーは信頼できるローカル MCP クライアントからだけ起動してください。

## パスの扱い

WSL から実行している場合、VMX パスに `/mnt/c/.../vm.vmx` のような WSL パスを渡すと、`C:\...\vm.vmx` に変換して `vmrun.exe` に渡します。Windows パスをそのまま渡しても動作します。
