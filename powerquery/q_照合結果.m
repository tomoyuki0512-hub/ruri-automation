// クエリ名: q_照合結果
// 預り書と SAP を「倉庫名 × 型式」でフルアウタージョインし、判定を付ける。
//
// 出力対象は預り書に存在する倉庫だけ。SAP 側にしか無い倉庫
// （取引先名など自社の棚卸対象外）は結果に含めない。
let
    // 出力対象を預り書の倉庫に絞る
    SAP対象 = Table.SelectRows(q_SAP, each List.Contains(q_預り書_倉庫リスト, [倉庫名])),

    // Table.Join はキー列名が衝突するとエラーになるので、SAP 側を改名してから結合する
    SAP改名 = Table.RenameColumns(SAP対象, {{"倉庫名", "倉庫名_S"}, {"型式", "型式_S"}}),

    結合 = Table.Join(
        q_預り書, {"倉庫名", "型式"},
        SAP改名,  {"倉庫名_S", "型式_S"},
        JoinKind.FullOuter
    ),

    // 片側にしか無い行はキーが null になるので統合する
    倉庫統合 = Table.AddColumn(結合, "_倉庫",
        each if [倉庫名] <> null then [倉庫名] else [倉庫名_S], type text),
    型式統合 = Table.AddColumn(倉庫統合, "_型式",
        each if [型式] <> null then [型式] else [型式_S], type text),

    判定付与 = Table.AddColumn(型式統合, "判定",
        each
            if [預り書台数] = null then "SAPのみ"
            else if [SAP基本数量] = null then "預り書のみ"
            // 小数の丸め誤差（0.1 + 0.2 など）は一致として扱う
            else if Number.Abs([預り書台数] - [SAP基本数量]) <= P_設定[許容差] then "一致"
            else "差異",
        type text),

    差異付与 = Table.AddColumn(判定付与, "_差異",
        each (if [預り書台数]   = null then 0 else [預り書台数])
           - (if [SAP基本数量] = null then 0 else [SAP基本数量]),
        type number),

    // 差異を上に出すための並び順
    順序付与 = Table.AddColumn(差異付与, "_判定順",
        each
            if [判定] = "預り書のみ" then 1
            else if [判定] = "SAPのみ" then 2
            else if [判定] = "差異"   then 3
            else 4,
        Int64.Type),

    整形 = Table.SelectColumns(順序付与, {
        "_判定順", "判定", "_倉庫", "_型式",
        "預り書台数", "SAP基本数量", "_差異",
        "預り書明細件数", "SAP明細件数", "SAP保管場所名_変換前"
    }),

    改名 = Table.RenameColumns(整形, {
        {"_倉庫", "倉庫名"},
        {"_型式", "型式"},
        {"_差異", "差異(預り書-SAP)"},
        {"SAP保管場所名_変換前", "SAP保管場所名(変換前)"}
    }),

    並替 = Table.Sort(改名, {
        {"_判定順", Order.Ascending},
        {"倉庫名",  Order.Ascending},
        {"型式",    Order.Ascending}
    }),

    // 片側にしか無い行の明細件数を 0 に揃える（数量欄は空欄のまま残す）
    件数補完 = Table.ReplaceValue(
        並替, null, 0, Replacer.ReplaceValue,
        {"預り書明細件数", "SAP明細件数"}
    ),

    完成 = Table.RemoveColumns(件数補完, {"_判定順"})
in
    完成
