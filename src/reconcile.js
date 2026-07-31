/*
 * 棚卸照合ロジック（DOM 非依存）
 *
 * 実棚 Excel（倉庫名 / 型式 / 台数）と SAP Excel（保管場所名 / 品目テキスト / 基本数量）を
 * 「倉庫名 × 型式」単位に集計して突合する。
 * ブラウザでは globalThis.Reconcile として、Node からは require で利用する。
 */
var Reconcile = (function () {
  'use strict';

  /** 判定区分。結果の並び順もこの順序に従う（差異を上に出す） */
  var STATUS = {
    ACTUAL_ONLY: '実棚のみ',
    SAP_ONLY: 'SAPのみ',
    DIFF: '差異',
    MATCH: '一致'
  };
  var STATUS_ORDER = [STATUS.ACTUAL_ONLY, STATUS.SAP_ONLY, STATUS.DIFF, STATUS.MATCH];

  /** 小数の丸め誤差で「差異」と誤判定しないための許容差 */
  var EPSILON = 1e-9;

  /** 集計キーの区切り文字。セル値には現れない制御文字を使う */
  var KEY_SEP = '\u0000';

  /** 列文字（A, E, I ...）を 0 始まりの添字に変換する */
  function columnIndex(letter) {
    var n = 0;
    var s = String(letter).toUpperCase();
    for (var i = 0; i < s.length; i++) {
      n = n * 26 + (s.charCodeAt(i) - 64);
    }
    return n - 1;
  }

  /**
   * セル値をキー用の文字列にする。
   * 照合は「完全一致のみ」なので trim も全角半角統一も行わない。
   * 数値セルと文字列セルが混在しても比較できるよう、文字列化だけを行う。
   */
  function toKeyText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value);
  }

  /** 全角英数字を半角にする（数量欄の解釈にのみ使用。キー照合には影響しない） */
  function toHalfWidth(text) {
    return text.replace(/[！-～]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    });
  }

  /**
   * 数量セルを数値にする。
   * 数値セルはそのまま。文字列は Excel / SAP 由来の表記を解釈する。
   *   "1,234"  → 1234    桁区切り
   *   "１２３"  → 123     全角数字
   *   "(123)"  → -123    会計形式の負数
   *   "△123"   → -123    日本の会計表記の負数
   *   "123-"   → -123    SAP の後置マイナス
   *   "12台"   → 解釈不能（誤読を避けるため失敗扱いにして警告に出す）
   * @returns {{value:number, ok:boolean, empty:boolean}}
   */
  function parseQuantity(value) {
    if (value === null || value === undefined) return { value: 0, ok: true, empty: true };

    if (typeof value === 'number') {
      var finite = isFinite(value);
      return { value: finite ? value : 0, ok: finite, empty: false };
    }
    if (typeof value === 'boolean') return { value: 0, ok: false, empty: false };
    if (value instanceof Date) return { value: 0, ok: false, empty: false };

    var text = toHalfWidth(String(value)).trim();
    if (text === '') return { value: 0, ok: true, empty: true };

    var negative = false;

    // 会計形式の括弧書き負数
    if (/^\(.*\)$/.test(text)) {
      negative = true;
      text = text.slice(1, -1).trim();
    }
    // 日本の会計表記の負数（△ ▲ ー −）
    if (/^[△▲−–—－]/.test(text)) {
      negative = true;
      text = text.slice(1).trim();
    }
    // SAP の後置マイナス
    if (/-$/.test(text)) {
      negative = true;
      text = text.slice(0, -1).trim();
    }

    text = text.replace(/,/g, '').replace(/\s/g, '');
    if (text === '') return { value: 0, ok: false, empty: false };

    // 数値以外の文字が混ざるものは解釈しない（"12台" を 12 と誤読しないため）
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) {
      return { value: 0, ok: false, empty: false };
    }

    var num = Number(text);
    if (!isFinite(num)) return { value: 0, ok: false, empty: false };
    return { value: negative ? -num : num, ok: true, empty: false };
  }

  /** 表示・CSV 用に数量を整形する（小数の丸め誤差を落とす） */
  function formatQuantity(num) {
    if (num === null || num === undefined) return '';
    var rounded = Math.round(num * 1e9) / 1e9;
    return String(rounded);
  }

  /**
   * 変換表（A列=変換前 / B列=変換後）を辞書化する。
   * 同じ変換前が複数あれば後勝ちとし、警告に記録する。
   * @param {Array<Array<*>>} rows シートの生データ（開始行以降）
   * @param {number} startRow 元 Excel の行番号（1 始まり）。警告メッセージ用。
   */
  function buildLocationMap(rows, startRow) {
    var map = Object.create(null);
    var warnings = [];
    var count = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || [];
      var from = toKeyText(row[columnIndex('A')]);
      var to = toKeyText(row[columnIndex('B')]);
      var excelRow = startRow + i;

      if (from === '' && to === '') continue;
      if (from === '') {
        warnings.push('変換表 ' + excelRow + '行目: 変換前(A列)が空のため無視しました。');
        continue;
      }
      if (to === '') {
        warnings.push('変換表 ' + excelRow + '行目: 変換後(B列)が空のため無視しました（「' + from + '」は変換されません）。');
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(map, from) && map[from] !== to) {
        warnings.push(
          '変換表 ' + excelRow + '行目: 「' + from + '」の変換先が重複しています（「' +
          map[from] + '」→「' + to + '」で上書き）。'
        );
      }
      map[from] = to;
      count++;
    }
    return { map: map, warnings: warnings, count: count };
  }

  /** 変換表を適用する。存在しなければ元の名前をそのまま使う。 */
  function convertLocation(name, map) {
    if (Object.prototype.hasOwnProperty.call(map, name)) {
      return { name: map[name], converted: true };
    }
    return { name: name, converted: false };
  }

  /**
   * シートの生データから「倉庫名 × 型式」の集計を作る。
   * @param {Array<Array<*>>} rows 開始行以降の生データ
   * @param {object} opts
   *   - cols: {warehouse, model, qty} 列文字
   *   - startRow: 元 Excel の行番号（1 始まり）
   *   - label: 警告メッセージ用の名称（"実棚" / "SAP"）
   *   - locationMap: 指定時は倉庫名に変換表を適用する
   */
  function aggregate(rows, opts) {
    var wIdx = columnIndex(opts.cols.warehouse);
    var mIdx = columnIndex(opts.cols.model);
    var qIdx = columnIndex(opts.cols.qty);
    var map = opts.locationMap || null;

    var groups = new Map();
    var warnings = [];
    var stats = { rows: 0, used: 0, skippedBlank: 0, badQty: 0, unconverted: 0, total: 0 };

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || [];
      var excelRow = opts.startRow + i;
      var rawWarehouse = toKeyText(row[wIdx]);
      var model = toKeyText(row[mIdx]);
      var rawQty = row[qIdx];

      var isBlankRow =
        rawWarehouse === '' && model === '' &&
        (rawQty === null || rawQty === undefined || rawQty === '');
      if (isBlankRow) continue;

      stats.rows++;

      if (rawWarehouse === '' || model === '') {
        stats.skippedBlank++;
        if (warnings.length < 50) {
          warnings.push(
            opts.label + ' ' + excelRow + '行目: ' +
            (rawWarehouse === '' ? opts.labels.warehouse : opts.labels.model) +
            'が空のため集計対象外にしました。'
          );
        }
        continue;
      }

      var warehouse = rawWarehouse;
      var converted = false;
      if (map) {
        var res = convertLocation(rawWarehouse, map);
        warehouse = res.name;
        converted = res.converted;
        if (!converted) stats.unconverted++;
      }

      var parsed = parseQuantity(rawQty);
      if (!parsed.ok) {
        stats.badQty++;
        if (warnings.length < 50) {
          warnings.push(
            opts.label + ' ' + excelRow + '行目: ' + opts.labels.qty +
            '「' + String(rawQty) + '」を数値として解釈できないため 0 として集計しました。'
          );
        }
      }

      var key = warehouse + KEY_SEP + model;
      var entry = groups.get(key);
      if (!entry) {
        entry = {
          key: key,
          warehouse: warehouse,
          model: model,
          qty: 0,
          lines: 0,
          sourceNames: [],
          rowNumbers: []
        };
        groups.set(key, entry);
      }
      entry.qty += parsed.value;
      entry.lines++;
      if (entry.sourceNames.indexOf(rawWarehouse) === -1) entry.sourceNames.push(rawWarehouse);
      if (entry.rowNumbers.length < 100) entry.rowNumbers.push(excelRow);

      stats.used++;
      stats.total += parsed.value;
    }

    return { groups: groups, warnings: warnings, stats: stats };
  }

  /**
   * 集計済みの実棚と SAP をフルアウタージョインして判定を付ける。
   * @param {Map} actualGroups 実棚側の集計
   * @param {Map} sapGroups SAP 側の集計
   */
  function compare(actualGroups, sapGroups) {
    var results = [];
    var summary = {
      match: 0, diff: 0, actualOnly: 0, sapOnly: 0,
      actualTotal: 0, sapTotal: 0, keys: 0
    };

    actualGroups.forEach(function (a) {
      var s = sapGroups.get(a.key);
      var sapQty = s ? s.qty : null;
      var delta = a.qty - (s ? s.qty : 0);
      var status;
      if (!s) {
        status = STATUS.ACTUAL_ONLY;
        summary.actualOnly++;
      } else if (Math.abs(delta) <= EPSILON) {
        status = STATUS.MATCH;
        summary.match++;
      } else {
        status = STATUS.DIFF;
        summary.diff++;
      }
      results.push({
        status: status,
        warehouse: a.warehouse,
        model: a.model,
        actualQty: a.qty,
        sapQty: sapQty,
        delta: delta,
        actualLines: a.lines,
        sapLines: s ? s.lines : 0,
        sapSourceNames: s ? s.sourceNames.slice() : [],
        actualRows: a.rowNumbers,
        sapRows: s ? s.rowNumbers : []
      });
      summary.actualTotal += a.qty;
    });

    sapGroups.forEach(function (s) {
      summary.sapTotal += s.qty;
      if (actualGroups.has(s.key)) return;
      summary.sapOnly++;
      results.push({
        status: STATUS.SAP_ONLY,
        warehouse: s.warehouse,
        model: s.model,
        actualQty: null,
        sapQty: s.qty,
        delta: -s.qty,
        actualLines: 0,
        sapLines: s.lines,
        sapSourceNames: s.sourceNames.slice(),
        actualRows: [],
        sapRows: s.rowNumbers
      });
    });

    summary.keys = results.length;
    sortResults(results);
    return { results: results, summary: summary };
  }

  /** 差異を上に、その中は倉庫名→型式の昇順で並べる */
  function sortResults(results) {
    var collator = typeof Intl !== 'undefined' && Intl.Collator
      ? new Intl.Collator('ja')
      : { compare: function (a, b) { return a < b ? -1 : a > b ? 1 : 0; } };

    results.sort(function (x, y) {
      var d = STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status);
      if (d !== 0) return d;
      d = collator.compare(x.warehouse, y.warehouse);
      if (d !== 0) return d;
      return collator.compare(x.model, y.model);
    });
    return results;
  }

  /**
   * 「完全一致」では別物として扱われるが、空白・全角半角・大小文字だけが違う
   * 惜しいキーの組を探す。結果は変えず、原因調査のヒントとして表示する。
   */
  function findNearMisses(actualGroups, sapGroups, limit) {
    limit = limit || 30;

    function loosen(text) {
      var s = text.replace(/[！-～]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
      });
      s = s.replace(/　/g, ' ');
      return s.replace(/\s+/g, '').toUpperCase();
    }

    var loose = new Map();
    actualGroups.forEach(function (a) {
      if (sapGroups.has(a.key)) return;
      var lk = loosen(a.warehouse) + KEY_SEP + loosen(a.model);
      if (!loose.has(lk)) loose.set(lk, []);
      loose.get(lk).push(a);
    });

    var hits = [];
    sapGroups.forEach(function (s) {
      if (hits.length >= limit) return;
      if (actualGroups.has(s.key)) return;
      var lk = loosen(s.warehouse) + KEY_SEP + loosen(s.model);
      var candidates = loose.get(lk);
      if (!candidates) return;
      for (var i = 0; i < candidates.length && hits.length < limit; i++) {
        hits.push({
          actualWarehouse: candidates[i].warehouse,
          actualModel: candidates[i].model,
          sapWarehouse: s.warehouse,
          sapModel: s.model
        });
      }
    });
    return hits;
  }

  /**
   * 3 ファイルを突合する入口。
   * @param {object} input
   *   - actual: {rows, startRow}
   *   - sap:    {rows, startRow}
   *   - mapping:{rows, startRow}
   */
  function run(input) {
    var mapping = buildLocationMap(input.mapping.rows, input.mapping.startRow);

    var actual = aggregate(input.actual.rows, {
      cols: { warehouse: 'A', model: 'E', qty: 'I' },
      startRow: input.actual.startRow,
      label: '実棚',
      labels: { warehouse: '倉庫名(A列)', model: '型式(E列)', qty: '台数(I列)' }
    });

    var sap = aggregate(input.sap.rows, {
      cols: { warehouse: 'E', model: 'G', qty: 'J' },
      startRow: input.sap.startRow,
      label: 'SAP',
      labels: { warehouse: '保管場所名(E列)', model: '品目テキスト(G列)', qty: '基本数量(J列)' },
      locationMap: mapping.map
    });

    var compared = compare(actual.groups, sap.groups);
    var nearMisses = findNearMisses(actual.groups, sap.groups);

    return {
      results: compared.results,
      summary: compared.summary,
      stats: { actual: actual.stats, sap: sap.stats, mappingCount: mapping.count },
      warnings: {
        mapping: mapping.warnings,
        actual: actual.warnings,
        sap: sap.warnings
      },
      nearMisses: nearMisses
    };
  }

  /** CSV の 1 セルをエスケープする */
  function csvCell(value) {
    var text = value === null || value === undefined ? '' : String(value);
    if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  var CSV_HEADER = [
    '判定', '倉庫名', '型式', '実棚台数', 'SAP基本数量', '差異(実棚-SAP)',
    '実棚明細件数', 'SAP明細件数', 'SAP保管場所名(変換前)'
  ];

  /**
   * 結果を CSV 文字列にする（BOM 付き・CRLF。Excel でそのまま開ける）。
   * @param {Array} results
   * @param {boolean} diffOnly true なら一致行を除外する
   */
  function toCsv(results, diffOnly) {
    var lines = [CSV_HEADER.map(csvCell).join(',')];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (diffOnly && r.status === STATUS.MATCH) continue;
      lines.push([
        r.status,
        r.warehouse,
        r.model,
        r.actualQty === null ? '' : formatQuantity(r.actualQty),
        r.sapQty === null ? '' : formatQuantity(r.sapQty),
        formatQuantity(r.delta),
        r.actualLines,
        r.sapLines,
        r.sapSourceNames.join(';')
      ].map(csvCell).join(','));
    }
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  return {
    STATUS: STATUS,
    STATUS_ORDER: STATUS_ORDER,
    EPSILON: EPSILON,
    KEY_SEP: KEY_SEP,
    columnIndex: columnIndex,
    toKeyText: toKeyText,
    parseQuantity: parseQuantity,
    formatQuantity: formatQuantity,
    buildLocationMap: buildLocationMap,
    convertLocation: convertLocation,
    aggregate: aggregate,
    compare: compare,
    findNearMisses: findNearMisses,
    run: run,
    toCsv: toCsv,
    CSV_HEADER: CSV_HEADER
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Reconcile;
}
