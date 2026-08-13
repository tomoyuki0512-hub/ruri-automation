// クエリ名: q_出力対象外
// 預り書に無い倉庫のため照合結果から除外したものの一覧。
//
// 倉庫名の書き間違いで意図せず除外されていないか確認するために使う。
// HTML 版の「確認事項」パネルに相当する。
let
    対象外 = Table.SelectRows(q_SAP, each not List.Contains(q_預り書_倉庫リスト, [倉庫名])),

    集計 = Table.Group(
        対象外,
        {"倉庫名"},
        {
            {"型式数", each Table.RowCount(_),        Int64.Type},
            {"明細数", each List.Sum([SAP明細件数]),  Int64.Type},
            {"数量",   each List.Sum([SAP基本数量]),  type number},
            {"変換前の名称",
                each Text.Combine(
                        List.Distinct(
                            List.Combine(
                                List.Transform([SAP保管場所名_変換前], each Text.Split(_, ";"))
                            )
                        ),
                        " / "
                     ),
                type text}
        }
    )
in
    Table.Sort(集計, {{"明細数", Order.Descending}})
