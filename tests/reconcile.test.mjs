import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../src/reconcile.js');

/** 列文字を添字にしてスパース行を組み立てるヘルパ */
function row(spec) {
  const arr = [];
  for (const [col, value] of Object.entries(spec)) {
    arr[R.columnIndex(col)] = value;
  }
  return arr;
}

test('columnIndex は列文字を 0 始まりの添字にする', () => {
  assert.equal(R.columnIndex('A'), 0);
  assert.equal(R.columnIndex('E'), 4);
  assert.equal(R.columnIndex('I'), 8);
  assert.equal(R.columnIndex('J'), 9);
  assert.equal(R.columnIndex('AA'), 26);
});

test('parseQuantity は Excel/SAP 由来の各表記を解釈する', () => {
  assert.deepEqual(R.parseQuantity(12), { value: 12, ok: true, empty: false });
  assert.deepEqual(R.parseQuantity(1.5), { value: 1.5, ok: true, empty: false });
  assert.equal(R.parseQuantity('1,234').value, 1234);
  assert.equal(R.parseQuantity('１２３').value, 123);
  assert.equal(R.parseQuantity('(123)').value, -123);
  assert.equal(R.parseQuantity('△123').value, -123);
  assert.equal(R.parseQuantity('▲1,200').value, -1200);
  assert.equal(R.parseQuantity('123-').value, -123);
  assert.equal(R.parseQuantity('-5').value, -5);
  assert.equal(R.parseQuantity(' 7 ').value, 7);
  assert.equal(R.parseQuantity('0.25').value, 0.25);

  // 空欄は 0 として扱い、警告は出さない
  assert.deepEqual(R.parseQuantity(''), { value: 0, ok: true, empty: true });
  assert.deepEqual(R.parseQuantity(null), { value: 0, ok: true, empty: true });

  // 単位付きなどは誤読を避けて解釈失敗にする
  assert.equal(R.parseQuantity('12台').ok, false);
  assert.equal(R.parseQuantity('該当なし').ok, false);
  assert.equal(R.parseQuantity(true).ok, false);
});

test('toKeyText は完全一致のため空白や全角半角を保持する', () => {
  assert.equal(R.toKeyText(' A倉庫 '), ' A倉庫 ');
  assert.equal(R.toKeyText('ＡＢＣ'), 'ＡＢＣ');
  // 数値セルと文字列セルが混在しても比較できるよう文字列化はする
  assert.equal(R.toKeyText(1234), '1234');
  assert.equal(R.toKeyText(null), '');
});

test('buildLocationMap は後勝ちで辞書化し重複を警告する', () => {
  const built = R.buildLocationMap([
    row({ A: 'ST01', B: '東京倉庫' }),
    row({ A: 'ST02', B: '大阪倉庫' }),
    row({ A: 'ST01', B: '東京第一倉庫' }),
    row({ A: '', B: '無視される' }),
    row({ A: 'ST09', B: '' })
  ], 2);

  assert.equal(built.map['ST01'], '東京第一倉庫');
  assert.equal(built.map['ST02'], '大阪倉庫');
  assert.equal(built.count, 3);
  assert.equal(built.warnings.length, 3);
  assert.match(built.warnings[0], /4行目/);
});

test('convertLocation は変換表に無ければ元の名前を使う', () => {
  const map = { ST01: '東京倉庫' };
  assert.deepEqual(R.convertLocation('ST01', map), { name: '東京倉庫', converted: true });
  assert.deepEqual(R.convertLocation('ST99', map), { name: 'ST99', converted: false });
});

