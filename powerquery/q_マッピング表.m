// クエリ名: q_マッピング表
// A列=保管場所名（変換前） / B列=倉庫名（変換後）
//
// 同じ保管場所名が複数行ある場合は「後勝ち」にする（HTML 版と同じ挙動）。
let
    読込 = fn_読込(
        P_設定[マッピングパス],
        P_設定[マッピング開始行],
        {"Column1", "Column2"},
        {"保管場所名", "倉庫名"}
    ),

    文字列化 = Table.TransformColumns(
        読込,
        {
            {"保管場所名", fn_文字列, type text},
            {"倉庫名",     fn_文字列, type text}
        }
    ),

    // 変換前・変換後のどちらかが空の行は無視する
    有効 = Table.SelectRows(文字列化, each [保管場所名] <> "" and [倉庫名] <> ""),

    // 後勝ちにするため、行番号の降順にしてから重複を除く
    行番号 = Table.AddIndexColumn(有効, "_行", 1, 1, Int64.Type),
    降順   = Table.Sort(行番号, {{"_行", Order.Descending}}),
    後勝ち = Table.Distinct(降順, {"保管場所名"}),
    結果   = Table.RemoveColumns(後勝ち, {"_行"})
in
    結果
