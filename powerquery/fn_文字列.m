// クエリ名: fn_文字列
// 突合キー用にセル値を文字列化する。
//
// 照合は「完全一致」なので Trim も全角半角統一も行わない。
// 数値セルと文字列セルが混在しても比較できるよう、文字列化だけを行う。
(v as any) as text =>
    if v = null then ""
    else if Value.Is(v, type text) then v
    else if Value.Is(v, type date) then Date.ToText(v, "yyyy-MM-dd")
    else Text.From(v)