test('aggregate は倉庫×型式でサマる', () => {
  const agg = R.aggregate([
    row({ A: '東京倉庫', E: 'AAA-100', I: 3 }),
    row({ A: '東京倉庫', E: 'AAA-100', I: 2 }),
    row({ A: '東京倉庫', E: 'BBB-200', I: 5 }),
    row({ A: '大阪倉庫', E: 'AAA-100', I: 1 })
  ], {
    cols: { warehouse: 'A', model: 'E', qty: 'I' },
    startRow: 2,
    label: '実棚',
    labels: { warehouse: '倉庫名(A列)', model: '型式(E列)', qty: '台数(I列)' }
  });

  assert.equal(agg.groups.size, 3);
  const tokyoAaa = agg.groups.get('東京倉庫' + R.KEY_SEP + 'AAA-100');
  assert.equal(tokyoAaa.qty, 5, '同一キーの明細が合算されること');
  assert.equal(tokyoAaa.lines, 2);
  assert.deepEqual(tokyoAaa.rowNumbers, [2, 3]);
  assert.equal(agg.stats.total, 11);
});

test('aggregate はキーが空の行を集計対象外にして警告する', () => {
  const agg = R.aggregate([
    row({ A: '東京倉庫', E: 'AAA-100', I: 3 }),
    row({ A: '', E: 'BBB-200', I: 9 }),
    row({ A: '大阪倉庫', E: '', I: 9 }),
    []
  ], {
    cols: { warehouse: 'A', model: 'E', qty: 'I' },
    startRow: 2,
    label: '実棚',
    labels: { warehouse: '倉庫名(A列)', model: '型式(E列)', qty: '台数(I列)' }
  });

  assert.equal(agg.groups.size, 1);
  assert.equal(agg.stats.skippedBlank, 2);
  assert.equal(agg.stats.total, 3, '対象外の行は合計に含めない');
  assert.equal(agg.warnings.length, 2);
});

test('run はサマル・変換・判定を通しで行う', () => {
  const actual = [
    // 一致（実棚側が2明細に分かれている＝サマル必須）
    row({ A: '東京倉庫', E: 'AAA-100', I: 3 }),
    row({ A: '東京倉庫', E: 'AAA-100', I: 2 }),
    // 数量差異
    row({ A: '東京倉庫', E: 'BBB-200', I: 10 }),
    // 実棚のみ
    row({ A: '大阪倉庫', E: 'CCC-300', I: 4 }),
    // 変換表に無い倉庫（SAP 側も元名称のまま突合されて一致する）
    row({ A: 'ST99', E: 'DDD-400', I: 7 })
  ];
  const sap = [
    row({ E: 'ST01', G: 'AAA-100', J: 5 }),
    row({ E: 'ST01', G: 'BBB-200', J: 8 }),
    // SAPのみ
    row({ E: 'ST02', G: 'EEE-500', J: 6 }),
    // SAP 側も分かれている
    row({ E: 'ST99', G: 'DDD-400', J: 4 }),
    row({ E: 'ST99', G: 'DDD-400', J: 3 })
  ];
  const mapping = [
    row({ A: 'ST01', B: '東京倉庫' }),
    row({ A: 'ST02', B: '大阪倉庫' })
  ];

  const out = R.run({
    actual: { rows: actual, startRow: 2 },
    sap: { rows: sap, startRow: 2 },
    mapping: { rows: mapping, startRow: 2 }
  });

  const byKey = new Map(out.results.map((r) => [r.warehouse + '|' + r.model, r]));

  const aaa = byKey.get('東京倉庫|AAA-100');
  assert.equal(aaa.status, R.STATUS.MATCH);
  assert.equal(aaa.actualQty, 5);
  assert.equal(aaa.sapQty, 5);
  assert.equal(aaa.actualLines, 2);

  const bbb = byKey.get('東京倉庫|BBB-200');
  assert.equal(bbb.status, R.STATUS.DIFF);
  assert.equal(bbb.delta, 2);

  const ccc = byKey.get('大阪倉庫|CCC-300');
  assert.equal(ccc.status, R.STATUS.ACTUAL_ONLY);
  assert.equal(ccc.sapQty, null);

  const eee = byKey.get('大阪倉庫|EEE-500');
  assert.equal(eee.status, R.STATUS.SAP_ONLY);
  assert.equal(eee.actualQty, null);
  assert.equal(eee.delta, -6);

  const ddd = byKey.get('ST99|DDD-400');
  assert.equal(ddd.status, R.STATUS.MATCH, '変換表に無い保管場所は元の名前で突合される');
  assert.equal(ddd.sapQty, 7);

  assert.deepEqual(
    { match: out.summary.match, diff: out.summary.diff, actualOnly: out.summary.actualOnly, sapOnly: out.summary.sapOnly },
    { match: 2, diff: 1, actualOnly: 1, sapOnly: 1 }
  );
  assert.equal(out.summary.actualTotal, 26);
  assert.equal(out.summary.sapTotal, 26);
  assert.equal(out.stats.sap.unconverted, 2, 'ST99 の2明細は変換表に無い');
});

