// クエリ名: q_預り書_明細
// A列=倉庫名 / E列=型式 / I列=台数
//
// 集計前の明細。q_預り書 と q_預り書_倉庫リスト の両方がこれを参照する。
// 「読み込みを有効にする」のチェックは外してよい（中間クエリ）。
let
    読込 = fn_読込(
        P_設定[預り書パス],
        P_設定[預り書開始行],
        {"Column1", "Column5", "Column9"},
        {"倉庫名", "型式", "数量"}
    ),

    文字列化 = Table.TransformColumns(
        読込,
        {
            {"倉庫名", fn_文字列, type text},
            {"型式",   fn_文字列, type text}
        }
    ),

    // 3項目すべて空の行はスキップする
    空行除去 = Table.SelectRows(
        文字列化,
        each not ([倉庫名] = "" and [型式] = "" and [数量] = null)
    ),

    数値化 = Table.AddColumn(
        空行除去,
        "台数",
        each let n = fn_数量([数量]) in if n = null then 0 else n,
        type number
    ),

    // 数値として解釈できなかったセルに印を付ける（q_確認事項 で使う）
    解釈フラグ = Table.AddColumn(
        数値化,
        "数量解釈不可",
        each fn_数量([数量]) = null,
        type logical
    )
in
    解釈フラグ
