# Remote Commander

出先のiPhoneから、自宅/会社PCで動くClaude Codeを操作するためのPWA。

## しくみ

```
[iPhone Safari (PWA)]
        │
        ▼ HTTPS
[Cloudflare Quick Tunnel]
        │
        ▼
[FastAPI :8765]
        │
        ▼ subprocess
[claude -p --output-format stream-json]
        │
        ▼ (stream-JSON → SSE)
[iPhone で返答がストリーム表示]
```

- バックエンドは Claude Code CLI を `--session-id` / `--resume` で制御するので、グローバル `CLAUDE.md`・スキル・MCP・権限設定はPC上と100%同じコンテキストで動く。
- Cloudflare Quick Tunnel は認証不要で `*.trycloudflare.com` のHTTPS URLを即発行。起動のたびにURLは変わる。
- PWAマニフェスト付き。iPhoneで「ホーム画面に追加」すればアプリ風に起動。

## 起動

```powershell
powershell -ExecutionPolicy Bypass -File "run.ps1"
```

- 起動すると公開URL（例: `https://xxx-yyy-zzz.trycloudflare.com`）が表示され、クリップボードにコピーされる。
- iPhone Safari でそのURLを開く → 共有 → 「ホーム画面に追加」でPWA化。

## 停止

```powershell
powershell -ExecutionPolicy Bypass -File "stop.ps1"
```

## 機能

- プロンプト送信・ストリーミング返答
- 複数セッション切替（ドロワー）
- セッション再開（`--resume`）
- 画像アップロード（`uploads/` に保存、プロンプトに絶対パスで添付）
- コピーボタン（返答ごと）
- PWA化（ホーム画面追加、オフラインでシェル読込）
- 3D CADっぽい動的背景（Three.js, `bg.js`）

## ファイル構成

```
remote-commander/
├── server.py           # FastAPI backend (claude CLI driver)
├── run.ps1             # start server + cloudflared quick tunnel
├── stop.ps1            # kill server + tunnel via state.json
├── bin/
│   └── cloudflared.exe # Windows tunnel binary
├── static/             # PWA frontend
│   ├── index.html
│   ├── style.css
│   ├── app.js          # chat UI, SSE handling, sessions, uploads
│   ├── bg.js           # Three.js animated 3D background
│   ├── sw.js           # service worker (offline shell cache)
│   ├── manifest.json
│   ├── icon-192.png
│   └── icon-512.png
├── uploads/            # runtime image uploads
├── logs/               # server.log / tunnel.log (runtime)
├── sessions.json       # session metadata (runtime)
└── state.json          # run.ps1 state for stop.ps1 (runtime)
```

## カスタマイズ

- ポート変更: `$PORT = 8765` を `run.ps1` で書き換え
- デフォルトcwd: `server.py` の `DEFAULT_CWD` を変更
- モデル変更: UIから未対応（サーバーは `model` パラメータ受け付け済み）

## 注意

- Cloudflare Quick Tunnel には **認証がない**。URLを知っていれば誰でも使える（短命URLだがSNS等に貼らないこと）。
- 認証を足すなら Cloudflare Access（Google OAuth等）を `trycloudflare.com` ではなく名前付きTunnel上に入れる。
- PCの蓋閉じはCLAUDE.mdの設定で無効化済みなので、外出中もバックエンドは動き続ける。
