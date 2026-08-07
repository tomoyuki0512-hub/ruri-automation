/*
 * 成果物（棚卸照合ツール.html）を実際のブラウザで開いて通しで検証する。
 *
 *   python3 tools/make_samples.py
 *   node tests/e2e.mjs
 *
 * Playwright がグローバルに入っている前提。スクリーンショットは tests/ に出力する。
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const appPath = join(root, '棚卸照合ツール.html');
const samples = process.env.SAMPLE_DIR || join(root, 'samples');

for (const p of [
  appPath,
  join(samples, 'sample_預り書.xlsx'),
  join(samples, 'sample_SAP.xlsx'),
  join(samples, 'sample_マッピング表.xlsx')
]) {
  if (!existsSync(p)) throw new Error(`必要なファイルがありません: ${p}\n先に tools/build.py と tools/make_samples.py を実行してください。`);
}

// Playwright の setInputFiles は非 ASCII のパスを渡すと無反応になるため、
// アップロード用に ASCII 名のコピーを作る（アプリ側の制約ではない）。
const uploadDir = mkdtempSync(join(tmpdir(), 'tanaoroshi-in-'));
const upload = {};
for (const [key, name] of [
  ['actual', 'sample_預り書.xlsx'],
  ['sap', 'sample_SAP.xlsx'],
  ['mapping', 'sample_マッピング表.xlsx']
]) {
  upload[key] = join(uploadDir, `${key}.xlsx`);
  copyFileSync(join(samples, name), upload[key]);
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, message: err.message });
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

// file:// で開く（利用者が HTML をダブルクリックしたのと同じ状況）
await page.goto(pathToFileURL(appPath).href);

// --- ファイル投入 -------------------------------------------------------
await page.setInputFiles('.card[data-file="actual"] input[type=file]', upload.actual);
await page.setInputFiles('.card[data-file="sap"] input[type=file]', upload.sap);
await page.setInputFiles('.card[data-file="mapping"] input[type=file]', upload.mapping);

await page.waitForSelector('.card[data-file="mapping"] .preview table');

const previewShot = join(here, 'screenshot-1-upload.png');
await page.screenshot({ path: previewShot, fullPage: true });

// プレビューが正しい列を拾えているか
const firstPreviewRow = await page.$$eval(
  '.card[data-file="actual"] .preview tbody tr:first-child td',
  (tds) => tds.map((td) => td.textContent)
);
check('預り書プレビューが A/E/I 列を表示する', () => {
  assert.deepEqual(firstPreviewRow, ['2', '東京第一倉庫', 'AAA-100', '3']);
});

const sapPreviewRow = await page.$$eval(
  '.card[data-file="sap"] .preview tbody tr:first-child td',
  (tds) => tds.map((td) => td.textContent)
);
check('SAP在庫残データのプレビューが E/G/J 列を表示する', () => {
  assert.deepEqual(sapPreviewRow, ['2', 'ST01', 'AAA-100', '5']);
});

check('実行ボタンが有効になる', async () => {});
const runDisabled = await page.$eval('#runBtn', (b) => b.disabled);
check('3ファイル揃うと実行ボタンが押せる', () => assert.equal(runDisabled, false));

// --- 実行 ---------------------------------------------------------------
await page.click('#runBtn');
await page.waitForSelector('#resultSection:not([hidden])');
await page.waitForFunction(() => document.querySelectorAll('#resultBody tr').length > 0);

const summary = await page.evaluate(() => window.__tanaoroshi.state.output.summary);
const stats = await page.evaluate(() => window.__tanaoroshi.state.output.stats);

check('判定件数が期待どおり', () => {
  assert.deepEqual(
    { match: summary.match, diff: summary.diff, actualOnly: summary.actualOnly, sapOnly: summary.sapOnly },
    { match: 6, diff: 1, actualOnly: 1, sapOnly: 1 }
  );
});
check('照合キー数が 9', () => assert.equal(summary.keys, 9));
check('預り書合計が 1245.5（"1,200" 文字列も加算）', () => assert.equal(summary.actualTotal, 1245.5));
check('SAP合計が 1248.5', () => assert.equal(summary.sapTotal, 1248.5));
check('マッピング表に無い保管場所を 4 明細検出', () =>
  assert.equal(stats.sap.unconverted, 4, 'ST99 の2明細 + 住友商事マシネックス株式会社 の2明細'));
check('マッピング表を 5 件読み込む', () => assert.equal(stats.mappingCount, 5));

// --- 預り書に無い倉庫の除外 ---------------------------------------------
const excluded = await page.evaluate(() => window.__tanaoroshi.state.output.excluded);
const allWarehouses = await page.$$eval('#resultBody tr', (trs) =>
  trs.map((t) => t.children[1].textContent.trim()));

check('預り書に無い倉庫は結果に出さない', () => {
  assert.ok(!allWarehouses.includes('住友商事マシネックス株式会社'),
    '実際に表示された倉庫: ' + JSON.stringify([...new Set(allWarehouses)]));
});
check('除外した倉庫を件数つきで保持する', () => {
  assert.equal(summary.excludedKeys, 3, 'ZZZ-900 / ZZZ-901 / YYY-800');
  assert.equal(summary.excludedLines, 3);
  assert.equal(excluded.length, 1, '変換表経由の XX01 も同じ倉庫名にまとまる');
  assert.equal(excluded[0].warehouse, '住友商事マシネックス株式会社');
  assert.equal(excluded[0].keys, 3);
  assert.equal(excluded[0].qty, 46, '30 + 12 + 4');
  assert.ok(excluded[0].sourceNames.includes('XX01'), '変換前の名前も残す');
});
check('除外した数量は SAP 合計に含めない', () => assert.equal(summary.sapTotal, 1248.5));

// 画面表示の検証
const summaryValues = await page.$$eval('#summary .stat-value', (els) => els.map((e) => e.textContent.trim()));
check('サマリーカードの表示が件数と一致', () => {
  assert.deepEqual(summaryValues, ['6件', '1件', '1件', '1件']);
});

const firstRow = await page.$$eval('#resultBody tr:first-child td', (tds) => tds.map((t) => t.textContent.trim()));
check('先頭行は差異（預り書のみ）が来る', () => {
  assert.equal(firstRow[0], '預り書のみ');
  assert.equal(firstRow[1], '東京第一倉庫');
  assert.equal(firstRow[2], 'CCC-300');
  assert.equal(firstRow[3], '4');
  assert.equal(firstRow[4], '—');
});

const diffRow = await page.$$eval('#resultBody tr', (trs) => {
  const tr = trs.find((t) => t.children[2].textContent.trim() === 'BBB-200');
  return Array.from(tr.children).map((td) => td.textContent.trim());
});
check('数量差異の行が預り書10/SAP8/差異+2', () => {
  assert.equal(diffRow[0], '差異');
  assert.equal(diffRow[3], '10');
  assert.equal(diffRow[4], '8');
  assert.equal(diffRow[5], '+2');
});

const summedRow = await page.$$eval('#resultBody tr', (trs) => {
  const tr = trs.find((t) => t.children[2].textContent.trim() === 'GGG-700');
  return Array.from(tr.children).map((td) => td.textContent.trim());
});
check('SAP側2明細がサマられて一致する（名古屋倉庫 GGG-700 = 12）', () => {
  assert.equal(summedRow[0], '一致');
  assert.equal(summedRow[3], '12');
  assert.equal(summedRow[4], '12');
  assert.equal(summedRow[7], '2', 'SAP明細件数が2');
});

const unconvertedRow = await page.$$eval('#resultBody tr', (trs) => {
  const tr = trs.find((t) => t.children[2].textContent.trim() === 'FFF-600');
  return Array.from(tr.children).map((td) => td.textContent.trim());
});
check('マッピング表に無い ST99 は元名称のまま突合して一致', () => {
  assert.equal(unconvertedRow[0], '一致');
  assert.equal(unconvertedRow[1], 'ST99');
  assert.equal(unconvertedRow[3], '7');
});

// --- 絞り込み -----------------------------------------------------------
await page.click('.filter-btn[data-filter="差異"]');
const diffOnlyCount = await page.$$eval('#resultBody tr', (t) => t.length);
check('「差異」で絞り込むと1件', () => assert.equal(diffOnlyCount, 1));

await page.click('.filter-btn[data-filter="all"]');
await page.fill('#searchBox', 'AAA');
const searchCount = await page.$$eval('#resultBody tr', (t) => t.length);
check('検索「AAA」で2件', () => assert.equal(searchCount, 2));
await page.fill('#searchBox', '');

const resultShot = join(here, 'screenshot-2-result.png');
await page.screenshot({ path: resultShot, fullPage: true });

// 警告パネル
await page.click('#warnToggle');
const warnText = await page.textContent('#warnBody');
check('マッピング表に無い保管場所は確認事項に出さない', () => {
  // 元の保管場所名のまま照合するのは仕様どおりの動きなので確認不要
  assert.doesNotMatch(warnText, /マッピング表に該当が無かった/);
  assert.doesNotMatch(warnText, /マッピング表に無い保管場所/);
});
check('出力対象外にした倉庫を確認事項に出す', () => {
  assert.match(warnText, /預り書に無い倉庫のため出力対象外/);
  assert.match(warnText, /住友商事マシネックス株式会社/);
  assert.match(warnText, /変換前: XX01/);
});
const warnShot = join(here, 'screenshot-3-warnings.png');
await page.screenshot({ path: warnShot, fullPage: true });

// --- CSV 保存: 「名前を付けて保存」ダイアログが使える場合 -----------------
// ネイティブのダイアログはテストで操作できないため、API を差し替えて
// 日本語ファイル名が提案され中身が正しく書き出されることだけを確認する。
await page.evaluate(() => {
  window.__picked = null;
  window.showSaveFilePicker = async (opts) => {
    window.__picked = { suggestedName: opts.suggestedName, accept: opts.types[0].accept };
    return {
      name: opts.suggestedName,
      createWritable: async () => ({
        write: async (blob) => {
          // Blob.text() は先頭の BOM を取り除いてしまうので、生バイトで受け取る
          const bytes = new Uint8Array(await blob.arrayBuffer());
          window.__picked.head = Array.from(bytes.slice(0, 3));
          window.__picked.body = new TextDecoder('utf-8').decode(bytes);
        },
        close: async () => {}
      })
    };
  };
});
await page.click('#csvAll');
await page.waitForFunction(() => window.__picked && window.__picked.body);
const picked = await page.evaluate(() => window.__picked);

check('保存ダイアログに日本語ファイル名を提案する', () => {
  assert.match(picked.suggestedName, /^棚卸照合結果_\d{8}_\d{4}\.csv$/);
  assert.deepEqual(picked.accept, { 'text/csv': ['.csv'] });
});
check('保存ダイアログ経由でも BOM 付き CSV を書き出す', () => {
  assert.deepEqual(picked.head, [0xef, 0xbb, 0xbf], 'UTF-8 BOM で始まる');
  assert.ok(picked.body.includes('差異,東京第一倉庫,BBB-200,10,8,2,1,1,ST01'));
});

// ダイアログをキャンセルしたときは何も保存せず、通知も出さない
await page.evaluate(() => {
  window.__picked = null;
  document.getElementById('toast').hidden = true;
  window.showSaveFilePicker = async () => {
    const e = new Error('cancelled');
    e.name = 'AbortError';
    throw e;
  };
});
await page.click('#csvAll');
await page.waitForTimeout(400);
const afterCancel = await page.evaluate(() => ({
  toastHidden: document.getElementById('toast').hidden,
  picked: window.__picked
}));
check('保存をキャンセルしても何も起きない', () => {
  assert.equal(afterCancel.toastHidden, true, '保存完了の通知が出ない');
  assert.equal(afterCancel.picked, null);
});

// --- CSV 保存: ダイアログ非対応ブラウザのフォールバック ------------------
const downloadDir = mkdtempSync(join(tmpdir(), 'tanaoroshi-'));
await page.evaluate(() => { delete window.showSaveFilePicker; });

const [allDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#csvAll')
]);
const allPath = join(downloadDir, 'all.csv');
await allDownload.saveAs(allPath);
const allCsv = readFileSync(allPath, 'utf8');

check('フォールバックのファイル名は ASCII で .csv 拡張子が残る', () => {
  assert.match(allDownload.suggestedFilename(), /^tanaoroshi_result_\d{8}_\d{4}\.csv$/);
});
check('CSV に BOM が付く', () => assert.equal(allCsv.charCodeAt(0), 0xfeff));
check('CSV が CRLF 改行', () => assert.ok(allCsv.includes('\r\n')));

const allLines = allCsv.replace(/^﻿/, '').trim().split('\r\n');
check('CSV ヘッダが仕様どおり', () => {
  assert.equal(allLines[0], '判定,倉庫名,型式,預り書台数,SAP基本数量,差異(預り書-SAP),預り書明細件数,SAP明細件数,SAP保管場所名(変換前)');
});
check('CSV は 9 件 + ヘッダ', () => assert.equal(allLines.length, 10));
check('CSV に差異行が正しく入る', () => {
  assert.ok(allLines.some((l) => l === '差異,東京第一倉庫,BBB-200,10,8,2,1,1,ST01'), allLines.join('\n'));
});
check('CSV に預り書のみ行（SAP側空欄）が入る', () => {
  assert.ok(allLines.some((l) => l === '預り書のみ,東京第一倉庫,CCC-300,4,,4,1,0,'), allLines.join('\n'));
});
check('CSV に SAPのみ行（預り書側空欄）が入る', () => {
  assert.ok(allLines.some((l) => l === 'SAPのみ,大阪倉庫,HHH-800,,9,-9,0,1,ST02'), allLines.join('\n'));
});
check('CSV でサマった明細件数が出る', () => {
  assert.ok(allLines.some((l) => l === '一致,東京第一倉庫,AAA-100,5,5,0,2,1,ST01'), allLines.join('\n'));
});

const [diffDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#csvDiff')
]);
const diffPath = join(downloadDir, 'diff.csv');
await diffDownload.saveAs(diffPath);
const diffCsv = readFileSync(diffPath, 'utf8');
const diffLines = diffCsv.replace(/^﻿/, '').trim().split('\r\n');

check('差異のみCSV は 3 件 + ヘッダ', () => assert.equal(diffLines.length, 4));
check('差異のみCSV に「一致」行が無い', () => {
  assert.ok(!diffLines.slice(1).some((l) => l.startsWith('一致,')));
});
check('差異のみCSV のフォールバック名', () => {
  assert.match(diffDownload.suggestedFilename(), /^tanaoroshi_diff_\d{8}_\d{4}\.csv$/);
});

// --- 読み込み設定の変更 -------------------------------------------------
// 開始行を打ち替えた時点で（フォーカスを外す前に）プレビューが追従し、
// 古い照合結果が残らないこと。
await page.fill('.card[data-file="actual"] .start-row', '3');
await page.waitForFunction(() =>
  document.querySelector('.card[data-file="actual"] .preview tbody tr td').textContent === '3');
const afterStartRow = await page.evaluate(() => ({
  hidden: document.getElementById('resultSection').hidden,
  output: window.__tanaoroshi.state.output,
  hint: document.getElementById('runHint').textContent
}));
check('開始行を打ち替えるとプレビューが即座に追従する', async () => {});
check('開始行を変えると古い結果を破棄して再実行を促す', () => {
  assert.equal(afterStartRow.hidden, true);
  assert.equal(afterStartRow.output, null);
  assert.match(afterStartRow.hint, /もう一度実行/);
});

// 入力途中で空にしても勝手に 1 に書き換えない
await page.fill('.card[data-file="actual"] .start-row', '');
const whileEmpty = await page.inputValue('.card[data-file="actual"] .start-row');
check('入力途中で空にしても値を書き換えない', () => assert.equal(whileEmpty, ''));
await page.locator('.card[data-file="actual"] .start-row').press('Tab');
const afterBlur = await page.inputValue('.card[data-file="actual"] .start-row');
check('フォーカスを外した時点で 1 に補正する', () => assert.equal(afterBlur, '1'));

// 元に戻して再実行できることを確認
await page.fill('.card[data-file="actual"] .start-row', '2');
await page.click('#runBtn');
await page.waitForSelector('#resultSection:not([hidden])');
const rerun = await page.evaluate(() => window.__tanaoroshi.state.output.summary);
check('設定を戻して再実行すると元の結果に戻る', () => {
  assert.deepEqual(
    { match: rerun.match, diff: rerun.diff, actualOnly: rerun.actualOnly, sapOnly: rerun.sapOnly },
    { match: 6, diff: 1, actualOnly: 1, sapOnly: 1 }
  );
});

// --- 同梱の実マッピング表が読めるか -------------------------------------
// リポジトリ同梱の「マッピング表(倉庫名⇔保管場所名).xlsx」は実データなので、
// 既定設定（先頭シート・2行目開始）でそのまま読めることを確認する。
const realMapping = join(root, 'マッピング表(倉庫名⇔保管場所名).xlsx');
if (existsSync(realMapping)) {
  const realCopy = join(uploadDir, 'real-mapping.xlsx');
  copyFileSync(realMapping, realCopy);

  await page.click('.card[data-file="mapping"] .clear-btn');
  await page.setInputFiles('.card[data-file="mapping"] input[type=file]', realCopy);
  await page.waitForSelector('.card[data-file="mapping"] .preview table');

  const realRow = await page.$$eval(
    '.card[data-file="mapping"] .preview tbody tr:first-child td',
    (tds) => tds.map((td) => td.textContent)
  );
  const realErrors = await page.$$eval('.card[data-file="mapping"] .card-error', (e) => e.map((x) => x.textContent));

  check('同梱のマッピング表を既定設定で読み込める', () => {
    assert.deepEqual(realErrors, []);
    assert.deepEqual(realRow, [
      '2', '株式会社ＰＦＵ　名古屋ロジスティックセンター', '名古屋ロジスティック倉庫'
    ]);
  });

  await page.click('#runBtn');
  await page.waitForSelector('#resultSection:not([hidden])');
  const realCount = await page.evaluate(() => window.__tanaoroshi.state.output.stats.mappingCount);
  check('同梱のマッピング表から 23 件読み込む', () => assert.equal(realCount, 23));

  // サンプルに戻して以降の検証に影響させない
  await page.click('.card[data-file="mapping"] .clear-btn');
  await page.setInputFiles('.card[data-file="mapping"] input[type=file]', upload.mapping);
  await page.waitForSelector('.card[data-file="mapping"] .preview table');
  await page.click('#runBtn');
  await page.waitForSelector('#resultSection:not([hidden])');
}

// --- ダークテーマ -------------------------------------------------------
await page.click('#themeToggle');
await page.waitForTimeout(150);
const themeAttr = await page.getAttribute('html', 'data-theme');
check('テーマ切り替えが効く', () => assert.ok(themeAttr === 'dark' || themeAttr === 'light'));
const darkShot = join(here, 'screenshot-4-dark.png');
await page.screenshot({ path: darkShot, fullPage: true });

check('JavaScript エラーが出ていない', () => {
  assert.deepEqual(consoleErrors, []);
});

await browser.close();

// --- 結果出力 -----------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (c.ok) {
    console.log(`  ok   ${c.name}`);
  } else {
    failed++;
    console.log(`  FAIL ${c.name}\n       ${c.message}`);
  }
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
console.log(`スクリーンショット: ${previewShot}, ${resultShot}, ${warnShot}, ${darkShot}`);
process.exit(failed ? 1 : 0);