test('結果は差異が先頭に来るよう並ぶ', () => {
  const out = R.run({
    actual: {
      rows: [
        row({ A: 'W1', E: 'M1', I: 1 }),
        row({ A: 'W2', E: 'M2', I: 5 }),
        row({ A: 'W3', E: 'M3', I: 2 })
      ],
      startRow: 2
    },
    sap: {
      rows: [
        row({ E: 'W1', G: 'M1', J: 1 }),
        row({ E: 'W2', G: 'M2', J: 9 }),
        row({ E: 'W4', G: 'M4', J: 3 })
      ],
      startRow: 2
    },
    mapping: { rows: [], startRow: 2 }
  });

  assert.deepEqual(out.results.map((r) => r.status), [
    R.STATUS.ACTUAL_ONLY, R.STATUS.SAP_ONLY, R.STATUS.DIFF, R.STATUS.MATCH
  ]);
});

test('小数の丸め誤差は一致と判定する', () => {
  const out = R.run({
    actual: { rows: [row({ A: 'W1', E: 'M1', I: 0.1 }), row({ A: 'W1', E: 'M1', I: 0.2 })], startRow: 2 },
    sap: { rows: [row({ E: 'W1', G: 'M1', J: 0.3 })], startRow: 2 },
    mapping: { rows: [], startRow: 2 }
  });
  assert.equal(out.results[0].status, R.STATUS.MATCH);
});

test('完全一致のため表記ゆれは別キー扱いだが参考情報に出る', () => {
  const out = R.run({
    actual: { rows: [row({ A: '東京倉庫', E: 'AAA-100', I: 5 })], startRow: 2 },
    sap: { rows: [row({ E: '東京倉庫', G: 'ＡＡＡ-100 ', J: 5 })], startRow: 2 },
    mapping: { rows: [], startRow: 2 }
  });

  assert.equal(out.summary.actualOnly, 1);
  assert.equal(out.summary.sapOnly, 1);
  assert.equal(out.summary.match, 0, '完全一致のみなので全角/空白違いは一致しない');
  assert.equal(out.nearMisses.length, 1, '惜しいキーとして参考表示される');
  assert.equal(out.nearMisses[0].actualModel, 'AAA-100');
});

test('toCsv は BOM 付き CRLF でエスケープする', () => {
  const out = R.run({
    actual: { rows: [row({ A: '東京, 倉庫', E: 'A"1', I: 3 })], startRow: 2 },
    sap: { rows: [row({ E: 'ST01', G: 'B1', J: 2 })], startRow: 2 },
    mapping: { rows: [row({ A: 'ST01', B: '東京, 倉庫' })], startRow: 2 }
  });

  const csv = R.toCsv(out.results, false);
  assert.ok(csv.startsWith('﻿判定,倉庫名,型式,'), 'BOM とヘッダ');
  assert.ok(csv.includes('\r\n'), 'CRLF 改行');
  assert.ok(csv.includes('"東京, 倉庫"'), 'カンマを含む値は引用符で囲む');
  assert.ok(csv.includes('"A""1"'), '引用符は二重化する');
  assert.ok(csv.includes('ST01'), '変換前の保管場所名を残す');

  const diffOnly = R.toCsv(out.results, true);
  assert.ok(!diffOnly.includes('一致'), '差異のみ CSV には一致行を含めない');
});
