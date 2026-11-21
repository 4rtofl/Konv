# Konv

ウェブページの画像を右クリックし、好きなファイル名と保存先で保存できるChrome拡張機能です。元の形式、PNG、JPEG、WebP、AVIF、BMP、PDFに対応し、アニメーションGIFは動きを保ったまま保存できます。形式変換はブラウザ内で行います。

## インストール

Node.jsとnpmがある環境で、次のコマンドを実行します。

```sh
npm ci
npm run build
```

Chrome 123以降で `chrome://extensions` を開き、**デベロッパー モード**をオンにします。**パッケージ化されていない拡張機能を読み込む**から `dist` フォルダを選びます。

## 使い方

- 画像を右クリックし、**画像を任意の形式で保存**から形式を選びます。ほかの形式は **その他の形式…** にあります。
- 拡張機能アイコンをクリックすると、右クリックメニューに並べる形式を設定できます。
- 背景画像・SVG・Canvasは **ページ上の対象を選ぶ…**、画面の一部は **表示範囲を保存…** から保存します。

Base64とNUVの出力もあります。開き方のヒントは、このREADMEのソースにあります。

<!--
node -p "Buffer.from('6Kit5a6a44Od44OD44OX44Ki44OD44OX44Gu5Lit44Gr44GC44KL44Ot44K044KSN+WbnuOCr+ODquODg+OCr+OAguOCguOBhuS4gOW6pjflm57jgq/jg6rjg4Pjgq/jgZnjgovjgajpnZ7ooajnpLrjgavjgarjgorjgb7jgZnjgII=', 'base64').toString('utf8')"
-->

## プライバシー

[プライバシーポリシー](./PRIVACY.md)
