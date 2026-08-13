// クエリ名: q_SAP
// E列=保管場所名 / G列=品目テキスト / J列=基本数量
//
// マッピング表で保管場所名を倉庫名に読み替えてから、「倉庫名 × 型式」で集計する。
let
    読込 = fn_読込(
        P_設定[SAPパス],
        P_設定[SAP開始行],
        {"Column5", "Column7", "Column10"},
        {"保管場所名", "型式", "数量"}
    ),

    文字列化 = Table.TransformColumns(
        読込,
        {
            {"保管場所名", fn_文字列, type text},
            {"型式",       fn_文字列, type text}
        }
    ),

    空行除去 = Table.SelectRows(
        文字列化,
        each not ([保管場所名] = "" and [型式] = "" and [数量] = null)
    ),

    // マッピング表を適用する。
    // 1行ずつ Table.SelectRows で引くと数千行で極端に遅くなるため、
    // NestedJoin（ハッシュ結合）で一括変換する。
    結合 = Table.NestedJoin(
        空行除去, {"保管場所名"},
        q_マッピング表, {"保管場所名"},
        "_map", JoinKind.LeftOuter
    ),
    展開 = Table.ExpandTableColumn(結合, "_map", {"倉庫名"}, {"_変換後"}),

    // マッピング表に無い保管場所名は、元の名前をそのまま使う
    変換 = Table.AddColumn(
        展開,
        "倉庫名",
        each if [_変換後] = null then [保管場所名] else [_変換後],
        type text
    ),
    後片付け = Table.RemoveColumns(変換, {"_変換後"}),

    数値化 = Table.AddColumn(
        後片付け,
        "基本数量",
        each let n = fn_数量([数量]) in if n = null then 0 else n,
        type number
    ),

    集計対象 = Table.SelectRows(数値化, each [倉庫名] <> "" and [型式] <> ""),

    集計 = Table.Group(
        集計対象,
        {"倉庫名", "型式"},
        {
            {"SAP基本数量", each List.Sum([基本数量]), type number},
            {"SAP明細件数", each Table.RowCount(_),    Int64.Type},
            // 変換前の名称を残しておくと、マッピング表が効いたか追跡できる
            {"SAP保管場所名_変換前",
                each Text.Combine(List.Distinct([保管場所名]), ";"), type text}
        }
    )
in
    集計
