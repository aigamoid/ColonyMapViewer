# Colony Map Viewer

円柱状のスペースコロニー（O'Neill シリンダー）の内面に地図を巻き付けてレンダリングする、
自車をうしろから見る TPS 視点のナビ POC。

遠方の目標が地平線の下に沈まず「前方の空にせり上がって」見えるため、
遠距離の目的地と近距離の自車周辺を **1 画面に同時に** 収められる。

## コンセプト

- **コロニー変形**: 平坦なローカル地図ジオメトリ (x=東, z=北, y=標高) を、
  半径 R の円柱内面へ頂点シェーダで巻き付ける（[`src/colony.ts`](src/colony.ts)）。
  自車は円柱内面の最下部に立ち、`forward` 方向へ地面がせり上がる。
- **3 表示モード**: ノースアップ / 目的地アップ / 自分（進行方向）アップ。
  巻き付け方向 `forward` を切り替えるだけで実現。
- **データ**: いずれも API キー不要。
  - ベクタータイル: [OpenFreeMap](https://openfreemap.org/)（OpenMapTiles スキーマ、建物・道路・水域）
  - 地形標高: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)（Terrarium PNG）
  - ジオコーディング: OSM Nominatim（デモ）
  - ルート探索: OSRM デモサーバ（デモ）
- **自車**: 実 GPS 追従 / フリードライブ（WASD）/ ルート自動走行（デモ）。

> ⚠️ 類似の商用プロダクトに **Orbify**（"Navigation Reimagined"、特許出願中 PCT/EP2026/058725）がある。
> コンセプト自体は BERG "Here and There"（2009）等の公知だが、
> 商用ナビ製品化する場合は係属特許との抵触を要確認。

## 開発

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/ を生成
```

## 公開（GitHub Pages）

`main` に push すると [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) が
自動でビルドして GitHub Pages にデプロイする。

初回のみリポジトリ設定で **Settings → Pages → Build and deployment → Source = GitHub Actions** を選択。

公開 URL: `https://<user>.github.io/<repo>/`

## クロスプラットフォーム

- Web（PWA・`manifest.webmanifest`）: Android / iOS / Windows のブラウザでそのまま動作。
- 将来のネイティブ化: Capacitor で iOS / Android アプリにラップ可能（WebGL レンダラはそのまま）。

## 既知の制約（POC）

- タイルは起動時に自車周辺 5×5（z14）のみ読み込み。広域スクロール／ストリーミング未実装。
- 建物ポリゴンの中庭（穴）は簡易処理。
- 地図クリックの目的地指定は曲面の近似逆変換のため誤差あり。
- 車酔い対策として半径 R は調整可能（左下パネル）。
