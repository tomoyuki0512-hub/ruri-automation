// クエリ名: q_預り書
// 預り書を「倉庫名 × 型式」で集計する（サマる）。
//
// 同じ倉庫・同じ型式が複数明細に分かれていても合算する。
let
    // 倉庫名または型式が空の行は集計対象外にする
    集計対象 = Table.SelectRows(q_預り書_明細, each [倉庫名] <> "" and [型式] <> ""),

    集計 = Table.Group(
        集計対象,
        {"倉庫名", "型式"},
        {
            {"預り書台数",     each List.Sum([台数]),  type number},
            {"預り書明細件数", each Table.RowCount(_), Int64.Type}
        }
    )
in
    集計
