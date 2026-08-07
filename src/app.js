/*
 * 棚卸照合ツール UI 制御
 * ファイルの読み込み・プレビュー表示・結果描画・CSV 出力を担当する。
 * 照合ロジック本体は reconcile.js（Reconcile）にある。
 */
(function () {
  'use strict';

  var R = Reconcile;

  /** ファイル種別ごとの定義。使用列は仕様どおり固定。 */
  var FILE_DEFS = {
    actual: {
      label: '預り書 Excel',
      columns: [
        { col: 'A', name: '倉庫名' },
        { col: 'E', name: '型式' },
        { col: 'I', name: '台数', numeric: true }
      ]
    },
    sap: {
      label: 'SAP在庫残データ Excel',
      columns: [
        { col: 'E', name: '保管場所名' },
        { col: 'G', name: '品目テキスト' },
        { col: 'J', name: '基本数量', numeric: true }
      ]
    },
    mapping: {
      label: 'マッピング表 Excel',
      columns: [
        { col: 'A', name: '保管場所名' },
        { col: 'B', name: '倉庫名' }
      ]
    }
  };

  /** 判定 → CSS クラスの接尾辞 */
  var STATUS_CLASS = {};
  STATUS_CLASS[R.STATUS.MATCH] = 'match';
  STATUS_CLASS[R.STATUS.DIFF] = 'diff';
  STATUS_CLASS[R.STATUS.ACTUAL_ONLY] = 'actual-only';
  STATUS_CLASS[R.STATUS.SAP_ONLY] = 'sap-only';

  /** 読み込んだファイルの状態 */
  var state = {
    actual: null,
    sap: null,
    mapping: null,
    output: null,
    filter: 'all',
    search: '',
    sortKey: null,
    sortDesc: false
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function text(el, value) { el.textContent = value; return el; }

  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }

  /** 桁区切り付きで数値を表示する */
  function fmtNum(num) {
    if (num === null || num === undefined) return '';
    var rounded = Math.round(num * 1e9) / 1e9;
    return rounded.toLocaleString('ja-JP', { maximumFractionDigits: 9 });
  }

  function fmtBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  var toastTimer = null;
  function toast(message) {
    var node = $('#toast');
    text(node, message);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, 2600);
  }

  /* ------------------------------------------------------------------
     テーマ切り替え
     ------------------------------------------------------------------ */

  function initTheme() {
    var stored = null;
    try { stored = localStorage.getItem('tanaoroshi-theme'); } catch (e) { /* file:// で不可の場合は無視 */ }
    if (stored === 'dark' || stored === 'light') {
      document.documentElement.setAttribute('data-theme', stored);
    }
    $('#themeToggle').addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
        (!document.documentElement.hasAttribute('data-theme') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      var next = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('tanaoroshi-theme', next); } catch (e) { /* 無視 */ }
    });
  }

  /* ------------------------------------------------------------------
     ファイル読み込み
     ------------------------------------------------------------------ */

  function readWorkbook(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('ファイルを読み込めませんでした。')); };
      reader.onload = function (e) {
        try {
          var wb = XLSX.read(new Uint8Array(e.target.result), {
            type: 'array',
            cellDates: true,
            // 書式や数式は使わないので読み飛ばして高速化する
            cellStyles: false,
            cellFormula: false
          });
          if (!wb.SheetNames || wb.SheetNames.length === 0) {
            reject(new Error('シートが見つかりません。'));
            return;
          }
          resolve(wb);
        } catch (err) {
          reject(new Error('Excel として読み込めませんでした（' + (err && err.message ? err.message : err) + '）'));
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /** シートを二次元配列にする。空セルは null、行末の空白は詰めない。 */
  function sheetToRows(sheet) {
    return XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      blankrows: true,
      defval: null
    });
  }

  function cardOf(kind) { return $('.card[data-file="' + kind + '"]'); }

  async function handleFile(kind, file) {
    var card = cardOf(kind);
    var drop = $('.drop', card);
    clearError(card);

    text($('.file-name', card), file.name);
    text($('.file-meta', card), '読み込み中…');
    $('.drop-empty', card).hidden = true;
    $('.drop-filled', card).hidden = false;
    drop.classList.add('filled');

    try {
      var wb = await readWorkbook(file);
      state[kind] = {
        file: file,
        workbook: wb,
        sheetName: wb.SheetNames[0],
        startRow: 2,
        rows: [],
        // シートを二次元配列に変換した結果のキャッシュ（開始行の変更を軽くする）
        sheetCache: Object.create(null)
      };
      var select = $('.sheet-select', card);
      select.innerHTML = '';
      wb.SheetNames.forEach(function (name) {
        var opt = el('option', null, name);
        opt.value = name;
        select.appendChild(opt);
      });
      select.value = state[kind].sheetName;
      $('.settings', card).hidden = false;
      card.classList.add('ready');
      refreshFile(kind, true);
    } catch (err) {
      resetFile(kind);
      showError(card, err.message || String(err));
    }
    updateRunButton();
  }

  /**
   * シート選択・開始行の変更を反映し、プレビューを描き直す。
   * @param {string} kind ファイル種別
   * @param {boolean} commit 入力を確定扱いにして不正値を補正するか（blur 時に true）
   */
  function refreshFile(kind, commit) {
    var st = state[kind];
    if (!st) return;
    var card = cardOf(kind);

    st.sheetName = $('.sheet-select', card).value;
    var startInput = $('.start-row', card);
    var startRow = parseInt(startInput.value, 10);
    if (!isFinite(startRow) || startRow < 1) {
      // 入力途中で空になっただけの可能性があるので、値の書き換えは確定時（blur）だけにする
      if (commit) {
        startRow = 1;
        startInput.value = '1';
      } else {
        return;
      }
    }
    st.startRow = startRow;

    var allRows = st.sheetCache[st.sheetName];
    if (!allRows) {
      var sheet = st.workbook.Sheets[st.sheetName];
      allRows = sheet ? sheetToRows(sheet) : [];
      st.sheetCache[st.sheetName] = allRows;
    }
    st.totalRows = allRows.length;
    st.rows = allRows.slice(startRow - 1);

    text($('.file-meta', card),
      fmtBytes(st.file.size) + '・' + st.totalRows + '行 → 対象 ' + st.rows.length + '行');

    renderPreview(kind);
    // 読み込み設定が変わったら結果は作り直す必要がある
    if (state.output) {
      state.output = null;
      $('#resultSection').hidden = true;
      setRunHint('読み込み設定が変わりました。もう一度実行してください。', true);
    }
  }

  function renderPreview(kind) {
    var st = state[kind];
    var card = cardOf(kind);
    var box = $('.preview', card);
    var def = FILE_DEFS[kind];
    box.innerHTML = '';

    var sample = st.rows.slice(0, 8);
    if (sample.length === 0) {
      box.hidden = false;
      box.appendChild(el('p', 'card-error', 'データ開始行以降に行がありません。開始行を確認してください。'));
      return;
    }

    var head = el('p', 'preview-title');
    head.appendChild(el('span', null, '読み取り結果プレビュー（先頭 ' + sample.length + '行）'));
    head.appendChild(el('span', null, st.sheetName));
    box.appendChild(head);

    var scroll = el('div', 'preview-scroll');
    var table = el('table');
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', 'rowno', '行'));
    def.columns.forEach(function (c) {
      hr.appendChild(el('th', c.numeric ? 'num' : null, c.col + '列 ' + c.name));
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    sample.forEach(function (row, i) {
      var tr = el('tr');
      tr.appendChild(el('td', 'rowno', String(st.startRow + i)));
      def.columns.forEach(function (c) {
        var raw = (row || [])[R.columnIndex(c.col)];
        var td = el('td', c.numeric ? 'num' : null);
        if (raw === null || raw === undefined || raw === '') {
          td.classList.add('empty-cell');
          td.textContent = '（空）';
        } else {
          td.textContent = R.toKeyText(raw);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    box.appendChild(scroll);
    box.hidden = false;
  }

  function resetFile(kind) {
    state[kind] = null;
    var card = cardOf(kind);
    card.classList.remove('ready');
    $('.drop', card).classList.remove('filled');
    $('.drop-empty', card).hidden = false;
    $('.drop-filled', card).hidden = true;
    $('.settings', card).hidden = true;
    $('.preview', card).hidden = true;
    $('.preview', card).innerHTML = '';
    $('.start-row', card).value = '2';
    $('input[type="file"]', card).value = '';
    clearError(card);
    updateRunButton();
  }

  function showError(card, message) {
    clearError(card);
    $('.drop', card).classList.add('error');
    var box = el('div', 'card-error', message);
    card.appendChild(box);
  }

  function clearError(card) {
    $('.drop', card).classList.remove('error');
    var existing = $('.card-error', card);
    if (existing && existing.parentNode === card) existing.remove();
  }

  function setRunHint(message, warn) {
    var hint = $('#runHint');
    text(hint, message);
    hint.classList.toggle('ready', !warn && /実行できます/.test(message));
  }

  function updateRunButton() {
    var ready = !!(state.actual && state.sap && state.mapping);
    $('#runBtn').disabled = !ready;
    if (ready) {
      setRunHint('3ファイルとも読み込み済みです。実行できます。', false);
    } else {
      var missing = [];
      if (!state.actual) missing.push('①預り書');
      if (!state.sap) missing.push('②SAP在庫残データ');
      if (!state.mapping) missing.push('③マッピング表');
      setRunHint(missing.join('・') + ' を読み込むと実行できます', true);
    }
  }

  /* ------------------------------------------------------------------
     ドラッグ＆ドロップ配線
     ------------------------------------------------------------------ */

  function wireCards() {
    Object.keys(FILE_DEFS).forEach(function (kind) {
      var card = cardOf(kind);
      var drop = $('.drop', card);
      var input = $('input[type="file"]', card);

      drop.addEventListener('click', function (e) {
        if (e.target.closest('.clear-btn')) return;
        if (state[kind]) return;
        input.click();
      });

      drop.addEventListener('keydown', function (e) {
        if (state[kind]) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          input.click();
        }
      });

      input.addEventListener('change', function () {
        if (input.files && input.files[0]) handleFile(kind, input.files[0]);
      });

      ['dragenter', 'dragover'].forEach(function (type) {
        drop.addEventListener(type, function (e) {
          e.preventDefault();
          e.stopPropagation();
          drop.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach(function (type) {
        drop.addEventListener(type, function (e) {
          e.preventDefault();
          e.stopPropagation();
          drop.classList.remove('dragover');
        });
      });
      drop.addEventListener('drop', function (e) {
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files[0]) handleFile(kind, files[0]);
      });

      $('.clear-btn', card).addEventListener('click', function (e) {
        e.stopPropagation();
        resetFile(kind);
      });

      $('.sheet-select', card).addEventListener('change', function () { refreshFile(kind, true); });
      // change だけだとフォーカスが外れるまでプレビューが古いままなので input も拾う
      $('.start-row', card).addEventListener('input', function () { refreshFile(kind, false); });
      $('.start-row', card).addEventListener('change', function () { refreshFile(kind, true); });
    });

    // ページ全体でのドロップはブラウザの既定動作（ファイルを開く）を止める
    ['dragover', 'drop'].forEach(function (type) {
      window.addEventListener(type, function (e) { e.preventDefault(); });
    });
  }

  /* ------------------------------------------------------------------
     実行
     ------------------------------------------------------------------ */

  function run() {
    if (!(state.actual && state.sap && state.mapping)) return;
    var btn = $('#runBtn');
    btn.disabled = true;
    setRunHint('照合中…', true);

    // ボタンの状態をブラウザに描画させてから重い処理に入る
    setTimeout(function () {
      try {
        state.output = R.run({
          actual: { rows: state.actual.rows, startRow: state.actual.startRow },
          sap: { rows: state.sap.rows, startRow: state.sap.startRow },
          mapping: { rows: state.mapping.rows, startRow: state.mapping.startRow }
        });
        state.filter = 'all';
        state.search = '';
        state.sortKey = null;
        state.sortDesc = false;
        $('#searchBox').value = '';
        renderResult();
        $('#resultSection').hidden = false;
        $('#resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
        setRunHint('照合が完了しました。', false);
      } catch (err) {
        setRunHint('エラー: ' + (err && err.message ? err.message : err), true);
      } finally {
        btn.disabled = false;
      }
    }, 20);
  }

  /* ------------------------------------------------------------------
     結果描画
     ------------------------------------------------------------------ */

  function renderResult() {
    renderSummary();
    renderTotals();
    renderWarnings();
    renderFilters();
    renderTable();
  }

  function statCard(className, label, value, unit) {
    var card = el('div', 'stat ' + className);
    card.appendChild(el('div', 'stat-label', label));
    var v = el('div', 'stat-value', fmtNum(value));
    if (unit) {
      var u = el('span', 'stat-unit', unit);
      v.appendChild(u);
    }
    card.appendChild(v);
    return card;
  }

  function renderSummary() {
    var s = state.output.summary;
    var box = $('#summary');
    box.innerHTML = '';
    box.appendChild(statCard('ok', '一致', s.match, '件'));
    box.appendChild(statCard('diff', '数量差異', s.diff, '件'));
    box.appendChild(statCard('actual-only', R.STATUS.ACTUAL_ONLY + '（SAP未登録）', s.actualOnly, '件'));
    box.appendChild(statCard('sap-only', 'SAPのみ（現物なし）', s.sapOnly, '件'));
  }

  function renderTotals() {
    var s = state.output.summary;
    var st = state.output.stats;
    var box = $('#totals');
    box.innerHTML = '';

    function entry(label, value, className) {
      var dl = el('dl');
      dl.appendChild(el('dt', null, label));
      dl.appendChild(el('dd', className || null, value));
      box.appendChild(dl);
    }

    entry('照合キー数（倉庫×型式）', fmtNum(s.keys));
    entry('預り書 合計台数', fmtNum(s.actualTotal));
    entry('SAP 合計数量', fmtNum(s.sapTotal));
    var deltaClass = Math.abs(s.actualTotal - s.sapTotal) <= R.EPSILON ? 'zero'
      : (s.actualTotal - s.sapTotal > 0 ? 'pos' : 'neg');
    entry('合計差異', fmtNum(s.actualTotal - s.sapTotal), deltaClass);
    entry('取込明細数', fmtNum(st.actual.used) + ' / ' + fmtNum(st.sap.used) + '（預り書 / SAP）');
    entry('マッピング表', fmtNum(st.mappingCount) + '件');
  }

  function renderWarnings() {
    var out = state.output;
    var panel = $('#warnPanel');
    var body = $('#warnBody');
    body.innerHTML = '';

    var sections = [];

    function collect(title, items) {
      if (items && items.length) sections.push({ title: title, items: items });
    }

    collect('マッピング表について', out.warnings.mapping);
    collect('預り書 Excel について', out.warnings.actual);
    collect('SAP在庫残データ Excel について', out.warnings.sap);

    if (out.excluded && out.excluded.length) {
      var excludedItems = out.excluded.map(function (e) {
        var source = e.sourceNames.filter(function (n) { return n !== e.warehouse; });
        return '「' + e.warehouse + '」' +
          (source.length ? '（変換前: ' + source.join(' / ') + '）' : '') +
          ' … ' + e.keys + '型式 / ' + e.lines + '明細 / 数量 ' + R.formatQuantity(e.qty);
      });
      sections.push({
        title: '預り書に無い倉庫のため出力対象外にしました（' +
          out.summary.excludedKeys + '型式 / ' + out.summary.excludedLines + '明細）',
        items: excludedItems.concat([
          '倉庫名の書き間違いでここに出ている場合は、預り書またはマッピング表を直してから再実行してください。'
        ])
      });
    }

    // マッピング表に該当が無い保管場所は元の名前のまま照合する仕様どおりの動きであり、
    // 確認の必要が無いため確認事項には出さない。
    // （そのうち預り書に無い倉庫は上の「出力対象外」に集約されて表示される）

    if (out.nearMisses.length) {
      var items = out.nearMisses.map(function (m) {
        return '預り書「' + m.actualWarehouse + ' / ' + m.actualModel + '」と SAP「' +
          m.sapWarehouse + ' / ' + m.sapModel + '」は空白・全角半角だけが異なります。';
      });
      sections.push({
        title: '表記ゆれの可能性（完全一致では別物として集計しています）',
        items: items
      });
    }

    var total = sections.reduce(function (n, s) { return n + s.items.length; }, 0);
    if (total === 0) {
      panel.hidden = true;
      return;
    }

    sections.forEach(function (section) {
      body.appendChild(el('h4', null, section.title));
      var ul = el('ul');
      section.items.slice(0, 20).forEach(function (item) {
        ul.appendChild(el('li', null, item));
      });
      if (section.items.length > 20) {
        ul.appendChild(el('li', 'panel-more', 'ほか ' + (section.items.length - 20) + ' 件'));
      }
      body.appendChild(ul);
    });

    text($('#warnTitle'), '確認事項（' + total + '件）');
    panel.hidden = false;
  }

  function renderFilters() {
    var s = state.output.summary;
    var box = $('#filters');
    box.innerHTML = '';

    var defs = [
      { key: 'all', label: 'すべて', count: s.keys },
      { key: R.STATUS.ACTUAL_ONLY, label: R.STATUS.ACTUAL_ONLY, count: s.actualOnly },
      { key: R.STATUS.SAP_ONLY, label: R.STATUS.SAP_ONLY, count: s.sapOnly },
      { key: R.STATUS.DIFF, label: R.STATUS.DIFF, count: s.diff },
      { key: R.STATUS.MATCH, label: R.STATUS.MATCH, count: s.match }
    ];

    defs.forEach(function (d) {
      var btn = el('button', 'filter-btn');
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(state.filter === d.key));
      btn.dataset.filter = d.key;
      btn.appendChild(el('span', null, d.label));
      btn.appendChild(el('span', 'filter-count', fmtNum(d.count)));
      btn.addEventListener('click', function () {
        state.filter = d.key;
        renderFilters();
        renderTable();
      });
      box.appendChild(btn);
    });
  }

  /** 現在の絞り込み・並び替えを適用した結果を返す */
  function visibleRows() {
    var rows = state.output.results;

    if (state.filter !== 'all') {
      rows = rows.filter(function (r) { return r.status === state.filter; });
    }

    var q = state.search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(function (r) {
        return (r.warehouse + ' ' + r.model + ' ' + r.sapSourceNames.join(' ')).toLowerCase().indexOf(q) !== -1;
      });
    }

    if (state.sortKey) {
      var key = state.sortKey;
      var dir = state.sortDesc ? -1 : 1;
      var collator = new Intl.Collator('ja');
      rows = rows.slice().sort(function (a, b) {
        var x = a[key];
        var y = b[key];
        if (key === 'status') {
          return dir * (R.STATUS_ORDER.indexOf(x) - R.STATUS_ORDER.indexOf(y));
        }
        if (typeof x === 'number' || typeof y === 'number' || x === null || y === null) {
          // 片側のみの行（null）は末尾に寄せる
          var nx = x === null || x === undefined ? -Infinity : x;
          var ny = y === null || y === undefined ? -Infinity : y;
          return dir * (nx - ny);
        }
        return dir * collator.compare(String(x), String(y));
      });
    }
    return rows;
  }

  function renderTable() {
    var rows = visibleRows();
    var tbody = $('#resultBody');
    tbody.innerHTML = '';

    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      var cls = STATUS_CLASS[r.status];
      var tr = el('tr', r.status === R.STATUS.MATCH ? '' : 'row-' + cls);

      var tdStatus = el('td');
      tdStatus.appendChild(el('span', 'pill pill-' + cls, r.status));
      tr.appendChild(tdStatus);

      tr.appendChild(el('td', null, r.warehouse));
      tr.appendChild(el('td', 'model', r.model));
      tr.appendChild(el('td', 'num' + (r.actualQty === null ? ' dim' : ''), r.actualQty === null ? '—' : fmtNum(r.actualQty)));
      tr.appendChild(el('td', 'num' + (r.sapQty === null ? ' dim' : ''), r.sapQty === null ? '—' : fmtNum(r.sapQty)));

      var deltaCls = 'num';
      if (r.status !== R.STATUS.MATCH) deltaCls += r.delta > 0 ? ' delta-pos' : ' delta-neg';
      var deltaText = r.status === R.STATUS.MATCH ? '0' : (r.delta > 0 ? '+' : '') + fmtNum(r.delta);
      tr.appendChild(el('td', deltaCls, deltaText));

      tr.appendChild(el('td', 'num dim', fmtNum(r.actualLines)));
      tr.appendChild(el('td', 'num dim', fmtNum(r.sapLines)));
      tr.appendChild(el('td', 'dim', r.sapSourceNames.join(' / ')));

      frag.appendChild(tr);
    });
    tbody.appendChild(frag);

    $('#tableEmpty').hidden = rows.length > 0;
    text($('#tableFoot'), rows.length + ' 件を表示中（全 ' + state.output.results.length + ' 件）');
  }

  function wireTableSort() {
    $$('#resultTable thead th').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.sort;
        if (!key || !state.output) return;
        if (state.sortKey === key) {
          state.sortDesc = !state.sortDesc;
        } else {
          state.sortKey = key;
          state.sortDesc = false;
        }
        $$('#resultTable thead th').forEach(function (other) {
          other.classList.toggle('sorted', other === th);
          other.classList.toggle('desc', other === th && state.sortDesc);
        });
        renderTable();
      });
    });
  }

  /* ------------------------------------------------------------------
     CSV 出力
     ------------------------------------------------------------------ */

  function timestamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  /**
   * a[download] による保存。
   * ブラウザによっては download 属性に日本語名を渡すと名前ごと無視され、
   * 拡張子の無い "download" というファイルになってしまうため、
   * この経路では必ず ASCII 名を使う（Excel が開けるよう .csv を保証する）。
   */
  function anchorDownload(asciiName, content) {
    // BOM は文字列側に含めているので、ここでは付け直さない
    var blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = asciiName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /**
   * CSV を保存する。
   * 「名前を付けて保存」ダイアログが使える環境では日本語のファイル名を提案し、
   * 使えない環境では ASCII 名でダウンロードフォルダに保存する。
   * @returns {Promise<{saved:boolean, name?:string, cancelled?:boolean}>}
   */
  async function saveCsv(jaName, asciiName, content) {
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        var handle = await window.showSaveFilePicker({
          suggestedName: jaName,
          types: [{ description: 'CSV ファイル', accept: { 'text/csv': ['.csv'] } }]
        });
        var writable = await handle.createWritable();
        await writable.write(new Blob([content], { type: 'text/csv;charset=utf-8;' }));
        await writable.close();
        return { saved: true, name: handle.name };
      } catch (err) {
        if (err && err.name === 'AbortError') return { saved: false, cancelled: true };
        // 未対応・権限エラーなどは従来のダウンロードにフォールバックする
      }
    }
    anchorDownload(asciiName, content);
    return { saved: true, name: asciiName };
  }

  async function exportCsv(diffOnly) {
    if (!state.output) return;
    var rows = state.output.results;
    if (diffOnly) {
      rows = rows.filter(function (r) { return r.status !== R.STATUS.MATCH; });
      if (rows.length === 0) {
        toast('差異はありません。すべて一致しています。');
        return;
      }
    }
    var stamp = timestamp();
    var jaName = (diffOnly ? '棚卸差異_' : '棚卸照合結果_') + stamp + '.csv';
    var asciiName = (diffOnly ? 'tanaoroshi_diff_' : 'tanaoroshi_result_') + stamp + '.csv';

    var result = await saveCsv(jaName, asciiName, R.toCsv(rows, false));
    if (result.cancelled) return;
    toast(result.name + ' を保存しました（' + rows.length + '件）');
  }

  /* ------------------------------------------------------------------
     初期化
     ------------------------------------------------------------------ */

  function init() {
    initTheme();
    wireCards();
    wireTableSort();
    updateRunButton();

    $('#runBtn').addEventListener('click', run);
    $('#csvAll').addEventListener('click', function () { exportCsv(false); });
    $('#csvDiff').addEventListener('click', function () { exportCsv(true); });

    $('#searchBox').addEventListener('input', function (e) {
      state.search = e.target.value;
      if (state.output) renderTable();
    });

    $('#warnToggle').addEventListener('click', function () {
      var expanded = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', String(!expanded));
      $('#warnBody').hidden = expanded;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // テスト用に内部状態を公開する
  window.__tanaoroshi = { state: state, exportCsv: exportCsv };
})();
