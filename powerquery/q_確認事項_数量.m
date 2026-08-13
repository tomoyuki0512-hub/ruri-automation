// クエリ名: q_確認事項_数量
// 数値として解釈できなかった数量セルの一覧（0 として集計されている行）。
//
// 例: "12台"、"該当なし" など。列ずれや入力ミスの発見に使う。
let
    預り書 = Table.SelectRows(q_預り書_明細, each [数量解釈不可] = true),
    預り書付与 = Table.AddColumn(預り書, "ファイル", each "預り書", type text),
    預り書整形 = Table.SelectColumns(預り書付与, {"ファイル", "倉庫名", "型式", "数量"}),

    // SAP 側は q_SAP が集計済みなので、明細をここで読み直す
    SAP読込 = fn_読込(
        P_設定[SAPパス],
        P_設定[SAP開始行],
        {"Column5", "Column7", "Column10"},
        {"倉庫名", "型式", "数量"}
    ),
    SAP文字列化 = Table.TransformColumns(
        SAP読込,
        {{"倉庫名", fn_文字列, type text}, {"型式", fn_文字列, type text}}
    ),
    SAP空行除去 = Table.SelectRows(
        SAP文字列化,
        each not ([倉庫名] = "" and [型式] = "" and [数量] = null)
    ),
    SAP不可 = Table.SelectRows(SAP空行除去, each fn_数量([数量]) = null),
    SAP付与 = Table.AddColumn(SAP不可, "ファイル", each "SAP", type text),
    SAP整形 = Table.SelectColumns(SAP付与, {"ファイル", "倉庫名", "型式", "数量"}),

    結合 = Table.Combine({預り書整形, SAP整形}),
    改名 = Table.RenameColumns(結合, {{"数量", "解釈できなかった値"}})
in
    改名
