/**
 * 用 zxing 复核 —— jsQR 在这个微信码上表现不稳（结果非单调、自相矛盾），
 * 需要一个更成熟的解码器来判"到底是图的问题还是解码器的问题"。
 *
 * zxing 支持直接从 RGB 数组解，不需要中间存盘。
 */
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { MultiFormatReader, BarcodeFormat, DecodeHintType, RGBLuminanceSource, BinaryBitmap, HybridBinarizer } = require('@zxing/library');

const TMP = 'C:/Users/92182/.workbuddy-ai/tmp';
const BRAND = 'D:/数学建模项目/mcm-agent/resources/brand';

function decodePng(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const luminances = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0; i < luminances.length; i++) {
    const r = png.data[i * 4], g = png.data[i * 4 + 1], b = png.data[i * 4 + 2];
    luminances[i] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminances, png.width, png.height)));
  try {
    const r = reader.decode(bitmap);
    return { ok: true, text: r.getText(), size: png.width + 'x' + png.height };
  } catch (e) {
    return { ok: false, err: e.constructor.name, size: png.width + 'x' + png.height };
  }
}

const CASES = [
  ['微信码 · 整图原图', path.join(TMP, 'wx-full.png')],
  ['微信码 · 我裁的', path.join(BRAND, 'wechat-qr.png')],
  ['收款码 · 整图原图', path.join(TMP, 'pay-orig.png')],
  ['收款码 · 我裁的', path.join(BRAND, 'pay-qr.png')],
];

for (const [label, f] of CASES) {
  if (!fs.existsSync(f)) { console.log('  ' + label.padEnd(18) + '✗ 文件不存在'); continue; }
  const r = decodePng(f);
  if (r.ok) {
    console.log('  ' + label.padEnd(18) + '✓ (' + r.size + ') ' + r.text.slice(0, 70));
  } else {
    console.log('  ' + label.padEnd(18) + '✗ (' + r.size + ') ' + r.err);
  }
}
